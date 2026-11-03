// Validasi kode promo (server-side). Melempar Error bermakna bila tidak valid.
const { fail, rp } = require('./_lib');

async function resolvePromo(d, code, uid, gameId, subtotal) {
  const norm = String(code || '').trim().toUpperCase();
  if (!norm) throw fail(400, 'Kode promo kosong');
  const all = await d.collection('promo_codes').get();
  const doc = all.docs.find((x) => String(x.data().code || '').trim().toUpperCase() === norm);
  const p = doc && doc.data();
  if (!p || p.active === false) throw fail(400, 'Kode promo tidak ditemukan');
  const now = Date.now();
  if (p.starts_at && new Date(p.starts_at).getTime() > now) throw fail(400, 'Kode promo belum berlaku');
  if (p.ends_at && new Date(p.ends_at).getTime() < now) throw fail(400, 'Kode promo sudah kedaluwarsa');
  if (p.max_uses != null && Number(p.used_count || 0) >= Number(p.max_uses)) throw fail(400, 'Kuota kode promo sudah habis');
  if (p.game_id && p.game_id !== gameId) throw fail(400, 'Kode promo tidak berlaku untuk produk ini');
  if (subtotal < Number(p.min_purchase || 0)) throw fail(400, 'Minimal pembelian ' + rp(p.min_purchase));
  const used = await d.collection('promo_redemptions').where('promo_id', '==', doc.id).where('user_id', '==', uid).get();
  if (used.size >= Number(p.max_uses_per_user || 1)) throw fail(400, 'Anda sudah pernah memakai kode promo ini');
  let disc = p.discount_type === 'percent' ? Math.floor((subtotal * Number(p.discount_value || 0)) / 100) : Number(p.discount_value || 0);
  if (p.max_discount) disc = Math.min(disc, Number(p.max_discount));
  disc = Math.max(0, Math.min(Math.floor(disc), subtotal));
  return { promo: { id: doc.id, code: String(p.code), name: p.name || '', ref: doc.ref }, discount: disc };
}

// Catat pemakaian promo (dipanggil setelah pesanan benar-benar dibuat).
async function redeemPromo(d, promo, uid, orderId, discount) {
  try {
    await d.collection('promo_redemptions').add({ promo_id: promo.id, user_id: uid, order_id: orderId, discount, created_at: new Date().toISOString() });
    await d.runTransaction(async (tx) => { const s = await tx.get(promo.ref); if (s.exists) tx.update(promo.ref, { used_count: Number(s.data().used_count || 0) + 1 }); });
  } catch (e) { console.warn('redeemPromo', e.message); }
}
module.exports = { resolvePromo, redeemPromo };
