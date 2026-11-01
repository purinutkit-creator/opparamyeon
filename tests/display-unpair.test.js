import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); });
after(async () => { await S.close(); });

test('จอลูกค้าออกจากการเชื่อมต่อเองได้ (แตะ 7 ครั้ง) แล้ว token ใช้ไม่ได้อีก', async () => {
  const { code } = (await S.call('POST', '/api/display/pairing', { mode: 'link' }, { token: owner, terminal: 'pos1' })).body;
  const { token } = (await S.call('POST', '/api/display/pair', { code })).body;
  assert.equal((await S.call('GET', '/api/display/me', undefined, { token })).status, 200);
  assert.equal((await S.call('POST', '/api/display/unpair', {})).status, 403, 'ต้องเป็นจอที่จับคู่อยู่');
  assert.equal((await S.call('POST', '/api/display/unpair', {}, { token })).status, 200);
  assert.equal((await S.call('GET', '/api/display/me', undefined, { token })).status, 403, 'ถูกยกเลิกแล้ว');
  const list = (await S.call('GET', '/api/display/pairings', undefined, { token: owner })).body;
  assert.equal(list[0].revoked, 1);
});

test('จอลูกค้าที่มีเครื่องพิมพ์: ใช้ token จอ ดึงรายชื่อเครื่องพิมพ์/รับงานพิมพ์ได้ แต่ทำอย่างอื่นไม่ได้ · ปิดรายละเอียดสินค้าได้', async () => {
  const { code } = (await S.call('POST', '/api/display/pairing', { mode: 'link' }, { token: owner, terminal: 'pos1' })).body;
  const { token } = (await S.call('POST', '/api/display/pair', { code })).body;
  const pr = (await S.call('POST', '/api/printers', { name: 'ข้างจอลูกค้า', conn: 'usb', paper: 58, roles: ['receipt'] }, { token: owner })).body;
  assert.equal((await S.call('GET', '/api/printers', undefined, { token })).status, 200);
  await S.call('POST', '/api/printers/' + pr.id + '/test', {}, { token: owner }).catch(() => {});
  const c = await S.call('POST', '/api/print/claim', { printer_id: pr.id, host: 'display:x' }, { token });
  assert.equal(c.status, 200);
  if (c.body && c.body.id) assert.equal((await S.call('POST', `/api/print/jobs/${c.body.id}/report`, { status: 'printed' }, { token })).status, 200);
  assert.equal((await S.call('POST', '/api/printers/' + pr.id + '/status', { status: 'ok' }, { token })).status, 200);
  for (const [m, u] of [['GET', '/api/catalog'], ['GET', '/api/settings'], ['POST', '/api/printers'], ['GET', '/api/print/jobs']]) assert.equal((await S.call(m, u, m === 'POST' ? {} : undefined, { token })).status, 401, u);
  // shop switches for the customer display
  await S.call('PUT', '/api/settings/display', { value: { product_details: false, latest_card: false } }, { token: owner });
  const pub = (await S.call('GET', '/api/settings/public')).body.display;
  assert.equal(pub.product_details, false); assert.equal(pub.latest_card, false);
  await S.call('PUT', '/api/settings/display', { value: { product_details: true, latest_card: true } }, { token: owner });
});
