// Member website API. Every query is scoped to req.member.id — a member can only read their own data.
import { Router } from 'express';
import multer from 'multer';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, forbidden, emit, audit, getSettings, token, sha256, addMinutes, rateLimit, randomCode, randomDigits, hashSecret, verifySecret, HttpError } from '../lib/util.js';
import { memberAuth, memberAuthOptional, createSession, revokeSessions } from '../lib/auth.js';
import { createMember, memberPublic, awardOrder, previewPoints, ledger, tierProgress, memberStats } from '../lib/members.js';
import { saveFile } from './system.js';
import { normalizePhone } from '../../public/shared/core.js';

const r = Router();
const upload = multer({ limits: { fileSize: 4 * 1024 * 1024 } });

r.get('/c/config', ah(async (req, res) => {
  const s = await getSettings();
  res.json({ enabled: s.members.enabled, signup: s.members.enabled && s.members.web_signup, fields: s.members.fields, custom_fields: s.members.custom_fields,
    points: { enabled: s.points.enabled, rate_baht: s.points.rate_baht, claim_enabled: s.points.claim_enabled }, verify: s.members.sensitive_verify,
    store: { name: s.store.name, logo: s.store.logo, phone: s.store.phone, address: s.store.address, contact_line: s.store.contact_line },
    mobile: s.mobile.enabled, fonts: s.fonts, colors: { bg: s.display.bg, accent: s.display.accent } });
}));

r.post('/c/register', ah(async (req, res) => {
  rateLimit('reg:' + req.ip, 5, 600000);
  const s = await getSettings();
  if (!s.members.enabled || !s.members.web_signup) throw forbidden('ร้านปิดรับสมัครสมาชิกใหม่ชั่วคราว');
  const m = await createMember(req.body || {}, 'web');
  const tok = await createSession('member', m.id);
  res.json({ token: tok, member: await memberPublic(m), first_login: true, default_password_hint: 'รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทร' });
}));

const LOGIN_MAX = 5;
r.post('/c/login', ah(async (req, res) => {
  rateLimit('login:' + req.ip, 20, 600000);
  const phone = normalizePhone(req.body.phone);
  const m = phone ? await db.get('SELECT * FROM members WHERE phone = ?', [phone]) : null;
  const fail = () => new HttpError(401, 'เบอร์โทรหรือรหัสผ่านไม่ถูกต้อง', 'bad_login');
  if (!m) { verifySecret('x', hashSecret('y')); throw fail(); } // similar timing for unknown phones
  if (m.locked_until && m.locked_until > now()) {
    const sec = Math.ceil((new Date(m.locked_until) - Date.now()) / 1000);
    throw new HttpError(429, `ลองรหัสผิดหลายครั้ง กรุณารอ ${sec} วินาทีแล้วลองใหม่`, 'locked');
  }
  if (!verifySecret(String(req.body.password ?? ''), m.password_hash)) {
    const n = (m.failed_logins || 0) + 1;
    // growing delay: 1, 2, 4, 8 ... minutes after every 5 failures
    const lock = n % LOGIN_MAX === 0 ? addMinutes(2 ** (n / LOGIN_MAX - 1)) : null;
    await db.run('UPDATE members SET failed_logins = ?, locked_until = ? WHERE id = ?', [n, lock, m.id]);
    throw fail();
  }
  if (m.status !== 'active') throw forbidden('บัญชีนี้ถูกระงับ กรุณาติดต่อร้าน');
  await db.run('UPDATE members SET failed_logins = 0, locked_until = NULL WHERE id = ?', [m.id]);
  const tok = await createSession('member', m.id);
  res.json({ token: tok, member: await memberPublic(m), password_is_default: !!m.password_is_default });
}));
r.post('/c/logout', memberAuth(), ah(async (req, res) => { await db.run('UPDATE sessions SET revoked = 1 WHERE token = ?', [req.memberToken]); res.json({ ok: true }); }));

r.get('/c/me', memberAuth(), ah(async (req, res) => {
  const m = req.member;
  const out = await memberPublic(m, { full: true });
  out.progress = await tierProgress(m);
  const st = await memberStats(m.id);
  out.expiring_points = st.expiring_points; out.expiring_first = st.expiring_first;
  out.coupons_active = Number((await db.get("SELECT COUNT(*) AS n FROM coupons WHERE member_id = ? AND status = 'reserved' AND expires_at > ?", [m.id, now()])).n);
  res.json(out);
}));
r.put('/c/me', memberAuth(), upload.single('avatar'), ah(async (req, res) => {
  const s = await getSettings();
  const m = req.member;
  const b = req.body || {};
  const f = s.members.fields;
  // email change is "important": requires extra verification
  if (b.email !== undefined && b.email !== (m.email || '')) await requireVerified(m, 'change_email', b.verification_id);
  if (b.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw bad('รูปแบบอีเมลไม่ถูกต้อง');
  let avatar = m.avatar;
  if (req.file) { if (!/^image\//.test(req.file.mimetype)) throw bad('ต้องเป็นรูปภาพ'); avatar = '/files/' + await saveFile(req.file.buffer, req.file.originalname, req.file.mimetype); }
  const val = (k) => (f[k] && f[k].on && b[k] !== undefined ? String(b[k]).slice(0, 100) : m[k]);
  await db.run('UPDATE members SET first_name = ?, last_name = ?, nickname = ?, birthday = ?, email = ?, avatar = ?, extra = ? WHERE id = ?',
    [val('first_name'), val('last_name'), val('nickname'), val('birthday'), val('email'), avatar, b.extra ? (typeof b.extra === 'string' ? b.extra : S(b.extra)) : m.extra, m.id]);
  await audit('member:' + m.id, 'self_update', 'member', m.id);
  res.json({ ok: true });
}));
r.post('/c/password', memberAuth(), ah(async (req, res) => {
  const m = req.member;
  const { current, next } = req.body || {};
  if (!verifySecret(String(current ?? ''), m.password_hash)) throw bad('รหัสผ่านปัจจุบันไม่ถูกต้อง');
  if (!next || String(next).length < 6) throw bad('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  await db.run('UPDATE members SET password_hash = ?, password_is_default = 0 WHERE id = ?', [hashSecret(String(next)), m.id]);
  await revokeSessions('member', m.id, req.memberToken);
  await audit('member:' + m.id, 'password_change', 'member', m.id);
  res.json({ ok: true });
}));

// ---------- forgot password: request goes to staff; answer never reveals whether the phone exists ----------
r.post('/c/forgot', ah(async (req, res) => {
  rateLimit('forgot:' + req.ip, 5, 3600000);
  const phone = normalizePhone(req.body.phone);
  const generic = { ok: true, message: 'หากเบอร์นี้เป็นสมาชิก ร้านจะติดต่อกลับเพื่อยืนยันตัวตนก่อนรีเซ็ตรหัสผ่าน' };
  if (!phone) return res.json(generic);
  const m = await db.get('SELECT id FROM members WHERE phone = ?', [phone]);
  if (m) {
    const open = await db.get("SELECT id FROM password_resets WHERE member_id = ? AND status IN ('pending','reviewing') AND created_at > ?", [m.id, addMinutes(-24 * 60)]);
    if (!open) {
      await db.run('INSERT INTO password_resets(id, member_id, status, created_at, updated_at, history) VALUES(?,?,?,?,?,?)',
        [id(), m.id, 'pending', now(), now(), S([{ at: now(), action: 'requested', ip: req.ip }])]);
      emit('admin', 'reset:new', {});
      emit('shop', 'reset:new', {});
    }
  }
  res.json(generic);
}));
r.get('/c/forgot/status', ah(async (req, res) => {
  rateLimit('forgots:' + req.ip, 20, 3600000);
  // status is only visible with the one-time reset code (no enumeration by phone)
  res.json({ message: 'ร้านจะติดต่อกลับทางเบอร์โทรที่ลงทะเบียนไว้ เมื่อยืนยันตัวตนแล้วจะได้รับลิงก์ตั้งรหัสผ่านใหม่' });
}));
r.post('/c/reset', ah(async (req, res) => {
  rateLimit('reset:' + req.ip, 10, 3600000);
  const tok = String(req.body.token || '');
  const pr = tok ? await db.get("SELECT * FROM password_resets WHERE token_hash = ? AND status = 'approved'", [sha256(tok)]) : null;
  if (!pr || pr.token_expires < now()) throw bad('ลิงก์รีเซ็ตไม่ถูกต้องหรือหมดอายุ');
  const pw = String(req.body.password || '');
  if (pw.length < 6) throw bad('รหัสผ่านใหม่ต้องมีอย่างน้อย 6 ตัวอักษร');
  await db.tx(async () => {
    const lock = await db.run("UPDATE password_resets SET status = 'done', token_hash = NULL, updated_at = ? WHERE id = ? AND status = 'approved'", [now(), pr.id]);
    if (!lock.changes) throw bad('ลิงก์นี้ถูกใช้แล้ว');
    await db.run("UPDATE password_resets SET status = 'expired' WHERE member_id = ? AND id <> ? AND status IN ('pending','reviewing','approved')", [pr.member_id, pr.id]);
    await db.run('UPDATE members SET password_hash = ?, password_is_default = 0, failed_logins = 0, locked_until = NULL WHERE id = ?', [hashSecret(pw), pr.member_id]);
    await revokeSessions('member', pr.member_id);
  });
  await audit('member:' + pr.member_id, 'password_reset_done', 'member', pr.member_id);
  res.json({ ok: true });
}));

// ---------- extra verification for sensitive actions (claim points, redeem, change important data) ----------
// method 'otp': code sent through the store's SMS webhook; 'staff': customer shows a code that staff enters on the POS;
// 'none': only if the store explicitly chose it.
async function requireVerified(m, purpose, verificationId) {
  const s = await getSettings();
  const method = s.members.sensitive_verify;
  if (method === 'none') return true;
  if (!verificationId) throw new HttpError(428, 'ต้องยืนยันตัวตนเพิ่มเติม', 'verification_required');
  const v = await db.get('SELECT * FROM verifications WHERE id = ? AND member_id = ?', [verificationId, m.id]);
  if (!v || v.purpose !== purpose || v.status !== 'approved' || v.expires_at < now()) throw new HttpError(428, 'การยืนยันตัวตนหมดอายุหรือไม่ถูกต้อง', 'verification_required');
  const used = await db.run("UPDATE verifications SET status = 'used' WHERE id = ? AND status = 'approved'", [v.id]);
  if (!used.changes) throw new HttpError(428, 'การยืนยันนี้ถูกใช้แล้ว', 'verification_required');
  return true;
}
r.post('/c/verify/start', memberAuth(), ah(async (req, res) => {
  rateLimit('vstart:' + req.member.id, 5, 600000);
  const s = await getSettings();
  const method = s.members.sensitive_verify;
  if (method === 'none') return res.json({ method: 'none' });
  const code = randomDigits(6);
  const vid = id();
  await db.run('INSERT INTO verifications(id, member_id, purpose, ref, method, code_hash, status, expires_at, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [vid, req.member.id, String(req.body.purpose || ''), String(req.body.ref || '').slice(0, 80), method, sha256(code), 'pending', addMinutes(10), now()]);
  if (method === 'otp') {
    const url = s.members.otp_webhook_url || process.env.OTP_WEBHOOK_URL;
    if (!url) throw bad('ร้านยังไม่ได้เชื่อมต่อช่องทางส่ง OTP');
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (process.env.OTP_WEBHOOK_TOKEN || '') },
      body: JSON.stringify({ phone: req.member.phone, message: `รหัส OTP ของคุณคือ ${code} (ใช้ได้ 10 นาที)` }) }).catch(() => null);
    if (!resp || !resp.ok) throw bad('ส่ง OTP ไม่สำเร็จ กรุณาลองใหม่หรือติดต่อพนักงาน');
    return res.json({ id: vid, method: 'otp', message: 'ส่งรหัส OTP ไปยังเบอร์ของคุณแล้ว' });
  }
  emit('shop', 'verification:new', { id: vid });
  // staff method: customer shows this code to the cashier, who enters it on the POS
  res.json({ id: vid, method: 'staff', code, message: 'แสดงรหัสนี้ให้พนักงานที่เคาน์เตอร์เพื่อยืนยัน' });
}));
r.post('/c/verify/otp', memberAuth(), ah(async (req, res) => {
  const v = await db.get("SELECT * FROM verifications WHERE id = ? AND member_id = ? AND method = 'otp' AND status = 'pending'", [req.body.id, req.member.id]);
  if (!v || v.expires_at < now()) throw bad('OTP หมดอายุ กรุณาขอรหัสใหม่');
  if (v.attempts >= 5) throw bad('กรอกผิดหลายครั้ง กรุณาขอรหัสใหม่');
  if (v.code_hash !== sha256(String(req.body.code || '').trim())) { await db.run('UPDATE verifications SET attempts = attempts + 1 WHERE id = ?', [v.id]); throw bad('OTP ไม่ถูกต้อง'); }
  await db.run("UPDATE verifications SET status = 'approved' WHERE id = ?", [v.id]);
  res.json({ ok: true });
}));
r.get('/c/verify/:id', memberAuth(), ah(async (req, res) => {
  const v = await db.get('SELECT id, status, method, expires_at FROM verifications WHERE id = ? AND member_id = ?', [req.params.id, req.member.id]);
  if (!v) throw notFound();
  res.json(v);
}));

// ---------- claim points from a receipt QR ----------
async function claimable(tok) {
  const s = await getSettings();
  const o = tok ? await db.get('SELECT * FROM orders WHERE claim_token = ?', [String(tok)]) : null;
  if (!o) throw notFound('ไม่พบบิลจาก QR นี้');
  const deadline = new Date(new Date(o.paid_at || o.created_at).getTime() + (s.points.claim_hours || 72) * 3600000).toISOString();
  let reason = null;
  if (!s.points.enabled || !s.points.claim_enabled) reason = 'ร้านปิดการรับแต้มย้อนหลังชั่วคราว';
  else if (o.status !== 'paid') reason = o.status === 'void' ? 'บิลนี้ถูกยกเลิกแล้ว' : 'บิลนี้ยังไม่ได้ชำระเงิน';
  else if (o.claim_status === 'claimed' || o.member_id || o.points_earned) reason = 'บิลนี้รับแต้มไปแล้ว';
  else if (deadline < now()) reason = 'เลยกำหนดเวลารับแต้มของบิลนี้แล้ว';
  return { o, deadline, reason };
}
r.get('/c/claim/:token', ah(async (req, res) => {
  rateLimit('claimv:' + req.ip, 30, 60000);
  const { o, deadline, reason } = await claimable(req.params.token);
  const me = await memberAuthOptional(req);
  const pv = await previewPoints(o, me);
  res.json({ bill_no: o.bill_no, paid_at: o.paid_at, total: o.total, refunded: o.refunded_amount, base: pv.base, points: reason ? 0 : pv.points, deadline, claimable: !reason, reason });
}));
r.post('/c/claim/:token', memberAuth(), ah(async (req, res) => {
  rateLimit('claim:' + req.member.id, 10, 60000);
  const { o, reason } = await claimable(req.params.token);
  if (reason) throw conflict(reason, 'not_claimable');
  await requireVerified(req.member, 'claim', req.body.verification_id);
  // awardOrder's conditional update makes a bill claimable exactly once, even with simultaneous requests
  const pts = await db.tx(() => awardOrder(o, req.member.id, 'member:' + req.member.id, 'claim'));
  emit('shop', 'orders:changed', { id: o.id });
  emit('admin', 'sales:changed', { id: o.id });
  const m = await db.get('SELECT * FROM members WHERE id = ?', [req.member.id]);
  res.json({ ok: true, points: pts, balance: m.points, bill_no: o.bill_no });
}));

// ---------- history ----------
r.get('/c/bills', memberAuth(), ah(async (req, res) => {
  res.json(await db.all("SELECT id, bill_no, source, status, total, refunded_amount, bowls, points_earned, paid_at, dine_type FROM orders WHERE member_id = ? AND status IN ('paid','void') ORDER BY paid_at DESC LIMIT 100", [req.member.id]));
}));
r.get('/c/bills/:id', memberAuth(), ah(async (req, res) => {
  const o = await db.get('SELECT * FROM orders WHERE id = ? AND member_id = ?', [req.params.id, req.member.id]);
  if (!o) throw notFound();
  const items = await db.all('SELECT name, qty, void_qty, refunded_qty, options, line_total FROM order_items WHERE order_id = ? ORDER BY seq', [o.id]);
  res.json({ bill_no: o.bill_no, queue_no: o.queue_no, paid_at: o.paid_at, total: o.total, discount: o.discount, tax: o.tax, packaging: o.packaging, refunded_amount: o.refunded_amount,
    points_earned: o.points_earned, status: o.status, source: o.source, items: items.map((i) => ({ ...i, options: J(i.options, []).map((x) => ({ group: x.group, name: x.name })) })) });
}));
r.get('/c/points', memberAuth(), ah(async (req, res) => {
  res.json(await db.all('SELECT id, delta, kind, order_id, balance_after, expires_at, reason, created_at FROM point_ledger WHERE member_id = ? ORDER BY created_at DESC LIMIT 200', [req.member.id]));
}));

// ---------- rewards ----------
async function rewardAvailability(rw, m) {
  const tiers = J(rw.tier_ids, []);
  const used = await db.get("SELECT COUNT(*) AS n FROM coupons WHERE reward_id = ? AND member_id = ? AND status IN ('reserved','used')", [rw.id, m.id]);
  const t = now();
  let reason = null;
  if (!rw.active) reason = 'ปิดการแลกชั่วคราว';
  else if (rw.starts_at && rw.starts_at > t) reason = 'ยังไม่ถึงวันเริ่มแลก';
  else if (rw.ends_at && rw.ends_at < t) reason = 'หมดเขตแลกแล้ว';
  else if (tiers.length && !tiers.includes(m.tier_id)) reason = 'เฉพาะสมาชิก Tier ที่กำหนด';
  else if (rw.total_limit && rw.issued_count >= rw.total_limit) reason = 'สิทธิ์เต็มแล้ว';
  else if (rw.per_member_limit && Number(used.n) >= rw.per_member_limit) reason = 'ใช้สิทธิ์ครบแล้ว';
  else if (m.points < rw.points) reason = 'แต้มไม่พอ';
  return reason;
}
r.get('/c/rewards', memberAuth(), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM rewards WHERE active = 1 ORDER BY points');
  res.json(await Promise.all(rows.map(async (rw) => ({ id: rw.id, name: rw.name, description: rw.description, image: rw.image, points: rw.points, coupon_days: rw.coupon_days,
    ends_at: rw.ends_at, terms: rw.terms, return_policy: rw.return_policy, remaining: rw.total_limit ? Math.max(0, rw.total_limit - rw.issued_count) : null,
    unavailable: await rewardAvailability(rw, req.member) }))));
}));
r.post('/c/rewards/:id/redeem', memberAuth(), ah(async (req, res) => {
  rateLimit('redeem:' + req.member.id, 10, 60000);
  const out = await db.tx(async () => {
    const rw = await db.get('SELECT * FROM rewards WHERE id = ?', [req.params.id]);
    if (!rw) throw notFound('ไม่พบรางวัล');
    const m = await db.get('SELECT * FROM members WHERE id = ?', [req.member.id]);
    const why = await rewardAvailability(rw, m);
    if (why) throw conflict(why, 'not_available');
    await requireVerified(m, 'redeem', req.body.verification_id);
    // quota: conditional increment cannot oversell
    const q = await db.run('UPDATE rewards SET issued_count = issued_count + 1 WHERE id = ? AND (total_limit = 0 OR issued_count < total_limit)', [rw.id]);
    if (!q.changes) throw conflict('สิทธิ์เต็มแล้ว');
    const cid = id();
    // the code is random — not the member number and not personal data
    let code;
    for (let i = 0; i < 5; i++) { code = randomCode(10); if (!(await db.get('SELECT id FROM coupons WHERE code = ?', [code]))) break; }
    await ledger(m.id, -rw.points, 'redeem_hold', { ref: cid, actor: 'member:' + m.id, reason: 'สำรองแต้มแลก ' + rw.name, unique_key: req.body.idempotency_key ? 'rd:' + m.id + ':' + req.body.idempotency_key : null });
    await db.run('UPDATE members SET reserved_points = reserved_points + ? WHERE id = ?', [rw.points, m.id]);
    const exp = addMinutes((rw.coupon_days || 7) * 1440);
    await db.run('INSERT INTO coupons(id, code, member_id, reward_id, points, status, created_at, expires_at, cost) VALUES(?,?,?,?,?,?,?,?,?)',
      [cid, code, m.id, rw.id, rw.points, 'reserved', now(), exp, rw.cost || 0]);
    return { id: cid, code, expires_at: exp, reward: rw.name };
  });
  res.json(out);
}));
r.get('/c/coupons', memberAuth(), ah(async (req, res) => {
  res.json(await db.all('SELECT c.id, c.code, c.status, c.created_at, c.expires_at, c.used_at, c.points, r.name AS reward_name, r.image, r.terms FROM coupons c LEFT JOIN rewards r ON r.id = c.reward_id WHERE c.member_id = ? ORDER BY c.created_at DESC', [req.member.id]));
}));
r.post('/c/coupons/:id/cancel', memberAuth(), ah(async (req, res) => {
  const c = await db.get('SELECT * FROM coupons WHERE id = ? AND member_id = ?', [req.params.id, req.member.id]);
  if (!c) throw notFound();
  await releaseCoupon(c, 'cancelled', 'member:' + req.member.id);
  res.json({ ok: true });
}));
r.get('/c/benefits', memberAuth(), ah(async (req, res) => res.json(await db.all('SELECT id, name, color, icon, benefits, multiplier, discount_pct, min_spent, min_visits, sort FROM tiers WHERE active = 1 ORDER BY sort'))));

// Release reserved points when a coupon expires or is cancelled (per reward policy)
export async function releaseCoupon(c, status, actor) {
  return db.tx(async () => {
    const lock = await db.run('UPDATE coupons SET status = ? WHERE id = ? AND status = ?', [status, c.id, 'reserved']);
    if (!lock.changes) throw conflict('คูปองนี้ใช้หรือยกเลิกไปแล้ว');
    const rw = await db.get('SELECT * FROM rewards WHERE id = ?', [c.reward_id]);
    await db.run('UPDATE members SET reserved_points = reserved_points - ? WHERE id = ?', [c.points, c.member_id]);
    if (!rw || rw.return_policy !== 'forfeit') {
      await ledger(c.member_id, c.points, 'redeem_release', { ref: c.id, actor, reason: status === 'expired' ? 'คืนแต้มคูปองหมดอายุ' : 'คืนแต้มคูปองที่ยกเลิก', unique_key: 'release:' + c.id });
      await db.run('UPDATE rewards SET issued_count = issued_count - 1 WHERE id = ? AND issued_count > 0', [c.reward_id]);
    } else {
      await db.run("UPDATE point_ledger SET kind = 'redeem', reason = ? WHERE ref = ? AND kind = 'redeem_hold'", ['คูปองหมดอายุ (ไม่คืนแต้มตามเงื่อนไข)', c.id]);
    }
  });
}
export async function expireCoupons() {
  const rows = await db.all("SELECT * FROM coupons WHERE status = 'reserved' AND expires_at < ?", [now()]);
  for (const c of rows) await releaseCoupon(c, 'expired', 'system').catch(() => {});
}

export default r;
