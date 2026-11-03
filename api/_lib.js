// Pembantu bersama untuk semua endpoint /api (Vercel Serverless + Firebase Admin). Server-side saja.
const admin = require('firebase-admin');
const crypto = require('crypto');

let initErr = null;
try {
  if (!admin.apps.length) {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT belum diisi di Vercel (atau belum di-Redeploy)');
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
  }
} catch (e) { initErr = e; }

const fail = (http, msg, extra) => Object.assign(new Error(msg), { http, extra: extra || {} });
const rp = (n) => 'Rp' + Number(n || 0).toLocaleString('id-ID');
const iso = () => new Date().toISOString();
const clean = (o) => { const out = {}; for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v; return out; };
const makeCode = (prefix) => prefix + Date.now().toString(36).slice(-5).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();

function db() {
  if (initErr) throw fail(500, 'Kunci Firebase bermasalah: ' + initErr.message);
  return admin.firestore();
}

// Verifikasi Firebase ID token. Mengembalikan { uid, email, decoded }.
async function authUser(req) {
  if (initErr) throw fail(500, 'Kunci Firebase bermasalah: ' + initErr.message);
  const tok = (req.headers.authorization || '').replace('Bearer ', '');
  if (!tok) throw fail(401, 'Belum login');
  try { const d = await admin.auth().verifyIdToken(tok); return { uid: d.uid, email: d.email || '', decoded: d }; }
  catch (e) {
    const msg = String((e && e.message) || ''), code = String((e && e.code) || '');
    console.error('authUser ditolak:', code, msg.slice(0, 300));   // lihat di Vercel > Logs
    let reason = 'invalid', hint = 'Sesi tidak valid, login ulang';
    if (/id-token-expired/.test(code)) { reason = 'expired'; hint = 'Sesi kedaluwarsa, muat ulang halaman lalu coba lagi'; }
    else if (/revoked/.test(code)) { reason = 'revoked'; hint = 'Sesi dicabut, silakan login ulang'; }
    else if (/incorrect "(aud|iss)"/.test(msg)) { reason = 'project_mismatch'; hint = 'Konfigurasi server salah: FIREBASE_SERVICE_ACCOUNT di Vercel bukan dari project Firebase web ini (gvsuperzstore). Ganti dengan service account project gvsuperzstore lalu Redeploy'; }
    else if (/too early|issued at|"iat"|"nbf"/i.test(msg)) { reason = 'clock'; hint = 'Jam server tidak sinkron dengan token, coba lagi sebentar lagi'; }
    else if (/internal|network|ENOTFOUND|ETIMEDOUT|ECONN|fetch|certificate/i.test(code + ' ' + msg)) { reason = 'net'; hint = 'Server gagal memverifikasi sesi (jaringan), coba lagi'; }
    throw fail(401, hint, { reason });
  }
}

async function isAdminUid(d, uid) {
  const s = await d.doc('profiles/' + uid).get();
  return s.exists && s.data().role === 'admin';
}
async function assertAdmin(d, uid) { if (!(await isAdminUid(d, uid))) throw fail(403, 'Khusus admin'); }

// Catat perubahan saldo DI DALAM transaksi Firestore (semua tx.get harus sudah dilakukan sebelum ini).
// p = data profil yang dibaca di transaksi; pref = DocumentReference profil.
function ledger(tx, d, pref, p, o) {
  const before = Number(p.balance || 0), after = before + Number(o.delta);
  if (after < 0) throw fail(402, 'Saldo tidak mencukupi', { code: 'saldo' });
  const now = iso(), tref = d.collection('transactions').doc(), code = makeCode('GVT');
  tx.update(pref, { balance: after, updated_at: now });
  tx.set(tref, clean({
    transaction_code: code, user_id: pref.id, user_code: p.user_code || null, kind: o.kind, amount: Number(o.amount),
    status: o.status || 'success', product_name: o.product_name, denomination_name: o.denomination_name,
    base_price: Number(o.base_price || 0), member_price: o.member_price == null ? null : Number(o.member_price),
    promo_code: o.promo_code || null, discount: Number(o.discount || 0), order_id: o.order_id || null,
    deposit_id: o.deposit_id || null, processed_by: o.processed_by || null, note: o.note || null,
    balance_before: before, balance_after: after, quantity: 1, created_at: now,
  }));
  return { id: tref.id, transaction_code: code, balance_after: after };
}

// Notifikasi in-app. audience: 'user' (user_id) atau admin (satu dokumen per admin). Tidak boleh menggagalkan transaksi.
async function notifyUser(d, uid, title, body, kind, link) {
  try { await d.collection('notifications').add(clean({ user_id: uid, audience: 'user', kind: kind || 'info', title, body: body || null, link: link || null, meta: {}, read_at: null, created_at: iso() })); }
  catch (e) { console.warn('notifyUser', e.message); }
}
async function notifyAdmins(d, title, body, kind, link) {
  try {
    const a = await d.collection('profiles').where('role', '==', 'admin').get();
    const b = d.batch();
    a.docs.forEach((x) => b.set(d.collection('notifications').doc(), clean({ user_id: x.id, audience: 'admin', kind: kind || 'info', title, body: body || null, link: link || '/admin', meta: {}, read_at: null, created_at: iso() })));
    await b.commit();
  } catch (e) { console.warn('notifyAdmins', e.message); }
}
async function logAdmin(d, adminId, action, targetType, targetId, detail) {
  try { await d.collection('admin_logs').add(clean({ admin_id: adminId, action, target_type: targetType || null, target_id: targetId || null, detail: detail || null, created_at: iso() })); }
  catch (e) { console.warn('logAdmin', e.message); }
}

// Pembungkus handler: method POST, JSON error seragam.
function handler(fn) {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    try {
      const out = await fn(req, res);
      if (!res.headersSent) return res.status(200).json(out === undefined ? { ok: true } : out);
    } catch (e) {
      if (e && e.http) return res.status(e.http).json(Object.assign({ error: e.message }, e.extra || {}));
      if (e && e.code === 'NOCFG') return res.status(503).json({ error: e.message });
      if (e && (e.code === 'TIMEOUT' || e.code === 'NETWORK' || e.code === 'BADRESP')) return res.status(502).json({ error: e.message });
      const em = String((e && e.message) || ''), ec = e && e.code;
      if (ec === 8 || /RESOURCE_EXHAUSTED|quota/i.test(String(ec) + ' ' + em)) { console.error('api error: kuota Firestore habis', em.slice(0, 200)); return res.status(503).json({ error: 'Kuota harian Firebase (paket Spark) habis. Reset otomatis sekitar pukul 14.00 WIB, atau upgrade ke paket Blaze.', reason: 'quota' }); }
      if (ec === 14 || ec === 4 || /UNAVAILABLE|DEADLINE_EXCEEDED/i.test(String(ec) + ' ' + em)) { console.error('api error: database sibuk', em.slice(0, 200)); return res.status(503).json({ error: 'Database sedang sibuk, coba lagi sebentar lagi', reason: 'busy' }); }
      console.error('api error', ec, em.slice(0, 200)); // jangan log body/kredensial
      return res.status(500).json({ error: 'Terjadi kesalahan server' + (ec ? ' (kode ' + String(ec).slice(0, 40) + ')' : '') });
    }
  };
}

module.exports = { admin, fail, rp, iso, clean, makeCode, db, authUser, isAdminUid, assertAdmin, ledger, notifyUser, notifyAdmins, logAdmin, handler };
