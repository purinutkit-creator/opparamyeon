// Staff meal benefit: the cashier asks to give this bill free to a staff member (food & drink, no limit),
// the owner approves or rejects on LINE (or a manager approves with a PIN at the till).
// Approved: the bill closes at 0 (100% discount "สวัสดิการพนักงาน: name"), the receipt says so, and a
// staff-meal voucher prints instead of the merchant summary (with the bill barcode).
import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, emit, audit, getSettings } from '../lib/util.js';
import { staffAuth, staffForAction } from '../lib/auth.js';
import { saveOrder, payOrder, getOrder, orderFull, recalc } from '../lib/orders.js';
import { enqueue, orderDocData, receiptDocData } from '../lib/print.js';
import { baht } from '../../public/shared/core.js';

const r = Router();
const BRAND = '#e8321f';

async function needShift(req) {
  const sh = req.terminalId ? await db.get("SELECT * FROM shifts WHERE terminal_id = ? AND status = 'open'", [req.terminalId]) : null;
  if (!sh) throw conflict('กรุณาเปิดรอบการขายก่อน', 'no_shift');
  return sh;
}

// LINE: a card for the owners with approve / reject buttons
async function lineRequest(meal, order) {
  const { lineTo } = await import('../lib/line.js');
  const full = await orderFull(order.id);
  const items = full.items.filter((i) => i.qty - i.void_qty > 0).slice(0, 12);
  const row = (l, v, b) => ({ type: 'box', layout: 'horizontal', contents: [{ type: 'text', text: l, size: 'sm', color: '#888888', flex: 3 }, { type: 'text', text: v, size: 'sm', align: 'end', flex: 5, wrap: true, ...(b ? { weight: 'bold', color: '#111111' } : {}) }] });
  const msg = {
    type: 'flex', altText: `🍱 ขออนุมัติสวัสดิการพนักงาน: ${meal.staff_name} · ${baht(meal.value)} บาท`,
    contents: { type: 'bubble', size: 'mega',
      header: { type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px', contents: [
        { type: 'text', text: '🍱 ขออนุมัติสวัสดิการพนักงาน', color: '#ffffff', weight: 'bold', size: 'lg' },
        { type: 'text', text: 'อาหารและเครื่องดื่มมื้อนี้ (ฟรี)', color: '#ffe0d9', size: 'sm' }] },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'text', text: meal.staff_name, weight: 'bold', size: 'xxl', wrap: true },
        row('มูลค่า', `${baht(meal.value)} บาท`, true), row('บิล', `${order.bill_no}${order.queue_no ? ' · คิว ' + order.queue_no : ''}`), row('ขอโดย', meal.requested_by_name || '-'),
        row('เวลา', new Date(meal.created_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })),
        { type: 'separator', margin: 'md' },
        ...items.map((i) => ({ type: 'box', layout: 'horizontal', margin: 'sm', contents: [{ type: 'text', text: `${i.qty - i.void_qty}× ${i.name}`, size: 'sm', flex: 5, wrap: true }, { type: 'text', text: baht(i.line_total), size: 'sm', align: 'end', flex: 2, color: '#666666' }] }))] },
      footer: { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', color: '#16a34a', height: 'md', action: { type: 'postback', label: '✅ อนุมัติ', data: `a=meal&id=${meal.id}&ok=1`, displayText: `อนุมัติสวัสดิการ ${meal.staff_name}` } },
        { type: 'button', style: 'secondary', height: 'md', action: { type: 'postback', label: '❌ ไม่อนุมัติ', data: `a=meal&id=${meal.id}&ok=0`, displayText: `ไม่อนุมัติสวัสดิการ ${meal.staff_name}` } }] } },
  };
  return lineTo('sale', [msg]).catch(() => 0);
}

// approve / reject (from LINE or a manager PIN); only once
export async function decideMeal(mealId, approve, by) {
  const meal = await db.get('SELECT * FROM staff_meals WHERE id = ?', [mealId]);
  if (!meal) throw notFound('ไม่พบคำขอ');
  if (meal.status !== 'pending') return { meal, already: true };
  const ch = await db.run("UPDATE staff_meals SET status = ?, decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'", [approve ? 'approved' : 'rejected', by, now(), mealId]);
  if (!ch.changes) return { meal: await db.get('SELECT * FROM staff_meals WHERE id = ?', [mealId]), already: true };
  let order = await getOrder(meal.order_id);
  if (approve) {
    try {
      // free: a 100% discount covering everything on the bill, then paid at 0
      await recalc(order.id);
      order = await getOrder(order.id);
      const reason = `สวัสดิการพนักงาน: ${meal.staff_name}`;
      const info = { ...(J(order.discount_info) || {}), manual: { type: 'percent', value: 100, reason }, staff_meal: { id: meal.id, staff: meal.staff_name, by } };
      await db.run('UPDATE orders SET discount = discount + total, total = 0, discount_info = ? WHERE id = ?', [S(info), order.id]);
      await db.run('UPDATE staff_meals SET value = ? WHERE id = ?', [order.total, meal.id]); // what the staff member would have paid
      const P = (await getSettings()).print || {};
      const staff = meal.requested_by ? await db.get('SELECT * FROM staff WHERE id = ?', [meal.requested_by]) : null;
      await payOrder({ orderId: order.id, payments: [], staff, terminalId: meal.terminal_id, shiftId: meal.shift_id, print: { receipt: P.auto_receipt !== false, merchant: false, queue: !!P.auto_queue } });
      // the voucher goes where the merchant summary would
      const paid = await getOrder(order.id);
      const data = { ...(await orderDocData(paid)), ...(await benefitFields(paid)) };
      const mp = P.merchant_printer_id ? [P.merchant_printer_id] : (await db.all('SELECT id, roles FROM printers WHERE active = 1')).filter((p) => J(p.roles, []).includes('merchant')).map((p) => p.id);
      for (const pid of mp) await enqueue('staff_meal', paid.id, data, { printerId: pid, dedupe: `staff_meal:${paid.id}` });
    } catch (e) {
      // could not close the bill: put the request back so it can be tried again
      await db.run("UPDATE staff_meals SET status = 'pending', decided_by = NULL, decided_at = NULL WHERE id = ?", [mealId]);
      throw e;
    }
  }
  await audit(String(by).startsWith('line:') ? null : by, approve ? 'staff_meal_approve' : 'staff_meal_reject', 'order', meal.order_id, null, { staff: meal.staff_name, by });
  const out = await db.get('SELECT * FROM staff_meals WHERE id = ?', [mealId]);
  emit('shop', 'staff_meal:decided', { id: mealId, order_id: meal.order_id, approved: approve, staff_name: meal.staff_name, terminal_id: meal.terminal_id });
  emit('shop', 'orders:changed', { id: meal.order_id });
  return { meal: out };
}
// what the receipt / voucher say about the benefit
export async function benefitFields(order) {
  const m = await db.get("SELECT * FROM staff_meals WHERE order_id = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT 1", [order.id]);
  if (!m) return {};
  let by = m.decided_by || '';
  if (by.startsWith('line:')) by = 'เจ้าของร้าน (LINE)';
  else if (by) { const s = await db.get('SELECT name FROM staff WHERE id = ?', [by]); by = s ? s.name : by; }
  return { benefit_label: `สวัสดิการพนักงาน: ${m.staff_name}`, benefit_staff: m.staff_name, benefit_value: baht(m.value) + ' บาท', benefit_approved_by: by };
}

r.get('/staff-meals/staff', staffAuth('sell'), ah(async (req, res) => {
  res.json(await db.all("SELECT id, code, name, nickname FROM staff WHERE active = 1 AND code NOT LIKE 'display%' ORDER BY name"));
}));
// the cashier asks: the bill is saved (open) and the owners get the request on LINE
r.post('/staff-meals', staffAuth('sell'), ah(async (req, res) => {
  const cfg = (await getSettings()).staff_meal || {};
  if (cfg.enabled === false) throw bad('ร้านปิดสวัสดิการพนักงานอยู่');
  const sh = await needShift(req);
  const b = req.body || {};
  const who = await db.get('SELECT id, name, nickname FROM staff WHERE id = ? AND active = 1', [String(b.staff_id || '')]);
  if (!who) throw bad('เลือกพนักงานที่ใช้สิทธิ์');
  let order;
  if (b.cart) order = (await saveOrder({ orderId: b.order_id || null, cart: b.cart, staff: req.staff, terminalId: req.terminalId, shiftId: sh.id, action: 'save', idempotencyKey: b.order_id ? null : b.idempotency_key ? 'o:' + b.idempotency_key : null })).order;
  else order = await getOrder(b.order_id);
  if (!['open', 'held', 'pending_payment'].includes(order.status)) throw conflict('บิลนี้ชำระหรือปิดไปแล้ว', 'not_payable');
  // one open request per bill
  const open = await db.get("SELECT * FROM staff_meals WHERE order_id = ? AND status = 'pending'", [order.id]);
  if (open) await db.run("UPDATE staff_meals SET status = 'cancelled', decided_at = ? WHERE id = ?", [now(), open.id]);
  const meal = { id: id(), order_id: order.id, staff_id: who.id, staff_name: who.nickname ? `${who.name} (${who.nickname})` : who.name, requested_by: req.staff.id, requested_by_name: req.staff.name,
    value: order.total, status: 'pending', terminal_id: req.terminalId, shift_id: sh.id, created_at: now() };
  await db.run('INSERT INTO staff_meals(id, order_id, staff_id, staff_name, requested_by, requested_by_name, value, status, terminal_id, shift_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [meal.id, meal.order_id, meal.staff_id, meal.staff_name, meal.requested_by, meal.requested_by_name, meal.value, meal.status, meal.terminal_id, meal.shift_id, meal.created_at]);
  const sent = await lineRequest(meal, order);
  await audit(req.staff.id, 'staff_meal_request', 'order', order.id, null, { staff: meal.staff_name, value: meal.value, line: sent });
  res.json({ id: meal.id, line_sent: sent, order: await orderFull(order.id) });
}));
r.get('/staff-meals/:id', staffAuth(), ah(async (req, res) => {
  const m = await db.get('SELECT * FROM staff_meals WHERE id = ?', [req.params.id]);
  if (!m) throw notFound();
  res.json({ ...m, order: m.status === 'approved' ? await orderFull(m.order_id) : undefined });
}));
// at the till instead of LINE: a manager (void-bill permission) approves with their PIN
r.post('/staff-meals/:id/approve', staffAuth('sell'), ah(async (req, res) => {
  const by = await staffForAction(req, 'void_bill');
  const out = await decideMeal(req.params.id, true, by.id);
  res.json({ ...out.meal, order: await orderFull(out.meal.order_id) });
}));
r.post('/staff-meals/:id/cancel', staffAuth('sell'), ah(async (req, res) => {
  await db.run("UPDATE staff_meals SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'", [now(), req.params.id]);
  res.json({ ok: true });
}));

export default r;
