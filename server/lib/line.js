// LINE Official Account (Messaging API) for stock: low-stock cards with buttons (add stock / put on the shopping list),
// the shopping list, a summary when a shift closes, and a rich menu. Channel secret/token live in the secrets table only.
import crypto from 'node:crypto';
import { db } from '../db.js';
import { id, now, getSettings, setSetting, getSecret, businessDateOf } from './util.js';

const API = () => process.env.LINE_API_BASE || 'https://api.line.me';
const DATA_API = () => process.env.LINE_DATA_API_BASE || process.env.LINE_API_BASE || 'https://api-data.line.me';
const BASE = () => process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
// recipients: { id, type, name, role: 'owner' | 'staff' } — owners get everything, staff only stock (no sales figures)
// to: which roles get each alert · sale receipts and sales reports go to owners only
export const LINE_DEFAULTS = { enabled: false, notify_low: true, notify_close: true, notify_sale: false, recipients: [], to: { low: ['owner', 'staff'], close: ['owner', 'staff'] } };
export const roleOf = (r) => (r && r.role === 'staff' ? 'staff' : 'owner');
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
// a photo the chat sent (binary) · the "…" typing animation while a photo is being looked at (1:1 chats only)
export async function lineContent(messageId) {
  const r = await fetch(`${DATA_API()}/v2/bot/message/${encodeURIComponent(messageId)}/content`, { headers: { Authorization: 'Bearer ' + await token() } });
  if (!r.ok) throw new Error('LINE content ' + r.status);
  return { buf: Buffer.from(await r.arrayBuffer()), mime: r.headers.get('content-type') || '' };
}
export const lineLoading = (chatId) => call('/v2/bot/chat/loading/start', { chatId, loadingSeconds: 20 }).catch(() => {});
export const linePush = (to, messages) => call('/v2/bot/message/push', { to, messages: [].concat(messages).slice(0, 5) });
// to everyone linked (owner / manager / the shop group); failures are logged, never thrown into a sale
export async function lineToAll(messages) {
  const c = await lineCfg();
  if (!c.enabled || !(await token())) return 0;
  let n = 0;
  for (const r of c.recipients || []) { try { await linePush(r.id, messages); n++; } catch (e) { console.warn('[line]', e.message); } }
  return n;
}
// to the chats whose role gets this kind of message
export async function lineTo(kind, messages) {
  const c = await lineCfg();
  if (!c.enabled || !(await token())) return 0;
  const roles = kind === 'sale' || kind === 'report' ? ['owner'] : ((c.to || {})[kind] || ['owner', 'staff']);
  let n = 0;
  for (const r of (c.recipients || []).filter((x) => roles.includes(roleOf(x)))) { try { await linePush(r.id, messages); n++; } catch (e) { console.warn('[line]', e.message); } }
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
  const x = await db.get(`SELECT id, name, unit, stock, low_stock${t === 'products' ? ', image, code, track_stock' : ''} FROM ${t} WHERE id = ?`, [itemId]);
  return x ? { ...x, type: type === 'ingredient' ? 'ingredient' : 'product', track_stock: t === 'ingredients' ? 1 : x.track_stock } : null;
}
// a typed barcode / product code / name → products (exact code first, then names that contain it)
export async function findProducts(q) {
  const s = String(q || '').trim();
  if (!s) return [];
  const b = await db.get('SELECT product_id FROM barcodes WHERE code = ?', [s]);
  const exact = await db.get('SELECT id FROM products WHERE active = 1 AND (id = ? OR code = ?)', [b ? b.product_id : '__', s]);
  if (exact) return [await itemOf('product', exact.id)];
  const like = await db.all("SELECT id FROM products WHERE active = 1 AND LOWER(name) LIKE ? ORDER BY name LIMIT 6", ['%' + s.toLowerCase() + '%']);
  const ing = await db.all("SELECT id FROM ingredients WHERE LOWER(name) LIKE ? ORDER BY name LIMIT 3", ['%' + s.toLowerCase() + '%']);
  return [...await Promise.all(like.map((x) => itemOf('product', x.id))), ...await Promise.all(ing.map((x) => itemOf('ingredient', x.id)))];
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
const pb = (label, data, style = 'primary', color = BRAND) => ({ type: 'button', style, ...(style === 'primary' ? { color } : {}), height: 'md', action: { type: 'postback', label: label.slice(0, 20), data, displayText: label } });
// Cards are laid out top-to-bottom (nothing side by side), so names and numbers are never cut off on a phone.
const RED = '#C81E1E', ORANGE = '#D97706', GREEN = '#15803D', GREY = '#6B7280';
const txt = (text, o = {}) => ({ type: 'text', text: String(text), wrap: true, ...o });
const bar = (stock, low) => { // how full: up to twice the low-stock level = full
  const full = Math.max(1, Number(low || 0) * 2), pct = Math.max(3, Math.min(100, Math.round(Number(stock) / full * 100)));
  return { type: 'box', layout: 'vertical', height: '10px', cornerRadius: '6px', backgroundColor: '#EEEEEE', margin: 'md',
    contents: [{ type: 'box', layout: 'vertical', width: pct + '%', height: '10px', cornerRadius: '6px', backgroundColor: Number(stock) <= 0 ? RED : ORANGE, contents: [] }] };
};
function itemBubble(x, note = '') {
  const counted = x.track_stock !== 0 && x.track_stock !== false;
  const out = counted && Number(x.stock) <= 0, low = counted && Number(x.stock) <= Number(x.low_stock || 0);
  const img = abs(x.image);
  const head = !counted ? ['📦 ยังไม่ได้นับสต็อก', GREY] : out ? ['⛔ หมดแล้ว', RED] : low ? ['⚠️ ใกล้หมด', ORANGE] : ['✅ มีของ', GREEN];
  return {
    type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: head[1],
      contents: [txt(head[0], { color: '#FFFFFF', weight: 'bold', size: 'lg' }), ...(note ? [txt(note, { color: '#FFFFFF', size: 'sm' })] : [])] },
    ...(img ? { hero: { type: 'image', url: img, size: 'full', aspectRatio: '20:11', aspectMode: 'cover' } } : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '18px', contents: [
      txt(x.name, { weight: 'bold', size: 'xl' }),
      txt('เหลืออยู่', { size: 'sm', color: GREY, margin: 'lg' }),
      txt(counted ? `${num(x.stock)} ${x.unit || ''}` : '—', { size: '4xl', weight: 'bold', color: out ? RED : low ? ORANGE : counted ? GREEN : GREY }),
      bar(x.stock, x.low_stock),
      txt(`แจ้งเตือนเมื่อเหลือ ${num(x.low_stock)} ${x.unit || ''} หรือน้อยกว่า`, { size: 'sm', color: GREY, margin: 'md' })] },
    footer: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px', contents: [
      pb('➕ เติมสต็อก', `a=add&t=${x.type}&i=${x.id}`),
      pb('🛒 ต้องซื้อเพิ่ม', `a=buy&t=${x.type}&i=${x.id}`, 'secondary')] },
  };
}
// first card of the carousel: every item and its number in one list
// how many to add: 1–100 on cards of ten you swipe through (or type any number)
export function addPickerMessage(x) {
  const cell = (n) => ({ type: 'box', layout: 'vertical', flex: 1, height: '52px', justifyContent: 'center', cornerRadius: '12px', backgroundColor: '#FFF1EC',
    action: { type: 'postback', label: '+' + n, data: `a=addq&t=${x.type}&i=${x.id}&q=${n}`, displayText: `เติม ${x.name} +${n}` },
    contents: [txt('+' + n, { align: 'center', weight: 'bold', size: 'lg', color: BRAND })] });
  const page = (from) => ({ type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: BRAND, contents: [txt(`➕ ${x.name}`, { color: '#FFFFFF', weight: 'bold', size: 'md' }), txt(`ตอนนี้มี ${num(x.stock)} ${x.unit || ''} · เลือก ${from}–${from + 9}`, { color: '#FFE4DC', size: 'xs' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '12px', contents: [0, 5].map((o) => ({ type: 'box', layout: 'horizontal', spacing: 'sm', contents: [0, 1, 2, 3, 4].map((c) => cell(from + o + c)) })) },
    footer: { type: 'box', layout: 'vertical', paddingAll: '10px', contents: [txt(from < 91 ? 'เลื่อน ← → ดูเลขอื่น · หรือพิมพ์ตัวเลขเอง' : 'หรือพิมพ์ตัวเลขเองในแชต', { size: 'xs', color: GREY, align: 'center' })] } });
  return [{ type: 'text', text: `➕ เติมสต็อก "${x.name}"\nตอนนี้มี ${num(x.stock)} ${x.unit || ''}\n\n👉 กดจำนวนในการ์ดด้านล่าง (เลื่อนดูได้ 1–100)\n⌨️ หรือพิมพ์ตัวเลขส่งมาเลย เช่น 36` },
    { type: 'flex', altText: `เลือกจำนวนที่จะเติม ${x.name}`, contents: { type: 'carousel', contents: [1, 11, 21, 31, 41, 51, 61, 71, 81, 91].map(page) } }];
}
// done: before → after, big
export function addedMessage(x, q, before) {
  return { type: 'flex', altText: `เติม ${x.name} +${q} แล้ว ตอนนี้มี ${num(x.stock)} ${x.unit || ''}`, contents: { type: 'bubble', size: 'kilo',
    header: { type: 'box', layout: 'vertical', paddingAll: '12px', backgroundColor: GREEN, contents: [txt('✅ เติมสต็อกแล้ว', { color: '#FFFFFF', weight: 'bold', size: 'md' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '16px', contents: [
      txt(x.name, { weight: 'bold', size: 'lg' }),
      txt(`+${num(q)} ${x.unit || ''}`, { size: 'xl', weight: 'bold', color: GREEN }),
      txt(`${num(before)} → ${num(x.stock)} ${x.unit || ''}`, { size: '3xl', weight: 'bold' }),
      txt('ก่อนเติม → หลังเติม', { size: 'xs', color: GREY })] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [pb('➕ เติมอีก', `a=add&t=${x.type}&i=${x.id}`, 'secondary'), pb('📦 ดูของใกล้หมด', 'a=low', 'secondary')] } } };
}
export const stockCard = (x, note = '') => ({ type: 'flex', altText: `${x.name}: เหลือ ${num(x.stock)} ${x.unit || ''}`.slice(0, 380), contents: itemBubble(x, note) });
// several possible matches: small cards, "this one?" opens the full stock card
export function candidatesMessage(list, title) {
  return { type: 'flex', altText: `${title}: ${list.map((c) => c.name).join(', ')}`.slice(0, 380), contents: { type: 'carousel', contents: list.slice(0, 10).map((c) => ({
    type: 'bubble', size: 'kilo',
    ...(abs(c.image) ? { hero: { type: 'image', url: abs(c.image), size: 'full', aspectRatio: '20:13', aspectMode: 'cover' } } : {}),
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [txt(title, { size: 'xs', color: GREY }), txt(c.name, { weight: 'bold', size: 'lg' }),
      ...(c.score !== undefined ? [txt(`คล้าย ${Math.round(c.score * 100)}%`, { size: 'sm', color: GREY })] : [])] },
    footer: { type: 'box', layout: 'vertical', contents: [pb('✓ ใช่ตัวนี้', `a=show&t=${c.type || 'product'}&i=${c.id}`)] } })) } };
}
function summaryBubble(items) {
  return { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: BRAND,
      contents: [txt('📦 ของใกล้หมด', { color: '#FFFFFF', weight: 'bold', size: 'xl' }), txt(`${items.length} รายการ · เลื่อนดูทีละรายการ →`, { color: '#FFE4DC', size: 'sm' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '18px', contents: items.slice(0, 12).flatMap((x, i) => [
      ...(i ? [{ type: 'separator' }] : []),
      txt(x.name, { weight: 'bold', size: 'md' }),
      txt(`${Number(x.stock) <= 0 ? '⛔ หมดแล้ว' : '⚠️ เหลือ'} ${Number(x.stock) <= 0 ? '' : num(x.stock) + ' ' + (x.unit || '')}`.trim(), { size: 'lg', weight: 'bold', color: Number(x.stock) <= 0 ? RED : ORANGE })]) },
    footer: { type: 'box', layout: 'vertical', contents: [pb('🛒 ซื้อทั้งหมดนี้', 'a=buyall')] } };
}
export function lowStockMessage(items, title = 'สินค้าใกล้หมด') {
  if (!items.length) return { type: 'text', text: '✅ ตอนนี้ไม่มีของใกล้หมด' };
  const bubbles = items.length > 1 ? [summaryBubble(items), ...items.slice(0, 9).map(itemBubble)] : [itemBubble(items[0])];
  return { type: 'flex', altText: (`${title}: ${items.slice(0, 3).map((x) => `${x.name} เหลือ ${num(x.stock)}`).join(', ')}${items.length > 3 ? ` และอีก ${items.length - 3} รายการ` : ''}`).slice(0, 380),
    contents: bubbles.length > 1 ? { type: 'carousel', contents: bubbles } : bubbles[0] };
}
// shopping list: one block per item (name, how many to buy, how many are left), then its "bought" button
export function listMessage(list, low = [], { title = '🛒 รายการที่ต้องซื้อ', sub = '' } = {}) {
  const notListed = low.filter((x) => !list.some((l) => l.item_type === x.type && l.item_id === x.id));
  const left = (l) => low.find((x) => x.type === l.item_type && x.id === l.item_id);
  const rows = list.slice(0, 10).flatMap((l, i) => {
    const x = left(l);
    return [
      ...(i ? [{ type: 'separator', margin: 'lg' }] : []),
      { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'lg', contents: [
        txt(`${i + 1}. ${l.name}`, { weight: 'bold', size: 'lg' }),
        txt(`ซื้อ ${num(l.qty)} ${l.unit || ''}`.trim(), { size: 'xl', weight: 'bold', color: BRAND }),
        ...(x ? [txt(`ตอนนี้เหลือ ${num(x.stock)} ${x.unit || ''}`.trim(), { size: 'sm', color: Number(x.stock) <= 0 ? RED : ORANGE })] : []),
        { type: 'button', style: 'secondary', height: 'sm', margin: 'sm', action: { type: 'postback', label: '✓ ซื้อแล้ว', data: `a=bought&l=${l.id}`, displayText: `ซื้อ ${l.name} แล้ว` } }] }];
  });
  return { type: 'flex', altText: `${title}: ${list.length} รายการ${list.length ? ' — ' + list.slice(0, 3).map((l) => `${l.name} ${num(l.qty)}`).join(', ') : ''}`, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', paddingAll: '16px', backgroundColor: BRAND, contents: [txt(title, { color: '#FFFFFF', weight: 'bold', size: 'xl' }), txt(sub || `${list.length} รายการ`, { color: '#FFE4DC', size: 'sm' })] },
    body: { type: 'box', layout: 'vertical', paddingAll: '18px', contents: [
      ...(rows.length ? rows : [txt('ยังไม่มีของที่ต้องซื้อ 👍', { color: GREY, size: 'md' })]),
      ...(list.length > 10 ? [txt(`และอีก ${list.length - 10} รายการ — ดูทั้งหมดที่หน้าสต็อก`, { size: 'sm', color: GREY, margin: 'lg' })] : []),
      ...(notListed.length ? [{ type: 'separator', margin: 'xl' }, txt('⚠️ ใกล้หมดแต่ยังไม่ได้ใส่รายการ', { size: 'md', weight: 'bold', color: ORANGE, margin: 'lg' }),
        ...notListed.slice(0, 6).map((x) => txt(`• ${x.name} — เหลือ ${num(x.stock)} ${x.unit || ''}`.trim(), { size: 'sm', margin: 'sm' }))] : [])] },
    footer: { type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '14px', contents: [
      ...(notListed.length ? [pb(`➕ ใส่ทั้งหมด (${notListed.length})`, 'a=buyall')] : []),
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
  if (items.length) await lineTo('low', lowStockMessage(items));
}
// shift closed: what is running low and what to buy
export async function notifyShiftClose(summary) {
  const c = await lineCfg();
  if (!c.enabled || !c.notify_close) return 0;
  const low = await lowItems(), list = await openList();
  if (!low.length && !list.length) return lineTo('close', { type: 'text', text: `✅ ปิดรอบแล้ว (${summary.terminal_name || ''}) — ไม่มีของใกล้หมด ไม่มีของต้องซื้อ` });
  return lineTo('close', listMessage(list, low, { title: '🛒 ปิดรอบแล้ว · ของที่ต้องซื้อ', sub: `${summary.terminal_name || ''} · ใกล้หมด ${low.length} รายการ · ในรายการซื้อ ${list.length}` }));
}

// ---------- rich menus (pictures drawn in the shop website) ----------
// staff (default for everyone): ของใกล้หมด · รายการที่ต้องซื้อ · หน้าสต็อก
// owners (linked to each owner's own chat): ยอดขาย·Live View · ใกล้หมด · ต้องซื้อ / สต็อก · จัดการร้าน · หลังบ้านสมาชิก
const page = (hash) => (BASE() ? BASE() + '/admin/#/' + hash : 'https://line.me');
export async function setupRichMenus(staffImg, ownerImg) {
  const c = await lineCfg();
  const W = 2500;
  const staff = await call('/v2/bot/richmenu', { size: { width: W, height: 843 }, selected: true, name: 'Oppa stock', chatBarText: '📦 สต็อก',
    areas: [col(0, 0, 843, { type: 'postback', data: 'a=low', displayText: 'ดูของใกล้หมด' }), col(1, 0, 843, { type: 'postback', data: 'a=list', displayText: 'รายการที่ต้องซื้อ' }), col(2, 0, 843, { type: 'uri', uri: page('stock') })] });
  await call(`/v2/bot/richmenu/${staff.richMenuId}/content`, null, { data: true, raw: staffImg.buf, type: staffImg.mime });
  await call(`/v2/bot/user/all/richmenu/${staff.richMenuId}`, null);
  // the owner picture is kept: every owner's chat gets its own copy of the menu (its button opens that owner's live sales link)
  let ownerFile = null;
  if (ownerImg) { const { saveFile } = await import('../routes/system.js'); ownerFile = await saveFile(ownerImg.buf, 'line-owner-menu', ownerImg.mime); }
  const old = c.richmenus || {};
  for (const m of [old.staff, old.owner, ...Object.values(old.per_owner || {})]) if (m) await call(`/v2/bot/richmenu/${m}`, null, { method: 'DELETE' }).catch(() => {});
  const next = { ...(await lineCfg()), richmenus: { staff: staff.richMenuId, owner_file: ownerFile, per_owner: {} } };
  await setSetting('line', next);
  await linkMenus(next);
  return { staff: staff.richMenuId, owner: ownerFile ? 'per-owner' : null };
}
const W3 = Math.round(2500 / 3);
const col = (i, y, h, action) => ({ bounds: { x: W3 * i, y, width: i === 2 ? 2500 - W3 * 2 : W3, height: h }, action });
export const liveUrl = async (recipientId) => { const { liveToken } = await import('./billlink.js'); return BASE().startsWith('https:') ? `${BASE()}/live/#${await liveToken(recipientId)}` : ''; };
async function ownerMenuFor(r, file) {
  const { db: d } = await import('../db.js');
  const f = await d.get('SELECT mime, data, path FROM files WHERE id = ?', [file]);
  if (!f) return null;
  const buf = f.data ? Buffer.from(f.data, 'base64') : (await import('node:fs')).readFileSync(f.path);
  const live = (await liveUrl(r.id)) || page('live');
  const m = await call('/v2/bot/richmenu', { size: { width: 2500, height: 1686 }, selected: true, name: 'Oppa owner', chatBarText: '🏪 เมนูเจ้าของร้าน',
    areas: [col(0, 0, 843, { type: 'uri', uri: live }), col(1, 0, 843, { type: 'postback', data: 'a=low', displayText: 'ดูของใกล้หมด' }),
      col(2, 0, 843, { type: 'postback', data: 'a=list', displayText: 'รายการที่ต้องซื้อ' }),
      col(0, 843, 843, { type: 'uri', uri: page('stock') }), col(1, 843, 843, { type: 'uri', uri: page('menu') }), col(2, 843, 843, { type: 'uri', uri: page('members') })] });
  await call(`/v2/bot/richmenu/${m.richMenuId}/content`, null, { data: true, raw: buf, type: f.mime });
  return m.richMenuId;
}
// rich menus only show in 1:1 chats: each owner's chat gets its own owner menu, staff the default stock menu
export async function linkMenus(c = null) {
  c = c || await lineCfg();
  const rm = { per_owner: {}, ...(c.richmenus || {}) };
  if (!rm.staff && !rm.owner_file) return;
  const per = { ...(rm.per_owner || {}) };
  const owners = new Set((c.recipients || []).filter((x) => x.type === 'user' && roleOf(x) === 'owner').map((x) => x.id));
  for (const r of (c.recipients || []).filter((x) => x.type === 'user')) {
    try {
      if (owners.has(r.id) && rm.owner_file) {
        if (!per[r.id]) per[r.id] = await ownerMenuFor(r, rm.owner_file);
        if (per[r.id]) await call(`/v2/bot/user/${r.id}/richmenu/${per[r.id]}`, null);
      } else await call(`/v2/bot/user/${r.id}/richmenu`, null, { method: 'DELETE' });
    } catch (e) { console.warn('[line menu]', e.message); }
  }
  // chats no longer owners: their own menu goes
  for (const [uid, mid] of Object.entries(per)) if (!owners.has(uid)) { await call(`/v2/bot/richmenu/${mid}`, null, { method: 'DELETE' }).catch(() => {}); delete per[uid]; }
  await setSetting('line', { ...(await lineCfg()), richmenus: { ...rm, per_owner: per } });
}

// ---------- sales: a receipt per bill (owners), today's sales on request ----------
const B = (satang) => (Number(satang || 0) / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tm = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' น.' : '');
const row2 = (l, r, o = {}) => ({ type: 'box', layout: 'horizontal', spacing: 'md', contents: [txt(l, { size: 'sm', color: '#555555', flex: 5, ...o.l }), txt(r, { size: 'sm', align: 'end', flex: 3, ...o.r })] });
export function saleMessage(o, { url = '', qr = '', methods = {}, store = '' } = {}) {
  const items = o.items.filter((i) => i.qty - i.void_qty > 0);
  const shown = items.slice(0, 12);
  const pays = o.payments.filter((p) => p.status === 'paid').map((p) => methods[p.method] || p.method);
  const body = [
    txt(store || 'ขายแล้ว', { size: 'xs', color: '#999999' }),
    { type: 'box', layout: 'horizontal', contents: [txt(`฿${B(o.total)}`, { size: 'xxl', weight: 'bold', color: BRAND, flex: 3 }), txt(o.queue_no ? `คิว ${o.queue_no}` : '', { size: 'md', weight: 'bold', align: 'end', gravity: 'center', flex: 2 })] },
    txt(`บิล ${o.bill_no} · ${tm(o.paid_at || o.created_at)}`, { size: 'sm', color: '#555555' }),
    txt([o.dine_type === 'takeaway' ? 'กลับบ้าน' : o.dine_type === 'mixed' ? 'ทานที่ร้าน+กลับบ้าน' : 'ทานที่ร้าน', o.table_name ? 'โต๊ะ ' + o.table_name : '', o.staff_name ? 'โดย ' + o.staff_name : ''].filter(Boolean).join(' · '), { size: 'xs', color: '#999999' }),
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: shown.map((i) => row2(`${i.qty - i.void_qty}× ${i.name}${(i.options || []).length ? ' (' + i.options.map((x) => x.name).join(', ') + ')' : ''}`, B(i.line_total))) },
    ...(items.length > shown.length ? [txt(`และอีก ${items.length - shown.length} รายการ`, { size: 'xs', color: '#999999' })] : []),
    { type: 'separator', margin: 'md' },
    { type: 'box', layout: 'vertical', spacing: 'xs', margin: 'md', contents: [
      ...(o.discount ? [row2('ส่วนลด', '−' + B(o.discount))] : []), ...(o.packaging ? [row2('ค่าบรรจุภัณฑ์', B(o.packaging))] : []),
      row2('รวม', B(o.total), { l: { weight: 'bold', color: '#111111' }, r: { weight: 'bold' } }), row2('ชำระโดย', pays.join(' + ') || '-')] },
    ...(qr ? [{ type: 'image', url: qr, size: 'md', aspectMode: 'fit', margin: 'lg' }, txt('สแกนดูบิล', { size: 'xxs', color: '#999999', align: 'center' })] : []),
  ];
  return { type: 'flex', altText: `🧾 ${o.bill_no} ฿${B(o.total)} · ${items.length} รายการ`, contents: { type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body },
    ...(url ? { footer: { type: 'box', layout: 'vertical', contents: [{ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '🧾 ดูบิล', uri: url } }] } } : {}) } };
}
export async function notifySale(orderId) {
  const c = await lineCfg();
  if (!c.enabled || !c.notify_sale || !(c.recipients || []).some((r) => roleOf(r) === 'owner')) return 0;
  const { orderFull } = await import('./orders.js');
  const { billToken } = await import('./billlink.js');
  const s = await getSettings();
  const o = await orderFull(orderId);
  if (!o || !o.bill_no) return 0;
  const t = await billToken(o.bill_no);
  const url = abs('/b/#' + t), qr = abs(`/api/public/bill/${encodeURIComponent(t)}/qr.png`);
  return lineTo('sale', saleMessage(o, { url, qr, methods: Object.fromEntries((s.sale.payment_methods || []).map((m) => [m.id, m.name])), store: s.store.name }));
}
export function reportMessage(sum, { recent = [], live = '', store = '' } = {}) {
  const avg = sum.bills_paid ? Math.round(sum.net_sales / sum.bills_paid) : 0;
  const tile = (label, value, color = '#111111') => ({ type: 'box', layout: 'vertical', flex: 1, paddingAll: '8px', backgroundColor: '#F7F3F1', cornerRadius: '10px', contents: [txt(label, { size: 'xxs', color: '#888888' }), txt(value, { size: 'md', weight: 'bold', color })] });
  return { type: 'flex', altText: `📊 ยอดขายวันนี้ ฿${B(sum.net_sales)} · ${sum.bills_paid} บิล`, contents: { type: 'bubble', size: 'mega',
    header: { type: 'box', layout: 'vertical', backgroundColor: BRAND, paddingAll: '16px', contents: [txt('📊 ยอดขายวันนี้', { color: '#FFFFFF', weight: 'bold', size: 'md' }), txt(`${store} · อัปเดต ${tm(sum.generated_at)}`, { color: '#FFE4DE', size: 'xs' })] },
    body: { type: 'box', layout: 'vertical', spacing: 'md', contents: [
      txt(`฿${B(sum.net_sales)}`, { size: '3xl', weight: 'bold', color: BRAND }),
      { type: 'box', layout: 'horizontal', spacing: 'sm', contents: [tile('บิล', String(sum.bills_paid)), tile('เฉลี่ย/บิล', B(avg)), tile('ชาม', String(sum.bowls_net))] },
      ...(sum.gross_profit !== undefined ? [row2('กำไรขั้นต้น', `${B(sum.gross_profit)} (${sum.margin_pct}%)`)] : []),
      ...(sum.discount ? [row2('ส่วนลด', B(sum.discount))] : []),
      ...(sum.voids.count || sum.refunds.count ? [row2('ยกเลิก / คืนเงิน', `${sum.voids.count} / ${sum.refunds.count} (${B(sum.voids.amount + sum.refunds.amount)})`)] : []),
      ...(sum.pending_payment.count ? [row2('⏳ รอชำระ', `${sum.pending_payment.count} บิล ${B(sum.pending_payment.amount)}`, { r: { color: '#B45309' } })] : []),
      ...(sum.payments.length ? [{ type: 'separator' }, txt('แยกตามช่องทาง', { size: 'xs', color: '#888888' }), ...sum.payments.map((p) => row2(p.name || p.method, B(p.net)))] : []),
      ...(recent.length ? [{ type: 'separator' }, txt('บิลล่าสุด', { size: 'xs', color: '#888888' }), ...recent.map((x) => row2(`${x.bill_no}${x.queue_no ? ' · คิว ' + x.queue_no : ''} · ${new Date(x.paid_at).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' })}`, B(x.total)))] : []),
    ] },
    footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
      ...(live ? [{ type: 'button', style: 'primary', color: BRAND, height: 'sm', action: { type: 'uri', label: '🔴 เปิด Live View', uri: live } }] : []),
      { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: '⟳ อัปเดตยอด', data: 'a=report', displayText: 'ยอดขายวันนี้' } }] } } };
}

// ---------- linking a chat (owner 1:1 or the shop group) with a one-time code shown in the shop website ----------
export async function newLinkCode(role = 'owner') {
  const code = String(crypto.randomInt(100000, 999999));
  const c = await lineCfg();
  await setSetting('line', { ...c, link_code: code, link_role: role === 'staff' ? 'staff' : 'owner', link_until: Date.now() + 10 * 60e3 });
  return code;
}
export async function tryLink(text, source) {
  const c = await lineCfg();
  const m = /(\d{6})/.exec(String(text || ''));
  if (!m || !c.link_code || m[1] !== c.link_code || Date.now() > Number(c.link_until || 0)) return null;
  const rid = source.groupId || source.roomId || source.userId;
  let name = source.groupId ? 'กลุ่ม LINE' : 'ผู้ใช้ LINE';
  try { if (!source.groupId && source.userId) name = (await call(`/v2/bot/profile/${source.userId}`, null, { method: 'GET' })).displayName || name; } catch { /* name is optional */ }
  const role = c.link_role === 'staff' ? 'staff' : 'owner';
  const recipients = (c.recipients || []).filter((r) => r.id !== rid).concat([{ id: rid, type: source.groupId ? 'group' : source.roomId ? 'room' : 'user', name, role, at: now() }]);
  const next = { ...c, recipients, link_code: '', link_until: 0, enabled: true };
  await setSetting('line', next);
  linkMenus(next).catch(() => {});
  return { name, role };
}
// the linked chat a message came from (a group's role applies to everyone in that group)
export async function recipientOf(source) {
  const c = await lineCfg();
  const rs = c.recipients || [];
  return rs.find((r) => r.id === (source.groupId || source.roomId)) || (!source.groupId && !source.roomId ? rs.find((r) => r.id === source.userId) : null) || null;
}
export async function isRecipient(source) { return !!(await recipientOf(source)); }
