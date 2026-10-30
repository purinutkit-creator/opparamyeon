import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => {
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});
after(async () => { await S.close(); });
const send = (lines, extra = {}) => S.call('POST', '/api/orders/save', { idempotency_key: key(), action: 'send', cart: { lines }, ...extra }, { token: owner, terminal: 'pos1' });
const contentOf = async (tid) => JSON.parse((await db.get('SELECT content FROM kitchen_tickets WHERE id = ?', [tid])).content);

test('เครื่องต้ม: แต่ละชามไปเครื่องที่ว่างก่อน สลับกัน ใบครัวบอกชามที่ x/y และต้มโดยเครื่องไหน', async () => {
  const r = await send([line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 }), line('p_r001', 1, { options: ramyeonOpts, bowl_group: 2 }), line('p_r001', 1, { options: ramyeonOpts, bowl_group: 3 })]);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const jobs = r.body.cooker_jobs;
  assert.equal(jobs.length, 3, 'หนึ่งชามต่อหนึ่งงาน');
  assert.deepEqual(jobs.map((j) => j.machine), [1, 2, 1], 'สลับเครื่อง 1 → 2 → 1');
  const mins = (a, b) => (Date.parse(b) - Date.parse(a)) / 60000;
  assert.equal(mins(jobs[0].start_at, jobs[0].end_at), 4, '1 ชาม 4 นาที');
  assert.equal(mins(jobs[0].start_at, jobs[2].start_at), 4, 'ชามที่ 3 รอเครื่อง 1 ว่าง');
  const c = await contentOf(jobs[2].ticket_id);
  assert.equal(c.bowl_part, 'ชามที่ 3/3');
  assert.equal(c.cooker, 'เครื่องต้ม 1');
  const st = (await S.call('GET', '/api/cookers/status', undefined, { token: owner })).body;
  assert.deepEqual(st.machines.map((m) => m.bowls), [2, 1]);
  assert.equal(st.machines[0].minutes_left, 8);
  // kitchen finishes bowl 1 early → bowl 3 moves up on machine 1
  await S.call('POST', `/api/kitchen/tickets/${jobs[0].ticket_id}/status`, { status: 'ready' }, { token: owner });
  const after1 = (await S.call('GET', '/api/cookers/status', undefined, { token: owner })).body;
  assert.equal(after1.machines[0].bowls, 1);
  assert.ok(after1.machines[0].minutes_left <= 4, 'คิวขยับเร็วขึ้น: ' + after1.machines[0].minutes_left);
  // a printer for cooker 2 → its tickets print there only
  const pr = (await S.call('POST', '/api/printers', { name: 'Cooker 2', conn: 'lan', address: '10.0.0.22', port: 9100, paper: 80, roles: ['kitchen'] }, { token: owner })).body.id;
  await S.call('PUT', '/api/settings/cookers', { value: { enabled: true, count: 2, minutes_per_bowl: 4, split_by_bowl: true, machines: [{ name: 'หม้อซ้าย' }, { name: 'หม้อขวา', printer_id: pr }] } }, { token: owner });
  const r2 = await send([line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 })]);
  const j2 = r2.body.cooker_jobs[0];
  assert.equal(j2.name, 'หม้อขวา', 'เครื่อง 2 ว่างก่อน');
  const printersUsed = (await db.all("SELECT printer_id FROM print_jobs WHERE ref_id = ? AND doc_type = 'kitchen'", [j2.ticket_id])).map((x) => x.printer_id);
  assert.deepEqual(printersUsed, [pr]);
  // void the bill → its bowls leave the queue
  await S.call('POST', `/api/orders/${r.body.id}/void`, { reason: 'test' }, { token: owner });
  const left = (await S.call('GET', '/api/cookers/status', undefined, { token: owner })).body.machines.map((m) => m.bowls);
  assert.deepEqual(left, [0, 1]);
});

test('ส่งครัวบิลเดิมซ้ำ ไม่พิมพ์ "สั่งเพิ่ม" (เว้นแต่ร้านตั้งให้พิมพ์)', async () => {
  const r = await send([line('p_d001', 1)]);
  const lines2 = r.body.items.map((i) => ({ id: i.id, qty: i.qty })).concat([line('p_d001', 1)]);
  const r2 = await S.call('POST', '/api/orders/save', { order_id: r.body.id, action: 'send', cart: { lines: lines2 } }, { token: owner, terminal: 'pos1' });
  const t2 = r2.body.tickets.find((t) => t.kind === 'add');
  const c2 = await contentOf(t2.id);
  assert.equal(c2.kind_label, 'ออเดอร์ใหม่');
  assert.equal(c2.kind, 'new');
  const s = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.print;
  await S.call('PUT', '/api/settings/print', { value: { ...s, mark_additions: true } }, { token: owner });
  const lines3 = r2.body.items.map((i) => ({ id: i.id, qty: i.qty })).concat([line('p_d001', 1)]);
  const r3 = await S.call('POST', '/api/orders/save', { order_id: r.body.id, action: 'send', cart: { lines: lines3 } }, { token: owner, terminal: 'pos1' });
  const t3 = r3.body.tickets.filter((t) => t.kind === 'add').pop();
  assert.equal((await contentOf(t3.id)).kind_label, '+++ สั่งเพิ่ม +++');
});

test('ใบสรุปร้านค้า: เลือกแบบย่อ (ไม่ตัด) และเลือกเครื่องพิมพ์ได้', async () => {
  const mk = async (name, paper, roles) => (await S.call('POST', '/api/printers', { name, conn: 'lan', address: '10.0.0.' + paper, port: 9100, paper, roles }, { token: owner })).body.id;
  const big = await mk('Receipt 80', 80, ['receipt', 'merchant']);
  const small = await mk('Roll 58', 58, ['receipt']);
  const P = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.print;
  const pay = () => S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { merchant: true } }, { token: owner, terminal: 'pos1' });
  // usual slip → printers with the merchant role, their own template
  const o1 = (await pay()).body;
  const j1 = await db.all("SELECT printer_id, payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'merchant'", [o1.id]);
  assert.deepEqual(j1.map((j) => j.printer_id), [big]);
  assert.equal(JSON.parse(j1[0].payload).template, undefined);
  // compact on the 58 mm roll printer → only that printer, compact layout without cutting
  await S.call('PUT', '/api/settings/print', { value: { ...P, merchant_style: 'compact', merchant_printer_id: small } }, { token: owner });
  const o2 = (await pay()).body;
  const j2 = await db.all("SELECT printer_id, payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'merchant'", [o2.id]);
  assert.deepEqual(j2.map((j) => j.printer_id), [small]);
  const t = JSON.parse(j2[0].payload).template;
  assert.equal(t.cut, 'none');
  assert.equal(t.paper, 58);
  assert.ok(t.elements.some((e) => e.type === 'qr') && t.elements.some((e) => e.type === 'totals'));
  const tpls = (await S.call('GET', '/api/templates', undefined, { token: owner })).body.templates;
  assert.ok(tpls.some((x) => x.doc_type === 'merchant' && x.name.startsWith('ใบสรุปย่อ')), 'แก้หน้าตาได้ในตัวออกแบบ');
  await S.call('PUT', '/api/settings/print', { value: P }, { token: owner });
});
