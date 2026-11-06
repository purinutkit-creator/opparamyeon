import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); });
after(async () => { await S.close(); });

test('แปลชื่อเมนู/ตัวเลือก/ประเทศ/ระดับเผ็ดเป็น EN/中文 ด้วย AI · แก้ชื่อไทยแล้วต้องแปลใหม่ · แก้คำแปลเองได้', async () => {
  const http = await import('node:http');
  let calls = 0;
  const mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    calls++;
    const body = JSON.parse(b);
    const text = body.messages[0].content;
    const items = JSON.parse(text.slice(text.lastIndexOf('\n[') + 1));
    const tr = (it, p) => ({ name: p + it.name, description: it.description ? p + it.description : '', highlights: it.highlights ? p + it.highlights : '', topic: it.topic ? p + it.topic : '', rename_to: it.rename_to ? p + it.rename_to : '' });
    const out = { items: items.map((it) => ({ k: it.k, en: tr(it, 'EN:'), zh: tr(it, 'ZH:'), ja: tr(it, 'JA:'), ko: tr(it, 'KO:') })) };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text: JSON.stringify(out) }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  try {
    await S.call('PUT', '/api/assistant/config', { anthropic_api_key: 'sk-ant-test-1234' }, { token: owner });
    let d = (await S.call('GET', '/api/translations', undefined, { token: owner })).body;
    assert.ok(d.status.total > 0 && d.status.missing === d.status.total, JSON.stringify(d.status));
    assert.ok(d.items.some((x) => x.kind === 'spice') && d.items.some((x) => x.kind === 'option'));
    let left = d.status.missing, guard = 0;
    while (left && guard++ < 40) { const r = await S.call('POST', '/api/translations/ai', { size: 40 }, { token: owner }); assert.equal(r.status, 200, JSON.stringify(r.body)); left = r.body.remaining; }
    assert.equal(left, 0); assert.ok(calls >= 2, 'แบ่งเป็นหลายรอบ');
    const egg = await db.get("SELECT id, name FROM products WHERE code = 'T001'");
    let cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body;
    assert.equal(cat.translations.product[egg.id].en.name, 'EN:' + egg.name);
    assert.equal(cat.translations.product[egg.id].zh.name, 'ZH:' + egg.name);
    assert.ok(Object.keys(cat.translations.spice).length === 6);
    assert.equal(cat.translations.product[egg.id].ko.name, 'KO:' + egg.name);
    // customer pages: interface text in one language
    const ja = (await S.call('GET', '/api/public/i18n/ja')).body;
    assert.equal(ja['ตะกร้า'], 'JA:ตะกร้า');
    assert.equal(ja['รวมสินค้า'], 'JA:รวมสินค้า', 'คำบนใบเสร็จ');
    assert.deepEqual((await S.call('GET', '/api/public/i18n/xx')).body, {});
    // receipt in the customer's language, merchant slip in Thai
    await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
    const P = (await S.call('GET', '/api/settings', undefined, { token: owner })).body.print;
    await S.call('PUT', '/api/settings/print', { value: { ...P, auto_merchant: true, auto_receipt: true } }, { token: owner });
    const { key, line } = await import('./helpers.js');
    const pr = (await S.call('POST', '/api/printers', { name: 'R', conn: 'lan', address: '10.9.9.9', port: 9100, paper: 80, roles: ['receipt', 'merchant'] }, { token: owner })).body.id;
    const o = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lang: 'ja', lines: [line(egg.id, 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { receipt: true, merchant: true } }, { token: owner, terminal: 'pos1' })).body;
    assert.equal(o.lang, 'ja');
    const rec = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt' AND printer_id = ?", [o.id, pr])).payload).data;
    const mer = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'merchant' AND printer_id = ?", [o.id, pr])).payload).data;
    // the Thai name changed above, so Japanese is missing for it: give it one and print again
    await S.call('PUT', '/api/translations', { kind: 'product', ref: egg.id, lang: 'ja', data: { name: '温泉卵', description: '', highlights: '' } }, { token: owner });
    const o2 = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lang: 'ja', lines: [line(egg.id, 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }], print: { receipt: true } }, { token: owner, terminal: 'pos1' })).body;
    const rec2 = JSON.parse((await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt' AND printer_id = ?", [o2.id, pr])).payload).data;
    assert.equal(rec2.items[0].name, '温泉卵');
    assert.equal(rec.payments[0].method, 'JA:เงินสด');
    assert.equal(rec.i18n['ยอดสุทธิ'], 'JA:ยอดสุทธิ');
    assert.equal(mer.i18n, undefined, 'ใบสรุปร้านค้าภาษาไทย');
    assert.equal(mer.payments[0].method, 'เงินสด');
    await S.call('PUT', '/api/settings/print', { value: P }, { token: owner });
    // renamed in Thai → the old translation no longer shows, and it counts as missing again
    await db.run('UPDATE products SET name = ? WHERE id = ?', [egg.name + ' ใหม่', egg.id]);
    cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body;
    assert.equal(cat.translations.product[egg.id], undefined);
    assert.equal((await S.call('GET', '/api/translations', undefined, { token: owner })).body.status.missing, 1);
    // the shop writes it by hand
    assert.equal((await S.call('PUT', '/api/translations', { kind: 'product', ref: egg.id, lang: 'en', data: { name: 'Onsen egg', description: '', highlights: '' } }, { token: owner })).status, 200);
    cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body;
    assert.equal(cat.translations.product[egg.id].en.name, 'Onsen egg');
    assert.equal((await S.call('PUT', '/api/translations', { kind: 'product', ref: egg.id, lang: 'fr', data: { name: 'x' } }, { token: owner })).status, 400);
    const kitchen = await S.login('0003', '3333');
    assert.equal((await S.call('POST', '/api/translations/ai', {}, { token: kitchen })).status, 403);
  } finally {
    await S.call('PUT', '/api/assistant/config', { clear: ['anthropic_api_key'] }, { token: owner });
    delete process.env.ANTHROPIC_BASE_URL; mock.close();
  }
});
