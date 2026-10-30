// Staff working a shift together: the owner's roster (how many scan in at opening, who joins later, who is on leave)
// and the crew kept on each shift (the main sign-in plus everyone else).
import { db, J, S } from '../db.js';
import { id, now, getSettings, businessDateOf, HttpError } from './util.js';
import { verifyStaffPin } from './auth.js';
import { enqueue } from './print.js';
import { ATTENDANCE_SLIP } from './templates.js';
import { attendanceToken, staffFromTicket } from './billlink.js';

// everyone who worked a shift is kept on it (joined time; "main" = the one the POS was signed in as)
export async function joinShiftCrew(shiftId, people) {
  const sh = await db.get('SELECT crew FROM shifts WHERE id = ?', [shiftId]);
  if (!sh) return [];
  const list = J(sh.crew, []);
  for (const p of people) { const i = list.findIndex((x) => x.id === p.id); if (i < 0) list.push({ ...p, at: now() }); else if (p.main) list[i].main = true; }
  await db.run('UPDATE shifts SET crew = ? WHERE id = ?', [S(list), shiftId]);
  return list;
}

// today's plan (business day): weekly count, or the special day's count, minus the people on leave
export async function crewPlan(date) {
  const cfg = (await getSettings()).crew || {};
  const day = date || await businessDateOf();
  const wd = new Date(day + 'T12:00:00Z').getUTCDay();
  const sp = (cfg.dates || {})[day] || {};
  const base = Math.max(1, Math.round(Number(sp.count ?? (cfg.weekly || {})[wd] ?? 1) || 1));
  const leave = (sp.leave || []).map(String), late = (sp.late || []).map(String).filter((x) => !leave.includes(x));
  return { date: day, weekday: wd, base, need: Math.max(1, base - leave.length), leave, late, special: !!(cfg.dates || {})[day], max: Math.max(2, Number(cfg.max) || 8) };
}

// PIN check for signing in on the POS: someone the owner marked on leave today can't join
export async function verifyOnDuty(code, pin, plan) {
  const s = await verifyStaffPin(code, pin);
  const p = plan || await crewPlan();
  if (p.leave.includes(s.id)) throw new HttpError(403, `${s.name} ลาหยุดวันนี้ (ตั้งไว้โดยร้าน) — เข้างานไม่ได้`, 'on_leave');
  return s;
}

// clock-in times: everyone's first sign-in of the business day is kept (later sign-ins don't move it).
// "at" comes from the POS (the moment the card/PIN was accepted); anything outside the last 3 hours falls back to now.
const sane = (at) => { const t = Date.parse(at || ''), n = Date.now(); return t && t > n - 3 * 3600e3 && t < n + 120e3 ? new Date(t).toISOString() : now(); };
export async function clockIn(people, { terminalId = null, shiftId = null, kind = 'open' } = {}) {
  const day = await businessDateOf();
  const added = [];
  for (const p of people) {
    if (await db.get('SELECT id FROM attendance WHERE staff_id = ? AND business_date = ?', [p.id, day])) continue;
    const row = { id: id(), staff_id: p.id, name: p.name, business_date: day, at: sane(p.at), terminal_id: terminalId, shift_id: shiftId, kind, main: p.main ? 1 : 0, created_at: now(),
      photo: (p.selfie && p.selfie.url) || '', face_ok: p.selfie && p.selfie.face_ok !== undefined && p.selfie.face_ok !== null ? (p.selfie.face_ok ? 1 : 0) : null, live: p.selfie ? (p.selfie.live ? 1 : 0) : null };
    await db.run('INSERT INTO attendance(id, staff_id, name, business_date, at, terminal_id, shift_id, kind, main, created_at, photo, face_ok, live) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', Object.values(row));
    added.push(row);
  }
  return { day, added };
}
export async function attendanceOf(day) {
  return db.all(`SELECT a.staff_id, a.name, a.at, a.kind, a.main, a.photo, a.face_ok, a.live, t.name AS terminal FROM attendance a LEFT JOIN terminals t ON t.id = a.terminal_id
    WHERE a.business_date = ? ORDER BY a.at`, [day]);
}
export async function attendanceUrl(day) {
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  return `${base}/at/#${await attendanceToken(day)}`;
}
const hm = (iso) => new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
// print the day's clock-in slip (everyone so far) when people were added; the shop picks when and where
export async function printAttendance(day, terminalId) {
  const s = await getSettings(), cfg = s.crew || {};
  if (cfg.print === 'off') return [];
  const rows = await attendanceOf(day);
  if (!rows.length) return [];
  let printerId = cfg.printer_id || null;
  if (!printerId) { // the receipt printer of this POS (first one with the receipt job)
    const ps = await db.all('SELECT id, roles, host_terminal_id, paper FROM printers WHERE active = 1');
    const rec = ps.filter((p) => J(p.roles, []).includes('receipt'));
    printerId = (rec.find((p) => p.host_terminal_id === terminalId) || rec[0] || {}).id || null;
  }
  if (!printerId) return [];
  const pr = await db.get('SELECT paper FROM printers WHERE id = ?', [printerId]);
  const term = terminalId ? await db.get('SELECT name FROM terminals WHERE id = ?', [terminalId]) : null;
  const dayText = new Date(day + 'T12:00:00Z').toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const data = { store_name: s.store.name, day_text: dayText, terminal: term ? term.name : '', att_url: await attendanceUrl(day),
    rows: rows.map((r) => [r.name + (r.main ? ' (หลัก)' : r.kind === 'late' ? ' (มาทีหลัง)' : ''), hm(r.at) + ' น.']),
    summary: `เข้างานแล้ว ${rows.length} คน`, printed_at: new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) };
  return enqueue('attendance', day, data, { printerId, template: ATTENDANCE_SLIP(Number(pr && pr.paper) === 58 ? 58 : 80) });
}

// ---- clock-in selfie ----
export async function clockedToday(staffId) { return !!(await db.get('SELECT id FROM attendance WHERE staff_id = ? AND business_date = ?', [staffId, await businessDateOf()])); }
// the photo taken for this ticket (POS camera or the phone behind the QR); the face check result comes from the device that confirmed it
export async function selfieOf(staffId, ticket, face) {
  if (!ticket || (await staffFromTicket(ticket)) !== staffId) return null;
  const p = await db.get('SELECT url, live FROM clockin_photos WHERE ticket = ? AND staff_id = ?', [ticket, staffId]);
  return p && p.url ? { url: p.url, live: !!p.live, face_ok: face && face.ok !== undefined ? face.ok : null } : null;
}
// required by the shop: a selfie at every POS sign-in (or only the first of the day, if the shop set it so)
export async function needSelfie(staffId) {
  const cfg = (await getSettings()).crew || {};
  if ((cfg.selfie || 'required') !== 'required') return false;
  return (cfg.selfie_when || 'every') === 'every' || !(await clockedToday(staffId));
}
