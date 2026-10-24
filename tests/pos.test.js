import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioc } from 'socket.io-client';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';

let S, owner, cashier;
before(async () => {
  S = await startServer();
  owner = await S.login();
  cashier = await S.login('0002', '2222', 'pos1');
  await S.call('POST', '/api/terminals', { name: 'เครื่องขาย 2' }, { token: owner });
  const t2 = (await db.get("SELECT id FROM terminals WHERE name = 'เครื่องขาย 2'")).id;
  S.t2 = t2;
  S.owner2 = await S.login('0001', '1234', t2);
  await S.call('POST', '/api/shifts/open', { opening_cash: 100000 }, { token: owner, terminal: 'pos1' });
  await S.call('POST', '/api/shifts/open', { opening_cash: 50000 }, { token: S.owner2, terminal: t2 });
  // one printer that does receipts + kitchen + shift (one printer, many jobs)
  await S.call('POST', '/api/printers', { name: 'XP-80', conn: 'lan', address: '192.168.1.50', port: 9100, paper: 80, roles: ['receipt', 'kitchen', 'shift', 'refund', 'mobile_qr', 'queue'] }, { token: owner });
});
after(async () => { await S.close(); });

const sell = (token, terminal, lines, extra = {}) => {
  const k = key();
  return S.call('POST', '/api/orders/checkout', { idempotency_key: k, cart: { lines, ...extra.cart }, payments: extra.payments || [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token, terminal });
};

test('ขายเงินสด คิดเงินทอน และสร้างใบเสร็จ + ใบครัว', async () => {
  const r = await sell(owner, 'pos1', [line('p_r001', 1, { options: ramyeonOpts }), line('p_d002', 2)], { payments: [{ method: 'cash', amount: 20000, received: 20000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const o = r.body;
  assert.equal(o.status, 'paid');
  assert.equal(o.total, 7900 + 5000);
  assert.equal(o.change_amount, 20000 - 12900);
  assert.equal(o.bowls, 1);
  assert.match(o.queue_no, /^D\d{3}$/);
  assert.ok(o.print_jobs.some((j) => j.doc_type === 'receipt'));
  assert.ok(o.print_jobs.some((j) => j.doc_type === 'kitchen'));
  const cash = o.payments.find((p) => p.method === 'cash');
  assert.equal(cash.amount, 12900, 'บันทึกเงินสดสุทธิหลังทอน');
});

test('ราคาจากฐานข้อมูลเท่านั้น และสิทธิ์แก้ราคา/ส่วนลด', async () => {
  const r = await sell(cashier, 'pos1', [{ ...line('p_r001', 1, { options: ramyeonOpts }), unit_price: 1 }]);
  assert.equal(r.body.total, 7900);
  const r2 = await sell(cashier, 'pos1', [{ ...line('p_r001', 1, { options: ramyeonOpts }), price_override: 100 }]);
  assert.equal(r2.status, 403);
  const r3 = await sell(cashier, 'pos1', [line('p_r001', 1, { options: ramyeonOpts })], { cart: { discount: { type: 'percent', value: 50 } } });
  assert.equal(r3.status, 403, 'แคชเชียร์ให้ส่วนลดได้ไม่เกิน 10%');
  const r4 = await sell(cashier, 'pos1', [line('p_r001', 1, { options: ramyeonOpts })], { cart: { discount: { type: 'percent', value: 10 } } });
  assert.equal(r4.body.discount, 790);
});

test('ต้องเลือกตัวเลือกบังคับ', async () => {
  const r = await sell(owner, 'pos1', [line('p_r001', 1)]);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'option_required');
});

test('กดยืนยันซ้ำ (idempotency) ไม่เกิดบิล/รับเงินซ้ำ', async () => {
  const k = key();
  const body = { idempotency_key: k, cart: { lines: [line('p_d003', 1)] }, payments: [{ method: 'cash', amount: 1500, received: 1500 }] };
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => S.call('POST', '/api/orders/checkout', body, { token: owner, terminal: 'pos1' })));
  const ids = new Set([a, b, c].filter((x) => x.status === 200).map((x) => x.body.id));
  assert.equal(ids.size, 1);
  const n = await db.get('SELECT COUNT(*) AS n FROM payments WHERE order_id = ?', [[...ids][0]]);
  assert.equal(Number(n.n), 1);
});

test('เลขคิวไม่ชนกันเมื่อขายพร้อมกันหลายเครื่อง; เลขบิลไม่ซ้ำ', async () => {
  const jobs = [];
  for (let i = 0; i < 20; i++) jobs.push(sell(i % 2 ? owner : S.owner2, i % 2 ? 'pos1' : S.t2, [line('p_d003', 1)]));
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => r.status === 200), JSON.stringify(res.find((r) => r.status !== 200)));
  const q = res.map((r) => r.body.queue_no);
  assert.equal(new Set(q).size, q.length, 'queue unique');
  const b = res.map((r) => r.body.bill_no);
  assert.equal(new Set(b).size, b.length, 'bill unique');
});

test('แยกคิวทานที่ร้าน/กลับบ้าน และแสดงตรงกันทุกจุด (บิล ใบครัว ใบเสร็จ)', async () => {
  const r = await sell(owner, 'pos1', [line('p_r001', 1, { options: ramyeonOpts, dine_type: 'takeaway' })]);
  const o = r.body;
  assert.equal(o.dine_type, 'takeaway');
  assert.match(o.queue_no, /^T\d{3}$/);
  const jobs = await db.all('SELECT doc_type, payload FROM print_jobs WHERE ref_id = ? OR ref_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?)', [o.id, o.id]);
  for (const j of jobs) {
    const d = JSON.parse(j.payload).data;
    assert.equal(d.dine_type, 'takeaway', j.doc_type);
    assert.equal(d.queue_no, o.queue_no, j.doc_type);
  }
  const mixed = await sell(owner, 'pos1', [line('p_r001', 1, { options: ramyeonOpts, dine_type: 'takeaway' }), line('p_d001', 1)]);
  assert.equal(mixed.body.dine_type, 'mixed');
  const kitchen = mixed.body.items.map((i) => i.dine_type).sort();
  assert.deepEqual(kitchen, ['dine_in', 'takeaway']);
});

test('ส่งครัวก่อนชำระ → สั่งเพิ่มพิมพ์เฉพาะรายการเพิ่ม → ยกเลิกรายการส่งใบยกเลิก', async () => {
  const k = key();
  const s1 = await S.call('POST', '/api/orders/save', { idempotency_key: k, action: 'send', cart: { lines: [line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 }), line('p_t001', 1, { bowl_group: 1 })], table_id: 't1' } }, { token: owner, terminal: 'pos1' });
  assert.equal(s1.status, 200, JSON.stringify(s1.body));
  const o = s1.body;
  assert.ok(o.queue_no);
  assert.equal(o.tickets.filter((t) => t.kind === 'new').length, 1, 'ชามที่ 1 + ไข่อยู่ใบเดียวกัน (ไม่แยกไปจุดท็อปปิ้ง)');
  // add more
  const lines2 = o.items.map((i) => ({ id: i.id, qty: i.qty })).concat([line('p_d001', 1)]);
  const s2 = await S.call('POST', '/api/orders/save', { order_id: o.id, action: 'send', cart: { lines: lines2 } }, { token: owner, terminal: 'pos1' });
  const add = s2.body.tickets.filter((t) => t.kind === 'add');
  assert.equal(add.length, 1);
  const addContent = JSON.parse((await db.get('SELECT content FROM kitchen_tickets WHERE id = ?', [add[0].id])).content);
  assert.deepEqual(addContent.lines.map((l) => l.name), ['ชาเย็น']);
  assert.equal(s2.body.queue_no, o.queue_no, 'เลขคิวเดิม');
  // cashier cannot cancel an item already in the kitchen
  const egg = s2.body.items.find((i) => i.product_id === 'p_t001');
  const keepLines = s2.body.items.filter((i) => i.id !== egg.id).map((i) => ({ id: i.id, qty: i.qty - i.void_qty }));
  const denied = await S.call('POST', '/api/orders/save', { order_id: o.id, action: 'save', cart: { lines: keepLines } }, { token: cashier, terminal: 'pos1' });
  assert.equal(denied.status, 403);
  const s3 = await S.call('POST', '/api/orders/save', { order_id: o.id, action: 'save', cart: { lines: keepLines } }, { token: owner, terminal: 'pos1' });
  const v = s3.body.tickets.filter((t) => t.kind === 'void');
  assert.equal(v.length, 1);
  const vc = JSON.parse((await db.get('SELECT content FROM kitchen_tickets WHERE id = ?', [v[0].id])).content);
  assert.match(vc.ref, new RegExp(o.bill_no));
  assert.equal(s3.body.total, 7900 + 4500);
  // pay: no duplicate kitchen tickets
  const before = s3.body.tickets.length;
  const p = await S.call('POST', '/api/orders/checkout', { order_id: o.id, idempotency_key: key(), payments: [{ method: 'card', amount: s3.body.total }] }, { token: owner, terminal: 'pos1' });
  assert.equal(p.status, 200, JSON.stringify(p.body));
  assert.equal(p.body.tickets.length, before, 'จ่ายเงินแล้วไม่ส่งครัวซ้ำ');
  assert.equal(p.body.queue_no, o.queue_no);
});

test('พักบิลและเรียกคืน', async () => {
  const h = await S.call('POST', '/api/orders/save', { idempotency_key: key(), action: 'hold', cart: { lines: [line('p_d002', 1)], customer_name: 'คุณเอ' } }, { token: owner, terminal: 'pos1' });
  assert.equal(h.body.status, 'held');
  assert.equal(h.body.tickets.length, 0);
  const list = await S.call('GET', '/api/orders?status=held', undefined, { token: owner });
  assert.ok(list.body.some((x) => x.id === h.body.id));
  const p = await S.call('POST', '/api/orders/checkout', { order_id: h.body.id, idempotency_key: key(), payments: [{ method: 'cash', amount: 2500, received: 2500 }] }, { token: owner, terminal: 'pos1' });
  assert.equal(p.body.status, 'paid');
});

test('แบ่งชำระหลายช่องทาง', async () => {
  const r = await sell(owner, 'pos1', [line('p_set1', 1, { options: [{ group_id: 'og_spicy', id: 's1' }] })], { payments: [{ method: 'promptpay', amount: 10000 }, { method: 'cash', amount: 13900, received: 15000 }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bowls, 2, 'เซตคู่ = 2 ชาม');
  assert.equal(r.body.change_amount, 1100);
  const bad = await sell(owner, 'pos1', [line('p_d003', 1)], { payments: [{ method: 'card', amount: 99999 }] });
  assert.equal(bad.status, 400, 'บัตร/โอนเกินยอดไม่ได้');
});

test('เครื่องพิมพ์เดียวรับหลายงาน: ดึงงานทีละงานตามลำดับ ไม่ปะปน; สถานะตามที่อุปกรณ์ยืนยัน', async () => {
  const pr = (await S.call('GET', '/api/printers', undefined, { token: owner })).body[0];
  const first = await S.call('POST', '/api/print/claim', { printer_id: pr.id, host: 'pos1' }, { token: owner, terminal: 'pos1' });
  assert.ok(first.body && first.body.id);
  const second = await S.call('POST', '/api/print/claim', { printer_id: pr.id, host: 'pos1' }, { token: owner, terminal: 'pos1' });
  assert.equal(second.body, null, 'งานถัดไปต้องรอจนงานแรกเสร็จ');
  await S.call('POST', `/api/print/jobs/${first.body.id}/report`, { status: 'sent' }, { token: owner, terminal: 'pos1' });
  let j = await db.get('SELECT status FROM print_jobs WHERE id = ?', [first.body.id]);
  assert.equal(j.status, 'sent', 'เครื่องรับงานแล้ว ยังไม่แจ้งว่าพิมพ์เสร็จ');
  const next = await S.call('POST', '/api/print/claim', { printer_id: pr.id }, { token: owner, terminal: 'pos1' });
  assert.ok(next.body.seq > first.body.seq, 'ลำดับงานถูกต้อง');
  await S.call('POST', `/api/print/jobs/${next.body.id}/report`, { status: 'failed', error: 'กระดาษหมด' }, { token: owner, terminal: 'pos1' });
  const dup = await S.call('POST', `/api/print/jobs/${next.body.id}/report`, { status: 'printed' }, { token: owner, terminal: 'pos1' });
  assert.equal(dup.status, 409, 'งานที่ล้มเหลวไม่ถูกเปลี่ยนเป็นพิมพ์สำเร็จ');
  await S.call('POST', `/api/print/jobs/${next.body.id}/retry`, {}, { token: owner });
  j = await db.get('SELECT status FROM print_jobs WHERE id = ?', [next.body.id]);
  assert.equal(j.status, 'queued');
});

test('พิมพ์ซ้ำใช้เลขคิวเดิม ไม่สร้างออเดอร์ใหม่', async () => {
  const r = await sell(owner, 'pos1', [line('p_d003', 1)]);
  const before = Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n);
  const rp = await S.call('POST', `/api/orders/${r.body.id}/print`, { doc: 'receipt' }, { token: owner });
  assert.equal(rp.body.reprint, true);
  const job = await db.get('SELECT payload FROM print_jobs WHERE id = ?', [rp.body.job_id]);
  const d = JSON.parse(job.payload).data;
  assert.equal(d.queue_no, r.body.queue_no);
  assert.equal(d.reprint, true);
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n), before);
  const kitchen = r.body.tickets.length;
  assert.equal((await S.call('GET', `/api/orders/${r.body.id}`, undefined, { token: owner })).body.tickets.length, kitchen, 'ไม่มีใบครัวเพิ่ม');
  const cashierRe = await S.call('POST', `/api/orders/${r.body.id}/print`, { doc: 'receipt' }, { token: await S.login('0003', '3333') });
  assert.equal(cashierRe.status, 403);
});

test('ใบ Mobile Ordering ออกเฉพาะเมื่อเลือก', async () => {
  const r = await sell(owner, 'pos1', [line('p_d003', 1)]);
  assert.ok(!r.body.print_jobs.some((j) => j.doc_type === 'mobile_qr'));
  const n0 = Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'mobile_qr'")).n);
  const m = await S.call('POST', `/api/orders/${r.body.id}/print`, { doc: 'mobile_qr' }, { token: owner });
  assert.equal(m.status, 200);
  assert.ok(m.body.session.token.length >= 24);
  const again = await S.call('POST', `/api/orders/${r.body.id}/print`, { doc: 'mobile_qr' }, { token: owner });
  assert.equal(again.body.session.id, m.body.session.id, 'พิมพ์ซ้ำใช้สิทธิ์เดิม');
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'mobile_qr'")).n), n0 + 2);
  const kitchenUser = await S.login('0003', '3333');
  assert.equal((await S.call('POST', `/api/orders/${r.body.id}/print`, { doc: 'mobile_qr' }, { token: kitchenUser })).status, 403);
});

test('ยกเลิกบิล คืนเงินบางรายการ: ยอดเงิน จำนวนชาม และรายงานตรงกัน', async () => {
  const dash0 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  const a = await sell(owner, 'pos1', [line('p_r001', 2, { options: ramyeonOpts }), line('p_d002', 1)]);
  const b = await sell(owner, 'pos1', [line('p_set1', 1, { options: [{ group_id: 'og_spicy', id: 's1' }] })]);
  const dash1 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  assert.equal(dash1.net_sales - dash0.net_sales, a.body.total + b.body.total);
  assert.equal(dash1.bills_paid - dash0.bills_paid, 2);
  assert.equal(dash1.bowls_net - dash0.bowls_net, 4);
  // refund one ramyeon
  const ram = a.body.items.find((i) => i.product_id === 'p_r001');
  const rf = await S.call('POST', `/api/orders/${a.body.id}/refund`, { items: [{ item_id: ram.id, qty: 1 }], reason: 'ลูกค้าเปลี่ยนใจ' }, { token: owner, terminal: 'pos1' });
  assert.equal(rf.status, 200, JSON.stringify(rf.body));
  assert.equal(rf.body.amount, 7900);
  assert.equal(rf.body.bowls, 1);
  const over = await S.call('POST', `/api/orders/${a.body.id}/refund`, { items: [{ item_id: ram.id, qty: 5 }], reason: 'x' }, { token: owner, terminal: 'pos1' });
  assert.equal(over.status, 400);
  const v = await S.call('POST', `/api/orders/${b.body.id}/void`, { reason: 'คีย์ผิด' }, { token: owner, terminal: 'pos1' });
  assert.equal(v.status, 200);
  const cashierVoid = await S.call('POST', `/api/orders/${a.body.id}/void`, { reason: 'x' }, { token: cashier, terminal: 'pos1' });
  assert.equal(cashierVoid.status, 403);
  const dash2 = (await S.call('GET', '/api/dashboard', undefined, { token: owner })).body;
  assert.equal(dash2.net_sales - dash0.net_sales, a.body.total - 7900);
  assert.equal(dash2.bowls_net - dash0.bowls_net, 1);
  assert.equal(dash2.bills_paid - dash0.bills_paid, 1);
  assert.equal(dash2.voids.count - dash0.voids.count, 1);
  // report endpoint (same rules) agrees with the dashboard
  const rep = (await S.call('GET', '/api/reports?preset=today', undefined, { token: owner })).body;
  assert.equal(rep.summary.net_sales, dash2.net_sales);
  assert.equal(rep.summary.bowls_net, dash2.bowls_net);
  assert.equal(rep.summary.bills_paid, dash2.bills_paid);
  const shift = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  assert.ok(shift.net_sales > 0);
});

test('Refresh หลายครั้งพร้อมกันไม่ทำให้ยอดเปลี่ยน', async () => {
  const runs = await Promise.all(Array.from({ length: 10 }, () => S.call('GET', '/api/dashboard', undefined, { token: owner })));
  const vals = new Set(runs.map((r) => `${r.body.net_sales}/${r.body.bills_paid}/${r.body.bowls_net}`));
  assert.equal(vals.size, 1);
  const n = Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n);
  await Promise.all(Array.from({ length: 5 }, () => S.call('GET', '/api/reports?preset=last7', undefined, { token: owner })));
  assert.equal(Number((await db.get('SELECT COUNT(*) AS n FROM orders')).n), n);
});

test('ต้นทุน ณ เวลาขายไม่เปลี่ยนเมื่อแก้ต้นทุนภายหลัง; แคชเชียร์ไม่เห็นต้นทุน', async () => {
  const r = await sell(owner, 'pos1', [line('p_d002', 1)]);
  const cost0 = r.body.cost_total;
  await S.call('PUT', '/api/products/p_d002', { cost: 9999 }, { token: owner });
  const again = (await S.call('GET', `/api/orders/${r.body.id}`, undefined, { token: owner })).body;
  assert.equal(again.cost_total, cost0);
  const asCashier = (await S.call('GET', `/api/orders/${r.body.id}`, undefined, { token: cashier })).body;
  assert.equal(asCashier.cost_total, undefined);
});

test('สต็อกตัดตามสูตรวัตถุดิบ', async () => {
  const egg0 = (await db.get("SELECT stock FROM ingredients WHERE id = 'i_egg'")).stock;
  const noodle0 = (await db.get("SELECT stock FROM ingredients WHERE id = 'i_noodle'")).stock;
  await sell(owner, 'pos1', [line('p_r001', 2, { options: [...ramyeonOpts, { group_id: 'og_add', id: 'a_egg' }] })]);
  assert.equal((await db.get("SELECT stock FROM ingredients WHERE id = 'i_egg'")).stock, egg0 - 2);
  assert.equal((await db.get("SELECT stock FROM ingredients WHERE id = 'i_noodle'")).stock, noodle0 - 2);
});

test('จอลูกค้า: จับคู่ด้วยรหัส 6 หลัก หมดอายุ/ยกเลิกได้ และรับข้อมูลจาก POS แบบเรียลไทม์', async () => {
  const pc = await S.call('POST', '/api/display/pairing', {}, { token: owner, terminal: 'pos1' });
  assert.match(pc.body.code, /^\d{6}$/);
  const bad = await S.call('POST', '/api/display/pair', { code: '000000' });
  assert.equal(bad.status, 400);
  const ok = await S.call('POST', '/api/display/pair', { code: pc.body.code });
  assert.ok(ok.body.token);
  const reuse = await S.call('POST', '/api/display/pair', { code: pc.body.code });
  assert.equal(reuse.status, 400, 'ใช้รหัสซ้ำไม่ได้');
  const disp = ioc(S.base, { auth: { kind: 'display', token: ok.body.token }, transports: ['websocket'] });
  const pos = ioc(S.base, { auth: { kind: 'staff', token: owner, terminal_id: 'pos1' }, transports: ['websocket'] });
  // a display of another terminal must not see it
  const pc2 = await S.call('POST', '/api/display/pairing', {}, { token: S.owner2, terminal: S.t2 });
  const other = await S.call('POST', '/api/display/pair', { code: pc2.body.code });
  const disp2 = ioc(S.base, { auth: { kind: 'display', token: other.body.token }, transports: ['websocket'] });
  let leaked = false;
  disp2.on('display:state', (s) => { if (s.cart_id === 'c-1') leaked = true; });
  await new Promise((r) => setTimeout(r, 300));
  const got = new Promise((r) => disp.on('display:state', r));
  pos.emit('display:state', { cart_id: 'c-1', phase: 'cart', dine_type: 'takeaway', lines: [{ name: 'มาม่า', qty: 1 }], total: 7900 });
  const st = await got;
  assert.equal(st.dine_type, 'takeaway');
  assert.equal(st.total, 7900);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(leaked, false);
  // revoke
  const pairings = (await S.call('GET', '/api/display/pairings', undefined, { token: owner })).body;
  const revoked = new Promise((r) => disp.on('display:revoked', r));
  await S.call('POST', `/api/display/pairings/${pairings.find((p) => p.terminal_id === 'pos1').id}/revoke`, {}, { token: owner });
  await revoked;
  assert.equal((await S.call('GET', '/api/display/me', undefined, { token: ok.body.token })).status, 403);
  disp.close(); disp2.close(); pos.close();
});

test('Live View: แอดมินเห็นรายการที่แคชเชียร์กำลังคีย์และการชำระเงินแบบเรียลไทม์ แต่รายละเอียดไม่หลุดไปจอลูกค้า', async () => {
  const pc = await S.call('POST', '/api/display/pairing', {}, { token: owner, terminal: 'pos1' });
  const dtok = (await S.call('POST', '/api/display/pair', { code: pc.body.code })).body.token;
  const disp = ioc(S.base, { auth: { kind: 'display', token: dtok }, transports: ['websocket'] });
  const admin = ioc(S.base, { auth: { kind: 'staff', token: owner }, transports: ['websocket'] });
  const cash2 = ioc(S.base, { auth: { kind: 'staff', token: cashier, terminal_id: 'pos1' }, transports: ['websocket'] });
  try {
  let cashierSaw = false;
  cash2.on('live:update', () => { cashierSaw = true; });
  const within = (p, what) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error('timeout: ' + what)), 4000))]);
  await within(Promise.all([admin, disp, cash2].map((c, i) => new Promise((r) => (c.connected ? r() : c.on('connect', r))).then(() => i))), 'connect');
  const fromAdmin = new Promise((r) => admin.on('live:update', (x) => { if (x.state.cart_id === 'live-1' && x.state.phase === 'pay') r(x); }));
  const fromDisp = new Promise((r) => disp.on('display:state', (x) => { if (x.cart_id === 'live-1' && x.phase === 'pay') r(x); }));
  cash2.emit('display:state', { cart_id: 'live-1', phase: 'cart', lines: [{ name: 'มาม่า', qty: 1, price: 7900 }], total: 7900, at: 1,
    live: { member: { name: 'สมศรี ใจดี', member_no: 'M1', points: 10, earn: 3 } } });
  cash2.emit('display:state', { cart_id: 'live-1', phase: 'pay', lines: [{ name: 'มาม่า', qty: 2, price: 15800 }], total: 15800, at: 2,
    live: { member: { name: 'สมศรี ใจดี', member_no: 'M1', points: 10, earn: 6 }, pay: { method: 'เงินสด', entered: 20000, remaining: 15800, change: 4200 } } });
  const rec = await within(fromAdmin, 'admin update');
  assert.equal(rec.terminal_id, 'pos1');
  assert.equal(rec.online, true);
  assert.equal(rec.state.lines[0].qty, 2);
  assert.equal(rec.detail.pay.method, 'เงินสด');
  assert.equal(rec.detail.pay.change, 4200);
  assert.equal(rec.detail.member.name, 'สมศรี ใจดี');
  const d = await within(fromDisp, 'display state');
  assert.equal(d.live, undefined, 'จอลูกค้าไม่ได้รับชื่อเต็มสมาชิก/รายละเอียดพนักงาน');
  // an admin opening Live View later gets the current state of every terminal
  const snap = await within(new Promise((r) => admin.emit('live:snapshot', r)), 'snapshot');
  assert.equal(snap.find((x) => x.terminal_id === 'pos1').state.phase, 'pay');
  // a late, older update never overwrites a newer one
  cash2.emit('display:state', { cart_id: 'live-1', phase: 'cart', lines: [], total: 0, at: 0 });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await new Promise((r) => admin.emit('live:snapshot', r))).find((x) => x.terminal_id === 'pos1').state.phase, 'pay');
  assert.equal(cashierSaw, false, 'แคชเชียร์ที่ไม่มีสิทธิ์ดูยอดขายไม่เห็น Live View');
  const off = new Promise((r) => admin.on('live:update', (x) => { if (x.terminal_id === 'pos1' && !x.online) r(x); }));
  cash2.close();
  assert.equal((await within(off, 'offline')).online, false, 'ปิด POS แล้วแสดงออฟไลน์');
  } finally { admin.close(); disp.close(); cash2.close(); }
});

test('ช่องกรอกสมาชิกบนจอลูกค้า: เปิดเมื่อพนักงานสั่งเท่านั้น ผูกกับบิลและเครื่อง', async () => {
  await S.call('POST', '/api/members', { phone: '0891112222', first_name: 'สมชาย' }, { token: owner });
  const pc = await S.call('POST', '/api/display/pairing', {}, { token: owner, terminal: 'pos1' });
  const dtok = (await S.call('POST', '/api/display/pair', { code: pc.body.code })).body.token;
  const H = { Authorization: 'Bearer ' + dtok };
  // no prompt opened → lookup refused
  const noPrompt = await S.call('POST', '/api/member-prompt/lookup', { prompt_id: 'x', q: '0891112222' }, { headers: H });
  assert.equal(noPrompt.status, 409);
  const pos = ioc(S.base, { auth: { kind: 'staff', token: owner, terminal_id: 'pos1' }, transports: ['websocket'] });
  await new Promise((r) => pos.on('connect', r));
  const pr = await S.call('POST', '/api/member-prompt', { cart_id: 'cart-A' }, { token: owner, terminal: 'pos1' });
  const look = await S.call('POST', '/api/member-prompt/lookup', { prompt_id: pr.body.id, q: '089-111-2222' }, { headers: H });
  assert.equal(look.body.results.length, 1);
  assert.match(look.body.results[0].phone, /^089-xxx-2222$/);
  assert.ok(!JSON.stringify(look.body).includes('0891112222'), 'เบอร์ถูกปกปิด');
  // display of a different terminal cannot use this prompt
  const pc2 = await S.call('POST', '/api/display/pairing', {}, { token: S.owner2, terminal: S.t2 });
  const d2 = (await S.call('POST', '/api/display/pair', { code: pc2.body.code })).body.token;
  assert.equal((await S.call('POST', '/api/member-prompt/confirm', { prompt_id: pr.body.id, member_id: look.body.results[0].id }, { headers: { Authorization: 'Bearer ' + d2 } })).status, 403);
  const selected = new Promise((r) => pos.on('member:selected', r));
  const conf = await S.call('POST', '/api/member-prompt/confirm', { prompt_id: pr.body.id, member_id: look.body.results[0].id }, { headers: H });
  assert.equal(conf.status, 200);
  const ev = await selected;
  assert.equal(ev.cart_id, 'cart-A');
  assert.equal(ev.member.first_name, 'สมชาย');
  // closed after confirm
  assert.equal((await S.call('POST', '/api/member-prompt/lookup', { prompt_id: pr.body.id, q: '0891112222' }, { headers: H })).status, 409);
  // changing bill closes an open prompt
  const pr2 = await S.call('POST', '/api/member-prompt', { cart_id: 'cart-B' }, { token: owner, terminal: 'pos1' });
  pos.emit('display:cart_changed', { cart_id: 'cart-C' });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await S.call('POST', '/api/member-prompt/lookup', { prompt_id: pr2.body.id, q: '0891112222' }, { headers: H })).status, 409);
  pos.close();
});

test('ปิดรอบ: เงินสดที่ควรมีและยอดขาด/เกิน', async () => {
  const t3 = (await S.call('POST', '/api/terminals', { name: 'เครื่องขาย 3' }, { token: owner })).body.id;
  const tok = await S.login('0001', '1234', t3);
  await S.call('POST', '/api/shifts/open', { opening_cash: 100000 }, { token: tok, terminal: t3 });
  const a = await sell(tok, t3, [line('p_d001', 2)], { payments: [{ method: 'cash', amount: 10000, received: 10000 }] });
  await sell(tok, t3, [line('p_d003', 1)], { payments: [{ method: 'card', amount: 1500 }] });
  await S.call('POST', '/api/shifts/cash', { type: 'out', amount: 2000, reason: 'ซื้อน้ำแข็ง' }, { token: tok, terminal: t3 });
  const cl = await S.call('POST', '/api/shifts/close', { counted_cash: 100000 + 9000 - 2000 - 100 }, { token: tok, terminal: t3 });
  assert.equal(cl.status, 200, JSON.stringify(cl.body));
  assert.equal(cl.body.expected_cash, 100000 + a.body.total - 2000);
  assert.equal(cl.body.diff, -100);
  assert.equal(cl.body.bills, 2);
  const after = await sell(tok, t3, [line('p_d003', 1)]);
  assert.equal(after.status, 409, 'ปิดรอบแล้วขายต่อไม่ได้จนกว่าจะเปิดรอบใหม่');
});
