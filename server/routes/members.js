// Staff/admin side of membership: search, detail, adjustments, tiers, rewards, coupon redemption, reset requests
import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, forbidden, emit, audit, getSettings, token, sha256, addMinutes, businessDateOf } from '../lib/util.js';
import { staffAuth, can, requirePerm, revokeSessions } from '../lib/auth.js';
import { createMember, memberPublic, ledger, recomputeTier, tierProgress, memberStats, findMember, getMemberOr404 } from '../lib/members.js';
import { stockForItems } from '../lib/orders.js';
import { enqueue, storeData, fmtDate } from '../lib/print.js';
import { normalizePhone } from '../../public/shared/core.js';

const r = Router();

// POS lookup by member no / phone
r.get('/members/lookup', staffAuth('sell'), ah(async (req, res) => {
  const rows = await findMember(req.query.q);
  res.json(await Promise.all(rows.map((m) => memberPublic(m))));
}));
r.post('/members', staffAuth('sell'), ah(async (req, res) => {
  const m = await createMember(req.body, 'pos');
  await audit(req.staff.id, 'create', 'member', m.id, null, { phone: m.phone });
  emit('admin', 'member:changed', { id: m.id });
  res.json(await memberPublic(m));
}));
r.get('/members/check-phone', staffAuth('sell'), ah(async (req, res) => {
  const p = normalizePhone(req.query.phone);
  if (!p) return res.json({ valid: false });
  res.json({ valid: true, exists: !!(await db.get('SELECT id FROM members WHERE phone = ?', [p])) });
}));

r.get('/members', staffAuth('manage_members'), ah(async (req, res) => {
  const q = String(req.query.q || '').trim();
  const where = []; const p = [];
  if (q) { where.push('(m.phone LIKE ? OR m.member_no LIKE ? OR m.first_name LIKE ? OR m.last_name LIKE ? OR m.nickname LIKE ?)'); p.push(...Array(5).fill('%' + q + '%')); }
  if (req.query.tier) { where.push('m.tier_id = ?'); p.push(req.query.tier); }
  if (req.query.status) { where.push('m.status = ?'); p.push(req.query.status); }
  if (req.query.from) { where.push('m.created_at >= ?'); p.push(req.query.from); }
  if (req.query.to) { where.push('m.created_at < ?'); p.push(req.query.to + 'T99'); }
  const rows = await db.all(`SELECT m.id, m.member_no, m.phone, m.first_name, m.last_name, m.nickname, m.status, m.points, m.total_spent, m.bills, m.visits, m.last_visit, m.created_at,
    t.name AS tier_name, t.color AS tier_color FROM members m LEFT JOIN tiers t ON t.id = m.tier_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC LIMIT 300`, p);
  const pending = await db.get("SELECT COUNT(*) AS n FROM password_resets WHERE status IN ('pending','reviewing')");
  res.json({ members: rows, pending_resets: Number(pending.n) });
}));
r.get('/members/:id', staffAuth('manage_members'), ah(async (req, res) => {
  const m = await getMemberOr404(req.params.id);
  const out = await memberPublic(m, { full: true });
  out.progress = await tierProgress(m);
  out.stats = await memberStats(m.id);
  out.ledger = await db.all('SELECT * FROM point_ledger WHERE member_id = ? ORDER BY created_at DESC LIMIT 200', [m.id]);
  out.bills = await db.all('SELECT id, bill_no, queue_no, source, status, total, refunded_amount, bowls, points_earned, paid_at FROM orders WHERE member_id = ? ORDER BY created_at DESC LIMIT 100', [m.id]);
  out.coupons = await db.all('SELECT c.*, r.name AS reward_name FROM coupons c LEFT JOIN rewards r ON r.id = c.reward_id WHERE c.member_id = ? ORDER BY c.created_at DESC', [m.id]);
  out.refunds = await db.all('SELECT f.* FROM refunds f JOIN orders o ON o.id = f.order_id WHERE o.member_id = ? ORDER BY f.created_at DESC', [m.id]);
  out.resets = (await db.all('SELECT * FROM password_resets WHERE member_id = ? ORDER BY created_at DESC', [m.id])).map((x) => ({ ...x, token_hash: undefined, history: J(x.history, []) }));
  out.audit = await db.all("SELECT a.*, s.name AS actor_name FROM audit a LEFT JOIN staff s ON s.id = a.actor WHERE a.entity = 'member' AND a.entity_id = ? ORDER BY a.created_at DESC LIMIT 100", [m.id]);
  res.json(out);
}));
r.put('/members/:id', staffAuth('manage_members'), ah(async (req, res) => {
  const m = await getMemberOr404(req.params.id);
  const b = req.body || {};
  let phone = m.phone;
  if (b.phone && b.phone !== m.phone) {
    phone = normalizePhone(b.phone);
    if (!phone) throw bad('รูปแบบเบอร์โทรไม่ถูกต้อง');
    if (await db.get('SELECT id FROM members WHERE phone = ? AND id <> ?', [phone, m.id])) throw conflict('เบอร์นี้เป็นสมาชิกอยู่แล้ว');
    if (!b.reason) throw bad('การเปลี่ยนเบอร์โทร (บัญชีเข้าสู่ระบบ) ต้องระบุเหตุผลการตรวจสอบตัวตน');
  }
  const fields = ['first_name', 'last_name', 'nickname', 'birthday', 'email', 'note', 'status'];
  const next = Object.fromEntries(fields.map((f) => [f, b[f] !== undefined ? b[f] : m[f]]));
  if (!['active', 'suspended'].includes(next.status)) throw bad('สถานะไม่ถูกต้อง');
  await db.run('UPDATE members SET phone = ?, first_name = ?, last_name = ?, nickname = ?, birthday = ?, email = ?, note = ?, status = ?, extra = ? WHERE id = ?',
    [phone, next.first_name, next.last_name, next.nickname, next.birthday, next.email, next.note, next.status, b.extra ? S(b.extra) : m.extra, m.id]);
  if (next.status === 'suspended') await revokeSessions('member', m.id);
  const changed = fields.filter((f) => String(m[f] ?? '') !== String(next[f] ?? ''));
  if (phone !== m.phone) changed.push('phone');
  await audit(req.staff.id, 'update', 'member', m.id, Object.fromEntries(changed.map((f) => [f, m[f]])), Object.fromEntries(changed.map((f) => [f, f === 'phone' ? phone : next[f]])), b.reason);
  res.json({ ok: true });
}));
r.post('/members/:id/points', staffAuth('adjust_points'), ah(async (req, res) => {
  const m = await getMemberOr404(req.params.id);
  const delta = Math.round(Number(req.body.delta));
  if (!delta) throw bad('กรุณาระบุจำนวนแต้ม');
  if (!req.body.reason) throw bad('กรุณาระบุเหตุผล');
  const s = await getSettings();
  const out = await db.tx(() => ledger(m.id, delta, 'adjust', { actor: req.staff.id, reason: req.body.reason,
    expires_at: delta > 0 && s.points.expire_days ? addMinutes(s.points.expire_days * 1440) : null }));
  await audit(req.staff.id, 'points_adjust', 'member', m.id, { points: m.points }, { points: out.balance }, req.body.reason);
  res.json(out);
}));
r.post('/members/:id/tier', staffAuth('adjust_points'), ah(async (req, res) => {
  const m = await getMemberOr404(req.params.id);
  if (!req.body.reason) throw bad('กรุณาระบุเหตุผล');
  const t = req.body.tier_id ? await db.get('SELECT * FROM tiers WHERE id = ?', [req.body.tier_id]) : null;
  if (req.body.tier_id && !t) throw notFound('ไม่พบ Tier');
  await db.run('UPDATE members SET tier_id = ?, tier_manual = ?, tier_since = ?, tier_expires = ? WHERE id = ?',
    [t ? t.id : m.tier_id, req.body.auto ? 0 : 1, now(), t && t.duration_days ? addMinutes(t.duration_days * 1440) : null, m.id]);
  if (req.body.auto) await recomputeTier(m.id);
  await audit(req.staff.id, 'tier_set', 'member', m.id, { tier_id: m.tier_id, manual: m.tier_manual }, { tier_id: t ? t.id : null, manual: !req.body.auto }, req.body.reason);
  res.json({ ok: true });
}));

// ---------- password reset requests ----------
r.get('/password-resets', staffAuth('member_reset'), ah(async (req, res) => {
  await db.run("UPDATE password_resets SET status = 'expired' WHERE status IN ('pending','reviewing') AND created_at < ?", [addMinutes(-7 * 1440)]);
  const rows = await db.all(`SELECT p.*, m.member_no, m.phone, m.first_name, m.last_name FROM password_resets p JOIN members m ON m.id = p.member_id ORDER BY
    CASE WHEN p.status IN ('pending','reviewing') THEN 0 ELSE 1 END, p.created_at DESC LIMIT 200`);
  res.json(rows.map((x) => ({ ...x, token_hash: undefined, history: J(x.history, []) })));
}));
r.post('/password-resets/:id', staffAuth('member_reset'), ah(async (req, res) => {
  const pr = await db.get('SELECT * FROM password_resets WHERE id = ?', [req.params.id]);
  if (!pr) throw notFound();
  const { action, reason, verified_by } = req.body || {};
  if (!reason) throw bad('กรุณาระบุเหตุผล/วิธีตรวจสอบตัวตน');
  const hist = J(pr.history, []);
  let status = pr.status, tok = null;
  if (action === 'review') status = 'reviewing';
  else if (action === 'reject') status = 'rejected';
  else if (action === 'approve') {
    // identity must be verified with something beyond name/phone (ID card, OTP, purchase history...)
    if (!verified_by || verified_by === 'name' || verified_by === 'phone') throw bad('ต้องตรวจสอบตัวตนด้วยวิธีอื่นนอกจากชื่อหรือเบอร์โทร');
    if (!['pending', 'reviewing'].includes(pr.status)) throw conflict('คำขอนี้ดำเนินการไปแล้ว');
    tok = token(24);
    status = 'approved';
    await db.run('UPDATE password_resets SET token_hash = ?, token_expires = ? WHERE id = ?', [sha256(tok), addMinutes(60), pr.id]);
  } else throw bad('action ไม่ถูกต้อง');
  hist.push({ at: now(), by: req.staff.name, action, reason, verified_by });
  await db.run('UPDATE password_resets SET status = ?, updated_at = ?, handled_by = ?, history = ? WHERE id = ?', [status, now(), req.staff.id, S(hist), pr.id]);
  await audit(req.staff.id, 'password_reset_' + action, 'member', pr.member_id, { status: pr.status }, { status, verified_by }, reason);
  // the one-time link is shown once to the staff member to hand to the verified customer
  res.json({ ok: true, status, reset_url: tok ? `${process.env.PUBLIC_URL || ''}/member/#/reset/${tok}` : null, reset_code: tok, expires_in_minutes: tok ? 60 : null });
}));

// staff approval of sensitive member actions (when verification method = staff)
r.get('/verifications', staffAuth('sell'), ah(async (req, res) => {
  res.json(await db.all(`SELECT v.id, v.purpose, v.ref, v.status, v.created_at, v.expires_at, m.member_no, m.first_name, m.phone FROM verifications v JOIN members m ON m.id = v.member_id
    WHERE v.method = 'staff' AND v.status = 'pending' AND v.expires_at > ? ORDER BY v.created_at DESC`, [now()]));
}));
r.post('/verifications/:id', staffAuth('sell'), ah(async (req, res) => {
  const v = await db.get('SELECT * FROM verifications WHERE id = ?', [req.params.id]);
  if (!v) throw notFound();
  // staff types the code the customer shows on their phone: proves the person at the counter holds the logged-in session
  const ok = req.body.approve && v.code_hash === sha256(String(req.body.code || '').trim());
  if (req.body.approve && !ok) throw bad('รหัสยืนยันไม่ตรงกับที่ลูกค้าแสดง');
  await db.run("UPDATE verifications SET status = ?, approved_by = ? WHERE id = ? AND status = 'pending'", [ok ? 'approved' : 'rejected', req.staff.id, v.id]);
  emit('member:' + v.member_id, 'verification', { id: v.id, status: ok ? 'approved' : 'rejected' });
  await audit(req.staff.id, 'member_verify', 'member', v.member_id, null, { purpose: v.purpose, ok });
  res.json({ ok });
}));

// ---------- tiers ----------
r.get('/tiers', ah(async (req, res) => res.json(await db.all('SELECT * FROM tiers ORDER BY sort'))));
const TF = ['name', 'color', 'icon', 'card_image', 'sort', 'active', 'min_spent', 'min_visits', 'min_points', 'window_days', 'duration_days', 'multiplier', 'discount_pct', 'benefits'];
const normTier = (b, cur = {}) => {
  const o = Object.fromEntries(TF.map((f) => [f, b[f] !== undefined ? b[f] : cur[f]]));
  for (const f of ['sort', 'min_spent', 'min_visits', 'min_points', 'window_days', 'duration_days']) o[f] = Math.round(Number(o[f]) || 0);
  o.multiplier = Number(o.multiplier) || 1; o.discount_pct = Math.min(100, Number(o.discount_pct) || 0); o.active = o.active === false || o.active === 0 ? 0 : 1;
  if (!o.name) throw bad('กรุณาระบุชื่อ Tier');
  return o;
};
r.post('/tiers', staffAuth('settings'), ah(async (req, res) => {
  const o = normTier(req.body); const tid = id();
  await db.run(`INSERT INTO tiers(id, ${TF.join(', ')}) VALUES(?, ${TF.map(() => '?').join(', ')})`, [tid, ...TF.map((f) => o[f])]);
  await audit(req.staff.id, 'create', 'tier', tid, null, o);
  res.json({ id: tid });
}));
r.put('/tiers/:id', staffAuth('settings'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM tiers WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  const o = normTier(req.body, cur);
  await db.run(`UPDATE tiers SET ${TF.map((f) => f + ' = ?').join(', ')} WHERE id = ?`, [...TF.map((f) => o[f]), cur.id]);
  await audit(req.staff.id, 'update', 'tier', cur.id, cur, o, req.body.reason);
  res.json({ ok: true });
}));
r.post('/tiers/recompute', staffAuth('settings'), ah(async (req, res) => {
  const all = await db.all('SELECT id FROM members');
  for (const m of all) await recomputeTier(m.id);
  res.json({ ok: true, count: all.length });
}));

// ---------- rewards ----------
const RF = ['name', 'description', 'image', 'points', 'product_id', 'tier_ids', 'total_limit', 'per_member_limit', 'starts_at', 'ends_at', 'coupon_days', 'active', 'return_policy', 'terms', 'cost'];
const normReward = (b, cur = {}) => {
  const o = Object.fromEntries(RF.map((f) => [f, b[f] !== undefined ? b[f] : cur[f]]));
  for (const f of ['points', 'total_limit', 'per_member_limit', 'coupon_days', 'cost']) o[f] = Math.round(Number(o[f]) || 0);
  if (typeof o.tier_ids !== 'string') o.tier_ids = S(o.tier_ids || []);
  o.active = o.active === false || o.active === 0 ? 0 : 1;
  if (!o.name || !(o.points > 0)) throw bad('กรุณาระบุชื่อรางวัลและแต้มที่ใช้');
  if (!['refund_points', 'forfeit'].includes(o.return_policy || 'refund_points')) throw bad('นโยบายคืนสิทธิ์ไม่ถูกต้อง');
  o.return_policy = o.return_policy || 'refund_points';
  return o;
};
r.get('/rewards', staffAuth(), ah(async (req, res) => res.json((await db.all('SELECT * FROM rewards ORDER BY points')).map((x) => ({ ...x, tier_ids: J(x.tier_ids, []) })))));
r.post('/rewards', staffAuth('manage_members'), ah(async (req, res) => {
  const o = normReward(req.body); const rid = id();
  await db.run(`INSERT INTO rewards(id, ${RF.join(', ')}) VALUES(?, ${RF.map(() => '?').join(', ')})`, [rid, ...RF.map((f) => o[f])]);
  await audit(req.staff.id, 'create', 'reward', rid, null, o);
  res.json({ id: rid });
}));
r.put('/rewards/:id', staffAuth('manage_members'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM rewards WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  const o = normReward(req.body, cur);
  await db.run(`UPDATE rewards SET ${RF.map((f) => f + ' = ?').join(', ')} WHERE id = ?`, [...RF.map((f) => o[f]), cur.id]);
  await audit(req.staff.id, 'update', 'reward', cur.id, cur, o, req.body.reason);
  res.json({ ok: true });
}));

// ---------- coupon redemption at the counter ----------
async function couponView(c) {
  const rw = await db.get('SELECT * FROM rewards WHERE id = ?', [c.reward_id]);
  const m = await db.get('SELECT * FROM members WHERE id = ?', [c.member_id]);
  return { id: c.id, code: c.code, status: c.status, expired: c.status === 'reserved' && c.expires_at < now(), expires_at: c.expires_at, points: c.points, used_at: c.used_at,
    reward: rw && { id: rw.id, name: rw.name, product_id: rw.product_id, image: rw.image }, member: await memberPublic(m) };
}
r.get('/coupons/:code', staffAuth('redeem'), ah(async (req, res) => {
  const c = await db.get('SELECT * FROM coupons WHERE code = ?', [String(req.params.code).trim().toUpperCase()]);
  if (!c) throw notFound('ไม่พบคูปอง');
  res.json(await couponView(c));
}));
r.post('/coupons/:code/redeem', staffAuth('redeem'), ah(async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const out = await db.tx(async () => {
    const c = await db.get('SELECT * FROM coupons WHERE code = ?', [code]);
    if (!c) throw notFound('ไม่พบคูปอง');
    if (c.status === 'used') throw conflict(`คูปองนี้ถูกใช้แล้วเมื่อ ${fmtDate(c.used_at)}`, 'used');
    if (c.status !== 'reserved') throw conflict('คูปองนี้ถูกยกเลิกหรือหมดอายุ', 'invalid');
    if (c.expires_at < now()) throw conflict('คูปองหมดอายุแล้ว', 'expired');
    // single use even when two devices scan at the same moment
    const lock = await db.run("UPDATE coupons SET status = 'used', used_at = ?, used_by = ?, used_terminal = ?, business_date = ? WHERE id = ? AND status = 'reserved'",
      [now(), req.staff.id, req.terminalId, await businessDateOf(), c.id]);
    if (!lock.changes) throw conflict('คูปองนี้ถูกใช้ไปแล้ว', 'used');
    // reserved points become spent
    await db.run('UPDATE members SET reserved_points = reserved_points - ? WHERE id = ?', [c.points, c.member_id]);
    await db.run("UPDATE point_ledger SET kind = 'redeem', reason = ? WHERE ref = ? AND kind = 'redeem_hold'", ['แลกรางวัลสำเร็จ', c.id]);
    const rw = await db.get('SELECT * FROM rewards WHERE id = ?', [c.reward_id]);
    if (rw && rw.product_id) await stockForItems([{ product_id: rw.product_id, qty: 1, void_qty: 0, options: '[]' }], -1, 'reward', c.code, req.staff.id);
    const m = await db.get('SELECT * FROM members WHERE id = ?', [c.member_id]);
    await audit(req.staff.id, 'redeem', 'coupon', c.id, { status: 'reserved' }, { status: 'used', terminal: req.terminalId });
    await enqueue('redeem', c.id, { ...(await storeData()), reward_name: rw ? rw.name : '', coupon_code: c.code, member: `${m.first_name || ''} (${m.member_no})`,
      points_used: c.points, datetime: fmtDate(now()), staff: req.staff.name }, { dedupe: 'redeem:' + c.id });
    return couponView({ ...c, status: 'used', used_at: now() });
  });
  emit('member:' + out.member.id, 'coupon:used', { id: out.id });
  res.json(out);
}));

export default r;
