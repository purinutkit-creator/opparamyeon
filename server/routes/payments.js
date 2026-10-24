import { Router } from 'express';
import express from 'express';
import multer from 'multer';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, forbidden, emit, getSettings, rateLimit, audit, getSecret, setSecret } from '../lib/util.js';
import { staffAuth } from '../lib/auth.js';
import { getOrder, payOrder, idemRetry } from '../lib/orders.js';
import { GATEWAYS, beamCreds } from '../lib/gateways.js';
import { saveFile } from './system.js';
import { promptPayPayload } from '../../public/shared/core.js';

const r = Router();
const upload = multer({ limits: { fileSize: 8 * 1024 * 1024 } });

async function mobileOrder(req) {
  const tok = req.headers['x-mobile-token'] || '';
  const ms = tok ? await db.get('SELECT * FROM mobile_sessions WHERE token = ?', [tok]) : null;
  if (!ms) throw forbidden('QR ไม่ถูกต้อง');
  const o = await getOrder(req.params.id);
  if (o.mobile_session_id !== ms.id) throw notFound();
  return o;
}

// PromptPay QR with the exact order amount (computed on the server)
export async function promptPayFor(amount, ref) {
  const s = await getSettings();
  if (!s.payment.promptpay_id) throw bad('ร้านยังไม่ได้ตั้งค่าพร้อมเพย์');
  return { payload: promptPayPayload(s.payment.promptpay_id, amount), name: s.payment.promptpay_name, amount, ref,
    note: 'โอนตามยอดที่แสดงเท่านั้น ระบบจะยืนยันหลังพนักงานตรวจสอบยอดเงินเข้า' };
}
r.get('/payments/promptpay', staffAuth('sell'), ah(async (req, res) => res.json(await promptPayFor(Math.round(Number(req.query.amount)), req.query.ref || ''))));
r.get('/m/orders/:id/promptpay', ah(async (req, res) => {
  const o = await mobileOrder(req);
  if (o.status !== 'pending_payment') throw conflict('ออเดอร์นี้ไม่อยู่ในสถานะรอชำระ');
  res.json(await promptPayFor(o.total, o.bill_no));
}));
// Customer uploads a transfer slip. This never marks the order paid — staff must verify.
r.post('/m/orders/:id/slip', upload.single('file'), ah(async (req, res) => {
  rateLimit('slip:' + req.ip, 6, 60000);
  const o = await mobileOrder(req);
  if (o.status !== 'pending_payment') throw conflict('ออเดอร์นี้ไม่อยู่ในสถานะรอชำระ');
  if (!req.file || !/^image\//.test(req.file.mimetype)) throw bad('กรุณาแนบรูปสลิป');
  const fid = await saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
  await db.run("INSERT INTO payment_intents(id, order_id, provider, amount, status, url, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)",
    [id(), o.id, 'slip', o.total, 'pending_review', '/files/' + fid, now(), now()]);
  await db.run("UPDATE orders SET verify_status = 'pending' WHERE id = ?", [o.id]);
  emit('shop', 'mobile:slip', { id: o.id, bill_no: o.bill_no, slip: '/files/' + fid, total: o.total });
  emit('shop', 'orders:changed', { id: o.id });
  res.json({ ok: true, message: 'ส่งหลักฐานแล้ว รอพนักงานตรวจสอบ' });
}));
r.get('/orders/:id/slips', staffAuth('verify_payment'), ah(async (req, res) => res.json(await db.all("SELECT * FROM payment_intents WHERE order_id = ? ORDER BY created_at DESC", [req.params.id]))));

// Online gateway charge
r.post('/m/orders/:id/gateway', ah(async (req, res) => {
  rateLimit('gw:' + req.ip, 10, 60000);
  const o = await mobileOrder(req);
  if (o.status !== 'pending_payment') throw conflict('ออเดอร์นี้ไม่อยู่ในสถานะรอชำระ');
  const s = await getSettings();
  const pid = (s.payment.providers.beam || {}).enabled ? 'beam' : s.payment.mock_enabled ? 'mock' : null;
  if (!pid) throw bad('ร้านยังไม่ได้เปิดชำระออนไลน์');
  const gw = GATEWAYS[pid];
  if (!(await gw.configured())) throw bad('ยังไม่ได้ตั้งค่าข้อมูลเชื่อมต่อผู้ให้บริการบนเซิร์ฟเวอร์');
  const existing = await db.get("SELECT * FROM payment_intents WHERE order_id = ? AND provider = ? AND status = 'pending' AND amount = ?", [o.id, pid, o.total]);
  if (existing) return res.json({ url: existing.url, provider: pid });
  const c = await gw.createCharge(o, { mode: (s.payment.providers.beam || {}).mode, redirectUrl: `${process.env.PUBLIC_URL || ''}/m/#${req.headers['x-mobile-token']}`, expiresAt: o.expires_at });
  await db.run('INSERT INTO payment_intents(id, order_id, provider, provider_ref, amount, status, url, created_at, updated_at, raw) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [id(), o.id, pid, c.provider_ref, o.total, 'pending', c.url, now(), now(), S(c.raw || null)]);
  res.json({ url: c.url, provider: pid });
}));

// Webhook: signature check → de-duplicate → confirm with the provider's API → mark paid (idempotent)
export const webhookRouter = Router();
webhookRouter.post('/webhooks/:provider', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const gw = GATEWAYS[req.params.provider];
  if (!gw) return res.status(404).end();
  const s = await getSettings();
  if (gw.id === 'mock' && !s.payment.mock_enabled) return res.status(404).end();
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
  if (!(await gw.verifyWebhook(raw, req.headers))) { await logEvent(gw.id, null, raw, 'bad_signature'); return res.status(401).json({ error: 'bad signature' }); }
  let j; try { j = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  const ev = gw.parseWebhook(j, req.headers);
  const fresh = await logEvent(gw.id, ev.event_key, raw, 'received');
  if (!fresh) return res.json({ ok: true, duplicate: true });
  const result = await settleIntent(gw, ev.provider_ref, ev.paid);
  await db.run('UPDATE webhook_events SET status = ?, note = ? WHERE event_key = ?', [result.status, result.note || null, ev.event_key]);
  res.json({ ok: true, ...result });
}));
async function logEvent(provider, key, raw, status) {
  try {
    await db.run('INSERT INTO webhook_events(id, provider, event_key, payload, status, created_at) VALUES(?,?,?,?,?,?)', [id(), provider, key || 'bad:' + id(), raw.toString('utf8').slice(0, 20000), status, now()]);
    return true;
  } catch (e) { if (/unique|UNIQUE|duplicate/i.test(e.message)) return false; throw e; }
}
export async function settleIntent(gw, ref, claimedPaid) {
  const intent = await db.get('SELECT * FROM payment_intents WHERE provider = ? AND provider_ref = ?', [gw.id, ref]);
  if (!intent) return { status: 'unknown_intent' };
  if (intent.status === 'paid') return { status: 'already_paid' };
  if (!claimedPaid) {
    await db.run("UPDATE payment_intents SET status = 'failed', updated_at = ? WHERE id = ? AND status = 'pending'", [now(), intent.id]);
    return { status: 'not_paid' };
  }
  const s = await getSettings();
  // never trust the webhook body alone: ask the provider and compare amount + reference
  const st = await gw.fetchStatus(ref, { mode: (s.payment.providers.beam || {}).mode });
  if (!st.paid) return { status: 'unconfirmed' };
  if (Number(st.amount) !== intent.amount || (st.reference && st.reference !== intent.order_id)) {
    await db.run("UPDATE payment_intents SET status = 'mismatch', updated_at = ? WHERE id = ?", [now(), intent.id]);
    emit('admin', 'payment:alert', { order_id: intent.order_id, message: 'ยอดเงิน/เลขอ้างอิงจากผู้ให้บริการไม่ตรงกับออเดอร์' });
    return { status: 'mismatch' };
  }
  const lock = await db.run("UPDATE payment_intents SET status = 'paid', updated_at = ? WHERE id = ? AND status IN ('pending','failed')", [now(), intent.id]);
  if (!lock.changes) return { status: 'already_paid' };
  const o = await getOrder(intent.order_id);
  if (o.status !== 'pending_payment' || o.total !== intent.amount) {
    // paid after the order expired / was cancelled / changed: keep the money record and alert staff for refund or re-open
    await db.run("INSERT INTO payments(id, order_id, method, amount, status, provider, provider_ref, created_at, meta) VALUES(?,?,?,?,?,?,?,?,?)",
      [id(), o.id, 'online', intent.amount, 'needs_review', gw.id, gw.id + ':' + ref, now(), S({ reason: 'paid_after_' + o.status })]);
    emit('shop', 'payment:alert', { order_id: o.id, bill_no: o.bill_no, message: `ได้รับเงินออนไลน์หลังออเดอร์${o.status === 'expired' ? 'หมดอายุ' : 'เปลี่ยนสถานะ'} — ตรวจสอบและคืนเงินหรือเปิดออเดอร์ใหม่` });
    return { status: 'needs_review' };
  }
  try {
    await idemRetry(() => payOrder({ orderId: o.id, payments: [{ method: 'online', amount: intent.amount, ref }], staff: null, idempotencyKey: gw.id + ':' + ref, provider: gw.id }));
  } catch (e) {
    if (e.code !== 'already_paid') throw e;
  }
  emit('shop', 'mobile:paid', { id: o.id, bill_no: o.bill_no });
  return { status: 'paid' };
}

// ---------- gateway keys entered by the shop (write-only from the browser) ----------
r.get('/payments/providers/beam', staffAuth('settings'), ah(async (req, res) => {
  const c = await beamCreds();
  const mask = (v) => (v ? v.slice(0, 3) + '•••' + v.slice(-3) : '');
  res.json({ merchant_id: c.merchantId, api_key_set: !!c.apiKey, api_key_hint: mask(c.apiKey), webhook_secret_set: !!c.webhookSecret, webhook_secret_hint: mask(c.webhookSecret),
    webhook_url: (process.env.PUBLIC_URL || '') + '/api/webhooks/beam', from_env: !(await getSecret('beam.api_key')) && !!process.env.BEAM_API_KEY });
}));
r.put('/payments/providers/beam', staffAuth('settings'), ah(async (req, res) => {
  const b = req.body || {};
  if (b.merchant_id !== undefined) await setSecret('beam.merchant_id', String(b.merchant_id).trim());
  if (b.api_key) await setSecret('beam.api_key', String(b.api_key).trim());           // blank = keep the saved key
  if (b.webhook_secret) await setSecret('beam.webhook_secret', String(b.webhook_secret).trim());
  if (b.clear) for (const k of ['beam.merchant_id', 'beam.api_key', 'beam.webhook_secret']) await setSecret(k, null);
  await audit(req.staff.id, 'beam_keys', 'settings', 'beam', null, { merchant_id: b.merchant_id, api_key: b.api_key ? 'changed' : 'kept', webhook_secret: b.webhook_secret ? 'changed' : 'kept', clear: !!b.clear });
  res.json({ ok: true });
}));
r.post('/payments/providers/beam/test', staffAuth('settings'), ah(async (req, res) => {
  const s = await getSettings();
  if (!(await GATEWAYS.beam.configured())) return res.json({ ok: false, message: 'กรอก Merchant ID, API Key และ Webhook HMAC Key ให้ครบก่อน' });
  res.json(await GATEWAYS.beam.test((s.payment.providers.beam || {}).mode));
}));

// mock checkout page calls this to simulate the provider (only when mock is enabled)
r.post('/payments/mock/:ref/complete', ah(async (req, res) => {
  const s = await getSettings();
  if (!s.payment.mock_enabled) throw forbidden();
  const gw = GATEWAYS.mock;
  if (!gw.markPaid(req.params.ref)) throw notFound();
  const raw = Buffer.from(JSON.stringify({ event: 'paid', ref: req.params.ref }));
  const port = req.socket.localPort;
  const resp = await fetch(`http://127.0.0.1:${port}/api/webhooks/mock`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-mock-signature': gw.sign(raw) }, body: raw });
  res.json(await resp.json());
}));

// staff can re-check a pending online payment manually
r.post('/orders/:id/payment-recheck', staffAuth('verify_payment'), ah(async (req, res) => {
  const intents = await db.all("SELECT * FROM payment_intents WHERE order_id = ? AND provider IN ('beam','mock') AND status IN ('pending','failed')", [req.params.id]);
  const out = [];
  for (const i of intents) {
    const gw = GATEWAYS[i.provider];
    const st = await gw.fetchStatus(i.provider_ref, { mode: ((await getSettings()).payment.providers.beam || {}).mode }).catch((e) => ({ error: e.message }));
    if (st.paid) out.push(await settleIntent(gw, i.provider_ref, true)); else out.push({ status: st.error ? 'error' : 'not_paid', error: st.error });
  }
  await audit(req.staff.id, 'payment_recheck', 'order', req.params.id, null, out);
  res.json(out);
}));

export default r;
