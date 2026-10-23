import { db, J, S } from '../db.js';
import { id, now, getSettings, businessDateOf, nextCounter, bad, conflict, notFound, forbidden, emit, audit, token, addMinutes } from './util.js';
import { can } from './auth.js';
import { computeTotals, orderDineType, splitTickets, countBowls, dineLabel } from '../../public/shared/core.js';
import { enqueue, orderDocData, fmtDate } from './print.js';
import { awardOrder, reverseForRefund } from './members.js';

const EDITABLE = ['held', 'open', 'pending_payment'];

// ---------- pricing: never trust client prices ----------
export async function priceLines(rawLines, { staff = null, source = 'pos', existing = new Map() } = {}) {
  const out = [];
  for (const raw of rawLines) {
    const qty = Math.floor(Number(raw.qty));
    if (!(qty > 0) || qty > 999) throw bad('จำนวนสินค้าไม่ถูกต้อง');
    const old = raw.id ? existing.get(raw.id) : null;
    if (raw.id && !old) throw bad('รายการเดิมไม่อยู่ในบิลนี้');
    if (old) { out.push({ ...old, _old: old, qty_new: qty, dine_type: old.dine_type }); continue; }
    const p = await db.get('SELECT * FROM products WHERE id = ?', [raw.product_id]);
    if (!p || !p.active) throw bad(`สินค้าไม่พร้อมขาย: ${raw.name || raw.product_id}`, 'unavailable');
    if (p.sold_out) throw bad(`สินค้าหมด: ${p.name}`, 'sold_out');
    if (source !== 'pos' && !p.mobile) throw bad(`เมนูนี้สั่งผ่านมือถือไม่ได้: ${p.name}`, 'unavailable');
    if (source !== 'pos' && p.track_stock && p.stock < qty) throw bad(`สินค้าคงเหลือไม่พอ: ${p.name}`, 'out_of_stock');
    // options must belong to the product's option groups; prices come from the DB
    const groups = J(p.option_groups, []);
    const chosen = [];
    const byGroup = new Map();
    for (const o of raw.options || []) {
      if (!groups.includes(o.group_id)) throw bad(`ตัวเลือกไม่ถูกต้องสำหรับ ${p.name}`);
      const g = await db.get('SELECT * FROM option_groups WHERE id = ?', [o.group_id]);
      const opt = J(g.options, []).find((x) => x.id === o.id);
      if (!opt || opt.active === false) throw bad(`ตัวเลือกไม่พร้อมใช้: ${o.name || o.id}`);
      byGroup.set(g.id, (byGroup.get(g.id) || 0) + 1);
      chosen.push({ group_id: g.id, group: g.name, id: opt.id, name: opt.name, price: Number(opt.price) || 0, cost: Number(opt.cost) || 0, recipe: opt.recipe || [] });
    }
    for (const gid of groups) {
      const g = await db.get('SELECT * FROM option_groups WHERE id = ?', [gid]);
      if (!g) continue;
      const n = byGroup.get(gid) || 0;
      if (n < g.min_select) throw bad(`กรุณาเลือก ${g.name} สำหรับ ${p.name}`, 'option_required');
      if (g.max_select && n > g.max_select) throw bad(`เลือก ${g.name} ได้ไม่เกิน ${g.max_select}`);
    }
    let unit = p.price;
    if (raw.price_override !== undefined && raw.price_override !== null && raw.price_override !== '' && Number(raw.price_override) !== p.price) {
      if (!can(staff, 'edit_price')) throw forbidden('ไม่มีสิทธิ์แก้ราคา');
      unit = Math.max(0, Math.round(Number(raw.price_override)));
    }
    const dt = raw.dine_type === 'takeaway' ? 'takeaway' : 'dine_in';
    // cost snapshot at the time of sale: recipe menus use current ingredient costs, finished goods use product cost
    let costUnit = p.cost;
    const recipe = J(p.recipe, []);
    if (p.kind === 'recipe' && recipe.length) {
      costUnit = 0;
      for (const r of recipe) { const ing = await db.get('SELECT cost FROM ingredients WHERE id = ?', [r.ingredient_id]); costUnit += Math.round((ing ? ing.cost : 0) * Number(r.qty)); }
    }
    out.push({ product_id: p.id, name: p.name, qty, qty_new: qty, unit_price: unit, options: chosen, note: String(raw.note || '').slice(0, 200), dine_type: dt,
      bowl_group: raw.bowl_group ? Math.max(1, Math.floor(raw.bowl_group)) : null, bowl_count: Number(p.bowl_count) || 0, station_id: p.station_id,
      cost_unit: costUnit, category_id: p.category_id, per_bowl_limit: p.per_bowl_limit, product: p, void_qty: 0, sent_qty: 0 });
  }
  // per-bowl rule: e.g. at most 2 packets of noodles in one bowl group
  const grp = new Map();
  for (const l of out) if (l.bowl_group && l.per_bowl_limit) {
    const k = l.bowl_group + ':' + l.product_id; grp.set(k, (grp.get(k) || 0) + l.qty_new);
    if (grp.get(k) > l.per_bowl_limit) throw bad(`${l.name} ใส่ได้ไม่เกิน ${l.per_bowl_limit} ต่อชาม`, 'per_bowl_limit');
  }
  return out;
}

async function tierDiscountPct(memberId) {
  if (!memberId) return 0;
  const r = await db.get('SELECT t.discount_pct FROM members m JOIN tiers t ON t.id = m.tier_id WHERE m.id = ? AND t.active = 1', [memberId]);
  return r ? Number(r.discount_pct) || 0 : 0;
}

async function resolveDiscount(cart, staff, items_total, memberId) {
  const s = await getSettings();
  const d = cart.discount || {};
  let amount = 0;
  if (d.value) {
    if (!can(staff, 'discount')) throw forbidden('ไม่มีสิทธิ์ให้ส่วนลด');
    amount = d.type === 'percent' ? Math.round(items_total * Math.min(100, Number(d.value)) / 100) : Math.round(Number(d.value));
    const maxPct = (s.sale.max_discount_pct || {})[staff.role_id] ?? 100;
    if (amount > Math.round(items_total * maxPct / 100) && !(cart._approved_discount)) throw forbidden(`ส่วนลดเกินสิทธิ์ (${maxPct}%) ต้องให้ผู้จัดการอนุมัติ`);
  }
  const tierPct = await tierDiscountPct(memberId);
  const tierAmt = tierPct ? Math.round((items_total - amount) * tierPct / 100) : 0;
  return { type: 'amount', value: amount + tierAmt, info: { manual: d.value ? { type: d.type, value: d.value, reason: d.reason || '' } : null, tier_pct: tierPct, tier_amount: tierAmt } };
}

async function allocateQueue(order, terminalId, shiftId) {
  const s = await getSettings();
  const q = s.queue;
  if (!q.enabled) return null;
  const series = order.dine_type === 'takeaway' ? 'takeaway' : order.dine_type === 'mixed' ? q.mixed_series : 'dine_in';
  const prefix = q.separate ? (series === 'takeaway' ? q.takeaway_prefix : q.dine_in_prefix) : q.prefix;
  const period = q.reset === 'shift' ? 'shift:' + (shiftId || 'none') : q.reset === 'manual' ? 'manual' : 'day:' + (await businessDateOf());
  const scope = q.scope === 'terminal' ? 'term:' + (terminalId || 'web') : 'shared';
  const key = `queue:${scope}:${q.separate ? series : 'all'}:${period}:e${q.epoch || 0}`;
  const n = await nextCounter(key) + (Number(q.start) || 1) - 1;
  return (prefix || '') + String(n).padStart(Number(q.digits) || 3, '0');
}

async function newBillNo() {
  const s = await getSettings();
  const bd = await businessDateOf();
  const n = await nextCounter('bill:' + bd);
  return `${s.bill.prefix || 'B'}${bd.slice(2).replaceAll('-', '')}-${String(n).padStart(4, '0')}`;
}

export async function getOrder(oid) {
  const o = await db.get('SELECT * FROM orders WHERE id = ?', [oid]);
  if (!o) throw notFound('ไม่พบบิล');
  return o;
}
export async function orderFull(oid) {
  const o = await getOrder(oid);
  const items = (await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY seq', [oid])).map((i) => ({ ...i, options: J(i.options, []) }));
  const payments = await db.all('SELECT id, method, amount, received, change_amount, ref, status, provider, created_at, slip_file FROM payments WHERE order_id = ? ORDER BY created_at', [oid]);
  const refunds = (await db.all('SELECT * FROM refunds WHERE order_id = ? ORDER BY created_at', [oid])).map((r) => ({ ...r, items: J(r.items, []) }));
  const tickets = await db.all('SELECT id, station_id, kind, status, created_at FROM kitchen_tickets WHERE order_id = ? ORDER BY created_at', [oid]);
  const jobs = await db.all('SELECT id, printer_id, doc_type, status, error, attempts, created_at, updated_at FROM print_jobs WHERE ref_id = ? OR ref_id IN (SELECT id FROM kitchen_tickets WHERE order_id = ?) ORDER BY seq', [oid, oid]);
  const member = o.member_id ? await db.get('SELECT id, member_no, first_name, last_name, nickname, phone, points FROM members WHERE id = ?', [o.member_id]) : null;
  const staff = o.staff_id ? await db.get('SELECT name FROM staff WHERE id = ?', [o.staff_id]) : null;
  return { ...o, discount_info: J(o.discount_info), items, payments, refunds, tickets, print_jobs: jobs, member, staff_name: staff && staff.name };
}

// Create or update an order from a cart. action: 'hold' | 'send' | 'save'
export async function saveOrder({ orderId = null, cart, staff, terminalId = null, shiftId = null, action = 'save', idempotencyKey = null, source = 'pos', mobileSessionId = null, payMode = null }) {
  return db.tx(async () => {
    if (idempotencyKey) {
      const dup = await db.get('SELECT id FROM orders WHERE idempotency_key = ?', [idempotencyKey]);
      if (dup) return { order: await getOrder(dup.id), duplicate: true };
    }
    const s = await getSettings();
    let order = orderId ? await getOrder(orderId) : null;
    if (order && !EDITABLE.includes(order.status)) throw conflict('บิลนี้ปิดแล้ว แก้ไขไม่ได้', 'not_editable');
    if (order && cart.version && Number(cart.version) !== order.version) throw conflict('บิลถูกแก้ไขจากเครื่องอื่น กรุณาโหลดใหม่', 'version');
    const existingItems = order ? await db.all('SELECT * FROM order_items WHERE order_id = ?', [order.id]) : [];
    const existing = new Map(existingItems.map((i) => [i.id, { ...i, options: J(i.options, []) }]));
    const lines = await priceLines(cart.lines || [], { staff, source, existing });
    const t = now();
    const bdate = await businessDateOf();
    if (!order) {
      const oid = id();
      await db.run(`INSERT INTO orders(id, bill_no, source, terminal_id, shift_id, staff_id, status, created_at, updated_at, business_date, idempotency_key, mobile_session_id, pay_mode)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [oid, await newBillNo(), source, terminalId, shiftId, staff ? staff.id : null, action === 'hold' ? 'held' : 'open', t, t, bdate, idempotencyKey, mobileSessionId, payMode]);
      order = await getOrder(oid);
    }
    // removed or reduced existing lines
    const keep = new Set(lines.filter((l) => l._old).map((l) => l._old.id));
    const voided = [];
    for (const old of existingItems) {
      const eff = old.qty - old.void_qty;
      const l = lines.find((x) => x._old && x._old.id === old.id);
      const newEff = keep.has(old.id) ? l.qty_new : 0;
      if (newEff === eff) continue;
      if (newEff > eff) { // increase: more units, still unsent
        await db.run('UPDATE order_items SET qty = qty + ? WHERE id = ?', [newEff - eff, old.id]);
        continue;
      }
      const delta = eff - newEff;
      if (old.sent_qty > 0) {
        const sentVoid = Math.max(0, old.sent_qty - newEff);
        if (sentVoid > 0 && staff && !can(staff, 'void_item') && source === 'pos') throw forbidden('ต้องมีสิทธิ์ยกเลิกรายการที่ส่งครัวแล้ว');
        await db.run('UPDATE order_items SET void_qty = void_qty + ?, sent_qty = sent_qty - ? WHERE id = ?', [delta, sentVoid, old.id]);
        if (sentVoid > 0) voided.push({ ...old, options: J(old.options, []), qty: sentVoid });
      } else if (newEff === 0) await db.run('DELETE FROM order_items WHERE id = ?', [old.id]);
      else await db.run('UPDATE order_items SET qty = ? WHERE id = ?', [old.void_qty + newEff, old.id]);
    }
    let seq = existingItems.reduce((m, i) => Math.max(m, i.seq), 0);
    for (const l of lines.filter((x) => !x._old)) {
      await db.run(`INSERT INTO order_items(id, order_id, product_id, name, qty, unit_price, options, options_price, line_total, cost_unit, dine_type, note, bowl_group, bowl_count,
        station_id, seq, category_id, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id(), order.id, l.product_id, l.name, l.qty, l.unit_price, S(l.options.map(({ recipe, ...o }) => ({ ...o, recipe }))), l.options.reduce((a, o) => a + o.price, 0), 0,
        l.cost_unit + l.options.reduce((a, o) => a + o.cost, 0), l.dine_type, l.note, l.bowl_group, l.bowl_count, l.station_id, ++seq, l.category_id, t]);
    }
    order = await recalc(order.id, cart, staff);
    const fields = {
      table_id: cart.table_id ?? order.table_id, table_name: cart.table_id ? (await db.get('SELECT name FROM dining_tables WHERE id = ?', [cart.table_id]) || {}).name : (cart.table_name ?? order.table_name),
      customer_name: cart.customer_name ?? order.customer_name, customer_phone: cart.customer_phone ?? order.customer_phone, note: cart.note ?? order.note,
      member_id: cart.member_id !== undefined ? cart.member_id || null : order.member_id,
    };
    if (fields.table_id && fields.table_id !== order.table_id) await db.run("UPDATE dining_tables SET status = 'occupied' WHERE id = ?", [fields.table_id]);
    const newStatus = action === 'hold' ? 'held' : order.status === 'held' ? 'open' : order.status;
    await db.run('UPDATE orders SET table_id = ?, table_name = ?, customer_name = ?, customer_phone = ?, note = ?, member_id = ?, status = ?, updated_at = ?, version = version + 1 WHERE id = ?',
      [fields.table_id, fields.table_name, fields.customer_name, fields.customer_phone, fields.note, fields.member_id, newStatus, t, order.id]);
    order = await recalc(order.id, cart, staff);
    if (voided.length) await kitchenTickets(order, voided, 'void', staff);
    if (action === 'send') await sendKitchen(order, staff, terminalId, shiftId);
    order = await getOrder(order.id);
    emit('shop', 'orders:changed', { id: order.id, status: order.status });
    return { order };
  });
}

// Recompute totals from stored items (single source of truth for money and bowls)
export async function recalc(orderId, cart = null, staff = null) {
  const s = await getSettings();
  const o = await getOrder(orderId);
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
  for (const i of items) await db.run('UPDATE order_items SET line_total = ? WHERE id = ?', [(i.unit_price + i.options_price) * (i.qty - i.void_qty), i.id]);
  const lines = items.map((i) => ({ ...i, options: J(i.options, []) }));
  const pre = computeTotals(lines, s.sale);
  let disc = J(o.discount_info);
  let discVal = o.discount || 0;
  if (cart && (cart.discount !== undefined || cart.member_id !== undefined)) {
    const d = await resolveDiscount(cart.discount !== undefined ? cart : { discount: disc && disc.manual }, staff || { perms: ['discount'], role_id: 'owner' }, pre.items_total,
      cart.member_id !== undefined ? cart.member_id : o.member_id);
    disc = d.info; discVal = d.value;
  } else if (disc) {
    const manual = disc.manual ? (disc.manual.type === 'percent' ? Math.round(pre.items_total * disc.manual.value / 100) : disc.manual.value) : 0;
    discVal = manual + (disc.tier_pct ? Math.round((pre.items_total - manual) * disc.tier_pct / 100) : 0);
  }
  const tt = computeTotals(lines, s.sale, { type: 'amount', value: discVal });
  await db.run('UPDATE orders SET items_total = ?, discount = ?, discount_info = ?, packaging = ?, tax = ?, total = ?, bowls = ?, cost_total = ?, dine_type = ? WHERE id = ?',
    [tt.items_total, tt.discount, S(disc), tt.packaging, tt.tax, tt.total, tt.bowls, tt.cost, orderDineType(lines), orderId]);
  return getOrder(orderId);
}

export async function ensureQueue(order, terminalId, shiftId) {
  if (order.queue_no) return order.queue_no;
  const q = await allocateQueue(order, terminalId || order.terminal_id, shiftId || order.shift_id);
  if (q) await db.run('UPDATE orders SET queue_no = ? WHERE id = ? AND queue_no IS NULL', [q, order.id]);
  return (await getOrder(order.id)).queue_no;
}

// Send all unsent quantities to their stations. Only the new ("เพิ่ม") items are printed for later additions.
export async function sendKitchen(order, staff, terminalId, shiftId) {
  await ensureQueue(order, terminalId, shiftId);
  order = await getOrder(order.id);
  const items = await db.all('SELECT * FROM order_items WHERE order_id = ? ORDER BY seq', [order.id]);
  const unsent = items.filter((i) => i.qty - i.void_qty - i.sent_qty > 0)
    .map((i) => ({ ...i, options: J(i.options, []), qty: i.qty - i.void_qty - i.sent_qty }));
  if (!unsent.length) return [];
  const isAdd = items.some((i) => i.sent_qty > 0);
  for (const i of unsent) await db.run('UPDATE order_items SET sent_qty = sent_qty + ? WHERE id = ?', [i.qty, i.id]);
  const out = await kitchenTickets(order, unsent, isAdd ? 'add' : 'new', staff);
  if (order.prep_status === 'none') await db.run("UPDATE orders SET prep_status = 'received' WHERE id = ?", [order.id]);
  return out;
}

export async function kitchenTickets(order, lines, kind, staff) {
  // toppings in a bowl group follow the station of that bowl so they are never separated
  const groupStation = new Map();
  for (const l of lines) if (l.bowl_group && l.bowl_count > 0 && !groupStation.has(l.bowl_group)) groupStation.set(l.bowl_group, l.station_id);
  const allItems = await db.all('SELECT bowl_group, station_id, bowl_count FROM order_items WHERE order_id = ? AND bowl_count > 0 AND bowl_group IS NOT NULL', [order.id]);
  for (const i of allItems) if (!groupStation.has(i.bowl_group)) groupStation.set(i.bowl_group, i.station_id);
  const byStation = new Map();
  for (const l of lines) {
    const st = (l.bowl_group && groupStation.get(l.bowl_group)) || l.station_id || 'default';
    if (!byStation.has(st)) byStation.set(st, []);
    byStation.get(st).push(l);
  }
  const staffName = staff ? staff.name : order.source === 'pos' ? '' : 'Mobile Ordering';
  const created = [];
  for (const [stationId, ls] of byStation) {
    const station = await db.get('SELECT * FROM stations WHERE id = ?', [stationId]) || { id: stationId, name: 'ครัว', split_mode: 'order', bowls_per_ticket: 1 };
    const parts = kind === 'void' ? [{ label: '', lines: ls, index: 1, count: 1 }] : splitTickets(ls, station.split_mode, station.bowls_per_ticket);
    for (const part of parts) {
      const tid = id();
      const content = {
        kind, kind_label: kind === 'void' ? '*** ยกเลิกรายการ ***' : kind === 'add' ? '+++ สั่งเพิ่ม +++' : 'ออเดอร์ใหม่',
        queue_no: order.queue_no, bill_no: order.bill_no, dine_type: order.dine_type, dine_label: dineLabel(order.dine_type), table: order.table_name || '',
        customer: order.customer_name || '', staff: staffName, created_at: now(), datetime: fmtDate(now()), note: order.note || '', source: order.source,
        station: station.name, station_id: station.id, part_label: part.label, part: parts.length > 1 ? `ใบที่ ${part.index}/${part.count}` + (part.label ? ` · ${part.label}` : '') : part.label || '',
        lines: part.lines.map((l) => ({ name: l.name, qty: l.qty, options: (l.options || []).map((o) => ({ group: o.group, name: o.name })), note: l.note, dine_type: l.dine_type,
          bowl_group: l.bowl_group, bowl_label: l.bowl_label || (l.bowl_group ? `ชามที่ ${l.bowl_group}` : ''), bowl_count: l.bowl_count })),
        bowls: countBowls(part.lines), ref: kind === 'void' ? `อ้างอิงบิล ${order.bill_no} คิว ${order.queue_no || '-'}` : '',
      };
      await db.run('INSERT INTO kitchen_tickets(id, order_id, station_id, kind, content, status, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)',
        [tid, order.id, station.id, kind, S(content), kind === 'void' ? 'void' : 'new', now(), now()]);
      const data = { ...(await kitchenDocData(content)) };
      await enqueue('kitchen', tid, data, { stationId: station.id, dedupe: 'kitchen:' + tid });
      created.push(tid);
      emit('kitchen', 'kitchen:ticket', { id: tid, order_id: order.id, station_id: station.id, kind, content });
    }
  }
  return created;
}
async function kitchenDocData(c) {
  return { store_name: '', ticket_kind: c.kind_label, queue_no: c.queue_no, dine_type: c.dine_type, dine_label: c.dine_label, table: c.table, customer: c.customer,
    station: c.station, ticket_part: c.part, bill_no: c.bill_no, datetime: c.datetime, staff: c.staff, order_note: c.note, bowls: c.bowls, reason: c.ref,
    items: c.lines.map((l) => ({ ...l, line_total: null })) };
}

// ---------- stock ----------
async function moveStock(type, itemId, qty, reason, ref, staffId) {
  if (!qty) return;
  if (type === 'product') {
    const r = await db.get('UPDATE products SET stock = stock + ? WHERE id = ? AND track_stock = 1 RETURNING stock, low_stock, name', [qty, itemId]);
    if (!r) return;
    if (r.stock <= r.low_stock) emit('admin', 'stock:low', { id: itemId, name: r.name, stock: r.stock });
  } else {
    const r = await db.get('UPDATE ingredients SET stock = stock + ? WHERE id = ? RETURNING stock, low_stock, name', [qty, itemId]);
    if (r && r.stock <= r.low_stock) emit('admin', 'stock:low', { id: itemId, name: r.name, stock: r.stock });
  }
  await db.run('INSERT INTO stock_moves(id, item_type, item_id, qty, reason, ref, staff_id, created_at) VALUES(?,?,?,?,?,?,?,?)', [id(), type, itemId, qty, reason, ref, staffId, now()]);
}
// sign -1 = sell, +1 = return. qtyFn picks the quantity of each item to move.
export async function stockForItems(items, sign, reason, ref, staffId, qtyFn = (i) => i.qty - i.void_qty) {
  for (const i of items) {
    const q = qtyFn(i);
    if (!q) continue;
    const p = await db.get('SELECT id, track_stock, kind, recipe FROM products WHERE id = ?', [i.product_id]);
    if (!p) continue;
    if (p.track_stock) await moveStock('product', p.id, sign * q, reason, ref, staffId);
    for (const r of J(p.recipe, [])) await moveStock('ingredient', r.ingredient_id, sign * q * Number(r.qty), reason, ref, staffId);
    for (const o of J(i.options, [])) for (const r of o.recipe || []) await moveStock('ingredient', r.ingredient_id, sign * q * Number(r.qty), reason, ref, staffId);
  }
}

// ---------- payment ----------
// payments: [{ method, amount, received }] in satang. Idempotent by key; a paid order can never be paid twice.
export async function payOrder({ orderId, payments, staff, terminalId, shiftId, idempotencyKey, print = {}, provider = null }) {
  const result = await db.tx(async () => {
    if (idempotencyKey) {
      const dup = await db.get('SELECT order_id FROM payments WHERE provider_ref = ?', ['idem:' + idempotencyKey]);
      if (dup) return { order: await getOrder(dup.order_id), duplicate: true };
    }
    let order = await getOrder(orderId);
    if (order.status === 'paid') throw conflict('บิลนี้ชำระแล้ว', 'already_paid');
    if (!EDITABLE.includes(order.status)) throw conflict('บิลนี้ไม่อยู่ในสถานะรอชำระ', 'not_payable');
    const s = await getSettings();
    const enabled = new Set(s.sale.payment_methods.filter((m) => m.enabled).map((m) => m.id));
    let paid = 0, received = 0, nonCash = 0;
    const rows = [];
    for (const p of payments || []) {
      const amt = Math.round(Number(p.amount));
      if (!(amt > 0)) continue;
      if (!enabled.has(p.method) && !provider) throw bad('ช่องทางชำระเงินไม่ได้เปิดใช้งาน: ' + p.method);
      const rec = p.method === 'cash' ? Math.max(amt, Math.round(Number(p.received) || amt)) : amt;
      if (p.method !== 'cash') nonCash += amt;
      rows.push({ method: p.method, amount: amt, received: rec, ref: p.ref || null, slip: p.slip_file || null });
      paid += amt; received += rec;
    }
    if (nonCash > order.total) throw bad('ยอดชำระที่ไม่ใช่เงินสดเกินยอดบิล');
    if (paid < order.total) throw bad(`ยอดชำระไม่ครบ ขาด ${((order.total - paid) / 100).toFixed(2)} บาท`, 'underpaid');
    // cash change: only cash can produce change
    const change = paid - order.total + (received - paid);
    const cashLine = rows.find((r) => r.method === 'cash');
    if (paid > order.total && !cashLine) throw bad('ยอดชำระเกิน');
    // lock the order: conditional status change makes double submission impossible
    const bdate = await businessDateOf();
    const t = now();
    const lock = await db.run(`UPDATE orders SET status = 'paid', paid_at = ?, paid_business_date = ?, paid_amount = ?, change_amount = ?, shift_id = COALESCE(shift_id, ?),
      terminal_id = COALESCE(terminal_id, ?), staff_id = COALESCE(staff_id, ?), version = version + 1, updated_at = ?, expires_at = NULL WHERE id = ? AND status = ?`,
    [t, bdate, order.total, change, shiftId, terminalId, staff ? staff.id : null, t, orderId, order.status]);
    if (!lock.changes) throw conflict('บิลนี้กำลังถูกชำระจากเครื่องอื่น', 'already_paid');
    let first = true;
    for (const r of rows) {
      // record the net amount actually kept for each method (cash minus change)
      const keep = r.method === 'cash' ? r.amount - (paid - order.total) : r.amount;
      await db.run(`INSERT INTO payments(id, order_id, method, amount, received, change_amount, ref, status, provider, provider_ref, staff_id, shift_id, created_at, business_date, slip_file)
        VALUES(?,?,?,?,?,?,?,'paid',?,?,?,?,?,?,?)`, [id(), orderId, r.method, keep, r.received, r.method === 'cash' ? change : 0, r.ref, provider,
        first && idempotencyKey ? 'idem:' + idempotencyKey : null, staff ? staff.id : null, shiftId, t, bdate, r.slip]);
      first = false;
    }
    order = await getOrder(orderId);
    await ensureQueue(order, terminalId, shiftId);
    order = await getOrder(orderId);
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    await stockForItems(items, -1, 'sale', order.bill_no, staff && staff.id);
    if (order.member_id) await awardOrder(order, order.member_id, staff ? staff.id : 'system', 'earn').catch((e) => { if (e.code !== 'already_claimed') throw e; });
    else if (s.points.enabled && s.points.claim_qr && s.members.enabled) {
      await db.run("UPDATE orders SET claim_token = ?, claim_status = 'available' WHERE id = ?", [token(18), orderId]);
    }
    order = await getOrder(orderId);
    // kitchen: everything not sent yet goes now (also covers "send after payment" mode)
    await sendKitchen(order, staff, terminalId, shiftId);
    order = await getOrder(orderId);
    if (order.mobile_session_id) await afterMobilePaid(order);
    if (print.receipt !== false) await enqueue('receipt', orderId, await orderDocData(order), { dedupe: 'receipt:' + orderId });
    if (print.queue) await enqueue('queue', orderId, await orderDocData(order), { dedupe: 'queue:' + orderId });
    return { order };
  });
  if (!result.duplicate) {
    const o = result.order;
    emit('shop', 'orders:changed', { id: o.id, status: o.status });
    emit('admin', 'sales:changed', { id: o.id });
    if (o.mobile_session_id) emit('mobile:' + o.mobile_session_id, 'order:status', { id: o.id, status: o.status, prep_status: o.prep_status });
  }
  return result;
}

async function afterMobilePaid(order) {
  const ms = await db.get('SELECT * FROM mobile_sessions WHERE id = ?', [order.mobile_session_id]);
  if (ms && ms.mode === 'pickup' && ms.single_use) { /* pickup sessions end when the pickup is completed, not at payment */ }
}

export async function checkout({ cart, payments, staff, terminalId, shiftId, idempotencyKey, print, orderId = null }) {
  return db.tx(async () => {
    const dup = idempotencyKey ? await db.get('SELECT order_id FROM payments WHERE provider_ref = ?', ['idem:' + idempotencyKey]) : null;
    if (dup) return { order: await getOrder(dup.order_id), duplicate: true };
    const { order } = await saveOrder({ orderId, cart, staff, terminalId, shiftId, action: 'save', idempotencyKey: orderId ? null : 'o:' + idempotencyKey });
    return payOrder({ orderId: order.id, payments, staff, terminalId, shiftId, idempotencyKey, print });
  });
}

// ---------- void / refund ----------
export async function voidOrder({ orderId, staff, reason, terminalId }) {
  if (!reason) throw bad('กรุณาระบุเหตุผล');
  const r = await db.tx(async () => {
    const o = await getOrder(orderId);
    if (o.status === 'void') return { order: o, duplicate: true };
    const wasPaid = o.status === 'paid';
    const lock = await db.run("UPDATE orders SET status = 'void', void_reason = ?, voided_by = ?, voided_at = ?, version = version + 1 WHERE id = ? AND status = ?",
      [reason, staff.id, now(), orderId, o.status]);
    if (!lock.changes) throw conflict('สถานะบิลเปลี่ยนไปแล้ว');
    const items = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const sent = items.filter((i) => i.sent_qty > 0).map((i) => ({ ...i, options: J(i.options, []), qty: i.sent_qty }));
    if (sent.length) await kitchenTickets(o, sent, 'void', staff);
    let amount = 0;
    if (wasPaid) {
      amount = o.total - o.refunded_amount;
      const bowls = o.bowls - o.refunded_bowls;
      await stockForItems(items, 1, 'void', o.bill_no, staff.id, (i) => i.qty - i.void_qty - i.refunded_qty);
      const rid = id();
      await db.run('INSERT INTO refunds(id, order_id, kind, items, amount, bowls, cost, reason, staff_id, shift_id, method, created_at, business_date) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
        [rid, orderId, 'void', S(items.map((i) => ({ item_id: i.id, name: i.name, qty: i.qty - i.void_qty - i.refunded_qty }))), amount, bowls, o.cost_total - o.refunded_cost,
          reason, staff.id, await currentShiftId(terminalId), await refundMethod(orderId), now(), await businessDateOf()]);
      const after = await getOrder(orderId);
      await reverseForRefund(after, rid, null, staff.id);
      if (o.member_id) await db.run('UPDATE members SET total_spent = total_spent - ?, bills = bills - 1, tier_score = tier_score - ? WHERE id = ?', [amount, amount, o.member_id]);
      if (o.claim_status === 'available') await db.run("UPDATE orders SET claim_status = 'void' WHERE id = ?", [orderId]);
      await enqueue('refund', rid, await orderDocData(after, { ticket_kind: 'ยกเลิกบิล', reason, refund_amount: (amount / 100).toFixed(2), staff: staff.name }), { dedupe: 'refund:' + rid });
    }
    if (o.table_id) await freeTableIfIdle(o.table_id);
    await audit(staff.id, 'void_bill', 'order', orderId, { status: o.status, total: o.total }, { status: 'void' }, reason);
    return { order: await getOrder(orderId), amount };
  });
  emit('shop', 'orders:changed', { id: orderId, status: 'void' });
  emit('admin', 'sales:changed', { id: orderId });
  return r;
}
async function refundMethod(orderId) {
  const p = await db.get("SELECT method FROM payments WHERE order_id = ? AND status = 'paid' ORDER BY amount DESC LIMIT 1", [orderId]);
  return p ? p.method : 'cash';
}
async function currentShiftId(terminalId) {
  if (!terminalId) return null;
  const s = await db.get("SELECT id FROM shifts WHERE terminal_id = ? AND status = 'open'", [terminalId]);
  return s ? s.id : null;
}

// items: [{ item_id, qty }]; amounts are computed by the server from the stored line prices.
export async function refundItems({ orderId, items, staff, reason, method, restock = true, idempotencyKey, terminalId }) {
  if (!reason) throw bad('กรุณาระบุเหตุผล');
  const r = await db.tx(async () => {
    if (idempotencyKey) { const d = await db.get('SELECT * FROM refunds WHERE idempotency_key = ?', [idempotencyKey]); if (d) return { refund: d, duplicate: true }; }
    const o = await getOrder(orderId);
    if (o.status !== 'paid') throw conflict('คืนเงินได้เฉพาะบิลที่ชำระแล้ว');
    const rows = await db.all('SELECT * FROM order_items WHERE order_id = ?', [orderId]);
    const picked = [];
    for (const it of items || []) {
      const row = rows.find((x) => x.id === it.item_id);
      const q = Math.floor(Number(it.qty));
      if (!row || !(q > 0)) throw bad('รายการคืนไม่ถูกต้อง');
      const left = row.qty - row.void_qty - row.refunded_qty;
      if (q > left) throw bad(`คืน ${row.name} ได้ไม่เกิน ${left}`);
      row.refunded_qty += q;
      picked.push({ item_id: row.id, name: row.name, qty: q, unit: row.unit_price + row.options_price, cost: row.cost_unit * q, row });
    }
    if (!picked.length) throw bad('กรุณาเลือกรายการที่คืน');
    // discount is shared proportionally between refunded and kept items
    const gross = picked.reduce((s, p) => s + p.unit * p.qty, 0);
    const ratio = o.items_total ? gross / o.items_total : 0;
    let amount = Math.round(gross - o.discount * ratio);
    const s = await getSettings();
    if (!s.sale.tax_inclusive && s.sale.tax_rate) amount += Math.round(amount * s.sale.tax_rate / 100);
    amount = Math.min(amount, o.total - o.refunded_amount);
    const after = computeTotals(rows.map((i) => ({ ...i, options: J(i.options, []), void_qty: i.void_qty + i.refunded_qty })), s.sale);
    const bowls = Math.max(0, (o.bowls - o.refunded_bowls) - after.bowls);
    const cost = picked.reduce((a, p) => a + p.cost, 0);
    for (const p of picked) await db.run('UPDATE order_items SET refunded_qty = refunded_qty + ? WHERE id = ?', [p.qty, p.item_id]);
    await db.run('UPDATE orders SET refunded_amount = refunded_amount + ?, refunded_bowls = refunded_bowls + ?, refunded_cost = refunded_cost + ?, version = version + 1 WHERE id = ?',
      [amount, bowls, cost, orderId]);
    if (restock) await stockForItems(picked.map((p) => ({ ...p.row, qty: p.qty, void_qty: 0 })), 1, 'refund', o.bill_no, staff.id);
    const rid = id();
    await db.run('INSERT INTO refunds(id, order_id, kind, items, amount, bowls, cost, reason, staff_id, shift_id, method, created_at, business_date, idempotency_key) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      [rid, orderId, 'refund', S(picked.map(({ row, ...p }) => p)), amount, bowls, cost, reason, staff.id, await currentShiftId(terminalId), method || await refundMethod(orderId), now(), await businessDateOf(), idempotencyKey || null]);
    const updated = await getOrder(orderId);
    await reverseForRefund(updated, rid, picked, staff.id);
    if (o.member_id) await db.run('UPDATE members SET total_spent = total_spent - ?, tier_score = tier_score - ? WHERE id = ?', [amount, amount, o.member_id]);
    await audit(staff.id, 'refund', 'order', orderId, { refunded_amount: o.refunded_amount }, { refunded_amount: o.refunded_amount + amount, items: picked.map((p) => ({ name: p.name, qty: p.qty })) }, reason);
    const doc = await orderDocData(updated, { ticket_kind: 'ใบคืนเงิน', reason, refund_amount: (amount / 100).toFixed(2), staff: staff.name,
      items: picked.map((p) => ({ name: p.name, qty: p.qty, options: J(p.row.options, []), line_total: p.unit * p.qty })) });
    await enqueue('refund', rid, doc, { dedupe: 'refund:' + rid });
    return { refund: await db.get('SELECT * FROM refunds WHERE id = ?', [rid]), amount, bowls };
  });
  emit('admin', 'sales:changed', { id: orderId });
  emit('shop', 'orders:changed', { id: orderId });
  return r;
}

export async function freeTableIfIdle(tableId) {
  const open = await db.get("SELECT COUNT(*) AS n FROM orders WHERE table_id = ? AND status IN ('held','open','pending_payment')", [tableId]);
  if (!Number(open.n)) await db.run("UPDATE dining_tables SET status = 'free' WHERE id = ? AND status = 'occupied'", [tableId]);
}

// Expire unpaid "pay at cashier" orders
export async function expireUnpaid() {
  const rows = await db.all("SELECT id FROM orders WHERE status = 'pending_payment' AND expires_at IS NOT NULL AND expires_at < ?", [now()]);
  for (const r of rows) {
    const ch = await db.run("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'pending_payment'", [now(), r.id]);
    if (ch.changes) {
      const o = await getOrder(r.id);
      const sent = (await db.all('SELECT * FROM order_items WHERE order_id = ? AND sent_qty > 0', [r.id])).map((i) => ({ ...i, options: J(i.options, []), qty: i.sent_qty }));
      if (sent.length) await kitchenTickets(o, sent, 'void', null);
      emit('shop', 'orders:changed', { id: r.id, status: 'expired' });
      if (o.mobile_session_id) emit('mobile:' + o.mobile_session_id, 'order:status', { id: o.id, status: 'expired' });
    }
  }
}
export { addMinutes };
