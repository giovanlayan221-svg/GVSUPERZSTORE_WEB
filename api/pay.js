// /api/pay.js — pembelian memakai SALDO akun + cek promo. Semua perubahan saldo terjadi di server (browser tidak bisa).
//   action: 'order'      {game_id, denomination_id, uid_game, server_id?, whatsapp, promo_code?}  -> potong saldo + buat pesanan + kirim ke provider
//           'checkPromo' {code, game_id, subtotal}
const L = require('./_lib');
const { resolvePromo, redeemPromo } = require('./_promo');
const { fail, iso, makeCode, ledger, clean } = L;

// Validasi input pesanan (dipakai juga oleh pkqris.js).
function prepOrder(b) {
  b = b || {};
  const game_id = String(b.game_id || ''), denomination_id = String(b.denomination_id || '');
  const uid_game = String(b.uid_game || '').trim().slice(0, 60) || '-', server_id = String(b.server_id || '').trim().slice(0, 30);
  const whatsapp = String(b.whatsapp || '').trim();
  const promo_code = String(b.promo_code || '').trim().slice(0, 40);
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(game_id) || !/^[A-Za-z0-9_-]{6,40}$/.test(denomination_id)) throw fail(400, 'Produk tidak valid');
  if (!/^[0-9+]{8,20}$/.test(whatsapp)) throw fail(400, 'Nomor WhatsApp tidak valid (8-20 digit)');
  return { game_id, denomination_id, uid_game, server_id, whatsapp, promo_code };
}

// Baca & validasi produk + nominal dari database (harga TIDAK dipercaya dari browser).
async function loadProduct(read, o) {
  const [gs, ds] = await Promise.all([read(L.db().collection('games').doc(o.game_id)), read(L.db().collection('denominations').doc(o.denomination_id))]);
  if (!gs.exists || !ds.exists) throw fail(400, 'Produk tidak ditemukan');
  const game = gs.data(), den = ds.data();
  if (den.game_id !== o.game_id) throw fail(400, 'Produk tidak ditemukan');
  if (game.active === false || den.active === false) throw fail(400, 'Produk sedang tidak tersedia');
  const req = game.account_requirement || (game.requires_server ? 'uid_server' : 'uid');
  const needUid = (game.product_type || 'topup') === 'topup' && req !== 'none', needSrv = (game.product_type || 'topup') === 'topup' && req === 'uid_server';
  if (needUid && o.uid_game.length < 2) throw fail(400, 'UID / ID akun wajib diisi');
  if (needSrv && !o.server_id) throw fail(400, 'Server ID wajib diisi');
  return { game, den };
}

async function orderWithBalance(d, uid, body) {
  const o = prepOrder(body);
  let disc = 0, promo = null;
  if (o.promo_code) {
    const [gs, ds] = await Promise.all([d.doc('games/' + o.game_id).get(), d.doc('denominations/' + o.denomination_id).get()]);
    if (!gs.exists || !ds.exists) throw fail(400, 'Produk tidak ditemukan');
    const unit = Number(ds.data().member_price != null ? ds.data().member_price : ds.data().price);
    const r = await resolvePromo(d, o.promo_code, uid, o.game_id, unit); disc = r.discount; promo = r.promo;
  }
  let out = null;
  await d.runTransaction(async (tx) => {
    out = null;
    const pref = d.doc('profiles/' + uid);
    const [ps, gs, ds] = await Promise.all([tx.get(pref), tx.get(d.doc('games/' + o.game_id)), tx.get(d.doc('denominations/' + o.denomination_id))]);
    if (!ps.exists) throw fail(404, 'Profil tidak ditemukan');
    const { game, den } = await loadProduct(async (r) => (r.path === gs.ref.path ? gs : ds), o);
    const p = ps.data(), unit = Number(den.member_price != null ? den.member_price : den.price);
    if (!Number.isInteger(unit) || unit < 0) throw fail(400, 'Harga produk tidak valid');
    const total = Math.max(0, unit - Math.min(disc, unit)), key = o.denomination_id + '|' + o.uid_game + '|' + o.server_id + '|' + total, now = Date.now();
    if (p.rl_key === key && now - Number(p.rl_at || 0) < 15000) throw fail(409, 'Pesanan yang sama baru saja dibuat. Cek Riwayat sebelum mengulang.', { code: 'dup' });
    if (Number(p.balance || 0) < total) throw fail(402, 'Saldo tidak mencukupi', { code: 'saldo' });
    const oref = d.collection('orders').doc(), code = makeCode('GVO');
    const led = ledger(tx, d, pref, p, { delta: -total, kind: 'purchase', amount: total, status: 'processing', product_name: game.name, denomination_name: den.name, base_price: den.price, member_price: den.member_price, promo_code: promo ? promo.code.toUpperCase() : null, discount: disc, order_id: oref.id });
    tx.update(pref, { rl_key: key, rl_at: now });
    tx.set(oref, clean({ order_code: code, user_id: uid, game_id: o.game_id, denomination_id: o.denomination_id, game_name: game.name, denomination_name: den.name, payment_method_name: 'Saldo Akun', uid_game: o.uid_game, server_id: o.server_id || null, whatsapp: o.whatsapp, amount: total, discount: disc, promo_code: promo ? promo.code.toUpperCase() : null, paid_with_balance: true, pay_method: 'balance', status: 'processing', transaction_id: led.id, created_at: iso(), updated_at: iso() }));
    out = { order_id: oref.id, order_code: code, transaction_code: led.transaction_code, total, name: game.name + ' ' + den.name };
  });
  if (promo) await redeemPromo(d, promo, uid, out.order_id, disc);
  await L.notifyAdmins(d, 'Pesanan baru', out.order_code + ' · ' + out.name + ' · ' + L.rp(out.total), 'order', '/admin');
  try { await require('./haybi').kirim(d, { uid, isAdmin: true }, out.order_id, { quick: true }); } // gagal kirim tidak membatalkan pesanan: dicoba ulang penyapu / admin
  catch (e) { if (!(e && e.http === 409)) console.warn('kirim', out.order_id, e && e.message); }
  return { order_code: out.order_code, transaction_code: out.transaction_code, total: out.total };
}

module.exports = L.handler(async (req) => {
  const me = await L.authUser(req), d = L.db(), b = req.body || {}, a = String(b.action || '');
  if (a === 'order') return orderWithBalance(d, me.uid, b);
  if (a === 'checkPromo') {
    const code = String(b.code || '').trim(), sub = Number(b.subtotal);
    if (!code || !Number.isInteger(sub) || sub < 0) throw fail(400, 'Data promo tidak valid');
    const r = await resolvePromo(d, code, me.uid, String(b.game_id || ''), sub);
    return { code: r.promo.code.toUpperCase(), name: r.promo.name, discount: r.discount };
  }
  throw fail(400, 'action tidak dikenal');
});
module.exports.prepOrder = prepOrder;
module.exports.loadProduct = loadProduct;
