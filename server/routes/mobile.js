// Mobile Ordering: one-time QR sessions for a table or a pickup, issued only when staff asks.
import { Router } from 'express';
import { db, J } from '../db.js';
import { ah, id, now, token, bad, notFound, conflict, forbidden, emit, addMinutes, getSettings, rateLimit, audit, randomCode } from '../lib/util.js';
import { staffAuth, requirePerm } from '../lib/auth.js';
import { saveOrder, getOrder, orderFull, sendKitchen, freeTableIfIdle, voidOrder, idemRetry } from '../lib/orders.js';
import { enqueue, storeData, fmtDate } from '../lib/print.js';
import { catalog } from './catalog.js';
import { dineLabel } from '../../public/shared/core.js';

const r = Router();
const base = () => process.env.PUBLIC_URL || '';

export async function createMobileSession({ mode, table_id = null, origin_order_id = null, staff, hours, single_use, allow_table_change }) {
  const s = await getSettings();
  if (!s.mobile.enabled) throw bad('ร้านยังไม่ได้เปิดใช้ Mobile Ordering');
  if (mode === 'table') {
    const t = table_id ? await db.get('SELECT * FROM dining_tables WHERE id = ? AND active = 1', [table_id]) : null;
    if (table_id && !t) throw bad('โต๊ะนี้ปิดใช้งาน');
  }
  const sid = id();
  const tok = token(24); // unguessable; the table/bill number alone is never a credential
  const ref = 'MO-' + randomCode(6);
  await db.run(`INSERT INTO mobile_sessions(id, token, ref, mode, table_id, origin_order_id, status, single_use, expires_at, created_by, created_at, allow_table_change)
    VALUES(?,?,?,?,?,?,'active',?,?,?,?,?)`, [sid, tok, ref, mode, table_id, origin_order_id, (single_use ?? s.mobile.single_order) ? 1 : 0,
    addMinutes((Number(hours) || s.mobile.qr_hours || 3) * 60), staff ? staff.id : null, now(), (allow_table_change ?? s.mobile.allow_table_change) ? 1 : 0]);
  if (table_id) await db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ? AND status = 'free'", [table_id]);
  return db.get('SELECT * FROM mobile_sessions WHERE id = ?', [sid]);
}
async function mobileDoc(ms) {
  const t = ms.table_id ? await db.get('SELECT name FROM dining_tables WHERE id = ?', [ms.table_id]) : null;
  return { ...(await storeData()), mobile_url: `${base()}/m/#${ms.token}`, mobile_ref: ms.ref, mobile_target: ms.mode === 'table' ? `โต๊ะ ${t ? t.name : '-'}` : 'Pick Up',
    mobile_expires: fmtDate(ms.expires_at), table_name: t ? t.name : '', datetime: fmtDate(ms.created_at) };
}
// Print (or reprint) the Mobile Ordering slip for an existing bill. Reprint reuses the same session (same token).
export async function issueMobileForOrder(orderId, staff, opts = {}) {
  const o = await getOrder(orderId);
  let ms = await db.get("SELECT * FROM mobile_sessions WHERE origin_order_id = ? AND status = 'active' AND expires_at > ?", [o.id, now()]);
  if (!ms) ms = await createMobileSession({ mode: o.table_id ? 'table' : opts.mode || 'pickup', table_id: o.table_id, origin_order_id: o.id, staff, hours: opts.hours, single_use: opts.single_use });
  const prev = await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE ref_id = ? AND doc_type = 'mobile_qr'", [ms.id]);
  const jobs = await enqueue('mobile_qr', ms.id, await mobileDoc(ms), { dedupe: `mobile_qr:${ms.id}:${Number(prev.n)}`, printerId: opts.printer_id || null });
  await audit(staff.id, 'print_mobile_qr', 'mobile_session', ms.id, null, { order_id: o.id, reprint: Number(prev.n) > 0 });
  return { session: publicSession(ms), jobs, url: `${base()}/m/#${ms.token}` };
}
const publicSession = (ms) => ({ id: ms.id, ref: ms.ref, mode: ms.mode, table_id: ms.table_id, status: ms.status, single_use: !!ms.single_use, used_count: ms.used_count,
  expires_at: ms.expires_at, created_at: ms.created_at, token: ms.token });

// ---------- staff side ----------
r.post('/mobile/sessions', staffAuth('print_mobile_qr'), ah(async (req, res) => {
  const ms = await createMobileSession({ ...req.body, staff: req.staff });
  let jobs = [];
  if (req.body.print !== false) jobs = await enqueue('mobile_qr', ms.id, await mobileDoc(ms), { dedupe: `mobile_qr:${ms.id}:0`, printerId: req.body.printer_id || null });
  await audit(req.staff.id, 'print_mobile_qr', 'mobile_session', ms.id, null, { mode: ms.mode, table_id: ms.table_id });
  res.json({ session: publicSession(ms), jobs, url: `${base()}/m/#${ms.token}` });
}));
r.get('/mobile/sessions', staffAuth(), ah(async (req, res) => {
  const rows = await db.all(`SELECT m.*, t.name AS table_name FROM mobile_sessions m LEFT JOIN dining_tables t ON t.id = m.table_id
    WHERE m.status = 'active' OR m.created_at > ? ORDER BY m.created_at DESC LIMIT 100`, [addMinutes(-24 * 60)]);
  res.json(rows.map((x) => ({ ...publicSession(x), table_name: x.table_name, closed_reason: x.closed_reason })));
}));
r.post('/mobile/sessions/:id/reprint', staffAuth('print_mobile_qr'), ah(async (req, res) => {
  const ms = await db.get('SELECT * FROM mobile_sessions WHERE id = ?', [req.params.id]);
  if (!ms) throw notFound();
  if (ms.status !== 'active' || ms.expires_at < now()) throw conflict('QR นี้หมดอายุหรือปิดแล้ว ออกใบใหม่แทน');
  const prev = await db.get("SELECT COUNT(*) AS n FROM print_jobs WHERE ref_id = ? AND doc_type = 'mobile_qr'", [ms.id]);
  res.json({ jobs: await enqueue('mobile_qr', ms.id, await mobileDoc(ms), { dedupe: `mobile_qr:${ms.id}:${Number(prev.n)}` }) });
}));
// close the ordering round (separate from closing the bill)
r.post('/mobile/sessions/:id/close', staffAuth('sell'), ah(async (req, res) => {
  const ms = await db.get('SELECT * FROM mobile_sessions WHERE id = ?', [req.params.id]);
  if (!ms) throw notFound();
  await db.run("UPDATE mobile_sessions SET status = ?, closed_at = ?, closed_reason = ? WHERE id = ? AND status = 'active'", [req.body.revoke ? 'revoked' : 'closed', now(), req.body.reason || 'staff', ms.id]);
  emit('mobile:' + ms.id, 'session:closed', {});
  if (req.body.free_table && ms.table_id) await freeTableIfIdle(ms.table_id);
  await audit(req.staff.id, 'mobile_close', 'mobile_session', ms.id, null, null, req.body.reason);
  res.json({ ok: true });
}));
r.post('/tables/:id/close', staffAuth('sell'), ah(async (req, res) => {
  // closing a table ends all ordering rounds bound to it
  const open = await db.get("SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status IN ('held','open','pending_payment')", [req.params.id]);
  if (Number(open.n) && !req.body.force) throw conflict('ยังมีบิลค้างชำระที่โต๊ะนี้');
  const sessions = await db.all("SELECT id FROM mobile_sessions WHERE table_id = ? AND status = 'active'", [req.params.id]);
  await db.run("UPDATE mobile_sessions SET status = 'closed', closed_at = ?, closed_reason = 'table_closed' WHERE table_id = ? AND status = 'active'", [now(), req.params.id]);
  for (const s of sessions) emit('mobile:' + s.id, 'session:closed', {});
  await db.run("UPDATE dining_tables SET status = 'free' WHERE id = ? AND status <> 'disabled'", [req.params.id]);
  emit('shop', 'tables:changed', {});
  res.json({ ok: true });
}));

// ---------- customer side (token in URL fragment, sent as header) ----------
async function sessionFrom(req, { forOrder = false } = {}) {
  const tok = req.headers['x-mobile-token'] || '';
  const ms = tok ? await db.get('SELECT * FROM mobile_sessions WHERE token = ?', [tok]) : null;
  if (!ms) throw forbidden('QR ไม่ถูกต้อง');
  const expired = ms.expires_at < now();
  if (expired && ms.status === 'active') await db.run("UPDATE mobile_sessions SET status = 'expired' WHERE id = ? AND status = 'active'", [ms.id]);
  if (forOrder) {
    if (expired || ms.status !== 'active') throw forbidden(ms.status === 'closed' || ms.status === 'revoked' ? 'รอบการสั่งอาหารนี้ปิดแล้ว' : 'QR หมดอายุแล้ว', 'session_closed');
    if (ms.single_use && ms.used_count > 0) throw forbidden('QR นี้ใช้ส่งออเดอร์ได้ครั้งเดียวและถูกใช้แล้ว', 'session_used');
  }
  return { ...ms, status: expired && ms.status === 'active' ? 'expired' : ms.status };
}
r.get('/m/session', ah(async (req, res) => {
  const ms = await sessionFrom(req);
  const s = await getSettings();
  const tables = await db.all('SELECT id, name, zone, seats, status FROM dining_tables WHERE active = 1 ORDER BY sort, name');
  const orders = await db.all('SELECT id, bill_no, queue_no, status, prep_status, total, bowls, created_at, pay_mode, verify_status, dine_type, table_name, customer_name FROM orders WHERE mobile_session_id = ? ORDER BY created_at', [ms.id]);
  const st = await storeData();
  res.json({
    session: { ref: ms.ref, mode: ms.mode, table_id: ms.table_id, status: ms.status, single_use: !!ms.single_use, used_count: ms.used_count, expires_at: ms.expires_at,
      can_order: ms.status === 'active' && !(ms.single_use && ms.used_count > 0), allow_table_change: !!ms.allow_table_change, id: ms.id },
    store: { name: st.store_name, logo: st.logo, phone: st.phone },
    options: { table_enabled: s.mobile.table_enabled && tables.length > 0, pickup_enabled: s.mobile.pickup_enabled, pickup_phone_required: s.mobile.pickup_phone_required,
      pay_cashier: s.mobile.pay_cashier, pay_online: s.mobile.pay_online && (!!s.payment.promptpay_id || !!(s.payment.providers.beam || {}).enabled || s.payment.mock_enabled),
      promptpay: !!s.payment.promptpay_id, slip_upload: s.payment.slip_upload, gateway: (s.payment.providers.beam || {}).enabled ? 'beam' : s.payment.mock_enabled ? 'mock' : null,
      has_tables: tables.length > 0, any_table_free: tables.some((t) => t.status === 'free') },
    tables: tables.map((t) => ({ id: t.id, name: t.name, zone: t.zone, available: t.status === 'free' || t.id === ms.table_id })),
    orders,
  });
}));
r.get('/m/menu', ah(async (req, res) => { await sessionFrom(req); res.json(await catalog({ mobile: true })); }));
r.get('/m/orders/:id', ah(async (req, res) => {
  const ms = await sessionFrom(req);
  const o = await orderFull(req.params.id);
  if (o.mobile_session_id !== ms.id) throw notFound();
  res.json({ id: o.id, bill_no: o.bill_no, queue_no: o.queue_no, status: o.status, prep_status: o.prep_status, total: o.total, bowls: o.bowls, items_total: o.items_total,
    discount: o.discount, packaging: o.packaging, tax: o.tax, pay_mode: o.pay_mode, verify_status: o.verify_status, dine_type: o.dine_type, table_name: o.table_name,
    customer_name: o.customer_name, created_at: o.created_at, expires_at: o.expires_at,
    items: o.items.map((i) => ({ name: i.name, qty: i.qty - i.void_qty, options: i.options.map((x) => ({ group: x.group, name: x.name })), note: i.note, line_total: i.line_total })),
    payments: o.payments.filter((p) => p.status === 'paid').map((p) => ({ method: p.method, amount: p.amount })) });
}));

// Place an order. Prices, stock and options are re-validated on the server; the client total is ignored.
r.post('/m/orders', ah(async (req, res) => {
  rateLimit('mo:' + req.ip, 20, 60000);
  const ms = await sessionFrom(req, { forOrder: true });
  const s = await getSettings();
  const b = req.body || {};
  if (!b.idempotency_key || String(b.idempotency_key).length < 8) throw bad('missing idempotency_key');
  const findDup = () => db.get('SELECT id FROM orders WHERE idempotency_key = ?', ['m:' + b.idempotency_key]);
  const dup = await findDup();
  if (dup) return res.json({ id: dup.id, duplicate: true });
  let mode = ms.mode === 'table' ? 'table' : b.mode === 'table' ? 'table' : 'pickup';
  let tableId = null;
  if (mode === 'table') {
    if (!s.mobile.table_enabled) throw bad('ร้านไม่ได้เปิดสั่งแบบทานที่ร้าน');
    tableId = ms.table_id && !(ms.allow_table_change && b.table_id) ? ms.table_id : b.table_id;
    const t = tableId ? await db.get('SELECT * FROM dining_tables WHERE id = ? AND active = 1', [tableId]) : null;
    if (!t) throw bad('กรุณาเลือกโต๊ะ');
    if (t.status !== 'free' && t.id !== ms.table_id) throw conflict('โต๊ะนี้ไม่ว่าง กรุณาเลือกโต๊ะอื่นหรือเลือก Pick Up', 'table_busy');
  } else {
    if (!s.mobile.pickup_enabled) throw bad('ร้านไม่ได้เปิด Pick Up');
    if (!String(b.customer_name || '').trim()) throw bad('กรุณากรอกชื่อผู้รับ');
    if (s.mobile.pickup_phone_required && !/^0\d{8,9}$/.test(String(b.customer_phone || '').replace(/\D/g, ''))) throw bad('กรุณากรอกเบอร์ติดต่อ');
  }
  const payMode = b.pay_mode === 'online' ? 'online' : 'cashier';
  if (payMode === 'cashier' && !s.mobile.pay_cashier) throw bad('ร้านไม่ได้เปิดชำระที่แคชเชียร์');
  if (payMode === 'online' && !s.mobile.pay_online) throw bad('ร้านไม่ได้เปิดชำระออนไลน์');
  const lines = (b.lines || []).map((l) => ({ product_id: l.product_id, qty: l.qty, options: l.options || [], note: l.note, bowl_group: l.bowl_group,
    dine_type: mode === 'table' ? 'dine_in' : 'takeaway' }));
  if (!lines.length) throw bad('ตะกร้าว่าง');
  let out;
  try { out = await db.tx(async () => {
    // single-use QR: the conditional increment is the lock — two phones submitting together cannot both pass
    const use = await db.run(`UPDATE mobile_sessions SET used_count = used_count + 1 WHERE id = ? AND status = 'active' AND (single_use = 0 OR used_count = 0)`, [ms.id]);
    if (!use.changes) throw forbidden('QR นี้ใช้ส่งออเดอร์ไปแล้ว', 'session_used');
    const { order } = await saveOrder({ cart: { lines, table_id: tableId, customer_name: b.customer_name, customer_phone: b.customer_phone, note: b.note },
      source: mode === 'table' ? 'mobile_table' : 'mobile_pickup', mobileSessionId: ms.id, idempotencyKey: 'm:' + b.idempotency_key, action: 'save', payMode });
    const kitchenRule = mode === 'table' ? s.mobile.table_kitchen : s.mobile.pickup_kitchen;
    await db.run("UPDATE orders SET status = 'pending_payment', expires_at = ?, prep_status = 'none' WHERE id = ?",
      [addMinutes(s.mobile.cashier_expire_minutes || 30), order.id]);
    let o = await getOrder(order.id);
    if (kitchenRule === 'immediately') { await sendKitchen(o, null, null, null); o = await getOrder(order.id); }
    return o;
  }); } catch (e) {
    // a simultaneous duplicate submission (network retry) → answer with the order that won
    if (/23505|unique/i.test(`${e.code || ''} ${e.message || ''}`)) { const d = await findDup(); if (d) return res.json({ id: d.id, duplicate: true }); }
    throw e;
  }
  emit('shop', 'mobile:new_order', { id: out.id, bill_no: out.bill_no, customer_name: out.customer_name, table_name: out.table_name, total: out.total, bowls: out.bowls,
    pay_mode: payMode, status: 'pending_payment', source: out.source });
  emit('shop', 'orders:changed', { id: out.id });
  res.json({ id: out.id, bill_no: out.bill_no, queue_no: out.queue_no, total: out.total, status: out.status });
}));
r.post('/m/orders/:id/cancel', ah(async (req, res) => {
  const ms = await sessionFrom(req);
  const o = await getOrder(req.params.id);
  if (o.mobile_session_id !== ms.id) throw notFound();
  if (o.status !== 'pending_payment' || o.prep_status !== 'none') throw conflict('ยกเลิกเองไม่ได้ กรุณาติดต่อพนักงาน');
  await voidOrder({ orderId: o.id, staff: { id: 'customer', name: 'ลูกค้า' }, reason: 'ลูกค้ายกเลิกผ่านมือถือ' });
  res.json({ ok: true });
}));

export default r;
