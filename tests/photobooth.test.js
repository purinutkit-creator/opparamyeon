import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

test('ตู้ถ่ายรูป: ซื้อครบได้ QR บนใบเสร็จ → ตู้ที่จับคู่สแกน → ตรวจยอด → ถ่าย → พิมพ์เข้าคิว → ดาวน์โหลดเมื่อยินยอม', async () => {
  const pr = (await S.call('POST', '/api/printers', { name: 'Photo 58', conn: 'lan', address: '10.0.0.58', port: 9100, paper: 58, roles: ['receipt', 'photo'] }, { token: owner })).body.id;
  await S.call('PUT', '/api/settings/photobooth', { value: { enabled: true, require_receipt: true, min_spend: 3000, sessions_per_receipt: 1, store_photos: true, link_hours: 24 } }, { token: owner });
  // booth pairing: only a paired booth (or staff) may redeem
  assert.equal((await S.call('POST', '/api/photobooth/redeem', { code: 'x' })).status, 401);
  const { code } = (await S.call('POST', '/api/photobooth/pairing', {}, { token: owner })).body;
  const booth = (await S.call('POST', '/api/display/pair', { code })).body.token;
  const cfg = (await S.call('GET', '/api/photobooth/config', undefined, { token: booth })).body;
  assert.equal(cfg.printer.id, pr); assert.equal(cfg.printer.dots, 384);
  // a bill over the minimum gets the photo QR on its receipt
  const egg = await db.get("SELECT id, price FROM products WHERE code = 'T001'");
  const big = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { receipt: true } }, { token: owner, terminal: 'pos1' })).body;
  const rec = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt'", [big.id])).payload).data;
  assert.match(rec.photo_url, /\/photo\/#r=/);
  const small = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line(egg.id, 1)] }, payments: [{ method: 'cash', amount: egg.price, received: egg.price }], print: { receipt: true } }, { token: owner, terminal: 'pos1' })).body;
  if (small.total < 3000) assert.equal(JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt'", [small.id])).payload).data.photo_url, undefined, 'บิลยอดไม่ถึงไม่มี QR');
  // scan
  assert.equal((await S.call('POST', '/api/photobooth/redeem', { code: 'https://x/photo/#r=FAKE.abc' }, { token: booth })).body.code, 'bad_code');
  const r = await S.call('POST', '/api/photobooth/redeem', { code: rec.photo_url }, { token: booth });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.amount, big.total); assert.ok(r.body.download_url);
  assert.equal((await S.call('POST', '/api/photobooth/redeem', { code: rec.photo_url }, { token: booth })).body.code, 'used', 'ใช้สิทธิ์ซ้ำไม่ได้');
  // finish: the 1-bit strip goes to the photo printer; sent twice (network) = still one print
  const fin = await S.call('POST', `/api/photobooth/sessions/${r.body.session_id}/finish`, { print_image: PNG, color_image: PNG.replace('png', 'png'), consent: true, layout: 'strip4', shots: 4, height_dots: 1600 }, { token: booth });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  await S.call('POST', `/api/photobooth/sessions/${r.body.session_id}/finish`, { print_image: PNG, consent: true }, { token: booth });
  const jobs = await db.all("SELECT printer_id, payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'photo'", [r.body.session_id]);
  assert.equal(jobs.length, 1); assert.equal(jobs[0].printer_id, pr);
  assert.match(JSON.parse(jobs[0].payload).template.elements[0].src, /^\/files\//);
  // the customer's download link (only with consent)
  const tok = fin.body.download_url.split('#d=')[1];
  const dl = await S.call('GET', '/api/public/photo/' + tok);
  assert.equal(dl.status, 200); assert.match(dl.body.url, /^\/files\//);
  // no consent: nothing to download
  const qr2 = (await S.call('POST', '/api/photobooth/redeem', { code: (await (async () => { const o = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { receipt: true } }, { token: owner, terminal: 'pos1' })).body; return JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt'", [o.id])).payload).data.photo_url; })()) }, { token: booth })).body;
  const fin2 = (await S.call('POST', `/api/photobooth/sessions/${qr2.session_id}/finish`, { print_image: PNG, consent: false }, { token: booth })).body;
  assert.equal(fin2.download_url, null);
  assert.equal((await S.call('GET', '/api/public/photo/' + qr2.download_url.split('#d=')[1])).status, 404);
  // report + reprint
  const rep = (await S.call('GET', '/api/photobooth/report', undefined, { token: owner })).body;
  assert.ok(rep.today.sessions >= 2 && rep.today.prints >= 2);
  assert.equal((await S.call('POST', `/api/photobooth/sessions/${r.body.session_id}/reprint`, {}, { token: owner })).status, 200);
  // expired photos are deleted
  await db.run('UPDATE photo_sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', r.body.session_id]);
  const { cleanupPhotos } = await import('../server/routes/photobooth.js');
  assert.ok(await cleanupPhotos() >= 1);
  assert.equal((await S.call('GET', '/api/public/photo/' + tok)).status, 404);
  // revoked booth is locked out
  const dev = (await S.call('GET', '/api/photobooth/devices', undefined, { token: owner })).body[0];
  await S.call('POST', `/api/photobooth/devices/${dev.id}/revoke`, {}, { token: owner });
  assert.equal((await S.call('GET', '/api/photobooth/config', undefined, { token: booth })).status, 401);
  await S.call('PUT', '/api/settings/photobooth', { value: { enabled: false } }, { token: owner });
});
