// Photo booth: a paired booth device scans a receipt (free photos for bills of at least the set amount),
// takes the photos, and prints the strip on a thermal printer through the normal print queue.
// The booth sends two pictures: the colour strip (download page, only with the customer's consent) and the
// 1-bit strip already dithered at the printer's dot width (what the printer prints, dot for dot).
import { Router } from 'express';
import { db } from '../db.js';
import { ah, id, now, token, bad, notFound, conflict, forbidden, getSettings, randomDigits, rateLimit, audit, addMinutes } from '../lib/util.js';
import { staffAuth, can } from '../lib/auth.js';
import { enqueue, publicPrinter, printerOptions, reprint } from '../lib/print.js';
import { billFromToken } from '../lib/billlink.js';
import { saveFile } from './system.js';

const r = Router();
const PB = async () => ({ ...(await getSettings()).photobooth });
const base = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
const DOTS = (paper) => (Number(paper) === 58 ? 384 : 576);

// the booth is a paired device (like a customer display, mode 'photobooth'); a signed-in cashier may run it too
const boothAuth = () => async (req, res, next) => {
  try {
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const p = tok ? await db.get("SELECT * FROM display_pairings WHERE display_token = ? AND revoked = 0 AND mode = 'photobooth'", [tok]) : null;
    if (p) { await db.run('UPDATE display_pairings SET last_seen = ? WHERE id = ?', [now(), p.id]); req.booth = { id: p.id, name: 'ตู้ถ่ายรูป' }; return next(); }
    return staffAuth('sell')(req, res, (e) => { if (e) return next(e); req.booth = { id: 'staff:' + req.staff.id, name: req.staff.name }; next(); });
  } catch (e) { next(e); }
};

async function boothPrinter(pb) {
  const all = (await db.all('SELECT * FROM printers WHERE active = 1')).map(publicPrinter);
  return (pb.printer_id && all.find((p) => p.id === pb.printer_id)) || all.find((p) => p.roles.includes('photo')) || all.find((p) => p.roles.includes('receipt')) || null;
}
// exactly the dots the printer draws across (paper width, the printer's own dot setting, minus its margins)
const printWidth = (p) => (p ? Math.max(200, (p.options.width_dots || DOTS(p.paper)) - 2 * (Number(p.margin) || 0)) : 384);

// ---------- admin ----------
r.post('/photobooth/pairing', staffAuth('settings'), ah(async (req, res) => {
  let code;
  for (let i = 0; i < 10; i++) { code = randomDigits(6); if (!(await db.get('SELECT id FROM display_pairings WHERE code = ? AND used_at IS NULL AND revoked = 0 AND expires_at > ?', [code, now()]))) break; }
  await db.run('INSERT INTO display_pairings(id, terminal_id, code, expires_at, created_at, mode) VALUES(?,?,?,?,?,?)', [id(), 'photobooth', code, addMinutes(15), now(), 'photobooth']);
  res.json({ code, expires_at: addMinutes(15), url: `/photo/?code=${code}` });
}));
r.get('/photobooth/devices', staffAuth('settings'), ah(async (req, res) => {
  res.json(await db.all("SELECT id, used_at, last_seen, revoked FROM display_pairings WHERE mode = 'photobooth' AND used_at IS NOT NULL ORDER BY used_at DESC LIMIT 20"));
}));
r.post('/photobooth/devices/:id/revoke', staffAuth('settings'), ah(async (req, res) => {
  await db.run("UPDATE display_pairings SET revoked = 1 WHERE id = ? AND mode = 'photobooth'", [req.params.id]);
  res.json({ ok: true });
}));
r.get('/photobooth/report', staffAuth(), ah(async (req, res) => {
  const all = await db.all('SELECT * FROM photo_sessions ORDER BY created_at DESC LIMIT 300');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  const day = (x) => new Date(x.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) === today;
  const sum = (list) => ({ sessions: list.length, printed: list.filter((x) => x.prints > 0).length, prints: list.reduce((s, x) => s + (x.prints || 0), 0), shots: list.reduce((s, x) => s + (x.shots || 0), 0),
    paper_mm: list.reduce((s, x) => s + (x.paper_mm || 0) * (x.prints || 0), 0), sales: list.reduce((s, x) => s + (x.amount || 0), 0) });
  res.json({ today: sum(all.filter(day)), total: sum(all), sessions: all.slice(0, 60).map((x) => ({ ...x, dl_token: undefined, color_url: x.file_color ? '/files/' + x.file_color : null, print_url: x.file_print ? '/files/' + x.file_print : null })) });
}));
r.post('/photobooth/sessions/:id/reprint', staffAuth('reprint'), ah(async (req, res) => {
  const s = await db.get('SELECT * FROM photo_sessions WHERE id = ?', [req.params.id]);
  if (!s) throw notFound();
  const j = await db.get("SELECT id FROM print_jobs WHERE ref_id = ? AND doc_type = 'photo' AND (dedupe_key IS NULL OR dedupe_key NOT LIKE 'reprint:%') ORDER BY seq LIMIT 1", [s.id]);
  if (!j) throw bad('รูปชุดนี้ยังไม่เคยพิมพ์ หรือไฟล์ถูกลบแล้ว');
  const nid = await reprint(j.id, req.staff.id);
  await db.run('UPDATE photo_sessions SET prints = prints + 1 WHERE id = ?', [s.id]);
  await audit(req.staff.id, 'reprint', 'photo_session', s.id, null, {});
  res.json({ job_id: nid });
}));

// ---------- booth ----------
r.get('/photobooth/config', boothAuth(), ah(async (req, res) => {
  const pb = await PB();
  const p = await boothPrinter(pb);
  const s = await getSettings();
  res.json({ ...pb, store: { name: s.store.name, logo: s.store.logo }, printer: p ? { id: p.id, name: p.name, paper: p.paper, conn: p.conn, dots: printWidth(p) } : null, booth: req.booth });
}));
// which bill a scanned code points to: the photo QR / bill link on the receipt (signed), or the points QR
async function orderFromCode(raw) {
  const s = String(raw || '').trim();
  let m = /[#&?]r=([^&\s]+)/.exec(s) || /\/b\/#([^\s]+)/.exec(s);
  const signed = m ? decodeURIComponent(m[1]) : /^[A-Z0-9-]+\.[\w-]+$/i.test(s) ? s : null;
  if (signed) { const bill = await billFromToken(signed); if (bill) return db.get('SELECT * FROM orders WHERE bill_no = ?', [bill]); }
  m = /\/claim\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (m) return db.get('SELECT * FROM orders WHERE claim_token = ?', [m[1]]);
  return null;
}
r.post('/photobooth/redeem', boothAuth(), ah(async (req, res) => {
  rateLimit('pbr:' + req.booth.id, 30, 60000);
  const pb = await PB();
  if (!pb.enabled) throw bad('ตู้ถ่ายรูปปิดอยู่', 'disabled');
  let o = null;
  if (pb.require_receipt) {
    o = await orderFromCode(req.body.code);
    if (!o) throw bad('QR นี้ไม่ใช่ใบเสร็จของร้าน — สแกน QR บนใบเสร็จ', 'bad_code');
    if (o.status !== 'paid') throw bad('บิลนี้ยังไม่ได้ชำระหรือถูกยกเลิก', 'not_paid');
    const net = o.total - (o.refunded_amount || 0);
    if (net < pb.min_spend) return res.status(400).json({ error: `ยอดใบเสร็จ ${(net / 100).toFixed(2)} บาท ยังไม่ถึง ${(pb.min_spend / 100).toFixed(2)} บาท`, code: 'below_min', amount: net, min: pb.min_spend });
    if (pb.receipt_hours && Date.now() - Date.parse(o.paid_at) > pb.receipt_hours * 3600e3) throw bad(`ใบเสร็จนี้เกิน ${pb.receipt_hours} ชั่วโมงแล้ว`, 'too_old');
    const used = Number((await db.get('SELECT COUNT(*) AS n FROM photo_sessions WHERE order_id = ?', [o.id])).n);
    if (used >= (pb.sessions_per_receipt || 1)) throw conflict('ใบเสร็จนี้ใช้สิทธิ์ถ่ายรูปครบแล้ว', 'used');
  }
  const sid = id();
  // the download link exists from the start so its QR can go on the strip; it only opens if the customer agrees to keep the photo
  const dl = pb.store_photos ? token(24) : null;
  await db.run('INSERT INTO photo_sessions(id, order_id, bill_no, amount, device, status, dl_token, created_at) VALUES(?,?,?,?,?,?,?,?)',
    [sid, o ? o.id : null, o ? o.bill_no : null, o ? o.total - (o.refunded_amount || 0) : 0, req.booth.id, 'started', dl, now()]);
  res.json({ session_id: sid, bill_no: o ? o.bill_no : null, amount: o ? o.total - (o.refunded_amount || 0) : 0, min: pb.min_spend, download_url: dl ? `${base()}/photo/#d=${dl}` : null,
    number: String(Number((await db.get('SELECT COUNT(*) AS n FROM photo_sessions')).n)).padStart(4, '0') });
}));
const IMG = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/;
r.post('/photobooth/sessions/:id/finish', boothAuth(), ah(async (req, res) => {
  const s = await db.get('SELECT * FROM photo_sessions WHERE id = ?', [req.params.id]);
  if (!s) throw notFound();
  if (s.device !== req.booth.id) throw forbidden('รูปชุดนี้เริ่มจากตู้อื่น');
  if (s.status === 'done') return res.json(await sessionOut(s)); // sent twice (network): same result, no second print
  const pb = await PB();
  const pm = IMG.exec(String(req.body.print_image || ''));
  if (!pm) throw bad('ไม่มีรูปสำหรับพิมพ์');
  const consent = !!req.body.consent && pb.store_photos;
  const cm = consent ? IMG.exec(String(req.body.color_image || '')) : null;
  if (pm[2].length > 6e6 || (cm && cm[2].length > 8e6)) throw bad('รูปใหญ่เกินไป');
  const printFid = await saveFile(Buffer.from(pm[2], 'base64'), 'photo-print.png', 'image/' + pm[1]);
  const colorFid = cm ? await saveFile(Buffer.from(cm[2], 'base64'), 'photo.' + (cm[1] === 'png' ? 'png' : 'jpg'), 'image/' + cm[1]) : null;
  const dl = cm ? s.dl_token || token(24) : null;
  // without consent nothing is kept beyond printing
  const exp = new Date(Date.now() + (cm ? (pb.link_hours || 24) : 2) * 3600e3).toISOString();
  const layout = String(req.body.layout || '').slice(0, 30), shots = Math.max(0, Math.min(8, Number(req.body.shots) || 0)), paperMm = Math.round(Number(req.body.height_dots || 0) / 8);
  const ch = await db.run("UPDATE photo_sessions SET status = 'done', file_color = ?, file_print = ?, dl_token = ?, layout = ?, shots = ?, consent = ?, paper_mm = ?, finished_at = ?, expires_at = ? WHERE id = ? AND status <> 'done'",
    [colorFid, printFid, dl, layout, shots, consent ? 1 : 0, paperMm, now(), exp, s.id]);
  if (!ch.changes) return res.json(await sessionOut(await db.get('SELECT * FROM photo_sessions WHERE id = ?', [s.id])));
  const p = await boothPrinter(pb);
  let jobs = [];
  if (p && req.body.print !== false) {
    const tpl = { paper: p.paper, margin: Number(p.margin) || 0, copies: Math.max(1, Math.min(5, Number(pb.copies) || 1)), elements: [{ type: 'image', src: '/files/' + printFid, width_pct: 100, align: 'center' }] };
    jobs = await enqueue('photo', s.id, { session: s.id }, { printerId: p.id, template: tpl, dedupe: 'photo:' + s.id });
    if (jobs.length) await db.run('UPDATE photo_sessions SET prints = 1 WHERE id = ?', [s.id]);
  }
  res.json(await sessionOut(await db.get('SELECT * FROM photo_sessions WHERE id = ?', [s.id])));
}));
async function sessionOut(s) {
  const jobs = await db.all("SELECT id, status, error FROM print_jobs WHERE ref_id = ? AND doc_type = 'photo' ORDER BY seq", [s.id]);
  return { session_id: s.id, status: s.status, download_url: s.dl_token ? `${base()}/photo/#d=${s.dl_token}` : null, expires_at: s.expires_at, jobs, printed: jobs.length > 0 };
}
r.get('/photobooth/sessions/:id', boothAuth(), ah(async (req, res) => {
  const s = await db.get('SELECT * FROM photo_sessions WHERE id = ?', [req.params.id]);
  if (!s || s.device !== req.booth.id) throw notFound();
  res.json(await sessionOut(s));
}));
// the customer's download page (QR on the strip): only with the token, only until it expires
r.get('/public/photo/:token', ah(async (req, res) => {
  rateLimit('pdl:' + req.ip, 60, 60000);
  const s = await db.get('SELECT file_color, expires_at, created_at FROM photo_sessions WHERE dl_token = ?', [String(req.params.token)]);
  if (!s || !s.file_color || Date.parse(s.expires_at) < Date.now()) throw notFound('ลิงก์รูปหมดอายุหรือไม่ถูกต้อง');
  res.set('Cache-Control', 'no-store');
  res.json({ url: '/files/' + s.file_color, expires_at: s.expires_at, taken_at: s.created_at, store: (await getSettings()).store.name });
}));

// photos past their time are deleted (files and links)
export async function cleanupPhotos() {
  const old = await db.all('SELECT id, file_color, file_print FROM photo_sessions WHERE expires_at IS NOT NULL AND expires_at < ? AND (file_color IS NOT NULL OR file_print IS NOT NULL)', [now()]);
  for (const s of old) {
    for (const f of [s.file_color, s.file_print].filter(Boolean)) {
      const row = await db.get('SELECT path FROM files WHERE id = ?', [f]);
      if (row && row.path) { try { (await import('node:fs')).unlinkSync(row.path); } catch { /* already gone */ } }
      await db.run('DELETE FROM files WHERE id = ?', [f]);
    }
    await db.run('UPDATE photo_sessions SET file_color = NULL, file_print = NULL, dl_token = NULL WHERE id = ?', [s.id]);
  }
  return old.length;
}
export default r;
