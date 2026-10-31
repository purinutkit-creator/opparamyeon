// LINE Official Account (Messaging API) for stock: low-stock cards with buttons (add stock / put on the shopping list),
// the shopping list, a summary when a shift closes, and a rich menu. Channel secret/token live in the secrets table only.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { id, now, getSettings, setSetting, getSecret, businessDateOf } from './util.js';

const API = () => process.env.LINE_API_BASE || 'https://api.line.me';
const DATA_API = () => process.env.LINE_DATA_API_BASE || process.env.LINE_API_BASE || 'https://api-data.line.me';
const BASE = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
export const LINE_DEFAULTS = { enabled: false, notify_low: true, notify_close: true, recipients: [] };
export async function lineCfg() { return { ...LINE_DEFAULTS, ...((await getSettings()).line || {}) }; }
// keys typed in the shop website win; otherwise the server's environment (LINE_CHANNEL_SECRET / LINE_CHANNEL_ACCESS_TOKEN on Render)
export const lineSecret = async () => (await getSecret('line.channel_secret')) || process.env.LINE_CHANNEL_SECRET || null;
export const lineToken = async () => (await getSecret('line.channel_token')) || process.env.LINE_CHANNEL_ACCESS_TOKEN || null;
const token = lineToken;

async function call(path, body, { method = 'POST', data = false, raw = null, type = 'application/json' } = {}) {
  const t = await token();
  if (!t) throw new Error('ยังไม่ได้ใส่ Channel access token ของ LINE');
  const r = await fetch((data ? DATA_API() : API()) + path, { method, headers: { Authorization: 'Bearer ' + t, ...(raw || body ? { 'Content-Type': type } : {}) }, body: raw || (body ? JSON.stringify(body) : undefined) });
  const txt = await r.text();
  if (!r.ok) throw new Error(`LINE ${r.status}: ${txt.slice(0, 200)}`);
  try { return txt ? JSON.parse(txt) : {}; } catch { return {}; }
}
export const lineReply = (replyToken, messages) => call('/v2/bot/message/reply', { replyToken, messages: [].concat(messages).slice(0, 5) });
export const linePush = (to, messages) => call('/v2/bot/message/push', { to, messages: [].concat(messages).slice(0, 5) });
// to everyone linked (owner / manager / the shop group); failures are logged, never thrown into a sale
export async function lineToAll(messages) {
  const c = await lineCfg();
  if (!c.enabled || !(await token())) return 0;
  let n = 0;
  for (const r of c.recipients || []) { try { await linePush(r.id, messages); n++; } catch (e) { console.warn('[line]', e.message); } }
  return n;
}
export async function verifyLineSignature(raw, sig) {
  const secret = await lineSecret();
  if (!secret || !sig) return false;
  const want = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('base64'));
  const got = Buffer.from(String(sig));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

// ---------- data ----------
const num = (v) => Math.round(Number(v || 0) * 100) / 100;
const abs = (u) => (!u ? '' : /^https:/.test(u) ? u : BASE().startsWith('https:') ? BASE() + u : '');
export async function lowItems() {
  const p = (await db.all('SELECT id, name, unit, stock, low_stock, image FROM products WHERE active = 1 AND track_stock = 1 AND stock <= low_stock ORDER BY stock')).map((x) => ({ ...x, type: 'product' }));
  const i = (await db.all('SELECT id, name, unit, stock, low_stock FROM ingredients WHERE stock <= low_stock ORDER BY stock')).map((x) => ({ ...x, type: 'ingredient' }));
  return [...p, ...i];
}
export async function itemOf(type, itemId) {
  const t = type === 'ingredient' ? 'ingredients' : 'products';
  const x = await db.get(`SELECT id, name, unit, stock, low_stock${t === 'products' ? ', image' : ''} FROM ${t} WHERE id = ?`, [itemId]);
  return x ? { ...x, type: type === 'ingredient' ? 'ingredient' : 'product' } : null;
}
export const openList = () => db.all("SELECT * FROM shopping_list WHERE status = 'open' ORDER BY created_at");
// add to the shopping list (one open line per item; adding again raises the quantity)
export async function addToList({ type, itemId, name, qty, unit = '', note = '', by = '' }) {
  const ex = itemId ? await db.get("SELECT id, qty FROM shopping_list WHERE item_type = ? AND item_id = ? AND status = 'open'", [type, itemId]) : null;
  if (ex) { if (qty) await db.run('UPDATE shopping_list SET qty = ? WHERE id = ?', [Math.max(Number(ex.qty) || 0, Number(qty)), ex.id]); return ex.id; }
  const lid = id();
  await db.run('INSERT INTO shopping_list(id, item_type, item_id, name, qty, unit, note, status, added_by, created_at) VALUES(?,?,?,?,?,?,?,?,?,?)', [lid, type || 'other', itemId || null, name, Number(qty) || 1, unit, note, 'open', by, now()]);
  return lid;
}
// how many to buy by default: back up to twice the low-stock level
export const suggestQty = (x) => Math.max(1, Math.ceil(Number(x.low_stock || 0) * 2 - Number(x.stock || 0)));

// ---------- messages (Flex) ----------
const BRAND = '#E23A1F';
const pb = (label, data, style = 'primary', color = BRAND) => ({ type: 'button', style, color: style === 'primary' ? color : undefined, height: 'sm', action: { type: 'postback', label: label.slice(0, 20), data, displayText: label } });
function itemBubble(x) {
  const out = Number(x.stock) <= 0;
  const img = abs(x.image);
  return {
    type: 'bubble', size: 'kilo',
    ...(img ? { hero: { type: 'image', url: img, size: 'full', aspectRatio: '20:13', aspectMode: 'cover' } } : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      { type: 'text', text: out ? '⛔ หมดแล้ว' : '⚠️ ใกล้หมด', size: 'xs', weight: 'bold', color: out ? '#B91C1C' : '#B45309' },
      { type: 'text', text: x.name, weight: 'bold', size: 'lg', wrap: true },
      { type: 'box', layout: 'baseline', contents: [{ type: 'text', text: 'คงเหลือ', size: 'sm', color: '#888888', flex: 0 },
        { type: 'text', text: `${num(x.stock)} ${x.unit || ''}`, size: 'xl', weight: 'bold', color: out ? '#B91C1C' : BRAND, align: 'end' }] },
      { type: 'text', text: `แจ้งเตือนเมื่อเหลือ ≤ ${num(x.low_stock)}`, size: 'xs', color: '#999999' }] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      pb('➕ เพิ่มสต็อก', `a=add&t=${x.type}&i=${x.id}`),
      pb('🛒 ใส่รายการที่ต้องซื้อ', `a=buy&t=${x.type}&i=${x.id}`, 'secondary')] },
  };
}
export function lowStockMessage(items, title = 'สินค้าใกล้หมด') {
  if (!items.length) return { type: 'text', text: '✅ ตอนนี้ไม่มีสินค้า/วัตถุดิบใกล้หมด' };
  return { type: 'flex', altText: `${title}: ${items.slice(0, 3).map((x) => `${x.name} เหลือ ${num(x.stock)}`).join(', ')}`, contents: { type: 'carousel', contents: items.slice(0, 10).map(itemBubble) } };
}
export function listMessage(list, low = [], { title = '🛒 รายการที่ต้องซื้อ', sub = '' } = {}) {
  const notListed = low.filter((x) => !list.some((l) => l.item_type === x.type && l.item_id === x.id));
  const rows = list.slice(0, 12).map((l) => ({ type: 'box', layout: 'horizontal', spacing: 'sm', alignItems: 'center', contents: [
    { type: 'text', text: l.name, size: 'sm', wrap: true, flex: 5 },
    { type: 'text', text: `${num(l.qty)} ${l.unit || ''}`, size: 'sm', weight: 'bold', align: 'end', flex: 2 },
    { type: 'button', style: 'link', height: 'sm', flex: 2, action: { type: 'postback', label: 'ซื้อแล้ว', data: `a=bought&l=${l.id}`, displayText: `ซื้อ ${l.name} แล้ว` } }] }));
  return { type: 'flex', altText: `${title} ${list.length} รายการ`, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: BRAND, contents: [{ type: 'text', text: title, color: '#FFFFFF', weight: 'bold', size: 'lg' }, ...(sub ? [{ type: 'text', text: sub, color: '#FFE4DC', size: 'xs', wrap: true }] : [])] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      ...(rows.length ? rows : [{ type: 'text', text: 'ยังไม่มีของในรายการ', color: '#888888', size: 'sm' }]),
      ...(notListed.length ? [{ type: 'separator' }, { type: 'text', text: `⚠️ ใกล้หมดแต่ยังไม่อยู่ในรายการ: ${notListed.slice(0, 6).map((x) => x.name).join(', ')}${notListed.length > 6 ? ' …' : ''}`, size: 'xs', color: '#B45309', wrap: true }] : [])] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      ...(notListed.length ? [pb(`➕ ใส่ของใกล้หมดทั้งหมด (${notListed.length})`, 'a=buyall')] : []),
      pb('📦 ดูของใกล้หมด', 'a=low', 'secondary')] } } };
}

// ---------- low-stock alerts: once per item per day, gathered for a few seconds into one carousel ----------
const sentToday = new Map(); let pending = new Map(), timer = null;
export function notifyLow(type, itemId) {
  (async () => {
    const c = await lineCfg();
    if (!c.enabled || !c.notify_low || !(c.recipients || []).length) return;
    const day = await businessDateOf();
    const key = `${type}:${itemId}`;
    if (sentToday.get(key) === day) return;
    sentToday.set(key, day);
    pending.set(key, { type, itemId });
    clearTimeout(timer);
    timer = setTimeout(flushLow, Number(process.env.LINE_BATCH_MS || 8000));
  })().catch((e) => console.warn('[line]', e.message));
}
export async function flushLow() {
  const batch = [...pending.values()]; pending = new Map();
  const items = (await Promise.all(batch.map((b) => itemOf(b.type, b.itemId)))).filter((x) => x && Number(x.stock) <= Number(x.low_stock));
  if (items.length) await lineToAll(lowStockMessage(items));
}
// shift closed: what is running low and what to buy
export async function notifyShiftClose(summary) {
  const c = await lineCfg();
  if (!c.enabled || !c.notify_close) return 0;
  const low = await lowItems(), list = await openList();
  if (!low.length && !list.length) return lineToAll({ type: 'text', text: `✅ ปิดรอบแล้ว (${summary.terminal_name || ''}) — ไม่มีของใกล้หมด ไม่มีของต้องซื้อ` });
  return lineToAll(listMessage(list, low, { title: '🛒 ปิดรอบแล้ว · ของที่ต้องซื้อ', sub: `${summary.terminal_name || ''} · ใกล้หมด ${low.length} รายการ · ในรายการซื้อ ${list.length}` }));
}

// ---------- rich menu (image drawn in the shop website) ----------
export async function setupRichMenu(imageBuf, mime) {
  const W = 2500, H = 843, w = Math.round(W / 3);
  const stockUrl = BASE() ? BASE() + '/admin/#/stock' : 'https://line.me';
  const menu = await call('/v2/bot/richmenu', { size: { width: W, height: H }, selected: true, name: 'Oppa stock', chatBarText: '📦 สต็อก',
    areas: [
      { bounds: { x: 0, y: 0, width: w, height: H }, action: { type: 'postback', data: 'a=low', displayText: 'ดูของใกล้หมด' } },
      { bounds: { x: w, y: 0, width: w, height: H }, action: { type: 'postback', data: 'a=list', displayText: 'รายการที่ต้องซื้อ' } },
      { bounds: { x: w * 2, y: 0, width: W - w * 2, height: H }, action: { type: 'uri', uri: stockUrl } }] });
  await call(`/v2/bot/richmenu/${menu.richMenuId}/content`, null, { data: true, raw: imageBuf, type: mime });
  await call(`/v2/bot/user/all/richmenu/${menu.richMenuId}`, null);
  return menu.richMenuId;
}

// ---------- linking a chat (owner 1:1 or the shop group) with a one-time code shown in the shop website ----------
export async function newLinkCode() {
  const code = String(crypto.randomInt(100000, 999999));
  const c = await lineCfg();
  await setSetting('line', { ...c, link_code: code, link_until: Date.now() + 10 * 60e3 });
  return code;
}
export async function tryLink(text, source) {
  const c = await lineCfg();
  const m = /(\d{6})/.exec(String(text || ''));
  if (!m || !c.link_code || m[1] !== c.link_code || Date.now() > Number(c.link_until || 0)) return null;
  const rid = source.groupId || source.roomId || source.userId;
  let name = source.groupId ? 'กลุ่ม LINE' : 'ผู้ใช้ LINE';
  try { if (!source.groupId && source.userId) name = (await call(`/v2/bot/profile/${source.userId}`, null, { method: 'GET' })).displayName || name; } catch { /* name is optional */ }
  const recipients = (c.recipients || []).filter((r) => r.id !== rid).concat([{ id: rid, type: source.groupId ? 'group' : source.roomId ? 'room' : 'user', name, at: now() }]);
  await setSetting('line', { ...c, recipients, link_code: '', link_until: 0, enabled: true });
  return name;
}
export async function isRecipient(source) {
  const c = await lineCfg();
  const ids = new Set((c.recipients || []).map((r) => r.id));
  return ids.has(source.groupId) || ids.has(source.roomId) || ids.has(source.userId);
}
