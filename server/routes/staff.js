import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, hashSecret, audit, conflict } from '../lib/util.js';
import { staffAuth, verifyStaffPin, createSession, PERMS } from '../lib/auth.js';
import { getSettings } from '../lib/util.js';
import { staffToken, staffFromToken } from '../lib/billlink.js';
import { joinShiftCrew, crewPlan, verifyOnDuty, clockIn, printAttendance, attendanceOf, attendanceUrl } from '../lib/crew.js';
import { attendanceFromToken, ATT_WINDOW_DAYS } from '../lib/billlink.js';

const r = Router();

const person = (s) => ({ id: s.id, code: s.code, name: s.name });
r.post('/auth/login', ah(async (req, res) => {
  const { code, pin, terminal_id } = req.body || {};
  // on a POS the owner's roster applies (people on leave today can't sign in); the shop website is not affected
  const plan = terminal_id ? await crewPlan() : null;
  const s = plan ? await verifyOnDuty(code, pin, plan) : await verifyStaffPin(code, pin);
  // the rest of the crew who scanned in on this device (each with their own PIN)
  const crew = [];
  for (const c of (Array.isArray(req.body.crew) ? req.body.crew : []).slice(0, 12)) {
    const m = await verifyOnDuty(c && c.code, c && c.pin, plan || undefined);
    if (m.id !== s.id && !crew.some((x) => x.id === m.id)) crew.push({ ...person(m), at: c.at });
  }
  const term = terminal_id ? await db.get('SELECT id FROM terminals WHERE id = ?', [terminal_id]) : null;
  const tok = await createSession('staff', s.id, term ? term.id : null);
  if (crew.length) await db.run('UPDATE sessions SET crew = ? WHERE token = ?', [S(crew.map(person)), tok]);
  const open = term ? await db.get("SELECT id FROM shifts WHERE terminal_id = ? AND status = 'open'", [term.id]) : null;
  if (open) await joinShiftCrew(open.id, [{ ...person(s), main: true }, ...crew.map(person)]);
  // clock-in on the POS: the first sign-in of the day for each person; the slip prints when someone new came in
  if (term) {
    const ci = await clockIn([{ ...person(s), main: true, at: req.body.at }, ...crew], { terminalId: term.id, shiftId: open && open.id });
    if (ci.added.length) await printAttendance(ci.day, term.id, { crewSize: 1 + crew.length }).catch(() => {});
  }
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [s.role_id]);
  await audit(s.id, 'login', 'staff', s.id, null, { terminal_id: term && term.id, crew: crew.map((x) => x.code) });
  res.json({ token: tok, crew: crew.map(person), staff: { id: s.id, code: s.code, name: s.name, photo: s.photo, role_id: s.role_id, role_name: role.name, perms: J(role.perms, []) } });
}));
// several staff signing in together: check one person's PIN (same lockout rules) without opening a session
r.post('/auth/verify', ah(async (req, res) => {
  const s = await verifyOnDuty((req.body || {}).code, (req.body || {}).pin);
  const role = await db.get('SELECT name FROM roles WHERE id = ?', [s.role_id]);
  res.json({ ...person(s), last_name: s.last_name || '', nickname: s.nickname || '', title: s.title || '', photo: s.photo || '', role_name: role ? role.name : '' });
}));
r.post('/auth/logout', staffAuth(), ah(async (req, res) => {
  await db.run('UPDATE sessions SET revoked = 1 WHERE token = ?', [req.staff.token]);
  res.json({ ok: true });
}));
r.get('/auth/me', staffAuth(), ah(async (req, res) => {
  const { token, pin_hash, ...st } = req.staff;
  res.json({ staff: st, perms_catalog: PERMS });
}));
// re-verify PIN on lock screen (auto lock) without issuing a new session
r.post('/auth/unlock', staffAuth(), ah(async (req, res) => {
  const s = await verifyStaffPin(req.staff.code, req.body.pin);
  res.json({ ok: s.id === req.staff.id });
}));
// Manager approval for a single action
r.post('/auth/approve', staffAuth(), ah(async (req, res) => {
  const s = await verifyStaffPin(req.body.code, req.body.pin);
  const role = await db.get('SELECT perms FROM roles WHERE id = ?', [s.role_id]);
  const ok = J(role.perms, []).includes(req.body.perm);
  res.json({ ok, name: s.name });
}));

// clock-in times for the owner: the QR on the clock-in slip opens a day and steps through the days around it (no login)
r.get('/public/attendance/:token', ah(async (req, res) => {
  const a = await attendanceFromToken(req.params.token, req.query.date);
  if (!a) throw notFound('ลิงก์เวลาเข้างานไม่ถูกต้องหรือเกินช่วงที่ดูได้');
  const shift = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const from = shift(a.base, -ATT_WINDOW_DAYS), to = shift(a.base, ATT_WINDOW_DAYS);
  const days = await db.all('SELECT business_date AS day, COUNT(*) AS n FROM attendance WHERE business_date >= ? AND business_date <= ? GROUP BY business_date ORDER BY business_date', [from, to]);
  const rows = await attendanceOf(a.day);
  res.set('Cache-Control', 'no-store');
  res.json({ store: (await getSettings()).store.name || '', day: a.day, from, to, days: days.map((d) => ({ day: d.day, n: Number(d.n) })),
    rows: rows.map((r) => ({ name: r.name, at: r.at, kind: r.kind, main: !!r.main, terminal: r.terminal || '' })) });
}));
// link for the shop website / POS (today)
r.get('/attendance/link', staffAuth(), ah(async (req, res) => res.json({ url: await attendanceUrl(req.query.date || (await crewPlan()).date) })));

// today's roster for the POS sign-in screen (no login yet): how many scan in, who is on leave / joining later (names only)
r.get('/crew/today', ah(async (req, res) => {
  const p = await crewPlan();
  const ids = [...p.leave, ...p.late];
  const people = ids.length ? await db.all(`SELECT id, name, nickname FROM staff WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  const nm = (x) => { const s = people.find((y) => y.id === x); return s ? s.nickname || s.name : null; };
  const tid = String(req.query.terminal || '');
  const sh = tid ? await db.get("SELECT crew FROM shifts WHERE terminal_id = ? AND status = 'open'", [tid]) : null;
  const inShift = new Set(J(sh && sh.crew, []).map((c) => c.id));
  res.set('Cache-Control', 'no-store');
  res.json({ date: p.date, weekday: p.weekday, need: p.need, base: p.base, max: p.max, special: p.special, shift_open: !!sh,
    leave: p.leave.map(nm).filter(Boolean), late: p.late.map((x) => ({ name: nm(x), joined: inShift.has(x) })).filter((x) => x.name) });
}));

// ---------- terminals (เครื่องขาย) ----------
r.get('/terminals', staffAuth(), ah(async (req, res) => res.json(await db.all('SELECT * FROM terminals ORDER BY name'))));
r.post('/terminals', staffAuth('settings'), ah(async (req, res) => {
  const tid = id();
  await db.run('INSERT INTO terminals(id, name, created_at) VALUES(?,?,?)', [tid, String(req.body.name || 'เครื่องขาย').slice(0, 60), now()]);
  await audit(req.staff.id, 'create', 'terminal', tid, null, req.body);
  res.json(await db.get('SELECT * FROM terminals WHERE id = ?', [tid]));
}));
r.put('/terminals/:id', staffAuth('settings'), ah(async (req, res) => {
  await db.run('UPDATE terminals SET name = ? WHERE id = ?', [req.body.name, req.params.id]);
  res.json({ ok: true });
}));
// device status reports (printers found, screens detected...) shown on the admin website
r.post('/terminals/:id/report', staffAuth(), ah(async (req, res) => {
  await db.run('UPDATE terminals SET last_seen = ?, info = ? WHERE id = ?', [now(), S(req.body || {}), req.params.id]);
  res.json({ ok: true });
}));

// ---------- staff ----------
const pubStaff = (s) => ({ id: s.id, code: s.code, name: s.name, last_name: s.last_name || '', nickname: s.nickname || '', title: s.title || '', photo: s.photo, role_id: s.role_id, active: !!s.active, created_at: s.created_at, locked_until: s.locked_until });
const clean = (v, n = 60) => String(v ?? '').trim().slice(0, n);
const photoRef = (v) => (typeof v === 'string' && /^(\/files\/[\w-]+|https:\/\/[^\s"'<>]{1,480})$/.test(v) ? v : null);
// staff card: what the QR opens (no PIN, nothing private) and what the POS login shows after a scan
r.get('/public/staff/:token', ah(async (req, res) => {
  const code = await staffFromToken(req.params.token);
  const s = code && await db.get('SELECT * FROM staff WHERE code = ?', [code]);
  if (!s) throw notFound('บัตรพนักงานไม่ถูกต้อง');
  const role = await db.get('SELECT name FROM roles WHERE id = ?', [s.role_id]);
  const st = await getSettings();
  res.set('Cache-Control', 'no-store');
  res.json({ code: s.code, name: s.name, last_name: s.last_name || '', nickname: s.nickname || '', title: s.title || '', role_name: role ? role.name : '', photo: s.photo, active: !!s.active,
    since: s.created_at, store: st.store.name || '', logo: st.store.logo || '' });
}));
r.get('/staff/:id/card', staffAuth('manage_staff'), ah(async (req, res) => {
  const s = await db.get('SELECT * FROM staff WHERE id = ?', [req.params.id]);
  if (!s) throw notFound();
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  res.json({ url: `${base}/st/#${await staffToken(s.code)}` });
}));
r.get('/staff', staffAuth('manage_staff'), ah(async (req, res) => res.json((await db.all('SELECT * FROM staff ORDER BY code')).map(pubStaff))));
r.post('/staff', staffAuth('manage_staff'), ah(async (req, res) => {
  const b = req.body || {};
  if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw bad('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  if (!b.code || !b.name) throw bad('กรุณากรอกรหัสและชื่อพนักงาน');
  if (await db.get('SELECT id FROM staff WHERE code = ?', [b.code])) throw conflict('รหัสพนักงานซ้ำ');
  const sid = id();
  await db.run('INSERT INTO staff(id, code, name, last_name, nickname, title, photo, role_id, pin_hash, active, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [sid, String(b.code), clean(b.name), clean(b.last_name), clean(b.nickname, 30), clean(b.title), photoRef(b.photo), b.role_id || 'cashier', hashSecret(b.pin), b.active === false ? 0 : 1, now()]);
  await audit(req.staff.id, 'create', 'staff', sid, null, { code: b.code, name: b.name, role_id: b.role_id });
  res.json({ id: sid });
}));
r.put('/staff/:id', staffAuth('manage_staff'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM staff WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  const b = req.body || {};
  if (b.pin && !/^\d{4,6}$/.test(String(b.pin))) throw bad('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  await db.run('UPDATE staff SET name = ?, last_name = ?, nickname = ?, title = ?, photo = ?, role_id = ?, active = ?, pin_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [b.name !== undefined ? clean(b.name) : cur.name, b.last_name !== undefined ? clean(b.last_name) : cur.last_name, b.nickname !== undefined ? clean(b.nickname, 30) : cur.nickname, b.title !== undefined ? clean(b.title) : cur.title,
      b.photo !== undefined ? photoRef(b.photo) : cur.photo, b.role_id ?? cur.role_id, b.active === undefined ? cur.active : b.active ? 1 : 0, b.pin ? hashSecret(b.pin) : cur.pin_hash, cur.id]);
  if (b.active === false) await db.run("UPDATE sessions SET revoked = 1 WHERE kind = 'staff' AND subject_id = ?", [cur.id]);
  await audit(req.staff.id, 'update', 'staff', cur.id, pubStaff(cur), { ...pubStaff({ ...cur, ...b }), pin_changed: !!b.pin }, b.reason);
  res.json({ ok: true });
}));
r.get('/roles', staffAuth(), ah(async (req, res) => res.json({ roles: (await db.all('SELECT * FROM roles ORDER BY sort')).map((x) => ({ ...x, perms: J(x.perms, []) })), perms: PERMS })));
r.put('/roles/:id', staffAuth('manage_staff'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM roles WHERE id = ?', [req.params.id]);
  const perms = (req.body.perms || []).filter((p) => PERMS[p]);
  if (cur) await db.run('UPDATE roles SET name = ?, perms = ? WHERE id = ?', [req.body.name || cur.name, S(perms), cur.id]);
  else await db.run('INSERT INTO roles(id, name, perms, sort) VALUES(?,?,?,9)', [req.params.id, req.body.name || req.params.id, S(perms)]);
  await audit(req.staff.id, 'update', 'role', req.params.id, cur && J(cur.perms), perms, req.body.reason);
  res.json({ ok: true });
}));
r.get('/audit', staffAuth('settings'), ah(async (req, res) => {
  const rows = await db.all('SELECT a.*, s.name AS actor_name FROM audit a LEFT JOIN staff s ON s.id = a.actor ORDER BY a.created_at DESC LIMIT 300');
  res.json(rows.map((x) => ({ ...x, before_val: J(x.before_val), after_val: J(x.after_val) })));
}));

export default r;
