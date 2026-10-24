import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';
import { parseCsv, sheetCsvUrl, directImageUrl } from '../server/routes/importer.js';

let S, owner, printer;
before(async () => {
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
  const p = await S.call('POST', '/api/printers', { name: 'One printer', conn: 'lan', address: '10.0.0.9', port: 9100, paper: 80, roles: ['receipt', 'kitchen', 'merchant'],
    options: { cash_drawer: true, copies_by_doc: { receipt: 2 }, buzzer_mode: 'all', density: 190 } }, { token: owner });
  printer = p.body.id;
});
after(async () => { await S.close(); });
const sell = async (lines, extra = {}) => (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], ...extra }, { token: owner, terminal: 'pos1' })).body;
const jobsOf = (o) => db.all('SELECT doc_type, seq FROM print_jobs WHERE ref_id = ? OR ref_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?) ORDER BY seq', [o.id, o.id]);

test('ตั้งค่าเครื่องพิมพ์ละเอียด: บันทึกและคืนค่า options', async () => {
  const p = (await S.call('GET', '/api/printers', undefined, { token: owner })).body.find((x) => x.id === printer);
  assert.equal(p.options.density, 190);
  assert.equal(p.options.buzzer_mode, 'all');
  assert.equal(p.options.cash_drawer, true);
  const bad = await S.call('PUT', '/api/printers/' + printer, { options: { density: 999, scale: 9 } }, { token: owner });
  assert.equal(bad.status, 200);
  const p2 = (await S.call('GET', '/api/printers', undefined, { token: owner })).body.find((x) => x.id === printer);
  assert.equal(p2.options.density, 230, 'ค่าเกินถูกจำกัดช่วง');
  assert.equal(p2.options.scale, 1.5);
  await S.call('PUT', '/api/printers/' + printer, { options: { cash_drawer: true, copies_by_doc: { receipt: 2 }, buzzer_mode: 'all', density: 190 } }, { token: owner });
});

test('ลำดับการพิมพ์ตามที่ตั้ง: ใบเสร็จก่อนใบครัว และสลับได้; จำนวนสำเนาแยกตามเอกสาร; เปิดลิ้นชักเมื่อรับเงินสด', async () => {
  const o = await sell([line('p_r001', 1, { options: ramyeonOpts })]);
  const docs = (await jobsOf(o)).map((j) => j.doc_type);
  assert.deepEqual(docs, ['drawer', 'receipt', 'receipt', 'kitchen', 'merchant'], 'ใบสรุปร้านค้าพิมพ์อัตโนมัติทุกบิล (ค่าเริ่มต้น): ' + docs.join(','));
  await S.call('PUT', '/api/settings/print', { value: { order: ['kitchen', 'receipt'], auto_merchant: true } }, { token: owner });
  const o2 = await sell([line('p_r001', 1, { options: ramyeonOpts })]);
  const docs2 = (await jobsOf(o2)).map((j) => j.doc_type);
  assert.deepEqual(docs2, ['drawer', 'kitchen', 'receipt', 'receipt', 'merchant']);
  const card = await sell([line('p_d003', 1)], { payments: [{ method: 'card', amount: 1500 }] });
  assert.ok(!(await jobsOf(card)).some((j) => j.doc_type === 'drawer'), 'จ่ายบัตรไม่เปิดลิ้นชัก');
  await S.call('PUT', '/api/settings/print', { value: { order: ['receipt', 'kitchen'], auto_merchant: true } }, { token: owner });
});

test('ใบสรุปร้านค้า: มีบาร์โค้ดเลขบิล + QR รายละเอียด และสแกนเลขบิลเพื่อค้นบิลได้', async () => {
  const o = await sell([line('p_d001', 1)], { print: { merchant: true } });
  const j = await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'merchant'", [o.id]);
  const d = JSON.parse(j.payload).data;
  assert.equal(d.bill_no, o.bill_no);
  assert.match(d.detail_url, new RegExp(o.bill_no));
  assert.equal(d.pay_methods, 'เงินสด');
  const tpl = await db.get("SELECT data FROM templates WHERE doc_type = 'merchant' AND is_default = 1");
  const els = JSON.parse(tpl.data).elements;
  assert.ok(els.some((e) => e.type === 'barcode' && e.value === '{bill_no}'));
  assert.ok(els.some((e) => e.type === 'qr' && e.value === '{detail_url}'));
  const found = await S.call('GET', '/api/orders/by-bill/' + o.bill_no.toLowerCase(), undefined, { token: owner });
  assert.equal(found.body.id, o.id);
  assert.equal((await S.call('GET', '/api/orders/by-bill/NOPE', undefined, { token: owner })).status, 404);
});

test('ใบครัวแบบใหม่: เวลารับ/โต๊ะตัวใหญ่/หน่วยนับตั้งชื่อได้', async () => {
  await S.call('PUT', '/api/settings/sale', { value: { count_unit: 'จาน' } }, { token: owner });
  const s = await S.call('POST', '/api/orders/save', { idempotency_key: key(), action: 'send', cart: { lines: [line('p_r001', 1, { options: ramyeonOpts })], table_id: 't2' } }, { token: owner, terminal: 'pos1' });
  const t = await db.get("SELECT payload FROM print_jobs WHERE doc_type = 'kitchen' AND ref_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?)", [s.body.id]);
  const d = JSON.parse(t.payload).data;
  assert.equal(d.table_or_type, 'โต๊ะ: A2');
  assert.ok(d.received_time);
  assert.equal(d.count_unit, 'จาน');
  const tpl = JSON.parse((await db.get("SELECT data FROM templates WHERE doc_type = 'kitchen' AND is_default = 1")).data);
  assert.ok(tpl.elements.some((e) => e.type === 'items' && e.style === 'kitchen'));
  assert.equal((await S.call('GET', '/api/settings/public')).body.sale.count_unit, 'จาน');
  await S.call('PUT', '/api/settings/sale', { value: { count_unit: 'ชาม' } }, { token: owner });
});

test('นำเข้าสินค้าจาก CSV/Google Sheet: ดูตัวอย่างก่อน แล้วสร้าง/อัปเดต หมวดหมู่และจุดครัวใหม่', async () => {
  const tpl = await fetch(S.base + '/api/import/template.csv', { headers: { Authorization: 'Bearer ' + owner } }).then((r) => r.text());
  assert.match(tpl, /code \| รหัสสินค้า/);
  const csv = tpl + '\nX900,"มาม่า, พิเศษ",เมนูใหม่,"1,099.50",40,ที่,1,2,ครัวพิเศษ,"X9001, X9002",,อร่อย,"ชนิดเส้น, ไม่มีกลุ่มนี้",TRUE,TRUE,FALSE,0,0,1\nR001,มาม่าเกาหลีต้นตำรับ (สูตรใหม่),มาม่าเกาหลี,85,,,,,,,,,,,,,,,';
  const dry = await S.call('POST', '/api/import/products', { csv, dry_run: true }, { token: owner });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const x = dry.body.preview.find((p) => p.code === 'X900');
  assert.equal(x.action, 'create'); assert.equal(x.price, 109950); assert.equal(x.new_category, true);
  assert.equal(dry.body.preview.find((p) => p.code === 'R001').action, 'update');
  assert.ok(dry.body.errors.some((e) => /ไม่มีกลุ่มนี้/.test(e.error)));
  assert.equal(await db.get("SELECT id FROM products WHERE code = 'X900'"), undefined, 'dry run ไม่บันทึก');
  const done = await S.call('POST', '/api/import/products', { csv }, { token: owner });
  assert.ok(done.body.created >= 3 && done.body.updated >= 1, JSON.stringify(done.body));
  const p = await db.get("SELECT * FROM products WHERE code = 'X900'");
  assert.equal(p.name, 'มาม่า, พิเศษ');
  assert.equal(JSON.parse(p.option_groups).length, 1);
  assert.ok(await db.get("SELECT id FROM categories WHERE name = 'เมนูใหม่'"));
  assert.ok(await db.get("SELECT id FROM stations WHERE name = 'ครัวพิเศษ'"));
  assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM barcodes WHERE product_id = ?", [p.id])).n), 2);
  assert.equal((await db.get("SELECT price FROM products WHERE code = 'R001'")).price, 8500);
  const cashier = await S.login('0002', '2222');
  assert.equal((await S.call('POST', '/api/import/products', { csv }, { token: cashier })).status, 403);
});

test('ตัวช่วยลิงก์ Google Sheet / Drive และ CSV parser', () => {
  assert.equal(sheetCsvUrl('https://docs.google.com/spreadsheets/d/ABC_123/edit#gid=456'), 'https://docs.google.com/spreadsheets/d/ABC_123/export?format=csv&gid=456');
  assert.equal(directImageUrl('https://drive.google.com/file/d/XYZ/view?usp=sharing'), 'https://drive.google.com/uc?export=download&id=XYZ');
  assert.deepEqual(parseCsv('a,"b ""q"", c"\r\n1,2'), [['a', 'b "q", c'], ['1', '2']]);
});

test('คีย์ Beam: ร้านกรอกเองได้ เก็บฝั่งเซิร์ฟเวอร์ ไม่ส่งกลับไปที่เบราว์เซอร์', async () => {
  await S.call('PUT', '/api/payments/providers/beam', { merchant_id: 'merchant-1', api_key: 'sk_live_SECRET_123', webhook_secret: 'aGVsbG8=' }, { token: owner });
  const g = (await S.call('GET', '/api/payments/providers/beam', undefined, { token: owner })).body;
  assert.equal(g.merchant_id, 'merchant-1');
  assert.equal(g.api_key_set, true);
  assert.ok(!JSON.stringify(g).includes('SECRET_123'));
  const all = JSON.stringify((await S.call('GET', '/api/settings', undefined, { token: owner })).body) + JSON.stringify((await S.call('GET', '/api/settings/public')).body);
  assert.ok(!all.includes('SECRET_123') && !all.includes('aGVsbG8='));
  const { GATEWAYS } = await import('../server/lib/gateways.js');
  assert.equal(await GATEWAYS.beam.configured(), true);
  const crypto = await import('node:crypto');
  const raw = Buffer.from('{"id":"pl_1"}');
  const sig = crypto.createHmac('sha256', Buffer.from('aGVsbG8=', 'base64')).update(raw).digest('base64');
  assert.equal(await GATEWAYS.beam.verifyWebhook(raw, { 'x-beam-signature': sig }), true);
  assert.equal(await GATEWAYS.beam.verifyWebhook(raw, { 'x-beam-signature': 'bad' }), false);
  const cashier = await S.login('0002', '2222');
  assert.equal((await S.call('GET', '/api/payments/providers/beam', undefined, { token: cashier })).status, 403);
  await S.call('PUT', '/api/payments/providers/beam', { api_key: '' }, { token: owner });
  assert.equal((await S.call('GET', '/api/payments/providers/beam', undefined, { token: owner })).body.api_key_set, true, 'เว้นว่าง = ใช้คีย์เดิม');
});
