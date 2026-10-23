import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';
import { GATEWAYS } from '../server/lib/gateways.js';

let S, owner;
before(async () => {
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
  await S.call('PUT', '/api/settings/payment', { value: { promptpay_id: '0812345678', promptpay_name: 'ร้านโอปป้า', mock_enabled: true } }, { token: owner });
  await S.call('PUT', '/api/settings/mobile', { value: { pay_online: true } }, { token: owner });
});
after(async () => { await S.close(); });

const M = (tok) => ({ headers: { 'X-Mobile-Token': tok } });
const newSession = async (body) => (await S.call('POST', '/api/mobile/sessions', body, { token: owner })).body;

test('โต๊ะ: สั่งผ่าน QR ที่ผูกโต๊ะ ราคาคำนวณที่เซิร์ฟเวอร์ ส่งเข้าครัวโดยไม่ต้องกรอกซ้ำ', async () => {
  const ms = await newSession({ mode: 'table', table_id: 't2' });
  assert.ok(ms.jobs.length >= 0);
  const info = (await S.call('GET', '/api/m/session', undefined, M(ms.session.token))).body;
  assert.equal(info.session.mode, 'table');
  assert.equal(info.session.table_id, 't2');
  const r = await S.call('POST', '/api/m/orders', { idempotency_key: key(), expected_total: 1, lines: [{ product_id: 'p_r002', qty: 1, options: ramyeonOpts, unit_price: 1 }], pay_mode: 'cashier' }, M(ms.session.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.total, 9900, 'ไม่เชื่อยอดจากโทรศัพท์');
  const o = (await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body;
  assert.equal(o.source, 'mobile_table');
  assert.equal(o.table_name, 'A2');
  assert.ok(o.tickets.length > 0, 'โต๊ะ: ส่งครัวทันทีตามค่าเริ่มต้น');
  // QR cannot switch to another table unless allowed
  const r2 = await S.call('POST', '/api/m/orders', { idempotency_key: key(), table_id: 't3', lines: [line('p_d003', 1)], pay_mode: 'cashier' }, M(ms.session.token));
  const o2 = (await S.call('GET', '/api/orders/' + r2.body.id, undefined, { token: owner })).body;
  assert.equal(o2.table_id, 't2');
});

test('Pick Up + ชำระที่แคชเชียร์: แจ้งเตือน POS ทันที, รอชำระไม่นับเป็นยอดขาย, รับชำระต่อจากออเดอร์เดิม', async () => {
  const ms = await newSession({ mode: 'pickup' });
  const pos = ioc(S.base, { auth: { kind: 'staff', token: owner, terminal_id: 'pos1' }, transports: ['websocket'] });
  await new Promise((r) => pos.on('connect', r));
  const alert = new Promise((r) => pos.on('mobile:new_order', r));
  const dash0 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  const noName = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', lines: [line('p_d001', 1)], pay_mode: 'cashier' }, M(ms.session.token));
  assert.equal(noName.status, 400);
  const k = key();
  const body = { idempotency_key: k, mode: 'pickup', customer_name: 'มินจู', lines: [{ product_id: 'p_r001', qty: 1, options: ramyeonOpts }, line('p_d001', 1)], pay_mode: 'cashier' };
  const [a, b] = await Promise.all([S.call('POST', '/api/m/orders', body, M(ms.session.token)), S.call('POST', '/api/m/orders', body, M(ms.session.token))]);
  assert.equal(a.body.id, b.body.id, 'กดยืนยันซ้ำ/เน็ตกระตุกไม่สร้างออเดอร์ซ้ำ');
  const ev = await alert;
  assert.equal(ev.customer_name, 'มินจู');
  assert.equal(ev.pay_mode, 'cashier');
  assert.equal(ev.bowls, 1);
  const o = (await S.call('GET', '/api/orders/' + a.body.id, undefined, { token: owner })).body;
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.tickets.length, 0, 'Pick Up ที่ยังไม่จ่าย รอชำระก่อนส่งครัว');
  const dash1 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  assert.equal(dash1.net_sales, dash0.net_sales, 'ออเดอร์รอชำระไม่นับเป็นยอดขาย');
  assert.equal(dash1.pending_payment.count, dash0.pending_payment.count + 1);
  const n0 = Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n);
  const mob = ioc(S.base, { auth: { kind: 'mobile', token: ms.session.token }, transports: ['websocket'] });
  await new Promise((r) => mob.on('connect', r));
  const paidEv = new Promise((r) => mob.on('order:status', r));
  const p = await S.call('POST', '/api/orders/checkout', { order_id: o.id, idempotency_key: key(), payments: [{ method: 'cash', amount: o.total, received: o.total }] }, { token: owner, terminal: 'pos1' });
  assert.equal(p.body.status, 'paid');
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n), n0, 'ไม่สร้างรายการใหม่');
  assert.ok(p.body.tickets.length > 0, 'ส่งครัวหลังชำระ');
  assert.equal((await paidEv).status, 'paid', 'แจ้งกลับโทรศัพท์ลูกค้า');
  const dash2 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  assert.equal(dash2.net_sales - dash0.net_sales, o.total);
  pos.close(); mob.close();
});

test('QR ใช้ได้ครั้งเดียว (single) แม้ส่งพร้อมกัน; QR หมดอายุ/ปิดรอบแล้วสั่งไม่ได้แต่ยังดูสถานะได้', async () => {
  const ms = await newSession({ mode: 'pickup', single_use: true });
  const mk = () => S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'A', lines: [line('p_d003', 1)], pay_mode: 'cashier' }, M(ms.session.token));
  const res = await Promise.all([mk(), mk(), mk()]);
  assert.equal(res.filter((r) => r.status === 200).length, 1);
  const info = (await S.call('GET', '/api/m/session', undefined, M(ms.session.token))).body;
  assert.equal(info.session.can_order, false);
  assert.equal(info.orders.length, 1, 'ยังดูสถานะออเดอร์เดิมได้');
  const ms2 = await newSession({ mode: 'table', table_id: 't4' });
  await S.call('POST', '/api/tables/t4/close', { force: true }, { token: owner });
  const closed = await S.call('POST', '/api/m/orders', { idempotency_key: key(), lines: [line('p_d003', 1)], pay_mode: 'cashier' }, M(ms2.session.token));
  assert.equal(closed.status, 403);
  const ms3 = await newSession({ mode: 'pickup' });
  await db.run('UPDATE mobile_sessions SET expires_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', ms3.session.id]);
  const exp = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'B', lines: [line('p_d003', 1)], pay_mode: 'cashier' }, M(ms3.session.token));
  assert.equal(exp.status, 403);
  const guess = await S.call('GET', '/api/m/session', undefined, M('t4'));
  assert.equal(guess.status, 403, 'เลขโต๊ะไม่ใช่สิทธิ์เข้าถึง');
});

test('ไม่มีโต๊ะ → Pick Up เป็นตัวเลือกหลัก; สินค้าหมดสั่งไม่ได้', async () => {
  const ms = await newSession({ mode: 'pickup' });
  await db.run('UPDATE dining_tables SET active = 0');
  const info = (await S.call('GET', '/api/m/session', undefined, M(ms.session.token))).body;
  assert.equal(info.options.has_tables, false);
  assert.equal(info.options.pickup_enabled, true);
  await db.run('UPDATE dining_tables SET active = 1');
  await S.call('POST', '/api/products/p_s002/sold-out', { sold_out: true }, { token: owner });
  const r = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'C', lines: [line('p_s002', 1)], pay_mode: 'cashier' }, M(ms.session.token));
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'sold_out');
});

test('พร้อมเพย์: QR มียอดของออเดอร์, กด "โอนแล้ว"/ส่งสลิปไม่ทำให้เป็นชำระแล้ว จนพนักงานตรวจ', async () => {
  const ms = await newSession({ mode: 'pickup' });
  const r = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'D', lines: [line('p_d001', 2)], pay_mode: 'online' }, M(ms.session.token));
  const pp = (await S.call('GET', `/api/m/orders/${r.body.id}/promptpay`, undefined, M(ms.session.token))).body;
  assert.match(pp.payload, /540590\.00/);
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'slip.png');
  const up = await S.call('POST', `/api/m/orders/${r.body.id}/slip`, fd, M(ms.session.token));
  assert.equal(up.status, 200);
  let o = (await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body;
  assert.equal(o.status, 'pending_payment');
  assert.equal(o.verify_status, 'pending');
  const v = await S.call('POST', `/api/orders/${r.body.id}/verify-slip`, { approve: true }, { token: owner, terminal: 'pos1' });
  assert.equal(v.body.status, 'paid');
  const v2 = await S.call('POST', `/api/orders/${r.body.id}/verify-slip`, { approve: true }, { token: owner, terminal: 'pos1' });
  o = (await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body;
  assert.equal(o.payments.filter((p) => p.status === 'paid').length, 1, 'ยืนยันซ้ำไม่รับเงินซ้ำ');
});

test('Payment Gateway: ต้องตรวจลายเซ็น + ยืนยันกับผู้ให้บริการ, webhook ซ้ำไม่รับเงิน/ตัดสต็อกซ้ำ', async () => {
  const ms = await newSession({ mode: 'pickup' });
  const r = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'E', lines: [line('p_d002', 1)], pay_mode: 'online' }, M(ms.session.token));
  const gw = await S.call('POST', `/api/m/orders/${r.body.id}/gateway`, {}, M(ms.session.token));
  const ref = gw.body.url.split('#')[1];
  const stock0 = (await db.get("SELECT stock FROM products WHERE id = 'p_d002'")).stock;
  // forged webhook without valid signature
  const forged = await fetch(S.base + '/api/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': 'xxx' }, body: JSON.stringify({ event: 'paid', ref }) });
  assert.equal(forged.status, 401);
  // valid signature but provider says not paid yet → stays pending
  const raw = JSON.stringify({ event: 'paid', ref });
  const early = await fetch(S.base + '/api/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': GATEWAYS.mock.sign(raw) }, body: raw });
  assert.equal((await early.json()).status, 'unconfirmed');
  assert.equal((await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body.status, 'pending_payment');
  await db.run("DELETE FROM webhook_events WHERE event_key = ?", ['paid:' + ref]);
  GATEWAYS.mock.markPaid(ref);
  const send = () => fetch(S.base + '/api/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': GATEWAYS.mock.sign(raw) }, body: raw }).then((x) => x.json());
  const results = await Promise.all([send(), send(), send()]);
  assert.equal(results.filter((x) => x.status === 'paid').length, 1);
  const o = (await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body;
  assert.equal(o.status, 'paid');
  assert.equal(o.payments.filter((p) => p.status === 'paid').length, 1);
  assert.equal((await db.get("SELECT stock FROM products WHERE id = 'p_d002'")).stock, stock0 - 1, 'ตัดสต็อกครั้งเดียว');
  assert.ok(o.tickets.length > 0, 'ส่งครัวหลังยืนยันเงิน');
});

test('จ่ายสำเร็จหลังออเดอร์หมดอายุ → เก็บไว้ตรวจสอบ ไม่ถูกนับเป็นยอดขาย', async () => {
  const ms = await newSession({ mode: 'pickup' });
  const r = await S.call('POST', '/api/m/orders', { idempotency_key: key(), mode: 'pickup', customer_name: 'F', lines: [line('p_d003', 1)], pay_mode: 'online' }, M(ms.session.token));
  const gw = await S.call('POST', `/api/m/orders/${r.body.id}/gateway`, {}, M(ms.session.token));
  const ref = gw.body.url.split('#')[1];
  await db.run("UPDATE orders SET status = 'expired' WHERE id = ?", [r.body.id]);
  GATEWAYS.mock.markPaid(ref);
  const raw = JSON.stringify({ event: 'paid', ref });
  const res = await (await fetch(S.base + '/api/webhooks/mock', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': GATEWAYS.mock.sign(raw) }, body: raw })).json();
  assert.equal(res.status, 'needs_review');
  const o = (await S.call('GET', '/api/orders/' + r.body.id, undefined, { token: owner })).body;
  assert.equal(o.status, 'expired');
  assert.ok(o.payments.some((p) => p.status === 'needs_review'));
});

test('รายงานแยกแหล่งที่มา POS / Mobile โต๊ะ / Mobile Pick Up', async () => {
  const rep = (await S.call('GET', '/api/reports?preset=today', undefined, { token: owner })).body;
  const src = Object.fromEntries(rep.by_source.map((x) => [x.source, x]));
  assert.ok(src.mobile_pickup);
  const onlyPickup = (await S.call('GET', '/api/reports?preset=today&source=mobile_pickup', undefined, { token: owner })).body;
  assert.equal(onlyPickup.summary.net_sales, src.mobile_pickup.amount);
});
