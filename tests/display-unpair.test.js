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
