import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

// a stand-in for api.line.me: records what the POS sends
const sent = []; let mock;
let S, owner;
before(async () => {
  mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    sent.push({ path: req.url, auth: req.headers.authorization, body: b && req.headers['content-type'] === 'application/json' ? JSON.parse(b) : b.length });
    res.setHeader('content-type', 'application/json');
    res.end(req.url === '/v2/bot/richmenu' ? '{"richMenuId":"rm-1"}' : req.url.startsWith('/v2/bot/profile') ? '{"displayName":"เจ้าของร้าน"}' : '{}');
  }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  process.env.LINE_BATCH_MS = '50';
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});
after(async () => { await S.close(); mock.close(); delete process.env.LINE_API_BASE; });
const SECRET = 'test-channel-secret';
const hook = (events) => { const raw = JSON.stringify({ events }); return fetch(S.base + '/api/line/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('base64') }, body: raw }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastTo = (path) => [...sent].reverse().find((x) => x.path === path);

test('LINE: ตั้งค่า เชื่อมแชตด้วยรหัส แจ้งเตือนของใกล้หมดพร้อมปุ่ม เติมสต็อก/ใส่รายการซื้อ และสรุปตอนปิดรอบ', async () => {
  let r = await S.call('PUT', '/api/line/settings', { enabled: true, notify_low: true, notify_close: true, channel_secret: SECRET, channel_token: 'tok-123' }, { token: owner });
  assert.equal(r.status, 200);
  const st = (await S.call('GET', '/api/line/settings', undefined, { token: owner })).body;
  assert.equal(st.has_secret, true); assert.equal(st.has_token, true); assert.equal(JSON.stringify(st).includes('tok-123'), false, 'ไม่ส่งคีย์กลับ');
  assert.equal((await S.call('GET', '/api/settings/public')).body.line, undefined);
  // bad signature is refused
  assert.equal((await fetch(S.base + '/api/line/webhook', { method: 'POST', headers: { 'x-line-signature': 'x' }, body: '{"events":[]}' })).status, 401);
  // link the owner's chat with the one-time code
  const { code } = (await S.call('POST', '/api/line/link-code', {}, { token: owner })).body;
  await hook([{ type: 'message', replyToken: 'rt1', source: { type: 'user', userId: 'Uowner' }, message: { type: 'text', text: 'เชื่อมต่อ ' + code } }]); await wait(100);
  assert.equal(lastTo('/v2/bot/message/reply').body.replyToken, 'rt1');
  assert.equal(lastTo('/v2/bot/message/reply').auth, 'Bearer tok-123');
  assert.deepEqual((await S.call('GET', '/api/line/settings', undefined, { token: owner })).body.recipients.map((x) => [x.id, x.name]), [['Uowner', 'เจ้าของร้าน']]);
  // someone else (not linked) can't press buttons
  const p = (await S.call('GET', '/api/stock', undefined, { token: owner })).body.products.find((x) => !x.track_stock);
  await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 3, track: true, low_stock: 1 }, { token: owner });
  const n0 = sent.length;
  await hook([{ type: 'postback', replyToken: 'rtX', source: { type: 'user', userId: 'Ustranger' }, postback: { data: `a=addq&t=product&i=${p.id}&q=50` } }]); await wait(100);
  assert.equal(sent.length, n0); assert.equal((await db.get('SELECT stock FROM products WHERE id = ?', [p.id])).stock, 3);
  // selling it down to the low level → one LINE card with buttons
  const opts = p.option_groups && p.option_groups.length ? [] : [];
  await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line(p.id, 2, { options: opts })] }, payments: [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token: owner, terminal: 'pos1' });
  await wait(300);
  const push = lastTo('/v2/bot/message/push');
  assert.ok(push, 'ส่งแจ้งเตือนของใกล้หมด'); assert.equal(push.body.to, 'Uowner');
  const card = push.body.messages[0].contents.contents[0];
  assert.equal(push.body.messages[0].type, 'flex');
  assert.ok(JSON.stringify(card).includes(p.name));
  assert.deepEqual(card.footer.contents.map((b) => b.action.data.split('&')[0]), ['a=add', 'a=buy']);
  // ➕ → quick replies → +12 adds stock
  await hook([{ type: 'postback', replyToken: 'rt2', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=add&t=product&i=${p.id}` } }]); await wait(100);
  assert.ok(lastTo('/v2/bot/message/reply').body.messages[0].quickReply.items.some((x) => x.action.data.endsWith('&q=12')));
  await hook([{ type: 'postback', replyToken: 'rt3', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=addq&t=product&i=${p.id}&q=12` } }]); await wait(150);
  assert.equal((await db.get('SELECT stock FROM products WHERE id = ?', [p.id])).stock, 13);
  assert.equal((await db.get("SELECT reason FROM stock_moves WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [p.id])).reason, 'เติมผ่าน LINE');
  // 🛒 → shopping list; bought → offer to restock
  await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 1, mode: 'set' }, { token: owner });
  await hook([{ type: 'postback', replyToken: 'rt4', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=buy&t=product&i=${p.id}` } }]); await wait(150);
  const list = (await S.call('GET', '/api/shopping', undefined, { token: owner })).body.open;
  assert.equal(list.length, 1); assert.equal(list[0].name, p.name); assert.equal(list[0].qty, 1, 'ซื้อให้กลับไปเป็น 2 เท่าของจุดเตือน');
  // shift close → summary of what to buy
  const cur = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  await S.call('POST', '/api/shifts/close', { counted_cash: cur.expected_cash }, { token: owner, terminal: 'pos1' }); await wait(200);
  const sum = lastTo('/v2/bot/message/push');
  assert.match(sum.body.messages[0].altText, /ต้องซื้อ/);
  assert.ok(JSON.stringify(sum.body).includes(p.name));
  await hook([{ type: 'postback', replyToken: 'rt5', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=bought&l=${list[0].id}` } }]); await wait(150);
  assert.equal((await db.get('SELECT status FROM shopping_list WHERE id = ?', [list[0].id])).status, 'bought');
  // rich menu: created, image uploaded, set as default
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  r = await S.call('POST', '/api/line/richmenu', { image: png }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.id, 'rm-1');
  assert.ok(sent.some((x) => x.path === '/v2/bot/richmenu/rm-1/content') && sent.some((x) => x.path === '/v2/bot/user/all/richmenu/rm-1'));
});
