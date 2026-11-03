// /api/sync-pending.js — "penyapu": memeriksa pesanan & QRIS yang menggantung, dari SERVER (walau aplikasi pelanggan tertutup).
// Jadwalkan GET/POST ke /api/sync-pending tiap 1-2 menit (cron-job.org gratis) dengan header  Authorization: Bearer <CRON_SECRET>
// (atau ?secret=<CRON_SECRET>). Env CRON_SECRET wajib diisi di Vercel. Aman dipanggil berulang (semua langkah idempotent).
const L = require('./_lib');
const { syncOrder } = require('./_orders');
const Q = require('./pkqris');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const sec = process.env.CRON_SECRET;
  if (!sec) return res.status(200).json({ ok: true, skipped: 'Penyapu nonaktif (CRON_SECRET tidak diisi). Aman: pesanan tetap diproses lewat webhook.' });
  const got = (req.headers.authorization || '').replace('Bearer ', '') || req.headers['x-cron-secret'] || (req.query && req.query.secret);
  if (got !== sec) return res.status(401).json({ error: 'Secret salah' });
  try {
    const d = L.db(), now = Date.now(), minute = Math.floor(now / 60000), T0 = now;
    const out = { orders: { found: 0, checked: 0, finalized: 0, sent: 0, skipped: 0, errors: 0 }, qris: { found: 0, checked: 0 } };
    // Satu query status==processing (tanpa indeks komposit); sisanya disaring di memori.
    const ps = await d.collection('orders').where('status', '==', 'processing').limit(100).get();
    out.orders.found = ps.size;
    for (const x of ps.docs) {
      const o = x.data(), age = now - Date.parse(o.created_at || 0);
      if (Date.now() - T0 > 20000) { out.orders.skipped++; continue; }
      if (age > 24 * 36e5) { out.orders.skipped++; continue; }                 // lebih dari 24 jam: urusan admin
      if (!o.provider_sent_at) {                                                 // belum terkirim ke provider: coba kirim (idempotent)
        if (o.provider_manual || age < 15000) { out.orders.skipped++; continue; }
        try { await Q.trySend(d, x.id, o.user_id); out.orders.sent++; } catch (e) { out.orders.errors++; }
        continue;
      }
      if (!['pending', 'unknown', 'sending'].includes(o.provider_status)) { out.orders.skipped++; continue; }
      const gap = age < 5 * 60e3 ? 1 : age < 60 * 60e3 ? 5 : 15;               // makin tua makin jarang dicek
      if (minute % gap !== 0) { out.orders.skipped++; continue; }
      out.orders.checked++;
      try { const r = await syncOrder(d, x.id); if (['sukses', 'success', 'gagal'].includes(r.state)) out.orders.finalized++; }
      catch (e) { out.orders.errors++; console.warn('sync-pending', x.id, e && e.message); }
    }
    // QRIS yang belum terdeteksi lunas (webhook terlewat): cek ke PunyaKios. Lebih dari 24 jam = ditutup.
    const qs = await d.collection('qrisPay').where('status', '==', 'menunggu').limit(40).get();
    out.qris.found = qs.size;
    for (const x of qs.docs) {
      if (Date.now() - T0 > 24000) break;
      const age = now - (x.data().createdAt || 0);
      if (age > 24 * 36e5) { await x.ref.update({ status: 'kadaluarsa' }).catch(() => {}); continue; }
      const gap = age < 5 * 60e3 ? 1 : age < 60 * 60e3 ? 5 : 15;
      if (minute % gap !== 0) continue;
      out.qris.checked++;
      try { await Q.syncIntent(d, x.id, { force: true }); } catch (e) { console.warn('sync-qris', x.id, e && e.message); }
    }
    return res.status(200).json({ ok: true, ...out });
  } catch (e) { console.error('sync-pending', e && e.message); return res.status(500).json({ error: e.message }); }
};
