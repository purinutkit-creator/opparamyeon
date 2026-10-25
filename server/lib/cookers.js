// Noodle cookers (เครื่องต้ม): every bowl ticket goes to the cooker that will be free first,
// one bowl takes `minutes_per_bowl`, so bowls alternate between the machines as the queue grows.
// Times are estimates: a job counts as finished at its end time, or earlier when the kitchen bumps the ticket.
import { db } from '../db.js';
import { id, now, getSettings, emit } from './util.js';

const MIN = 60000;
export function cookerCfg(s) {
  const c = s.cookers || {};
  const count = Math.max(1, Math.min(8, Math.round(Number(c.count) || 2)));
  const minutes = Math.max(0.5, Math.min(60, Number(c.minutes_per_bowl) || 4));
  const list = Array.isArray(c.machines) ? c.machines : [];
  const machines = Array.from({ length: count }, (_, i) => ({ no: i + 1, name: String((list[i] && list[i].name) || `เครื่องต้ม ${i + 1}`).slice(0, 40), printer_id: (list[i] && list[i].printer_id) || '' }));
  return { enabled: c.enabled !== false, split_by_bowl: c.split_by_bowl !== false, minutes, machines };
}

const active = (t = now()) => db.all("SELECT * FROM cooker_jobs WHERE status = 'queued' AND end_at > ? ORDER BY start_at", [t]);

// when each machine will be free, from the jobs still running/queued
function freeTimes(cfg, jobs, t) {
  return cfg.machines.map((m) => jobs.filter((j) => j.machine === m.no).reduce((a, j) => Math.max(a, Date.parse(j.end_at)), Date.parse(t)));
}

// pick a cooker for a ticket with `bowls` bowls; ties go to the machine that was used least recently ("สลับวนไป")
export async function assignCooker(order, ticketId, bowls) {
  const s = await getSettings();
  const cfg = cookerCfg(s);
  if (!cfg.enabled || !(bowls > 0)) return null;
  const t = now();
  const free = freeTimes(cfg, await active(t), t);
  const last = await db.get('SELECT machine FROM cooker_jobs ORDER BY created_at DESC, start_at DESC LIMIT 1');
  const order0 = cfg.machines.map((m) => m.no).sort((a, b) => ((a - (last ? last.machine : 0) - 1 + 64) % cfg.machines.length) - ((b - (last ? last.machine : 0) - 1 + 64) % cfg.machines.length));
  let best = order0[0];
  for (const no of order0) if (free[no - 1] < free[best - 1]) best = no;
  const start = free[best - 1], end = start + bowls * cfg.minutes * MIN;
  await db.run('INSERT INTO cooker_jobs(id, order_id, ticket_id, machine, bowls, queue_no, start_at, end_at, status, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [id(), order.id, ticketId, best, bowls, order.queue_no || '', new Date(start).toISOString(), new Date(end).toISOString(), 'queued', t]);
  const m = cfg.machines[best - 1];
  return { no: best, name: m.name, printer_id: m.printer_id, bowls, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString(), wait_min: Math.ceil((end - Date.parse(t)) / MIN) };
}

// jobs that have not started yet move up when something ahead finished early
async function repack(machine) {
  const s = await getSettings();
  const cfg = cookerCfg(s);
  const t = Date.parse(now());
  let at = t;
  for (const j of await db.all("SELECT * FROM cooker_jobs WHERE status = 'queued' AND machine = ? AND end_at > ? ORDER BY start_at", [machine, new Date(t).toISOString()])) {
    const st = Date.parse(j.start_at);
    if (st <= t) { at = Math.max(at, Date.parse(j.end_at)); continue; } // already cooking
    const ns = Math.max(at, t), ne = ns + j.bowls * cfg.minutes * MIN;
    if (ns < st) { await db.run('UPDATE cooker_jobs SET start_at = ?, end_at = ? WHERE id = ?', [new Date(ns).toISOString(), new Date(ne).toISOString(), j.id]); at = ne; }
    else at = Date.parse(j.end_at);
  }
}
async function close(where, args, status) {
  const rows = await db.all(`SELECT DISTINCT machine FROM cooker_jobs WHERE status = 'queued' AND ${where}`, args);
  if (!rows.length) return;
  await db.run(`UPDATE cooker_jobs SET status = ?, end_at = CASE WHEN end_at > ? THEN ? ELSE end_at END WHERE status = 'queued' AND ${where}`, [status, now(), now(), ...args]);
  for (const r of rows) await repack(r.machine);
  emit('shop', 'cookers:changed', {});
}
export const finishTicket = (ticketId) => close('ticket_id = ?', [ticketId], 'done');
export const finishOrder = (orderId) => close('order_id = ?', [orderId], 'done');
export const voidOrderJobs = (orderId) => close('order_id = ?', [orderId], 'void');
export const changed = () => emit('shop', 'cookers:changed', {});

// what the POS shows: per machine bowls still waiting/cooking and when it is free
export async function cookerStatus() {
  const s = await getSettings();
  const cfg = cookerCfg(s);
  const t = now(), tn = Date.parse(t);
  const jobs = await active(t);
  const free = freeTimes(cfg, jobs, t);
  return {
    enabled: cfg.enabled, minutes_per_bowl: cfg.minutes, now: t,
    machines: cfg.machines.map((m, i) => {
      const mine = jobs.filter((j) => j.machine === m.no);
      // bowls not finished yet (the one in the pot counts until its time is up)
      const left = mine.reduce((a, j) => a + Math.min(j.bowls, Math.ceil((Date.parse(j.end_at) - tn) / (cfg.minutes * MIN))), 0);
      return { no: m.no, name: m.name, bowls: left, free_at: new Date(free[i]).toISOString(), minutes_left: Math.max(0, Math.ceil((free[i] - tn) / MIN)),
        queue: mine.map((j) => ({ queue_no: j.queue_no, bowls: j.bowls, end_at: j.end_at })) };
    }),
  };
}
export async function jobsOf(orderId) {
  const cfg = cookerCfg(await getSettings());
  return (await db.all("SELECT ticket_id, machine, bowls, start_at, end_at, status FROM cooker_jobs WHERE order_id = ? AND status <> 'void' ORDER BY start_at", [orderId]))
    .map((j) => ({ ...j, name: (cfg.machines[j.machine - 1] || { name: `เครื่องต้ม ${j.machine}` }).name }));
}
