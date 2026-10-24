import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, key, line, ramyeonOpts } from './helpers.js';
import { db } from '../server/db.js';

let S, owner;
before(async () => {
  S = await startServer();
  owner = await S.login();
  await S.call('POST', '/api/shifts/open', { opening_cash: 0 }, { token: owner, terminal: 'pos1' });
  await S.call('PUT', '/api/settings/members', { value: { sensitive_verify: 'staff' } }, { token: owner });
  await S.call('POST', '/api/printers', { name: 'P', conn: 'usb', paper: 80, roles: ['receipt', 'redeem'] }, { token: owner });
});
after(async () => { await S.close(); });

const sell = async (lines, cart = {}) => (await S.call('POST', '/api/orders/checkout', { idempotency_key: key(), cart: { lines, ...cart }, payments: [{ method: 'cash', amount: 1e7, received: 1e7 }] }, { token: owner, terminal: 'pos1' })).body;
const MT = (t) => ({ token: t });
async function staffVerify(mtoken, purpose) {
  const v = (await S.call('POST', '/api/c/verify/start', { purpose }, MT(mtoken))).body;
  assert.equal(v.method, 'staff');
  const ok = await S.call('POST', '/api/verifications/' + v.id, { approve: true, code: v.code }, { token: owner });
  assert.equal(ok.body.ok, true);
  return v.id;
}

test('สมัครผ่านเว็บ: รหัสเริ่มต้น 4 ตัวท้าย (มีศูนย์นำหน้า), ตรวจเบอร์ซ้ำ, ไม่บังคับเปลี่ยนรหัส', async () => {
  const reg = await S.call('POST', '/api/c/register', { phone: '081-000-0012', first_name: 'จีซู' });
  assert.equal(reg.status, 200, JSON.stringify(reg.body));
  const dup = await S.call('POST', '/api/c/register', { phone: '+66810000012', first_name: 'ซ้ำ' });
  assert.equal(dup.status, 409);
  const login = await S.call('POST', '/api/c/login', { phone: '0810000012', password: '0012' });
  assert.equal(login.status, 200);
  assert.equal(login.body.password_is_default, true);
  const me = await S.call('GET', '/api/c/me', undefined, MT(login.body.token));
  assert.equal(me.status, 200, 'ใช้งานได้โดยไม่ต้องเปลี่ยนรหัส');
  const wrong = await S.call('POST', '/api/c/login', { phone: '0810000012', password: '12' });
  assert.equal(wrong.status, 401);
  const row = await db.get("SELECT password_hash FROM members WHERE phone = '0810000012'");
  assert.ok(row.password_hash.startsWith('scrypt$') && !row.password_hash.includes('0012'), 'เก็บเป็นแฮช');
});

test('จำกัดการลองรหัสผิด', async () => {
  await S.call('POST', '/api/c/register', { phone: '0820000001', first_name: 'A' });
  for (let i = 0; i < 5; i++) await S.call('POST', '/api/c/login', { phone: '0820000001', password: 'bad' });
  const locked = await S.call('POST', '/api/c/login', { phone: '0820000001', password: '0001' });
  assert.equal(locked.status, 429);
});

test('เปิด/ปิดการสมัคร: ปิดแล้วสมาชิกเดิมยังเข้าได้', async () => {
  await S.call('PUT', '/api/settings/members', { value: { web_signup: false } }, { token: owner });
  assert.equal((await S.call('POST', '/api/c/register', { phone: '0830000001', first_name: 'B' })).status, 403);
  assert.equal((await S.call('POST', '/api/c/login', { phone: '0810000012', password: '0012' })).status, 200);
  await S.call('PUT', '/api/settings/members', { value: { web_signup: true } }, { token: owner });
});

test('สะสมแต้มย้อนหลังจาก QR ใบเสร็จ: ครั้งเดียวต่อบิล แม้ยืนยันพร้อมกันหลายอุปกรณ์', async () => {
  const o = await sell([line('p_r002', 2, { options: ramyeonOpts })]); // 198 บาท → 7 แต้ม
  assert.equal(o.claim_status, 'available');
  assert.ok(o.claim_token.length >= 20, 'โทเคนคาดเดาไม่ได้');
  const receipt = await db.get("SELECT payload FROM print_jobs WHERE ref_id = ? AND doc_type = 'receipt'", [o.id]);
  assert.match(JSON.parse(receipt.payload).data.claim_url, new RegExp(o.claim_token));
  const prev = (await S.call('GET', '/api/c/claim/' + o.claim_token)).body;
  assert.equal(prev.claimable, true);
  assert.equal(prev.points, 7);
  assert.ok(prev.deadline);
  // new customer signs up from the QR, then claims
  const reg = (await S.call('POST', '/api/c/register', { phone: '0840000004', first_name: 'ลิซ่า' })).body;
  const reg2 = (await S.call('POST', '/api/c/register', { phone: '0840000005', first_name: 'โรเซ่' })).body;
  // shop can require verification for claims; by default scanning claims immediately (see next test)
  await S.call('PUT', '/api/settings/members', { value: { claim_verify: 'staff' } }, { token: owner });
  const noVerify = await S.call('POST', '/api/c/claim/' + o.claim_token, {}, MT(reg.token));
  assert.equal(noVerify.status, 428, 'ตั้งให้ยืนยันแล้วต้องยืนยันก่อน');
  const v1 = await staffVerify(reg.token, 'claim');
  const v2 = await staffVerify(reg2.token, 'claim');
  const [a, b] = await Promise.all([
    S.call('POST', '/api/c/claim/' + o.claim_token, { verification_id: v1 }, MT(reg.token)),
    S.call('POST', '/api/c/claim/' + o.claim_token, { verification_id: v2 }, MT(reg2.token)),
  ]);
  assert.equal([a, b].filter((x) => x.status === 200).length, 1, JSON.stringify([a.body, b.body]));
  const winner = a.status === 200 ? reg : reg2;
  const me = (await S.call('GET', '/api/c/me', undefined, MT(winner.token))).body;
  assert.equal(me.points, 7);
  const again = await S.call('GET', '/api/c/claim/' + o.claim_token);
  assert.equal(again.body.claimable, false);
  const ord = (await S.call('GET', '/api/orders/' + o.id, undefined, { token: owner })).body;
  assert.equal(ord.claim_status, 'claimed');
  assert.equal(ord.member.id, me.id);
  // reprint keeps the same claim token
  const rp = await S.call('POST', `/api/orders/${o.id}/print`, { doc: 'receipt' }, { token: owner });
  const job = await db.get('SELECT payload FROM print_jobs WHERE id = ?', [rp.body.job_id]);
  assert.match(JSON.parse(job.payload).data.claim_url, new RegExp(o.claim_token));
});

test('ค่าเริ่มต้น: สแกน QR ใบเสร็จแล้วรับแต้มได้ทันทีโดยไม่ต้องใส่รหัส แต่การแลกรางวัลยังต้องยืนยัน', async () => {
  await S.call('PUT', '/api/settings/members', { value: { claim_verify: 'none' } }, { token: owner });
  const o = await sell([line('p_d001', 2)]);
  const reg = (await S.call('POST', '/api/c/register', { phone: '0890000099', first_name: 'แบม' })).body;
  const r = await S.call('POST', '/api/c/claim/' + o.claim_token, {}, MT(reg.token));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.points, 3);
  assert.equal((await S.call('POST', '/api/c/claim/' + o.claim_token, {}, MT(reg.token))).status, 409, 'ยังรับได้ครั้งเดียว');
  await S.call('POST', `/api/members/${reg.member.id}/points`, { delta: 50, reason: 'test' }, { token: owner });
  assert.equal((await S.call('POST', '/api/c/rewards/rw_egg/redeem', {}, MT(reg.token))).status, 428);
});

test('บิลยกเลิก/หมดเขต/ปิดฟังก์ชัน รับแต้มไม่ได้', async () => {
  const o = await sell([line('p_d001', 1)]);
  await S.call('POST', `/api/orders/${o.id}/void`, { reason: 'test' }, { token: owner, terminal: 'pos1' });
  assert.equal((await S.call('GET', '/api/c/claim/' + o.claim_token)).body.claimable, false);
  const o2 = await sell([line('p_d001', 1)]);
  await db.run('UPDATE orders SET paid_at = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', o2.id]);
  assert.match((await S.call('GET', '/api/c/claim/' + o2.claim_token)).body.reason, /เลยกำหนด/);
  await S.call('PUT', '/api/settings/points', { value: { claim_enabled: false } }, { token: owner });
  const o3 = await sell([line('p_d001', 1)]);
  assert.equal((await S.call('GET', '/api/c/claim/' + o3.claim_token)).body.claimable, false);
  await S.call('PUT', '/api/settings/points', { value: { claim_enabled: true, claim_qr: false } }, { token: owner });
  const o4 = await sell([line('p_d001', 1)]);
  assert.equal(o4.claim_token, null, 'ปิดการออก QR สำหรับบิลใหม่');
  await S.call('PUT', '/api/settings/points', { value: { claim_qr: true } }, { token: owner });
});

test('สมาชิกในบิลตั้งแต่ก่อนชำระ + คืนเงินแล้วปรับแต้ม', async () => {
  const m = (await S.call('POST', '/api/members', { phone: '0850000005', first_name: 'แจนนี่' }, { token: owner })).body;
  const o = await sell([line('p_r001', 2, { options: ramyeonOpts })], { member_id: m.id }); // 158 → 6 pts
  assert.equal(o.points_earned, 6);
  const item = o.items[0];
  await S.call('POST', `/api/orders/${o.id}/refund`, { items: [{ item_id: item.id, qty: 1 }], reason: 'คืน 1' }, { token: owner, terminal: 'pos1' });
  const mm = await db.get('SELECT points, total_spent FROM members WHERE id = ?', [m.id]);
  assert.equal(mm.points, 3, '79 บาท → 3 แต้ม');
  assert.equal(mm.total_spent, 7900);
  const led = await db.all("SELECT kind, delta FROM point_ledger WHERE member_id = ? ORDER BY created_at", [m.id]);
  assert.deepEqual(led.map((x) => x.kind), ['earn', 'refund']);
});

test('ลืมรหัสผ่าน: ไม่บอกว่าเบอร์มีบัญชีไหม, ถึงแอดมิน, รีเซ็ตหลังตรวจสอบตัวตน, ลิงก์ใช้ครั้งเดียว', async () => {
  const a = await S.call('POST', '/api/c/forgot', { phone: '0810000012' });
  const b = await S.call('POST', '/api/c/forgot', { phone: '0899999999' });
  assert.deepEqual(a.body, b.body);
  await S.call('POST', '/api/c/forgot', { phone: '0810000012' });
  const list = (await S.call('GET', '/api/password-resets', undefined, { token: owner })).body;
  const mine = list.filter((x) => x.phone === '0810000012');
  assert.equal(mine.length, 1, 'ไม่สร้างคำขอซ้ำ');
  assert.equal(mine[0].status, 'pending');
  const weak = await S.call('POST', '/api/password-resets/' + mine[0].id, { action: 'approve', reason: 'โทรถาม', verified_by: 'name' }, { token: owner });
  assert.equal(weak.status, 400, 'ห้ามรีเซ็ตจากการรู้ชื่อ/เบอร์อย่างเดียว');
  const ok = await S.call('POST', '/api/password-resets/' + mine[0].id, { action: 'approve', reason: 'ตรวจบัตรประชาชนที่ร้าน', verified_by: 'id_card' }, { token: owner });
  assert.ok(ok.body.reset_code);
  const old = (await S.call('POST', '/api/c/login', { phone: '0810000012', password: '0012' })).body.token;
  const reset = await S.call('POST', '/api/c/reset', { token: ok.body.reset_code, password: 'newpass99' });
  assert.equal(reset.status, 200);
  assert.equal((await S.call('POST', '/api/c/reset', { token: ok.body.reset_code, password: 'again123' })).status, 400, 'ใช้ลิงก์ซ้ำไม่ได้');
  assert.equal((await S.call('GET', '/api/c/me', undefined, MT(old))).status, 401, 'ยกเลิกเซสชันเดิม');
  assert.equal((await S.call('POST', '/api/c/login', { phone: '0810000012', password: 'newpass99' })).status, 200);
  const detail = (await S.call('GET', '/api/members/' + mine[0].member_id, undefined, { token: owner })).body;
  assert.ok(!JSON.stringify(detail).includes('password_hash'), 'แอดมินไม่เห็นรหัสผ่าน');
});

test('แลกรางวัล: สำรองแต้ม, คูปองใช้ได้ครั้งเดียวแม้สแกนพร้อมกัน, ตัดสต็อก, คืนแต้มเมื่อยกเลิก', async () => {
  const reg = (await S.call('POST', '/api/c/register', { phone: '0860000006', first_name: 'โจ' })).body;
  const mid = reg.member.id;
  await S.call('POST', `/api/members/${mid}/points`, { delta: 50, reason: 'โปรเปิดร้าน' }, { token: owner });
  const rewards = (await S.call('GET', '/api/c/rewards', undefined, MT(reg.token))).body;
  const egg = rewards.find((r) => r.id === 'rw_egg');
  assert.equal(egg.unavailable, null);
  assert.ok(rewards.find((r) => r.id === 'rw_ramyeon').unavailable, 'Tier ไม่ถึง');
  const v = await staffVerify(reg.token, 'redeem');
  const red = await S.call('POST', '/api/c/rewards/rw_egg/redeem', { verification_id: v }, MT(reg.token));
  assert.equal(red.status, 200, JSON.stringify(red.body));
  assert.ok(!red.body.code.includes('0860000006') && !red.body.code.includes(reg.member.member_no));
  let me = (await S.call('GET', '/api/c/me', undefined, MT(reg.token))).body;
  assert.equal(me.points, 30);
  assert.equal(me.reserved_points, 20);
  const stock0 = (await db.get("SELECT stock FROM ingredients WHERE id = 'i_egg'")).stock;
  const t2 = await S.login('0002', '2222');
  const [a, b] = await Promise.all([S.call('POST', `/api/coupons/${red.body.code}/redeem`, {}, { token: owner, terminal: 'pos1' }), S.call('POST', `/api/coupons/${red.body.code}/redeem`, {}, { token: t2, terminal: 'pos1' })]);
  assert.equal([a, b].filter((x) => x.status === 200).length, 1);
  assert.equal((await S.call('POST', `/api/coupons/${red.body.code}/redeem`, {}, { token: owner, terminal: 'pos1' })).status, 409);
  assert.equal((await db.get("SELECT stock FROM ingredients WHERE id = 'i_egg'")).stock, stock0 - 1);
  me = (await S.call('GET', '/api/c/me', undefined, MT(reg.token))).body;
  assert.equal(me.points, 30); assert.equal(me.reserved_points, 0);
  // cancel a second coupon → points back
  const v2 = await staffVerify(reg.token, 'redeem');
  const red2 = (await S.call('POST', '/api/c/rewards/rw_egg/redeem', { verification_id: v2 }, MT(reg.token))).body;
  await S.call('POST', `/api/c/coupons/${red2.id}/cancel`, {}, MT(reg.token));
  me = (await S.call('GET', '/api/c/me', undefined, MT(reg.token))).body;
  assert.equal(me.points, 30);
  assert.equal((await S.call('POST', `/api/coupons/${red2.code}/redeem`, {}, { token: owner, terminal: 'pos1' })).status, 409);
  // rewards are not part of paid sales
  const rep = (await S.call('GET', '/api/reports?preset=today', undefined, { token: owner })).body;
  assert.equal(rep.rewards[0].n, 1);
});

test('Tier คำนวณจากยอดจริง แยกจากแต้มที่แลก; เมนูที่สั่งบ่อยมาจากบิลจริง', async () => {
  const m = (await S.call('POST', '/api/members', { phone: '0870000007', first_name: 'วี' }, { token: owner })).body;
  await S.call('PUT', '/api/tiers/silver', { min_visits: 0 }, { token: owner });
  for (let i = 0; i < 7; i++) await sell([line('p_set1', 1, { options: [{ group_id: 'og_spicy', id: 's1' }] })].concat(i ? [] : [line('p_d001', 1)]), { member_id: m.id });
  const d = (await S.call('GET', '/api/members/' + m.id, undefined, { token: owner })).body;
  assert.equal(d.tier.name, 'Silver');
  assert.equal(d.stats.favorites[0].name.startsWith('เซตคู่'), true);
  assert.equal(d.stats.bills, 7);
  // spending points does not lower the tier
  await S.call('POST', `/api/members/${m.id}/points`, { delta: -d.points, reason: 'ทดสอบ' }, { token: owner });
  const d2 = (await S.call('GET', '/api/members/' + m.id, undefined, { token: owner })).body;
  assert.equal(d2.tier.name, 'Silver');
  assert.ok(d2.ledger.length > 0);
});

test('ลูกค้าแต่ละคนเข้าถึงได้เฉพาะข้อมูลของตนเอง', async () => {
  const A = (await S.call('POST', '/api/c/register', { phone: '0880000008', first_name: 'A' })).body;
  const B = (await S.call('POST', '/api/c/register', { phone: '0880000009', first_name: 'B' })).body;
  const o = await sell([line('p_d001', 1)], { member_id: A.member.id });
  assert.equal((await S.call('GET', '/api/c/bills/' + o.id, undefined, MT(A.token))).status, 200);
  assert.equal((await S.call('GET', '/api/c/bills/' + o.id, undefined, MT(B.token))).status, 404);
  assert.equal((await S.call('GET', '/api/c/bills', undefined, MT(B.token))).body.length, 0);
  assert.equal((await S.call('GET', '/api/members/' + A.member.id, undefined, MT(B.token))).status, 401, 'token สมาชิกใช้กับ API แอดมินไม่ได้');
  const cA = (await S.call('GET', '/api/c/coupons', undefined, MT(A.token))).body;
  const cB = (await S.call('GET', '/api/c/coupons', undefined, MT(B.token))).body;
  assert.equal(cA.length + cB.length, 0);
});
