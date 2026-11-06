import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });

test('เลขคิวถัดไป (โชว์บนจอลูกค้าระหว่างขาย) ตรงกับเลขที่ได้จริงตอนชำระ และไม่กินเลขคิว', async () => {
  const peek = async (dine) => (await S.call('GET', '/api/queue/peek?dine=' + dine, undefined, { token: owner, terminal: 'pos1' })).body.queue_no;
  const a = await peek('takeaway');
  assert.ok(a, 'มีเลขคิว');
  assert.equal(await peek('takeaway'), a, 'ดูซ้ำไม่กินเลข');
  const egg = await db.get("SELECT id, price FROM products WHERE code = 'T001'");
  const r = await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { dine_type: 'takeaway', lines: [{ ...line(egg.id, 1), dine_type: 'takeaway' }] }, payments: [{ method: 'cash', amount: egg.price, received: egg.price }] }, { token: owner, terminal: 'pos1' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.queue_no, a);
  assert.notEqual(await peek('takeaway'), a, 'บิลถัดไปได้เลขใหม่');
});
