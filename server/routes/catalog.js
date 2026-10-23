import { Router } from 'express';
import { db, J, S } from '../db.js';
import { ah, id, now, bad, notFound, conflict, audit, emit } from '../lib/util.js';
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
      unit: p.unit, bowl_count: p.bowl_count, per_bowl_limit: p.per_bowl_limit, station_id: p.station_id, active: !!p.active, mobile: !!p.mobile,
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
  'low_stock', 'active', 'sold_out', 'kind', 'recipe', 'option_groups', 'sort', 'mobile'];
function normProduct(b, cur = {}) {
  const o = {};
  for (const f of PFIELDS) o[f] = b[f] !== undefined ? b[f] : cur[f];
  for (const f of ['recipe', 'option_groups']) if (typeof o[f] !== 'string') o[f] = S(o[f] || []);
  for (const f of ['track_stock', 'active', 'sold_out', 'mobile']) o[f] = o[f] === undefined ? (f === 'active' || f === 'mobile' ? 1 : 0) : o[f] ? 1 : 0;
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
