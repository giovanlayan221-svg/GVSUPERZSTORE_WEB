// /api/account.js — profil & status admin.
//   ensureProfile {display_name?}  -> buat profil bila belum ada (user_code berurutan). Pendaftar PERTAMA otomatis admin (seperti GVSMARTPAY).
//   me                              -> data akun sendiri
//   updateProfile {display_name?, username?, whatsapp?}
//   adminStatus / claimAdmin        -> cadangan: klaim admin pertama jika belum ada admin
const L = require('./_lib');
const { fail, iso, clean } = L;

const ACCOUNT_FIELDS = ['id', 'user_code', 'display_name', 'username', 'whatsapp', 'avatar_url', 'balance', 'created_at'];
const pick = (id, p) => { const o = { id }; for (const k of ACCOUNT_FIELDS) if (k !== 'id') o[k] = p[k] === undefined ? null : p[k]; return o; };

async function ensureProfile(d, me, body) {
  let created = false;
  await d.runTransaction(async (tx) => {
    created = false;
    const pref = d.doc('profiles/' + me.uid), cref = d.doc('meta/counters'), aref = d.doc('meta/app');
    const [ps, cs, as] = await Promise.all([tx.get(pref), tx.get(cref), tx.get(aref)]);
    if (ps.exists) {
      if (me.email && ps.data().email !== me.email) tx.update(pref, { email: me.email });
      return;
    }
    const seq = (cs.exists ? Number(cs.data().userSeq || 0) : 0) + 1;
    const first = !as.exists;
    const name = String(body.display_name || me.decoded.name || (me.email || '').split('@')[0] || 'Member').trim().slice(0, 60) || 'Member';
    tx.set(cref, { userSeq: seq }, { merge: true });
    if (first) tx.set(aref, { adminUid: me.uid, createdAt: iso() });
    tx.set(pref, clean({ user_code: 'GVS' + String(seq).padStart(6, '0'), display_name: name, username: null, whatsapp: null, avatar_url: null, email: me.email || null, balance: 0, role: first ? 'admin' : 'user', created_at: iso(), updated_at: iso() }));
    created = true;
  });
  return { ok: true, created };
}

async function adminStatus(d, uid) {
  const a = await d.collection('profiles').where('role', '==', 'admin').limit(1).get();
  return { adminExists: !a.empty, isAdmin: await L.isAdminUid(d, uid) };
}

module.exports = L.handler(async (req) => {
  const me = await L.authUser(req), d = L.db(), b = req.body || {}, a = String(b.action || '');
  if (a === 'ensureProfile') return ensureProfile(d, me, b);
  if (a === 'me') {
    await ensureProfile(d, me, {});
    const s = await d.doc('profiles/' + me.uid).get();
    return s.exists ? pick(s.id, s.data()) : null;
  }
  if (a === 'updateProfile') {
    const patch = {};
    if (b.display_name !== undefined) {
      const n = String(b.display_name).trim();
      if (n.length < 1 || n.length > 60) throw fail(400, 'Nama 1-60 karakter');
      patch.display_name = n;
    }
    if (b.username !== undefined) {
      const u = String(b.username).trim();
      if (u === '') patch.username = null;
      else {
        if (!/^[a-zA-Z0-9_.]{3,24}$/.test(u)) throw fail(400, 'Username 3-24 karakter: huruf, angka, titik, underscore');
        const dup = await d.collection('profiles').where('username', '==', u).limit(2).get();
        if (dup.docs.some((x) => x.id !== me.uid)) throw fail(409, 'Username sudah dipakai pengguna lain');
        patch.username = u;
      }
    }
    if (b.whatsapp !== undefined) {
      const w = String(b.whatsapp).trim();
      if (w.length > 20) throw fail(400, 'Nomor WhatsApp maksimal 20 karakter');
      patch.whatsapp = w === '' ? null : w;
    }
    await ensureProfile(d, me, {});
    await d.doc('profiles/' + me.uid).update({ ...patch, updated_at: iso() });
    return { ok: true };
  }
  if (a === 'adminStatus') return adminStatus(d, me.uid);
  if (a === 'claimAdmin') {
    await ensureProfile(d, me, {});
    const st = await adminStatus(d, me.uid);
    if (st.adminExists) throw fail(409, 'Admin sudah terdaftar. Hubungi admin yang ada untuk mendapatkan akses.');
    await d.doc('profiles/' + me.uid).update({ role: 'admin', updated_at: iso() });
    await d.doc('meta/app').set({ adminUid: me.uid, createdAt: iso() }, { merge: true });
    return { ok: true };
  }
  throw fail(400, 'action tidak dikenal');
});
