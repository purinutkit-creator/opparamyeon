import { db, J, S } from '../db.js';
import { id, now, nextCounter, emit, getSettings, notFound, conflict, bad } from './util.js';
import { DEFAULT_TEMPLATES } from './templates.js';
import { dineLabel, baht, maskPhone } from '../../public/shared/core.js';

export const STALE_MS = 120000;

export async function templateFor(docType, printer) {
  const tid = printer ? J(printer.templates, {})[docType] : null;
  let t = tid ? await db.get('SELECT * FROM templates WHERE id = ?', [tid]) : null;
  if (!t) t = await db.get('SELECT * FROM templates WHERE doc_type = ? AND is_default = 1', [docType]);
  return t ? { id: t.id, data: J(t.data) } : { id: null, data: DEFAULT_TEMPLATES[docType] };
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export async function storeData() {
  const s = await getSettings();
  return { store_name: s.store.name, branch: s.store.branch, address: s.store.address, phone: s.store.phone, tax_id: s.store.tax_id, logo: s.store.logo, footer: s.store.footer };
}

// Build a printable data snapshot for an order (receipt / queue / refund).
export async function orderDocData(order, extra = {}) {
  const s = await getSettings();
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY seq', [order.id]);
  const pays = await db.all("SELECT method, amount, received, change_amount FROM payments WHERE order_id = ? AND status = 'paid' ORDER BY created_at", [order.id]);
  const staff = order.staff_id ? await db.get('SELECT name FROM staff WHERE id = ?', [order.staff_id]) : null;
  const member = order.member_id ? await db.get('SELECT member_no, first_name, last_name, nickname, phone FROM members WHERE id = ?', [order.member_id]) : null;
  const methods = Object.fromEntries(s.sale.payment_methods.map((m) => [m.id, m.name]));
  const base = process.env.PUBLIC_URL || '';
  const memberName = member ? `${member.first_name || member.nickname || ''} ${member.last_name || ''}`.trim() + ` (${member.member_no})` : '';
  return {
    ...(await storeData()),
    bill_no: order.bill_no, queue_no: order.queue_no || '', dine_type: order.dine_type, dine_label: dineLabel(order.dine_type),
    table: order.table_name || '', customer: order.customer_name || '', member: s.members.show_on_receipt ? memberName : '',
    member_name: memberName, staff: staff ? staff.name : (order.source !== 'pos' ? 'Mobile Ordering' : ''), datetime: fmtDate(order.paid_at || order.created_at),
    order_note: order.note || '', bowls: order.bowls,
    items: items.filter((i) => i.qty - i.void_qty > 0).map((i) => ({ name: i.name, qty: i.qty - i.void_qty, options: J(i.options, []), note: i.note,
      dine_type: i.dine_type, line_total: i.line_total, bowl_group: i.bowl_group })),
    totals: { items_total: order.items_total, discount: order.discount, packaging: order.packaging, tax: order.tax, total: order.total },
    tax_inclusive: s.sale.tax_inclusive, tax_rate: s.sale.tax_rate,
    payments: pays.map((p) => ({ method: methods[p.method] || p.method, amount: p.amount, received: p.received, change: p.change_amount })),
    total: baht(order.total), total_satang: order.total, table_name: order.table_name || '', customer_name: order.customer_name || '',
    member_phone: member ? maskPhone(member.phone) : '',
    claim_available: !order.member_id && order.claim_status === 'available' && s.points.claim_qr && s.points.enabled,
    claim_url: order.claim_token ? `${base}/member/#/claim/${order.claim_token}` : '',
    ...extra,
  };
}

// Create one job per matching printer and copy. dedupe makes the same document impossible to enqueue twice.
export async function enqueue(docType, refId, data, { stationId = null, dedupe = null, printerId = null } = {}) {
  let printers = await db.all('SELECT * FROM printers WHERE active = 1');
  printers = printers.filter((p) => (printerId ? p.id === printerId : J(p.roles, []).includes(docType)));
  if (docType === 'kitchen' && stationId && !printerId) printers = printers.filter((p) => { const st = J(p.station_ids, []); return !st.length || st.includes(stationId); });
  const jobs = [];
  for (const p of printers) {
    const tpl = await templateFor(docType, p);
    const copies = Math.max(1, Number(tpl.data.copies || p.copies || 1));
    for (let c = 1; c <= copies; c++) {
      const key = dedupe ? `${dedupe}:${p.id}:${c}` : null;
      if (key && await db.get('SELECT id FROM print_jobs WHERE dedupe_key = ?', [key])) continue;
      const jid = id();
      const seq = await nextCounter('jobseq');
      await db.run('INSERT INTO print_jobs(id, printer_id, doc_type, ref_id, payload, status, dedupe_key, created_at, updated_at, seq, history) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        [jid, p.id, docType, refId, S({ data: { ...data, copy: c, copies }, template_id: tpl.id }), 'queued', key, now(), now(), seq, S([{ at: now(), status: 'queued' }])]);
      jobs.push({ id: jid, printer_id: p.id, host: p.host_terminal_id });
    }
  }
  for (const j of jobs) emit('print:' + j.printer_id, 'print:queued', { job_id: j.id, printer_id: j.printer_id });
  if (jobs.length) emit('admin', 'print:changed', {});
  return jobs;
}

// Strictly ordered per printer: a printer only gets its next job when the previous one is finished.
export async function claimNext(printerId, hostId) {
  return db.tx(async () => {
    const busy = await db.get("SELECT id, updated_at FROM print_jobs WHERE printer_id = ? AND status = 'claimed' ORDER BY seq LIMIT 1", [printerId]);
    if (busy) {
      if (Date.now() - new Date(busy.updated_at).getTime() < STALE_MS) return null;
      // never reprint automatically: the printer may already have printed it
      await setStatus(busy.id, 'unknown', 'ไม่ได้รับผลจากอุปกรณ์ภายในเวลาที่กำหนด — ตรวจสอบกระดาษแล้วกดลองใหม่หากยังไม่ออก');
    }
    const job = await db.get("SELECT * FROM print_jobs WHERE printer_id = ? AND status = 'queued' ORDER BY seq LIMIT 1", [printerId]);
    if (!job) return null;
    const r = await db.run("UPDATE print_jobs SET status = 'claimed', claimed_by = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'", [hostId, now(), job.id]);
    if (!r.changes) return null;
    await pushHistory(job.id, 'claimed', hostId);
    const printer = await db.get('SELECT * FROM printers WHERE id = ?', [printerId]);
    const payload = J(job.payload);
    const tpl = payload.template_id ? await db.get('SELECT data FROM templates WHERE id = ?', [payload.template_id]) : null;
    return { ...job, status: 'claimed', payload, template: tpl ? J(tpl.data) : DEFAULT_TEMPLATES[job.doc_type], printer: publicPrinter(printer) };
  });
}

async function pushHistory(jobId, status, note) {
  const j = await db.get('SELECT history FROM print_jobs WHERE id = ?', [jobId]);
  const h = J(j.history, []); h.push({ at: now(), status, note: note || undefined });
  await db.run('UPDATE print_jobs SET history = ? WHERE id = ?', [S(h.slice(-30)), jobId]);
}
export async function setStatus(jobId, status, error = null) {
  await db.run('UPDATE print_jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?', [status, error, now(), jobId]);
  await pushHistory(jobId, status, error);
  const j = await db.get('SELECT id, printer_id, doc_type, ref_id, status, error FROM print_jobs WHERE id = ?', [jobId]);
  emit('shop', 'print:status', j);
  emit('admin', 'print:changed', {});
  return j;
}

// Host reports the result. 'sent' = bytes delivered/accepted by the printer; 'printed' only when the printer confirmed.
export async function report(jobId, hostId, status, error) {
  if (!['sent', 'printed', 'failed'].includes(status)) throw bad('สถานะไม่ถูกต้อง');
  const j = await db.get('SELECT * FROM print_jobs WHERE id = ?', [jobId]);
  if (!j) throw notFound();
  if (j.status !== 'claimed' && !(j.status === 'sent' && status === 'printed')) throw conflict('งานพิมพ์นี้ถูกปิดไปแล้ว');
  return setStatus(jobId, status, error || null);
}

export async function retry(jobId) {
  const r = await db.run("UPDATE print_jobs SET status = 'queued', updated_at = ?, error = NULL WHERE id = ? AND status IN ('failed','unknown','cancelled')", [now(), jobId]);
  if (!r.changes) throw conflict('ลองใหม่ได้เฉพาะงานที่ล้มเหลว/ไม่ทราบสถานะ');
  await pushHistory(jobId, 'queued', 'retry');
  const j = await db.get('SELECT printer_id FROM print_jobs WHERE id = ?', [jobId]);
  emit('print:' + j.printer_id, 'print:queued', { job_id: jobId, printer_id: j.printer_id });
}

// Reprint = a new job with the same snapshot (same queue no / bill no). It never creates an order.
export async function reprint(jobId, actor) {
  const j = await db.get('SELECT * FROM print_jobs WHERE id = ?', [jobId]);
  if (!j) throw notFound();
  const payload = J(j.payload);
  const n = await nextCounter('reprint:' + jobId);
  const nid = id();
  await db.run('INSERT INTO print_jobs(id, printer_id, doc_type, ref_id, payload, status, dedupe_key, created_at, updated_at, seq, history) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    [nid, j.printer_id, j.doc_type, j.ref_id, S({ ...payload, data: { ...payload.data, reprint: true } }), 'queued', `reprint:${jobId}:${n}`, now(), now(), await nextCounter('jobseq'),
      S([{ at: now(), status: 'queued', note: 'reprint by ' + actor }])]);
  emit('print:' + j.printer_id, 'print:queued', { job_id: nid, printer_id: j.printer_id });
  return nid;
}

export function publicPrinter(p) {
  if (!p) return null;
  return { ...p, roles: J(p.roles, []), station_ids: J(p.station_ids, []), templates: J(p.templates, {}) };
}
