import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' }); });
after(async () => { await S.close(); });

test('พิมพ์ใบครัวซ้ำได้กี่ครั้งก็ได้ (ทั้งบิลหรือทีละใบ) และประวัติบิลในหน้าขาย', async () => {
  const pr = (await S.call('POST', '/api/printers', { name: 'ครัว', conn: 'lan', address: '10.0.0.77', port: 9100, paper: 80, roles: ['kitchen', 'receipt'] }, { token: owner })).body.id;
  const egg = await db.get("SELECT id, price FROM products WHERE code = 'T001'");
  const o = (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { customer_name: 'สมหญิง', lines: [line('p_d001', 1), line(egg.id, 1)] }, payments: [{ method: 'cash', amount: 1e6, received: 1e6 }] }, { token: owner, terminal: 'pos1' })).body;
  const kjobs = async () => (await db.all("SELECT j.payload, j.dedupe_key FROM print_jobs j JOIN kitchen_tickets k ON k.id = j.ref_id WHERE k.order_id = ? AND j.doc_type = 'kitchen' AND j.printer_id = ?", [o.id, pr]));
  const before = (await kjobs()).length;
  assert.ok(before >= 1, 'มีใบครัวตอนชำระ');
  for (let i = 0; i < 3; i++) {
    const r = await S.call('POST', `/api/orders/${o.id}/print`, { doc: 'kitchen' }, { token: owner, terminal: 'pos1' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  const after3 = await kjobs();
  assert.equal(after3.length, before * 4, 'พิมพ์ซ้ำ 3 รอบ ได้ครบทุกใบทุกรอบ');
  assert.ok(after3.filter((j) => String(j.dedupe_key).startsWith('reprint:')).every((j) => JSON.parse(j.payload).data.reprint), 'ทำเครื่องหมายว่าเป็นสำเนา');
  // one ticket only
  const t = await db.get("SELECT id FROM kitchen_tickets WHERE order_id = ? ORDER BY created_at LIMIT 1", [o.id]);
  const one = await S.call('POST', `/api/orders/${o.id}/print`, { doc: 'kitchen', ticket_id: t.id }, { token: owner, terminal: 'pos1' });
  assert.equal(one.body.tickets, 1);
  // kitchen staff can't reprint
  const kitchen = await S.login('0003', '3333');
  assert.equal((await S.call('POST', `/api/orders/${o.id}/print`, { doc: 'kitchen' }, { token: kitchen })).status, 403);
  // bill history: today's bills, search by customer / bill no
  const h = (await S.call('GET', '/api/orders/history', undefined, { token: owner, terminal: 'pos1' })).body;
  assert.ok(h.rows.some((x) => x.id === o.id && x.tickets >= 1));
  assert.ok(h.summary.bills >= 1 && h.summary.total > 0);
  const s1 = (await S.call('GET', '/api/orders/history?q=' + encodeURIComponent('สมหญิง'), undefined, { token: owner, terminal: 'pos1' })).body;
  assert.deepEqual(s1.rows.map((x) => x.id), [o.id]);
  const s2 = (await S.call('GET', '/api/orders/history?q=' + o.bill_no.toLowerCase(), undefined, { token: owner, terminal: 'pos1' })).body;
  assert.equal(s2.rows[0].id, o.id);
  assert.equal((await S.call('GET', '/api/orders/history?date=2001-01-01', undefined, { token: owner, terminal: 'pos1' })).body.rows.length, 0);
});
