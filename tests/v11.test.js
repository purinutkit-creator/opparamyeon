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

test('ใบ QR ชำระเงิน: พิมพ์ QR พร้อมเพย์ + ยอดเงิน, อัตโนมัติเมื่อไม่มีจอลูกค้าและไม่ซ้ำ, ปิดได้', async () => {
  await S.call('PUT', '/api/settings/payment', { value: { promptpay_id: '0812345678', promptpay_name: 'ร้านออปป้า' } }, { token: owner });
  const r = await S.call('POST', '/api/print/payqr', { amount: 15800 }, { token: owner, terminal: 'pos1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.printed, true);
  const job = await db.get('SELECT doc_type, payload FROM print_jobs WHERE id = ?', [r.body.jobs[0].id || r.body.jobs[0]]);
  assert.equal(job.doc_type, 'payqr');
  const d = JSON.parse(job.payload).data;
  assert.equal(d.pay_amount, '158.00 บาท');
  assert.match(d.pay_qr, /5406158\.00/, 'ยอดเงินฝังใน QR');
  assert.match(d.promptpay_masked, /5678$/);
  assert.ok(!d.promptpay_masked.includes('081234'), 'เลขพร้อมเพย์ถูกปิดบางส่วน');
  const auto1 = await S.call('POST', '/api/print/payqr', { amount: 9900, auto: true, ref: 'cart-q1' }, { token: owner, terminal: 'pos1' });
  assert.equal(auto1.body.printed, true, 'ไม่มีจอลูกค้า → พิมพ์อัตโนมัติ');
  const auto2 = await S.call('POST', '/api/print/payqr', { amount: 9900, auto: true, ref: 'cart-q1' }, { token: owner, terminal: 'pos1' });
  assert.equal(auto2.body.printed, false, 'ยอดเดิมบิลเดิมไม่พิมพ์ซ้ำ');
  await S.call('PUT', '/api/settings/print', { value: { payqr_auto: 'off' } }, { token: owner });
  const off = await S.call('POST', '/api/print/payqr', { amount: 5000, auto: true, ref: 'cart-q2' }, { token: owner, terminal: 'pos1' });
  assert.equal(off.body.skipped, true);
  const manual = await S.call('POST', '/api/print/payqr', { amount: 5000 }, { token: owner, terminal: 'pos1' });
  assert.equal(manual.body.printed, true, 'กดพิมพ์เองได้เสมอ');
  await S.call('PUT', '/api/settings/print', { value: { payqr_auto: 'no_display' } }, { token: owner });
  assert.equal((await S.call('POST', '/api/print/payqr', { amount: 0 }, { token: owner, terminal: 'pos1' })).status, 400);
});

test('Add-on พิเศษ: เปิดที่สินค้าแล้ว POS ได้รับค่าแสดงตัวเลือกปุ่มใหญ่', async () => {
  const cat = (await S.call('GET', '/api/catalog?all=1', undefined, { token: owner })).body;
  const p = cat.products.find((x) => x.option_groups.length);
  assert.equal(p.big_options, false);
  const u = await S.call('PUT', '/api/products/' + p.id, { ...p, big_options: true }, { token: owner });
  assert.equal(u.status, 200, JSON.stringify(u.body));
  const again = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body.products.find((x) => x.id === p.id);
  assert.equal(again.big_options, true);
  assert.deepEqual(again.option_groups, p.option_groups, 'ตัวเลือกเดิมไม่เปลี่ยน');
});

test('พิมพ์บาร์โค้ดสินค้า: บันทึกการตั้งค่าฉลาก, สร้าง EAN-13 ให้สินค้าที่ไม่มี, ส่งงานพิมพ์ด้วยราคาจากฐานข้อมูล', async () => {
  const { isEan13, ean13 } = await import('../public/shared/core.js');
  assert.equal(isEan13('4006381333931'), true);
  assert.equal(ean13('4006381333931').reduce((a, b) => a + b, 0), 95, 'EAN-13 มี 95 โมดูล');
  const cfg = await S.call('PUT', '/api/labels/config', { value: { width_mm: 40, height_mm: 30, font: 'Sarabun', show_code: true, hacker: 'x' } }, { token: owner });
  assert.equal(cfg.status, 200);
  assert.equal(cfg.body.width_mm, 40);
  assert.equal(cfg.body.hacker, undefined, 'รับเฉพาะค่าที่รู้จัก');
  // a product without barcode gets an in-store EAN-13
  const np = await S.call('POST', '/api/products', { code: 'LBL1', name: 'ฉลากทดสอบ', price: 2500 }, { token: owner });
  const gen = await S.call('POST', '/api/products/barcodes/generate', { product_ids: [np.body.id, 'p_r001'] }, { token: owner });
  assert.equal(gen.body.created.length, 1, 'สร้างเฉพาะสินค้าที่ยังไม่มีบาร์โค้ด');
  const code = gen.body.created[0].barcode;
  assert.ok(isEan13(code) && code.startsWith('20'), code);
  const found = await S.call('GET', '/api/barcode/' + code, undefined, { token: owner });
  assert.equal(found.body.product_id, np.body.id, 'สแกนบาร์โค้ดใหม่แล้วเจอสินค้า');
  const r = await S.call('POST', '/api/print/labels', { printer_id: printer, items: [{ product_id: np.body.id, qty: 3 }, { product_id: 'p_r001', qty: 2 }], cfg: { cols: 2, width_mm: 34, price: 1 } }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, 5);
  const job = await db.get('SELECT doc_type, payload FROM print_jobs WHERE id = ?', [r.body.jobs[0].id]);
  assert.equal(job.doc_type, 'label');
  const tpl = JSON.parse(job.payload).template;
  const rows = tpl.elements.filter((e) => e.type === 'label');
  assert.equal(rows.length, 3, '5 ดวง 2 ดวงต่อแถว = 3 แถว');
  assert.equal(rows[0].items[0].price, 2500, 'ราคาจากฐานข้อมูล');
  assert.equal(rows[0].items[0].barcode, code);
  assert.equal(rows[0].cfg.width_mm, 34);
  assert.equal(rows[0].cfg.height_mm, 30, 'ค่าที่บันทึกไว้ใช้ต่อ');
  const tooWide = await S.call('POST', '/api/print/labels', { printer_id: printer, items: [{ product_id: 'p_r001', qty: 1 }], cfg: { cols: 4, width_mm: 50 } }, { token: owner });
  assert.equal(tooWide.status, 400, 'ฉลากกว้างเกินกระดาษ');
  const cashierTok = await S.login('0002', '2222', 'pos1');
  assert.equal((await S.call('POST', '/api/print/labels', { printer_id: printer, items: [{ product_id: 'p_r001', qty: 1 }] }, { token: cashierTok })).status, 403);
});

test('Add-on: ท็อปปิ้ง (กลุ่มไม่บังคับ) ถูกระบุเป็น add-on ในใบครัวและใบเสร็จ ส่วนตัวเลือกบังคับเป็น choice; ธีมบันทึกและส่งถึงทุกหน้า', async () => {
  const o = await sell([line('p_r001', 1, { options: [...ramyeonOpts, { group_id: 'og_add', id: 'a_cheese' }] })]);
  const rc = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt'", [o.id])).payload).data;
  const opts = rc.items[0].options;
  assert.equal(opts.find((x) => x.id === 'a_cheese').addon, true);
  assert.equal(opts.find((x) => x.id === 'n_shin').addon, false);
  assert.equal(opts.find((x) => x.id === 'n_shin').group, 'ชนิดเส้น');
  const kt = await db.get('SELECT content FROM kitchen_tickets WHERE order_id = ?', [o.id]);
  const kopts = JSON.parse(kt.content).lines[0].options;
  assert.deepEqual(kopts.filter((x) => x.addon).map((x) => x.name), ['ชีส']);
  assert.ok(kopts.some((x) => !x.addon && x.group === 'ระดับความเผ็ด'));
  // theme
  const th = await S.call('PUT', '/api/settings/theme', { value: { preset: 'matcha', mode: 'dark', radius: 'square', pos_layout: 'list' } }, { token: owner });
  assert.equal(th.status, 200);
  const pub = (await S.call('GET', '/api/settings/public')).body;
  assert.equal(pub.theme.preset, 'matcha');
  assert.equal(pub.theme.pos_layout, 'list');
  assert.equal((await S.call('GET', '/api/c/config')).body.theme.radius, 'square');
  const { themeVars } = await import('../public/shared/theme.js');
  const v = themeVars({ preset: 'custom', brand: '#123456' }, 'dark');
  assert.equal(v['--brand-rgb'], '18 52 86');
  assert.ok(v['--bg'] && v['--grad'].includes('linear-gradient'));
});
