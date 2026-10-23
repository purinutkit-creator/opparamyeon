import { db, J } from '../db.js';
import { id, now, getSettings, audit, nextCounter, bad, conflict, notFound, emit, addMinutes } from './util.js';
import { pointsFor, normalizePhone, defaultPassword } from '../../public/shared/core.js';
import { hashSecret } from './util.js';

export async function memberPublic(m, { full = false } = {}) {
  if (!m) return null;
  const tier = m.tier_id ? await db.get('SELECT id, name, color, icon, card_image, multiplier, discount_pct, benefits FROM tiers WHERE id = ?', [m.tier_id]) : null;
  const out = { id: m.id, member_no: m.member_no, phone: m.phone, first_name: m.first_name, last_name: m.last_name, nickname: m.nickname,
    status: m.status, points: m.points, reserved_points: m.reserved_points, tier, total_spent: m.total_spent, bills: m.bills, visits: m.visits,
    last_visit: m.last_visit, created_at: m.created_at };
  if (full) Object.assign(out, { birthday: m.birthday, email: m.email, avatar: m.avatar, extra: J(m.extra, {}), note: m.note,
    tier_manual: !!m.tier_manual, tier_since: m.tier_since, tier_expires: m.tier_expires, tier_score: m.tier_score, password_is_default: !!m.password_is_default });
  return out;
}

export async function createMember(data, source = 'pos') {
  const s = await getSettings();
  const phone = normalizePhone(data.phone);
  if (!phone) throw bad('รูปแบบเบอร์โทรไม่ถูกต้อง (ตัวอย่าง 0812345678)', 'bad_phone');
  const exists = await db.get('SELECT id FROM members WHERE phone = ?', [phone]);
  if (exists) throw conflict('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว', 'duplicate_phone');
  const f = s.members.fields;
  for (const [k, cfg] of Object.entries(f)) if (cfg.on && cfg.req && k !== 'avatar' && !String(data[k] || '').trim()) throw bad(`กรุณากรอก ${k}`, 'required');
  for (const cf of s.members.custom_fields || []) if (cf.req && !String((data.extra || {})[cf.key] || '').trim()) throw bad(`กรุณากรอก ${cf.label}`, 'required');
  if (data.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.email)) throw bad('รูปแบบอีเมลไม่ถูกต้อง');
  const n = await nextCounter('member_no');
  const mid = id();
  const firstTier = await db.get('SELECT id FROM tiers WHERE active = 1 ORDER BY sort LIMIT 1');
  try {
    await db.run(`INSERT INTO members(id, member_no, phone, first_name, last_name, nickname, birthday, email, avatar, extra, status, password_hash,
      password_is_default, tier_id, tier_since, created_at, source) VALUES(?,?,?,?,?,?,?,?,?,?, 'active', ?, 1, ?, ?, ?, ?)`,
    [mid, 'M' + String(n).padStart(6, '0'), phone, f.first_name.on ? data.first_name || null : null, f.last_name.on ? data.last_name || null : null,
      f.nickname.on ? data.nickname || null : null, f.birthday.on ? data.birthday || null : null, f.email.on ? data.email || null : null,
      data.avatar || null, JSON.stringify(data.extra || {}), hashSecret(defaultPassword(phone)), firstTier ? firstTier.id : null, now(), now(), source]);
  } catch (e) {
    if (/unique|UNIQUE/.test(e.message)) throw conflict('เบอร์โทรนี้เป็นสมาชิกอยู่แล้ว', 'duplicate_phone');
    throw e;
  }
  return db.get('SELECT * FROM members WHERE id = ?', [mid]);
}

// Adjust the spendable balance atomically. Negative balance only when allowNegative (refund after points were used).
export async function ledger(memberId, delta, kind, { order_id = null, ref = null, reason = null, actor = null, unique_key = null, allowNegative = false, expires_at = null } = {}) {
  if (unique_key) {
    const dup = await db.get('SELECT id FROM point_ledger WHERE unique_key = ?', [unique_key]);
    if (dup) return { duplicate: true };
  }
  const r = delta >= 0 || allowNegative
    ? await db.run('UPDATE members SET points = points + ? WHERE id = ?', [delta, memberId])
    : await db.run('UPDATE members SET points = points + ? WHERE id = ? AND points + ? >= 0', [delta, memberId, delta]);
  if (!r.changes) throw conflict('แต้มไม่พอ', 'insufficient_points');
  const m = await db.get('SELECT points FROM members WHERE id = ?', [memberId]);
  await db.run(`INSERT INTO point_ledger(id, member_id, delta, kind, order_id, ref, balance_after, expires_at, remaining, reason, actor, created_at, unique_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [id(), memberId, delta, kind, order_id, ref, m.points, expires_at, delta > 0 && kind === 'earn' ? delta : 0, reason, actor, now(), unique_key]);
  if (delta < 0) await consumeLots(memberId, -delta);
  return { balance: m.points };
}
// FIFO consumption of earned lots, so "แต้มใกล้หมดอายุ" stays accurate.
async function consumeLots(memberId, amount) {
  let left = amount;
  const lots = await db.all("SELECT id, remaining FROM point_ledger WHERE member_id = ? AND remaining > 0 ORDER BY expires_at, created_at", [memberId]);
  for (const l of lots) {
    if (left <= 0) break;
    const take = Math.min(left, l.remaining);
    await db.run('UPDATE point_ledger SET remaining = remaining - ? WHERE id = ?', [take, l.id]);
    left -= take;
  }
}
export async function expirePoints() {
  const lots = await db.all('SELECT * FROM point_ledger WHERE remaining > 0 AND expires_at IS NOT NULL AND expires_at < ?', [now()]);
  for (const l of lots) {
    await db.tx(async () => {
      const r = await db.run('UPDATE point_ledger SET remaining = 0 WHERE id = ? AND remaining = ?', [l.id, l.remaining]);
      if (!r.changes) return;
      await db.run('UPDATE members SET points = points - ? WHERE id = ?', [l.remaining, l.member_id]);
      const m = await db.get('SELECT points FROM members WHERE id = ?', [l.member_id]);
      await db.run('INSERT INTO point_ledger(id, member_id, delta, kind, ref, balance_after, created_at, reason) VALUES(?,?,?,?,?,?,?,?)',
        [id(), l.member_id, -l.remaining, 'expire', l.id, m.points, now(), 'แต้มหมดอายุ']);
    });
  }
}

async function multiplierOf(member) {
  if (!member.tier_id) return 1;
  const t = await db.get('SELECT multiplier FROM tiers WHERE id = ? AND active = 1', [member.tier_id]);
  return t ? Number(t.multiplier) || 1 : 1;
}

export async function orderItemsForPoints(orderId) {
  return db.all('SELECT product_id, qty, void_qty, refunded_qty, line_total FROM order_items WHERE order_id = ?', [orderId]);
}
export async function previewPoints(order, member) {
  const s = await getSettings();
  const items = (await orderItemsForPoints(order.id)).map((i) => ({ ...i, refunded_qty: 0 }));
  return pointsFor(order, items, { ...s.points, tax_inclusive: s.sale.tax_inclusive }, member ? await multiplierOf(member) : 1);
}

// Called inside the payment transaction (member attached before payment) or from a receipt claim.
export async function awardOrder(order, memberId, actor, kind = 'earn') {
  const s = await getSettings();
  const member = await db.get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!member || member.status !== 'active') throw bad('สมาชิกไม่พร้อมใช้งาน');
  // mark order: only one award per bill, enforced by a conditional update
  const claimed = await db.run("UPDATE orders SET member_id = ?, claim_status = 'claimed' WHERE id = ? AND status = 'paid' AND (claim_status IS NULL OR claim_status = 'available') AND (member_id IS NULL OR member_id = ?) AND points_earned = 0",
    [memberId, order.id, memberId]);
  if (!claimed.changes) throw conflict('บิลนี้รับแต้มไปแล้ว หรือไม่เข้าเงื่อนไข', 'already_claimed');
  let pts = 0;
  if (s.points.enabled) {
    const { points } = await previewPoints(order, member);
    pts = points;
    if (pts > 0) {
      await ledger(memberId, pts, 'earn', { order_id: order.id, actor, unique_key: 'earn:' + order.id, reason: kind === 'claim' ? 'รับแต้มย้อนหลังจากใบเสร็จ' : 'สะสมแต้มจากบิล',
        expires_at: s.points.expire_days ? addMinutes(s.points.expire_days * 1440) : null });
    }
  }
  await db.run('UPDATE orders SET points_earned = ? WHERE id = ?', [pts, order.id]);
  const net = order.total - (order.refunded_amount || 0);
  const visitNew = !member.last_visit || member.last_visit.slice(0, 10) !== (order.paid_business_date || '');
  await db.run('UPDATE members SET total_spent = total_spent + ?, bills = bills + 1, visits = visits + ?, last_visit = ?, tier_score = tier_score + ? WHERE id = ?',
    [net, visitNew ? 1 : 0, (order.paid_business_date || now().slice(0, 10)) + 'T' + now().slice(11), net, memberId]);
  await recomputeTier(memberId);
  emit('admin', 'member:changed', { id: memberId });
  return pts;
}

// Refund: reverse points proportionally to refunded items. If the member already spent them, follow policy.
export async function reverseForRefund(order, refundId, ratioItems, actor) {
  if (!order.member_id || !order.points_earned) return 0;
  const s = await getSettings();
  const member = await db.get('SELECT * FROM members WHERE id = ?', [order.member_id]);
  const items = await orderItemsForPoints(order.id);
  const after = pointsFor({ ...order, discount: order.discount }, items, { ...s.points, tax_inclusive: s.sale.tax_inclusive }, await multiplierOf(member)).points;
  const already = await db.get("SELECT COALESCE(SUM(delta),0) AS d FROM point_ledger WHERE order_id = ? AND kind IN ('earn','refund')", [order.id]);
  const target = order.status === 'void' ? 0 : after;
  const delta = target - Number(already.d);
  if (delta >= 0) return 0;
  let take = delta;
  const policy = s.points.refund_policy;
  if (policy === 'cap_at_zero') take = -Math.min(-delta, Math.max(0, member.points));
  if (take !== 0) await ledger(member.id, take, 'refund', { order_id: order.id, ref: refundId, actor, allowNegative: policy !== 'cap_at_zero',
    reason: `ปรับแต้มจากการคืนเงิน/ยกเลิก (ควรหัก ${-delta} แต้ม)` + (take !== delta ? ` หักได้ ${-take} แต้ม` : '') });
  return take;
}

export async function recomputeTier(memberId) {
  const s = await getSettings();
  const m = await db.get('SELECT * FROM members WHERE id = ?', [memberId]);
  if (!m || m.tier_manual || s.points.tier_mode === 'manual') return;
  const tiers = await db.all('SELECT * FROM tiers WHERE active = 1 ORDER BY sort');
  let best = tiers[0];
  for (const t of tiers) {
    const since = new Date(Date.now() - (t.window_days || 3650) * 86400000).toISOString();
    const st = await db.get(`SELECT COALESCE(SUM(total - refunded_amount),0) AS spent, COUNT(DISTINCT paid_business_date) AS visits
      FROM orders WHERE member_id = ? AND status = 'paid' AND paid_at >= ?`, [memberId, since]);
    const earned = await db.get("SELECT COALESCE(SUM(delta),0) AS p FROM point_ledger WHERE member_id = ? AND kind IN ('earn','refund','adjust') AND created_at >= ?", [memberId, since]);
    const okSpent = !t.min_spent || st.spent >= t.min_spent;
    const okVisits = !t.min_visits || Number(st.visits) >= t.min_visits;
    const okPts = !t.min_points || Number(earned.p) >= t.min_points;
    if (okSpent && okVisits && okPts) best = t;
  }
  if (best && best.id !== m.tier_id) {
    await db.run('UPDATE members SET tier_id = ?, tier_since = ?, tier_expires = ? WHERE id = ?',
      [best.id, now(), best.duration_days ? addMinutes(best.duration_days * 1440) : null, memberId]);
    await audit('system', 'tier_change', 'member', memberId, { tier_id: m.tier_id }, { tier_id: best.id }, 'คำนวณ Tier อัตโนมัติ');
  }
}

export async function tierProgress(member) {
  const tiers = await db.all('SELECT * FROM tiers WHERE active = 1 ORDER BY sort');
  const idx = tiers.findIndex((t) => t.id === member.tier_id);
  const next = tiers[idx + 1];
  if (!next) return { next: null };
  const since = new Date(Date.now() - (next.window_days || 3650) * 86400000).toISOString();
  const st = await db.get("SELECT COALESCE(SUM(total - refunded_amount),0) AS spent, COUNT(DISTINCT paid_business_date) AS visits FROM orders WHERE member_id = ? AND status = 'paid' AND paid_at >= ?", [member.id, since]);
  const need = [];
  if (next.min_spent) need.push({ kind: 'spent', have: st.spent, need: next.min_spent });
  if (next.min_visits) need.push({ kind: 'visits', have: Number(st.visits), need: next.min_visits });
  const pct = need.length ? Math.min(100, Math.round(Math.min(...need.map((n) => (n.have / n.need) * 100)))) : 100;
  return { next: { id: next.id, name: next.name, color: next.color }, need, pct };
}

export async function memberStats(memberId) {
  const fav = await db.all(`SELECT i.product_id, i.name, SUM(i.qty - i.void_qty - i.refunded_qty) AS qty, COUNT(DISTINCT i.order_id) AS times
    FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.member_id = ? AND o.status = 'paid' GROUP BY i.product_id, i.name
    HAVING SUM(i.qty - i.void_qty - i.refunded_qty) > 0 ORDER BY qty DESC LIMIT 10`, [memberId]);
  const opts = new Map();
  const rows = await db.all("SELECT i.options, i.qty, i.void_qty, i.refunded_qty FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.member_id = ? AND o.status = 'paid'", [memberId]);
  for (const r of rows) for (const o of J(r.options, [])) {
    const k = `${o.group}: ${o.name}`;
    opts.set(k, (opts.get(k) || 0) + (r.qty - r.void_qty - r.refunded_qty));
  }
  const favOptions = [...opts.entries()].filter((x) => x[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, qty]) => ({ name, qty }));
  const agg = await db.get("SELECT COUNT(*) AS bills, COALESCE(SUM(total - refunded_amount),0) AS spent, MAX(paid_at) AS last FROM orders WHERE member_id = ? AND status = 'paid'", [memberId]);
  const soon = await db.get('SELECT COALESCE(SUM(remaining),0) AS p, MIN(expires_at) AS first FROM point_ledger WHERE member_id = ? AND remaining > 0 AND expires_at IS NOT NULL AND expires_at < ?',
    [memberId, addMinutes(30 * 1440)]);
  return { favorites: fav, favorite_options: favOptions, bills: Number(agg.bills), spent: Number(agg.spent), last_purchase: agg.last,
    avg_bill: agg.bills ? Math.round(agg.spent / agg.bills) : 0, expiring_points: Number(soon.p), expiring_first: soon.first };
}

export async function findMember(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const phone = normalizePhone(s);
  return db.all("SELECT * FROM members WHERE (member_no = ? OR phone = ?) AND status <> 'deleted' LIMIT 5", [s.toUpperCase(), phone || '__']);
}
export async function getMemberOr404(mid) { const m = await db.get('SELECT * FROM members WHERE id = ?', [mid]); if (!m) throw notFound('ไม่พบสมาชิก'); return m; }
