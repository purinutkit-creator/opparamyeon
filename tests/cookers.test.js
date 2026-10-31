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

test('QR ใบสรุปร้านค้า: เปิดรายละเอียดบิลได้โดยไม่ต้องเข้าสู่ระบบ ปลอมลิงก์ไม่ได้', async () => {
  const o = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 2)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { merchant: true } }, { token: owner, terminal: 'pos1' })).body;
  const job = await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'merchant'", [o.id]);
  const url = JSON.parse(job.payload).data.detail_url;
  const { billTokenOf, fromThaiKeys } = await import('../public/shared/core.js');
  const tok = billTokenOf(url);
  assert.ok(tok && tok.startsWith(o.bill_no + '.'), url);
  const r = await S.call('GET', '/api/public/bill/' + encodeURIComponent(tok));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.bill_no, o.bill_no);
  assert.equal(r.body.items[0].qty, 2);
  assert.equal(r.body.member, undefined, 'ไม่ส่งข้อมูลสมาชิก');
  const bad = tok.slice(0, -1) + (tok.endsWith('0') ? '1' : '0');
  assert.equal((await S.call('GET', '/api/public/bill/' + encodeURIComponent(bad))).status, 404);
  assert.equal((await S.call('GET', '/api/public/bill/' + encodeURIComponent(o.bill_no + '.000000000000'))).status, 404);
  // the same link typed by a scanner while the device keyboard is Thai (Kedmanee)
  const US = "1234567890-=qwertyuiop[]\\asdfghjkl;'zxcvbnm,./!@#$%^&*()_+QWERTYUIOP{}|ASDFGHJKL:\"ZXCVBNM<>?~";
  const TH = 'ๅ/-ภถุึคตจขชๆไำพะัีรนยบลฃฟหกดเ้่าสวงผปแอิืทมใฝ+๑๒๓๔ู฿๕๖๗๘๙๐"ฎฑธํ๊ณฯญฐ,ฅฤฆฏโฌ็๋ษศซ.()ฉฮฺ์?ฒฬฦ%';
  const typed = [...url].map((c) => (US.includes(c) ? [...TH][US.indexOf(c)] : c)).join('');
  assert.ok(/[฀-๿]/.test(typed));
  assert.equal(fromThaiKeys(typed), url);
  assert.equal(billTokenOf(fromThaiKeys(typed)), tok);
  assert.equal(fromThaiKeys('คคถ-ต/'), '885392');
});

test('รายงานรอบ: รายละเอียดเพิ่ม และ QR เปิดดูได้โดยไม่ต้องเข้าสู่ระบบ', async () => {
  await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 3), line('p_r001', 1, { options: ramyeonOpts, bowl_group: 1 })] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }] }, { token: owner, terminal: 'pos1' });
  const cur = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  assert.ok(cur.top_items.length && cur.top_items[0].qty >= 1, 'ขายดี');
  assert.ok(cur.hours.length >= 1 && cur.first_bill_at && cur.avg_bill > 0);
  assert.ok(cur.by_dine.dine_in.n >= 1);
  const link = (await S.call('GET', `/api/shifts/${cur.id}/link`, undefined, { token: owner, terminal: 'pos1' })).body.url;
  const tok = decodeURIComponent(link.split('/s/#')[1]);
  const pub = await S.call('GET', '/api/public/shift/' + encodeURIComponent(tok));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.shift.id, cur.id);
  assert.equal((await S.call('GET', '/api/public/shift/' + encodeURIComponent(cur.id + '.000000000000'))).status, 404);
  // the printed shift slip carries the same link
  await S.call('POST', `/api/shifts/${cur.id}/print`, {}, { token: owner, terminal: 'pos1' });
  const job = await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'shift' ORDER BY seq DESC", [cur.id]);
  if (job) assert.match(JSON.parse(job.payload).data.shift_url || '', /\/s\/#/);
});

test('บัตรพนักงาน: ชื่อ นามสกุล รูป และ QR สแกนดูข้อมูล/เข้าระบบได้ ปลอมไม่ได้', async () => {
  const id = (await S.call('POST', '/api/staff', { code: '7701', name: 'มินจี', last_name: 'คิม', nickname: 'มิน', title: 'หัวหน้ากะ', pin: '4321', role_id: 'cashier', photo: '/files/abc123' }, { token: owner })).body.id;
  const list = (await S.call('GET', '/api/staff', undefined, { token: owner })).body;
  const me = list.find((x) => x.id === id);
  assert.equal(me.last_name, 'คิม'); assert.equal(me.nickname, 'มิน'); assert.equal(me.photo, '/files/abc123');
  await S.call('PUT', '/api/staff/' + id, { photo: 'javascript:alert(1)' }, { token: owner });
  assert.equal((await S.call('GET', '/api/staff', undefined, { token: owner })).body.find((x) => x.id === id).photo, null, 'รูปต้องเป็นไฟล์ในระบบหรือ https');
  const url = (await S.call('GET', `/api/staff/${id}/card`, undefined, { token: owner })).body.url;
  const tok = decodeURIComponent(url.split('/st/#')[1]);
  const pub = await S.call('GET', '/api/public/staff/' + encodeURIComponent(tok));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.code, '7701'); assert.equal(pub.body.title, 'หัวหน้ากะ');
  assert.equal(pub.body.pin_hash, undefined);
  assert.equal((await S.call('GET', '/api/public/staff/7701.000000000000')).status, 404);
  assert.equal((await S.call('GET', '/api/public/staff/' + encodeURIComponent(tok.replace('7701', '0001')))).status, 404);
  assert.equal((await S.call('POST', '/api/auth/login', { code: '7701', pin: '4321' })).status, 200);
});

test('เข้างานหลายคน: ยืนยัน PIN ทีละคน เลือกคนหลัก แล้วรอบการขายบันทึกทุกคน', async () => {
  await S.call('POST', '/api/staff', { code: '7702', name: 'จีซู', pin: '5555', role_id: 'cashier' }, { token: owner });
  await S.call('POST', '/api/staff', { code: '7703', name: 'โรเซ่', pin: '6666', role_id: 'cashier' }, { token: owner });
  const v = await S.call('POST', '/api/auth/verify', { code: '7702', pin: '5555' });
  assert.equal(v.status, 200); assert.equal(v.body.name, 'จีซู'); assert.equal(v.body.pin_hash, undefined); assert.equal(v.body.token, undefined, 'ยืนยันอย่างเดียว ไม่เปิด session');
  assert.equal((await S.call('POST', '/api/auth/verify', { code: '7703', pin: '0000' })).status, 401);
  // a crew member with a wrong PIN stops the whole sign-in
  assert.equal((await S.call('POST', '/api/auth/login', { code: '0001', pin: '1234', crew: [{ code: '7702', pin: '1111' }] })).status, 401);
  // new terminal, no shift yet: the main signs in with the crew, then opens the shift
  const term = (await S.call('POST', '/api/terminals', { name: 'เครื่องทดสอบทีม' }, { token: owner })).body;
  const lg = await S.call('POST', '/api/auth/login', { code: '0001', pin: '1234', terminal_id: term.id, crew: [{ code: '7702', pin: '5555' }, { code: '7703', pin: '6666' }, { code: '0001', pin: '1234' }] });
  assert.equal(lg.status, 200, JSON.stringify(lg.body));
  assert.deepEqual(lg.body.crew.map((c) => c.code), ['7702', '7703'], 'คนหลักไม่ซ้ำในทีม');
  const sh = await S.call('POST', '/api/shifts/open', { opening_cash: 50000 }, { token: lg.body.token, terminal: term.id });
  assert.equal(sh.status, 200, JSON.stringify(sh.body));
  assert.deepEqual(sh.body.crew.map((c) => [c.code, !!c.main]), [['0001', true], ['7702', false], ['7703', false]]);
  // joining a shift that is already open adds the person
  await S.call('POST', '/api/staff', { code: '7704', name: 'ลิซ่า', pin: '7777', role_id: 'cashier' }, { token: owner });
  await S.call('POST', '/api/auth/login', { code: '7704', pin: '7777', terminal_id: term.id });
  const cur = (await S.call('GET', '/api/shifts/current', undefined, { token: lg.body.token, terminal: term.id })).body;
  for (const n of ['จีซู', 'โรเซ่', 'ลิซ่า']) assert.ok(cur.crew.some((c) => c.name === n), n + ' อยู่ในรอบ');
  assert.equal(cur.crew.length, 4);
  // the public report (QR) lists names only, never staff codes
  const link = (await S.call('GET', `/api/shifts/${cur.id}/link`, undefined, { token: lg.body.token, terminal: term.id })).body.url;
  const pub = await S.call('GET', '/api/public/shift/' + encodeURIComponent(decodeURIComponent(link.split('/s/#')[1])));
  assert.equal(pub.status, 200);
  assert.equal(pub.body.shift.crew.length, 4);
  assert.ok(pub.body.shift.crew.every((c) => c.code === undefined && c.id === undefined));
});

test('ตารางเข้างาน: เจ้าของตั้งจำนวนคนต่อวัน คนลาหยุดเข้าไม่ได้ คนเข้าทีหลังสแกนเข้ารอบภายหลัง', async () => {
  const staff = (await S.call('GET', '/api/staff', undefined, { token: owner })).body;
  const idOf = (c) => staff.find((x) => x.code === c).id;
  const today = (await S.call('GET', '/api/crew/today')).body.date;
  const wd = new Date(today + 'T12:00:00Z').getUTCDay();
  const weekly = { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, [wd]: 3 };
  let r = await S.call('PUT', '/api/settings/crew', { value: { weekly, dates: {}, max: 8 } }, { token: owner });
  assert.equal(r.status, 200);
  assert.equal((await S.call('GET', '/api/crew/today')).body.need, 3, 'วันนี้ตั้งไว้ 3 คน');
  // special day: one on leave, one joining later
  await S.call('PUT', '/api/settings/crew', { value: { weekly, dates: { [today]: { count: null, leave: [idOf('7702')], late: [idOf('7703')] } }, max: 8 } }, { token: owner });
  const plan = (await S.call('GET', '/api/crew/today?terminal=pos1')).body;
  assert.equal(plan.need, 2, '3 คน − ลา 1 คน');
  assert.deepEqual(plan.leave, ['จีซู']); assert.deepEqual(plan.late.map((x) => x.name), ['โรเซ่']);
  assert.equal(JSON.stringify(plan).includes('7702'), false, 'ไม่เปิดเผยรหัสพนักงาน');
  const v = await S.call('POST', '/api/auth/verify', { code: '7702', pin: '5555' });
  assert.equal(v.status, 403); assert.match(v.body.error, /ลาหยุด/);
  assert.equal((await S.call('POST', '/api/auth/login', { code: '7702', pin: '5555', terminal_id: 'pos1' })).status, 403, 'เข้า POS ไม่ได้วันที่ลา');
  assert.equal((await S.call('POST', '/api/auth/login', { code: '0001', pin: '1234', terminal_id: 'pos1', crew: [{ code: '7702', pin: '5555' }] })).status, 403);
  // the late one joins the open shift from the POS
  const j = await S.call('POST', '/api/shifts/join', { code: '7703', pin: '6666' }, { token: owner, terminal: 'pos1' });
  assert.equal(j.status, 200, JSON.stringify(j.body));
  assert.ok(j.body.crew.some((c) => c.name === 'โรเซ่' && c.late));
  assert.equal((await S.call('GET', '/api/crew/today?terminal=pos1')).body.late[0].joined, true);
  assert.equal((await S.call('POST', '/api/shifts/join', { code: '7702', pin: '5555' }, { token: owner, terminal: 'pos1' })).status, 403);
  await S.call('PUT', '/api/settings/crew', { value: { weekly: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1 }, dates: {}, max: 8 } }, { token: owner });
});

test('ลงเวลาเข้างาน: บันทึกเวลาแต่ละคน พิมพ์ใบลงเวลา QR ดูได้ (ย้อนวันได้ในช่วง) และปุ่มเงินเท่าเมื่อวาน', async () => {
  await S.call('POST', '/api/printers', { name: 'ใบเสร็จทดสอบลงเวลา', conn: 'lan', address: '10.9.9.30', port: 9100, paper: 80, roles: ['receipt'] }, { token: owner });
  await S.call('POST', '/api/staff', { code: '7901', name: 'ฮานา', pin: '1212', role_id: 'cashier' }, { token: owner });
  await S.call('POST', '/api/staff', { code: '7902', name: 'ดาอึน', pin: '3434', role_id: 'cashier' }, { token: owner });
  const t1 = new Date(Date.now() - 4 * 60e3).toISOString(), t2 = new Date(Date.now() - 2 * 60e3).toISOString();
  const lg = await S.call('POST', '/api/auth/login', { code: '7901', pin: '1212', at: t2, terminal_id: 'pos1', crew: [{ code: '7902', pin: '3434', at: t1 }] });
  assert.equal(lg.status, 200, JSON.stringify(lg.body));
  const rows = await db.all("SELECT name, at, main FROM attendance WHERE name IN ('ฮานา', 'ดาอึน') ORDER BY at");
  assert.deepEqual(rows.map((r) => [r.name, r.at, Number(r.main)]), [['ดาอึน', t1, 0], ['ฮานา', t2, 1]], 'เวลาที่สแกนของแต่ละคน');
  const job = await db.get("SELECT payload FROM print_jobs WHERE doc_type = 'attendance' ORDER BY seq DESC LIMIT 1");
  assert.ok(job, 'พิมพ์ใบลงเวลา');
  const data = JSON.parse(job.payload).data;
  assert.ok(data.rows.some((r) => r[0].startsWith('ดาอึน')) && data.rows.some((r) => r[0] === 'ฮานา (หลัก)'));
  // signing in again the same day keeps the first time and prints nothing new
  const n0 = (await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'attendance'")).n;
  await S.call('POST', '/api/auth/login', { code: '7901', pin: '1212', terminal_id: 'pos1' });
  assert.equal((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'attendance'")).n, n0);
  assert.equal((await db.get("SELECT at FROM attendance WHERE name = 'ฮานา'")).at, t2);
  // a time from the POS that is far off falls back to the server clock
  await S.call('POST', '/api/staff', { code: '7903', name: 'ซอล', pin: '5656', role_id: 'cashier' }, { token: owner });
  await S.call('POST', '/api/auth/login', { code: '7903', pin: '5656', terminal_id: 'pos1', at: '2001-01-01T00:00:00Z' });
  assert.ok(Date.parse((await db.get("SELECT at FROM attendance WHERE name = 'ซอล'")).at) > Date.now() - 60e3);
  // the QR: that day, other days within the window, nothing outside it, no forging
  const tok = decodeURIComponent(data.att_url.split('/at/#')[1]);
  const day = tok.split('.')[0];
  const pub = await S.call('GET', '/api/public/attendance/' + encodeURIComponent(tok));
  assert.equal(pub.status, 200);
  assert.ok(pub.body.rows.some((r) => r.name === 'ดาอึน'));
  assert.equal(JSON.stringify(pub.body).includes('7902'), false, 'ไม่มีรหัสพนักงาน');
  const back = (n) => new Date(Date.parse(day + 'T12:00:00Z') - n * 864e5).toISOString().slice(0, 10);
  assert.equal((await S.call('GET', `/api/public/attendance/${encodeURIComponent(tok)}?date=${back(5)}`)).status, 200);
  assert.equal((await S.call('GET', `/api/public/attendance/${encodeURIComponent(tok)}?date=${back(40)}`)).status, 404);
  assert.equal((await S.call('GET', '/api/public/attendance/' + encodeURIComponent(back(1) + tok.slice(10)))).status, 404);
  // "same as yesterday": the opening cash of the last shift on this device
  const last = (await S.call('GET', '/api/shifts/last-opening', undefined, { token: owner, terminal: 'pos1' })).body;
  assert.equal(typeof last.amount, 'number'); assert.ok(last.business_date);
});

test('รูปเข้างาน: ต้องถ่ายรูปก่อนเข้างาน (ตั้งบังคับ) ผูกรูปกับคนที่ใส่ PIN และคนแรกก็ได้ใบลงเวลา', async () => {
  const cur = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.crew;
  await S.call('PUT', '/api/settings/crew', { value: { ...cur, selfie: 'required', print: 'always' } }, { token: owner });
  await S.call('POST', '/api/staff', { code: '7911', name: 'นารา', pin: '1357', role_id: 'cashier' }, { token: owner });
  await S.call('POST', '/api/staff', { code: '7912', name: 'จุน', pin: '2468', role_id: 'cashier' }, { token: owner });
  const v = (await S.call('POST', '/api/auth/verify', { code: '7911', pin: '1357' })).body;
  assert.ok(v.ticket); assert.equal(v.clocked_today, false);
  // no photo → can't clock in on a POS
  const no = await S.call('POST', '/api/auth/login', { code: '7911', pin: '1357', terminal_id: 'pos1', ticket: v.ticket });
  assert.equal(no.status, 400); assert.match(no.body.error, /ถ่ายรูปเข้างาน/);
  // the photo (from the POS camera, or the phone behind the QR) is tied to the ticket
  const jpg = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64');
  assert.equal((await S.call('POST', '/api/clockin/photo', { ticket: v.ticket.replace(/.$/, (c) => (c === '0' ? '1' : '0')), image: jpg })).status, 400, 'ตั๋วปลอม');
  assert.equal((await S.call('POST', '/api/clockin/photo', { ticket: v.ticket, image: 'data:text/html;base64,PGI+' })).status, 400, 'ต้องเป็นรูป');
  assert.equal((await S.call('GET', '/api/clockin/ticket/' + encodeURIComponent(v.ticket))).body.name, 'นารา');
  const up = await S.call('POST', '/api/clockin/photo', { ticket: v.ticket, image: jpg, live: true, source: 'phone' });
  assert.equal(up.status, 200);
  assert.equal((await S.call('GET', '/api/clockin/photo/' + encodeURIComponent(v.ticket))).body.url, up.body.url);
  // someone else's ticket doesn't count for this person
  const w = (await S.call('POST', '/api/auth/verify', { code: '7912', pin: '2468' })).body;
  assert.equal((await S.call('POST', '/api/auth/login', { code: '7912', pin: '2468', terminal_id: 'pos1', ticket: v.ticket })).status, 400);
  const n0 = Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'attendance'")).n);
  const ok = await S.call('POST', '/api/auth/login', { code: '7911', pin: '1357', terminal_id: 'pos1', ticket: v.ticket, face: { ok: true } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = await db.get("SELECT photo, face_ok, live FROM attendance WHERE name = 'นารา'");
  assert.equal(row.photo, up.body.url); assert.equal(Number(row.face_ok), 1); assert.equal(Number(row.live), 1);
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'attendance'")).n), n0 + 1, 'คนแรกคนเดียวก็พิมพ์ใบลงเวลา');
  // every sign-in needs a photo (default); the shop can ask only for the first of the day
  assert.equal((await S.call('POST', '/api/auth/verify', { code: '7911', pin: '1357' })).body.clocked_today, true);
  assert.equal((await S.call('POST', '/api/auth/login', { code: '7911', pin: '1357', terminal_id: 'pos1' })).status, 400, 'เข้าใหม่ก็ต้องถ่ายรูป');
  await S.call('PUT', '/api/settings/crew', { value: { ...cur, selfie: 'required', selfie_when: 'first' } }, { token: owner });
  assert.equal((await S.call('POST', '/api/auth/login', { code: '7911', pin: '1357', terminal_id: 'pos1' })).status, 200, 'ตั้งเป็นครั้งแรกของวัน: เข้าซ้ำไม่ต้องถ่าย');
  assert.ok(w.ticket);
  await S.call('PUT', '/api/settings/crew', { value: { ...cur, selfie: 'off', selfie_when: 'every' } }, { token: owner });
});

test('ปิดรอบ: ม้วนใบสรุป 58 มม. ป้อนกระดาษให้ฉีก / ตัดเมื่อเครื่องมีมีดตัดและตั้งให้ตัด / ป้อนเพิ่มได้', async () => {
  const roll = (await S.call('POST', '/api/printers', { name: 'ม้วนสรุป 58', conn: 'lan', address: '10.9.9.58', port: 9100, paper: 58, roles: ['merchant'], cut_mode: 'none' }, { token: owner })).body;
  const P = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.print;
  await S.call('PUT', '/api/settings/print', { value: { ...P, merchant_style: 'compact', merchant_printer_id: roll.id, merchant_end_feed: 7, merchant_end_cut: true } }, { token: owner });
  const lastFeed = async () => JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE doc_type = 'feed' AND printer_id = ? ORDER BY seq DESC LIMIT 1", [roll.id])).payload).data;
  const cur = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  const closed = await S.call('POST', '/api/shifts/close', { counted_cash: cur.expected_cash }, { token: owner, terminal: 'pos1' });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.deepEqual(closed.body.roll.map((p) => [p.name, p.can_cut, p.cut]), [['ม้วนสรุป 58', false, false]], 'ไม่มีมีดตัด → ป้อนอย่างเดียว');
  let d = await lastFeed(); assert.equal(d.lines, 7); assert.equal(d.cut, false);
  // a printer with a cutter: feed + cut; "feed more" from the close screen; cutting can be switched off
  await S.call('PUT', '/api/printers/' + roll.id, { ...roll, cut_mode: 'full' }, { token: owner });
  assert.equal((await S.call('POST', '/api/print/merchant-feed', {}, { token: owner })).body.printers[0].cut, true);
  d = await lastFeed(); assert.equal(d.cut, true);
  await S.call('POST', '/api/print/merchant-feed', { lines: 4, cut: false }, { token: owner });
  d = await lastFeed(); assert.equal(d.lines, 4); assert.equal(d.cut, false);
  await S.call('PUT', '/api/settings/print', { value: { ...P, merchant_style: 'compact', merchant_printer_id: roll.id, merchant_end_cut: false } }, { token: owner });
  assert.equal((await S.call('POST', '/api/print/merchant-feed', {}, { token: owner })).body.printers[0].cut, false, 'ปิดการตัดไว้');
  // usual (normal) merchant slips: nothing to feed at close
  await S.call('PUT', '/api/settings/print', { value: P }, { token: owner });
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
  const c2 = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  assert.deepEqual((await S.call('POST', '/api/shifts/close', { counted_cash: c2.expected_cash }, { token: owner, terminal: 'pos1' })).body.roll, []);
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});

test('ใบสรุปร้านค้าตอนปิดรอบ: รวมทุกบิล เลือก 58/80 มม. และ POS รอสถานะจนพิมพ์เสร็จ', async () => {
  const pr = (await S.call('POST', '/api/printers', { name: 'สรุปปิดรอบ', conn: 'lan', address: '10.9.9.80', port: 9100, paper: 80, roles: ['receipt'] }, { token: owner })).body;
  const P = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.print;
  await S.call('PUT', '/api/settings/print', { value: { ...P, merchant_close: true, merchant_close_paper: 58, merchant_close_printer_id: pr.id } }, { token: owner });
  await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line('p_d001', 2)] }, payments: [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token: owner, terminal: 'pos1' });
  const cur = (await S.call('GET', '/api/shifts/current', undefined, { token: owner, terminal: 'pos1' })).body;
  const closed = (await S.call('POST', '/api/shifts/close', { counted_cash: cur.expected_cash }, { token: owner, terminal: 'pos1' })).body;
  assert.deepEqual(closed.merchant_close, { enabled: true, paper: 58, printer: { id: pr.id, name: 'สรุปปิดรอบ', paper: 80 } });
  const r = await S.call('POST', `/api/shifts/${closed.id}/merchant-print`, { paper: 58 }, { token: owner, terminal: 'pos1' });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.paper, 58);
  const job = await db.get('SELECT payload, printer_id FROM print_jobs WHERE id = ?', [r.body.jobs[0]]);
  const pl = JSON.parse(job.payload);
  assert.equal(job.printer_id, pr.id);
  assert.equal(pl.template.paper, 58); assert.equal(pl.template.force_paper, true, 'พิมพ์กว้าง 58 แม้เครื่องตั้ง 80');
  assert.ok(pl.data.bills.length >= 1); assert.ok(pl.data.totals[0][0].startsWith('รวม'));
  const st = (await S.call('GET', '/api/print/jobs/status?ids=' + r.body.jobs.join(','), undefined, { token: owner })).body;
  assert.equal(st[0].status, 'queued');
  await S.call('PUT', '/api/settings/print', { value: P }, { token: owner });
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
});

test('ล็อกหน้าจอ Inactive: ตั้งเวลา/เตือน/ล็อกหรือออกจากระบบ ส่งถึง POS และกันค่าผิด', async () => {
  let r = await S.call('PUT', '/api/settings/lock', { value: { enabled: true, seconds: 5, warn: 999, action: 'xx', keep_with_bill: 1 } }, { token: owner });
  assert.equal(r.status, 200);
  const pub = (await S.call('GET', '/api/settings/public')).body.lock;
  assert.deepEqual(pub, { enabled: true, seconds: 15, warn: 60, action: 'lock', keep_with_bill: true }, 'อย่างน้อย 15 วินาที เตือนไม่เกิน 60');
  await S.call('PUT', '/api/settings/lock', { value: { enabled: false, seconds: 600, warn: 10, action: 'logout' } }, { token: owner });
  const p2 = (await S.call('GET', '/api/settings/public')).body.lock;
  assert.equal(p2.enabled, false); assert.equal(p2.action, 'logout'); assert.equal(p2.seconds, 600);
  // PIN check on the lock screen
  assert.equal((await S.call('POST', '/api/auth/unlock', { pin: '1234' }, { token: owner })).body.ok, true);
});

test('สต็อก: สแกนแล้วเพิ่ม/นับจริง หมายเหตุไม่บังคับ ตั้งจุดเตือนใกล้หมด เริ่มนับสินค้าใหม่ และขายจนหมดแล้ว POS เห็นว่าหมด', async () => {
  const stock = (await S.call('GET', '/api/stock', undefined, { token: owner })).body;
  const p = stock.products.find((x) => !x.track_stock && x.barcodes.length) || stock.products.find((x) => !x.track_stock);
  assert.ok(p, 'มีสินค้าที่ยังไม่นับสต็อกให้ทดสอบ');
  // scan → start counting: no note needed
  let r = await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 3, mode: 'add', track: true, low_stock: 2 }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.item.stock, 3); assert.equal(r.body.item.low_stock, 2);
  const mv = await db.get('SELECT reason, ref FROM stock_moves WHERE item_id = ? ORDER BY created_at DESC LIMIT 1', [p.id]);
  assert.equal(mv.reason, 'รับเข้า'); assert.equal(mv.ref, 'add');
  r = await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 2, mode: 'set', note: 'นับหลังร้าน' }, { token: owner });
  assert.equal(r.body.item.stock, 2);
  assert.equal((await db.get('SELECT reason FROM stock_moves WHERE item_id = ? ORDER BY created_at DESC LIMIT 1', [p.id])).reason, 'นับหลังร้าน');
  assert.equal((await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 'abc' }, { token: owner })).status, 400);
  // only the low-stock level
  r = await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, low_stock: 1 }, { token: owner });
  assert.equal(r.body.item.stock, 2); assert.equal(r.body.item.low_stock, 1);
  // sell all of it → the catalog (POS) shows it sold out
  const opts = p.option_groups && p.option_groups.length ? ramyeonOpts : [];
  const sale = await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines: [line(p.id, 2, { options: opts })] }, payments: [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token: owner, terminal: 'pos1' });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.find((x) => x.id === p.id);
  assert.equal(cat.stock, 0); assert.equal(cat.sold_out, true, 'หมดที่ POS');
  await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 5 }, { token: owner });
  assert.equal((await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.find((x) => x.id === p.id).sold_out, false, 'เติมแล้วขายได้');
});

test('พิมพ์บาร์โค้ด: พิมพ์จากหน้าจัดการได้เลย (เครื่องที่เชื่อมไว้) และกระดาษพอดีขนาดฉลาก ไม่ป้อนเกิน', async () => {
  const pr = (await S.call('POST', '/api/printers', { name: 'ฉลาก 58', conn: 'usb', paper: 58, roles: ['receipt'] }, { token: owner })).body;
  const prods = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.slice(0, 2);
  const before = Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'label'")).n);
  const cfg = { width_mm: 40, height_mm: 30, cols: 1, feed_mm: 2, cut_each: false, end: 'feed', end_feed_mm: 8 };
  const r = await S.call('POST', '/api/print/labels', { printer_id: pr.id, items: [{ product_id: prods[0].id, qty: 2 }, { product_id: prods[1].id, qty: 1 }], cfg, local: true }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE doc_type = 'label'")).n), before, 'พิมพ์ในหน้านี้ ไม่เข้าคิว');
  const t = r.body.template;
  assert.equal(t.label_exact, true); assert.equal(t.margin, 0); assert.equal(t.label_end, 'feed'); assert.equal(t.label_end_mm, 8);
  assert.deepEqual(t.elements.map((e) => e.type), ['label', 'space', 'label', 'space', 'label'], 'ระยะห่างเฉพาะระหว่างแถว ไม่มีก่อน/หลัง');
  assert.equal(t.elements[1].height, 16, '2 มม. = 16 จุด');
  assert.equal(r.body.printer.id, pr.id);
  // cut each row: cut marks take no extra paper; without "local" the job is queued as before
  const q = await S.call('POST', '/api/print/labels', { printer_id: pr.id, items: [{ product_id: prods[0].id, qty: 2 }], cfg: { ...cfg, cut_each: true, end: 'cut' } }, { token: owner });
  assert.equal(q.status, 200);
  const pl = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE doc_type = 'label' ORDER BY seq DESC LIMIT 1")).payload);
  assert.deepEqual(pl.template.elements.map((e) => e.type + (e.type === 'cut' ? ':' + e.space : '')), ['label', 'cut:0', 'label']);
});

test('สต็อก: เติมสต็อกแล้วสินค้าที่เคยกด "หมด" เองกลับมาขายได้ · พิมพ์รายงานสต็อกแบบย่อ แถบดำเมื่อเหลือน้อยกว่า 5', async () => {
  const p = (await S.call('GET', '/api/stock', undefined, { token: owner })).body.products.find((x) => !x.track_stock);
  await S.call('POST', `/api/products/${p.id}/sold-out`, { sold_out: true }, { token: owner, terminal: 'pos1' });
  assert.equal((await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.find((x) => x.id === p.id).sold_out, true);
  await S.call('POST', '/api/stock/adjust', { item_type: 'product', item_id: p.id, qty: 3, track: true }, { token: owner });
  assert.equal((await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.find((x) => x.id === p.id).sold_out, false, 'เติมแล้วขายได้');
  const r = await S.call('POST', '/api/stock/print', { low: 5, local: true }, { token: owner, terminal: 'pos1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const low = r.body.data.low.find((x) => x[0].includes(p.name));
  assert.ok(low, 'เหลือ 3 < 5 อยู่ในส่วนใกล้หมด'); assert.equal(low[2], 'inv'); assert.match(low[0], /^ใกล้หมด/);
  assert.ok(!r.body.data.items.some((x) => x[0] === p.name));
  const q = await S.call('POST', '/api/stock/print', {}, { token: owner, terminal: 'pos1' });
  assert.equal(q.status, 200); assert.equal(q.body.jobs.length, 1);
});
