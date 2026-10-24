// Import products / categories / images from Google Sheets (or an uploaded CSV) using the template the system provides.
import { Router } from 'express';
import { db, S, J } from '../db.js';
import { ah, id, now, bad, audit, emit } from '../lib/util.js';
import { staffAuth } from '../lib/auth.js';
import { saveFile } from './system.js';

const r = Router();

// column key → [Thai header, example]
export const COLUMNS = [
  ['code', 'รหัสสินค้า*', 'R101'], ['name', 'ชื่อสินค้า*', 'มาม่าต้มยำชีส'], ['category', 'หมวดหมู่', 'มาม่าเกาหลี'], ['price', 'ราคาขาย (บาท)*', '89'],
  ['cost', 'ต้นทุน (บาท)', '30'], ['unit', 'หน่วยนับ', 'ที่'], ['count', 'นับเป็นกี่หน่วย (ชาม)', '1'], ['per_unit_limit', 'ใส่ได้สูงสุดต่อหน่วย', '2'],
  ['station', 'จุดครัว', 'ครัวมาม่า'], ['barcodes', 'บาร์โค้ด (คั่นด้วย ,)', '8850001000999'], ['image_url', 'ลิงก์รูปภาพ', 'https://drive.google.com/file/d/xxxx/view'],
  ['description', 'คำอธิบาย', 'เผ็ดจัดจ้าน ชีสยืด'], ['options', 'กลุ่มตัวเลือก (คั่นด้วย ,)', 'ชนิดเส้น, ระดับความเผ็ด, ท็อปปิ้งเพิ่ม'],
  ['active', 'เปิดขาย (TRUE/FALSE)', 'TRUE'], ['mobile', 'แสดงใน Mobile Ordering', 'TRUE'], ['track_stock', 'นับสต็อก', 'FALSE'], ['stock', 'จำนวนคงเหลือ', '0'],
  ['low_stock', 'แจ้งเตือนเมื่อเหลือ', '0'], ['sort', 'ลำดับแสดง', '10'],
];

export function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  const t = String(text).replace(/^﻿/, '');
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((x) => x.some((v) => String(v).trim() !== ''));
}
const csvCell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// Header cells may be the key ("price"), the Thai label ("ราคาขาย (บาท)*") or "price | ราคาขาย"
function headerMap(header) {
  return header.map((hcell) => {
    const h = String(hcell).trim().toLowerCase();
    const col = COLUMNS.find(([k, th]) => h === k || h.startsWith(k + ' ') || h.startsWith(k + '|') || h.includes(`(${k})`) || h.replace(/\s/g, '') === th.toLowerCase().replace(/\s/g, ''));
    return col ? col[0] : null;
  });
}
export function sheetCsvUrl(url) {
  const u = String(url || '').trim();
  const m = u.match(/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) { if (/^https?:\/\//.test(u) && /output=csv|format=csv|\.csv(\?|$)/.test(u)) return u; throw bad('ลิงก์ Google Sheet ไม่ถูกต้อง'); }
  const gid = (u.match(/[#&?]gid=(\d+)/) || [])[1] || '0';
  return `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=csv&gid=${gid}`;
}
// Google Drive share link → direct download link
export function directImageUrl(u) {
  const s = String(u || '').trim();
  const d = s.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?.*id=)([a-zA-Z0-9_-]+)/);
  return d ? `https://drive.google.com/uc?export=download&id=${d[1]}` : s;
}
const truthy = (v, def) => (v === undefined || v === '' ? def : /^(true|1|yes|y|ใช่|เปิด|✓)$/i.test(String(v).trim()));
const money = (v) => Math.round((Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0) * 100);

r.get('/import/template.csv', staffAuth('manage_menu'), ah(async (req, res) => {
  const ex2 = ['T101', 'ไข่ออนเซ็น', 'ท็อปปิ้ง', '15', '5', 'ฟอง', '0', '0', 'จุดท็อปปิ้ง', '', '', '', '', 'TRUE', 'TRUE', 'FALSE', '0', '0', '20'];
  const ex3 = ['D101', 'ชานมไต้หวัน', 'เครื่องดื่ม', '55', '18', 'แก้ว', '0', '0', 'จุดเครื่องดื่ม', '8850001000888', 'https://example.com/milktea.jpg', '', 'ความหวาน/น้ำแข็ง', 'TRUE', 'TRUE', 'TRUE', '40', '5', '30'];
  const csv = '﻿' + [COLUMNS.map(([k, th]) => csvCell(`${k} | ${th}`)).join(','), COLUMNS.map((c) => csvCell(c[2])).join(','), ex2.map(csvCell).join(','), ex3.map(csvCell).join(',')].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="oppa-products-template.csv"');
  res.end(csv);
}));
// current menu in the same format (edit in Google Sheets and import again)
r.get('/import/export.csv', staffAuth('manage_menu'), ah(async (req, res) => {
  const prods = await db.all('SELECT * FROM products ORDER BY sort, name');
  const cats = Object.fromEntries((await db.all('SELECT id, name FROM categories')).map((c) => [c.id, c.name]));
  const sts = Object.fromEntries((await db.all('SELECT id, name FROM stations')).map((c) => [c.id, c.name]));
  const ogs = Object.fromEntries((await db.all('SELECT id, name FROM option_groups')).map((c) => [c.id, c.name]));
  const bcs = await db.all('SELECT * FROM barcodes');
  const base = process.env.PUBLIC_URL || '';
  const lines = prods.map((p) => [p.code, p.name, cats[p.category_id] || '', p.price / 100, p.cost / 100, p.unit, p.bowl_count, p.per_bowl_limit, sts[p.station_id] || '',
    bcs.filter((b) => b.product_id === p.id).map((b) => b.code).join(', '), p.image ? (p.image.startsWith('/') ? base + p.image : p.image) : '', p.description || '',
    J(p.option_groups, []).map((g) => ogs[g]).filter(Boolean).join(', '), p.active ? 'TRUE' : 'FALSE', p.mobile ? 'TRUE' : 'FALSE', p.track_stock ? 'TRUE' : 'FALSE', p.stock, p.low_stock, p.sort].map(csvCell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="oppa-products.csv"');
  res.end('﻿' + [COLUMNS.map(([k, th]) => csvCell(`${k} | ${th}`)).join(','), ...lines].join('\n'));
}));

// body: { url } (Google Sheet link) or { csv } (text); dry_run → preview only; download_images → copy pictures into the system
r.post('/import/products', staffAuth('manage_menu'), ah(async (req, res) => {
  const b = req.body || {};
  let text = b.csv;
  if (!text && b.url) {
    const resp = await fetch(sheetCsvUrl(b.url), { redirect: 'follow' }).catch((e) => { throw bad('เปิด Google Sheet ไม่ได้: ' + e.message); });
    text = await resp.text();
    if (!resp.ok || /<html/i.test(text.slice(0, 200))) throw bad('อ่าน Google Sheet ไม่ได้ — ตั้งค่าแชร์เป็น "ทุกคนที่มีลิงก์ดูได้" ก่อน');
  }
  if (!text) throw bad('ไม่พบข้อมูล');
  const rows = parseCsv(text);
  if (rows.length < 2) throw bad('ไม่มีแถวสินค้า');
  const keys = headerMap(rows[0]);
  if (!keys.includes('code') || !keys.includes('name')) throw bad('ไม่พบคอลัมน์ code และ name — ใช้หัวตารางจากไฟล์ต้นแบบ');
  const cats = await db.all('SELECT * FROM categories');
  const stations = await db.all('SELECT * FROM stations');
  const groups = await db.all('SELECT id, name FROM option_groups');
  const preview = [], errors = [];
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const o = {}; keys.forEach((k, j) => { if (k) o[k] = String(rows[i][j] ?? '').trim(); });
    if (!o.code && !o.name) continue;
    if (o.code && o.code === COLUMNS[0][2] && o.name === COLUMNS[1][2]) continue; // template example row
    const rowNo = i + 1;
    if (!o.code || !o.name) { errors.push({ row: rowNo, error: 'ต้องมีรหัสและชื่อสินค้า' }); continue; }
    if (seen.has(o.code)) { errors.push({ row: rowNo, error: 'รหัสซ้ำในไฟล์: ' + o.code }); continue; }
    seen.add(o.code);
    const unknownGroups = (o.options || '').split(',').map((x) => x.trim()).filter((x) => x && !groups.some((g) => g.name === x));
    if (unknownGroups.length) errors.push({ row: rowNo, error: 'ไม่พบกลุ่มตัวเลือก: ' + unknownGroups.join(', ') + ' (ข้ามกลุ่มนี้)' , warn: true });
    const exists = await db.get('SELECT id FROM products WHERE code = ?', [o.code]);
    preview.push({ row: rowNo, action: exists ? 'update' : 'create', ...o, price: money(o.price), cost: money(o.cost),
      new_category: o.category && !cats.some((c) => c.name === o.category), new_station: o.station && !stations.some((s) => s.name === o.station) });
  }
  if (b.dry_run) return res.json({ preview, errors: errors, count: preview.length });
  let created = 0, updated = 0, images = 0;
  const imgErrors = [];
  for (const p of preview) {
    let cat = p.category ? cats.find((c) => c.name === p.category) : null;
    if (p.category && !cat) { cat = { id: id(), name: p.category }; await db.run('INSERT INTO categories(id, name, sort, active) VALUES(?,?,?,1)', [cat.id, cat.name, cats.length + 1]); cats.push(cat); }
    let st = p.station ? stations.find((s) => s.name === p.station) : null;
    if (p.station && !st) { st = { id: id(), name: p.station }; await db.run("INSERT INTO stations(id, name, split_mode, bowls_per_ticket, sort) VALUES(?,?,'order',1,?)", [st.id, st.name, stations.length + 1]); stations.push(st); }
    let image = p.image_url ? directImageUrl(p.image_url) : null;
    if (image && b.download_images) {
      try {
        const ir = await fetch(image, { redirect: 'follow' });
        const type = ir.headers.get('content-type') || '';
        const buf = Buffer.from(await ir.arrayBuffer());
        if (!ir.ok || !/^image\//.test(type)) throw new Error('ไม่ใช่ไฟล์รูป (ตั้งแชร์ไฟล์ให้ทุกคนดูได้)');
        if (buf.length > 8 * 1024 * 1024) throw new Error('รูปใหญ่เกิน 8MB');
        image = '/files/' + await saveFile(buf, p.code, type.split(';')[0]);
        images++;
      } catch (e) { imgErrors.push({ row: p.row, error: 'รูป: ' + e.message }); }
    }
    const og = (p.options || '').split(',').map((x) => x.trim()).map((n) => (groups.find((g) => g.name === n) || {}).id).filter(Boolean);
    const cur = await db.get('SELECT * FROM products WHERE code = ?', [p.code]);
    const v = { name: p.name, category_id: cat ? cat.id : cur && cur.category_id, description: p.description || (cur && cur.description) || null, image: image || (cur && cur.image) || null,
      price: p.price, cost: p.cost, unit: p.unit || (cur && cur.unit) || 'ที่', bowl_count: p.count === undefined || p.count === '' ? (cur ? cur.bowl_count : 0) : Number(p.count) || 0,
      per_bowl_limit: Number(p.per_unit_limit) || 0, station_id: st ? st.id : cur && cur.station_id, track_stock: truthy(p.track_stock, false) ? 1 : 0, low_stock: Number(p.low_stock) || 0,
      active: truthy(p.active, true) ? 1 : 0, mobile: truthy(p.mobile, true) ? 1 : 0, option_groups: S(og.length || p.options ? og : J(cur && cur.option_groups, [])), sort: Number(p.sort) || 0 };
    let pid;
    if (cur) {
      pid = cur.id;
      await db.run(`UPDATE products SET ${Object.keys(v).map((k) => k + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [...Object.values(v), now(), pid]);
      updated++;
    } else {
      pid = id();
      await db.run(`INSERT INTO products(id, code, ${Object.keys(v).join(', ')}, stock, kind, recipe, updated_at) VALUES(?, ?, ${Object.keys(v).map(() => '?').join(', ')}, ?, 'simple', '[]', ?)`,
        [pid, p.code, ...Object.values(v), Number(p.stock) || 0, now()]);
      created++;
    }
    if (p.barcodes) {
      const codes = p.barcodes.split(',').map((x) => x.trim()).filter(Boolean);
      for (const c of codes) {
        const o = await db.get('SELECT product_id FROM barcodes WHERE code = ?', [c]);
        if (o && o.product_id !== pid) { imgErrors.push({ row: p.row, error: `บาร์โค้ด ${c} เป็นของสินค้าอื่นอยู่แล้ว (ข้าม)` }); continue; }
        if (!o) await db.run('INSERT INTO barcodes(code, product_id) VALUES(?,?)', [c, pid]);
      }
    }
  }
  await audit(req.staff.id, 'import_products', 'products', null, null, { created, updated, images, source: b.url ? 'google_sheet' : 'csv' });
  emit('shop', 'catalog:changed', {}); emit('mobile', 'catalog:changed', {});
  res.json({ created, updated, images, errors: [...errors, ...imgErrors] });
}));

export default r;
