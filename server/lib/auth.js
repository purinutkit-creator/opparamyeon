import { db, J } from '../db.js';
import { id, now, token, hashSecret, verifySecret, addMinutes, HttpError, forbidden, audit } from './util.js';

export const PERMS = {
  view_sales: 'ดูยอดขาย', view_cost: 'ดูต้นทุน/กำไร', manage_menu: 'เพิ่ม/แก้เมนู', edit_price: 'แก้ราคา', discount: 'ให้ส่วนลด',
  void_item: 'ยกเลิกรายการที่ส่งครัวแล้ว', void_bill: 'ยกเลิกบิล', refund: 'คืนเงิน', reprint: 'พิมพ์ซ้ำ', cut_paper: 'สั่งตัดกระดาษ',
  shift: 'เปิด/ปิดรอบ', cash_move: 'เงินเข้า/ออกลิ้นชัก', edit_closed_shift: 'แก้ไขรอบที่ปิดแล้ว', settings: 'ตั้งค่าระบบ',
  manage_staff: 'จัดการพนักงาน', manage_stock: 'จัดการสต็อก', manage_members: 'จัดการสมาชิก', adjust_points: 'ปรับแต้ม/Tier',
  member_reset: 'อนุมัติรีเซ็ตรหัสสมาชิก', print_mobile_qr: 'พิมพ์ใบ Mobile Ordering', manage_tables: 'จัดการโต๊ะ', export: 'ส่งออกข้อมูล',
  kitchen: 'ใช้งานจอครัว', reset_queue: 'รีเซ็ตเลขคิว', verify_payment: 'ตรวจสอบการโอน/สลิป', redeem: 'รับแลกรางวัล', sell: 'ขายหน้าร้าน',
  manage_printers: 'ตั้งค่าเครื่องพิมพ์/จอลูกค้า',
};
const ALL = Object.keys(PERMS);
export const DEFAULT_ROLES = [
  { id: 'owner', name: 'เจ้าของ', perms: ALL, sort: 1 },
  { id: 'manager', name: 'ผู้จัดการ', perms: ALL.filter((p) => !['manage_staff', 'edit_closed_shift'].includes(p)), sort: 2 },
  { id: 'cashier', name: 'แคชเชียร์', perms: ['sell', 'discount', 'reprint', 'cut_paper', 'shift', 'cash_move', 'print_mobile_qr', 'verify_payment', 'redeem', 'kitchen'], sort: 3 },
  { id: 'kitchen', name: 'ครัว', perms: ['kitchen', 'cut_paper'], sort: 4 },
];

const SESSION_HOURS = { staff: 14, member: 24 * 30, display: 24 * 365 };

export async function createSession(kind, subjectId, terminalId = null) {
  const t = token(32);
  await db.run('INSERT INTO sessions(token, kind, subject_id, terminal_id, created_at, expires_at) VALUES(?,?,?,?,?,?)',
    [t, kind, subjectId, terminalId, now(), addMinutes(SESSION_HOURS[kind] * 60)]);
  return t;
}
export async function revokeSessions(kind, subjectId, exceptToken = null) {
  await db.run('UPDATE sessions SET revoked = 1 WHERE kind = ? AND subject_id = ? AND token <> ?', [kind, subjectId, exceptToken || '']);
}
export async function readSession(tok, kind) {
  if (!tok) return null;
  const s = await db.get('SELECT * FROM sessions WHERE token = ? AND kind = ? AND revoked = 0', [tok, kind]);
  if (!s || s.expires_at < now()) return null;
  return s;
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || null;

export async function loadStaff(tok) {
  const s = await readSession(tok, 'staff');
  if (!s) return null;
  const st = await db.get('SELECT s.id, s.code, s.name, s.photo, s.role_id, s.active, r.name AS role_name, r.perms FROM staff s JOIN roles r ON r.id = s.role_id WHERE s.id = ?', [s.subject_id]);
  if (!st || !st.active) return null;
  return { ...st, perms: J(st.perms, []), terminal_id: s.terminal_id, token: tok };
}

export function staffAuth(...needed) {
  return async (req, res, next) => {
    try {
      const st = await loadStaff(bearer(req));
      if (!st) throw new HttpError(401, 'กรุณาเข้าสู่ระบบ', 'unauthorized');
      for (const p of needed) if (!st.perms.includes(p)) throw forbidden(`ไม่มีสิทธิ์: ${PERMS[p] || p}`);
      req.staff = st;
      req.terminalId = req.headers['x-terminal-id'] || st.terminal_id || null;
      next();
    } catch (e) { next(e); }
  };
}
export const can = (staff, p) => !!staff && staff.perms.includes(p);
export const requirePerm = (staff, p) => { if (!can(staff, p)) throw forbidden(`ไม่มีสิทธิ์: ${PERMS[p] || p}`); };

// Optional override: a manager types their PIN on the cashier's screen for one action.
export async function staffForAction(req, perm) {
  if (can(req.staff, perm)) return req.staff;
  const ov = req.body && req.body.approver;
  if (ov && ov.code && ov.pin) {
    const s = await verifyStaffPin(ov.code, ov.pin);
    const perms = J((await db.get('SELECT perms FROM roles WHERE id = ?', [s.role_id])).perms, []);
    if (perms.includes(perm)) { await audit(s.id, 'approve', 'permission', perm, null, { for: req.staff.id }); return { ...s, perms }; }
  }
  throw forbidden(`ต้องได้รับอนุมัติ: ${PERMS[perm] || perm}`);
}

const MAX_TRIES = 5, LOCK_MIN = 5;
export async function verifyStaffPin(code, pin) {
  const s = await db.get('SELECT * FROM staff WHERE code = ?', [String(code || '').trim()]);
  if (!s || !s.active) throw new HttpError(401, 'รหัสพนักงานหรือ PIN ไม่ถูกต้อง', 'bad_login');
  if (s.locked_until && s.locked_until > now()) throw new HttpError(423, 'ลองรหัสผิดหลายครั้ง บัญชีถูกล็อกชั่วคราว กรุณารอ 5 นาที', 'locked');
  if (!verifySecret(String(pin || ''), s.pin_hash)) {
    const n = (s.failed_attempts || 0) + 1;
    await db.run('UPDATE staff SET failed_attempts = ?, locked_until = ? WHERE id = ?', [n >= MAX_TRIES ? 0 : n, n >= MAX_TRIES ? addMinutes(LOCK_MIN) : null, s.id]);
    throw new HttpError(401, `รหัสพนักงานหรือ PIN ไม่ถูกต้อง (เหลือ ${Math.max(0, MAX_TRIES - n)} ครั้ง)`, 'bad_login');
  }
  await db.run('UPDATE staff SET failed_attempts = 0, locked_until = NULL WHERE id = ?', [s.id]);
  return s;
}

// ---------- member auth ----------
export async function memberAuthOptional(req) {
  const s = await readSession(bearer(req), 'member');
  if (!s) return null;
  const m = await db.get('SELECT * FROM members WHERE id = ?', [s.subject_id]);
  if (!m || m.status !== 'active') return null;
  return m;
}
export function memberAuth() {
  return async (req, res, next) => {
    try {
      const m = await memberAuthOptional(req);
      if (!m) throw new HttpError(401, 'กรุณาเข้าสู่ระบบสมาชิก', 'unauthorized');
      req.member = m; req.memberToken = bearer(req);
      next();
    } catch (e) { next(e); }
  };
}

export async function seedStaff() {
  const n = await db.get('SELECT COUNT(*) AS n FROM roles');
  if (!Number(n.n)) for (const r of DEFAULT_ROLES) await db.run('INSERT INTO roles(id, name, perms, sort) VALUES(?,?,?,?)', [r.id, r.name, JSON.stringify(r.perms), r.sort]);
  const c = await db.get('SELECT COUNT(*) AS n FROM staff');
  if (!Number(c.n)) {
    const pin = process.env.OWNER_PIN || '1234';
    await db.run('INSERT INTO staff(id, code, name, role_id, pin_hash, active, created_at) VALUES(?,?,?,?,?,1,?)', [id(), '0001', 'เจ้าของร้าน', 'owner', hashSecret(pin), now()]);
    await db.run('INSERT INTO staff(id, code, name, role_id, pin_hash, active, created_at) VALUES(?,?,?,?,?,1,?)', [id(), '0002', 'แคชเชียร์', 'cashier', hashSecret('2222'), now()]);
    await db.run('INSERT INTO staff(id, code, name, role_id, pin_hash, active, created_at) VALUES(?,?,?,?,?,1,?)', [id(), '0003', 'ครัว', 'kitchen', hashSecret('3333'), now()]);
  }
}
