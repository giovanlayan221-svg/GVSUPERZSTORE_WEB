// /api/admin.js — aksi khusus ADMIN (dicek di server): daftar user, penyesuaian saldo, jadikan admin, cari email,
// ubah status pesanan (refund otomatis), kirim notifikasi massal.
const L = require('./_lib');
const { setOrderStatus } = require('./_orders');
const { fail, iso, rp, clean, ledger } = L;

const USER_FIELDS = ['user_code', 'username', 'display_name', 'whatsapp', 'balance', 'created_at'];

module.exports = L.handler(async (req) => {
  const me = await L.authUser(req), d = L.db(), b = req.body || {}, a = String(b.action || '');
  await L.assertAdmin(d, me.uid);

  if (a === 'listUsers') {
    const snap = await d.collection('profiles').orderBy('created_at', 'desc').limit(String(b.search || '').trim() ? 1000 : 200).get();   // hemat kuota: tanpa pencarian 200 terbaru, dengan pencarian 1000 terbaru
    let rows = snap.docs.map((x) => { const p = x.data(), o = { id: x.id }; for (const k of USER_FIELDS) o[k] = p[k] === undefined ? null : p[k]; o.email = p.email || ''; o.is_admin = p.role === 'admin'; return o; });
    rows.sort((x, y) => String(y.created_at || '').localeCompare(String(x.created_at || '')));
    rows = rows.slice(0, 500);
    const term = String(b.search || '').trim().toLowerCase();
    if (!term) return rows;
    return rows.filter((r) => [r.user_code, r.username, r.display_name, r.email, r.whatsapp].filter(Boolean).some((v) => String(v).toLowerCase().includes(term)));
  }

  if (a === 'findUsersByEmail') {
    const term = String(b.email || '').trim().toLowerCase();
    if (term.length < 2) throw fail(400, 'Minimal 2 karakter');
    const snap = await d.collection('profiles').orderBy('created_at', 'desc').limit(1000).get();   // hemat kuota: cari di 1000 pengguna terbaru
    return snap.docs.filter((x) => String(x.data().email || '').toLowerCase().includes(term)).slice(0, 20).map((x) => ({ id: x.id, email: x.data().email || '' }));
  }

  if (a === 'getUserEmails') {
    const ids = Array.isArray(b.ids) ? b.ids.slice(0, 200).map(String) : [];
    const out = {};
    if (!ids.length) return out;
    const docs = await d.getAll(...ids.map((id) => d.doc('profiles/' + id)));
    docs.forEach((x) => { if (x.exists) out[x.id] = x.data().email || ''; });
    return out;
  }

  if (a === 'adjustBalance') {
    const uid = String(b.user_id || ''), delta = Number(b.delta), note = String(b.note || '').trim().slice(0, 200);
    if (!uid || !Number.isInteger(delta) || delta === 0) throw fail(400, 'Nominal tidak valid (bilangan bulat, bukan 0)');
    await d.runTransaction(async (tx) => {
      const pref = d.doc('profiles/' + uid), ps = await tx.get(pref);
      if (!ps.exists) throw fail(404, 'Pengguna tidak ditemukan');
      ledger(tx, d, pref, ps.data(), { delta, kind: 'adjustment', amount: Math.abs(delta), product_name: 'Penyesuaian Saldo', processed_by: me.uid, note });
    });
    await L.notifyUser(d, uid, delta > 0 ? 'Saldo bertambah' : 'Saldo disesuaikan', (delta > 0 ? '+' : '-') + rp(Math.abs(delta)) + (note ? ' — ' + note : ''), 'balance', '/account');
    await L.logAdmin(d, me.uid, 'balance_adjustment', 'user', uid, { delta });
    return { ok: true };
  }

  if (a === 'setAdmin') {
    const uid = String(b.user_id || ''), on = !!b.is_admin;
    if (!uid) throw fail(400, 'Pengguna tidak valid');
    if (uid === me.uid && !on) throw fail(400, 'Tidak bisa mencabut admin diri sendiri');
    const pref = d.doc('profiles/' + uid);
    if (!(await pref.get()).exists) throw fail(404, 'Pengguna tidak ditemukan');
    await pref.update({ role: on ? 'admin' : 'user', updated_at: iso() });
    await L.logAdmin(d, me.uid, on ? 'grant_admin' : 'revoke_admin', 'user', uid, {});
    return { ok: true };
  }

  if (a === 'setOrderStatus') {
    const id = String(b.id || ''), st = String(b.status || '');
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) throw fail(400, 'ID pesanan tidak valid');
    if (!['pending_payment', 'processing', 'success', 'failed', 'cancelled'].includes(st)) throw fail(400, 'Status tidak valid');
    const r = await setOrderStatus(d, id, st, { adminId: me.uid, note: b.admin_note ? String(b.admin_note).trim() : undefined });
    return { ok: true, status: st, refunded: !!(r && r.refunded) };
  }

  if (a === 'broadcast') {
    const title = String(b.title || '').trim(), body = String(b.body || '').trim().slice(0, 400);
    if (title.length < 3 || title.length > 120) throw fail(400, 'Judul 3-120 karakter');
    let ids = [];
    if (b.target === 'user') { if (!b.user_id) throw fail(400, 'Pilih pengguna tujuan'); ids = [String(b.user_id)]; }
    else ids = (await d.collection('profiles').get()).docs.map((x) => x.id);
    if (!ids.length) throw fail(400, 'Tidak ada pengguna tujuan');
    for (let i = 0; i < ids.length; i += 400) {
      const batch = d.batch();
      ids.slice(i, i + 400).forEach((uid) => batch.set(d.collection('notifications').doc(), clean({ user_id: uid, audience: 'user', kind: String(b.kind || 'info').slice(0, 40), title, body: body || null, link: b.link ? String(b.link).slice(0, 300) : null, meta: {}, read_at: null, created_at: iso() })));
      await batch.commit();
    }
    await L.logAdmin(d, me.uid, 'broadcast_notification', 'notification', title, { recipients: ids.length });
    return { recipients: ids.length, pushed: 0 };
  }

  throw fail(400, 'action tidak dikenal');
});
