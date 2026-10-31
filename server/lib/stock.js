// Stock changes made by people (stock page, LINE buttons): add / count, low-stock level, start counting a product.
// Sales and voids move stock in lib/orders.js. Both tell the POS ("stock:changed") and, when an item gets low, LINE.
import { db } from '../db.js';
import { id, now, bad, notFound, emit, audit } from './util.js';
import { notifyLow } from './line.js';

export async function adjustStock({ type, id: itemId, qty, mode, note, low_stock, track, actor }) {
  const table = type === 'ingredient' ? 'ingredients' : 'products';
  const has = qty !== undefined && qty !== null && qty !== '';
  const n = Number(qty);
  if (has && !Number.isFinite(n)) throw bad('จำนวนไม่ถูกต้อง');
  const reason = String(note || '').trim().slice(0, 200) || (mode === 'set' ? 'นับสต็อก' : n >= 0 ? 'รับเข้า' : 'ปรับลด');
  let before, after;
  await db.tx(async () => {
    const cur = await db.get(`SELECT * FROM ${table} WHERE id = ?`, [itemId]);
    if (!cur) throw notFound();
    before = cur;
    if (table === 'products' && track && !cur.track_stock) await db.run('UPDATE products SET track_stock = 1 WHERE id = ?', [itemId]);
    if (low_stock !== undefined && low_stock !== '' && low_stock !== null && Number.isFinite(Number(low_stock))) await db.run(`UPDATE ${table} SET low_stock = ? WHERE id = ?`, [Math.max(0, Number(low_stock)), itemId]);
    if (has) {
      const delta = mode === 'set' ? n - cur.stock : n;
      if (delta) {
        await db.run(`UPDATE ${table} SET stock = stock + ? WHERE id = ?`, [delta, itemId]);
        await db.run('INSERT INTO stock_moves(id, item_type, item_id, qty, reason, ref, staff_id, created_at) VALUES(?,?,?,?,?,?,?,?)', [id(), type, itemId, delta, reason, mode === 'set' ? 'set' : 'add', actor || null, now()]);
        await audit(actor || null, 'stock_adjust', type, itemId, { stock: cur.stock }, { stock: cur.stock + delta }, reason);
      }
    }
    // stock is back: a product someone had marked "หมด" by hand goes back on sale
    if (table === 'products') await db.run('UPDATE products SET sold_out = 0 WHERE id = ? AND sold_out = 1 AND track_stock = 1 AND stock > 0', [itemId]);
    after = await db.get(`SELECT id, name, stock, low_stock, unit FROM ${table} WHERE id = ?`, [itemId]);
  });
  emit('shop', 'stock:changed', { id: itemId, type, stock: after.stock, low_stock: after.low_stock });
  if (Number(after.stock) <= Number(after.low_stock) && Number(before.stock) > Number(after.low_stock)) notifyLow(type, itemId);
  return after;
}
