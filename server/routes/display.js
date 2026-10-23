// Customer display pairing + customer-entered member lookup
import { Router } from 'express';
import { db } from '../db.js';
import { ah, id, now, token, bad, notFound, conflict, forbidden, emit, addMinutes, getSettings, randomDigits, rateLimit, audit } from '../lib/util.js';
import { staffAuth } from '../lib/auth.js';
import { findMember, createMember, memberPublic } from '../lib/members.js';
import { maskPhone, maskName } from '../../public/shared/core.js';

const r = Router();

// POS creates a 6 digit code bound to its terminal. Codes expire and are single use.
r.post('/display/pairing', staffAuth('sell'), ah(async (req, res) => {
  if (!req.terminalId) throw bad('ยังไม่ได้เลือกเครื่องขาย');
  const s = await getSettings();
  let code;
  for (let i = 0; i < 10; i++) {
    code = randomDigits(6);
    if (!(await db.get('SELECT id FROM display_pairings WHERE code = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?', [code, now()]))) break;
  }
  const pid = id();
  await db.run('INSERT INTO display_pairings(id, terminal_id, code, expires_at, created_at, mode) VALUES(?,?,?,?,?,?)',
    [pid, req.terminalId, code, addMinutes(s.display.pairing_minutes || 10), now(), req.body.mode || 'link']);
  res.json({ code, expires_at: addMinutes(s.display.pairing_minutes || 10), url: `/display/?code=${code}` });
}));
r.post('/display/pair', ah(async (req, res) => {
  rateLimit('pair:' + req.ip, 20, 60000);
  const code = String(req.body.code || '').replace(/\D/g, '');
  const p = await db.get('SELECT * FROM display_pairings WHERE code = ? AND used_at IS NULL AND revoked = 0', [code]);
  if (!p || p.expires_at < now()) throw bad('รหัสจับคู่ไม่ถูกต้องหรือหมดอายุ', 'bad_code');
  const t = token(32);
  const ch = await db.run('UPDATE display_pairings SET used_at = ?, display_token = ?, last_seen = ?, touch = ? WHERE id = ? AND used_at IS NULL', [now(), t, now(), req.body.touch === false ? 0 : 1, p.id]);
  if (!ch.changes) throw conflict('รหัสนี้ถูกใช้แล้ว');
  const term = await db.get('SELECT id, name FROM terminals WHERE id = ?', [p.terminal_id]);
  emit('terminal:' + p.terminal_id, 'display:paired', { id: p.id });
  res.json({ token: t, terminal: term });
}));
r.get('/display/pairings', staffAuth(), ah(async (req, res) => {
  res.json(await db.all(`SELECT p.id, p.terminal_id, t.name AS terminal_name, p.used_at, p.last_seen, p.mode, p.revoked, p.created_at, p.touch FROM display_pairings p
    LEFT JOIN terminals t ON t.id = p.terminal_id WHERE p.used_at IS NOT NULL ORDER BY p.used_at DESC LIMIT 50`));
}));
r.post('/display/pairings/:id/revoke', staffAuth('manage_printers'), ah(async (req, res) => {
  const p = await db.get('SELECT * FROM display_pairings WHERE id = ?', [req.params.id]);
  if (!p) throw notFound();
  await db.run('UPDATE display_pairings SET revoked = 1 WHERE id = ?', [p.id]);
  emit('displaytoken:' + p.id, 'display:revoked', {});
  await audit(req.staff.id, 'display_unpair', 'display', p.id);
  res.json({ ok: true });
}));

export async function displayFromToken(t) {
  if (!t) return null;
  const p = await db.get('SELECT * FROM display_pairings WHERE display_token = ? AND revoked = 0', [t]);
  if (p) await db.run('UPDATE display_pairings SET last_seen = ? WHERE id = ?', [now(), p.id]);
  return p || null;
}
const displayAuth = () => async (req, res, next) => {
  try {
    const p = await displayFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!p) throw forbidden('จอลูกค้ายังไม่ได้จับคู่หรือถูกยกเลิก');
    req.display = p; next();
  } catch (e) { next(e); }
};
r.get('/display/me', displayAuth(), ah(async (req, res) => {
  const t = await db.get('SELECT id, name FROM terminals WHERE id = ?', [req.display.terminal_id]);
  res.json({ terminal: t, pairing_id: req.display.id });
}));

// ---------- member entry on the customer display ----------
// Only staff can open it; the prompt is bound to (terminal, cart_id) and expires.
r.post('/member-prompt', staffAuth('sell'), ah(async (req, res) => {
  if (!req.terminalId || !req.body.cart_id) throw bad('ต้องมีบิลที่กำลังขาย');
  const s = await getSettings();
  await db.run("UPDATE member_prompts SET status = 'cancelled' WHERE terminal_id = ? AND status = 'open'", [req.terminalId]);
  const pid = id();
  const exp = addMinutes((s.display.member_prompt_seconds || 90) / 60);
  await db.run('INSERT INTO member_prompts(id, terminal_id, cart_id, status, expires_at, created_at, created_by) VALUES(?,?,?,?,?,?,?)',
    [pid, req.terminalId, String(req.body.cart_id), 'open', exp, now(), req.staff.id]);
  const payload = { id: pid, cart_id: req.body.cart_id, expires_at: exp, mode: req.body.mode || 'touch', allow_signup: s.members.signup_from_display && s.members.enabled,
    phone_url: req.body.mode === 'phone_qr' ? `/display/member.html#${pid}` : null };
  emit('display:' + req.terminalId, 'member:prompt', payload);
  res.json(payload);
}));
r.post('/member-prompt/close', staffAuth('sell'), ah(async (req, res) => {
  await closePrompts(req.terminalId, 'cancelled');
  res.json({ ok: true });
}));
export async function closePrompts(terminalId, status = 'cancelled') {
  await db.run("UPDATE member_prompts SET status = ? WHERE terminal_id = ? AND status = 'open'", [status, terminalId]);
  emit('display:' + terminalId, 'member:prompt_closed', {});
}
async function activePrompt(promptId, display) {
  const p = await db.get("SELECT * FROM member_prompts WHERE id = ? AND status = 'open'", [promptId]);
  if (!p || p.expires_at < now()) throw conflict('หน้ากรอกสมาชิกหมดเวลาหรือถูกปิดแล้ว', 'prompt_closed');
  if (display && display.terminal_id !== p.terminal_id) throw forbidden('อุปกรณ์นี้ไม่ได้จับคู่กับบิลนี้');
  return p;
}
// From the paired display (token) — or a phone opened via the staff-started QR (prompt id is the capability, short lived)
async function promptCtx(req) {
  const disp = await displayFromToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  return activePrompt(req.body.prompt_id, disp && disp.id ? disp : null);
}
r.post('/member-prompt/lookup', ah(async (req, res) => {
  rateLimit('mp:' + req.ip, 15, 60000);
  const p = await promptCtx(req);
  const found = await findMember(req.body.q);
  // masked results only — the customer verifies it is them, staff sees the full record on the POS
  res.json({ results: found.filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: maskName(m.first_name || m.nickname || ''), phone: maskPhone(m.phone), member_no: m.member_no })), prompt_id: p.id });
}));
r.post('/member-prompt/confirm', ah(async (req, res) => {
  const p = await promptCtx(req);
  const m = await db.get("SELECT * FROM members WHERE id = ? AND status = 'active'", [req.body.member_id]);
  if (!m) throw notFound('ไม่พบสมาชิก');
  const ch = await db.run("UPDATE member_prompts SET status = 'done', member_id = ? WHERE id = ? AND status = 'open'", [m.id, p.id]);
  if (!ch.changes) throw conflict('หน้ากรอกถูกปิดแล้ว');
  emit('terminal:' + p.terminal_id, 'member:selected', { cart_id: p.cart_id, member: await memberPublic(m) });
  emit('display:' + p.terminal_id, 'member:prompt_closed', { done: true });
  res.json({ ok: true });
}));
r.post('/member-prompt/signup', ah(async (req, res) => {
  rateLimit('mps:' + req.ip, 5, 60000);
  const p = await promptCtx(req);
  const s = await getSettings();
  if (!s.members.enabled || !s.members.signup_from_display) throw forbidden('ร้านไม่ได้เปิดให้สมัครจากหน้าจอลูกค้า');
  const m = await createMember(req.body, 'display');
  await db.run("UPDATE member_prompts SET status = 'done', member_id = ? WHERE id = ? AND status = 'open'", [m.id, p.id]);
  emit('terminal:' + p.terminal_id, 'member:selected', { cart_id: p.cart_id, member: await memberPublic(m), new_member: true });
  emit('display:' + p.terminal_id, 'member:prompt_closed', { done: true });
  res.json({ ok: true, member_no: m.member_no });
}));

export default r;
