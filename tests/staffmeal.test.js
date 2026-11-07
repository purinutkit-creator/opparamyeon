import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });

test('สวัสดิการพนักงาน: ขอที่เครื่องขาย → อนุมัติ → บิล 0 บาท ใบเสร็จติดชื่อ + ใบเบิกแทนใบสรุป · ไม่อนุมัติ = จ่ายปกติ', async () => {
  const pr = (await S.call('POST', '/api/printers', { name: 'R', conn: 'lan', address: '10.0.0.91', port: 9100, paper: 80, roles: ['receipt', 'merchant'] }, { token: owner })).body.id;
  const staff = (await S.call('GET', '/api/staff-meals/staff', undefined, { token: owner, terminal: 'pos1' })).body;
  const kim = staff.find((x) => x.code === '0002') || staff[0];
  const cashier = await S.login('0002', '2222');
  // ask
  const r = await S.call('POST', '/api/staff-meals', { staff_id: kim.id, cart: { lines: [line('p_d001', 2)] }, idempotency_key: key() }, { token: cashier, terminal: 'pos1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.order.status, 'open'); assert.equal(r.body.line_sent, 0, 'ยังไม่ได้ตั้ง LINE');
  const value = r.body.order.total;
  // a cashier cannot approve alone; a manager PIN can
  assert.equal((await S.call('POST', `/api/staff-meals/${r.body.id}/approve`, {}, { token: cashier, terminal: 'pos1' })).status, 403);
  const ap = await S.call('POST', `/api/staff-meals/${r.body.id}/approve`, { approver: { code: '0001', pin: '1234' } }, { token: cashier, terminal: 'pos1' });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  assert.equal(ap.body.order.status, 'paid'); assert.equal(ap.body.order.total, 0); assert.equal(ap.body.order.discount >= value, true);
  assert.equal(ap.body.value, value);
  const jobs = await db.all('SELECT doc_type, payload FROM print_jobs WHERE ref_id = ? AND printer_id = ?', [r.body.order.id, pr]);
  const rec = JSON.parse(jobs.find((j) => j.doc_type === 'receipt').payload).data;
  assert.match(rec.benefit_label, new RegExp('สวัสดิการพนักงาน: ' + kim.name));
  const v = jobs.find((j) => j.doc_type === 'staff_meal');
  assert.ok(v, 'พิมพ์ใบเบิกสวัสดิการ'); assert.equal(JSON.parse(v.payload).data.bill_no, r.body.order.bill_no);
  assert.ok(!jobs.some((j) => j.doc_type === 'merchant'), 'ไม่พิมพ์ใบสรุปร้านค้า');
  // decided once only (e.g. the owner presses again on LINE)
  const { decideMeal } = await import('../server/routes/staffmeal.js');
  assert.equal((await decideMeal(r.body.id, false, 'line:U1')).already, true);
  // rejected: the bill stays open and can be paid as usual
  const r2 = (await S.call('POST', '/api/staff-meals', { staff_id: kim.id, cart: { lines: [line('p_d001', 1)] }, idempotency_key: key() }, { token: cashier, terminal: 'pos1' })).body;
  const out = await decideMeal(r2.id, false, 'line:U1');
  assert.equal(out.meal.status, 'rejected');
  assert.equal((await db.get('SELECT status FROM orders WHERE id = ?', [r2.order.id])).status, 'open');
  const paid = await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), order_id: r2.order.id, payments: [{ method: 'cash', amount: r2.order.total, received: r2.order.total }] }, { token: cashier, terminal: 'pos1' });
  assert.equal(paid.status, 200, JSON.stringify(paid.body)); assert.equal(paid.body.total, r2.order.total);
});
