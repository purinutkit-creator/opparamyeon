// Staff working a shift together: the owner's roster (how many scan in at opening, who joins later, who is on leave)
// and the crew kept on each shift (the main sign-in plus everyone else).
import { db, J, S } from '../db.js';
import { now, getSettings, businessDateOf, HttpError } from './util.js';
import { verifyStaffPin } from './auth.js';

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
