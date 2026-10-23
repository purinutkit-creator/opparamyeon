import { makeApi, socket, uid } from '/shared/api.js';
import { h, $, toast, errToast, modal, PREP_TH, STATUS_TH } from '/shared/ui.js';
import { baht, computeTotals, countBowls, lineTotal, optionsKey, VERSION } from '/shared/core.js';
import { applyFonts } from '/shared/fonts.js';

const token = location.hash.slice(1);
const api = makeApi({ tokenKey: '__none', extraHeaders: () => ({ 'X-Mobile-Token': token }) });
const app = $('#app');
const ss = { get: (k, d) => { try { return JSON.parse(sessionStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } } };
let info, menu, settings, cat = 'all', view = 'menu';
let cart = ss.get('m_cart_' + token, []);
let checkout = ss.get('m_checkout_' + token, { mode: null, table_id: null, customer_name: '', customer_phone: '', note: '', pay_mode: 'cashier' });
const saveCart = () => { ss.set('m_cart_' + token, cart); ss.set('m_checkout_' + token, checkout); drawBar(); };

async function boot() {
  if (!token) return app.replaceChildren(h('div', { class: 'empty' }, 'กรุณาสแกน QR จากร้านเพื่อสั่งอาหาร'));
  settings = await fetch('/api/settings/public').then((r) => r.json());
  applyFonts(settings.fonts, 'mobile');
  try { info = await api.get('/m/session'); } catch (e) { return app.replaceChildren(h('div', { class: 'empty' }, '⚠️ ', e.message)); }
  if (info.session.can_order) menu = await api.get('/m/menu');
  if (!checkout.mode) checkout.mode = info.session.mode === 'table' ? 'table' : info.options.has_tables && info.options.table_enabled && info.options.any_table_free ? null : 'pickup';
  if (info.session.mode === 'table') checkout.table_id = info.session.table_id;
  const sock = await socket({ kind: 'mobile', token });
  sock.on('order:status', async (e) => { info = await api.get('/m/session'); if (e.message) toast(e.message, 'warn', 8000); if (view === 'orders') drawOrders(); });
  sock.on('session:closed', async () => { info = await api.get('/m/session'); toast('รอบการสั่งอาหารนี้ปิดแล้ว', 'warn'); render(); });
  sock.on('catalog:changed', async () => { if (info.session.can_order) { menu = await api.get('/m/menu'); if (view === 'menu') drawMenu(); } });
  view = info.session.can_order ? 'menu' : 'orders';
  render();
}
function render() {
  app.replaceChildren(h('header', { class: 'h' }, info.store.logo ? h('img', { src: info.store.logo, alt: '' }) : h('span', { style: { fontSize: '2em' } }, '🍜'),
    h('div', { style: { flex: 1 } }, h('strong', {}, info.store.name), h('div', { class: 'small muted' }, info.session.mode === 'table' ? `โต๊ะ ${(info.tables.find((t) => t.id === info.session.table_id) || {}).name || ''}` : 'Pick Up', ' · ', info.session.ref)),
    info.orders.length ? h('button', { class: 'btn sm', onclick: () => { view = view === 'orders' ? 'menu' : 'orders'; render(); } }, view === 'orders' ? 'เมนู' : `ออเดอร์ (${info.orders.length})`) : null),
  h('div', { id: 'body' }), h('div', { class: 'bar', id: 'bar' }));
  if (!info.session.can_order && view === 'menu') view = 'orders';
  if (view === 'menu') drawMenu(); else if (view === 'cart') drawCart(); else drawOrders();
  drawBar();
}
function drawBar() {
  const bar = $('#bar'); if (!bar) return;
  if (view !== 'menu' || !cart.length) { bar.replaceChildren(); bar.style.display = 'none'; return; }
  bar.style.display = '';
  const t = totals();
  bar.replaceChildren(h('button', { class: 'btn primary big block', onclick: () => { view = 'cart'; render(); } }, `ดูตะกร้า ${cart.reduce((s, l) => s + l.qty, 0)} รายการ · ${t.bowls} ชาม · ${baht(t.total)} ฿`));
}
const totals = () => computeTotals(cart.map((l) => ({ ...l, cost_unit: 0, dine_type: checkout.mode === 'table' ? 'dine_in' : 'takeaway' })), settings.sale);

function drawMenu() {
  const b = $('#body');
  const prods = menu.products.filter((p) => cat === 'all' || p.category_id === cat);
  b.replaceChildren(h('div', { class: 'cats' }, h('div', { class: 'tabs' }, [{ id: 'all', name: 'ทั้งหมด' }, ...menu.categories].map((c) => h('button', { class: 'tab' + (cat === c.id ? ' active' : ''), onclick: () => { cat = c.id; drawMenu(); } }, c.name)))),
    h('div', { class: 'list' }, prods.map((p) => h('button', { class: 'p' + (p.sold_out ? ' out' : ''), onclick: () => (p.sold_out ? toast('สินค้าหมด', 'warn') : pick(p)) },
      h('div', { class: 'im', style: p.image ? { backgroundImage: `url(${p.image})` } : {} }, p.image ? '' : '🍜'),
      h('div', {}, h('strong', {}, p.name), p.description ? h('div', { class: 'small muted' }, p.description) : null, h('div', { style: { color: 'var(--brand)', fontWeight: 800, marginTop: '.3em' } }, baht(p.price), ' ฿'),
        p.sold_out ? h('span', { class: 'badge bad' }, 'หมด') : null)))));
}
function pick(p) {
  const groups = p.option_groups.map((g) => menu.option_groups.find((x) => x.id === g)).filter(Boolean);
  const chosen = new Map(groups.map((g) => [g.id, new Set(g.min_select && g.options[0] ? [g.options[0].id] : [])]));
  let qty = 1;
  const note = h('input', { class: 'input', placeholder: 'หมายเหตุถึงครัว' });
  const body = h('div');
  const draw = () => {
    const unit = p.price + groups.reduce((s, g) => s + g.options.filter((o) => chosen.get(g.id).has(o.id)).reduce((a, o) => a + o.price, 0), 0);
    body.replaceChildren(p.image ? h('img', { src: p.image, style: { width: '100%', borderRadius: '12px' } }) : null, p.description ? h('p', { class: 'muted' }, p.description) : null,
      ...groups.map((g) => h('div', { class: 'opt-group', style: { marginBottom: '1em' } }, h('h4', {}, g.name, g.min_select ? h('span', { class: 'badge warn' }, ' ต้องเลือก') : null),
        h('div', { class: 'opts' }, g.options.map((o) => h('button', { class: 'opt' + (chosen.get(g.id).has(o.id) ? ' on' : ''), onclick: () => {
          const s = chosen.get(g.id);
          if (s.has(o.id)) { if (!(g.min_select && s.size <= g.min_select)) s.delete(o.id); } else { if (g.max_select === 1) s.clear(); if (!g.max_select || s.size < g.max_select) s.add(o.id); }
          draw();
        } }, o.name, o.price ? ` +${baht(o.price)}` : ''))))),
      h('label', { class: 'field' }, 'หมายเหตุ', note),
      h('div', { class: 'row between' }, h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { qty = Math.max(1, qty - 1); draw(); } }, '−'), h('strong', { style: { fontSize: '1.4em' } }, qty), h('button', { class: 'btn', onclick: () => { qty++; draw(); } }, '+')),
        h('strong', { style: { fontSize: '1.4em' } }, baht(unit * qty), ' ฿')));
  };
  draw();
  modal(p.name, body, { actions: [{ label: 'เพิ่มลงตะกร้า', class: 'primary big', onClick: () => {
    for (const g of groups) if (chosen.get(g.id).size < g.min_select) { toast('กรุณาเลือก ' + g.name, 'warn'); return false; }
    const options = groups.flatMap((g) => g.options.filter((o) => chosen.get(g.id).has(o.id)).map((o) => ({ group_id: g.id, group: g.name, id: o.id, name: o.name, price: o.price })));
    const same = cart.find((l) => l.product_id === p.id && optionsKey(l.options) === optionsKey(options) && !l.note && !note.value);
    if (same) same.qty += qty; else cart.push({ key: uid(), product_id: p.id, name: p.name, qty, unit_price: p.price, options, note: note.value, bowl_count: p.bowl_count });
    saveCart(); toast('เพิ่ม ' + p.name, 'ok', 1200);
  } }] });
}

function drawCart() {
  const b = $('#body');
  const t = totals();
  const o = info.options;
  const tables = info.tables;
  const name = h('input', { class: 'input', value: checkout.customer_name, placeholder: 'ชื่อผู้รับ' });
  const phone = h('input', { class: 'input', value: checkout.customer_phone, inputmode: 'tel', placeholder: o.pickup_phone_required ? 'เบอร์ติดต่อ (จำเป็น)' : 'เบอร์ติดต่อ (ไม่บังคับ)' });
  const note = h('input', { class: 'input', value: checkout.note, placeholder: 'หมายเหตุออเดอร์' });
  [name, phone, note].forEach((el, i) => el.addEventListener('input', () => { checkout[['customer_name', 'customer_phone', 'note'][i]] = el.value; saveCart(); }));
  const tableLocked = info.session.mode === 'table' && !info.session.allow_table_change;
  const modeBox = h('div', { class: 'card' },
    h('h3', {}, 'รับอาหารแบบไหน'),
    info.session.mode === 'table' ? h('p', {}, '🍽️ ทานที่ร้าน · โต๊ะ ', h('strong', {}, (tables.find((x) => x.id === checkout.table_id) || {}).name || '')) : h('div', { class: 'row' },
      o.table_enabled && o.has_tables ? h('button', { class: 'btn' + (checkout.mode === 'table' ? ' primary' : ''), onclick: () => { checkout.mode = 'table'; saveCart(); drawCart(); } }, '🍽️ ทานที่ร้าน') : null,
      o.pickup_enabled ? h('button', { class: 'btn' + (checkout.mode === 'pickup' ? ' primary' : ''), onclick: () => { checkout.mode = 'pickup'; saveCart(); drawCart(); } }, '🥡 Pick Up') : null),
    !o.has_tables && info.session.mode !== 'table' ? h('p', { class: 'small muted' }, 'ร้านนี้รับออเดอร์แบบ Pick Up') : null,
    checkout.mode === 'table' && !tableLocked ? (tables.some((x) => x.available) ? h('div', { class: 'row' }, tables.filter((x) => x.available).map((x) => h('button', { class: 'btn' + (checkout.table_id === x.id ? ' primary' : ''), onclick: () => { checkout.table_id = x.id; saveCart(); drawCart(); } }, x.name)))
      : h('p', { class: 'badge warn' }, 'ขณะนี้ไม่มีโต๊ะว่างให้เลือก กรุณาเลือก Pick Up')) : null,
    checkout.mode === 'pickup' ? h('div', {}, h('label', { class: 'field' }, 'ชื่อผู้รับ *', name), h('label', { class: 'field' }, 'เบอร์ติดต่อ', phone)) : null);
  const payBox = h('div', { class: 'card' }, h('h3', {}, 'ชำระเงิน'), h('div', { class: 'row' },
    o.pay_cashier ? h('button', { class: 'btn' + (checkout.pay_mode === 'cashier' ? ' primary' : ''), onclick: () => { checkout.pay_mode = 'cashier'; saveCart(); drawCart(); } }, '💵 ชำระที่แคชเชียร์') : null,
    o.pay_online ? h('button', { class: 'btn' + (checkout.pay_mode === 'online' ? ' primary' : ''), onclick: () => { checkout.pay_mode = 'online'; saveCart(); drawCart(); } }, '📲 ชำระออนไลน์') : null));
  b.replaceChildren(h('div', { class: 'section' },
    h('button', { class: 'btn sm', onclick: () => { view = 'menu'; render(); } }, '← เลือกเมนูเพิ่ม'),
    h('h2', { style: { marginTop: '.6em' } }, 'ตะกร้า'),
    h('div', { class: 'card' }, cart.length ? cart.map((l) => h('div', { class: 'row between', style: { padding: '.4em 0', borderBottom: '1px dashed var(--line)' } },
      h('div', { style: { flex: 1 } }, h('strong', {}, l.name), h('div', { class: 'small muted' }, l.options.map((x) => x.name).join(', '), l.note ? ' · ' + l.note : '')),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { l.qty--; if (l.qty <= 0) cart = cart.filter((x) => x !== l); saveCart(); drawCart(); } }, '−'), h('strong', {}, l.qty),
        h('button', { class: 'btn sm', onclick: () => { l.qty++; saveCart(); drawCart(); } }, '+')), h('strong', { style: { minWidth: '70px', textAlign: 'right' } }, baht(lineTotal(l)))))
      : h('div', { class: 'empty' }, 'ตะกร้าว่าง'),
    h('div', { class: 'row between', style: { marginTop: '.6em' } }, h('span', {}, `จำนวนชาม ${t.bowls}`), h('strong', { style: { fontSize: '1.4em' } }, 'รวม ', baht(t.total), ' ฿')),
    t.packaging ? h('div', { class: 'small muted' }, `รวมค่าบรรจุภัณฑ์ ${baht(t.packaging)}`) : null),
    modeBox, payBox, h('label', { class: 'field', style: { marginTop: '.6em' } }, 'หมายเหตุออเดอร์', note),
    h('p', { class: 'small muted' }, 'ยอดเงินสุดท้ายคำนวณโดยร้านจากราคาปัจจุบัน'),
    h('button', { class: 'btn primary big block', disabled: !cart.length, onclick: submit }, 'ยืนยันสั่งอาหาร')));
}
async function submit(e) {
  const btn = e.currentTarget;
  if (!checkout.mode) return toast('เลือกทานที่ร้านหรือ Pick Up', 'warn');
  if (checkout.mode === 'pickup' && !checkout.customer_name.trim()) return toast('กรุณากรอกชื่อผู้รับ', 'warn');
  // same key until success: double taps and network retries never create a second order
  if (!checkout.idem) { checkout.idem = uid(); saveCart(); }
  btn.disabled = true; btn.textContent = 'กำลังส่ง…';
  try {
    const r = await api.post('/m/orders', { idempotency_key: checkout.idem, mode: checkout.mode, table_id: checkout.table_id, customer_name: checkout.customer_name, customer_phone: checkout.customer_phone,
      note: checkout.note, pay_mode: checkout.pay_mode, expected_total: totals().total,
      lines: cart.map((l) => ({ product_id: l.product_id, qty: l.qty, options: l.options.map((o) => ({ group_id: o.group_id, id: o.id })), note: l.note })) });
    cart = []; checkout.idem = null; saveCart();
    info = await api.get('/m/session');
    view = 'orders'; render();
    toast('ส่งออเดอร์แล้ว', 'ok');
    if (checkout.pay_mode === 'online') payOnline(r.id);
  } catch (er) {
    errToast(er);
    if (er.code !== 'offline') { checkout.idem = null; saveCart(); }
    btn.disabled = false; btn.textContent = 'ยืนยันสั่งอาหาร';
  }
}
async function drawOrders() {
  const b = $('#body'); if (!b) return;
  const full = await Promise.all(info.orders.map((o) => api.get('/m/orders/' + o.id).catch(() => o)));
  const steps = ['none', 'received', 'cooking', 'ready', 'done'];
  b.replaceChildren(h('div', { class: 'section' },
    !info.session.can_order ? h('div', { class: 'card', style: { background: 'var(--warn-soft)' } }, info.session.status === 'active' ? 'QR นี้ใช้ส่งออเดอร์ได้ครั้งเดียว — ดูสถานะออเดอร์ได้ด้านล่าง' : info.session.status === 'expired' ? 'QR หมดอายุแล้ว' : 'รอบการสั่งอาหารนี้ปิดแล้ว', ' — สั่งเพิ่มกรุณาติดต่อพนักงาน')
      : h('button', { class: 'btn block', onclick: () => { view = 'menu'; render(); } }, '+ สั่งเพิ่ม'),
    ...full.reverse().map((o) => h('div', { class: 'card', style: { marginTop: '.8em' } },
      h('div', { class: 'row between' }, h('div', {}, h('div', { class: 'small muted' }, 'เลขออเดอร์ ', o.bill_no), h('div', { style: { fontSize: '2.4em', fontWeight: 800, color: 'var(--brand)' } }, o.queue_no ? 'คิว ' + o.queue_no : 'รอเลขคิว')),
        h('span', { class: 'badge ' + (o.status === 'paid' ? 'ok' : o.status === 'pending_payment' ? 'warn' : 'bad') }, o.status === 'pending_payment' ? (o.pay_mode === 'cashier' ? 'รอชำระที่แคชเชียร์' : o.verify_status === 'pending' ? 'รอร้านตรวจสอบการโอน' : 'รอชำระ') : STATUS_TH[o.status])),
      o.status !== 'void' && o.status !== 'expired' ? h('div', { class: 'steps' }, steps.map((s, i) => h('span', { class: steps.indexOf(o.prep_status) >= i && (o.prep_status !== 'none' || i === 0) ? 'on' : '' }, PREP_TH[s]))) : null,
      h('div', { class: 'small' }, (o.items || []).map((i) => `${i.qty}× ${i.name}`).join(', ')),
      h('div', { class: 'row between' }, h('span', {}, `${o.bowls} ชาม`), h('strong', {}, baht(o.total), ' ฿')),
      o.status === 'pending_payment' && o.pay_mode === 'online' ? h('button', { class: 'btn primary block', onclick: () => payOnline(o.id) }, 'ชำระเงินออนไลน์') : null,
      o.status === 'pending_payment' && o.verify_status === 'rejected' ? h('p', { class: 'badge bad' }, 'การโอนยังไม่ผ่านการตรวจสอบ กรุณาติดต่อพนักงาน') : null,
      o.status === 'pending_payment' && o.expires_at ? h('p', { class: 'small muted' }, 'ยกเลิกอัตโนมัติหากไม่ชำระภายใน ', new Date(o.expires_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })) : null)),
    h('p', { class: 'version', style: { textAlign: 'center' } }, 'v' + VERSION)));
}
async function payOnline(orderId) {
  const o = info.options;
  const body = h('div');
  if (o.promptpay) {
    try {
      const pp = await api.get(`/m/orders/${orderId}/promptpay`);
      const file = h('input', { type: 'file', accept: 'image/*' });
      body.append(h('div', { style: { textAlign: 'center' } }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(pp.payload), style: { width: '240px', background: '#fff', padding: '8px', borderRadius: '12px' } }),
        h('p', {}, 'ผู้รับเงิน: ', h('strong', {}, pp.name || '-')), h('p', { style: { fontSize: '1.4em', fontWeight: 800 } }, baht(pp.amount), ' บาท'), h('p', { class: 'small muted' }, 'อ้างอิง ', pp.ref, ' · ', pp.note)),
      o.slip_upload ? h('label', { class: 'field' }, 'แนบสลิปการโอน (ร้านจะตรวจสอบก่อนยืนยัน)', file) : null,
      o.slip_upload ? h('button', { class: 'btn primary block', onclick: async () => {
        if (!file.files[0]) return toast('เลือกรูปสลิป', 'warn');
        const fd = new FormData(); fd.append('file', file.files[0]);
        try { const r = await api.post(`/m/orders/${orderId}/slip`, fd); toast(r.message, 'ok'); info = await api.get('/m/session'); drawOrders(); } catch (e) { errToast(e); }
      } }, 'ส่งสลิปให้ร้านตรวจสอบ') : null);
    } catch (e) { body.append(h('p', {}, e.message)); }
  }
  if (o.gateway) body.append(h('hr'), h('button', { class: 'btn ok big block', onclick: async () => { try { const r = await api.post(`/m/orders/${orderId}/gateway`); location.href = r.url; } catch (e) { errToast(e); } } }, 'จ่ายด้วยบัตร/QR ผ่านระบบชำระเงินออนไลน์'));
  modal('ชำระเงินออนไลน์', body);
}
boot().catch((e) => app.replaceChildren(h('div', { class: 'empty' }, e.message)));
