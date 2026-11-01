import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

// a stand-in for api.line.me: records what the POS sends
const sent = []; let mock; const images = new Map(); // message id → image bytes the mock LINE hands out
let S, owner;
before(async () => {
  mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    sent.push({ path: req.url, auth: req.headers.authorization, body: b && req.headers['content-type'] === 'application/json' ? JSON.parse(b) : b.length });
    const img = /^\/v2\/bot\/message\/([^/]+)\/content$/.exec(req.url);
    if (img) { res.setHeader('content-type', 'image/png'); return res.end(images.get(img[1])); }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v2/bot/message/reply' && b.includes('rt-fail')) { res.statusCode = 400; return res.end('{"message":"Invalid reply token"}'); }
    res.end(req.url === '/v2/bot/richmenu' ? '{"richMenuId":"rm-1"}' : req.url.startsWith('/v2/bot/profile') ? '{"displayName":"เจ้าของร้าน"}' : req.url === '/v2/bot/info' ? (req.headers.authorization === 'Bearer ' + 'T'.repeat(160) ? '{"displayName":"Oppa Ramyeon","basicId":"@oppa"}' : (res.statusCode = 401, '{}')) : '{}');
  }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.LINE_API_BASE = `http://127.0.0.1:${mock.address().port}`;
  process.env.LINE_BATCH_MS = '50';
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});
after(async () => { await S.close(); mock.close(); delete process.env.LINE_API_BASE; });
const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'; const TOKEN = 'T'.repeat(160);
const hook = (events) => { const raw = JSON.stringify({ events }); return fetch(S.base + '/api/line/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-line-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('base64') }, body: raw }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lastTo = (path) => [...sent].reverse().find((x) => x.path === path);

test('LINE: ตั้งค่า เชื่อมแชตด้วยรหัส แจ้งเตือนของใกล้หมดพร้อมปุ่ม เติมสต็อก/ใส่รายการซื้อ และสรุปตอนปิดรอบ', async () => {
  // common mix-ups are caught before saving
  let r = await S.call('PUT', '/api/line/settings', { enabled: true, channel_secret: '2001234567' }, { token: owner });
  assert.equal(r.status, 400); assert.match(r.body.error, /Channel ID/);
  r = await S.call('PUT', '/api/line/settings', { enabled: true, channel_token: 'W'.repeat(160) }, { token: owner });
  assert.equal(r.status, 400, 'LINE ไม่รับ token'); assert.match(r.body.error, /ไม่รับ/);
  r = await S.call('PUT', '/api/line/settings', { enabled: true, notify_low: true, notify_close: true, channel_secret: SECRET, channel_token: TOKEN }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const st = (await S.call('GET', '/api/line/settings', undefined, { token: owner })).body;
  assert.equal(st.has_secret, true); assert.equal(st.has_token, true); assert.equal(JSON.stringify(st).includes(TOKEN), false, 'ไม่ส่งคีย์กลับ');
  assert.equal(st.secret_hint, '…8f90'); assert.deepEqual([st.bot.name, st.bot.basic_id], ['Oppa Ramyeon', '@oppa']);
  assert.equal((await S.call('GET', '/api/settings/public')).body.line, undefined);
  // bad signature is refused
  assert.equal((await fetch(S.base + '/api/line/webhook', { method: 'POST', headers: { 'x-line-signature': 'x' }, body: '{"events":[]}' })).status, 401);
  // link the owner's chat with the one-time code
  const { code } = (await S.call('POST', '/api/line/link-code', {}, { token: owner })).body;
  await hook([{ type: 'message', replyToken: 'rt1', source: { type: 'user', userId: 'Uowner' }, message: { type: 'text', text: 'เชื่อมต่อ ' + code } }]); await wait(100);
  assert.equal(lastTo('/v2/bot/message/reply').body.replyToken, 'rt1');
  assert.equal(lastTo('/v2/bot/message/reply').auth, 'Bearer ' + TOKEN);
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
  const fx = push.body.messages[0].contents;
  const card = fx.type === 'carousel' ? fx.contents.find((b) => JSON.stringify(b).includes('a=add')) : fx;
  assert.equal(push.body.messages[0].type, 'flex');
  assert.ok(JSON.stringify(card).includes(p.name));
  assert.ok(card.body.contents.every((c) => c.type !== 'text' || c.wrap), 'ข้อความทุกบรรทัดตัดขึ้นบรรทัดใหม่ ไม่ถูกตัดเป็น …');
  assert.deepEqual(card.footer.contents.map((b) => b.action.data.split('&')[0]), ['a=add', 'a=buy']);
  // ➕ → quick replies → +12 adds stock
  await hook([{ type: 'postback', replyToken: 'rt2', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=add&t=product&i=${p.id}` } }]); await wait(100);
  const picker = lastTo('/v2/bot/message/reply').body.messages[1].contents;
  assert.equal(picker.contents.length, 10, 'การ์ด 1–100 เลื่อนดูได้');
  assert.ok(JSON.stringify(picker).includes('&q=100') && JSON.stringify(picker).includes('&q=12'));
  await hook([{ type: 'postback', replyToken: 'rt3', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=addq&t=product&i=${p.id}&q=12` } }]); await wait(150);
  assert.equal((await db.get('SELECT stock FROM products WHERE id = ?', [p.id])).stock, 13);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].altText, /\+12/);
  assert.equal((await db.get("SELECT reason FROM stock_moves WHERE item_id = ? ORDER BY created_at DESC LIMIT 1", [p.id])).reason, 'เติมผ่าน LINE');
  // ➕ then type a number in the chat
  await hook([{ type: 'postback', replyToken: 'rt3b', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=add&t=product&i=${p.id}` } }]); await wait(100);
  await hook([{ type: 'message', replyToken: 'rt3c', source: { type: 'user', userId: 'Uowner' }, message: { type: 'text', text: '7' } }]); await wait(150);
  assert.equal((await db.get('SELECT stock FROM products WHERE id = ?', [p.id])).stock, 20, 'พิมพ์ 7 → เติม 7');
  await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 13, mode: 'set' }, { token: owner });
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

// pictures for the tests: a barcode (EAN-13 drawn as bars) and a "product photo" (coloured blocks)
async function barcodePng(code) {
  const { ean13 } = await import('../public/shared/core.js');
  const { PNG } = await import('pngjs');
  const runs = ean13(code); // bar / space widths, starting with a bar
  const mods = runs.flatMap((n, i) => Array(n).fill(i % 2 ? 0 : 1));
  const scale = 4, quiet = 40, w = mods.length * scale + quiet * 2, hgt = 220;
  const png = new PNG({ width: w, height: hgt });
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const m = Math.floor((x - quiet) / scale), black = x >= quiet && m < mods.length && mods[m] === 1 && y > 20 && y < 200;
    const i = (y * w + x) * 4; png.data[i] = png.data[i + 1] = png.data[i + 2] = black ? 0 : 255; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}
async function blocksPng(seed) {
  const { PNG } = await import('pngjs');
  const png = new PNG({ width: 240, height: 240 });
  for (let y = 0; y < 240; y++) for (let x = 0; x < 240; x++) {
    const i = (y * 240 + x) * 4, cell = (Math.floor(x / 60) + Math.floor(y / 60) * 4 + seed) % 5;
    png.data[i] = [230, 30, 250, 20, 120][cell]; png.data[i + 1] = [40, 200, 220, 90, 20][cell]; png.data[i + 2] = [30, 60, 40, 220, 160][cell]; png.data[i + 3] = 255;
  }
  return PNG.sync.write(png);
}

test('LINE: เช็กสต็อกด้วยรูปบาร์โค้ด รูปสินค้า หรือพิมพ์เลขบาร์โค้ด/ชื่อ', async () => {
  const { isEan13 } = await import('../public/shared/core.js');
  let cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products;
  if (!cat.some((p) => p.barcodes.some(isEan13))) { // seed codes may not carry a valid check digit: give one product a real EAN-13
    const { ean13Check } = await import('../public/shared/core.js');
    await db.run('INSERT INTO barcodes(code, product_id) VALUES(?,?)', ['200000000001' + ean13Check('200000000001'), cat[0].id]);
    cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products;
  }
  const withBc = cat.find((p) => p.barcodes.some(isEan13));
  const bc = withBc.barcodes.find(isEan13);
  const say = async (text, rt) => { await hook([{ type: 'message', replyToken: rt, source: { type: 'user', userId: 'Uowner' }, message: { type: 'text', text } }]); await wait(150); return lastTo('/v2/bot/message/reply').body; };
  // typed barcode → that product's card
  let r = await say(bc, 'rt-t1');
  assert.equal(r.replyToken, 'rt-t1'); assert.match(r.messages[0].altText, new RegExp(withBc.name.slice(0, 6)));
  // typed part of a name → the matching products
  r = await say(withBc.name.slice(0, 3), 'rt-t2');
  assert.ok(JSON.stringify(r.messages[0]).includes(withBc.name));
  // unknown → how to check
  r = await say('zzzไม่มีแน่ๆ', 'rt-t3'); assert.match(r.messages[0].text, /ส่งรูปบาร์โค้ด/);
  // photo of the barcode
  images.set('m-bc', await barcodePng(bc));
  await hook([{ type: 'message', replyToken: 'rt-i1', source: { type: 'user', userId: 'Uowner' }, message: { type: 'image', id: 'm-bc' } }]); await wait(1500);
  r = lastTo('/v2/bot/message/reply').body;
  assert.equal(r.replyToken, 'rt-i1'); assert.match(JSON.stringify(r.messages[0]), new RegExp('บาร์โค้ด ' + bc));
  // product photo (no barcode, no AI key) → the product with the most similar picture
  const pic = await blocksPng(1);
  const fd = new FormData(); fd.append('file', new Blob([pic], { type: 'image/png' }), 'p.png'); fd.append('kind', 'image');
  const up = (await S.call('POST', '/api/files', fd, { token: owner })).body;
  const target = cat.find((p) => p.id !== withBc.id);
  await S.call('PUT', '/api/products/' + target.id, { ...target, image: up.url }, { token: owner });
  images.set('m-photo', pic);
  await hook([{ type: 'message', replyToken: 'rt-i2', source: { type: 'user', userId: 'Uowner' }, message: { type: 'image', id: 'm-photo' } }]); await wait(1500);
  r = lastTo('/v2/bot/message/reply').body;
  assert.equal(r.replyToken, 'rt-i2');
  const carousel = r.messages[1].contents.contents;
  assert.ok(JSON.stringify(carousel[0]).includes(target.name), 'รูปเหมือนกันที่สุดอยู่ลำดับแรก');
  assert.ok(JSON.stringify(carousel[0]).includes(`a=show&t=product&i=${target.id}`));
  // "ใช่ตัวนี้" → full stock card
  await hook([{ type: 'postback', replyToken: 'rt-i3', source: { type: 'user', userId: 'Uowner' }, postback: { data: `a=show&t=product&i=${target.id}` } }]); await wait(150);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].altText, new RegExp(target.name.slice(0, 6)));
});

test('LINE: เจ้าของ/พนักงาน · ใบเสร็จทุกบิลส่งเฉพาะเจ้าของ · ยอดขายวันนี้ดูได้เฉพาะเจ้าของ · ริชเมนูเจ้าของ 6 ช่อง', async () => {
  // link a staff chat
  const { code } = (await S.call('POST', '/api/line/link-code', { role: 'staff' }, { token: owner })).body;
  await hook([{ type: 'message', replyToken: 'rs1', source: { type: 'user', userId: 'Ustaff' }, message: { type: 'text', text: code } }]); await wait(100);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].text, /พนักงาน/);
  let st = (await S.call('GET', '/api/line/settings', undefined, { token: owner })).body;
  assert.deepEqual(st.recipients.map((x) => [x.id, x.role]), [['Uowner', 'owner'], ['Ustaff', 'staff']], 'แชตเดิมที่ไม่มีสิทธิ์ระบุ = เจ้าของ');
  // receipts on, low-stock alerts to staff only
  let r = await S.call('PUT', '/api/line/settings', { enabled: true, notify_low: true, notify_close: true, notify_sale: true, to: { low: ['staff'], close: ['owner', 'staff'] }, recipients: ['Uowner', 'Ustaff'] }, { token: owner });
  assert.equal(r.status, 200);
  process.env.PUBLIC_URL = 'https://shop.test'; // LINE needs https links for pictures and buttons
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
  const n0 = sent.length;
  const co = await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_r001', 1, { options: (await import('./helpers.js')).ramyeonOpts })] }, payments: [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token: owner, terminal: 'pos1' });
  assert.equal(co.status, 200, JSON.stringify(co.body)); await wait(300);
  const pushes = sent.slice(n0).filter((x) => x.path === '/v2/bot/message/push' && /🧾/.test(x.body.messages[0].altText || ''));
  assert.deepEqual(pushes.map((x) => x.body.to), ['Uowner'], 'ใบเสร็จไปเฉพาะเจ้าของ');
  const bill = (await db.get('SELECT bill_no FROM orders WHERE paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 1')).bill_no;
  assert.match(pushes[0].body.messages[0].altText, new RegExp(bill));
  assert.ok(JSON.stringify(pushes[0].body).includes('มาม่าเกาหลีต้นตำรับ'));
  // receipt: a picture beside each item, and buttons for the latest sales and best sellers
  const rc = JSON.stringify(pushes[0].body.messages[0]);
  assert.ok(rc.includes('a=report') && rc.includes('a=top'), 'ปุ่มยอดขายล่าสุด / สินค้าขายดี');
  assert.ok(/"type":"image"/.test(rc), 'มีรูปสินค้าในบิล');
  assert.ok(rc.includes('https://shop.test/assets/icon-192.png') || rc.includes('https://shop.test/api/public/thumb/'), 'รูปเป็นลิงก์ https ที่ LINE เปิดได้');
  // best sellers: owner only
  await hook([{ type: 'postback', replyToken: 'rt-top', source: { type: 'user', userId: 'Uowner' }, postback: { data: 'a=top' } }]); await wait(200);
  const topMsg = lastTo('/v2/bot/message/reply').body.messages[0];
  assert.equal(topMsg.type, 'flex'); assert.match(topMsg.altText, /ขายดี/); assert.ok(JSON.stringify(topMsg).includes('มาม่าเกาหลีต้นตำรับ'));
  await hook([{ type: 'message', replyToken: 'rt-top2', source: { type: 'user', userId: 'Ustaff' }, message: { type: 'text', text: 'ขายดี' } }]); await wait(150);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].text, /เฉพาะเจ้าของ/);
  // a reply LINE refuses (e.g. expired token) still reaches the chat as a push
  const nF = sent.length;
  await hook([{ type: 'postback', replyToken: 'rt-fail', source: { type: 'user', userId: 'Uowner' }, postback: { data: 'a=top' } }]); await wait(250);
  const fb = sent.slice(nF).find((x) => x.path === '/v2/bot/message/push');
  assert.ok(fb, 'ส่งแบบ push แทน'); assert.equal(fb.body.to, 'Uowner'); assert.match(fb.body.messages[0].altText, /ขายดี/);
  // sales report: owner yes, staff no
  await hook([{ type: 'postback', replyToken: 'rr1', source: { type: 'user', userId: 'Ustaff' }, postback: { data: 'a=report' } }]); await wait(150);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].text, /เฉพาะเจ้าของ/);
  await hook([{ type: 'message', replyToken: 'rr2', source: { type: 'user', userId: 'Ustaff' }, message: { type: 'text', text: 'ยอดขาย' } }]); await wait(150);
  assert.match(lastTo('/v2/bot/message/reply').body.messages[0].text, /เฉพาะเจ้าของ/);
  await hook([{ type: 'postback', replyToken: 'rr3', source: { type: 'user', userId: 'Uowner' }, postback: { data: 'a=report' } }]); await wait(200);
  const rep = lastTo('/v2/bot/message/reply').body.messages[0];
  assert.equal(rep.type, 'flex'); assert.match(rep.altText, /ยอดขายวันนี้/); assert.ok(JSON.stringify(rep).includes(bill), 'มีบิลล่าสุด');
  // staff still has the stock buttons
  await hook([{ type: 'postback', replyToken: 'rr4', source: { type: 'user', userId: 'Ustaff' }, postback: { data: 'a=low' } }]); await wait(150);
  assert.equal(lastTo('/v2/bot/message/reply').body.replyToken, 'rr4');
  // low-stock alerts go to the roles set (here: staff only); receipts never to staff
  const { lineTo } = await import('../server/lib/line.js');
  const n1 = sent.length;
  assert.equal(await lineTo('low', { type: 'text', text: 'low' }), 1);
  assert.equal(await lineTo('sale', { type: 'text', text: 'sale' }), 1);
  assert.deepEqual(sent.slice(n1).map((x) => [x.body.to, x.body.messages[0].text]), [['Ustaff', 'low'], ['Uowner', 'sale']]);
  // rich menus: staff (default) + each owner's own 6-button menu whose first button opens their live sales link
  process.env.PUBLIC_URL = 'https://shop.test';
  const png = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');
  const n2 = sent.length;
  r = await S.call('POST', '/api/line/richmenu', { image: png, owner_image: png }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const made = sent.slice(n2).filter((x) => x.path === '/v2/bot/richmenu').map((x) => x.body);
  assert.equal(made.length, 2, 'เมนูพนักงาน + เมนูของเจ้าของ 1 คน');
  const ownerMenu = made.find((m) => m.name === 'Oppa owner');
  assert.equal(ownerMenu.areas.length, 6); assert.equal(ownerMenu.size.height, 1686);
  const liveLink = ownerMenu.areas[0].action.uri;
  assert.match(liveLink, /^https:\/\/shop\.test\/live\/#/, 'ปุ่มแรกเปิดหน้ายอดขายสด');
  assert.deepEqual(ownerMenu.areas.slice(1, 3).map((a) => a.action.data), ['a=low', 'a=list']);
  assert.ok(sent.slice(n2).some((x) => x.path === '/v2/bot/user/Uowner/richmenu/rm-1'), 'ลิงก์เมนูเจ้าของให้แชตเจ้าของ');
  assert.ok(sent.slice(n2).some((x) => x.path === '/v2/bot/user/Ustaff/richmenu' && x.body === 0), 'พนักงานใช้เมนูปกติ');
  // the live link: today's sales without logging in, only while that chat is an owner
  const liveTok = liveLink.split('#')[1];
  let lv = await S.call('GET', '/api/public/live/' + encodeURIComponent(liveTok));
  assert.equal(lv.status, 200, JSON.stringify(lv.body)); assert.ok(lv.body.recent.some((x) => x.bill_no === bill)); assert.ok('net_sales' in lv.body);
  assert.equal((await S.call('GET', '/api/public/live/' + encodeURIComponent(liveTok.slice(0, -2) + '00'))).status, 403, 'ปลอมลิงก์ไม่ได้');
  await S.call('PUT', '/api/line/settings', { enabled: true, notify_low: true, notify_close: true, recipients: ['Uowner', 'Ustaff'], roles: { Uowner: 'staff' } }, { token: owner });
  assert.equal((await S.call('GET', '/api/public/live/' + encodeURIComponent(liveTok))).status, 403, 'เปลี่ยนเป็นพนักงานแล้วลิงก์ใช้ไม่ได้');
  await S.call('PUT', '/api/line/settings', { enabled: true, notify_low: true, notify_close: true, recipients: ['Uowner', 'Ustaff'], roles: { Uowner: 'owner' } }, { token: owner });
  delete process.env.PUBLIC_URL;
  // shop website "remember this device": 30-day sign-in (not on a POS)
  const lr = await S.call('POST', '/api/auth/login', { code: '0001', pin: '1234', remember: true });
  const sess = await db.get('SELECT expires_at FROM sessions WHERE token = ?', [lr.body.token]);
  assert.ok(Date.parse(sess.expires_at) - Date.now() > 29 * 864e5, 'จดจำ 30 วัน');
  // QR of the bill link: valid token only
  const { billToken } = await import('../server/lib/billlink.js');
  const q = await fetch(S.base + `/api/public/bill/${encodeURIComponent(await billToken(bill))}/qr.png`);
  assert.equal(q.status, 200); assert.equal(q.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(S.base + '/api/public/bill/B999.bad/qr.png')).status, 404);
  // thumbnails for LINE: PNG for our own pictures, the shop icon when the file can't be read
  const { PNG } = await import('pngjs');
  const png1 = new PNG({ width: 300, height: 200 }); png1.data.fill(200);
  const fd = new FormData(); fd.append('file', new Blob([PNG.sync.write(png1)], { type: 'image/png' }), 'x.png'); fd.append('kind', 'image');
  const up = (await S.call('POST', '/api/files', fd, { token: owner })).body;
  const th = await fetch(S.base + `/api/public/thumb/${up.id}.png`);
  assert.equal(th.status, 200); assert.equal(th.headers.get('content-type'), 'image/png');
  const dim = PNG.sync.read(Buffer.from(await th.arrayBuffer())); assert.deepEqual([dim.width, dim.height], [160, 160]);
  const miss = await fetch(S.base + '/api/public/thumb/nope.png', { redirect: 'manual' });
  assert.equal(miss.status, 302); assert.match(miss.headers.get('location'), /icon-192\.png/);
});
