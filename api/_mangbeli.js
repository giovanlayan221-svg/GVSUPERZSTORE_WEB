// Klien MangBeli (API reseller v1) — HANYA dipakai di server (Vercel Serverless). Jangan di-import dari frontend.
// Dokumentasi: https://mangbeli.com/api-docs . Auth: sign = md5(api_key + api_secret + suffix); suffix beda per endpoint.
// Env (Vercel > Settings > Environment Variables):
//   MANGBELI_API_KEY, MANGBELI_API_SECRET  wajib. Untuk uji coba isi dengan key SANDBOX (endpoint sama, tidak memotong saldo).
//   MANGBELI_BASE_URL                      opsional, default https://mangbeli.com/api/v1
//   MANGBELI_SERVER_SEP                    opsional, pemisah user_id dan zone_id game ber-server (default kosong = digabung langsung).
//                                          Dokumentasi hanya menyebut "gabungan", format pastinya belum jelas: uji di Sandbox.
// ASUMSI yang tidak tertulis di dokumentasi (ditandai, perlu dites di Sandbox): GET memakai query string, POST memakai body JSON.
const crypto = require('crypto');
const DEF_BASE = 'https://mangbeli.com/api/v1', TIMEOUT_MS = 15000;
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

function cfg() {
  const key = process.env.MANGBELI_API_KEY, secret = process.env.MANGBELI_API_SECRET;
  const base = String(process.env.MANGBELI_BASE_URL || DEF_BASE).trim().replace(/\/+$/, '');
  if (!key || !secret) { const e = new Error('MangBeli belum dikonfigurasi di server (MANGBELI_API_KEY / MANGBELI_API_SECRET)'); e.code = 'NOCFG'; throw e; }
  if (!/^https:\/\/[^\s/]+(\/[^\s]*)?$/i.test(base)) { const e = new Error('MANGBELI_BASE_URL harus diawali https://'); e.code = 'NOCFG'; throw e; }
  return { key, secret, base };
}
const sign = (key, secret, suffix) => md5(String(key) + String(secret) + String(suffix == null ? '' : suffix));
function scrub(v, ks) { let t = JSON.stringify(v === undefined ? null : v); for (const k of ks) if (k && String(k).length >= 4) t = t.split(String(k)).join('***'); return JSON.parse(t); }

// method GET: params masuk query string; POST: body JSON. Return { ok, http, data }.
async function call(method, path, suffix, params) {
  const { key, secret, base } = cfg();
  const p = Object.assign({}, params || {}, { api_key: key, sign: sign(key, secret, suffix) });
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let r, text;
  try {
    if (method === 'GET') r = await fetch(base + path + '?' + new URLSearchParams(p).toString(), { headers: { Accept: 'application/json' }, signal: ctl.signal });
    else r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(p), signal: ctl.signal });
    text = await r.text();
  } catch (e) {
    const err = new Error(e && e.name === 'AbortError' ? 'MangBeli tidak merespons (timeout ' + TIMEOUT_MS / 1000 + ' dtk)' : 'Gagal menghubungi MangBeli');
    err.code = e && e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK'; throw err;
  } finally { clearTimeout(timer); }
  let data;
  try { data = JSON.parse(text); } catch (e) { const err = new Error('Respons MangBeli bukan JSON (HTTP ' + r.status + ')'); err.code = 'BADRESP'; err.http = r.status; throw err; }
  return { ok: r.ok, http: r.status, data: scrub(data, [key, secret]) };
}

// Status dokumentasi: pending | processing | success | failed. 'failed' = status akhir (saldo dikembalikan sistem MangBeli).
const norm = (s) => { const v = String(s == null ? '' : s).toLowerCase(); return v === 'success' ? 'sukses' : v === 'failed' ? 'error' : (v === 'pending' || v === 'processing') ? 'pending' : 'unknown'; };

// Webhook: signature = md5(event + ref_id + timestamp + api_secret)
function verifyWebhook(b) {
  const secret = process.env.MANGBELI_API_SECRET;
  if (!secret || !b || typeof b !== 'object' || typeof b.signature !== 'string') return false;
  const ref = b.data && b.data.ref_id != null ? b.data.ref_id : '';
  const exp = Buffer.from(md5(String(b.event == null ? '' : b.event) + ref + String(b.timestamp == null ? '' : b.timestamp) + secret)), got = Buffer.from(b.signature.trim().toLowerCase());
  return exp.length === got.length && crypto.timingSafeEqual(exp, got);
}
const sep = () => String(process.env.MANGBELI_SERVER_SEP || '').slice(0, 3);

module.exports = {
  norm, verifyWebhook, sep, sign,
  pricelist: () => call('GET', '/pricelist', 'pricelist'),
  balance: () => call('GET', '/balance', 'balance'),
  order: (ref, sku, customerNo) => call('POST', '/order', ref, { sku, customer_no: customerNo, ref_id: ref }),
  status: (ref) => call('GET', '/status', ref, { ref_id: ref }),
};
