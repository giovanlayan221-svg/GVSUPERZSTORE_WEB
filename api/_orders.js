// Logika pesanan bersama (dipakai haybi.js, pay.js, pkqris.js, admin.js, callback, sync-pending). Server-side saja.
// Status pesanan: processing (sedang diproses) -> success | failed | cancelled. Gagal/batal => saldo dikembalikan SEKALI (flag refunded).
const { fail, rp, iso, clean, ledger, notifyUser, db: getDb, logAdmin, admin } = require('./_lib');
const H = require('./_haybi');
const PK = require('./_punyakios');
const MB = require('./_mangbeli');

const LABEL = { processing: 'sedang diproses', success: 'berhasil', failed: 'gagal', cancelled: 'dibatalkan', pending_payment: 'menunggu pembayaran' };

// Tetapkan status pesanan (idempotent & aman dipanggil berulang). opts: { onlyFrom, sn, msg, note, adminId, cost, trx }
// onlyFrom (provider/otomatis): hanya berubah bila status sekarang salah satu dari daftar ini.
async function setOrderStatus(d, orderId, target, opts) {
  opts = opts || {};
  let info = null;
  await d.runTransaction(async (tx) => {
    info = null;
    const or = d.collection('orders').doc(orderId), os = await tx.get(or);
    if (!os.exists) throw fail(404, 'Pesanan tidak ditemukan');
    const o = os.data();
    if (opts.onlyFrom && !opts.onlyFrom.includes(o.status)) return;
    if (o.status === target) return;
    const wantRefund = (target === 'failed' || target === 'cancelled') && !o.refunded && !!o.user_id;
    if ((target === 'success' || target === 'processing' || target === 'pending_payment') && o.refunded) throw fail(409, 'Pesanan ini sudah dikembalikan dananya, tidak bisa diubah menjadi ' + LABEL[target]);
    let pref = null, p = null;
    if (wantRefund) { pref = d.doc('profiles/' + o.user_id); const ps = await tx.get(pref); if (ps.exists) p = ps.data(); }
    const tr = o.transaction_id ? d.collection('transactions').doc(o.transaction_id) : null;
    const now = iso(), upd = { status: target, updated_at: now };
    if (opts.adminId) upd.processed_by = opts.adminId;
    if (opts.note !== undefined && opts.note !== null) upd.admin_note = String(opts.note).slice(0, 300);
    if (opts.msg !== undefined || opts.sn) { upd.provider_message = opts.sn ? (opts.msg ? opts.msg + ' · ' : '') + 'SN: ' + opts.sn : (opts.msg || null); }
    if (opts.sn) upd.sn = opts.sn;
    if (target === 'success') upd.provider_status = o.provider ? 'success' : (o.provider_status || null);
    if (target === 'failed' || target === 'cancelled') upd.provider_status = o.provider ? 'failed' : (o.provider_status || null);
    let refunded = false;
    if (wantRefund && p) {
      const back = Number(o.amount || 0) + (o.pay_method === 'link' ? Number(o.pay_fee || 0) : 0);
      if (back > 0) {
        ledger(tx, d, pref, p, { delta: back, kind: 'refund', amount: back, product_name: o.game_name, denomination_name: o.denomination_name, order_id: orderId, processed_by: opts.adminId || null, note: 'Pengembalian dana pesanan ' + o.order_code });
        upd.refunded = true; refunded = true;
      }
    }
    tx.update(or, clean(upd));
    if (tr && (target === 'success' || target === 'failed' || target === 'cancelled')) tx.update(tr, { status: target === 'success' ? 'success' : 'failed' });
    if (target === 'success' && opts.cost != null && Number.isFinite(opts.cost) && opts.cost >= 0) {
      tx.set(d.collection('orderCosts').doc(orderId), { order_id: orderId, user_id: o.user_id || null, provider: o.provider || '', sku: o.provider_sku || '', ref: o.provider_ref || '', trx: opts.trx || null, cost: opts.cost, total: Number(o.amount) || 0, profit: (Number(o.amount) || 0) - opts.cost, at: Date.now() });
    }
    info = { user_id: o.user_id, order_code: o.order_code, game_name: o.game_name, denomination_name: o.denomination_name, refunded };
  });
  if (!info) return false;
  if (info.user_id) {
    await notifyUser(d, info.user_id, 'Pesanan ' + LABEL[target],
      `${info.order_code} · ${info.game_name} ${info.denomination_name}` + (info.refunded ? ' — saldo dikembalikan' : '') + (opts.sn ? ' — SN: ' + opts.sn : '') + (opts.note ? ' — ' + opts.note : ''),
      'order', '/order/' + info.order_code);
  }
  if (opts.adminId) await logAdmin(d, opts.adminId, 'order_' + target, 'order', info.order_code, { refunded: info.refunded });
  return { refunded: info.refunded };
}

// Cek status ke provider yang dipakai pesanan. Hasil: { st: 'sukses'|'pending'|'error'|'unknown'|'notfound', sn, msg, cost, trx, raw }
async function checkProvider(x) {
  if (x.provider === 'punyakios') {
    const res = await PK.status(x.provider_ref);
    if (res.http === 404) return { st: 'notfound', msg: 'Transaksi tidak ditemukan di PunyaKios', raw: res.data };
    const dd = (res.data && res.data.data) || {};
    if (!res.ok || (dd.ref_id && dd.ref_id !== x.provider_ref)) return { st: 'unknown', msg: (res.data && res.data.message) || ('HTTP ' + res.http), raw: res.data };
    const cost = Number(dd.amount);
    return { st: PK.norm(dd.status), sn: dd.sn || null, msg: dd.message || null, cost: Number.isFinite(cost) ? cost : null, trx: dd.trx_id || null, raw: res.data };
  }
  if (x.provider === 'mangbeli') {
    const res = await MB.status(x.provider_ref);
    if (res.http === 404) return { st: 'notfound', msg: 'Transaksi tidak ditemukan di MangBeli', raw: res.data };
    const dd = (res.data && res.data.data) || {};
    if (!res.ok || (res.data && res.data.success === false) || (dd.ref_id && dd.ref_id !== x.provider_ref)) return { st: 'unknown', msg: (res.data && res.data.message) || ('HTTP ' + res.http), raw: res.data };
    const cost = Number(dd.price);
    return { st: MB.norm(dd.status), sn: dd.sn || null, msg: dd.message || null, cost: Number.isFinite(cost) ? cost : null, raw: res.data };
  }
  const res = await H.cekStatus(x.provider_ref), dd = res.data || {};
  return { st: H.norm(dd), sn: dd.sn || null, msg: dd.pesan || null, rc: dd.rc, raw: dd };
}

// Cek status pesanan ke provider & perbarui. Tidak ada notifikasi ganda.
// hint: { sn, msg } dari webhook PunyaKios yang signature-nya valid. Status akhir TETAP dari cek status resmi; hint hanya melengkapi SN/pesan bila cek status tidak mengembalikannya.
const cleanTxt = (v, n) => (typeof v === 'string' || typeof v === 'number') ? String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n) : '';
async function syncOrder(d, orderId, hint) {
  const s = await d.collection('orders').doc(orderId).get();
  if (!s.exists) return { state: 'notfound' };
  const x = s.data();
  if (!x.provider_ref) return { state: 'nosend' };
  if (x.status !== 'processing') return { state: x.status };
  const c = await checkProvider(x), st = c.st, pesan = c.msg;
  const who = x.provider === 'punyakios' ? 'PunyaKios' : x.provider === 'mangbeli' ? 'MangBeli' : 'HAYBI';
  if (st === 'sukses') { await setOrderStatus(d, orderId, 'success', { onlyFrom: ['processing'], sn: c.sn || cleanTxt(hint && hint.sn, 1500) || null, msg: pesan || cleanTxt(hint && hint.msg, 300) || null, cost: x.provider === 'punyakios' || x.provider === 'mangbeli' ? c.cost : null, trx: c.trx }); return { state: 'sukses', raw: c.raw }; }
  // PunyaKios dan MangBeli mendefinisikan 'failed' sebagai status AKHIR -> refund. (HAYBI 'error' ambigu, jadi tidak di-refund otomatis.)
  if (st === 'error' && (x.provider === 'punyakios' || x.provider === 'mangbeli')) { await setOrderStatus(d, orderId, 'failed', { onlyFrom: ['processing'], msg: 'Transaksi gagal di provider' }); return { state: 'gagal', raw: c.raw }; }
  if ((st === 'error' || st === 'notfound') && x.provider_status !== 'error') {
    await d.collection('orders').doc(orderId).update({ provider_status: 'error', provider_message: pesan || ('rc ' + (c.rc || '?')), provider_updated_at: iso(), updated_at: iso() }).catch(() => {});
    const { notifyAdmins } = require('./_lib');
    await notifyAdmins(d, 'Pesanan perlu dicek', `${x.order_code} · ${who}: ${pesan || 'status error'}. Putuskan berhasil/gagal di Admin > Pesanan.`, 'order', '/admin');
  }
  return { state: st === 'notfound' ? 'error' : st, raw: c.raw };
}

module.exports = { setOrderStatus, syncOrder, checkProvider, LABEL };
