import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, hashSecret, audit, conflict } from '../lib/util.js';
import { staffAuth, verifyStaffPin, createSession, PERMS } from '../lib/auth.js';

const r = Router();

r.post('/auth/login', ah(async (req, res) => {
  const { code, pin, terminal_id } = req.body || {};
  const s = await verifyStaffPin(code, pin);
  const term = terminal_id ? await db.get('SELECT id FROM terminals WHERE id = ?', [terminal_id]) : null;
  const tok = await createSession('staff', s.id, term ? term.id : null);
  const role = await db.get('SELECT * FROM roles WHERE id = ?', [s.role_id]);
  await audit(s.id, 'login', 'staff', s.id, null, { terminal_id: term && term.id });
  res.json({ token: tok, staff: { id: s.id, code: s.code, name: s.name, photo: s.photo, role_id: s.role_id, role_name: role.name, perms: J(role.perms, []) } });
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
const pubStaff = (s) => ({ id: s.id, code: s.code, name: s.name, photo: s.photo, role_id: s.role_id, active: !!s.active, created_at: s.created_at, locked_until: s.locked_until });
r.get('/staff', staffAuth('manage_staff'), ah(async (req, res) => res.json((await db.all('SELECT * FROM staff ORDER BY code')).map(pubStaff))));
r.post('/staff', staffAuth('manage_staff'), ah(async (req, res) => {
  const b = req.body || {};
  if (!/^\d{4,6}$/.test(String(b.pin || ''))) throw bad('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  if (!b.code || !b.name) throw bad('กรุณากรอกรหัสและชื่อพนักงาน');
  if (await db.get('SELECT id FROM staff WHERE code = ?', [b.code])) throw conflict('รหัสพนักงานซ้ำ');
  const sid = id();
  await db.run('INSERT INTO staff(id, code, name, photo, role_id, pin_hash, active, created_at) VALUES(?,?,?,?,?,?,?,?)',
    [sid, String(b.code), b.name, b.photo || null, b.role_id || 'cashier', hashSecret(b.pin), b.active === false ? 0 : 1, now()]);
  await audit(req.staff.id, 'create', 'staff', sid, null, { code: b.code, name: b.name, role_id: b.role_id });
  res.json({ id: sid });
}));
r.put('/staff/:id', staffAuth('manage_staff'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM staff WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  const b = req.body || {};
  if (b.pin && !/^\d{4,6}$/.test(String(b.pin))) throw bad('PIN ต้องเป็นตัวเลข 4-6 หลัก');
  await db.run('UPDATE staff SET name = ?, photo = ?, role_id = ?, active = ?, pin_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?',
    [b.name ?? cur.name, b.photo ?? cur.photo, b.role_id ?? cur.role_id, b.active === undefined ? cur.active : b.active ? 1 : 0, b.pin ? hashSecret(b.pin) : cur.pin_hash, cur.id]);
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
