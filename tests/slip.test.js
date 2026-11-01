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

test('AI ตรวจสลิปจากรูป: ยอด/ผู้รับ/สลิปซ้ำ เทียบกับบิล · ตรวจไม่ทัน 5 วินาที = timeout', async () => {
  const http = await import('node:http');
  const QRCode = (await import('qrcode')).default;
  const { PNG } = await import('pngjs');
  let reply = null, delay = 0;
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b);
    setTimeout(() => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(reply) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })); }, delay);
  }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  try {
    await S.call('PUT', '/api/assistant/config', { anthropic_api_key: 'sk-ant-test-1234' }, { token: owner });
    await S.call('PUT', '/api/settings/payment', { value: { promptpay_id: '0812345678', promptpay_name: 'นาย ปุริณัฐ กิตติ' } }, { token: owner });
    const ref = 'AISLIP' + Date.now();
    const png = await QRCode.toBuffer(makeSlipQr('014', ref), { width: 300, margin: 4 });
    const image = 'data:image/png;base64,' + png.toString('base64');
    const egg = await db.get("SELECT id, price FROM products WHERE code = 'T001'");
    const read = (o) => ({ is_slip: true, amount: egg.price / 100, receiver_name: 'นาย ปุริณัฐ ก.', receiver_account: 'xxx-xxx-5678', sender_name: 'สมชาย', bank: 'SCB', date_time: new Date().toISOString(), ref, looks_edited: false, ...o });
    reply = read();
    let r = await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.verdict, 'pass', JSON.stringify(r.body));
    assert.equal(r.body.qr.bank_name, 'ไทยพาณิชย์', 'อ่าน QR สลิปจากรูปได้');
    assert.match(r.body.file, /^\/files\//);
    reply = read({ amount: 1 });
    r = await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner });
    assert.equal(r.body.verdict, 'fail'); assert.match(r.body.reasons.join(), /ไม่ตรงกับยอดบิล/);
    reply = read({ receiver_name: 'บริษัท อื่น จำกัด', receiver_account: 'xxx-x-x9999-x' });
    r = await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner });
    assert.equal(r.body.verdict, 'fail'); assert.match(r.body.reasons.join(), /ไม่ใช่บัญชีร้าน/);
    // pay with it, then the same slip is refused
    reply = read();
    const ok = (await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner })).body;
    const paid = await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line(egg.id, 1)] }, payments: [{ method: 'promptpay', amount: egg.price, slip_qr: ok.qr.code, slip_file: ok.file }] }, { token: owner, terminal: 'pos1' });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.ok(await db.get('SELECT 1 AS x FROM payments WHERE slip_file = ?', [ok.file]), 'เก็บรูปสลิปไว้กับการชำระ');
    r = await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner });
    assert.equal(r.body.verdict, 'fail'); assert.match(r.body.reasons.join(), /ใช้ไปแล้ว/);
    // too slow → timeout well within the cashier's wait
    delay = 7000;
    const t0 = Date.now();
    r = await S.call('POST', '/api/payments/slip-read', { image, amount: egg.price }, { token: owner });
    assert.equal(r.body.verdict, 'timeout', JSON.stringify(r.body));
    assert.ok(Date.now() - t0 < 5600, 'ไม่เกิน ~5 วินาที: ' + (Date.now() - t0));
  } finally {
    await S.call('PUT', '/api/assistant/config', { clear: ['anthropic_api_key'] }, { token: owner });
    delete process.env.ANTHROPIC_BASE_URL; mock.close();
  }
});
