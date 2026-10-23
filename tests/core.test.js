import test from 'node:test';
import assert from 'node:assert/strict';
import { addToCart, countBowls, splitTickets, businessDate, computeTotals, promptPayPayload, latestOnly, defaultPassword, normalizePhone, code128, pointsFor } from '../public/shared/core.js';

test('สแกนบาร์โค้ดซ้ำ เพิ่มจำนวนในรายการเดิม', () => {
  const cart = { lines: [], dine_type: 'dine_in' };
  const p = { id: 'p1', name: 'มาม่า', price: 7900, bowl_count: 1 };
  addToCart(cart, p); addToCart(cart, p); addToCart(cart, p);
  assert.equal(cart.lines.length, 1);
  assert.equal(cart.lines[0].qty, 3);
  // different dine type or options → separate line
  addToCart(cart, p, { dine_type: 'takeaway' });
  addToCart(cart, p, { options: [{ group_id: 'g', id: 'spicy' }] });
  assert.equal(cart.lines.length, 3);
});

test('กฎนับชาม: ไม่คำนวณจากจำนวนสินค้าตรง ๆ', () => {
  const L = (bowl_count, qty, bowl_group = null) => ({ bowl_count, qty, bowl_group });
  assert.equal(countBowls([L(1, 1)]), 1, 'มาม่าเดี่ยว = 1 ชาม');
  assert.equal(countBowls([L(1, 1, 1), L(1, 1, 1)]), 1, 'มาม่า 2 ซองในชามเดียว = 1 ชาม');
  assert.equal(countBowls([L(2, 1)]), 2, 'เซตคู่ = 2 ชาม');
  assert.equal(countBowls([L(0, 3), L(0, 2)]), 0, 'ไข่ ชีส เครื่องดื่ม = 0 ชาม');
  assert.equal(countBowls([L(1, 1, 1), L(0, 2, 1), L(1, 1, 2), L(0, 1, 2), L(0, 4)]), 2);
  assert.equal(countBowls([{ bowl_count: 1, qty: 3, void_qty: 1 }]), 2, 'ยกเลิกแล้วลดชาม');
});

test('ใบครัวแยกชาม ท็อปปิ้งอยู่กับชามของตัวเอง และไม่เปลี่ยนจำนวนสินค้า', () => {
  const lines = [
    { name: 'มาม่า A', qty: 1, bowl_count: 1, bowl_group: 1 }, { name: 'ไข่', qty: 1, bowl_count: 0, bowl_group: 1 },
    { name: 'มาม่า B', qty: 1, bowl_count: 1, bowl_group: 2 }, { name: 'ชีส', qty: 2, bowl_count: 0, bowl_group: 2 },
    { name: 'มาม่า C', qty: 2, bowl_count: 1 }, { name: 'โคล่า', qty: 1, bowl_count: 0 },
  ];
  const t = splitTickets(lines, 'bowl', 1);
  const withEgg = t.find((x) => x.lines.some((l) => l.name === 'ไข่'));
  assert.ok(withEgg.lines.some((l) => l.name === 'มาม่า A'));
  assert.ok(!withEgg.lines.some((l) => l.name === 'มาม่า B'));
  const withCheese = t.find((x) => x.lines.some((l) => l.name === 'ชีส'));
  assert.ok(withCheese.lines.some((l) => l.name === 'มาม่า B'));
  assert.equal(t.filter((x) => x.lines.some((l) => l.name === 'มาม่า C')).length, 2, 'มาม่า C 2 ชาม = 2 ใบ');
  const total = (ts) => ts.flatMap((x) => x.lines).reduce((s, l) => s + l.qty, 0);
  assert.equal(total(t), lines.reduce((s, l) => s + l.qty, 0));
  // every 2 bowls per ticket
  const t2 = splitTickets(lines, 'bowl', 2);
  assert.equal(total(t2), total(t));
  for (const x of t2) { const grp = x.lines.filter((l) => l.bowl_group); for (const g of new Set(grp.map((l) => l.bowl_group))) assert.equal(t2.filter((y) => y.lines.some((l) => l.bowl_group === g)).length, 1); }
  assert.equal(splitTickets(lines, 'order').length, 1);
  assert.equal(splitTickets(lines, 'item').length, lines.length);
});

test('ตัดวันขาย 04:00 ตามตัวอย่าง', () => {
  const rules = [{ effective_from: '1970-01-01', cutoff: '04:00', timezone: 'Asia/Bangkok' }];
  assert.equal(businessDate(new Date('2026-03-10T04:00:00+07:00'), rules), '2026-03-10');
  assert.equal(businessDate(new Date('2026-03-11T01:30:00+07:00'), rules), '2026-03-10');
  assert.equal(businessDate(new Date('2026-03-11T03:59:59+07:00'), rules), '2026-03-10');
  assert.equal(businessDate(new Date('2026-03-11T04:00:00+07:00'), rules), '2026-03-11');
  // a rule change only applies from its effective date
  const changed = [...rules, { effective_from: '2026-04-01', cutoff: '00:00', timezone: 'Asia/Bangkok' }];
  assert.equal(businessDate(new Date('2026-03-11T01:30:00+07:00'), changed), '2026-03-10');
  assert.equal(businessDate(new Date('2026-04-05T01:30:00+07:00'), changed), '2026-04-05');
});

test('ยอดรวม ส่วนลด ค่าบรรจุภัณฑ์ ภาษี', () => {
  const lines = [{ unit_price: 10000, qty: 2, options: [{ price: 1000 }], dine_type: 'takeaway', bowl_count: 1, cost_unit: 3000 }];
  const t = computeTotals(lines, { packaging_fee: 500, tax_rate: 7, tax_inclusive: false }, { type: 'percent', value: 10 });
  assert.equal(t.items_total, 22000);
  assert.equal(t.discount, 2200);
  assert.equal(t.packaging, 1000);
  assert.equal(t.tax, Math.round((22000 - 2200 + 1000) * 0.07));
  assert.equal(t.total, 22000 - 2200 + 1000 + t.tax);
});

test('PromptPay payload ถูกต้องตามมาตรฐาน EMVCo', () => {
  assert.equal(promptPayPayload('0801234567'), '00020101021129370016A000000677010111011300668012345675802TH530376463046197');
  assert.match(promptPayPayload('0812345678', 4200), /5405?42\.00/);
});

test('รหัสผ่านเริ่มต้น 4 ตัวท้าย คงเลขศูนย์นำหน้า', () => {
  assert.equal(defaultPassword(normalizePhone('081-234-0012')), '0012');
  assert.equal(defaultPassword(normalizePhone('+66 81 230 0007')), '0007');
  assert.equal(normalizePhone('12345'), null);
});

test('Refresh ถี่ ๆ: ผลเก่าไม่ทับผลใหม่ และรวมคำขอซ้อน', async () => {
  const guard = latestOnly();
  let calls = 0;
  const slow = (v, ms) => () => new Promise((r) => { calls++; setTimeout(() => r(v), ms); });
  const [a, b] = await Promise.all([guard(slow('old', 50)), guard(slow('dup', 1))]);
  assert.equal(calls, 1, 'คำขอที่ซ้อนกันถูกรวมเป็นครั้งเดียว');
  assert.deepEqual(a, b);
  const old = guard(slow('old', 60), { coalesce: false });
  const fresh = guard(slow('new', 5), { coalesce: false });
  assert.equal((await fresh).fresh, true);
  assert.equal((await old).fresh, false, 'ผลลัพธ์เก่าที่กลับมาทีหลังถูกทิ้ง');
});

test('Code128 และแต้ม', () => {
  assert.ok(code128('ABC123').length > 30);
  const order = { items_total: 10000, discount: 1000, packaging: 0, tax: 0 };
  assert.equal(pointsFor(order, [{ product_id: 'a', qty: 1, line_total: 10000 }], { rate_baht: 25 }).points, 3);
  assert.equal(pointsFor(order, [{ product_id: 'a', qty: 1, line_total: 10000 }], { rate_baht: 25, base: 'before_discount' }).points, 4);
});
