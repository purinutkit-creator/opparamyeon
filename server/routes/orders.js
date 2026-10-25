import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, emit, audit, getSettings, businessDateOf } from '../lib/util.js';
import { staffAuth, staffForAction, can, requirePerm } from '../lib/auth.js';
import { saveOrder, payOrder, checkout, voidOrder, refundItems, orderFull, getOrder, sendKitchen, freeTableIfIdle, idemRetry } from '../lib/orders.js';
import { enqueue, orderDocData, reprint, retry } from '../lib/print.js';
import { cookerStatus, finishTicket, finishOrder, voidOrderJobs } from '../lib/cookers.js';

const r = Router();

async function openShift(terminalId) {
  if (!terminalId) return null;
  return db.get("SELECT * FROM shifts WHERE terminal_id = ? AND status = 'open'", [terminalId]);
}
async function needShift(req) {
  const sh = await openShift(req.terminalId);
  if (!sh) throw conflict('กรุณาเปิดรอบการขายก่อน', 'no_shift');
  return sh;
}

r.get('/orders', staffAuth(), ah(async (req, res) => {
  const st = String(req.query.status || 'held,open,pending_payment').split(',');
  const rows = await db.all(`SELECT o.*, (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id) AS lines FROM orders o WHERE o.status IN (${st.map(() => '?').join(',')})
    ORDER BY o.created_at DESC LIMIT 200`, st);
  res.json(rows);
}));
// bill barcode on the merchant copy / receipt → look the bill up
r.get('/orders/by-bill/:billNo', staffAuth(), ah(async (req, res) => {
  const o = await db.get('SELECT id FROM orders WHERE bill_no = ?', [String(req.params.billNo).trim().toUpperCase()]);
  if (!o) throw notFound('ไม่พบบิล ' + req.params.billNo);
  res.json({ id: o.id });
}));
r.get('/orders/:id', staffAuth(), ah(async (req, res) => {
  const o = await orderFull(req.params.id);
  if (!can(req.staff, 'view_cost')) { delete o.cost_total; delete o.refunded_cost; o.items.forEach((i) => delete i.cost_unit); }
  res.json(o);
}));

// save: hold / send to kitchen / update an open bill
r.post('/orders/save', staffAuth('sell'), ah(async (req, res) => {
  const sh = await needShift(req);
  const { order_id, cart, action, idempotency_key } = req.body || {};
  if (!['hold', 'send', 'save'].includes(action || 'save')) throw bad('action ไม่ถูกต้อง');
  if (cart && cart.discount && cart.discount.value && req.body.approver) { await staffForAction(req, 'discount'); cart._approved_discount = true; }
  const out = await idemRetry(() => saveOrder({ orderId: order_id, cart, staff: req.staff, terminalId: req.terminalId, shiftId: sh.id, action: action || 'save', idempotencyKey: order_id ? null : idempotency_key }));
  res.json(await orderFull(out.order.id));
}));

r.post('/orders/checkout', staffAuth('sell'), ah(async (req, res) => {
  const sh = await needShift(req);
  const { order_id, cart, payments, idempotency_key, print } = req.body || {};
  if (!idempotency_key) throw bad('missing idempotency_key');
  if (cart && cart.discount && cart.discount.value && req.body.approver) { await staffForAction(req, 'discount'); cart._approved_discount = true; }
  const out = await idemRetry(() => (cart
    ? checkout({ orderId: order_id, cart, payments, staff: req.staff, terminalId: req.terminalId, shiftId: sh.id, idempotencyKey: idempotency_key, print: print || {} })
    : payOrder({ orderId: order_id, payments, staff: req.staff, terminalId: req.terminalId, shiftId: sh.id, idempotencyKey: idempotency_key, print: print || {} })));
  if (print && print.mobile_qr) {
    requirePerm(req.staff, 'print_mobile_qr');
    const { issueMobileForOrder } = await import('./mobile.js');
    await issueMobileForOrder(out.order.id, req.staff, req.body.mobile || {});
  }
  if (out.order.table_id && req.body.close_table) await freeTableIfIdle(out.order.table_id);
  res.json({ ...(await orderFull(out.order.id)), duplicate: !!out.duplicate });
}));

r.post('/orders/:id/send', staffAuth('sell'), ah(async (req, res) => {
  const sh = await needShift(req);
  const o = await getOrder(req.params.id);
  await db.tx(() => sendKitchen(o, req.staff, req.terminalId, sh.id));
  emit('shop', 'orders:changed', { id: o.id });
  res.json(await orderFull(o.id));
}));

r.post('/orders/:id/void', staffAuth(), ah(async (req, res) => {
  const o = await getOrder(req.params.id);
  const perm = o.status === 'paid' || o.status === 'open' ? 'void_bill' : 'sell';
  const actor = await staffForAction(req, perm);
  const out = await voidOrder({ orderId: o.id, staff: actor, reason: req.body.reason, terminalId: req.terminalId });
  await voidOrderJobs(o.id);
  res.json(out);
}));
r.post('/orders/:id/refund', staffAuth(), ah(async (req, res) => {
  const actor = await staffForAction(req, 'refund');
  const out = await refundItems({ orderId: req.params.id, items: req.body.items, staff: actor, reason: req.body.reason, method: req.body.method,
    restock: req.body.restock !== false, idempotencyKey: req.body.idempotency_key, terminalId: req.terminalId });
  res.json(out);
}));

// documents: reprint receipt/queue (same queue no, no new order), print mobile QR on demand
r.post('/orders/:id/print', staffAuth(), ah(async (req, res) => {
  const o = await getOrder(req.params.id);
  const doc = req.body.doc || 'receipt';
  if (doc === 'mobile_qr') {
    requirePerm(req.staff, 'print_mobile_qr');
    const { issueMobileForOrder } = await import('./mobile.js');
    return res.json(await issueMobileForOrder(o.id, req.staff, req.body.mobile || {}));
  }
  if (!['receipt', 'queue', 'merchant'].includes(doc)) throw bad('ประเภทเอกสารไม่ถูกต้อง');
  const prev = await db.get('SELECT id FROM print_jobs WHERE ref_id = ? AND doc_type = ? ORDER BY seq LIMIT 1', [o.id, doc]);
  if (prev) {
    requirePerm(req.staff, 'reprint');
    const nid = await reprint(prev.id, req.staff.id);
    await db.run('UPDATE orders SET reprints = reprints + 1 WHERE id = ?', [o.id]);
    await audit(req.staff.id, 'reprint', 'order', o.id, null, { doc });
    return res.json({ job_id: nid, reprint: true });
  }
  const jobs = await enqueue(doc, o.id, await orderDocData(o), { dedupe: `${doc}:${o.id}` });
  res.json({ jobs });
}));

// Mobile "pay at cashier" / transfer slip verification
r.post('/orders/:id/verify-slip', staffAuth('verify_payment'), ah(async (req, res) => {
  const sh = await needShift(req);
  const o = await getOrder(req.params.id);
  if (req.body.approve) {
    const out = await idemRetry(() => payOrder({ orderId: o.id, payments: [{ method: 'promptpay', amount: o.total, ref: 'slip:' + (req.body.ref || ''), slip_file: req.body.slip_file || null }],
      staff: req.staff, terminalId: req.terminalId, shiftId: sh.id, idempotencyKey: 'slip:' + o.id }));
    await db.run("UPDATE orders SET verify_status = 'approved' WHERE id = ?", [o.id]);
    await audit(req.staff.id, 'verify_slip', 'order', o.id, null, { approved: true });
    return res.json(await orderFull(out.order.id));
  }
  await db.run("UPDATE orders SET verify_status = 'rejected' WHERE id = ?", [o.id]);
  await audit(req.staff.id, 'verify_slip', 'order', o.id, null, { approved: false }, req.body.reason);
  if (o.mobile_session_id) emit('mobile:' + o.mobile_session_id, 'order:status', { id: o.id, status: o.status, verify_status: 'rejected', message: req.body.reason || 'ตรวจสอบการโอนไม่ผ่าน กรุณาติดต่อพนักงาน' });
  res.json({ ok: true });
}));

// ---------- kitchen display ----------
// noodle cooker queue for the POS top bar (estimates)
r.get('/cookers/status', staffAuth(), ah(async (req, res) => res.json(await cookerStatus())));
r.get('/kitchen/tickets', staffAuth('kitchen'), ah(async (req, res) => {
  const since = new Date(Date.now() - 12 * 3600000).toISOString();
  const rows = await db.all("SELECT * FROM kitchen_tickets WHERE created_at >= ? AND status <> 'done' ORDER BY created_at", [since]);
  res.json(rows.map((t) => ({ ...t, content: J(t.content) })));
}));
const PREP = ['received', 'cooking', 'ready', 'done'];
r.post('/kitchen/tickets/:id/status', staffAuth('kitchen'), ah(async (req, res) => {
  const st = req.body.status;
  if (!['new', 'cooking', 'ready', 'done', 'void'].includes(st)) throw bad('สถานะไม่ถูกต้อง');
  const t = await db.get('SELECT * FROM kitchen_tickets WHERE id = ?', [req.params.id]);
  if (!t) throw notFound();
  await db.run('UPDATE kitchen_tickets SET status = ?, updated_at = ? WHERE id = ?', [st, now(), t.id]);
  if (st === 'ready' || st === 'done' || st === 'void') await finishTicket(t.id); // the cooker is free earlier than estimated
  // order prep status = least advanced of its active tickets
  const all = await db.all("SELECT status FROM kitchen_tickets WHERE order_id = ? AND kind <> 'void'", [t.order_id]);
  const rank = (s) => ({ new: 0, cooking: 1, ready: 2, done: 3 })[s] ?? 3;
  const minRank = Math.min(...all.map((x) => rank(x.status)));
  const prep = ['received', 'cooking', 'ready', 'done'][minRank] || 'received';
  await db.run('UPDATE orders SET prep_status = ? WHERE id = ?', [prep, t.order_id]);
  const o = await getOrder(t.order_id);
  emit('kitchen', 'kitchen:status', { id: t.id, status: st });
  emit('shop', 'orders:changed', { id: o.id });
  if (o.mobile_session_id) emit('mobile:' + o.mobile_session_id, 'order:status', { id: o.id, status: o.status, prep_status: prep });
  res.json({ ok: true, prep_status: prep });
}));
// mark a pickup / order as handed over (completes pickup mobile sessions)
r.post('/orders/:id/complete', staffAuth('sell'), ah(async (req, res) => {
  const o = await getOrder(req.params.id);
  await db.run("UPDATE orders SET prep_status = 'done' WHERE id = ?", [o.id]);
  await db.run("UPDATE kitchen_tickets SET status = 'done' WHERE order_id = ?", [o.id]);
  await finishOrder(o.id);
  if (o.mobile_session_id) {
    const ms = await db.get('SELECT * FROM mobile_sessions WHERE id = ?', [o.mobile_session_id]);
    if (ms && ms.mode === 'pickup') await db.run("UPDATE mobile_sessions SET status = 'closed', closed_at = ?, closed_reason = 'pickup_completed' WHERE id = ? AND status = 'active'", [now(), ms.id]);
    emit('mobile:' + o.mobile_session_id, 'order:status', { id: o.id, status: o.status, prep_status: 'done' });
  }
  emit('shop', 'orders:changed', { id: o.id });
  res.json({ ok: true });
}));

// ---------- shifts ----------
r.get('/shifts/current', staffAuth(), ah(async (req, res) => {
  const sh = await openShift(req.terminalId);
  res.json(sh ? await shiftSummary(sh) : null);
}));
r.post('/shifts/open', staffAuth('shift'), ah(async (req, res) => {
  if (!req.terminalId) throw bad('ยังไม่ได้เลือกเครื่องขาย');
  const sid = id();
  await db.tx(async () => {
    if (await openShift(req.terminalId)) throw conflict('เครื่องนี้มีรอบที่เปิดอยู่แล้ว');
    await db.run('INSERT INTO shifts(id, terminal_id, staff_id, opened_at, opening_cash, note, status, business_date) VALUES(?,?,?,?,?,?,?,?)',
      [sid, req.terminalId, req.staff.id, now(), Math.round(Number(req.body.opening_cash) || 0), req.body.note || '', 'open', await businessDateOf()]);
  });
  await audit(req.staff.id, 'shift_open', 'shift', sid, null, req.body);
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [sid]);
  await enqueue('shift', sid, await shiftDoc(await shiftSummary(sh), 'ใบเปิดรอบการขาย'), { dedupe: 'shift-open:' + sid });
  res.json(await shiftSummary(sh));
}));
r.post('/shifts/cash', staffAuth('cash_move'), ah(async (req, res) => {
  const sh = await needShift(req);
  const amt = Math.round(Number(req.body.amount) || 0);
  if (!(amt > 0) || !['in', 'out'].includes(req.body.type)) throw bad('ข้อมูลไม่ถูกต้อง');
  if (!req.body.reason) throw bad('กรุณาระบุเหตุผล');
  await db.run('INSERT INTO cash_moves(id, shift_id, type, amount, reason, staff_id, created_at) VALUES(?,?,?,?,?,?,?)', [id(), sh.id, req.body.type, amt, req.body.reason, req.staff.id, now()]);
  await audit(req.staff.id, 'cash_' + req.body.type, 'shift', sh.id, null, { amount: amt }, req.body.reason);
  res.json(await shiftSummary(sh));
}));
r.post('/shifts/close', staffAuth('shift'), ah(async (req, res) => {
  const sh = await needShift(req);
  const counted = Math.round(Number(req.body.counted_cash));
  if (!(counted >= 0)) throw bad('กรุณากรอกเงินสดที่นับได้');
  const sum = await shiftSummary(sh);
  const diff = counted - sum.expected_cash;
  const ch = await db.run("UPDATE shifts SET status = 'closed', closed_at = ?, closed_by = ?, counted_cash = ?, expected_cash = ?, diff = ?, summary = ?, note = ? WHERE id = ? AND status = 'open'",
    [now(), req.staff.id, counted, sum.expected_cash, diff, S(sum), [sh.note, req.body.note].filter(Boolean).join(' / '), sh.id]);
  if (!ch.changes) throw conflict('รอบนี้ถูกปิดไปแล้ว');
  await audit(req.staff.id, 'shift_close', 'shift', sh.id, null, { counted, expected: sum.expected_cash, diff });
  const closed = await shiftSummary(await db.get('SELECT * FROM shifts WHERE id = ?', [sh.id]));
  const s = await getSettings();
  if (s.queue.reset === 'shift') emit('shop', 'queue:reset', {});
  await enqueue('shift', sh.id, await shiftDoc(closed, 'ใบสรุปปิดรอบการขาย'), { dedupe: 'shift-close:' + sh.id });
  res.json(closed);
}));
r.get('/shifts', staffAuth('view_sales'), ah(async (req, res) => {
  const rows = await db.all('SELECT sh.*, s.name AS staff_name, t.name AS terminal_name FROM shifts sh LEFT JOIN staff s ON s.id = sh.staff_id LEFT JOIN terminals t ON t.id = sh.terminal_id ORDER BY opened_at DESC LIMIT 100');
  res.json(rows.map((x) => ({ ...x, summary: J(x.summary) })));
}));
r.get('/shifts/:id', staffAuth('view_sales'), ah(async (req, res) => {
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
  if (!sh) throw notFound();
  res.json(await shiftSummary(sh));
}));
r.post('/shifts/:id/print', staffAuth('shift'), ah(async (req, res) => {
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
  if (!sh) throw notFound();
  const prev = await db.get("SELECT id FROM print_jobs WHERE ref_id = ? AND doc_type = 'shift' ORDER BY seq DESC LIMIT 1", [sh.id]);
  if (prev) return res.json({ job_id: await reprint(prev.id, req.staff.id) });
  res.json({ jobs: await enqueue('shift', sh.id, await shiftDoc(await shiftSummary(sh), sh.status === 'open' ? 'ใบสรุประหว่างรอบ' : 'ใบสรุปปิดรอบการขาย')) });
}));
r.put('/shifts/:id', staffAuth('edit_closed_shift'), ah(async (req, res) => {
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
  if (!sh) throw notFound();
  if (!req.body.reason) throw bad('กรุณาระบุเหตุผล');
  const counted = Math.round(Number(req.body.counted_cash));
  await db.run('UPDATE shifts SET counted_cash = ?, diff = ? - expected_cash WHERE id = ?', [counted, counted, sh.id]);
  await audit(req.staff.id, 'shift_edit', 'shift', sh.id, { counted_cash: sh.counted_cash }, { counted_cash: counted }, req.body.reason);
  res.json({ ok: true });
}));

export async function shiftSummary(sh) {
  const pays = await db.all(`SELECT p.method, SUM(p.amount) AS amount, COUNT(*) AS n FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE p.shift_id = ? AND p.status = 'paid' GROUP BY p.method`, [sh.id]);
  const bills = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(discount),0) AS discount, COALESCE(SUM(bowls),0) AS bowls FROM orders WHERE shift_id = ? AND status IN ('paid','void') AND paid_at IS NOT NULL", [sh.id]);
  const voids = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(bowls),0) AS bowls FROM refunds WHERE shift_id = ? AND kind = 'void'", [sh.id]);
  const refunds = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(bowls),0) AS bowls FROM refunds WHERE shift_id = ? AND kind = 'refund'", [sh.id]);
  const cashRefund = await db.get("SELECT COALESCE(SUM(amount),0) AS a FROM refunds WHERE shift_id = ? AND method = 'cash'", [sh.id]);
  const moves = await db.all('SELECT * FROM cash_moves WHERE shift_id = ? ORDER BY created_at', [sh.id]);
  const cin = moves.filter((m) => m.type === 'in').reduce((s, m) => s + m.amount, 0);
  const cout = moves.filter((m) => m.type === 'out').reduce((s, m) => s + m.amount, 0);
  const cash = Number((pays.find((p) => p.method === 'cash') || {}).amount || 0);
  const expected = sh.opening_cash + cash + cin - cout - Number(cashRefund.a);
  const staff = await db.get('SELECT name FROM staff WHERE id = ?', [sh.staff_id]);
  const term = await db.get('SELECT name FROM terminals WHERE id = ?', [sh.terminal_id]);
  return { ...sh, summary: undefined, staff_name: staff && staff.name, terminal_name: term && term.name,
    payments: pays.map((p) => ({ method: p.method, amount: Number(p.amount), count: Number(p.n) })),
    gross_sales: Number(bills.total), bills: Number(bills.n) - Number(voids.n), bowls: Number(bills.bowls), discount: Number(bills.discount),
    voids: { count: Number(voids.n), amount: Number(voids.amount), bowls: Number(voids.bowls) }, refunds: { count: Number(refunds.n), amount: Number(refunds.amount), bowls: Number(refunds.bowls) },
    net_sales: Number(bills.total) - Number(voids.amount) - Number(refunds.amount), net_bowls: Number(bills.bowls) - Number(voids.bowls) - Number(refunds.bowls),
    cash_in: cin, cash_out: cout, cash_moves: moves, cash_sales: cash, cash_refunds: Number(cashRefund.a),
    expected_cash: sh.status === 'closed' ? sh.expected_cash : expected, counted_cash: sh.counted_cash, diff: sh.diff };
}
async function shiftDoc(sum, title) {
  const s = await getSettings();
  const names = Object.fromEntries(s.sale.payment_methods.map((m) => [m.id, m.name]));
  return { store_name: s.store.name, ticket_kind: title, shift: { ...sum, payments: sum.payments.map((p) => ({ ...p, name: names[p.method] || p.method })) } };
}

export default r;
