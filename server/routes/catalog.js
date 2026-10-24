import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, audit, emit, getSettings, setSetting, getSecret, setSecret, rateLimit } from '../lib/util.js';
import { enqueue } from '../lib/print.js';
import { lookupBarcode, suggestCategory, fetchImage } from '../lib/productlookup.js';
import { aiKeys, identifyWithClaude, findImages, basicNames, AiError, AI_MODEL } from '../lib/productai.js';
import { saveFile } from './system.js';
import { labelCfg, labelRowDots } from '../../public/shared/labels.js';
import { isEan13, ean13Check } from '../../public/shared/core.js';
import { staffAuth, can } from '../lib/auth.js';

const r = Router();
const changed = () => { emit('shop', 'catalog:changed', {}); emit('mobile', 'catalog:changed', {}); };

export async function catalog({ includeInactive = false, mobile = false, withCost = false } = {}) {
  const cats = await db.all(`SELECT * FROM categories ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
  let prods = await db.all(`SELECT * FROM products ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
  if (mobile) prods = prods.filter((p) => p.mobile);
  const bcs = await db.all('SELECT * FROM barcodes');
  const groups = (await db.all('SELECT * FROM option_groups ORDER BY sort, name')).map((g) => ({ ...g, options: J(g.options, []).filter((o) => includeInactive || o.active !== false)
    .map((o) => (withCost ? o : { id: o.id, name: o.name, price: o.price, active: o.active })) }));
  const stations = await db.all('SELECT * FROM stations ORDER BY sort, name');
  return {
    categories: cats, stations, option_groups: groups,
    products: prods.map((p) => ({
      id: p.id, code: p.code, name: p.name, category_id: p.category_id, description: p.description, image: p.image, price: p.price,
      unit: p.unit, bowl_count: p.bowl_count, per_bowl_limit: p.per_bowl_limit, station_id: p.station_id, active: !!p.active, mobile: !!p.mobile, big_options: !!p.big_options,
      sold_out: !!p.sold_out || (p.track_stock && p.stock <= 0), track_stock: !!p.track_stock, stock: mobile ? undefined : p.stock, low_stock: mobile ? undefined : p.low_stock,
      kind: p.kind, option_groups: J(p.option_groups, []), sort: p.sort, barcodes: bcs.filter((b) => b.product_id === p.id).map((b) => b.code),
      ...(withCost ? { cost: p.cost, recipe: J(p.recipe, []) } : {}),
    })),
  };
}

r.get('/catalog', staffAuth(), ah(async (req, res) => res.json(await catalog({ includeInactive: req.query.all === '1', withCost: can(req.staff, 'view_cost') || can(req.staff, 'manage_menu') }))));

r.get('/barcode/:code', staffAuth(), ah(async (req, res) => {
  const code = String(req.params.code).trim();
  const b = await db.get('SELECT product_id FROM barcodes WHERE code = ?', [code]);
  const p = await db.get('SELECT id FROM products WHERE id = ? OR code = ?', [b ? b.product_id : '__', code]);
  if (!p) throw notFound('ไม่พบสินค้าจากบาร์โค้ด ' + code);
  res.json({ product_id: p.id });
}));

// ---------- products ----------
async function saveBarcodes(pid, codes) {
  const list = [...new Set((codes || []).map((c) => String(c).trim()).filter(Boolean))];
  for (const c of list) {
    const o = await db.get('SELECT product_id FROM barcodes WHERE code = ?', [c]);
    if (o && o.product_id !== pid) throw conflict(`บาร์โค้ด ${c} ถูกใช้กับสินค้าอื่นแล้ว`);
  }
  await db.run('DELETE FROM barcodes WHERE product_id = ?', [pid]);
  for (const c of list) await db.run('INSERT INTO barcodes(code, product_id) VALUES(?,?)', [c, pid]);
}
const PFIELDS = ['code', 'name', 'category_id', 'description', 'image', 'price', 'cost', 'unit', 'bowl_count', 'per_bowl_limit', 'station_id', 'track_stock', 'stock',
  'low_stock', 'active', 'sold_out', 'kind', 'recipe', 'option_groups', 'sort', 'mobile', 'big_options'];
function normProduct(b, cur = {}) {
  const o = {};
  for (const f of PFIELDS) o[f] = b[f] !== undefined ? b[f] : cur[f];
  for (const f of ['recipe', 'option_groups']) if (typeof o[f] !== 'string') o[f] = S(o[f] || []);
  for (const f of ['track_stock', 'active', 'sold_out', 'mobile', 'big_options']) o[f] = o[f] === undefined ? (f === 'active' || f === 'mobile' ? 1 : 0) : o[f] ? 1 : 0;
  for (const f of ['price', 'cost', 'per_bowl_limit', 'sort']) o[f] = Math.round(Number(o[f]) || 0);
  for (const f of ['bowl_count', 'stock', 'low_stock']) o[f] = Number(o[f]) || 0;
  if (!o.name || !o.code) throw bad('กรุณากรอกรหัสและชื่อสินค้า');
  if (o.price < 0 || o.cost < 0) throw bad('ราคาต้องไม่ติดลบ');
  return o;
}
r.post('/products', staffAuth('manage_menu'), ah(async (req, res) => {
  const o = normProduct(req.body);
  if (await db.get('SELECT id FROM products WHERE code = ?', [o.code])) throw conflict('รหัสสินค้าซ้ำ');
  const pid = id();
  await db.tx(async () => {
    await db.run(`INSERT INTO products(id, ${PFIELDS.join(', ')}, updated_at) VALUES(?, ${PFIELDS.map(() => '?').join(', ')}, ?)`, [pid, ...PFIELDS.map((f) => o[f]), now()]);
    await saveBarcodes(pid, req.body.barcodes);
  });
  await audit(req.staff.id, 'create', 'product', pid, null, o);
  changed();
  res.json({ id: pid });
}));
r.put('/products/:id', staffAuth('manage_menu'), ah(async (req, res) => {
  const cur = await db.get('SELECT * FROM products WHERE id = ?', [req.params.id]);
  if (!cur) throw notFound();
  if (req.body.price !== undefined && Number(req.body.price) !== cur.price && !can(req.staff, 'edit_price')) throw bad('ไม่มีสิทธิ์แก้ราคา');
  const o = normProduct(req.body, cur);
  // stock is changed only through stock adjustments (keeps a movement history)
  o.stock = cur.stock;
  await db.tx(async () => {
    await db.run(`UPDATE products SET ${PFIELDS.map((f) => f + ' = ?').join(', ')}, updated_at = ? WHERE id = ?`, [...PFIELDS.map((f) => o[f]), now(), cur.id]);
    if (req.body.barcodes) await saveBarcodes(cur.id, req.body.barcodes);
  });
  const important = ['price', 'cost', 'active', 'sold_out', 'recipe'].filter((f) => String(cur[f]) !== String(o[f]));
  await audit(req.staff.id, 'update', 'product', cur.id, Object.fromEntries(important.map((f) => [f, cur[f]])), Object.fromEntries(important.map((f) => [f, o[f]])), req.body.reason);
  changed();
  res.json({ ok: true });
}));
r.delete('/products/:id', staffAuth('manage_menu'), ah(async (req, res) => {
  // soft delete: old bills keep their snapshot, the product just disappears from sale
  await db.run('UPDATE products SET active = 0 WHERE id = ?', [req.params.id]);
  await audit(req.staff.id, 'deactivate', 'product', req.params.id);
  changed();
  res.json({ ok: true });
}));
r.post('/products/:id/sold-out', staffAuth('sell'), ah(async (req, res) => {
  await db.run('UPDATE products SET sold_out = ? WHERE id = ?', [req.body.sold_out ? 1 : 0, req.params.id]);
  await audit(req.staff.id, 'sold_out', 'product', req.params.id, null, { sold_out: !!req.body.sold_out });
  changed();
  res.json({ ok: true });
}));

// ---------- generic simple tables ----------
function crud(path, table, fields, perm, { normalize = (o) => o, afterChange = changed } = {}) {
  r.get('/' + path, staffAuth(), ah(async (req, res) => res.json((await db.all(`SELECT * FROM ${table} ORDER BY ${fields.includes('sort') ? 'sort, ' : ''}name`)).map((x) => {
    if (x.options) x.options = J(x.options, []);
    return x;
  }))));
  r.post('/' + path, staffAuth(perm), ah(async (req, res) => {
    const o = normalize(Object.fromEntries(fields.map((f) => [f, req.body[f]])));
    if (!o.name) throw bad('กรุณากรอกชื่อ');
    const nid = req.body.id && /^[a-z0-9_-]{2,40}$/i.test(req.body.id) ? req.body.id : id();
    await db.run(`INSERT INTO ${table}(id, ${fields.join(', ')}) VALUES(?, ${fields.map(() => '?').join(', ')})`, [nid, ...fields.map((f) => o[f])]);
    await audit(req.staff.id, 'create', table, nid, null, o);
    afterChange();
    res.json({ id: nid });
  }));
  r.put('/' + path + '/:id', staffAuth(perm), ah(async (req, res) => {
    const cur = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [req.params.id]);
    if (!cur) throw notFound();
    const o = normalize(Object.fromEntries(fields.map((f) => [f, req.body[f] !== undefined ? req.body[f] : cur[f]])));
    await db.run(`UPDATE ${table} SET ${fields.map((f) => f + ' = ?').join(', ')} WHERE id = ?`, [...fields.map((f) => o[f]), cur.id]);
    await audit(req.staff.id, 'update', table, cur.id, cur, o, req.body.reason);
    afterChange();
    res.json({ ok: true });
  }));
  r.delete('/' + path + '/:id', staffAuth(perm), ah(async (req, res) => {
    await db.run(`DELETE FROM ${table} WHERE id = ?`, [req.params.id]);
    await audit(req.staff.id, 'delete', table, req.params.id);
    afterChange();
    res.json({ ok: true });
  }));
}
const bool = (v) => (v === false || v === 0 || v === '0' ? 0 : 1);
crud('categories', 'categories', ['name', 'sort', 'active', 'color'], 'manage_menu', { normalize: (o) => ({ ...o, sort: Number(o.sort) || 0, active: bool(o.active) }) });
crud('stations', 'stations', ['name', 'split_mode', 'bowls_per_ticket', 'sort'], 'settings', {
  normalize: (o) => {
    if (o.split_mode && !['order', 'item', 'bowl', 'bowl_group'].includes(o.split_mode)) throw bad('รูปแบบใบครัวไม่ถูกต้อง');
    return { ...o, split_mode: o.split_mode || 'order', bowls_per_ticket: Math.max(1, Number(o.bowls_per_ticket) || 1), sort: Number(o.sort) || 0 };
  },
});
crud('option-groups', 'option_groups', ['name', 'min_select', 'max_select', 'options', 'sort'], 'manage_menu', {
  normalize: (o) => ({ ...o, min_select: Number(o.min_select) || 0, max_select: Number(o.max_select) || 0, sort: Number(o.sort) || 0,
    options: S((typeof o.options === 'string' ? J(o.options, []) : o.options || []).map((x) => ({ id: x.id || id().slice(0, 8), name: x.name, price: Math.round(Number(x.price) || 0),
      cost: Math.round(Number(x.cost) || 0), active: x.active !== false, recipe: (x.recipe || []).filter((r) => r.ingredient_id) }))) }),
});
crud('ingredients', 'ingredients', ['name', 'unit', 'low_stock', 'cost'], 'manage_stock', { normalize: (o) => ({ ...o, low_stock: Number(o.low_stock) || 0, cost: Math.round(Number(o.cost) || 0) }) });
crud('tables', 'dining_tables', ['name', 'zone', 'seats', 'sort', 'active', 'status'], 'manage_tables', {
  normalize: (o) => ({ ...o, seats: Number(o.seats) || 0, sort: Number(o.sort) || 0, active: bool(o.active), status: ['free', 'occupied', 'disabled'].includes(o.status) ? o.status : 'free' }),
  afterChange: () => emit('shop', 'tables:changed', {}),
});

// ---------- stock ----------
r.post('/stock/adjust', staffAuth('manage_stock'), ah(async (req, res) => {
  const { item_type, item_id, qty, mode, reason } = req.body || {};
  if (!reason) throw bad('กรุณาระบุเหตุผล');
  const table = item_type === 'ingredient' ? 'ingredients' : 'products';
  await db.tx(async () => {
    const cur = await db.get(`SELECT stock FROM ${table} WHERE id = ?`, [item_id]);
    if (!cur) throw notFound();
    const delta = mode === 'set' ? Number(qty) - cur.stock : Number(qty);
    await db.run(`UPDATE ${table} SET stock = stock + ? WHERE id = ?`, [delta, item_id]);
    await db.run('INSERT INTO stock_moves(id, item_type, item_id, qty, reason, ref, staff_id, created_at) VALUES(?,?,?,?,?,?,?,?)', [id(), item_type, item_id, delta, reason, mode, req.staff.id, now()]);
    await audit(req.staff.id, 'stock_adjust', item_type, item_id, { stock: cur.stock }, { stock: cur.stock + delta }, reason);
  });
  changed();
  res.json({ ok: true });
}));
r.get('/stock', staffAuth(), ah(async (req, res) => {
  const products = await db.all('SELECT id, code, name, unit, stock, low_stock, track_stock FROM products WHERE track_stock = 1 ORDER BY name');
  const ingredients = await db.all('SELECT * FROM ingredients ORDER BY name');
  const moves = await db.all('SELECT * FROM stock_moves ORDER BY created_at DESC LIMIT 200');
  res.json({ products, ingredients, moves });
}));

export default r;

// ---------- product barcode labels ----------
r.get('/labels/config', staffAuth('manage_menu'), ah(async (req, res) => res.json(labelCfg((await getSettings()).labels))));
r.put('/labels/config', staffAuth('manage_menu'), ah(async (req, res) => {
  const v = req.body.value || {};
  const clean = Object.fromEntries(Object.entries(v).filter(([k]) => k in labelCfg({})));
  const after = await setSetting('labels', clean);
  await audit(req.staff.id, 'settings', 'settings', 'labels', null, after);
  res.json(labelCfg(after));
}));
const bestBarcode = (codes) => codes.find(isEan13) || codes[0] || '';
// Print labels on a printer of the shop (ESC/POS raster). Prices and codes come from the database.
r.post('/print/labels', staffAuth('manage_menu'), ah(async (req, res) => {
  const cfg = labelCfg({ ...(await getSettings()).labels, ...(req.body.cfg || {}) });
  const printer = await db.get('SELECT * FROM printers WHERE id = ? AND active = 1', [req.body.printer_id || '']);
  if (!printer) throw bad('กรุณาเลือกเครื่องพิมพ์');
  const width = Number(printer.paper) === 58 ? 384 : 576;
  if (labelRowDots(cfg).w > width) throw bad(`ฉลากกว้างเกินกระดาษ ${printer.paper} มม. — ลดความกว้างหรือจำนวนคอลัมน์`);
  const store = (await getSettings()).store.name;
  const list = [];
  for (const { product_id, qty } of [].concat(req.body.items || [])) {
    const p = await db.get('SELECT id, code, name, price FROM products WHERE id = ?', [product_id]);
    if (!p) throw notFound('ไม่พบสินค้า');
    const codes = (await db.all('SELECT code FROM barcodes WHERE product_id = ?', [p.id])).map((b) => b.code);
    const n = Math.max(0, Math.min(200, Math.round(Number(qty) || 0)));
    for (let i = 0; i < n; i++) list.push({ name: p.name, price: p.price, code: p.code, barcode: bestBarcode(codes), store });
  }
  if (!list.length) throw bad('ยังไม่ได้เลือกสินค้า');
  if (list.length > 500) throw bad('พิมพ์ได้ครั้งละไม่เกิน 500 ดวง');
  const cols = labelRowDots(cfg).cols;
  const elements = [];
  for (let i = 0; i < list.length; i += cols) {
    elements.push({ type: 'label', cfg, items: list.slice(i, i + cols), font: cfg.font });
    elements.push(cfg.cut_each ? { type: 'cut' } : { type: 'space', height: Math.round((Number(cfg.feed_mm) || 0) * 8) });
  }
  const template = { paper: Number(printer.paper) || 80, margin: 0, section_gap: 0, font: cfg.font, size: 20, copies: 1, feed_after: 3, cut: 'full', elements };
  const jobs = await enqueue('label', 'labels-' + Date.now(), { store_name: store }, { printerId: printer.id, template });
  await audit(req.staff.id, 'print_labels', 'printer', printer.id, null, { count: list.length });
  res.json({ jobs, count: list.length });
}));
// Give products without a barcode an in-store EAN-13 (prefix 20 = for use inside the shop)
r.post('/products/barcodes/generate', staffAuth('manage_menu'), ah(async (req, res) => {
  const ids = req.body.product_ids && req.body.product_ids.length ? req.body.product_ids : (await db.all('SELECT id FROM products WHERE active = 1')).map((p) => p.id);
  const made = [];
  await db.tx(async () => {
    for (const pid of ids) {
      if (await db.get('SELECT code FROM barcodes WHERE product_id = ?', [pid])) continue;
      if (!(await db.get('SELECT id FROM products WHERE id = ?', [pid]))) continue;
      let code;
      do { const d12 = '20' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0'); code = d12 + ean13Check(d12); } while (await db.get('SELECT code FROM barcodes WHERE code = ?', [code]));
      await db.run('INSERT INTO barcodes(code, product_id) VALUES(?,?)', [code, pid]);
      made.push({ product_id: pid, barcode: code });
    }
  });
  if (made.length) { await audit(req.staff.id, 'generate_barcodes', 'product', null, null, { count: made.length }); changed(); }
  res.json({ created: made });
}));

// ---------- product assistant: photo/barcode → name + photo (price and category are set by staff) ----------
r.post('/products/lookup', staffAuth('manage_menu'), ah(async (req, res) => {
  const code = String(req.body.barcode || '').trim();
  if (!/^[0-9A-Za-z-]{4,32}$/.test(code)) throw bad('บาร์โค้ดไม่ถูกต้อง');
  const has = await db.get('SELECT p.id, p.name, p.price, p.active FROM barcodes b JOIN products p ON p.id = b.product_id WHERE b.code = ?', [code]);
  if (has) return res.json({ barcode: code, exists: has });
  const info = await lookupBarcode(code);
  const cats = await db.all('SELECT id, name FROM categories WHERE active = 1 ORDER BY sort, name');
  const taken = await db.get('SELECT id FROM products WHERE code = ?', [code]);
  res.json({ barcode: code, ...info, suggested_category_id: info.found ? suggestCategory(info, cats) : null, suggested_code: taken ? '' : code });
}));
r.post('/products/import-image', staffAuth('manage_menu'), ah(async (req, res) => {
  let img;
  try { img = await fetchImage(String(req.body.url || '')); } catch (e) { throw bad(e.message); }
  const fid = await saveFile(img.buf, img.name.slice(0, 120), img.mime);
  res.json({ url: '/files/' + fid });
}));

// ---------- product assistant with AI: any product photo (barcode optional) → names + many photos ----------
const hint4 = (v) => (v ? '…' + String(v).slice(-4) : '');
r.get('/assistant/config', staffAuth('manage_menu'), ah(async (req, res) => {
  const k = await aiKeys();
  res.json({ ai: !!k.anthropic, pexels: !!k.pexels, serper: !!k.serper, model: AI_MODEL, hints: { anthropic: hint4(k.anthropic), pexels: hint4(k.pexels), serper: hint4(k.serper) } });
}));
r.put('/assistant/config', staffAuth('settings'), ah(async (req, res) => {
  const b = req.body || {};
  for (const [k, name] of [['anthropic_api_key', 'anthropic_api_key'], ['pexels_api_key', 'pexels_api_key'], ['serper_api_key', 'serper_api_key']]) if (b[k]) await setSecret(name, String(b[k]).trim()); // blank = keep the saved key
  for (const k of [].concat(b.clear || [])) if (['anthropic_api_key', 'pexels_api_key', 'serper_api_key'].includes(k)) await setSecret(k, null);
  await audit(req.staff.id, 'settings', 'secrets', 'assistant', null, { set: Object.keys(b).filter((k) => b[k] && k !== 'clear'), clear: b.clear || [] });
  res.json({ ok: true });
}));
r.post('/products/identify', staffAuth('manage_menu'), ah(async (req, res) => {
  rateLimit('identify:' + req.staff.id, 30, 600000);
  const text = String(req.body.text || '').trim().slice(0, 200);
  let barcode = String(req.body.barcode || '').trim();
  if (barcode && !/^[0-9A-Za-z-]{4,32}$/.test(barcode)) barcode = '';
  let image = null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.image || ''));
  if (req.body.image && !m) throw bad('รูปไม่ถูกต้อง (รองรับ JPEG/PNG/WebP)');
  if (m) { if (m[2].length > 7_000_000) throw bad('รูปใหญ่เกินไป'); image = { mediaType: m[1], data: m[2] }; }
  if (!image && !text && !barcode) throw bad('ถ่ายรูปสินค้า หรือพิมพ์ชื่อสินค้าก่อน');
  const keys = await aiKeys();
  const cats = await db.all('SELECT id, name FROM categories WHERE active = 1 ORDER BY sort, name');
  const existsFor = (code) => db.get('SELECT p.id, p.name, p.price, p.active FROM barcodes b JOIN products p ON p.id = b.product_id WHERE b.code = ?', [code]);
  if (barcode) { const has = await existsFor(barcode); if (has) return res.json({ barcode, exists: has }); }
  const info = barcode ? await lookupBarcode(barcode) : { found: false, names: [], images: [] };
  let ai = null, aiError = null;
  if (keys.anthropic && (image || text || info.found)) {
    try {
      ai = await identifyWithClaude({ apiKey: keys.anthropic, imageBase64: image && image.data, mediaType: image && image.mediaType, text,
        barcodeInfo: info.found ? `${info.names.join(' / ')} (${info.brand || ''} ${info.quantity || ''})` : '', categories: cats });
    } catch (e) { if (!(e instanceof AiError)) throw e; aiError = e.message; }
  }
  if (ai && !barcode && /^\d{8,14}$/.test(ai.barcode || '')) {
    barcode = ai.barcode;
    const has = await existsFor(barcode); if (has) return res.json({ barcode, exists: has, ai });
  }
  if (!ai && !info.found && !text) {
    return res.json({ need_ai: !keys.anthropic, ai_error: aiError, barcode, names: [], images: [], errors: info.errors || [] });
  }
  const names = [...new Set([
    ...(ai ? [ai.product_name_th, ...(ai.names_th || []), ...(ai.names_mixed || []), ai.product_name_en, ...(ai.names_en || [])] : []),
    ...basicNames([...(info.names || []), text], { brand: info.brand, size: info.quantity }),
  ].map((n) => String(n || '').replace(/\s+/g, ' ').trim()).filter(Boolean))].slice(0, 30);
  const productQueries = ai ? ai.image_queries_product : [[info.brand, info.names[0]].filter(Boolean).join(' ') || text];
  const promoQueries = ai ? ai.image_queries_promo : [info.names.find((n) => /^[\x00-\x7F]+$/.test(n)) || text];
  const found = await findImages({ productQueries, promoQueries, keys });
  const images = [...(info.images || []).map((u) => ({ url: u, thumb: u, source: info.source, kind: 'product' })), ...found.images].filter((im, i, a) => a.findIndex((x) => x.url === im.url) === i);
  const hintByName = ai && ai.category_hint ? cats.find((c) => c.name === ai.category_hint || ai.category_hint.includes(c.name)) : null;
  const taken = barcode ? await db.get('SELECT id FROM products WHERE code = ?', [barcode]) : null;
  res.json({ barcode, found: !!ai || info.found, source: ai ? (ai.identified ? 'AI (Claude)' : 'AI (ไม่แน่ใจ)') : info.source, identified: ai ? !!ai.identified : info.found,
    product_type: ai ? ai.product_type : '', brand: (ai && ai.brand) || info.brand || '', quantity: (ai && ai.size) || info.quantity || '', flavor: ai ? ai.flavor : '',
    names, images, suggested_category_id: (hintByName && hintByName.id) || suggestCategory({ names, categories: info.categories || [], brand: info.brand }, cats),
    suggested_code: barcode && !taken ? barcode : '', ai_error: aiError, errors: [...(info.errors || []), ...found.errors], sources: { ai: !!keys.anthropic, pexels: !!keys.pexels, serper: !!keys.serper } });
}));
