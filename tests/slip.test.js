import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';
import { makeSlipQr, parseSlipQr, promptPayPayload } from '../public/shared/core.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });
const egg = async () => (await db.get("SELECT id, price FROM products WHERE code = 'T001'"));
const pay = async (slip) => { const p = await egg(); return S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line(p.id, 1)] }, payments: [{ method: 'promptpay', amount: p.price, slip_qr: slip }] }, { token: owner, terminal: 'pos1' }); };

test('อ่าน QR สลิปธนาคาร: ธนาคาร + เลขอ้างอิง, CRC ผิด/QR พร้อมเพย์ = ไม่ใช่สลิป', () => {
  const q = makeSlipQr('014', '2024110112345678ABCD');
  assert.deepEqual(parseSlipQr(q), { bank: '014', bank_name: 'ไทยพาณิชย์', ref: '2024110112345678ABCD' });
  assert.equal(parseSlipQr(q.slice(0, -4) + 'FFFF'), null);
  assert.equal(parseSlipQr(promptPayPayload('0812345678', 4500)), null);
  assert.equal(parseSlipQr('hello'), null);
});

test('ตรวจสลิปตอนชำระพร้อมเพย์: สลิปจริงผ่าน ใช้ซ้ำไม่ได้ (ทั้งตอนตรวจและตอนชำระ)', async () => {
  const q = makeSlipQr('004', '015309142531BTF09431');
  let r = await S.call('POST', '/api/payments/slip-check', { code: q }, { token: owner });
  assert.equal(r.status, 200); assert.equal(r.body.bank_name, 'กสิกรไทย');
  assert.equal((await S.call('POST', '/api/payments/slip-check', { code: promptPayPayload('0812345678', 100) }, { token: owner })).status, 400);
  r = await pay(q);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = await db.get('SELECT * FROM slips WHERE ref = ?', ['015309142531BTF09431']);
  assert.ok(row && row.bill_no, 'บันทึกสลิปกับบิล');
  const p = await db.get("SELECT ref FROM payments WHERE order_id = ? AND method = 'promptpay'", [row.order_id]);
  assert.match(p.ref, /สลิป กสิกรไทย 015309142531BTF09431/);
  r = await S.call('POST', '/api/payments/slip-check', { code: q }, { token: owner });
  assert.equal(r.status, 409); assert.match(r.body.error, new RegExp(row.bill_no));
  const before = Number((await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'")).n);
  r = await pay(q);
  assert.equal(r.status, 409); assert.equal(r.body.code, 'slip_used');
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM orders WHERE status = 'paid'")).n), before, 'บิลที่สองไม่ถูกชำระ');
  const kitchen = await S.login('0003', '3333');
  assert.equal((await S.call('POST', '/api/payments/slip-check', { code: q }, { token: kitchen })).status, 403);
});
