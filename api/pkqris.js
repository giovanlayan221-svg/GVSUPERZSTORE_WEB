// /api/pkqris.js — bayar lewat QRIS dinamis PunyaKios (QR tampil di dalam web, sama seperti GVSMARTPAY): (1) DEPOSIT saldo, (2) PESANAN produk.
// Alur: create (link dibuat, pesanan/saldo BELUM ada) -> pelanggan memilih metode & bayar di halaman PunyaKios -> webhook/cek status resmi ("paid") -> diproses SEKALI.
//  - Biaya admin ditanggung PEMBELI (fee_charge_to: user). Nominal akhir bergantung metode yang dipilih di halaman bayar, jadi dicek dengan batas wajar.
//  - Pesanan GAGAL setelah dibayar: saldo akun pelanggan bertambah sebesar yang dibayar (harga + biaya QRIS).
//  - Dibayar lewat batas waktu, atau harga/produk berubah sebelum dibayar: tidak jadi pesanan, uang masuk ke saldo akun.
//  - Dibayar kurang: TIDAK diproses otomatis, admin dikabari.
//  - Hanya status "paid" dari endpoint cek status PunyaKios yang dipercaya (isi webhook bukan bukti bayar).
//  - Idempotent: satu pembayaran = satu hasil (ID pesanan/deposit = ID pembayaran).
const L = require('./_lib');
const PK = require('./_punyakios');
const FEE_TO = String(process.env.PUNYAKIOS_FEE_CHARGE_TO || 'user').toLowerCase() === 'merchant' ? 'merchant' : 'user';
const PAY = require('./pay');
const { resolvePromo, redeemPromo } = require('./_promo');
const { fail, iso, rp, makeCode, ledger, clean } = L;

const WINDOW_MS = 24 * 3600e3;
const CHK = new Map();
const ID_RE = /^[A-Za-z0-9]{10,40}$/;
const PAID = new Set(['paid', 'success', 'settlement', 'completed', 'berhasil']);

// Cari alamat halaman pembayaran di respons PunyaKios (nama kunci bisa beda), hanya https.
function findUrl(dd) {
  const keys = ['payment_url', 'checkout_url', 'payment_link', 'link', 'url', 'redirect_url', 'invoice_url', 'pay_url'];
  for (const k of keys) if (typeof dd[k] === 'string' && /^https:\/\//i.test(dd[k])) return dd[k];
  for (const v of Object.values(dd)) if (typeof v === 'string' && /^https:\/\/[^\s]+$/i.test(v)) return v;
  return '';
}

async function create(d, uid, b) {
  const isDep = String(b.kind || 'order') === 'deposit';
  let ord, base, promoInfo = null, disc = 0;
  if (isDep) {
    const amt = Number(b.amount);
    if (!Number.isInteger(amt) || amt < 10000 || amt > 20000000) throw fail(400, 'Minimal deposit Rp10.000 dan maksimal Rp20.000.000');
    ord = { name: 'Deposit Saldo' }; base = amt;
  } else {
    const o = PAY.prepOrder(b);
    const { game, den } = await PAY.loadProduct((r) => r.get(), o);
    const unit = Number(den.price);
    if (!Number.isInteger(unit) || unit < 1) throw fail(400, 'Harga produk tidak valid');
    if (o.promo_code) { const r = await resolvePromo(d, o.promo_code, uid, o.game_id, unit); disc = r.discount; promoInfo = r.promo; }
    base = unit - disc;
    ord = { ...o, game_name: game.name, denomination_name: den.name, name: game.name + ' ' + den.name, unit, discount: disc, promo_code: promoInfo ? promoInfo.code.toUpperCase() : null };
    delete ord.promo_code_raw;
  }
  if (base < 1000) throw fail(400, 'Total di bawah Rp1.000, QRIS tidak bisa dibuat. Bayar pakai saldo.');
  if (base > 50000000) throw fail(400, 'Nominal QRIS maksimal Rp50.000.000');
  const us = await d.doc('profiles/' + uid).get();
  if (!us.exists) throw fail(404, 'Akun tidak ditemukan');
  const now = Date.now();
  const act = await d.collection('qrisPay').where('uid', '==', uid).where('status', '==', 'menunggu').limit(10).get();
  const live = act.docs.filter((x) => (x.data().expiresAt || 0) > now && x.data().qris);
  // Pembayaran yang sama persis & QRIS masih berlaku: tampilkan QRIS yang sama (bukan membuat baru).
  const same = live.find((x) => { const q = x.data(), p = q.order || {}; return (q.kind || 'order') === (isDep ? 'deposit' : 'order') && q.base === base && ['denomination_id', 'uid_game', 'server_id', 'whatsapp'].every((k) => String(p[k] || '') === String(ord[k] || '')); });
  if (same) { const q = same.data(); return { ok: true, id: same.id, qris: q.qris, base: q.base, payFee: q.payFee, total: q.payTotal, expiresAt: q.expiresAt, resumed: true, kind: q.kind || 'order' }; }
  if (live.length >= 3) throw fail(429, 'Masih ada 3 pembayaran yang belum dibayar. Selesaikan atau tunggu kedaluwarsa.');
  const ref = d.collection('qrisPay').doc(), id = ref.id, ext = 'GVQ' + id;
  await ref.set(clean({ uid, userName: us.data().display_name || '', kind: isDep ? 'deposit' : 'order', order: ord, ...(promoInfo ? { promo_id: promoInfo.id, discount: disc } : {}), base, extId: ext, status: 'membuat', createdAt: now, expiresAt: now + WINDOW_MS }));
  let res;
  try { res = await PK.payCreate(ext, base, 'GVSUPERZSTORE ' + ord.name); }
  catch (e) { await ref.update({ status: 'gagal', err: String(e.message).slice(0, 100) }).catch(() => {}); e.detail = e.message; throw e; }
  const dd = (res.data && res.data.data) || {};
  const qr = [dd.qris_string, dd.qr_string, dd.qris, dd.qr_code].find((v) => typeof v === 'string' && v.length > 20) || '';
  const tot = Number(dd.total_amount != null ? dd.total_amount : dd.amount);       // yang HARUS dibayar pelanggan
  const fee = dd.fee_amount != null && Number.isFinite(Number(dd.fee_amount)) ? Number(dd.fee_amount) : tot - base;
  // Tarif PunyaKios: MDR 0,7% + Rp200. Batas longgar menolak angka tak masuk akal.
  const sane = res.ok && qr && Number.isFinite(tot) && tot >= base && fee >= 0 && tot - base === fee && fee <= Math.round(base * 0.03) + 300;
  if (!sane) {
    const pm = String((res.data && (res.data.message || res.data.error || (res.data.data && res.data.data.message))) || '').replace(/\s+/g, ' ').slice(0, 160);
    const why = 'HTTP ' + res.http + (pm ? ' - ' + pm : '') + (res.ok && !qr ? ' (tanpa qris_string)' : '') + (res.ok && qr ? ' (nominal/biaya tidak cocok: base ' + base + ', total ' + tot + ', fee ' + fee + ')' : '');
    console.warn('pkqris create ditolak:', why, 'kunci respons:', Object.keys(dd).join(','));
    await ref.update({ status: 'gagal', err: why.slice(0, 300) }).catch(() => {});
    if ([400, 401, 403, 422, 503].includes(res.http)) await L.notifyAdmins(d, 'QRIS PunyaKios bermasalah', 'Pembuatan QRIS ditolak (' + why.slice(0, 120) + ').', 'qris', '/admin');
    throw fail(502, 'Pembayaran belum bisa dibuat sekarang. Coba lagi sebentar atau bayar pakai saldo.', { detail: why });
  }
  const pe = Date.parse(dd.expires_at), expiresAt = Number.isFinite(pe) && pe > now ? Math.min(pe, now + WINDOW_MS) : now + WINDOW_MS;
  await ref.update({ status: 'menunggu', trx: dd.trx_id || null, qris: qr, payFee: fee, payTotal: tot, provExpires: dd.expires_at || null, expiresAt });
  return { ok: true, id, qris: qr, base, payFee: fee, total: tot, expiresAt, kind: isDep ? 'deposit' : 'order' };
}

// Kirim pesanan hasil QRIS ke provider. Idempotent (kirim() hanya mengirim sekali). Gagal tidak diam: admin dikabari.
async function trySend(d, id, uid) {
  const or = d.collection('orders').doc(id);
  try {
    const r = await require('./haybi').kirim(d, { uid, isAdmin: true }, id, { quick: true });
    if (r && r.skipped) {
      await or.update({ provider_manual: true, updated_at: iso() }).catch(() => {});
      await L.notifyAdmins(d, 'Pesanan perlu diproses manual', String(r.note || 'diproses manual').slice(0, 160) + ' (pesanan ' + id + ')', 'order', '/admin');
    }
    return r || { ok: true };
  } catch (e) {
    if (e && e.http === 409) return { ok: true, note: 'sudah final / sudah terkirim' };
    const msg = String((e && e.message) || e).slice(0, 160);
    console.warn('trySend', id, msg);
    await or.update({ provider_message: 'Gagal kirim: ' + msg, updated_at: iso() }).catch(() => {});
    await L.notifyAdmins(d, 'Pesanan belum terkirim ke provider', msg + ' (pesanan ' + id + ')', 'order', '/admin');
    return { ok: false, error: msg };
  }
}

// Satu-satunya tempat yang mengubah pembayaran QRIS menjadi saldo/pesanan. Idempotent lewat transaksi Firestore.
async function fulfill(d, id) {
  const ref = d.collection('qrisPay').doc(id);
  let outcome = null, info = null, promoNote = null;
  await d.runTransaction(async (tx) => {
    outcome = null; info = null; promoNote = null;
    const s = await tx.get(ref);
    if (!s.exists || s.data().status !== 'menunggu') return;
    const q = s.data(), o = q.order || {}, now = Date.now(), isDep = q.kind === 'deposit';
    const pref = d.doc('profiles/' + q.uid), ps = await tx.get(pref);
    let ok = isDep || now <= q.expiresAt, game = null, den = null;
    if (ok && !isDep) { // produk harus masih ada, aktif, dan harganya sama seperti saat QRIS dibuat
      const [gs, ds] = await Promise.all([tx.get(d.doc('games/' + o.game_id)), tx.get(d.doc('denominations/' + o.denomination_id))]);
      ok = gs.exists && ds.exists && gs.data().active !== false && ds.data().active !== false && Number(ds.data().price) === o.unit && ds.data().game_id === o.game_id;
      if (ok) { game = gs.data(); den = ds.data(); }
    }
    info = { uid: q.uid, name: o.name || 'Pesanan', base: q.base, total: q.payTotal };
    if (!ps.exists) { tx.update(ref, { status: 'perlu-dicek', paidAt: now }); outcome = 'perlu-dicek'; return; }
    const p = ps.data();
    const credit = (amount, note) => { // uang masuk ke saldo akun + catatan deposit
      ledger(tx, d, pref, p, { delta: amount, kind: 'deposit', amount, product_name: 'Deposit', note, deposit_id: id });
      tx.set(d.collection('deposits').doc(id), { deposit_code: makeCode('GVD'), user_id: q.uid, amount, status: 'accepted', note, payment_method_name: 'QRIS', pay_ref: q.extId, processed_at: iso(), created_at: iso() });
    };
    if (isDep) { credit(q.base, 'Deposit via QRIS PunyaKios'); tx.update(ref, { status: 'selesai', paidAt: now }); outcome = 'deposit'; return; }
    if (ok) {
      const code = makeCode('GVO');
      tx.set(d.collection('orders').doc(id), clean({ order_code: code, user_id: q.uid, game_id: o.game_id, denomination_id: o.denomination_id, game_name: game.name, denomination_name: den.name, payment_method_name: 'QRIS', uid_game: o.uid_game, server_id: o.server_id || null, whatsapp: o.whatsapp, amount: q.base, discount: q.discount || 0, promo_code: o.promo_code || null, paid_with_balance: false, pay_method: 'link', pay_fee: q.payFee, pay_ref: q.extId, status: 'processing', created_at: iso(), updated_at: iso() }));
      tx.update(ref, { status: 'selesai', orderId: id, paidAt: now });
      outcome = 'selesai'; info.code = code; if (q.promo_id) promoNote = { id: q.promo_id, discount: q.discount || 0, uid: q.uid };
    } else {
      credit(q.payTotal, 'Pembayaran pesanan kedaluwarsa / harga berubah — dikreditkan ke saldo');
      tx.update(ref, { status: 'dikreditkan', paidAt: now });
      outcome = 'dikreditkan';
    }
  });
  if (outcome === 'deposit') await L.notifyUser(d, info.uid, 'Deposit berhasil', `Saldo Anda bertambah ${rp(info.base)}.`, 'deposit', '/account');
  else if (outcome === 'selesai') {
    await L.notifyUser(d, info.uid, 'Pembayaran diterima', `${info.name} · ${rp(info.total)} sedang diproses.`, 'order', '/order/' + info.code);
    await L.notifyAdmins(d, 'Pesanan baru (QRIS)', `${info.code} · ${info.name} · ${rp(info.base)}`, 'order', '/admin');
    if (promoNote) await redeemPromo(d, { id: promoNote.id, ref: d.doc('promo_codes/' + promoNote.id) }, promoNote.uid, id, promoNote.discount);
    await trySend(d, id, info.uid);
  } else if (outcome === 'dikreditkan') await L.notifyUser(d, info.uid, 'Pembayaran masuk ke saldo', `${rp(info.total)} ditambahkan ke saldo akun (waktu bayar habis atau harga produk berubah). Silakan pesan ulang.`, 'deposit', '/account');
  else if (outcome === 'perlu-dicek') await L.notifyAdmins(d, 'Pembayaran perlu dicek', `Akun pembayaran ${id} tidak ditemukan. Cek manual di PunyaKios.`, 'qris', '/admin');
  const st = (await ref.get()).data() || {};
  return { status: st.status, orderId: st.orderId || null, kind: st.kind || 'order' };
}

// Cek ke PunyaKios apakah QRIS sudah "paid"; kalau ya, proses lewat fulfill().
async function syncIntent(d, id, opts) {
  const ref = d.collection('qrisPay').doc(id), s = await ref.get();
  if (!s.exists) return { status: 'tidak-ada' };
  const q = s.data();
  if (q.status === 'selesai' && q.orderId) { // pastikan pesanan benar-benar terkirim ke provider (coba ulang bila belum)
    const k = 'send-' + id;
    if (Date.now() - (CHK.get(k) || 0) > 20000) {
      CHK.set(k, Date.now());
      const o = await d.collection('orders').doc(q.orderId).get();
      if (o.exists && o.data().status === 'processing' && !o.data().provider_sent_at && !o.data().provider_manual && Date.now() - Date.parse(o.data().created_at || 0) > 15000) await trySend(d, q.orderId, q.uid);
    }
  }
  if (q.status !== 'menunggu') return { status: q.status, orderId: q.orderId || null, kind: q.kind || 'order' };
  if (!(opts && opts.force)) { if (Date.now() - (CHK.get(id) || 0) < 4000) return { status: 'menunggu' }; }
  CHK.set(id, Date.now()); if (CHK.size > 500) CHK.clear();
  const r = await PK.payStatus(q.extId), dd = (r.data && r.data.data) || {};
  const expired = Date.now() > (q.expiresAt || 0);
  const pst = String(dd.status || '').toLowerCase(), pm = String((r.data && r.data.message) || '').replace(/\s+/g, ' ').slice(0, 120);
  const dbg = { http: r.http, status: pst || null, amount: dd.amount != null ? Number(dd.amount) : null, msg: pm || null };
  await ref.update({ provHttp: r.http, provStatus: pst || null, provAmount: dbg.amount, provMsg: pm || null, lastCheckAt: Date.now() }).catch(() => {});
  if (!r.ok || !PAID.has(pst)) return { status: expired ? 'kadaluarsa' : 'menunggu', dbg };
  const amt = Number(dd.total_amount != null ? dd.total_amount : dd.amount);
  const maxPay = q.base + Math.max(10000, Math.round(q.base * 0.05));
  if (!(Number.isFinite(amt) && amt >= q.base && amt <= maxPay)) { // dibayar kurang / janggal: jangan diproses otomatis (biaya admin metode bayar boleh menambah di atas nominal)
    await ref.update({ status: 'selisih', paidAmount: Number.isFinite(amt) ? amt : null }).catch(() => {});
    await L.notifyAdmins(d, 'Pembayaran tidak sesuai', `${rp(amt)} dibayar, seharusnya minimal ${rp(q.base)} (${id}). Cek manual.`, 'qris', '/admin');
    return { status: 'selisih' };
  }
  return fulfill(d, id);
}

// Khusus admin: ringkasan pembayaran QRIS terbaru + nasib pesanannya (sekaligus memeriksa ulang yang masih menunggu).
async function diag(d) {
  const T0 = Date.now(), qs = await d.collection('qrisPay').orderBy('createdAt', 'desc').limit(6).get(), rows = [];
  for (const x of qs.docs) {
    let q = x.data();
    if (Date.now() - T0 < 20000 && (q.status === 'menunggu' || q.status === 'selesai')) { try { await syncIntent(d, x.id, { force: true }); q = (await x.ref.get()).data() || q; } catch (e) { q.err = q.err || String(e.message).slice(0, 100); } }
    let o = null;
    if (q.orderId) { const os = await d.collection('orders').doc(q.orderId).get(); o = os.exists ? { status: os.data().status, provider: os.data().provider || null, provider_status: os.data().provider_status || null, kirim: os.data().provider_sent_at ? 'sudah dikirim' : 'BELUM dikirim', message: os.data().provider_message || null } : { status: 'pesanan tidak ditemukan' }; }
    rows.push({ id: x.id, kind: q.kind || 'order', name: (q.order && q.order.name) || '', user: q.userName || '', total: q.payTotal || q.base || 0, status: q.status, at: q.createdAt, provStatus: q.provStatus || null, provHttp: q.provHttp || null, provMsg: q.provMsg || null, err: q.err || null, order: o });
  }
  return { ok: true, rows };
}

module.exports = L.handler(async (req) => {
  const me = await L.authUser(req), d = L.db(), b = req.body || {}, a = String(b.action || '');
  const isAdm = () => L.isAdminUid(d, me.uid);
  if (a === 'create') {
    try { return await create(d, me.uid, b); }
    catch (e) { if (e.detail && (await isAdm().catch(() => false))) e.message += ' [admin: ' + String(e.detail).slice(0, 200) + ']'; throw e; }
  }
  if (a === 'diag') { await L.assertAdmin(d, me.uid); return diag(d); }
  if (a === 'check') {
    const id = String(b.id || '');
    if (!ID_RE.test(id)) throw fail(400, 'ID tidak valid');
    const s = await d.collection('qrisPay').doc(id).get();
    if (!s.exists || s.data().uid !== me.uid) throw fail(404, 'Pembayaran tidak ditemukan');
    const out = await syncIntent(d, id, { force: true });
    if (out.dbg && !(await isAdm().catch(() => false))) delete out.dbg;
    return { ok: true, ...out };
  }
  throw fail(400, 'action tidak dikenal');
});
module.exports.syncIntent = syncIntent;
module.exports.fulfill = fulfill;
module.exports.trySend = trySend;
