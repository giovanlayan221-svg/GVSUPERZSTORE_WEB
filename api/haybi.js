// /api/haybi.js — satu-satunya pintu website ke provider H2H (HAYBI dan PunyaKios). Kredensial TIDAK pernah keluar dari server.
// Semua request wajib login. Body JSON { action, ... }
//   ADMIN saja   : saldo | produk {kategori?,operator?} | harga {produk}        (HAYBI)
//                  pk_saldo | pk_produk {category?,provider?} | pk_untung {days?} (PunyaKios)
//   Pemilik/admin: kirim {orderId}  -> kirim pesanan (saldo sudah dipotong / QRIS sudah lunas) ke provider
//                  status {orderId} -> cek status ke provider & perbarui
// Provider dipilih admin per NOMINAL (denominations.provider = 'haybi' | 'punyakios', denominations.provider_sku = kode produk).
// Nominal tanpa provider/SKU tetap diproses manual oleh admin.
const L = require('./_lib');
const H = require('./_haybi');
const PK = require('./_punyakios');
const { setOrderStatus, syncOrder } = require('./_orders');
const { fail, iso, notifyAdmins } = L;

const CODE_RE = /^[A-Za-z0-9._\-]{1,64}$/;
const TARGET_RE = /^[A-Za-z0-9._\-@()+ ]{3,64}$/;   // '+' untuk email bertanda (nama+tag@gmail.com)

// Daftar produk HAYBI -> bentuk seragam { sku, nama, harga, kategori, operator, status }.
// Seperti GVSMARTPAY: cari array objek terbesar di mana pun dalam respons, harga "Rp 6.989" tetap terbaca.
function pickList(d) {
  let best = [];
  const walk = (v, n) => { if (n > 6) return; if (Array.isArray(v)) { if (v.length > best.length && v[0] && typeof v[0] === 'object') best = v; v.forEach((x) => walk(x, n + 1)); } else if (v && typeof v === 'object') Object.values(v).forEach((x) => walk(x, n + 1)); };
  walk(d, 0);
  return best.length ? best : null;
}
const first = (o, keys) => { for (const k of keys) if (o[k] != null && o[k] !== '' && typeof o[k] !== 'object') return o[k]; return null; };
const num = (v) => {
  if (typeof v === 'number') return v > 0 ? v : null;
  const s = String(v == null ? '' : v).trim();
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return Number(s.replace(/\./g, ''));
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s) > 0 ? Number(s) : null;
  const n = Number(s.replace(/[^\d]/g, '')); return n > 0 ? n : null;
};
function normProduct(x) {
  if (!x || typeof x !== 'object') return { sku: '' };
  let sku = '';
  for (const k of ['sku', 'kode', 'code', 'kode_produk', 'kode_sku', 'product_code', 'produk', 'id']) { const v = x[k]; if (v != null && CODE_RE.test(String(v))) { sku = String(v); break; } }
  const nama = first(x, ['nama', 'name', 'nama_produk', 'product_name', 'keterangan', 'deskripsi', 'description']) || sku;
  let harga = null; for (const k of ['harga', 'price', 'harga_beli', 'harga_modal', 'harga_jual', 'amount']) { harga = num(x[k]); if (harga) break; }
  const st = first(x, ['status', 'stok', 'available', 'aktif']);
  return { sku, nama: String(nama).slice(0, 160), harga, kategori: String(first(x, ['kategori', 'category', 'tipe', 'type', 'jenis', 'group']) || ''), operator: String(first(x, ['operator', 'brand', 'provider', 'merk', 'game', 'vendor']) || ''), status: st == null ? '' : String(st) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tujuan ke provider: ID game (+ server) untuk game; nomor WhatsApp (angka) untuk apps premium tanpa ID.
// HAYBI: ID dan server menyatu tanpa pemisah. PunyaKios (sesuai penjelasan owner): ID game dan server dipisah koma, mis. 12345678,1234.
const PKSRV_RE = /^[A-Za-z0-9._\-]{3,40},[A-Za-z0-9._\-]{1,16}$/;
function targetOf(x, prov) {
  const gid = String(x.uid_game || '').trim(), srv = String(x.server_id || '').trim();
  if (gid && gid !== '-') return prov === 'punyakios' && srv ? gid + ',' + srv : gid + srv;
  return String(x.whatsapp || '').replace(/\D/g, '');
}

async function kirim(d, who, orderId, opts) {
  const quick = !!(opts && opts.quick); // quick: dipanggil dari server (webhook/penyapu): jangan menunggu lama
  const T0 = Date.now();
  let ref = 'GV' + orderId, prov = 'haybi', ord = null, den = null;
  await d.runTransaction(async (tx) => {
    ord = null; den = null;
    const or = d.collection('orders').doc(orderId), s = await tx.get(or);
    if (!s.exists) throw fail(404, 'Pesanan tidak ditemukan');
    const x = s.data();
    if (x.user_id !== who.uid && !who.isAdmin) throw fail(403, 'Bukan pesananmu');
    if (x.status !== 'processing') throw fail(409, 'Pesanan sudah final');
    if (x.provider_sent_at) throw fail(409, 'Pesanan sudah pernah dikirim ke provider');
    if (!x.denomination_id) return;
    const ds = await tx.get(d.collection('denominations').doc(x.denomination_id));
    if (!ds.exists) return;
    const p = ds.data();
    if (!p.provider_sku || !['haybi', 'punyakios'].includes(p.provider)) return;      // belum dipetakan => manual
    if (!CODE_RE.test(String(p.provider_sku))) throw fail(400, 'Kode produk (SKU) tidak valid');
    // anti-manipulasi: nominal yang dibayar tidak boleh di bawah harga di database
    const floor = Number(p.member_price != null ? p.member_price : p.price);
    if (!(Number(x.amount) + (Number(x.discount) || 0) >= floor)) throw fail(400, 'Nominal pesanan tidak sesuai harga produk');
    const tg = targetOf(x, p.provider);
    if (!(p.provider === 'punyakios' && tg.indexOf(',') >= 0 ? PKSRV_RE.test(tg) : TARGET_RE.test(tg))) throw fail(400, 'Nomor/ID tujuan tidak valid');
    if (p.provider === 'punyakios') { prov = 'punyakios'; ref = 'PK' + orderId; }
    tx.update(or, { provider_ref: ref, provider_status: 'sending', provider: prov, provider_sku: p.provider_sku, provider_sent_at: iso(), provider_updated_at: iso(), updated_at: iso() });
    ord = x; den = p;
  });
  if (!ord) return { ok: true, skipped: 'manual', note: 'Nominal belum dipetakan ke provider (atau format tujuan belum didukung) — diproses manual oleh admin' };
  const target = targetOf(ord, prov), or = d.collection('orders').doc(orderId);
  const mark = (o) => or.update({ ...o, provider_updated_at: iso(), updated_at: iso() }).catch(() => {});
  const release = () => or.update({ provider_ref: L.admin.firestore.FieldValue.delete(), provider_status: L.admin.firestore.FieldValue.delete(), provider_sent_at: L.admin.firestore.FieldValue.delete(), provider: L.admin.firestore.FieldValue.delete(), provider_sku: L.admin.firestore.FieldValue.delete(), updated_at: iso() }).catch(() => {});
  const poll = async () => {
    if (quick) return { ok: true, state: 'pending' };
    for (const w of [3000, 5000, 6000]) {
      if (Date.now() - T0 > 20000) break;
      await sleep(w);
      try { const r = await syncOrder(d, orderId); if (r.state === 'sukses') return { ok: true, state: 'sukses' }; if (r.state === 'gagal' || r.state === 'error') return { ok: true, state: 'error' }; } catch (e) { break; }
    }
    return { ok: true, state: 'pending' };
  };

  if (prov === 'punyakios') {
    let res;
    try { res = await PK.order(ref, String(den.provider_sku), target); }
    catch (e) {
      if (e.code === 'NOCFG') { await release(); return { ok: true, skipped: 'manual', note: 'PunyaKios belum dikonfigurasi — diproses manual oleh admin' }; }
      await mark({ provider_status: 'unknown', provider_message: 'Status belum pasti, sedang dicek' });
      return { ok: true, state: 'unknown', note: 'Status belum pasti, dicek ulang otomatis' };
    }
    const body = res.data || {}, dd = body.data || {}, em = String(body.message || body.status || ('HTTP ' + res.http)).slice(0, 160);
    if (res.ok) { // HTTP 2xx saja BUKAN bukti berhasil: yang dipakai status transaksinya
      const st = PK.norm(dd.status);
      if (dd.ref_id && dd.ref_id !== ref) { await mark({ provider_status: 'unknown', provider_message: 'Respons tidak cocok, sedang dicek' }); return poll(); }
      if (st === 'sukses') { const c = Number(dd.amount); await setOrderStatus(d, orderId, 'success', { onlyFrom: ['processing'], sn: dd.sn || null, msg: dd.message || null, cost: Number.isFinite(c) ? c : null, trx: dd.trx_id || null }); return { ok: true, state: 'sukses' }; }
      if (st === 'error') { await setOrderStatus(d, orderId, 'failed', { onlyFrom: ['processing'], msg: 'Transaksi gagal di provider' }); return { ok: true, state: 'error' }; }
      await mark({ provider_status: st === 'pending' ? 'pending' : 'unknown' });
      return poll();
    }
    if (res.http === 422) { await mark({ provider_status: 'pending' }); return poll(); } // TRX_DUPLICATE: ikuti statusnya, JANGAN order ulang
    if ([400, 401, 404, 429, 503].includes(res.http)) {
      let conf = null; try { conf = await PK.status(ref); } catch (e) { conf = null; }
      if (conf && conf.http === 404) {
        await setOrderStatus(d, orderId, 'failed', { onlyFrom: ['processing'], msg: 'Ditolak provider (HTTP ' + res.http + ')' });
        if (res.http !== 404) await notifyAdmins(d, 'PunyaKios menolak order', (ord.order_code || 'Pesanan') + ' · ' + em + ' (HTTP ' + res.http + '). Cek saldo / kredensial PunyaKios.', 'order', '/admin');
        return { ok: true, state: 'error' };
      }
      if (conf && conf.ok) { await mark({ provider_status: 'pending' }); return poll(); }
      await mark({ provider_status: 'unknown', provider_message: 'Status belum pasti, sedang dicek' });
      return { ok: true, state: 'unknown', note: 'Penolakan belum terkonfirmasi, tidak di-refund otomatis' };
    }
    await mark({ provider_status: 'unknown', provider_message: 'Status belum pasti, sedang dicek' });
    return { ok: true, state: 'unknown' };
  }

  // ---- HAYBI ----
  let res;
  try { res = await H.transaksi(ref, String(den.provider_sku), target); }
  catch (e) {
    if (e.code === 'NOCFG') { await release(); return { ok: true, skipped: 'manual', note: 'HAYBI belum dikonfigurasi — diproses manual oleh admin' }; }
    // Hasil tidak diketahui (timeout/jaringan): JANGAN refund dulu, transaksi bisa saja sudah masuk di HAYBI.
    await mark({ provider_status: 'unknown', provider_message: e.message });
    return { ok: true, state: 'unknown', note: 'Status belum pasti, admin akan memeriksa' };
  }
  const dd = res.data || {}, st = H.norm(dd);
  if (st === 'sukses') { await setOrderStatus(d, orderId, 'success', { onlyFrom: ['processing'], sn: dd.sn || null, msg: dd.pesan || null }); return { ok: true, state: 'sukses' }; }
  if (st === 'error') { await setOrderStatus(d, orderId, 'failed', { onlyFrom: ['processing'], msg: dd.pesan || ('rc ' + (dd.rc || '?')) }); return { ok: true, state: 'error', pesan: dd.pesan || null }; }
  await mark({ provider_status: st === 'pending' ? 'pending' : 'unknown', provider_message: dd.pesan || null, provider_code: dd.rc || null });
  if (st === 'pending' && !quick) {
    for (const w of [3000, 5000, 6000]) {
      if (Date.now() - T0 > 20000) break;
      await sleep(w);
      try { const r = await syncOrder(d, orderId); if (r.state === 'sukses') return { ok: true, state: 'sukses' }; if (r.state === 'error' || r.state === 'gagal') break; } catch (e) { break; }
    }
  }
  return { ok: true, state: st === 'pending' ? 'pending' : 'unknown' };
}

// Ringkasan admin: modal, penjualan, untung dari orderCosts (ditulis server saat transaksi PunyaKios sukses).
async function untung(d, days) {
  const n = Math.min(90, Math.max(1, Number(days) || 30)), since = Date.now() - n * 864e5;
  const q = await d.collection('orderCosts').where('at', '>=', since).orderBy('at', 'desc').limit(1000).get();
  let sales = 0, cost = 0, profit = 0; const recent = [];
  q.docs.forEach((s, i) => { const x = s.data(); sales += Number(x.total) || 0; cost += Number(x.cost) || 0; profit += Number(x.profit) || 0; if (i < 15) recent.push({ order_id: x.order_id, sku: x.sku, cost: x.cost, total: x.total, profit: x.profit, at: x.at }); });
  return { ok: true, days: n, count: q.size, truncated: q.size >= 1000, sales, cost, profit, recent };
}

async function status(d, who, orderId) {
  const s = await d.collection('orders').doc(orderId).get();
  if (!s.exists) throw fail(404, 'Pesanan tidak ditemukan');
  const x = s.data();
  if (x.user_id !== who.uid && !who.isAdmin) throw fail(403, 'Bukan pesananmu');
  if (!x.provider_ref) throw fail(409, 'Pesanan ini belum dikirim ke provider');
  const r = await syncOrder(d, orderId), out = { ok: true, state: r.state };
  if (who.isAdmin && r.raw) out.raw = r.raw; // detail mentah hanya untuk admin
  return out;
}

module.exports = L.handler(async (req) => {
  const me = await L.authUser(req), d = L.db(), isAdmin = await L.isAdminUid(d, me.uid), who = { uid: me.uid, isAdmin };
  const b = req.body || {}, a = String(b.action || '');
  if (['saldo', 'produk', 'harga'].includes(a)) {
    if (!isAdmin) throw fail(403, 'Khusus admin');
    if (a === 'saldo') return (await H.cekSaldo()).data;
    if (a === 'produk') {
      for (const k of ['kategori', 'operator']) if (b[k] != null && !/^[\w .\-]{1,40}$/.test(String(b[k]))) throw fail(400, k + ' tidak valid');
      const r = await H.produk(b.kategori, b.operator), d = r.data || {};
      const list = pickList(d);
      if (!list) return { ok: false, products: [], pesan: d.pesan || d.message || null, raw: d };   // format tak dikenali: tampilkan mentah supaya bisa dicek
      const prods = list.slice(0, 6000).map(normProduct).filter((x) => x.sku);
      return { ok: prods.length > 0, count: prods.length, products: prods, pesan: d.pesan || d.message || null, sample: list[0] };
    }
    if (!CODE_RE.test(String(b.produk || ''))) throw fail(400, 'Kode produk tidak valid');
    return (await H.cekHarga(String(b.produk))).data;
  }
  if (['pk_saldo', 'pk_produk', 'pk_untung'].includes(a)) {
    if (!isAdmin) throw fail(403, 'Khusus admin');
    if (a === 'pk_untung') return untung(d, b.days);
    if (a === 'pk_saldo') {
      const r = await PK.profile(), p = (r.data && r.data.data) || {};
      if (!r.ok) throw fail(502, 'PunyaKios: ' + String((r.data && (r.data.message || r.data.status)) || 'HTTP ' + r.http).slice(0, 120));
      const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
      return { ok: true, name: p.name || null, saldo: Number(p.saldo) || 0, is_sandbox: !!p.is_sandbox, webhook_url: p.webhook_url || null, expected_webhook: host ? 'https://' + host + '/api/punyakios-callback' : null };
    }
    for (const k of ['category', 'provider']) if (b[k] != null && b[k] !== '' && !/^[\w .\-]{1,40}$/.test(String(b[k]))) throw fail(400, k + ' tidak valid');
    const r = await PK.produk({ category: b.category || '', provider: b.provider || '' }), p = (r.data && r.data.data) || {};
    if (!r.ok) throw fail(502, 'PunyaKios: ' + String((r.data && (r.data.message || r.data.status)) || 'HTTP ' + r.http).slice(0, 120));
    const list = (Array.isArray(p.products) ? p.products : []).slice(0, 3000).map((x) => ({ sku: String(x.sku || ''), nama: String(x.nama || ''), category: String(x.category || ''), provider: String(x.provider || ''), price: Number(x.price) || 0 }));
    return { ok: true, maintenance: !!p.maintenance, count: list.length, products: list };
  }
  if (a === 'kirim' || a === 'status') {
    if (!/^[A-Za-z0-9]{10,40}$/.test(String(b.orderId || ''))) throw fail(400, 'orderId tidak valid');
    return a === 'kirim' ? kirim(d, who, String(b.orderId)) : status(d, who, String(b.orderId));
  }
  throw fail(400, 'action tidak dikenal');
});
module.exports.kirim = kirim;
