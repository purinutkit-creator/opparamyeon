import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';
import { splitTickets } from '../public/shared/core.js';

let S, owner;
before(async () => {
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});
after(async () => { await S.close(); });
const send = (lines) => S.call('POST', '/api/orders/save', { idempotency_key: key(), action: 'send', cart: { lines } }, { token: owner, terminal: 'pos1' });
const tickets = async (orderId) => (await db.all('SELECT content FROM kitchen_tickets WHERE order_id = ?', [orderId])).map((t) => JSON.parse(t.content));
const cheese = async () => (await db.get("SELECT id FROM products WHERE code = 'T002'")).id;

test('ใบครัว: ท็อปปิ้งที่ไม่ได้อยู่ในชามไปอยู่ใบสุดท้ายของชาม ไม่แยกเป็น "รายการอื่น"', () => {
  const t = splitTickets([{ name: 'มาม่า', qty: 2, bowl_count: 1 }, { name: 'ชีส', qty: 1, bowl_count: 0 }], 'bowl', 1);
  assert.equal(t.length, 2);
  assert.deepEqual(t[1].lines.map((l) => l.name), ['มาม่า', 'ชีส']);
  assert.deepEqual(splitTickets([{ name: 'ชีส', qty: 1, bowl_count: 0 }], 'bowl', 1).map((x) => x.label), ['รายการอื่น'], 'ไม่มีชามเลย ก็พิมพ์ตามเดิม');
});

test('ชีส (จุดท็อปปิ้ง) สั่งพร้อมมาม่า ไม่ได้ใส่ชาม: เครื่องพิมพ์ครัวเครื่องเดียวกัน → ใบเดียวกับมาม่า ไม่แยกใบ', async () => {
  await S.call('POST', '/api/printers', { name: 'ครัว', conn: 'lan', address: '10.0.0.9', paper: 80, roles: ['kitchen'] }, { token: owner });
  const r = await send([line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 }), line(await cheese(), 1)]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const ts = await tickets(r.body.id || r.body.order.id);
  assert.equal(ts.length, 1, 'ใบเดียว: ' + ts.map((t) => t.station + ':' + t.lines.map((l) => l.name).join('+')).join(' | '));
  assert.deepEqual(ts[0].lines.map((l) => l.name).sort(), ['ชีสแผ่น', 'มาม่าเกาหลีต้นตำรับ'].sort());
});

test('ร้านที่ตั้งเครื่องพิมพ์แยกให้จุดท็อปปิ้ง ยังแยกใบตามที่ตั้งไว้', async () => {
  await db.run("UPDATE printers SET station_ids = ? WHERE name = 'ครัว'", [JSON.stringify(['st_ramyeon'])]);
  await S.call('POST', '/api/printers', { name: 'ท็อปปิ้ง', conn: 'lan', address: '10.0.0.10', paper: 58, roles: ['kitchen'], station_ids: ['st_topping'] }, { token: owner });
  const r = await send([line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 }), line(await cheese(), 1)]);
  const ts = await tickets(r.body.id || r.body.order.id);
  assert.equal(ts.length, 2);
});
