// printers, print jobs, templates, fonts, files, settings, business day rules
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import QRCode from 'qrcode';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, audit, emit, getSettings, setSetting, clearRulesCache, dayRules, businessDateOf, DEFAULT_SETTINGS } from '../lib/util.js';
import { staffAuth, can, requirePerm } from '../lib/auth.js';
import { claimNext, report, retry, reprint, publicPrinter, enqueue, storeData, normalizePrinterOptions, feedMerchantRoll } from '../lib/print.js';
import { DEFAULT_TEMPLATES, DOC_TYPES, COMPACT_MERCHANT, COMPACT_MERCHANT_NAME } from '../lib/templates.js';
import { VERSION, businessRange } from '../../public/shared/core.js';

const r = Router();
const upload = multer({ limits: { fileSize: 60 * 1024 * 1024 } });

// ---------- files: stored in DB (works on Render without a disk) or UPLOAD_DIR when set ----------
const UPLOAD_DIR = process.env.UPLOAD_DIR || '';
export async function saveFile(buf, name, mime) {
  const fid = id();
  if (UPLOAD_DIR) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
    const p = path.join(UPLOAD_DIR, fid);
    fs.writeFileSync(p, buf);
    await db.run('INSERT INTO files(id, name, mime, size, path, created_at) VALUES(?,?,?,?,?,?)', [fid, name, mime, buf.length, p, now()]);
  } else {
    await db.run('INSERT INTO files(id, name, mime, size, data, created_at) VALUES(?,?,?,?,?,?)', [fid, name, mime, buf.length, buf.toString('base64'), now()]);
  }
  return fid;
}
const IMG = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/;
const VID = /^video\/(mp4|webm|ogg)$/;
const AUD = /^audio\/(mpeg|mp3|wav|x-wav|ogg|webm|aac|mp4)$/;
r.post('/files', staffAuth(), upload.single('file'), ah(async (req, res) => {
  const f = req.file;
  if (!f) throw bad('ไม่พบไฟล์');
  const kind = req.body.kind || 'image';
  const okMime = kind === 'video' ? VID.test(f.mimetype) || IMG.test(f.mimetype) : kind === 'audio' ? AUD.test(f.mimetype) : IMG.test(f.mimetype);
  if (!okMime) throw bad('ชนิดไฟล์ไม่รองรับ: ' + f.mimetype);
  if (kind === 'image' && f.size > 8 * 1024 * 1024) throw bad('รูปภาพต้องไม่เกิน 8MB');
  const fid = await saveFile(f.buffer, f.originalname, f.mimetype);
  res.json({ id: fid, url: '/files/' + fid, mime: f.mimetype, size: f.size });
}));
export async function serveFile(req, res) {
  const f = await db.get('SELECT * FROM files WHERE id = ?', [req.params.id]);
  if (!f) return res.status(404).end();
  res.setHeader('Content-Type', f.mime || 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  if (f.path) return res.sendFile(path.resolve(f.path));
  const buf = Buffer.from(f.data, 'base64');
  // range support so promo videos can play/seek
  const range = req.headers.range;
  if (range) {
    const [a, b] = range.replace('bytes=', '').split('-');
    const start = Number(a) || 0, end = b ? Number(b) : buf.length - 1;
    res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${buf.length}`);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.end(buf.subarray(start, end + 1));
  }
  res.end(buf);
}

// ---------- QR / misc ----------
export async function qrSvg(req, res) {
  const data = String(req.query.d || '').slice(0, 1200);
  if (!data) return res.status(400).end();
  res.setHeader('Content-Type', 'image/svg+xml');
  res.end(await QRCode.toString(data, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
}
r.get('/qr-matrix', ah(async (req, res) => {
  // raw module matrix for thermal printing (so QR is rendered crisp at exact dots)
  const q = QRCode.create(String(req.query.d || '').slice(0, 1200), { errorCorrectionLevel: 'M' });
  res.json({ size: q.modules.size, data: Array.from(q.modules.data) });
}));

// ---------- printers ----------
r.get('/printers', staffAuth(), ah(async (req, res) => res.json((await db.all('SELECT * FROM printers ORDER BY name')).map(publicPrinter))));
const PR = ['name', 'conn', 'address', 'port', 'paper', 'margin', 'copies', 'roles', 'station_ids', 'cut_mode', 'feed_before', 'feed_after', 'buzzer', 'beep_count', 'render',
  'host_terminal_id', 'templates', 'can_confirm', 'active', 'options'];
function normPrinter(b, cur = {}) {
  const o = {};
  for (const f of PR) o[f] = b[f] !== undefined ? b[f] : cur[f];
  if (!['usb', 'lan', 'bluetooth', 'serial', 'agent_usb', 'browser'].includes(o.conn)) throw bad('ช่องทางเชื่อมต่อไม่ถูกต้อง');
  if (![58, 80].includes(Number(o.paper))) throw bad('ขนาดกระดาษต้องเป็น 58 หรือ 80 มม.');
  for (const f of ['roles', 'station_ids', 'templates']) if (typeof o[f] !== 'string') o[f] = S(o[f] || (f === 'templates' ? {} : []));
  for (const f of ['port', 'paper', 'margin', 'copies', 'feed_before', 'feed_after', 'beep_count']) o[f] = Number(o[f]) || 0;
  for (const f of ['buzzer', 'can_confirm']) o[f] = o[f] ? 1 : 0;
  o.active = o.active === undefined ? 1 : o.active ? 1 : 0;
  o.copies = Math.max(1, o.copies);
  o.options = S(normalizePrinterOptions(typeof o.options === 'string' ? J(o.options, {}) : o.options || {}));
  return o;
}
r.post('/printers', staffAuth('manage_printers'), ah(async (req, res) => {
  const o = normPrinter(req.body);
  const pid = id();
  await db.run(`INSERT INTO printers(id, ${PR.join(', ')}) VALUES(?, ${PR.map(() => '?').join(', ')})`, [pid, ...PR.map((f) => o[f])]);
  await audit(req.staff.id, 'create', 'printer', pid, null, o);
  emit('shop', 'printers:changed', {});
  res.json({ id: pid });
}));
r.put('/printers/:id', staffAuth('manage_printers'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM printers WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  const o = normPrinter(req.body, cur);
  await db.run(`UPDATE printers SET ${PR.map((f) => f + ' = ?').join(', ')} WHERE id = ?`, [...PR.map((f) => o[f]), cur.id]);
  await audit(req.staff.id, 'update', 'printer', cur.id, null, o);
  emit('shop', 'printers:changed', {});
  res.json({ ok: true });
}));
r.delete('/printers/:id', staffAuth('manage_printers'), ah(async (req, res) => {
  await db.run('UPDATE printers SET active = 0 WHERE id = ?', [req.params.id]);
  await db.run("UPDATE print_jobs SET status = 'cancelled' WHERE printer_id = ? AND status = 'queued'", [req.params.id]);
  emit('shop', 'printers:changed', {});
  res.json({ ok: true });
}));
// device reports the printer connection status (real hardware check happens on the device)
r.post('/printers/:id/status', staffAuth(), ah(async (req, res) => {
  await db.run('UPDATE printers SET status = ?, status_at = ? WHERE id = ?', [String(req.body.status || '').slice(0, 200), now(), req.params.id]);
  emit('admin', 'print:changed', {});
  res.json({ ok: true });
}));

// ---------- print jobs ----------
r.post('/print/claim', staffAuth(), ah(async (req, res) => {
  const p = await db.get('SELECT * FROM printers WHERE id = ? AND active = 1', [req.body.printer_id]);
  if (!p) throw notFound('ไม่พบเครื่องพิมพ์');
  res.json(await claimNext(p.id, req.body.host || req.terminalId || req.staff.id));
}));
r.post('/print/jobs/:id/report', staffAuth(), ah(async (req, res) => res.json(await report(req.params.id, req.terminalId, req.body.status, req.body.error))));
r.post('/print/jobs/:id/retry', staffAuth('reprint'), ah(async (req, res) => { await retry(req.params.id); await audit(req.staff.id, 'print_retry', 'print_job', req.params.id); res.json({ ok: true }); }));
r.post('/print/jobs/:id/reprint', staffAuth('reprint'), ah(async (req, res) => res.json({ id: await reprint(req.params.id, req.staff.id) })));
r.post('/print/jobs/:id/cancel', staffAuth('reprint'), ah(async (req, res) => {
  const ch = await db.run("UPDATE print_jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','failed','unknown')", [now(), req.params.id]);
  if (!ch.changes) throw conflict('ยกเลิกไม่ได้ (กำลังพิมพ์หรือเสร็จแล้ว)');
  res.json({ ok: true });
}));
r.get('/print/jobs', staffAuth(), ah(async (req, res) => {
  const rows = await db.all(`SELECT j.id, j.printer_id, j.doc_type, j.ref_id, j.status, j.error, j.attempts, j.created_at, j.updated_at, j.history, p.name AS printer_name
    FROM print_jobs j LEFT JOIN printers p ON p.id = j.printer_id ${req.query.status ? 'WHERE j.status = ?' : ''} ORDER BY j.seq DESC LIMIT 200`, req.query.status ? [req.query.status] : []);
  res.json(rows.map((x) => ({ ...x, history: J(x.history, []) })));
}));
// status of a few jobs (the POS waits for the shift-close summary to finish printing)
r.get('/print/jobs/status', staffAuth(), ah(async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, 20);
  const rows = ids.length ? await db.all(`SELECT id, status, error FROM print_jobs WHERE id IN (${ids.map(() => '?').join(',')})`, ids) : [];
  res.json(rows);
}));
// test pages & manual cut are executed on the device; this records them and lets a remote device run them
r.post('/print/test', staffAuth('manage_printers'), ah(async (req, res) => {
  const p = await db.get('SELECT * FROM printers WHERE id = ?', [req.body.printer_id]);
  if (!p) throw notFound();
  // a template from the designer can be test-printed on the real printer (same renderer as the preview)
  const jobs = req.body.template
    ? await enqueue(req.body.doc_type || 'receipt', 'test-' + Date.now(), { ...(req.body.data || {}), ...(await storeData()) }, { printerId: p.id, template: req.body.template })
    : await enqueue('test', 'test-' + Date.now(), { ...(await storeData()), test: req.body.what || 'all', datetime: new Date().toLocaleString('th-TH') }, { printerId: p.id });
  res.json({ jobs });
}));
// "feed more" / "cut" for the merchant summary roll (shift close screen)
r.post('/print/merchant-feed', staffAuth(), ah(async (req, res) => {
  const b = req.body || {};
  res.json({ printers: await feedMerchantRoll({ lines: b.lines, cut: b.cut }) });
}));
r.post('/print/cut', staffAuth('cut_paper'), ah(async (req, res) => {
  await audit(req.staff.id, 'manual_cut', 'printer', req.body.printer_id);
  if (req.body.local) return res.json({ ok: true }); // already cut directly on this device
  const jobs = await enqueue('cut', 'cut-' + Date.now(), {}, { printerId: req.body.printer_id });
  res.json({ jobs });
}));

// ---------- templates ----------
r.get('/templates', staffAuth(), ah(async (req, res) => {
  const rows = await db.all('SELECT * FROM templates ORDER BY doc_type, name');
  res.json({ templates: rows.map((t) => ({ ...t, data: J(t.data) })), defaults: DEFAULT_TEMPLATES, doc_types: DOC_TYPES, compact_merchant: COMPACT_MERCHANT, compact_merchant_name: COMPACT_MERCHANT_NAME });
}));
function validateTemplate(d) {
  if (!d || !Array.isArray(d.elements)) throw bad('แม่แบบไม่ถูกต้อง');
  if (![58, 80].includes(Number(d.paper))) throw bad('ขนาดกระดาษไม่ถูกต้อง');
  for (const e of d.elements) if (e.type === 'qr' && Number(e.size_mm) < 15) throw bad('QR Code ต้องมีขนาดอย่างน้อย 15 มม. เพื่อให้สแกนได้');
  return d;
}
r.post('/templates', staffAuth('settings'), ah(async (req, res) => {
  const { doc_type, name, data, is_default } = req.body;
  if (!DOC_TYPES[doc_type]) throw bad('ประเภทเอกสารไม่ถูกต้อง');
  const tid = id();
  await db.tx(async () => {
    if (is_default) await db.run('UPDATE templates SET is_default = 0 WHERE doc_type = ?', [doc_type]);
    await db.run('INSERT INTO templates(id, doc_type, name, data, is_default, updated_at) VALUES(?,?,?,?,?,?)', [tid, doc_type, name || 'แม่แบบใหม่', S(validateTemplate(data || DEFAULT_TEMPLATES[doc_type])), is_default ? 1 : 0, now()]);
  });
  await audit(req.staff.id, 'create', 'template', tid, null, { doc_type, name });
  res.json({ id: tid });
}));
r.put('/templates/:id', staffAuth('settings'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM templates WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  await db.tx(async () => {
    if (req.body.is_default) await db.run('UPDATE templates SET is_default = 0 WHERE doc_type = ?', [cur.doc_type]);
    await db.run('UPDATE templates SET name = ?, data = ?, is_default = ?, updated_at = ? WHERE id = ?',
      [req.body.name || cur.name, req.body.data ? S(validateTemplate(req.body.data)) : cur.data, req.body.is_default === undefined ? cur.is_default : req.body.is_default ? 1 : 0, now(), cur.id]);
  });
  await audit(req.staff.id, 'update', 'template', cur.id, null, { name: req.body.name });
  res.json({ ok: true });
}));
r.delete('/templates/:id', staffAuth('settings'), ah(async (req, res) => { await db.run('DELETE FROM templates WHERE id = ?', [req.params.id]); res.json({ ok: true }); }));

// ---------- fonts ----------
const FONT_MAGIC = { ttf: [0x00, 0x01, 0x00, 0x00], otf: [0x4f, 0x54, 0x54, 0x4f], woff: [0x77, 0x4f, 0x46, 0x46], woff2: [0x77, 0x4f, 0x46, 0x32], ttc: [0x74, 0x74, 0x63, 0x66] };
const FONT_MIME = { ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', ttc: 'font/collection' };
export function detectFont(buf) {
  for (const [k, m] of Object.entries(FONT_MAGIC)) if (m.every((b, i) => buf[i] === b)) return k;
  if (buf[0] === 0x74 && buf[1] === 0x72 && buf[2] === 0x75 && buf[3] === 0x65) return 'ttf'; // 'true' (Apple TrueType)
  return null;
}
r.get('/fonts', ah(async (req, res) => res.json(await db.all('SELECT id, name, source, family, weights, file_id, format, has_thai, created_at FROM fonts ORDER BY name'))));
r.post('/fonts/upload', staffAuth('settings'), upload.single('file'), ah(async (req, res) => {
  const f = req.file;
  if (!f) throw bad('ไม่พบไฟล์');
  if (f.size > 15 * 1024 * 1024) throw bad('ไฟล์ฟอนต์ใหญ่เกิน 15MB');
  const fmt = detectFont(f.buffer);
  if (!fmt) throw bad('ไฟล์นี้ไม่ใช่ฟอนต์ TTF/OTF/WOFF/WOFF2 ที่ถูกต้อง');
  const family = String(req.body.family || f.originalname.replace(/\.[^.]+$/, '')).replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 60) || 'CustomFont';
  const fid = await saveFile(f.buffer, f.originalname, FONT_MIME[fmt]);
  const nid = id();
  await db.run('INSERT INTO fonts(id, name, source, family, weights, file_id, format, has_thai, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [nid, family, 'upload', family, S([Number(req.body.weight) || 400]), fid, fmt, req.body.has_thai === '1' ? 1 : req.body.has_thai === '0' ? 0 : null, now()]);
  await audit(req.staff.id, 'font_upload', 'font', nid, null, { family, fmt });
  res.json({ id: nid, family, format: fmt, url: '/files/' + fid });
}));
r.post('/fonts/google', staffAuth('settings'), ah(async (req, res) => {
  const family = String(req.body.family || '').trim().replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 60);
  if (!family) throw bad('กรุณาระบุชื่อฟอนต์');
  const weights = (req.body.weights || [400, 700]).map(Number).filter((w) => w >= 100 && w <= 900);
  const nid = id();
  await db.run('INSERT INTO fonts(id, name, source, family, weights, format, has_thai, created_at) VALUES(?,?,?,?,?,?,?,?)', [nid, family, 'google', family, S(weights), 'google', req.body.has_thai ? 1 : null, now()]);
  res.json({ id: nid });
}));
r.put('/fonts/:id', staffAuth('settings'), ah(async (req, res) => { await db.run('UPDATE fonts SET has_thai = ? WHERE id = ?', [req.body.has_thai ? 1 : 0, req.params.id]); res.json({ ok: true }); }));
r.delete('/fonts/:id', staffAuth('settings'), ah(async (req, res) => { await db.run('DELETE FROM fonts WHERE id = ?', [req.params.id]); res.json({ ok: true }); }));

// ---------- settings ----------
const PUBLIC_KEYS = ['store', 'display', 'fonts', 'queue', 'mobile', 'members', 'points', 'week_start', 'theme'];
export function publicSettings(s) {
  const out = Object.fromEntries(PUBLIC_KEYS.map((k) => [k, s[k]]));
  out.members = { ...s.members, otp_webhook_url: undefined };
  out.payment = { promptpay_enabled: !!s.payment.promptpay_id, promptpay_id: s.payment.promptpay_id, promptpay_name: s.payment.promptpay_name, slip_upload: s.payment.slip_upload,
    beam: !!(s.payment.providers.beam && s.payment.providers.beam.enabled), mock: !!s.payment.mock_enabled };
  out.sale = { payment_methods: s.sale.payment_methods, count_unit: s.sale.count_unit || 'ชาม', tax_rate: s.sale.tax_rate, tax_inclusive: s.sale.tax_inclusive, packaging_fee: s.sale.packaging_fee,
    packaging_mode: s.sale.packaging_mode, kitchen_send: s.sale.kitchen_send, auto_lock_minutes: s.sale.auto_lock_minutes, max_discount_pct: s.sale.max_discount_pct };
  out.sound = s.sound;
  out.print = s.print;
  out.version = VERSION;
  return out;
}
r.get('/settings/public', ah(async (req, res) => res.json(publicSettings(await getSettings()))));
r.get('/settings', staffAuth(), ah(async (req, res) => {
  const s = await getSettings();
  const full = can(req.staff, 'settings') ? s : publicSettings(s);
  res.json({ ...full, version: VERSION, day_rules: await dayRules(), today: await businessDateOf() });
}));
r.put('/settings/:key', staffAuth('settings'), ah(async (req, res) => {
  const key = req.params.key;
  if (!(key in DEFAULT_SETTINGS)) throw bad('ไม่รู้จักหมวดการตั้งค่า');
  const before = (await getSettings())[key];
  const v = req.body.value;
  if (key === 'payment' && v && v.providers) for (const p of Object.values(v.providers)) { delete p.api_key; delete p.secret; } // secrets live in env vars only
  if (key === 'crew' && v) { // roster: whole numbers, staff ids as text, special days from 60 days back
    const keep = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10), ids = (x) => (Array.isArray(x) ? x.map(String).slice(0, 50) : []);
    v.weekly = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, Math.max(1, Math.min(12, Math.round(Number((v.weekly || {})[d]) || 1)))]));
    v.dates = Object.fromEntries(Object.entries(v.dates || {}).filter(([d]) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= keep)
      .map(([d, x]) => [d, { count: x && x.count ? Math.max(1, Math.min(12, Math.round(Number(x.count)))) : null, late: ids(x && x.late), leave: ids(x && x.leave), note: String((x && x.note) || '').slice(0, 120) }]));
    v.max = Math.max(2, Math.min(12, Math.round(Number(v.max) || 8)));
    v.print = v.print === 'off' ? 'off' : 'always'; v.printer_id = String(v.printer_id || '');
    v.selfie = ['required', 'optional', 'off'].includes(v.selfie) ? v.selfie : (before && before.selfie) || 'required'; // not sent = keep
    v.selfie_when = ['every', 'first'].includes(v.selfie_when) ? v.selfie_when : (before && before.selfie_when) || 'every';
  }
  const after = await setSetting(key, v);
  await audit(req.staff.id, 'settings', 'settings', key, before, after, req.body.reason);
  emit('shop', 'settings:changed', { key });
  emit('display', 'settings:changed', { key });
  res.json(after);
}));
r.post('/queue/reset', staffAuth('reset_queue'), ah(async (req, res) => {
  const s = await getSettings();
  await setSetting('queue', { epoch: (s.queue.epoch || 0) + 1 });
  await audit(req.staff.id, 'queue_reset', 'settings', 'queue', { epoch: s.queue.epoch }, { epoch: (s.queue.epoch || 0) + 1 }, req.body.reason);
  emit('shop', 'queue:reset', {});
  res.json({ ok: true });
}));
// Business-day cutoff: changes apply from a chosen date and never rewrite old bills
r.get('/business-day', staffAuth(), ah(async (req, res) => res.json({ rules: await db.all('SELECT * FROM business_day_rules ORDER BY effective_from'), today: await businessDateOf() })));
r.post('/business-day', staffAuth('settings'), ah(async (req, res) => {
  const { effective_from, cutoff, timezone } = req.body || {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective_from || '')) throw bad('กรุณาระบุวันที่เริ่มใช้');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(cutoff || '')) throw bad('เวลาตัดวันไม่ถูกต้อง');
  const today = await businessDateOf();
  if (effective_from <= today && (await db.get('SELECT COUNT(*) AS n FROM orders WHERE paid_business_date >= ?', [effective_from])).n > 0)
    throw bad('มีบิลในช่วงวันที่เลือกแล้ว กรุณาเลือกวันเริ่มใช้ตั้งแต่พรุ่งนี้เป็นต้นไป เพื่อไม่ให้รายงานเก่าเปลี่ยน');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone || 'Asia/Bangkok' }); } catch { throw bad('เขตเวลาไม่ถูกต้อง'); }
  await db.run('DELETE FROM business_day_rules WHERE effective_from = ?', [effective_from]);
  await db.run('INSERT INTO business_day_rules(id, effective_from, cutoff, timezone, created_at, created_by) VALUES(?,?,?,?,?,?)', [id(), effective_from, cutoff, timezone || 'Asia/Bangkok', now(), req.staff.id]);
  clearRulesCache();
  await audit(req.staff.id, 'business_day_rule', 'settings', effective_from, null, { cutoff, timezone }, req.body.reason);
  res.json({ ok: true, rules: await dayRules() });
}));
r.get('/business-day/range', staffAuth(), ah(async (req, res) => res.json(businessRange(req.query.from, req.query.to || req.query.from, await dayRules()))));

export default r;
