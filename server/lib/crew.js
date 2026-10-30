// Staff working a shift together (several people sign in on one POS: the main one plus the crew)
import { db, J, S } from '../db.js';
import { now } from './util.js';

// everyone who worked a shift is kept on it (joined time; "main" = the one the POS was signed in as)
export async function joinShiftCrew(shiftId, people) {
  const sh = await db.get('SELECT crew FROM shifts WHERE id = ?', [shiftId]);
  if (!sh) return;
  const list = J(sh.crew, []);
  for (const p of people) { const i = list.findIndex((x) => x.id === p.id); if (i < 0) list.push({ ...p, at: now() }); else if (p.main) list[i].main = true; }
  await db.run('UPDATE shifts SET crew = ? WHERE id = ?', [S(list), shiftId]);
}
