// LINE stock management: the webhook (button presses, linking a chat) and the shop website's settings + shopping list.
import express, { Router } from 'express';
import { db } from '../db.js';
import { ah, now, bad, notFound, audit, setSecret, setSetting } from '../lib/util.js';
import { staffAuth } from '../lib/auth.js';
import { adjustStock } from '../lib/stock.js';
import { decodeImage, readBarcode, similarProducts, aiMatch } from '../lib/imgmatch.js';
import { addPickerMessage, addedMessage } from '../lib/line.js';
import { lineContent, lineLoading, findProducts, stockCard, candidatesMessage, lineSecret, lineToken, verifyLineSignature, lineReply, lineCfg, lowItems, itemOf, openList, addToList, suggestQty, lowStockMessage, listMessage, tryLink, recipientOf, newLinkCode, setupRichMenus, linkMenus, lineToAll, roleOf, reportMessage, liveUrl } from '../lib/line.js';
import { summary } from './reports.js';
import { businessDateOf, getSettings } from '../lib/util.js';

// today's sales for the owner's chat (button "ยอดขาย · Live View" or typing "ยอด")
async function salesReport(rec) {
  const day = await businessDateOf();
  const s = await getSettings();
  const names = Object.fromEntries((s.sale.payment_methods || []).map((m) => [m.id, m.name]));
  const sum = await summary(day, day, {}, { withCost: true });
  sum.payments = sum.payments.map((p) => ({ ...p, name: names[p.method] || p.method }));
  const recent = await db.all('SELECT bill_no, queue_no, total, paid_at FROM orders WHERE paid_business_date = ? AND paid_at IS NOT NULL ORDER BY paid_at DESC LIMIT 5', [day]);
  return reportMessage(sum, { recent, live: rec ? await liveUrl(rec.id) : '', store: s.store.name });
}
const OWNER_ONLY = { type: 'text', text: '🔒 ยอดขายและรายงานดูได้เฉพาะเจ้าของร้าน\n\nพนักงานใช้ได้: ดูของใกล้หมด · เติมสต็อก · รายการที่ต้องซื้อ · เช็กสต็อกจากรูป/บาร์โค้ด' };

const num = (v) => Math.round(Number(v || 0) * 100) / 100;
export const lineWebhook = Router();
lineWebhook.post('/line/webhook', express.raw({ type: '*/*', limit: '1mb' }), ah(async (req, res) => {
  const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
  if (!(await verifyLineSignature(raw, req.headers['x-line-signature']))) return res.status(401).json({ error: 'bad signature' });
  let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }
  res.json({ ok: true }); // LINE wants a quick 200; replies go out with the reply token
  for (const ev of body.events || []) await handle(ev).catch((e) => console.warn('[line webhook]', e.message));
}));

async function handle(ev) {
  const src = ev.source || {}, rt = ev.replyToken;
  if (ev.type === 'message' && ev.message && ev.message.type === 'text') {
    const linked = await tryLink(ev.message.text, src);
    if (linked) return lineReply(rt, { type: 'text', text: linked.role === 'owner'
      ? `✅ เชื่อมต่อแล้ว (${linked.name}) · สิทธิ์: เจ้าของร้าน 👑\nจะได้รับ: ใบเสร็จทุกบิล (ถ้าเปิดไว้) · ของใกล้หมด · สรุปตอนปิดรอบ\nกดเมนูด้านล่าง หรือพิมพ์ "ยอด" ดูยอดขายวันนี้ · "สต็อก" · "ซื้อ"`
      : `✅ เชื่อมต่อแล้ว (${linked.name}) · สิทธิ์: พนักงาน\nใช้ได้: ดูของใกล้หมด · เติมสต็อก · รายการที่ต้องซื้อ\nกดเมนูด้านล่าง หรือพิมพ์ "สต็อก" / "ซื้อ"` });
    const rec = await recipientOf(src);
    if (!rec) return;
    const t = ev.message.text.trim();
    if (/^(ยอด|ยอดขาย|รายงาน|sales|report)/i.test(t)) return lineReply(rt, roleOf(rec) === 'owner' ? await salesReport(rec) : OWNER_ONLY);
    // a number typed right after "เติมสต็อก" = how many to add
    const pend = waiting.get(chatOf(src));
    if (pend && pend.until > Date.now() && /^\d{1,4}(\.\d+)?$/.test(t) && Number(t) > 0) { waiting.delete(chatOf(src)); return addNow(rt, pend.type, pend.id, Number(t), src); }
    // a barcode number / product code / name → that product's stock
    const found = /^\d{4,}$/.test(t) || !/^(สต็อก|stock|ใกล้หมด|ซื้อ|list|รายการ)/i.test(t) ? await findProducts(t) : [];
    if (found.length === 1) return lineReply(rt, stockCard(found[0], `ค้นจาก "${t}"`));
    if (found.length > 1) return lineReply(rt, candidatesMessage(found, `ค้น "${t}"`));
    if (/สต็อก|stock|ใกล้หมด/i.test(t)) return lineReply(rt, lowStockMessage(await lowItems()));
    if (/ซื้อ|list|รายการ/i.test(t)) return lineReply(rt, listMessage(await openList(), await lowItems()));
    return lineReply(rt, { type: 'text', text: `ไม่พบสินค้า "${t}"\n\nเช็กสต็อกได้โดย:\n📷 ส่งรูปบาร์โค้ด หรือรูปสินค้า\n🔢 พิมพ์เลขบาร์โค้ด / รหัสสินค้า\n🔤 พิมพ์ชื่อสินค้า\n📦 พิมพ์ "สต็อก" ดูของใกล้หมด · "ซื้อ" ดูรายการที่ต้องซื้อ` });
  }
  // a photo: barcode in it → that product; otherwise AI (if the shop set a key) or the closest product pictures
  if (ev.type === 'message' && ev.message && ev.message.type === 'image') {
    if (!(await recipientOf(src))) return;
    if (src.userId && !src.groupId) lineLoading(src.userId);
    const { buf, mime } = await lineContent(ev.message.id);
    const img = decodeImage(buf, mime);
    const code = img ? readBarcode(img) : null;
    if (code) {
      const f = await findProducts(code);
      if (f.length) return lineReply(rt, stockCard(f[0], `บาร์โค้ด ${code}`));
      return lineReply(rt, { type: 'text', text: `อ่านบาร์โค้ดได้: ${code}\nแต่ยังไม่มีสินค้านี้ในร้าน — เพิ่มได้ที่ จัดการร้าน → ผู้ช่วยเพิ่มสินค้า` });
    }
    const ai = await aiMatch(buf, mime).catch(() => null);
    if (ai && ai.product && ai.confidence >= 0.6) return lineReply(rt, stockCard(await itemOf('product', ai.product.id), `🤖 จากรูป · มั่นใจ ${Math.round(ai.confidence * 100)}%`));
    const near = img ? (await similarProducts(img, 3)).filter((c) => c.score >= 0.55) : [];
    if (near.length) return lineReply(rt, [{ type: 'text', text: 'ไม่เห็นบาร์โค้ดในรูป — สินค้าที่หน้าตาคล้ายที่สุด 👇 กด "ใช่ตัวนี้" เพื่อดูสต็อก' }, candidatesMessage(await Promise.all(near.map(async (c) => ({ ...(await itemOf('product', c.id)), score: c.score }))), 'คล้ายกับ')]);
    return lineReply(rt, { type: 'text', text: 'ไม่พบสินค้าที่ตรงกับรูปนี้ 🙏\n\nลองใหม่:\n📷 ถ่ายบาร์โค้ดให้ชัด เต็มเฟรม ไม่เบลอ\n🔢 หรือพิมพ์เลขบาร์โค้ด / ชื่อสินค้า' });
  }
  if (ev.type !== 'postback') return;
  const rec = await recipientOf(src);
  if (!rec) return;
  const p = new URLSearchParams(ev.postback.data || '');
  const a = p.get('a'), who = 'line:' + (src.userId || src.groupId || '');
  if (a === 'report') return lineReply(rt, roleOf(rec) === 'owner' ? await salesReport(rec) : OWNER_ONLY);
  if (a === 'low') return lineReply(rt, lowStockMessage(await lowItems()));
  if (a === 'show') { const x = await itemOf(p.get('t'), p.get('i')); return x ? lineReply(rt, stockCard(x)) : null; }
  if (a === 'list') return lineReply(rt, listMessage(await openList(), await lowItems()));
  if (a === 'add') { // how much to add: 1–100 to swipe through, or type a number within 5 minutes
    const x = await itemOf(p.get('t'), p.get('i')); if (!x) return;
    waiting.set(chatOf(src), { type: x.type, id: x.id, until: Date.now() + 5 * 60e3 });
    return lineReply(rt, addPickerMessage(x));
  }
  if (a === 'addq') { waiting.delete(chatOf(src)); return addNow(rt, p.get('t'), p.get('i'), Number(p.get('q')), src); }
  if (a === 'buy') {
    const x = await itemOf(p.get('t'), p.get('i')); if (!x) return;
    await addToList({ type: x.type, itemId: x.id, name: x.name, qty: suggestQty(x), unit: x.unit || '', by: who });
    return lineReply(rt, [{ type: 'text', text: `🛒 ใส่รายการที่ต้องซื้อแล้ว\n${x.name}  ×${suggestQty(x)} ${x.unit || ''}` }, listMessage(await openList(), await lowItems())]);
  }
  if (a === 'buyall') {
    const list = await openList();
    for (const x of await lowItems()) if (!list.some((l) => l.item_type === x.type && l.item_id === x.id)) await addToList({ type: x.type, itemId: x.id, name: x.name, qty: suggestQty(x), unit: x.unit || '', by: who });
    return lineReply(rt, listMessage(await openList(), await lowItems()));
  }
  if (a === 'bought') { // bought: off the list, and offer to put it into stock
    const l = await db.get("SELECT * FROM shopping_list WHERE id = ? AND status = 'open'", [p.get('l')]); if (!l) return lineReply(rt, { type: 'text', text: 'รายการนี้ซื้อแล้ว' });
    await db.run("UPDATE shopping_list SET status = 'bought', done_at = ? WHERE id = ?", [now(), l.id]);
    return lineReply(rt, { type: 'text', text: `✓ ซื้อแล้ว: ${l.name} ${num(l.qty)} ${l.unit || ''}${l.item_id ? '\n\n👇 เติมเข้าสต็อกเลยไหม?' : ''}`,
      ...(l.item_id ? { quickReply: { items: [{ type: 'action', action: { type: 'postback', label: `เติม +${num(l.qty)}`, data: `a=addq&t=${l.item_type}&i=${l.item_id}&q=${num(l.qty)}`, displayText: `เติม ${l.name} +${num(l.qty)}` } },
        { type: 'action', action: { type: 'postback', label: 'ยังไม่เติม', data: 'a=list', displayText: 'ดูรายการที่ต้องซื้อ' } }] } } : {}) });
  }
}

// "เติมสต็อก" pressed, waiting for a typed number (per chat, 5 minutes)
const waiting = new Map();
const chatOf = (src) => src.groupId || src.roomId || src.userId;
async function addNow(rt, type, itemId, q, src) {
  if (!(q > 0 && q <= 9999)) return lineReply(rt, { type: 'text', text: 'จำนวนต้องอยู่ระหว่าง 1–9999' });
  const before = await itemOf(type, itemId); if (!before) return;
  const x = await adjustStock({ type, id: itemId, qty: q, mode: 'add', note: 'เติมผ่าน LINE', track: true, actor: 'line:' + (src.userId || src.groupId || '') });
  return lineReply(rt, addedMessage(x, q, before.stock));
}

const r = Router();
// live sales page opened from an owner's LINE rich menu: no login, the signed link of a chat that is still an owner
r.get('/public/live/:token', ah(async (req, res) => {
  const { liveFromToken } = await import('../lib/billlink.js');
  const rid = await liveFromToken(req.params.token);
  const c = await lineCfg();
  const rec = rid && (c.recipients || []).find((x) => x.id === rid);
  if (!rec || roleOf(rec) !== 'owner') return res.status(403).json({ error: 'ลิงก์นี้ใช้ไม่ได้แล้ว — เปิดใหม่จากเมนูใน LINE ของเจ้าของร้าน', code: 'revoked' });
  const day = await businessDateOf();
  const s = await getSettings();
  const names = Object.fromEntries((s.sale.payment_methods || []).map((m) => [m.id, m.name]));
  const sum = await summary(day, day, {}, { withCost: true });
  sum.payments = sum.payments.map((p) => ({ ...p, name: names[p.method] || p.method }));
  const recent = await db.all(`SELECT o.bill_no, o.queue_no, o.total, o.paid_at, o.dine_type, o.source, o.status, st.name AS staff FROM orders o LEFT JOIN staff st ON st.id = o.staff_id
    WHERE o.paid_business_date = ? AND o.paid_at IS NOT NULL ORDER BY o.paid_at DESC LIMIT 15`, [day]);
  const byHour = {};
  for (const x of await db.all('SELECT paid_at, total FROM orders WHERE paid_business_date = ? AND paid_at IS NOT NULL', [day])) {
    const k = new Date(x.paid_at).toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' }); byHour[k] = (byHour[k] || 0) + Number(x.total);
  }
  const top = await db.all(`SELECT i.name, SUM(i.qty - i.void_qty - i.refunded_qty) AS qty, SUM(i.line_total) AS amount FROM order_items i JOIN orders o ON o.id = i.order_id
    WHERE o.paid_business_date = ? AND o.status = 'paid' GROUP BY i.name ORDER BY qty DESC LIMIT 5`, [day]);
  const open = await db.get("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders WHERE status IN ('open','pending_payment')");
  res.set('Cache-Control', 'no-store');
  res.json({ store: s.store.name, viewer: rec.name, business_date: day, ...sum, recent, by_hour: byHour, top: top.map((x) => ({ name: x.name, qty: Number(x.qty), amount: Number(x.amount) })),
    open_bills: { count: Number(open.n), amount: Number(open.amount) } });
}));
// settings page: secrets are write-only (never returned), recipients linked with a one-time code
r.get('/line/settings', staffAuth('settings'), ah(async (req, res) => {
  const c = await lineCfg();
  const base = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
  const sec = await lineSecret(), tok = await lineToken();
  const hint = (v) => (v ? '…' + v.slice(-4) : '');
  res.json({ enabled: c.enabled, notify_low: c.notify_low, notify_close: c.notify_close, notify_sale: !!c.notify_sale, to: c.to, recipients: (c.recipients || []).map((x) => ({ ...x, role: roleOf(x) })),
    richmenus: c.richmenus || null, public_https: base.startsWith('https:'), webhook_url: base + '/api/line/webhook',
    has_secret: !!sec, has_token: !!tok, secret_hint: hint(sec), token_hint: hint(tok), bot: c.bot || null });
}));
r.put('/line/settings', staffAuth('settings'), ah(async (req, res) => {
  const b = req.body || {};
  const secret = String(b.channel_secret || '').trim(), tok = String(b.channel_token || '').trim();
  // easy mix-ups: the 10-digit Channel ID, or the token in the secret box
  if (secret && !/^[0-9a-f]{32}$/i.test(secret)) throw bad(/^\d{8,12}$/.test(secret) ? 'นี่คือ Channel ID — ช่องนี้ต้องใส่ Channel secret (ตัวอักษร/ตัวเลข 32 ตัว อยู่ในแท็บ Basic settings)' : 'Channel secret ต้องเป็นตัวอักษร a-f และตัวเลข 32 ตัว (แท็บ Basic settings)');
  if (tok && tok.length < 100) throw bad('Channel access token สั้นเกินไป — กด Issue ที่แท็บ Messaging API แล้วคัดลอกมาทั้งหมด (ยาวประมาณ 170 ตัว)');
  let bot = null;
  if (tok) { // check the token with LINE before keeping it
    const r2 = await fetch((process.env.LINE_API_BASE || 'https://api.line.me') + '/v2/bot/info', { headers: { Authorization: 'Bearer ' + tok } }).catch(() => null);
    if (!r2) throw bad('ติดต่อ LINE ไม่ได้ตอนนี้ — ลองกดบันทึกอีกครั้ง');
    if (!r2.ok) throw bad('LINE ไม่รับ Channel access token นี้ — ตรวจว่าคัดลอกมาครบ และเป็น token ของ Channel ที่ถูกต้อง');
    const j = await r2.json().catch(() => ({}));
    bot = { name: j.displayName || '', basic_id: j.basicId || '', picture: j.pictureUrl || '' };
    await setSecret('line.channel_token', tok);
  }
  if (secret) await setSecret('line.channel_secret', secret);
  const c = await lineCfg();
  // recipients kept (by id) with their role: owner = everything, staff = stock only
  const roles = b.roles && typeof b.roles === 'object' ? b.roles : {};
  const recipients = (Array.isArray(b.recipients) ? (c.recipients || []).filter((x) => b.recipients.includes(x.id)) : (c.recipients || []))
    .map((x) => ({ ...x, role: roles[x.id] === 'staff' ? 'staff' : roles[x.id] === 'owner' ? 'owner' : roleOf(x) }));
  const pick = (v, d) => (Array.isArray(v) ? ['owner', 'staff'].filter((r) => v.includes(r)) : d);
  const to = { low: pick(b.to && b.to.low, (c.to || {}).low || ['owner', 'staff']), close: pick(b.to && b.to.close, (c.to || {}).close || ['owner', 'staff']) };
  const next = { ...c, enabled: !!b.enabled, notify_low: !!b.notify_low, notify_close: !!b.notify_close, notify_sale: b.notify_sale === undefined ? !!c.notify_sale : !!b.notify_sale, to, recipients, ...(bot ? { bot } : {}) };
  await setSetting('line', next);
  const changedRole = recipients.some((x) => { const old = (c.recipients || []).find((y) => y.id === x.id); return old && roleOf(old) !== x.role; });
  if (changedRole && (await lineToken())) linkMenus(next).catch(() => {});
  await audit(req.staff.id, 'settings', 'settings', 'line', null, { enabled: !!b.enabled, secret_changed: !!b.channel_secret, token_changed: !!b.channel_token });
  res.json({ ok: true });
}));
r.post('/line/link-code', staffAuth('settings'), ah(async (req, res) => res.json({ code: await newLinkCode((req.body || {}).role) })));
r.post('/line/test', staffAuth('settings'), ah(async (req, res) => {
  const n = await lineToAll([{ type: 'text', text: '🔔 ทดสอบจากระบบ POS — ข้อความนี้แปลว่าการแจ้งเตือนสต็อกทาง LINE ใช้งานได้' }, lowStockMessage(await lowItems())]);
  if (!n) throw bad('ส่งไม่ได้ — ตรวจ token, เปิดใช้งาน และเชื่อมต่อแชตอย่างน้อย 1 แชต');
  res.json({ sent: n });
}));
const img = (v, label) => {
  const m = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=]+)$/.exec(String(v || ''));
  if (!m) throw bad('รูปริชเมนู' + label + 'ไม่ถูกต้อง');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 1024 * 1024) throw bad('รูปริชเมนู' + label + 'ต้องไม่เกิน 1MB');
  return { buf, mime: m[1] };
};
r.post('/line/richmenu', staffAuth('settings'), ah(async (req, res) => {
  const b = req.body || {};
  const ids = await setupRichMenus(img(b.image, 'พนักงาน'), b.owner_image ? img(b.owner_image, 'เจ้าของ') : null);
  res.json({ id: ids.staff, ...ids });
}));
// shopping list (also on the stock page)
r.get('/shopping', staffAuth(), ah(async (req, res) => res.json({ open: await openList(), bought: await db.all("SELECT * FROM shopping_list WHERE status = 'bought' ORDER BY done_at DESC LIMIT 30"), low: await lowItems() })));
r.post('/shopping', staffAuth('manage_stock'), ah(async (req, res) => {
  const b = req.body || {};
  let name = String(b.name || '').trim(), unit = b.unit || '';
  if (b.item_id) { const x = await itemOf(b.item_type, b.item_id); if (!x) throw notFound(); name = x.name; unit = x.unit || ''; }
  if (!name) throw bad('ใส่ชื่อของที่ต้องซื้อ');
  res.json({ id: await addToList({ type: b.item_id ? b.item_type : 'other', itemId: b.item_id || null, name, qty: Number(b.qty) || 1, unit, note: b.note || '', by: req.staff.id }) });
}));
r.put('/shopping/:id', staffAuth('manage_stock'), ah(async (req, res) => {
  const l = await db.get('SELECT * FROM shopping_list WHERE id = ?', [req.params.id]); if (!l) throw notFound();
  const b = req.body || {};
  if (b.qty !== undefined) await db.run('UPDATE shopping_list SET qty = ? WHERE id = ?', [Math.max(0, Number(b.qty) || 0), l.id]);
  if (b.status === 'bought' || b.status === 'open') await db.run('UPDATE shopping_list SET status = ?, done_at = ? WHERE id = ?', [b.status, b.status === 'bought' ? now() : null, l.id]);
  // bought + restock: the quantity goes into stock
  if (b.restock && l.item_id) await adjustStock({ type: l.item_type, id: l.item_id, qty: Number(b.qty ?? l.qty), mode: 'add', note: 'ซื้อตามรายการ', actor: req.staff.id });
  res.json({ ok: true });
}));
r.delete('/shopping/:id', staffAuth('manage_stock'), ah(async (req, res) => { await db.run('DELETE FROM shopping_list WHERE id = ?', [req.params.id]); res.json({ ok: true }); }));
export default r;
