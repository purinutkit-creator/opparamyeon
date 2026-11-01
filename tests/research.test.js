import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from './helpers.js';

// a stand-in for the Claude API: web search turn (paused once, then resumed), then the JSON options
const calls = []; let mock, S, owner;
before(async () => {
  mock = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
    const body = JSON.parse(b || '{}'); calls.push(body);
    const msg = (content, stop) => res.end(JSON.stringify({ id: 'm' + calls.length, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stop, usage: { input_tokens: 1, output_tokens: 1 } }));
    res.setHeader('content-type', 'application/json');
    if (body.tools) {
      const resumed = body.messages.length > 1;
      if (!resumed) return msg([{ type: 'server_tool_use', id: 'st1', name: 'web_search', input: { query: 'samyang buldak carbonara' } }], 'pause_turn');
      return msg([{ type: 'web_search_tool_result', tool_use_id: 'st1', content: [{ type: 'web_search_result', title: 'Samyang Buldak Carbonara 130g', url: 'https://example.com/buldak', encrypted_content: 'x' }] },
        { type: 'text', text: 'บะหมี่ซัมยัง บูลดัก คาโบนาร่า 130 กรัม จากเกาหลี เผ็ดระดับ 2,600 SHU ครีมชีส' }], 'end_turn');
    }
    return msg([{ type: 'text', text: JSON.stringify({ found: true, summary_th: 'บะหมี่ซัมยังรสคาโบนาร่า', descriptions: [{ style: 'สั้นกระชับ', text: 'บะหมี่เผ็ดครีมชีส' }, { style: 'ชวนกิน', text: 'เผ็ดนัว ครีมมี่' }, { style: 'ให้ข้อมูล', text: '130 กรัม จากเกาหลี' }, { style: 'จอลูกค้า', text: 'เผ็ดกำลังดี' }],
      highlights: ['ซอสครีมชีส', 'เผ็ดกลาง', 'นำเข้าจากเกาหลี'], spice_level: 7, spice_reason: 'ประมาณ 2,600 SHU', facts: [{ label: 'น้ำหนัก', value: '130 กรัม' }] }) }], 'end_turn');
  }); });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${mock.address().port}`;
  S = await startServer(); owner = await S.login();
});
after(async () => { await S.close(); mock.close(); delete process.env.ANTHROPIC_BASE_URL; });

test('ค้นหาข้อมูลสินค้า: ค้นเว็บ (ค้นต่อเมื่อหยุดกลางทาง) แล้วได้ตัวเลือกคำอธิบาย สรรพคุณ ความเผ็ด แหล่งข้อมูล', async () => {
  let r = await S.call('POST', '/api/products/research', { name: 'Samyang Buldak Carbonara' }, { token: owner });
  assert.equal(r.status, 400); assert.match(r.body.error, /API Key/);
  await S.call('PUT', '/api/assistant/config', { anthropic_api_key: 'sk-ant-test-1234' }, { token: owner });
  const cashier = await S.login('0002', '2222');
  assert.equal((await S.call('POST', '/api/products/research', { name: 'x' }, { token: cashier })).status, 403);
  r = await S.call('POST', '/api/products/research', { name: 'Samyang Buldak Carbonara', category_id: 'c_ramyeon' }, { token: owner });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.descriptions.length, 4);
  assert.deepEqual(r.body.highlights, ['ซอสครีมชีส', 'เผ็ดกลาง', 'นำเข้าจากเกาหลี']);
  assert.equal(r.body.spice_level, 5, 'ความเผ็ดอยู่ใน 0–5');
  assert.deepEqual(r.body.sources, [{ title: 'Samyang Buldak Carbonara 130g', url: 'https://example.com/buldak' }]);
  const search = calls.filter((c) => c.tools);
  assert.equal(search.length, 2, 'ค้นต่อหลัง pause_turn');
  assert.equal(search[0].tools[0].type, 'web_search_20260209');
  assert.equal(search[1].messages.at(-1).role, 'assistant', 'ส่งคำตอบเดิมกลับไปให้ค้นต่อ ไม่เพิ่มข้อความผู้ใช้');
  const fmt = calls.at(-1);
  assert.equal(fmt.tools, undefined, 'ขั้นจัดรูปแบบไม่ใช้เครื่องมือ');
  assert.equal(fmt.output_config.format.type, 'json_schema');
  assert.match(JSON.stringify(fmt.messages), /2,600 SHU/, 'ใช้ผลค้นในการเขียนตัวเลือก');
  await S.call('PUT', '/api/assistant/config', { clear: ['anthropic_api_key'] }, { token: owner });
});
