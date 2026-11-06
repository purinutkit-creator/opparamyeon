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
    const out = { items: items.map((it) => ({ k: it.k, en: tr(it, 'EN:'), zh: tr(it, 'ZH:') })) };
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
    while (left && guard++ < 20) { const r = await S.call('POST', '/api/translations/ai', { size: 10 }, { token: owner }); assert.equal(r.status, 200, JSON.stringify(r.body)); left = r.body.remaining; }
    assert.equal(left, 0); assert.ok(calls >= 2, 'แบ่งเป็นหลายรอบ');
    const egg = await db.get("SELECT id, name FROM products WHERE code = 'T001'");
    let cat = (await S.call('GET', '/api/catalog', undefined, { token: owner })).body;
    assert.equal(cat.translations.product[egg.id].en.name, 'EN:' + egg.name);
    assert.equal(cat.translations.product[egg.id].zh.name, 'ZH:' + egg.name);
    assert.ok(Object.keys(cat.translations.spice).length === 6);
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
