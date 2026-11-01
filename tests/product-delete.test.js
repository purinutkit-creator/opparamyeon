import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });
const adminList = async () => (await S.call('GET', '/api/catalog?all=1', undefined, { token: owner })).body.products;

test('ลบเมนูที่ไม่ใช้: ไม่เคยขาย = ลบถาวร · เคยขาย = ซ่อน บิลเก่ายังอยู่ รหัส/บาร์โค้ดใช้ซ้ำได้', async () => {
  const a = (await S.call('POST', '/api/products', { code: 'DEL1', name: 'ไม่เคยขาย', price: 1000, barcodes: ['2000000000017'] }, { token: owner })).body;
  const b = (await S.call('POST', '/api/products', { code: 'DEL2', name: 'เคยขาย', price: 2000, barcodes: ['2000000000024'] }, { token: owner })).body;
  const sale = await S.call('POST', '/api/orders/save', { idempotency_key: key(), action: 'save', cart: { lines: [line(b.id, 1)] } }, { token: owner, terminal: 'pos1' });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  assert.equal((await S.call('POST', '/api/products/delete', { ids: [a.id] })).status, 401, 'ต้องล็อกอิน');
  const r = await S.call('POST', '/api/products/delete', { ids: [a.id, b.id] }, { token: owner });
  assert.deepEqual(r.body, { ok: true, removed: 1, archived: 1 });
  assert.equal(await db.get('SELECT id FROM products WHERE id = ?', [a.id]), undefined, 'ลบถาวร');
  const kept = await db.get('SELECT active, deleted FROM products WHERE id = ?', [b.id]);
  assert.equal(Number(kept.active), 0); assert.equal(Number(kept.deleted), 1);
  const ids = (await adminList()).map((p) => p.id);
  assert.ok(!ids.includes(a.id) && !ids.includes(b.id), 'หายจากหน้าจัดการเมนู');
  assert.ok(await db.get('SELECT id FROM order_items WHERE product_id = ?', [b.id]), 'บิลเก่ายังอยู่');
  const again = await S.call('POST', '/api/products', { code: 'DEL2', name: 'เมนูใหม่รหัสเดิม', price: 1, barcodes: ['2000000000024'] }, { token: owner });
  assert.equal(again.status, 200, 'รหัสและบาร์โค้ดใช้ซ้ำได้ ' + JSON.stringify(again.body));
  assert.deepEqual((await S.call('POST', '/api/products/delete', { ids: [] }, { token: owner })).status, 400);
});

test('จัดเรียงลำดับเมนูด้วยการลาก + ตั้งจุดครัวด่วน (ทีละเมนู / หลายเมนู)', async () => {
  const list = async () => (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products;
  const ram = (await list()).filter((p) => p.category_id === 'c_ramyeon');
  const want = ram.map((p) => p.id).reverse();
  await db.run("UPDATE categories SET sort_by = 'name_asc' WHERE id = 'c_ramyeon'");
  assert.equal((await S.call('POST', '/api/products/reorder', { ids: want }, {})).status, 401);
  const r = await S.call('POST', '/api/products/reorder', { ids: want, category_id: 'c_ramyeon' }, { token: owner });
  assert.equal(r.status, 200);
  assert.deepEqual((await list()).filter((p) => p.category_id === 'c_ramyeon').map((p) => p.id), want, 'หน้าขายเรียงตามที่ลาก');
  assert.equal((await db.get("SELECT sort_by FROM categories WHERE id = 'c_ramyeon'")).sort_by, 'sort', 'หมวดเปลี่ยนเป็นเรียงตามลำดับที่ตั้ง');
  // stations
  const ids = ram.slice(0, 2).map((p) => p.id);
  assert.equal((await S.call('POST', '/api/products/station', { ids, station_id: 'st_drink' }, { token: owner })).status, 200);
  assert.deepEqual((await list()).filter((p) => ids.includes(p.id)).map((p) => p.station_id), ['st_drink', 'st_drink']);
  assert.equal((await S.call('POST', '/api/products/station', { ids, station_id: 'nope' }, { token: owner })).status, 400);
  await S.call('POST', '/api/products/station', { ids: [ids[0]], station_id: '' }, { token: owner });
  assert.equal((await list()).find((p) => p.id === ids[0]).station_id, null, 'ไม่ระบุจุดครัว');
  await S.call('POST', '/api/products/station', { ids, station_id: 'st_ramyeon' }, { token: owner });
});
