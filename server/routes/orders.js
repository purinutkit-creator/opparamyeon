import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, emit, audit, getSettings, businessDateOf } from '../lib/util.js';
import { staffAuth, staffForAction, can, requirePerm } from '../lib/auth.js';
import { saveOrder, payOrder, checkout, voidOrder, refundItems, orderFull, getOrder, sendKitchen, freeTableIfIdle, idemRetry } from '../lib/orders.js';
import { enqueue, orderDocData, reprint, retry, feedMerchantRoll } from '../lib/print.js';
import { cookerStatus, finishTicket, finishOrder, voidOrderJobs } from '../lib/cookers.js';
import { billFromToken, shiftToken, shiftFromToken } from '../lib/billlink.js';
import { joinShiftCrew, verifyOnDuty, clockIn, printAttendance, selfieOf, needSelfie } from '../lib/crew.js';
import { notifyShiftClose } from '../lib/line.js';
import { MERCHANT_CLOSE } from '../lib/templates.js';
import { baht } from '../../public/shared/core.js';

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
// bill details from the signed QR on the merchant slip: no login, only what is printed on a receipt
r.get('/public/bill/:token', ah(async (req, res) => {
  const billNo = await billFromToken(req.params.token);
  if (!billNo) throw notFound('ลิงก์บิลไม่ถูกต้อง');
  const row = await db.get('SELECT id FROM orders WHERE bill_no = ?', [billNo]);
  if (!row) throw notFound('ไม่พบบิล ' + billNo);
  const o = await orderFull(row.id);
  const s = await getSettings();
  const methods = Object.fromEntries((s.sale.payment_methods || []).map((m) => [m.id, m.name]));
  res.set('Cache-Control', 'no-store');
  res.json({ store: s.store.name || '', bill_no: o.bill_no, queue_no: o.queue_no || '', status: o.status, dine_type: o.dine_type, table: o.table_name || '',
    created_at: o.created_at, paid_at: o.paid_at, staff: o.staff_name || '', bowls: o.bowls,
    items: o.items.filter((i) => i.qty - i.void_qty > 0).map((i) => ({ name: i.name, qty: i.qty - i.void_qty, refunded: i.refunded_qty || 0, options: (i.options || []).map((x) => x.name), note: i.note || '', line_total: i.line_total })),
    items_total: o.items_total, discount: o.discount, packaging: o.packaging, tax: o.tax, total: o.total, refunded: o.refunded_amount || 0,
    payments: o.payments.filter((p) => p.status === 'paid').map((p) => ({ method: methods[p.method] || p.method, amount: p.amount, received: p.received, change: p.change_amount })) });
}));
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
  const sess = await db.get('SELECT crew FROM sessions WHERE token = ?', [req.staff.token]);
  await joinShiftCrew(sid, [{ id: req.staff.id, code: req.staff.code, name: req.staff.name, main: true }, ...J(sess && sess.crew, [])]);
  await audit(req.staff.id, 'shift_open', 'shift', sid, null, req.body);
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [sid]);
  await enqueue('shift', sid, await shiftDoc(await shiftSummary(sh), 'ใบเปิดรอบการขาย'), { dedupe: 'shift-open:' + sid });
  res.json(await shiftSummary(sh));
}));
// opening cash of the shift before (for the "same as yesterday" button)
r.get('/shifts/last-opening', staffAuth(), ah(async (req, res) => {
  const sh = req.terminalId ? await db.get('SELECT opening_cash, business_date, opened_at FROM shifts WHERE terminal_id = ? ORDER BY opened_at DESC LIMIT 1', [req.terminalId]) : null;
  res.json(sh ? { amount: Number(sh.opening_cash), business_date: sh.business_date, opened_at: sh.opened_at } : null);
}));
// someone joins the open shift later (scan + PIN on the POS) without changing who is signed in
r.post('/shifts/join', staffAuth(), ah(async (req, res) => {
  const sh = await needShift(req);
  const s = await verifyOnDuty((req.body || {}).code, (req.body || {}).pin);
  const selfie = await selfieOf(s.id, req.body.ticket, req.body.face);
  if (!selfie && await needSelfie(s.id)) throw bad(`${s.name} ยังไม่ได้ถ่ายรูปเข้างาน`, 'selfie_required');
  const crew = await joinShiftCrew(sh.id, [{ id: s.id, code: s.code, name: s.name, late: true }]);
  const ci = await clockIn([{ id: s.id, name: s.name, at: req.body.at, selfie }], { terminalId: req.terminalId, shiftId: sh.id, kind: 'late' });
  if (ci.added.length) await printAttendance(ci.day, req.terminalId).catch(() => {});
  await audit(req.staff.id, 'shift_join', 'shift', sh.id, null, { staff: s.code });
  res.json({ name: s.name, crew });
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
  // the compact merchant roll: feed it out (and cut, if set and possible) so the day's slips can be torn off
  const roll = s.print && s.print.merchant_style === 'compact' ? await feedMerchantRoll() : [];
  notifyShiftClose(closed).catch((e) => console.warn('[line]', e.message)); // LINE: what is running low / what to buy
  res.json({ ...closed, roll, merchant_close: await merchantCloseInfo() });
}));
// ---- merchant summary of the whole shift, printed at close (the POS confirms the paper first, then waits until it's done) ----
async function merchantClosePrinter() {
  const P = (await getSettings()).print || {};
  const want = P.merchant_close_printer_id || P.merchant_printer_id;
  const ps = await db.all('SELECT id, name, roles, paper FROM printers WHERE active = 1');
  return (want && ps.find((p) => p.id === want)) || ps.find((p) => J(p.roles, []).includes('merchant')) || null;
}
async function merchantCloseInfo() {
  const P = (await getSettings()).print || {};
  if (!P.merchant_close) return { enabled: false };
  const p = await merchantClosePrinter();
  return { enabled: true, paper: Number(P.merchant_close_paper) === 80 ? 80 : 58, printer: p ? { id: p.id, name: p.name, paper: p.paper } : null };
}
r.post('/shifts/:id/merchant-print', staffAuth('shift'), ah(async (req, res) => {
  const sh = await db.get('SELECT * FROM shifts WHERE id = ?', [req.params.id]);
  if (!sh) throw notFound('ไม่พบรอบ');
  const info = await merchantCloseInfo();
  const p = await merchantClosePrinter();
  if (!p) throw bad('ยังไม่ได้ตั้งเครื่องพิมพ์ใบสรุปร้านค้า (จัดการร้าน → เครื่องพิมพ์ → ใบสรุปร้านค้า)');
  const paper = Number(req.body.paper || info.paper) === 80 ? 80 : 58;
  const s = await getSettings();
  const names = Object.fromEntries(s.sale.payment_methods.map((m) => [m.id, m.name]));
  const orders = await db.all("SELECT id, bill_no, queue_no, total, status, paid_at FROM orders WHERE shift_id = ? AND paid_at IS NOT NULL ORDER BY paid_at", [sh.id]);
  const pays = await db.all("SELECT p.order_id, p.method, p.amount FROM payments p JOIN orders o ON o.id = p.order_id WHERE o.shift_id = ? AND p.status = 'paid'", [sh.id]);
  const hm = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-');
  const methodOf = (oid) => [...new Set(pays.filter((x) => x.order_id === oid).map((x) => names[x.method] || x.method))].join('+');
  const sum = await shiftSummary(sh);
  const term = await db.get('SELECT name FROM terminals WHERE id = ?', [sh.terminal_id]);
  const data = { store_name: s.store.name, shift_line: `${(term && term.name) || ''} · ${sum.staff_name || ''}`,
    time_line: `${new Date(sh.opened_at).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' })} – ${sh.closed_at ? hm(sh.closed_at) : 'ยังเปิดอยู่'}`,
    bills: orders.map((o) => [`${hm(o.paid_at)} ${o.queue_no || ''} ${o.bill_no}${o.status === 'void' ? ' (ยกเลิก)' : ''} ${methodOf(o.id)}`.replace(/\s+/g, ' ').trim(), baht(o.total)]),
    pays: sum.payments.map((x) => [`${names[x.method] || x.method} (${x.count})`, baht(x.amount)]),
    totals: [[`รวม ${sum.bills} บิล`, baht(sum.net_sales)]],
    shift_url: `${process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || ''}/s/#${await shiftToken(sh.id)}` };
  const jobs = await enqueue('merchant', 'close-' + sh.id, data, { printerId: p.id, template: MERCHANT_CLOSE(paper) });
  await audit(req.staff.id, 'merchant_close_print', 'shift', sh.id, null, { printer: p.id, paper });
  res.json({ jobs: jobs.map((j) => j.id), printer: p.name, paper });
}));
// shift report from the QR on the shift slip (no login)
r.get('/public/shift/:token', ah(async (req, res) => {
  const sid = await shiftFromToken(req.params.token);
  const sh = sid && await db.get('SELECT * FROM shifts WHERE id = ?', [sid]);
  if (!sh) throw notFound('ลิงก์รายงานรอบไม่ถูกต้อง');
  const s = await getSettings();
  res.set('Cache-Control', 'no-store');
  res.json({ store: s.store.name || '', count_unit: s.sale.count_unit || 'ชาม', payment_names: Object.fromEntries(s.sale.payment_methods.map((m) => [m.id, m.name])), shift: await publicShift(sh) });
}));
// the public report shows who worked, but not their staff codes (they are half of a sign-in)
async function publicShift(sh) { const sum = await shiftSummary(sh); return { ...sum, crew: sum.crew.map((c) => ({ name: c.name, main: !!c.main })) }; }
// link for the POS screen (QR shown when closing a shift)
r.get('/shifts/:id/link', staffAuth('shift'), ah(async (req, res) => {
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  res.json({ url: `${base || ''}/s/#${await shiftToken(req.params.id)}` });
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
  return { ...sh, summary: undefined, crew: J(sh.crew, []), staff_name: staff && staff.name, terminal_name: term && term.name,
    payments: pays.map((p) => ({ method: p.method, amount: Number(p.amount), count: Number(p.n) })),
    gross_sales: Number(bills.total), bills: Number(bills.n) - Number(voids.n), bowls: Number(bills.bowls), discount: Number(bills.discount),
    voids: { count: Number(voids.n), amount: Number(voids.amount), bowls: Number(voids.bowls) }, refunds: { count: Number(refunds.n), amount: Number(refunds.amount), bowls: Number(refunds.bowls) },
    net_sales: Number(bills.total) - Number(voids.amount) - Number(refunds.amount), net_bowls: Number(bills.bowls) - Number(voids.bowls) - Number(refunds.bowls),
    cash_in: cin, cash_out: cout, cash_moves: moves, cash_sales: cash, cash_refunds: Number(cashRefund.a),
    expected_cash: sh.status === 'closed' ? sh.expected_cash : expected, counted_cash: sh.counted_cash, diff: sh.diff, ...(await shiftDetails(sh)) };
}
// the finer picture of a shift: when, what sold, dine-in vs takeaway, members, busiest hours
async function shiftDetails(sh) {
  const orders = await db.all("SELECT id, total, discount, packaging, tax, dine_type, source, member_id, points_earned, paid_at, bowls FROM orders WHERE shift_id = ? AND status = 'paid' AND paid_at IS NOT NULL ORDER BY paid_at", [sh.id]);
  const items = await db.all(`SELECT oi.name, oi.category_id, SUM(oi.qty - oi.void_qty - oi.refunded_qty) AS qty, SUM(oi.line_total) AS amount FROM order_items oi JOIN orders o ON o.id = oi.order_id
    WHERE o.shift_id = ? AND o.status = 'paid' GROUP BY oi.name, oi.category_id`, [sh.id]);
  const cats = Object.fromEntries((await db.all('SELECT id, name FROM categories')).map((c) => [c.id, c.name]));
  const sum = (a, f) => a.reduce((x, o) => x + Number(f(o) || 0), 0);
  const group = (key) => { const m = {}; for (const o of orders) { const k = key(o); m[k] = m[k] || { n: 0, amount: 0 }; m[k].n++; m[k].amount += Number(o.total); } return m; };
  const hourOf = (iso) => Number(new Date(iso).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hour12: false }).slice(0, 2)) % 24;
  const hours = group((o) => hourOf(o.paid_at));
  const byCat = {};
  for (const i of items) { const k = cats[i.category_id] || 'อื่นๆ'; byCat[k] = byCat[k] || { name: k, qty: 0, amount: 0 }; byCat[k].qty += Number(i.qty); byCat[k].amount += Number(i.amount); }
  const top = items.map((i) => ({ name: i.name, qty: Number(i.qty), amount: Number(i.amount) })).filter((i) => i.qty > 0).sort((a, b) => b.qty - a.qty || b.amount - a.amount);
  const members = orders.filter((o) => o.member_id);
  return {
    first_bill_at: orders[0] ? orders[0].paid_at : null, last_bill_at: orders.length ? orders[orders.length - 1].paid_at : null,
    avg_bill: orders.length ? Math.round(sum(orders, (o) => o.total) / orders.length) : 0,
    items_count: sum(top, (i) => i.qty), packaging: sum(orders, (o) => o.packaging), tax: sum(orders, (o) => o.tax), discount_bills: orders.filter((o) => Number(o.discount) > 0).length,
    by_dine: group((o) => o.dine_type || 'dine_in'), by_source: group((o) => o.source || 'pos'),
    member_bills: members.length, member_sales: sum(members, (o) => o.total), points_given: sum(members, (o) => o.points_earned),
    top_items: top.slice(0, 10), categories: Object.values(byCat).sort((a, b) => b.amount - a.amount),
    hours: Object.entries(hours).map(([h, v]) => ({ hour: Number(h), ...v })).sort((a, b) => a.hour - b.hour),
  };
}
async function shiftDoc(sum, title) {
  const s = await getSettings();
  const names = Object.fromEntries(s.sale.payment_methods.map((m) => [m.id, m.name]));
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  return { store_name: s.store.name, ticket_kind: title, count_unit: s.sale.count_unit || 'ชาม', shift_url: `${base}/s/#${await shiftToken(sum.id)}`,
    shift: { ...sum, payments: sum.payments.map((p) => ({ ...p, name: names[p.method] || p.method })) } };
}

export default r;
