import { Router } from 'express';
import { db, J } from '../db.js';
import { ah, bad, getSettings, businessDateOf, dayRules, now } from '../lib/util.js';
import { staffAuth, can } from '../lib/auth.js';
import { addDays, businessRange } from '../../public/shared/core.js';

const r = Router();

// Resolve a preset into business dates [from, to] (inclusive)
export async function resolveRange(q) {
  const today = await businessDateOf();
  const s = await getSettings();
  const ws = Number(q.week_start ?? s.week_start ?? 1); // 0=Sun,1=Mon
  const dow = new Date(today + 'T00:00:00Z').getUTCDay();
  switch (q.preset || 'today') {
    case 'today': return { from: today, to: today, label: 'วันนี้' };
    case 'yesterday': { const y = addDays(today, -1); return { from: y, to: y, label: 'เมื่อวาน' }; }
    case 'last7': return { from: addDays(today, -6), to: today, label: 'ย้อนหลัง 7 วัน (รวมวันนี้)' };
    case 'week': return { from: addDays(today, -((dow - ws + 7) % 7)), to: today, label: 'สัปดาห์นี้' };
    case 'month': return { from: today.slice(0, 8) + '01', to: today, label: 'เดือนนี้' };
    case 'custom': {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(q.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.to || q.from || '')) throw bad('ช่วงวันที่ไม่ถูกต้อง');
      const to = q.to || q.from;
      if (to < q.from) throw bad('วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');
      return { from: q.from, to, label: 'กำหนดเอง' };
    }
    default: throw bad('ช่วงเวลาไม่ถูกต้อง');
  }
}

function filters(q, alias = 'o') {
  const w = []; const p = [];
  if (q.source) { w.push(`${alias}.source = ?`); p.push(q.source); }
  if (q.terminal_id) { w.push(`${alias}.terminal_id = ?`); p.push(q.terminal_id); }
  if (q.shift_id) { w.push(`${alias}.shift_id = ?`); p.push(q.shift_id); }
  if (q.staff_id) { w.push(`${alias}.staff_id = ?`); p.push(q.staff_id); }
  if (q.dine_type) { w.push(`${alias}.dine_type = ?`); p.push(q.dine_type); }
  return { sql: w.length ? ' AND ' + w.join(' AND ') : '', p };
}

// Summary for business dates [from, to]. Sales are counted on the day they were paid; refunds/voids on the day they happened.
// Pending (unpaid) orders are never counted as sales.
export async function summary(from, to, q = {}, { withCost = true } = {}) {
  const f = filters(q);
  const sales = await db.get(`SELECT COUNT(*) AS bills_all, COALESCE(SUM(o.total),0) AS gross, COALESCE(SUM(o.discount),0) AS discount, COALESCE(SUM(o.tax),0) AS tax,
    COALESCE(SUM(o.packaging),0) AS packaging, COALESCE(SUM(o.bowls),0) AS bowls, COALESCE(SUM(o.cost_total),0) AS cost,
    COALESCE(SUM(CASE WHEN o.status = 'paid' THEN 1 ELSE 0 END),0) AS bills_paid
    FROM orders o WHERE o.paid_at IS NOT NULL AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql}`, [from, to, ...f.p]);
  const ref = await db.all(`SELECT f.kind, COUNT(*) AS n, COALESCE(SUM(f.amount),0) AS amount, COALESCE(SUM(f.bowls),0) AS bowls, COALESCE(SUM(f.cost),0) AS cost
    FROM refunds f JOIN orders o ON o.id = f.order_id WHERE f.business_date >= ? AND f.business_date <= ?${f.sql} GROUP BY f.kind`, [from, to, ...f.p]);
  const rv = (k) => ref.find((x) => x.kind === k) || { n: 0, amount: 0, bowls: 0, cost: 0 };
  const voids = rv('void'), refunds = rv('refund');
  const pays = await db.all(`SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.status = 'paid' AND p.business_date >= ? AND p.business_date <= ?${f.sql} GROUP BY p.method`, [from, to, ...f.p]);
  const refByMethod = await db.all(`SELECT f.method, COALESCE(SUM(f.amount),0) AS amount FROM refunds f JOIN orders o ON o.id = f.order_id
    WHERE f.business_date >= ? AND f.business_date <= ?${f.sql} GROUP BY f.method`, [from, to, ...f.p]);
  const pending = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(o.total),0) AS amount FROM orders o WHERE o.status = 'pending_payment'${f.sql}`, f.p);
  const net = Number(sales.gross) - Number(voids.amount) - Number(refunds.amount);
  const netCost = Number(sales.cost) - Number(voids.cost) - Number(refunds.cost);
  const s = await getSettings();
  const taxPart = s.sale.tax_rate ? Math.round(net - net / (1 + s.sale.tax_rate / 100)) : 0;
  const netExTax = s.sale.tax_inclusive ? net - taxPart : net - Number(sales.tax);
  const out = {
    from, to, range: businessRange(from, to, await dayRules()),
    net_sales: net, gross_sales: Number(sales.gross), discount: Number(sales.discount), tax: Number(sales.tax), packaging: Number(sales.packaging),
    bills_paid: Number(sales.bills_all) - Number(voids.n), bills_voided: Number(voids.n), refunds: { count: Number(refunds.n), amount: Number(refunds.amount), bowls: Number(refunds.bowls) },
    voids: { count: Number(voids.n), amount: Number(voids.amount), bowls: Number(voids.bowls) },
    bowls_sold: Number(sales.bowls), bowls_cancelled: Number(voids.bowls) + Number(refunds.bowls), bowls_net: Number(sales.bowls) - Number(voids.bowls) - Number(refunds.bowls),
    payments: pays.map((p) => {
      const back = refByMethod.find((x) => x.method === p.method);
      return { method: p.method, amount: Number(p.amount), refunded: back ? Number(back.amount) : 0, net: Number(p.amount) - (back ? Number(back.amount) : 0), count: Number(p.n) };
    }),
    pending_payment: { count: Number(pending.n), amount: Number(pending.amount) },
    generated_at: now(),
  };
  if (withCost) Object.assign(out, { cost: netCost, gross_profit: netExTax - netCost, margin_pct: netExTax ? Math.round(((netExTax - netCost) / netExTax) * 1000) / 10 : 0,
    profit_note: 'กำไรขั้นต้น = ยอดขายสุทธิ (ไม่รวมภาษี) − ต้นทุนขาย ณ เวลาขาย ยังไม่หักค่าใช้จ่ายร้านอื่นที่ไม่ได้บันทึก เช่น ค่าเช่า ค่าแรง ค่าน้ำไฟ' });
  return out;
}

r.get('/dashboard', staffAuth('view_sales'), ah(async (req, res) => {
  const today = await businessDateOf();
  const sum = await summary(today, today, req.query, { withCost: can(req.staff, 'view_cost') });
  const recent = await db.all("SELECT id, bill_no, queue_no, total, bowls, status, paid_at, source, dine_type FROM orders WHERE paid_business_date = ? ORDER BY paid_at DESC LIMIT 10", [today]);
  const hours = await db.all("SELECT paid_at, total FROM orders WHERE paid_business_date = ? AND paid_at IS NOT NULL", [today]);
  const byHour = {};
  for (const h of hours) { const k = new Date(h.paid_at).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' }); byHour[k] = (byHour[k] || 0) + h.total; }
  const rewards = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(cost),0) AS cost FROM coupons WHERE status = 'used' AND business_date = ?", [today]);
  res.json({ business_date: today, ...sum, recent, by_hour: byHour, rewards: { count: Number(rewards.n), cost: can(req.staff, 'view_cost') ? Number(rewards.cost) : undefined } });
}));

r.get('/reports', staffAuth('view_sales'), ah(async (req, res) => {
  const range = await resolveRange(req.query);
  const withCost = can(req.staff, 'view_cost');
  const sum = await summary(range.from, range.to, req.query, { withCost });
  const f = filters(req.query);
  const base = `FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.paid_at IS NOT NULL AND o.status = 'paid' AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql}`;
  const qp = [range.from, range.to, ...f.p];
  const netQty = '(i.qty - i.void_qty - i.refunded_qty)';
  const netAmt = `(CASE WHEN (i.qty - i.void_qty) > 0 THEN i.line_total * ${netQty} * 1.0 / (i.qty - i.void_qty) ELSE 0 END)`;
  const byProduct = await db.all(`SELECT i.product_id, i.name, SUM(${netQty}) AS qty, SUM(${netAmt}) AS amount, SUM(i.cost_unit * ${netQty}) AS cost,
    SUM(i.bowl_count * ${netQty}) AS bowls_raw ${base} GROUP BY i.product_id, i.name ORDER BY amount DESC`, qp);
  const byCat = await db.all(`SELECT COALESCE(c.name, 'ไม่มีหมวด') AS name, SUM(${netQty}) AS qty, SUM(${netAmt}) AS amount, SUM(i.cost_unit * ${netQty}) AS cost
    FROM order_items i JOIN orders o ON o.id = i.order_id LEFT JOIN categories c ON c.id = i.category_id WHERE o.paid_at IS NOT NULL AND o.status = 'paid'
    AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql} GROUP BY c.name ORDER BY amount DESC`, qp);
  const byStaff = await db.all(`SELECT COALESCE(s.name, 'Mobile Ordering') AS name, COUNT(*) AS bills, SUM(o.total - o.refunded_amount) AS amount, SUM(o.bowls - o.refunded_bowls) AS bowls
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id WHERE o.status = 'paid' AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql} GROUP BY s.name ORDER BY amount DESC`, qp);
  const byDine = await db.all(`SELECT i.dine_type, SUM(${netQty}) AS qty, SUM(${netAmt}) AS amount ${base} GROUP BY i.dine_type`, qp);
  const bySource = await db.all(`SELECT o.source, COUNT(*) AS bills, SUM(o.total - o.refunded_amount) AS amount, SUM(o.bowls - o.refunded_bowls) AS bowls FROM orders o
    WHERE o.status = 'paid' AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql} GROUP BY o.source`, qp);
  const daily = await db.all(`SELECT o.paid_business_date AS day, COUNT(*) AS bills, SUM(o.total) AS gross, SUM(o.bowls) AS bowls FROM orders o
    WHERE o.paid_at IS NOT NULL AND o.paid_business_date >= ? AND o.paid_business_date <= ?${f.sql} GROUP BY o.paid_business_date ORDER BY day`, qp);
  const dailyRef = await db.all(`SELECT f.business_date AS day, SUM(f.amount) AS amount, SUM(f.bowls) AS bowls FROM refunds f JOIN orders o ON o.id = f.order_id
    WHERE f.business_date >= ? AND f.business_date <= ?${f.sql} GROUP BY f.business_date`, qp);
  const days = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
    const a = daily.find((x) => x.day === d) || {}; const b = dailyRef.find((x) => x.day === d) || {};
    days.push({ day: d, net: Number(a.gross || 0) - Number(b.amount || 0), bills: Number(a.bills || 0), bowls: Number(a.bowls || 0) - Number(b.bowls || 0) });
    if (days.length > 400) break;
  }
  const months = {};
  for (const d of days) { const m = d.day.slice(0, 7); months[m] = months[m] || { month: m, net: 0, bills: 0, bowls: 0 }; months[m].net += d.net; months[m].bills += d.bills; months[m].bowls += d.bowls; }
  const rewards = await db.all(`SELECT r.name, COUNT(*) AS n, SUM(c.points) AS points, SUM(c.cost) AS cost FROM coupons c JOIN rewards r ON r.id = c.reward_id
    WHERE c.status = 'used' AND c.business_date >= ? AND c.business_date <= ? GROUP BY r.name`, [range.from, range.to]);
  const num = (rows) => rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, typeof v === 'string' || v === null ? v : Math.round(Number(v) * 100) / 100])));
  const strip = (rows) => (withCost ? rows : rows.map(({ cost, ...x }) => x));
  res.json({ range: { ...range, ...sum.range }, summary: sum, by_product: strip(num(byProduct)), by_category: strip(num(byCat)), by_staff: num(byStaff), by_dine: num(byDine),
    by_source: num(bySource), daily: days, monthly: Object.values(months), rewards: strip(num(rewards).map((x) => ({ ...x, cost: x.cost }))) });
}));

// bills: search & filter
r.get('/bills', staffAuth('view_sales'), ah(async (req, res) => {
  const q = req.query;
  const w = []; const p = [];
  if (q.q) { w.push('(o.bill_no LIKE ? OR o.queue_no = ? OR o.customer_name LIKE ?)'); p.push('%' + q.q + '%', q.q, '%' + q.q + '%'); }
  if (q.preset || q.from) { const rg = await resolveRange(q.preset ? q : { ...q, preset: 'custom' }); w.push('COALESCE(o.paid_business_date, o.business_date) >= ? AND COALESCE(o.paid_business_date, o.business_date) <= ?'); p.push(rg.from, rg.to); }
  if (q.status) { w.push('o.status = ?'); p.push(q.status); }
  const f = filters(q);
  const rows = await db.all(`SELECT o.id, o.bill_no, o.queue_no, o.status, o.source, o.dine_type, o.table_name, o.customer_name, o.total, o.discount, o.tax, o.bowls, o.refunded_amount,
    o.refunded_bowls, o.created_at, o.paid_at, o.paid_business_date, o.business_date, o.terminal_id, o.shift_id, s.name AS staff_name, t.name AS terminal_name, m.member_no
    FROM orders o LEFT JOIN staff s ON s.id = o.staff_id LEFT JOIN terminals t ON t.id = o.terminal_id LEFT JOIN members m ON m.id = o.member_id
    WHERE 1 = 1 ${w.length ? 'AND ' + w.join(' AND ') : ''}${f.sql} ORDER BY o.created_at DESC LIMIT 500`, [...p, ...f.p]);
  res.json(rows);
}));

// CSV export
r.get('/export/:what.csv', staffAuth('export'), ah(async (req, res) => {
  const range = await resolveRange(req.query);
  let rows = [];
  if (req.params.what === 'bills') {
    rows = await db.all(`SELECT o.bill_no, o.queue_no, o.status, o.source, o.dine_type, o.paid_business_date, o.paid_at, o.items_total, o.discount, o.packaging, o.tax, o.total,
      o.refunded_amount, o.bowls, o.refunded_bowls ${can(req.staff, 'view_cost') ? ', o.cost_total' : ''} FROM orders o WHERE o.paid_at IS NOT NULL AND o.paid_business_date >= ? AND o.paid_business_date <= ? ORDER BY o.paid_at`, [range.from, range.to]);
  } else if (req.params.what === 'items') {
    rows = await db.all(`SELECT o.bill_no, o.paid_business_date, i.name, i.qty, i.void_qty, i.refunded_qty, i.unit_price, i.options_price, i.line_total, i.dine_type, i.bowl_count
      ${can(req.staff, 'view_cost') ? ', i.cost_unit' : ''} FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.paid_at IS NOT NULL AND o.paid_business_date >= ? AND o.paid_business_date <= ? ORDER BY o.paid_at`, [range.from, range.to]);
  } else if (req.params.what === 'payments') {
    rows = await db.all('SELECT o.bill_no, p.method, p.amount, p.received, p.change_amount, p.business_date, p.created_at FROM payments p JOIN orders o ON o.id = p.order_id WHERE p.business_date >= ? AND p.business_date <= ? ORDER BY p.created_at', [range.from, range.to]);
  } else if (req.params.what === 'refunds') {
    rows = await db.all('SELECT o.bill_no, f.kind, f.amount, f.bowls, f.reason, f.method, f.business_date, f.created_at FROM refunds f JOIN orders o ON o.id = f.order_id WHERE f.business_date >= ? AND f.business_date <= ? ORDER BY f.created_at', [range.from, range.to]);
  } else throw bad('ไม่รองรับ');
  const money = new Set(['items_total', 'discount', 'packaging', 'tax', 'total', 'refunded_amount', 'cost_total', 'unit_price', 'options_price', 'line_total', 'cost_unit', 'amount', 'received', 'change_amount']);
  const cols = rows[0] ? Object.keys(rows[0]) : [];
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = '﻿' + [cols.join(','), ...rows.map((x) => cols.map((c) => esc(money.has(c) && x[c] !== null ? (x[c] / 100).toFixed(2) : x[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.what}-${range.from}-${range.to}.csv"`);
  res.end(csv);
}));

export default r;
