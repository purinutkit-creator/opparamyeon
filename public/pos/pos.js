import { makeApi, store, socket, uid, storageWarning } from '/shared/api.js';
import { loginHero, h, $, toast, errToast, modal, confirmBox, promptBox, keypad, fmtTime, STATUS_TH, PREP_TH, SOURCE_TH, JOB_TH, debounce } from '/shared/ui.js';
import { baht, toSatang, addToCart, computeTotals, countBowls, dineLabel, lineUnitTotal, lineTotal, orderDineType, promptPayPayload, VERSION, maskPhone, pointsFor } from '/shared/core.js';
import { applyFonts } from '/shared/fonts.js';
import { PrintHost, pairPrinter, unpairPrinter, isLinkedHere, testPrint, support, agentUrl, linkOf } from '/shared/printers.js';
import { playSound, unlock, beep } from '/shared/sound.js';

const api = makeApi({ extraHeaders: () => ({ 'X-Terminal-Id': store.get('terminal_id') || '' }), onUnauthorized: () => { store.del('staff_token'); location.reload(); } });
const app = $('#app');
const st = {
  settings: null, staff: null, terminal: null, shift: null, catalog: null, cat: 'all', q: '',
  cart: null, sock: null, host: null, pending: { mobile: 0, verify: 0 }, bc: null, lastActivity: Date.now(), locked: false,
};
const U = () => (st.settings && st.settings.sale.count_unit) || 'ชาม'; // unit name (ชาม/จาน/ที่…) set by the shop
const can = (p) => st.staff && st.staff.perms.includes(p);
const newCart = () => ({ cart_id: uid(), order_id: null, version: null, lines: [], dine_type: 'dine_in', table_id: null, customer_name: '', note: '', member: null, discount: null, idem: uid() });

// ---------------- boot ----------------
async function boot() {
  st.settings = await fetch('/api/settings/public').then((r) => r.json());
  applyFonts(st.settings.fonts, 'pos');
  document.addEventListener('pointerdown', unlock, { once: true });
  if (!store.get('staff_token')) return loginScreen();
  try { st.staff = (await api.get('/auth/me')).staff; } catch { return loginScreen(); }
  const terms = await api.get('/terminals');
  st.terminal = terms.find((t) => t.id === store.get('terminal_id'));
  if (!st.terminal) return pickTerminal(terms);
  st.shift = await api.get('/shifts/current');
  st.catalog = await api.get('/catalog');
  st.cart = store.get('cart_' + st.terminal.id) || newCart();
  render();
  await connect();
  if (!st.shift) openShiftDialog();
  setupScanner();
  setupAutoLock();
  reportDevice();
}

function loginScreen() {
  const code = h('input', { class: 'input', placeholder: 'รหัสพนักงาน', inputmode: 'numeric', autocomplete: 'username', value: store.get('last_code', '') });
  const pin = h('input', { class: 'input pin', type: 'password', placeholder: 'PIN', inputmode: 'numeric', autocomplete: 'current-password' });
  const go = async () => {
    try {
      const r = await api.post('/auth/login', { code: code.value, pin: pin.value, terminal_id: store.get('terminal_id') }, { token: null });
      store.set('staff_token', r.token); store.set('last_code', code.value);
      location.reload();
    } catch (e) { errToast(e); pin.value = ''; }
  };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.replaceChildren(loginHero('หน้าขาย POS', 'ขายเร็ว ปุ่มใหญ่ สแกนบาร์โค้ด ส่งครัว และรับชำระได้ในที่เดียว', h('div', { class: 'card' },
    h('h2', {}, 'เข้าสู่ระบบ'), h('p', { class: 'muted' }, 'ใช้รหัสพนักงานและ PIN'),
    h('label', { class: 'field' }, 'รหัสพนักงาน', code), h('label', { class: 'field' }, 'PIN', pin),
    keypad(pin, { onEnter: go }),
    h('p', { class: 'version' }, `เวอร์ชัน ${VERSION} · `, h('a', { href: '/guide/' }, 'คู่มือการใช้งาน')))));
  (code.value ? pin : code).focus();
}

async function pickTerminal(terms) {
  app.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'card' },
    h('h2', {}, 'เลือกเครื่องขายนี้'), h('p', { class: 'muted' }, 'เครื่องขายใช้แยกรอบการขาย เลขคิว (ถ้าตั้งแยก) และจอลูกค้า'),
    ...terms.map((t) => h('button', { class: 'btn block big', style: { marginBottom: '.5em' }, onclick: () => { store.set('terminal_id', t.id); location.reload(); } }, t.name)),
    can('settings') && h('button', { class: 'btn ghost block', onclick: async () => {
      const name = await promptBox('สร้างเครื่องขายใหม่', { label: 'ชื่อเครื่อง', value: 'เครื่องขาย ' + (terms.length + 1) });
      if (name) { const t = await api.post('/terminals', { name }); store.set('terminal_id', t.id); location.reload(); }
    } }, '+ สร้างเครื่องขายใหม่'),
    h('button', { class: 'btn ghost block', onclick: logout }, 'ออกจากระบบ'))));
}

async function connect() {
  st.sock = await socket({ kind: 'staff', token: store.get('staff_token'), terminal_id: st.terminal.id });
  const s = st.sock;
  s.on('connect', () => { setNet(true); pushDisplay(); refreshBadges(); });
  s.on('disconnect', () => setNet(false));
  s.on('catalog:changed', async () => { st.catalog = await api.get('/catalog'); renderMenu(); });
  s.on('settings:changed', async () => { st.settings = await fetch('/api/settings/public').then((r) => r.json()); render(); });
  s.on('mobile:new_order', (o) => {
    st.pending.mobile++; renderTop();
    playSound(st.settings.sound, 'new_order', 'pos');
    toast(`📱 ออเดอร์ใหม่ ${o.customer_name || o.table_name || ''} · ${baht(o.total)} บาท · ${o.bowls} ${U()} · ${o.pay_mode === 'cashier' ? 'รอชำระที่แคชเชียร์' : 'ชำระออนไลน์'}`, 'warn', 8000);
  });
  s.on('mobile:slip', (o) => { st.pending.mobile++; renderTop(); playSound(st.settings.sound, 'new_order', 'pos'); toast(`🧾 ลูกค้าส่งสลิปโอนเงิน บิล ${o.bill_no} รอตรวจสอบ`, 'warn', 8000); });
  s.on('mobile:paid', (o) => toast(`✅ รับชำระออนไลน์แล้ว บิล ${o.bill_no}`, 'ok'));
  s.on('payment:alert', (a) => { playSound(st.settings.sound, 'error', 'pos'); toast('⚠️ ' + a.message, 'error', 12000); });
  s.on('verification:new', () => { st.pending.verify++; renderTop(); toast('🔐 สมาชิกขอยืนยันตัวตนที่เคาน์เตอร์', 'warn'); });
  s.on('reset:new', () => toast('มีคำขอรีเซ็ตรหัสผ่านสมาชิกใหม่ (ดูที่เว็บไซต์จัดการร้าน)', 'info'));
  s.on('orders:changed', debounce(refreshBadges, 500));
  s.on('print:status', (j) => { if (j.status === 'failed' || j.status === 'unknown') toast(`พิมพ์ไม่สำเร็จ (${j.doc_type}): ${j.error || ''}`, 'error', 7000); });
  s.on('member:selected', (e) => {
    if (e.cart_id !== st.cart.cart_id) return; // only for the bill that opened the prompt
    st.cart.member = e.member; saveCart(); renderCart();
    toast(`ลูกค้ายืนยันสมาชิก: ${e.member.first_name || ''} ${maskPhone(e.member.phone)}`, 'ok');
    const m = document.querySelector('.member-prompt-wait'); if (m) m.closest('.modal-back').remove();
  });
  s.on('display:paired', () => toast('เชื่อมต่อจอลูกค้าแล้ว', 'ok'));
  st.host = new PrintHost({ api, sock: s, terminalId: st.terminal.id, settings: st.settings, device: 'pos', onChange: () => {} });
  st.host.start().catch(errToast);
  // dual screen on the same device: the customer window listens on this channel too
  try { st.bc = new BroadcastChannel('opp-display-' + st.terminal.id); } catch { /* old browser */ }
}
let online = true;
function setNet(v) { online = v; const el = $('#net'); if (el) { el.className = 'status-dot ' + (v ? 'ok' : 'bad'); el.title = v ? 'ออนไลน์' : 'ออฟไลน์ — ข้อมูลยังไม่อัปเดต'; } }
async function refreshBadges() {
  try {
    const pend = await api.get('/orders?status=pending_payment');
    st.pending.mobile = pend.length;
    if (can('sell')) st.pending.verify = (await api.get('/verifications')).length;
    renderTop();
  } catch { /* offline */ }
}

// ---------------- layout ----------------
function render() {
  app.replaceChildren(h('div', { class: 'pos' }, h('div', { class: 'topbar', id: 'top' }), h('div', { class: 'main' },
    h('section', { class: 'menu', id: 'menu' }), h('aside', { class: 'cart', id: 'cart' }))),
  h('button', { class: 'btn primary big mobile-cart-btn', id: 'mcart', onclick: () => $('#cart').classList.toggle('open') }, 'ตะกร้า'));
  renderTop(); renderMenu(); renderCart();
}
function renderTop() {
  const t = $('#top'); if (!t) return;
  const badge = (n, pulse) => (n ? h('span', { class: 'count' + (pulse ? ' pulse' : '') }, n) : null);
  t.replaceChildren(
    h('span', { class: 'brand' }, h('img', { src: st.settings.store.logo || '/assets/bowl.svg', alt: '' }), st.settings.store.name), h('span', { id: 'net', class: 'status-dot ' + (online ? 'ok' : 'bad') }),
    h('span', { class: 'who muted' }, `${st.terminal.name} · ${st.staff.name}`),
    st.shift ? h('span', { class: 'badge ok' }, 'รอบเปิดอยู่') : h('button', { class: 'btn sm danger', onclick: openShiftDialog }, 'ยังไม่เปิดรอบ'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: ordersDialog }, '🧾 บิล/ออเดอร์', badge(st.pending.mobile, st.pending.mobile > 0)),
    can('redeem') && h('button', { class: 'btn', onclick: () => couponDialog() }, '🎁 แลกรางวัล'),
    st.pending.verify ? h('button', { class: 'btn', onclick: verifyDialog }, '🔐 ยืนยันสมาชิก', badge(st.pending.verify, true)) : null,
    can('print_mobile_qr') && h('button', { class: 'btn', onclick: mobileQrDialog }, '📱 QR สั่งอาหาร'),
    h('button', { class: 'btn', onclick: shiftDialog }, '💰 รอบการขาย'),
    h('button', { class: 'btn', onclick: devicesDialog }, '🖨️ อุปกรณ์'),
    can('cut_paper') && h('button', { class: 'btn', onclick: manualCut }, '✂️ ตัดกระดาษ'),
    h('button', { class: 'btn', onclick: moreMenu, 'aria-label': 'เมนูเพิ่มเติม' }, '⋯'),
    h('span', { class: 'version' }, 'v' + VERSION));
}

// secondary actions live in a small menu so the top bar stays readable on tablets
function moreMenu(e) {
  e.stopPropagation();
  const old = $('.menu-pop'); if (old) return old.remove();
  const pop = h('div', { class: 'menu-pop', role: 'menu' },
    h('a', { href: '/guide/', target: '_blank' }, '📖 คู่มือการใช้งาน'),
    (can('view_sales') || can('settings')) && h('a', { href: '/admin/', target: '_blank' }, '📊 เว็บไซต์จัดการร้าน'),
    h('a', { href: '/kitchen/', target: '_blank' }, '👩‍🍳 จอครัว'),
    h('button', { onclick: () => { pop.remove(); lockNow(); } }, '🔒 ล็อกหน้าจอ'),
    h('button', { onclick: logout }, '🚪 ออกจากระบบ / สลับผู้ใช้'),
    h('div', { class: 'version', style: { padding: '.4em .8em' } }, `${st.staff.name} · ${st.terminal.name} · เวอร์ชัน ${VERSION}`));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('click', () => pop.remove(), { once: true }));
}

function renderMenu() {
  const m = $('#menu'); if (!m) return;
  const cats = st.catalog.categories;
  const search = h('input', { class: 'input', id: 'search', placeholder: '🔍 ค้นหาชื่อ / รหัสสินค้า / สแกนบาร์โค้ด', value: st.q, autocomplete: 'off' });
  search.addEventListener('input', debounce(() => { st.q = search.value; renderGrid(); }, 150));
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = search.value.trim();
    if (v && addByCode(v)) { search.value = ''; st.q = ''; renderGrid(); }
    else if (v) { const list = filtered(); if (list.length === 1) { pickProduct(list[0]); search.value = ''; st.q = ''; renderGrid(); } }
  });
  m.replaceChildren(
    h('div', { class: 'search' }, search, h('button', { class: 'btn', onclick: () => { search.value = ''; st.q = ''; renderGrid(); } }, 'ล้าง')),
    h('div', { class: 'tabs cats' }, [{ id: 'all', name: 'ทั้งหมด', color: '' }, ...cats].map((c) => h('button', { class: 'tab' + (st.cat === c.id ? ' active' : ''), style: c.color ? `--cat:${c.color}` : null, onclick: () => { st.cat = c.id; renderMenu(); } },
      c.id !== 'all' ? h('i', { class: 'dot' }) : null, c.name, h('span', { class: 'n' }, st.catalog.products.filter((p) => p.active && (c.id === 'all' || p.category_id === c.id)).length)))),
    h('div', { class: 'products', id: 'grid' }));
  renderGrid();
}
const filtered = () => {
  const q = st.q.trim().toLowerCase();
  return st.catalog.products.filter((p) => p.active && (st.cat === 'all' || p.category_id === st.cat) &&
    (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q) || p.barcodes.some((b) => b.includes(q))));
};
function renderGrid() {
  const g = $('#grid'); if (!g) return;
  const list = filtered();
  const inCart = new Map();
  for (const l of st.cart.lines) inCart.set(l.product_id, (inCart.get(l.product_id) || 0) + l.qty);
  const catColor = Object.fromEntries(st.catalog.categories.map((c) => [c.id, c.color]));
  g.replaceChildren(...(list.length ? list.map((p) => h('button', { class: 'prod' + (p.sold_out ? ' out' : '') + (inCart.get(p.id) ? ' picked' : ''), style: catColor[p.category_id] ? `--cat:${catColor[p.category_id]}` : null,
    onclick: () => pickProduct(p), oncontextmenu: (e) => { e.preventDefault(); soldOutToggle(p); } },
    h('div', { class: 'img' + (p.image ? '' : ' noimg'), style: p.image ? { backgroundImage: `url(${p.image})` } : {} }, p.image ? null : h('img', { src: '/assets/bowl.svg', alt: '' }),
      inCart.get(p.id) ? h('span', { class: 'incart' }, '×' + inCart.get(p.id)) : null, p.sold_out ? h('span', { class: 'soldout' }, 'หมด') : null),
    h('div', { class: 'nm' }, p.name),
    h('div', { class: 'pr' }, h('span', { class: 'price' }, baht(p.price) + ' ฿'), p.bowl_count ? h('span', { class: 'unit' }, `${p.bowl_count} ${U()}`) : null, h('span', { class: 'plus' }, '+')))) : [h('div', { class: 'empty' }, 'ไม่พบสินค้า')]));
}
async function soldOutToggle(p) {
  if (!(await confirmBox(p.sold_out ? 'เปิดขาย' : 'ตั้งเป็นสินค้าหมด', `${p.name}`, 'ยืนยัน'))) return;
  await api.post(`/products/${p.id}/sold-out`, { sold_out: !p.sold_out }).catch(errToast);
}

// ---------------- cart ----------------
function saveCart() { store.set('cart_' + st.terminal.id, st.cart); pushDisplay(); }
const product = (id) => st.catalog.products.find((p) => p.id === id);
function addByCode(code) {
  const p = st.catalog.products.find((x) => x.active && (x.barcodes.includes(code) || x.code.toLowerCase() === code.toLowerCase()));
  if (!p) return false;
  pickProduct(p, { fromScan: true });
  return true;
}
function currentBowlGroup() { return st.activeBowl || null; }
function pickProduct(p, { fromScan = false } = {}) {
  if (p.sold_out) return toast('สินค้าหมด: ' + p.name, 'warn');
  if (p.option_groups.length) return optionsDialog(p);
  // toppings (0 bowls) go into the currently selected bowl so they print with it
  const bowl = !p.bowl_count ? currentBowlGroup() : null;
  addToCart(st.cart, p, { dine_type: st.cart.dine_type, bowl_group: bowl });
  if (fromScan) toast(`+1 ${p.name}`, 'ok', 900);
  saveCart(); renderCart();
}
function optionsDialog(p, editLine = null) {
  const groups = p.option_groups.map((gid) => st.catalog.option_groups.find((g) => g.id === gid)).filter(Boolean);
  const chosen = new Map(groups.map((g) => [g.id, new Set((editLine ? editLine.options : []).filter((o) => o.group_id === g.id).map((o) => o.id))]));
  for (const g of groups) if (g.min_select && !chosen.get(g.id).size && g.options[0]) chosen.get(g.id).add(g.options[0].id);
  let qty = editLine ? editLine.qty : 1;
  let dine = editLine ? editLine.dine_type : st.cart.dine_type;
  const note = h('input', { class: 'input', placeholder: 'หมายเหตุ เช่น ไม่ใส่ต้นหอม', value: editLine ? editLine.note : '' });
  const body = h('div');
  const draw = () => {
    const price = p.price + groups.reduce((s, g) => s + g.options.filter((o) => chosen.get(g.id).has(o.id)).reduce((a, o) => a + o.price, 0), 0);
    body.replaceChildren(
      ...groups.map((g) => h('div', { class: 'opt-group' }, h('h4', {}, g.name, h('span', { class: 'muted small' }, g.min_select ? ` (บังคับ${g.max_select > 1 ? ` เลือกได้ ${g.max_select}` : ''})` : g.max_select ? ` (เลือกได้ไม่เกิน ${g.max_select})` : '')),
        h('div', { class: 'opts' }, g.options.map((o) => h('button', { class: 'opt' + (chosen.get(g.id).has(o.id) ? ' on' : ''), onclick: () => {
          const set = chosen.get(g.id);
          if (set.has(o.id)) { if (!(g.min_select && set.size <= g.min_select)) set.delete(o.id); }
          else { if (g.max_select === 1) set.clear(); if (!g.max_select || set.size < g.max_select) set.add(o.id); else toast(`เลือกได้ไม่เกิน ${g.max_select}`, 'warn'); }
          draw();
        } }, o.name, o.price ? ` +${baht(o.price)}` : ''))))),
      h('div', { class: 'row', style: { marginBottom: '.8em' } }, h('div', { class: 'seg', style: { flex: 1 } },
        h('button', { class: dine === 'dine_in' ? 'on' : '', onclick: () => { dine = 'dine_in'; draw(); } }, 'ทานที่ร้าน'),
        h('button', { class: dine === 'takeaway' ? 'on takeaway' : '', onclick: () => { dine = 'takeaway'; draw(); } }, 'กลับบ้าน')),
      h('div', { class: 'qty' }, h('button', { onclick: () => { qty = Math.max(1, qty - 1); draw(); } }, '−'), h('span', {}, qty), h('button', { onclick: () => { qty++; draw(); } }, '+'))),
      h('label', { class: 'field' }, 'หมายเหตุ', note),
      h('div', { class: 'bigsum' }, baht(price * qty), ' ฿'));
  };
  draw();
  modal(p.name, body, { actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: editLine ? 'บันทึก' : 'เพิ่มลงบิล', class: 'primary', onClick: () => {
    for (const g of groups) if (chosen.get(g.id).size < g.min_select) { toast('กรุณาเลือก ' + g.name, 'warn'); return false; }
    const options = groups.flatMap((g) => g.options.filter((o) => chosen.get(g.id).has(o.id)).map((o) => ({ group_id: g.id, group: g.name, id: o.id, name: o.name, price: o.price })));
    if (editLine) Object.assign(editLine, { options, qty, dine_type: dine, note: note.value });
    else {
      const bowl = p.bowl_count ? nextBowlGroup() : currentBowlGroup();
      const l = addToCart(st.cart, p, { qty, options, dine_type: dine, note: note.value, bowl_group: bowl });
      if (p.bowl_count && l.qty === qty) st.activeBowl = l.bowl_group;
    }
    saveCart(); renderCart();
  } }] });
}
// every new bowl item gets its own bowl number so toppings can be attached to it
function nextBowlGroup() { return Math.max(0, ...st.cart.lines.map((l) => l.bowl_group || 0)) + 1; }

function previewTotals() {
  const lines = st.cart.lines.map((l) => ({ ...l, cost_unit: 0 }));
  const sale = st.settings.sale;
  const d = st.cart.discount;
  const pre = computeTotals(lines, sale);
  const manual = d ? (d.type === 'percent' ? Math.round(pre.items_total * d.value / 100) : d.value) : 0;
  const tierPct = st.cart.member && st.cart.member.tier ? st.cart.member.tier.discount_pct || 0 : 0;
  const tierAmt = tierPct ? Math.round((pre.items_total - manual) * tierPct / 100) : 0;
  return { ...computeTotals(lines, sale, { type: 'amount', value: manual + tierAmt }), tierAmt };
}
function renderCart() {
  const c = $('#cart'); if (!c) return;
  const cart = st.cart;
  const t = previewTotals();
  const mc = $('#mcart'); if (mc) mc.textContent = `ตะกร้า ${cart.lines.reduce((s, l) => s + l.qty, 0)} รายการ · ${baht(t.total)} ฿`;
  const setDine = (d) => { cart.dine_type = d; for (const l of cart.lines) if (!l.sent_qty) l.dine_type = d; saveCart(); renderCart(); };
  const tables = st.tables || [];
  c.replaceChildren(
    h('div', { class: 'cart-head' },
      h('div', { class: 'row between' }, h('strong', {}, cart.order_id ? `บิล ${cart.bill_no || ''}` : 'บิลใหม่', cart.queue_no ? h('span', { class: 'badge brand' }, ' คิว ' + cart.queue_no) : null),
        h('button', { class: 'btn sm', onclick: clearCart }, cart.order_id ? 'ปิดบิลนี้' : 'ล้างบิล')),
      h('div', { class: 'seg' }, h('button', { class: cart.dine_type === 'dine_in' ? 'on' : '', onclick: () => setDine('dine_in') }, '🍽️ ทานที่ร้าน'),
        h('button', { class: cart.dine_type === 'takeaway' ? 'on takeaway' : '', onclick: () => setDine('takeaway') }, '🥡 กลับบ้าน')),
      h('div', { class: 'row' },
        h('button', { class: 'chip', onclick: pickTable }, cart.table_name ? `โต๊ะ ${cart.table_name}` : '+ โต๊ะ'),
        h('button', { class: 'chip', onclick: async () => { const v = await promptBox('ชื่อลูกค้า', { value: cart.customer_name, required: false }); if (v !== null) { cart.customer_name = v; saveCart(); renderCart(); } } }, cart.customer_name ? `👤 ${cart.customer_name}` : '+ ชื่อลูกค้า'),
        h('button', { class: 'chip', onclick: async () => { const v = await promptBox('หมายเหตุออเดอร์', { value: cart.note, required: false }); if (v !== null) { cart.note = v; saveCart(); renderCart(); } } }, cart.note ? `📝 ${cart.note}` : '+ หมายเหตุ'),
        cart.member ? null : h('button', { class: 'chip', onclick: memberDialog }, '+ สมาชิก')),
      cart.member ? memberBox(cart, t) : null),
    h('div', { class: 'lines' }, cart.lines.length ? cart.lines.map((l) => lineView(l))
      : h('div', { class: 'cart-empty' }, h('img', { src: '/assets/bowl.svg', alt: '' }), h('b', {}, 'ยังไม่มีสินค้าในบิล'), h('span', {}, 'แตะเมนูทางซ้าย หรือสแกนบาร์โค้ดได้เลย'))),
    h('div', { class: 'totals' },
      row('รวมสินค้า', baht(t.items_total)),
      t.discount ? row('ส่วนลด' + (t.tierAmt ? ' (รวมสิทธิ์ Tier)' : ''), '-' + baht(t.discount)) : null,
      t.packaging ? row('ค่าบรรจุภัณฑ์', baht(t.packaging)) : null,
      t.tax ? row(st.settings.sale.tax_inclusive ? 'VAT (รวมในราคา)' : 'VAT', baht(t.tax)) : null,
      row(h('span', {}, ('จำนวน' + U() + ' '), h('strong', {}, t.bowls)), h('span', { class: 'grand num' }, baht(t.total) + ' ฿'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => saveOrder('hold'), disabled: !cart.lines.length }, '⏸ พักบิล'),
      h('button', { class: 'btn', onclick: () => saveOrder('send'), disabled: !cart.lines.length }, '🔥 ส่งครัว'),
      h('button', { class: 'btn', onclick: discountDialog, disabled: !cart.lines.length || !can('discount') }, '％ ส่วนลด'),
      h('button', { class: 'btn', onclick: bowlPicker }, `🥣 ${U()} ${st.activeBowl || '-'}`),
      h('button', { class: 'btn primary pay', onclick: payDialog, disabled: !cart.lines.length }, h('span', {}, '💳 ชำระเงิน'), h('span', { class: 'amt num' }, `${baht(t.total)} ฿`))));
  renderGrid();
}
// points the attached member will get from this bill (same rule as the server; the receipt shows the final number)
function previewEarn(cart, t) {
  const P = st.settings.points || {};
  if (!P.enabled || !cart.member) return 0;
  const items = cart.lines.map((l) => ({ product_id: l.product_id, qty: l.qty, void_qty: 0, refunded_qty: 0, line_total: lineTotal(l) }));
  return pointsFor({ items_total: t.items_total, discount: t.discount, packaging: t.packaging, tax: t.tax }, items, { ...P, tax_inclusive: st.settings.sale.tax_inclusive },
    cart.member.tier ? Number(cart.member.tier.multiplier) || 1 : 1).points;
}
function memberBox(cart, t) {
  const m = cart.member, earn = previewEarn(cart, t);
  return h('div', { class: 'member-box' },
    h('div', { class: 'av' }, (m.first_name || m.nickname || '⭐').slice(0, 1)),
    h('div', { class: 'who' }, h('b', {}, `${m.first_name || m.nickname || ''}`, m.tier ? h('span', { class: 'badge', style: { background: m.tier.color, color: '#fff', marginLeft: '.4em' } }, m.tier.name) : null),
      h('small', {}, `${m.member_no} · มี ${Number(m.points).toLocaleString()} แต้ม`)),
    st.settings.points && st.settings.points.enabled ? h('div', { class: 'earn' }, h('b', {}, `+${earn}`), h('small', {}, 'แต้มบิลนี้')) : null,
    h('button', { class: 'btn sm', onclick: () => { cart.member = null; saveCart(); renderCart(); } }, 'นำออก'));
}
const row = (a, b) => h('div', { class: 'r' }, h('span', {}, a), h('span', { class: 'num' }, b));
function lineView(l) {
  const sent = l.sent_qty || 0;
  const setQty = (q) => {
    if (q < sent && !can('void_item')) return toast('รายการนี้ส่งครัวแล้ว ต้องมีสิทธิ์ยกเลิกรายการ', 'warn');
    if (q <= 0) st.cart.lines = st.cart.lines.filter((x) => x !== l); else l.qty = q;
    saveCart(); renderCart();
  };
  return h('div', { class: 'line' },
    h('div', { class: 'top' }, h('div', { class: 'nm' }, l.name, h('div', { class: 'opts' }, (l.options || []).map((o) => o.name + (o.price ? ` +${baht(o.price)}` : '')).join(', ')),
      l.note ? h('div', { class: 'opts' }, '📝 ' + l.note) : null), h('strong', { class: 'num' }, baht(lineTotal(l)))),
    h('div', { class: 'ctl' },
      h('div', { class: 'qty' }, h('button', { onclick: () => setQty(l.qty - 1), 'aria-label': 'ลด' }, '−'), h('span', {}, l.qty), h('button', { onclick: () => setQty(l.qty + 1), 'aria-label': 'เพิ่ม' }, '+')),
      h('button', { class: 'chip' + (l.dine_type === 'takeaway' ? ' takeaway' : ''), disabled: !!sent, onclick: () => { l.dine_type = l.dine_type === 'takeaway' ? 'dine_in' : 'takeaway'; saveCart(); renderCart(); } }, l.dine_type === 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน'),
      h('button', { class: 'chip bowl', disabled: !!sent, onclick: () => assignBowl(l) }, l.bowl_group ? `${U()}ที่ ${l.bowl_group}` : ('ไม่ระบุ' + U())),
      !sent && product(l.product_id) && product(l.product_id).option_groups.length ? h('button', { class: 'chip', onclick: () => optionsDialog(product(l.product_id), l) }, 'แก้ไข') : null,
      !sent ? h('button', { class: 'chip', onclick: async () => { const v = await promptBox('หมายเหตุรายการ', { value: l.note, required: false }); if (v !== null) { l.note = v; saveCart(); renderCart(); } } }, 'หมายเหตุ') : null,
      sent ? h('span', { class: 'chip sent' }, `ส่งครัวแล้ว ${sent}`) : null,
      h('button', { class: 'chip', onclick: () => setQty(0) }, '🗑')));
}
async function assignBowl(l) {
  const max = nextBowlGroup();
  const opts = [null, ...Array.from({ length: max }, (_, i) => i + 1)];
  const body = h('div', { class: 'row' }, opts.map((g) => h('button', { class: 'btn big', onclick: () => { l.bowl_group = g; saveCart(); renderCart(); m.close(); } }, g ? `${U()}ที่ ${g}${g === max ? ' (ใหม่)' : ''}` : 'ไม่ระบุ')));
  const m = modal(('จัดเข้า' + U() + ': ') + l.name, h('div', {}, h('p', { class: 'muted' }, ('สินค้าใน' + U() + 'เดียวกันนับเป็น 1 ' + U() + ' และพิมพ์อยู่ในใบครัวเดียวกัน')), body));
}
function bowlPicker() {
  const max = nextBowlGroup();
  const m = modal((U() + 'ที่กำลังเพิ่มท็อปปิ้ง'), h('div', {}, h('p', { class: 'muted' }, ('ท็อปปิ้งที่แตะเพิ่มหลังจากนี้จะถูกจัดเข้า' + U() + 'ที่เลือก')),
    h('div', { class: 'row' }, [null, ...Array.from({ length: max - 1 }, (_, i) => i + 1)].map((g) => h('button', { class: 'btn big', onclick: () => { st.activeBowl = g; renderCart(); m.close(); } }, g ? `${U()}ที่ ${g}` : 'ไม่ระบุ')))));
}
async function pickTable() {
  st.tables = await api.get('/tables');
  const m = modal('เลือกโต๊ะ', h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => { Object.assign(st.cart, { table_id: null, table_name: null }); saveCart(); renderCart(); m.close(); } }, 'ไม่ระบุโต๊ะ'),
    st.tables.filter((t) => t.active).map((t) => h('button', { class: 'btn big', onclick: () => { Object.assign(st.cart, { table_id: t.id, table_name: t.name }); saveCart(); renderCart(); m.close(); } },
      t.name, h('span', { class: 'badge ' + (t.status === 'free' ? 'ok' : 'warn') }, t.status === 'free' ? 'ว่าง' : 'มีลูกค้า')))));
}
async function clearCart() {
  if (st.cart.lines.length && !st.cart.order_id && !(await confirmBox('ล้างบิล', 'ต้องการล้างรายการทั้งหมด?', 'ล้างบิล', true))) return;
  st.cart = newCart(); st.activeBowl = null; saveCart(); renderCart();
  st.sock && st.sock.emit('display:cart_changed', { cart_id: st.cart.cart_id });
}
function cartPayload() {
  const c = st.cart;
  return { lines: c.lines.map((l) => (l.id ? { id: l.id, qty: l.qty } : { product_id: l.product_id, qty: l.qty, options: (l.options || []).map((o) => ({ group_id: o.group_id, id: o.id })),
    note: l.note, dine_type: l.dine_type, bowl_group: l.bowl_group, price_override: l.price_override })),
  table_id: c.table_id, customer_name: c.customer_name, note: c.note, member_id: c.member ? c.member.id : null, discount: c.discount || { value: 0 }, version: c.version };
}
async function saveOrder(action) {
  try {
    const r = await api.post('/orders/save', { order_id: st.cart.order_id, action, idempotency_key: st.cart.idem, cart: cartPayload(), approver: st.cart.approver });
    if (action === 'hold') { toast(`พักบิล ${r.bill_no} แล้ว`, 'ok'); st.cart = newCart(); st.activeBowl = null; }
    else { loadOrderIntoCart(r); toast(`ส่งครัวแล้ว · คิว ${r.queue_no}`, 'ok'); }
    saveCart(); renderCart();
  } catch (e) { errToast(e); if (e.code === 'no_shift') openShiftDialog(); if (e.code === 'version') reloadOrder(); }
}
async function reloadOrder() { if (st.cart.order_id) loadOrderIntoCart(await api.get('/orders/' + st.cart.order_id)); renderCart(); }
function loadOrderIntoCart(o) {
  st.cart = { ...newCart(), cart_id: st.cart.order_id === o.id ? st.cart.cart_id : uid(), order_id: o.id, bill_no: o.bill_no, queue_no: o.queue_no, version: o.version,
    dine_type: o.dine_type === 'takeaway' ? 'takeaway' : 'dine_in', table_id: o.table_id, table_name: o.table_name, customer_name: o.customer_name || '', note: o.note || '',
    member: o.member ? { ...o.member, tier: null } : null, discount: o.discount_info && o.discount_info.manual ? { type: o.discount_info.manual.type, value: o.discount_info.manual.value } : null,
    lines: o.items.filter((i) => i.qty - i.void_qty > 0).map((i) => ({ key: i.id, id: i.id, id_locked: true, product_id: i.product_id, name: i.name, qty: i.qty - i.void_qty, unit_price: i.unit_price,
      options: i.options, note: i.note, dine_type: i.dine_type, bowl_group: i.bowl_group, bowl_count: i.bowl_count, sent_qty: i.sent_qty })), source: o.source, status: o.status };
  st.sock && st.sock.emit('display:cart_changed', { cart_id: st.cart.cart_id });
}

// ---------------- discount ----------------
function discountDialog() {
  let type = st.cart.discount ? st.cart.discount.type : 'percent';
  const val = h('input', { class: 'input', inputmode: 'decimal', value: st.cart.discount ? (type === 'percent' ? st.cart.discount.value : st.cart.discount.value / 100) : '' });
  const reason = h('input', { class: 'input', placeholder: 'เหตุผล', value: (st.cart.discount && st.cart.discount.reason) || '' });
  const seg = h('div', { class: 'seg' });
  const drawSeg = () => seg.replaceChildren(h('button', { class: type === 'percent' ? 'on' : '', onclick: () => { type = 'percent'; drawSeg(); } }, 'เปอร์เซ็นต์ %'),
    h('button', { class: type === 'amount' ? 'on' : '', onclick: () => { type = 'amount'; drawSeg(); } }, 'จำนวนเงิน ฿'));
  drawSeg();
  const max = (st.settings.sale.max_discount_pct || {})[st.staff.role_id] ?? 100;
  modal('ส่วนลดท้ายบิล', h('div', {}, seg, h('label', { class: 'field', style: { marginTop: '.8em' } }, 'มูลค่า', val), keypad(val, { decimal: true }), h('label', { class: 'field', style: { marginTop: '.8em' } }, 'เหตุผล', reason),
    h('p', { class: 'muted small' }, `สิทธิ์ของคุณ: ไม่เกิน ${max}% (เกินกว่านี้ต้องให้ผู้จัดการใส่ PIN อนุมัติ)`)), { actions: [
    { label: 'ไม่มีส่วนลด', onClick: () => { st.cart.discount = null; st.cart.approver = null; saveCart(); renderCart(); } },
    { label: 'ใช้ส่วนลด', class: 'primary', onClick: async () => {
      const v = Number(val.value) || 0;
      const d = { type, value: type === 'percent' ? Math.min(100, v) : toSatang(v), reason: reason.value };
      const pre = computeTotals(st.cart.lines, st.settings.sale);
      const amt = type === 'percent' ? pre.items_total * d.value / 100 : d.value;
      if (amt > pre.items_total * max / 100) { const ap = await approverDialog('discount'); if (!ap) return false; st.cart.approver = ap; }
      st.cart.discount = d; saveCart(); renderCart();
    } }] });
}
function approverDialog(perm) {
  return new Promise((resolve) => {
    const code = h('input', { class: 'input', placeholder: 'รหัสผู้อนุมัติ', inputmode: 'numeric' });
    const pin = h('input', { class: 'input pin', type: 'password', placeholder: 'PIN', inputmode: 'numeric' });
    let ok = false;
    modal('ต้องให้ผู้มีสิทธิ์อนุมัติ', h('div', {}, h('label', { class: 'field' }, 'รหัสพนักงาน', code), h('label', { class: 'field' }, 'PIN', pin), keypad(pin)), { onClose: () => { if (!ok) resolve(null); }, actions: [
      { label: 'ยกเลิก', onClick: () => {} },
      { label: 'อนุมัติ', class: 'primary', onClick: async () => { const r = await api.post('/auth/approve', { code: code.value, pin: pin.value, perm }); if (!r.ok) { toast('ผู้อนุมัติไม่มีสิทธิ์นี้', 'error'); return false; } ok = true; resolve({ code: code.value, pin: pin.value }); } }] });
  });
}

// ---------------- payment ----------------
function payDialog() {
  if (!st.shift) return openShiftDialog();
  const t = previewTotals();
  const methods = st.settings.sale.payment_methods.filter((m) => m.enabled);
  const pays = []; // {method, amount, received}
  let method = 'cash';
  const amt = h('input', { class: 'input', inputmode: 'decimal', style: { fontSize: '1.6em', textAlign: 'right' } });
  const printReceipt = h('input', { type: 'checkbox', checked: (st.settings.print || {}).auto_receipt !== false });
  const printQueue = h('input', { type: 'checkbox', checked: !!(st.settings.print || {}).auto_queue });
  const P = st.settings.print || {};
  const printMobile = h('input', { type: 'checkbox', disabled: !can('print_mobile_qr') });
  const printMerchant = h('input', { type: 'checkbox', checked: !!P.auto_merchant });
  const right = h('div'); const left = h('div');
  const paid = () => pays.reduce((s, p) => s + p.amount, 0);
  const remaining = () => Math.max(0, t.total - paid());
  const drawLeft = () => {
    const rem = remaining();
    left.replaceChildren(h('div', { class: 'muted' }, 'ยอดชำระ'), h('div', { class: 'bigsum num' }, baht(t.total), ' ฿'),
      h('div', { class: 'muted small', style: { textAlign: 'center' } }, `${t.bowls} ${U()} · ${dineLabel(orderDineType(st.cart.lines))}`),
      pays.length ? h('div', { class: 'card', style: { margin: '.6em 0' } }, pays.map((p, i) => row(h('span', {}, methods.find((m) => m.id === p.method).name, ' ', h('button', { class: 'chip', onclick: () => { pays.splice(i, 1); drawLeft(); drawRight(); } }, 'ลบ')),
        baht(p.method === 'cash' ? p.received : p.amount))), row('คงเหลือ', baht(rem))) : null,
      h('div', { class: 'pay-methods' }, methods.map((m) => h('button', { class: 'btn big' + (method === m.id ? ' on' : ''), onclick: () => { method = m.id; amt.value = (remaining() / 100).toFixed(2); drawLeft(); drawRight(); } }, m.name))),
      h('div', { style: { marginTop: '1em' } }, h('label', { class: 'switch' }, printReceipt, 'พิมพ์ใบเสร็จ'), ' ', h('label', { class: 'switch' }, printQueue, 'พิมพ์ใบเลขคิว'), ' ',
        h('label', { class: 'switch' }, printMerchant, 'พิมพ์ใบสรุปร้านค้า'), ' ', h('label', { class: 'switch' }, printMobile, 'พิมพ์ใบ Mobile Ordering')));
  };
  const drawRight = () => {
    const rem = remaining();
    const received = toSatang(amt.value);
    const quick = [rem, ...[2000, 10000, 50000, 100000].filter((x) => x > rem)].slice(0, 5);
    right.replaceChildren(
      h('label', { class: 'field' }, method === 'cash' ? 'รับเงินสด (บาท)' : 'จำนวนเงิน (บาท)', amt),
      method === 'cash' ? h('div', { class: 'row' }, [...new Set(quick)].map((q) => h('button', { class: 'btn', onclick: () => { amt.value = (q / 100).toFixed(2); drawRight(); } }, baht(q)))) : null,
      method === 'cash' && received > rem ? h('div', { class: 'bigsum', style: { color: 'var(--ok)' } }, 'ทอน ', baht(received - rem)) : null,
      method === 'promptpay' && st.settings.payment.promptpay_enabled ? h('div', { style: { textAlign: 'center' } }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(qrPayload(Math.min(rem, toSatang(amt.value) || rem))), style: { width: '200px' }, alt: 'PromptPay QR' }),
        h('div', { class: 'small muted' }, 'แสดงบนจอลูกค้าด้วย · ตรวจสอบยอดเงินเข้าก่อนกดยืนยัน')) : null,
      keypad(amt, { decimal: true }),
      h('div', { class: 'row', style: { marginTop: '.6em' } }, h('button', { class: 'btn block', onclick: addPay }, '+ เพิ่มช่องทางนี้ (แบ่งจ่าย)')));
    pushDisplay({ phase: 'pay', received: method === 'cash' ? received : 0, change: method === 'cash' ? Math.max(0, received - rem) : 0, qr: method === 'promptpay' ? qrPayload(rem) : null,
      livePay: { method: (methods.find((x) => x.id === method) || {}).name || method, entered: received, remaining: rem, change: method === 'cash' ? Math.max(0, received - rem) : 0,
        splits: pays.map((p) => ({ method: (methods.find((x) => x.id === p.method) || {}).name || p.method, amount: p.amount })) } });
  };
  amt.addEventListener('input', debounce(drawRight, 200));
  const addPay = () => {
    const v = toSatang(amt.value); const rem = remaining();
    if (!(v > 0)) return toast('กรุณาใส่จำนวนเงิน', 'warn');
    if (method !== 'cash' && v > rem) return toast('ช่องทางนี้รับได้ไม่เกินยอดคงเหลือ', 'warn');
    pays.push(method === 'cash' ? { method, amount: Math.min(v, rem), received: v } : { method, amount: v });
    amt.value = (remaining() / 100).toFixed(2); method = remaining() ? method : method; drawLeft(); drawRight();
  };
  amt.value = (t.total / 100).toFixed(2);
  drawLeft(); drawRight();
  const idem = st.cart.idem; // same key on retry → never double charged
  modal('ชำระเงิน', h('div', { class: 'pay-grid' }, left, right), { wide: true, onClose: () => pushDisplay(), actions: [
    { label: 'ยกเลิก', onClick: () => {} },
    { label: 'ยืนยันรับเงิน', class: 'ok big', onClick: async () => {
      const list = pays.slice();
      if (paid() < t.total) {
        const v = toSatang(amt.value); const rem = remaining();
        if (method === 'cash') { if (v < rem) { toast('รับเงินไม่พอ', 'warn'); return false; } list.push({ method, amount: rem, received: v }); }
        else { if (v < rem) { toast('ยอดไม่ครบ กรุณาเพิ่มช่องทางชำระ', 'warn'); return false; } list.push({ method, amount: rem }); }
      }
      const payload = { idempotency_key: idem, order_id: st.cart.order_id, cart: cartPayload(), payments: list.map((p) => ({ ...p, amount: p.amount, received: p.received })),
        print: { receipt: printReceipt.checked, queue: printQueue.checked, merchant: printMerchant.checked, mobile_qr: printMobile.checked }, approver: st.cart.approver };
      try {
        const o = await api.post('/orders/checkout', payload);
        done(o);
      } catch (e) {
        if (e.code === 'already_paid') { toast('บิลนี้ชำระแล้ว', 'warn'); st.cart = newCart(); saveCart(); renderCart(); return; }
        throw e;
      }
    } }] });
}
const qrPayload = (amount) => (st.settings.payment.promptpay_enabled ? promptPayPayload(st.settings.payment.promptpay_id || '', amount) : null);
function done(o) {
  const change = o.change_amount;
  pushDisplay({ phase: 'done', queue_no: o.queue_no, change, total: o.total, received: o.paid_amount + change, dine_type: o.dine_type,
    livePay: { done: true, bill_no: o.bill_no, method: (o.payments || []).map((p) => (st.settings.sale.payment_methods.find((x) => x.id === p.method) || {}).name || p.method).join(' + '), change } });
  modal('ชำระเงินสำเร็จ', h('div', { style: { textAlign: 'center' } }, h('div', { class: 'muted' }, 'เลขคิว'), h('div', { class: 'qbig' }, o.queue_no || '-'),
    h('div', { class: 'badge ' + (o.dine_type === 'takeaway' ? 'takeaway' : 'info'), style: { fontSize: '1.2em' } }, dineLabel(o.dine_type)),
    change ? h('div', { class: 'bigsum', style: { color: 'var(--ok)', marginTop: '.4em' } }, 'เงินทอน ', baht(change), ' ฿') : null,
    h('p', { class: 'muted' }, `บิล ${o.bill_no} · ${o.bowls} ${U()}`), o.claim_token ? h('p', { class: 'small muted' }, 'ใบเสร็จมี QR ให้ลูกค้าสมัครสมาชิก/รับแต้มย้อนหลัง') : null),
  { onClose: () => setTimeout(() => pushDisplay({ phase: 'idle' }), 6000), actions: [{ label: 'บิลถัดไป', class: 'primary big', onClick: () => {} }] });
  st.cart = newCart(); st.activeBowl = null; saveCart(); renderCart();
  st.shift && api.get('/shifts/current').then((s) => { st.shift = s; }).catch(() => {});
}

// ---------------- customer display ----------------
let lastPhase = 'idle';
function pushDisplay(extra = {}) {
  if (!st.cart || !st.sock) return;
  const { livePay, ...ex } = extra;
  const t = previewTotals();
  const phase = extra.phase || (st.cart.lines.length ? 'cart' : 'idle');
  lastPhase = phase;
  const m = st.cart.member;
  const state = { cart_id: st.cart.cart_id, phase, dine_type: orderDineType(st.cart.lines.length ? st.cart.lines : [{ qty: 1, dine_type: st.cart.dine_type }]),
    lines: st.cart.lines.map((l) => ({ name: l.name, qty: l.qty, options: (l.options || []).map((o) => o.name), price: lineTotal(l), dine_type: l.dine_type, bowl_group: l.bowl_group })),
    items_total: t.items_total, discount: t.discount, packaging: t.packaging, tax: t.tax, total: t.total, bowls: t.bowls, table: st.cart.table_name,
    member: m && st.settings.members.show_on_display ? { name: (m.first_name || m.nickname || '').slice(0, 2) + '***', points: m.points, tier: m.tier && m.tier.name } : null,
    qr: null, received: 0, change: 0, ...ex, at: Date.now() };
  if (st.bc) st.bc.postMessage(state);
  // staff-only details for the admin Live View (the server strips them before the customer display)
  const c = st.cart;
  state.live = { bill_no: c.bill_no || '', queue_no: c.queue_no || '', table: c.table_name || '', customer: c.customer_name || '', note: c.note || '',
    member: m ? { name: `${m.first_name || m.nickname || ''} ${m.last_name || ''}`.trim(), member_no: m.member_no, points: m.points, tier: m.tier && m.tier.name, earn: previewEarn(c, t) } : null,
    discount_label: c.discount ? (c.discount.type === 'percent' ? `${c.discount.value}%` : baht(c.discount.value) + ' ฿') : '',
    line_notes: c.lines.map((l) => l.note || ''), sent: c.lines.map((l) => l.sent_qty || 0), pay: livePay || null };
  st.sock.emit('display:state', state);
}

// ---------------- members ----------------
function memberDialog() {
  const q = h('input', { class: 'input', placeholder: 'เบอร์โทร หรือ หมายเลขสมาชิก', inputmode: 'tel' });
  const res = h('div');
  const search = async () => {
    const list = await api.get('/members/lookup?q=' + encodeURIComponent(q.value)).catch((e) => { errToast(e); return []; });
    res.replaceChildren(...(list.length ? list.map((m) => h('div', { class: 'order-row' }, h('strong', {}, m.member_no), h('div', {}, `${m.first_name || ''} ${m.last_name || ''} · ${maskPhone(m.phone)}`,
      h('div', { class: 'small muted' }, `${m.points} แต้ม · ${m.tier ? m.tier.name : ''}`)), h('button', { class: 'btn primary', onclick: () => { st.cart.member = m; saveCart(); renderCart(); dlg.close(); } }, 'เลือก')))
      : [h('div', { class: 'empty' }, 'ไม่พบสมาชิก ', h('button', { class: 'btn', onclick: () => { dlg.close(); registerDialog(q.value); } }, 'สมัครสมาชิกใหม่'))]));
  };
  q.addEventListener('keydown', (e) => { if (e.key === 'Enter') search(); });
  const dlg = modal('ค้นหาสมาชิก', h('div', {}, h('div', { class: 'row' }, q, h('button', { class: 'btn primary', onclick: search }, 'ค้นหา')), keypad(q, { onEnter: search }), res,
    h('hr'), h('button', { class: 'btn block big', onclick: () => { dlg.close(); memberPromptOnDisplay('touch'); } }, '📺 แสดงช่องกรอกสมาชิกที่หน้าจอลูกค้า'),
    h('button', { class: 'btn block', style: { marginTop: '.5em' }, onclick: () => { dlg.close(); memberPromptOnDisplay('phone_qr'); } }, '📱 จอลูกค้าแบบไม่สัมผัส: แสดง QR ให้ลูกค้ากรอกบนมือถือ')));
}
async function memberPromptOnDisplay(mode) {
  try {
    const p = await api.post('/member-prompt', { cart_id: st.cart.cart_id, mode });
    const close = async () => { await api.post('/member-prompt/close').catch(() => {}); };
    modal('รอลูกค้ากรอกสมาชิกที่หน้าจอลูกค้า', h('div', { class: 'member-prompt-wait', style: { textAlign: 'center' } },
      h('p', {}, 'จอลูกค้ากำลังแสดงช่องกรอกเบอร์โทร/หมายเลขสมาชิก'),
      mode === 'phone_qr' ? h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(location.origin + p.phone_url), style: { width: '220px' } }) : null,
      h('p', { class: 'muted small' }, `หมดเวลา ${fmtTime(p.expires_at)} · ผลลัพธ์จะเข้าบิลนี้โดยอัตโนมัติ`)), { onClose: close, actions: [{ label: 'ปิดหน้ากรอกและกลับหน้าขาย', class: 'danger', onClick: close }] });
  } catch (e) { errToast(e); }
}
async function registerDialog(prefill = '') {
  const cfg = await api.get('/c/config');
  const f = cfg.fields;
  const phone = h('input', { class: 'input', inputmode: 'tel', value: /^\d/.test(prefill) ? prefill : '' });
  const inputs = Object.fromEntries(['first_name', 'last_name', 'nickname', 'birthday', 'email'].filter((k) => f[k].on).map((k) => [k, h('input', { class: 'input', type: k === 'birthday' ? 'date' : k === 'email' ? 'email' : 'text' })]));
  const L = { first_name: 'ชื่อ', last_name: 'นามสกุล', nickname: 'ชื่อเล่น', birthday: 'วันเกิด', email: 'อีเมล' };
  const hint = h('span', { class: 'hint' });
  phone.addEventListener('input', debounce(async () => { const r = await api.get('/members/check-phone?phone=' + encodeURIComponent(phone.value)); hint.textContent = !r.valid ? 'รูปแบบเบอร์ไม่ถูกต้อง' : r.exists ? '⚠️ เบอร์นี้เป็นสมาชิกอยู่แล้ว' : '✓ ใช้ได้'; }, 400));
  modal('สมัครสมาชิก', h('div', {}, h('label', { class: 'field' }, 'เบอร์โทร *', phone, hint), Object.entries(inputs).map(([k, el]) => h('label', { class: 'field' }, L[k] + (f[k].req ? ' *' : ''), el)),
    h('p', { class: 'muted small' }, 'รหัสผ่านเริ่มต้นสำหรับเว็บไซต์สมาชิก = เลข 4 ตัวท้ายของเบอร์โทร')), { actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: 'สมัคร', class: 'primary', onClick: async () => {
    const m = await api.post('/members', { phone: phone.value, ...Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value])) });
    st.cart.member = m; saveCart(); renderCart(); toast('สมัครสมาชิกแล้ว ' + m.member_no, 'ok');
  } }] });
}
async function verifyDialog() {
  const list = await api.get('/verifications');
  const body = h('div', {}, list.length ? list.map((v) => {
    const code = h('input', { class: 'input', placeholder: 'รหัส 6 หลักที่ลูกค้าแสดง', inputmode: 'numeric' });
    return h('div', { class: 'card', style: { marginBottom: '.6em' } }, h('strong', {}, `${v.first_name || ''} ${v.member_no} · ${maskPhone(v.phone)}`),
      h('div', { class: 'small muted' }, `${v.purpose === 'claim' ? 'รับแต้มจากใบเสร็จ' : v.purpose === 'redeem' ? 'แลกรางวัล' : v.purpose} · ${fmtTime(v.created_at)}`),
      h('p', { class: 'small' }, 'ตรวจสอบตัวตนลูกค้าที่เคาน์เตอร์ แล้วกรอกรหัสที่แสดงบนมือถือลูกค้า'),
      h('div', { class: 'row' }, code, h('button', { class: 'btn ok', onclick: async () => { await api.post('/verifications/' + v.id, { approve: true, code: code.value }).then(() => { toast('ยืนยันแล้ว', 'ok'); st.pending.verify = Math.max(0, st.pending.verify - 1); renderTop(); }).catch(errToast); } }, 'ยืนยัน'),
        h('button', { class: 'btn', onclick: async () => { await api.post('/verifications/' + v.id, { approve: false }).catch(errToast); } }, 'ปฏิเสธ')));
  }) : h('div', { class: 'empty' }, 'ไม่มีคำขอ'));
  modal('คำขอยืนยันตัวตนสมาชิก', body);
}

// ---------------- coupons ----------------
async function couponDialog(prefill = '') {
  const code = h('input', { class: 'input', placeholder: 'สแกนบาร์โค้ด หรือกรอกโค้ดคูปอง', value: prefill, style: { textTransform: 'uppercase' } });
  const res = h('div');
  const look = async () => {
    try {
      const c = await api.get('/coupons/' + encodeURIComponent(code.value.trim()));
      const okToUse = c.status === 'reserved' && !c.expired;
      res.replaceChildren(h('div', { class: 'card' }, h('h3', {}, '🎁 ', c.reward ? c.reward.name : ''),
        h('p', {}, `สมาชิก: ${c.member.first_name || ''} ${c.member.member_no} · ${maskPhone(c.member.phone)}`),
        h('p', {}, 'สถานะ: ', h('span', { class: 'badge ' + (okToUse ? 'ok' : 'bad') }, c.status === 'used' ? `ใช้แล้ว ${fmtTime(c.used_at)}` : c.expired ? 'หมดอายุ' : c.status === 'reserved' ? 'ใช้ได้' : 'ยกเลิก')),
        h('p', { class: 'small muted' }, `หมดอายุ ${fmtTime(c.expires_at)} · ${c.points} แต้ม`),
        okToUse ? h('button', { class: 'btn ok big block', onclick: async (e) => {
          e.target.disabled = true;
          try { await api.post(`/coupons/${encodeURIComponent(c.code)}/redeem`); toast('ส่งมอบรางวัลแล้ว', 'ok'); look(); } catch (er) { errToast(er); look(); }
        } }, 'ยืนยันส่งมอบสินค้า') : null));
    } catch (e) { res.replaceChildren(h('div', { class: 'empty' }, e.message)); }
  };
  code.addEventListener('keydown', (e) => { if (e.key === 'Enter') look(); });
  modal('แลกรางวัลด้วยโค้ด/บาร์โค้ด', h('div', {}, h('div', { class: 'row' }, code, h('button', { class: 'btn primary', onclick: look }, 'ตรวจสอบ')), res), { wide: false });
  if (prefill) look();
}

// ---------------- orders / bills ----------------
async function ordersDialog() {
  let tab = st.pending.mobile ? 'pending' : 'open';
  const body = h('div');
  const draw = async () => {
    const status = tab === 'open' ? 'held,open' : tab === 'pending' ? 'pending_payment' : 'paid,void';
    const list = await api.get('/orders?status=' + status);
    body.replaceChildren(h('div', { class: 'tabs', style: { marginBottom: '.8em' } }, [['open', 'บิลค้าง/พักบิล'], ['pending', `Mobile รอชำระ (${tab === 'pending' ? list.length : st.pending.mobile})`], ['recent', 'บิลล่าสุด']].map(([k, n]) =>
      h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; draw(); } }, n))),
    ...(list.length ? list.slice(0, 80).map((o) => h('div', { class: 'order-row' },
      h('div', {}, h('strong', {}, o.queue_no || '—'), h('div', { class: 'small muted' }, o.bill_no)),
      h('div', {}, h('div', {}, h('span', { class: 'badge ' + (o.status === 'paid' ? 'ok' : o.status === 'void' ? 'bad' : 'warn') }, STATUS_TH[o.status]), ' ',
        h('span', { class: 'badge' }, SOURCE_TH[o.source] || o.source), ' ', h('span', { class: 'badge ' + (o.dine_type === 'takeaway' ? 'takeaway' : 'info') }, dineLabel(o.dine_type)),
        o.verify_status === 'pending' ? h('span', { class: 'badge warn' }, ' มีสลิปรอตรวจ') : null, o.pay_mode === 'cashier' && o.status === 'pending_payment' ? h('span', { class: 'badge warn' }, ' รอชำระที่แคชเชียร์') : null),
        h('div', { class: 'small' }, [o.table_name && 'โต๊ะ ' + o.table_name, o.customer_name, `${o.bowls} ${U()}`, fmtTime(o.created_at), o.prep_status !== 'none' && PREP_TH[o.prep_status]].filter(Boolean).join(' · '))),
      h('div', { class: 'row end' }, h('strong', { class: 'num' }, baht(o.total)), h('button', { class: 'btn primary', onclick: () => openOrder(o.id, dlg) }, 'เปิด')))) : [h('div', { class: 'empty' }, 'ไม่มีรายการ')]));
  };
  const dlg = modal('บิลและออเดอร์', body, { wide: true });
  draw().catch(errToast);
}
async function openOrder(id, parent) {
  const o = await api.get('/orders/' + id);
  const editable = ['held', 'open', 'pending_payment'].includes(o.status);
  const acts = [];
  if (editable) acts.push({ label: 'เปิดในหน้าขาย / รับชำระ', class: 'primary', onClick: () => { loadOrderIntoCart(o); saveCart(); renderCart(); parent && parent.close(); } });
  if (o.status === 'pending_payment' && o.verify_status === 'pending' && can('verify_payment')) acts.push({ label: '✓ สลิปถูกต้อง รับชำระ', class: 'ok', onClick: async () => { await api.post(`/orders/${o.id}/verify-slip`, { approve: true }); toast('ยืนยันรับเงินแล้ว', 'ok'); parent && parent.close(); } },
    { label: 'สลิปไม่ถูกต้อง', onClick: async () => { const reason = await promptBox('เหตุผล', { label: 'แจ้งลูกค้า' }); if (reason) await api.post(`/orders/${o.id}/verify-slip`, { approve: false, reason }); } });
  if (o.status === 'paid') {
    acts.push({ label: '🖨 พิมพ์ใบเสร็จซ้ำ', close: false, onClick: async () => { await api.post(`/orders/${o.id}/print`, { doc: 'receipt' }); toast('ส่งพิมพ์ซ้ำแล้ว (ใช้เลขคิวเดิม)', 'ok'); } },
      { label: '🧾 ใบสรุปร้านค้า', close: false, onClick: async () => { await api.post(`/orders/${o.id}/print`, { doc: 'merchant' }); toast('ส่งพิมพ์ใบสรุปร้านค้าแล้ว', 'ok'); } });
    if (can('print_mobile_qr')) acts.push({ label: '📱 พิมพ์ใบ Mobile Ordering', close: false, onClick: async () => { await api.post(`/orders/${o.id}/print`, { doc: 'mobile_qr' }); toast('ส่งพิมพ์ใบ QR แล้ว', 'ok'); } });
    acts.push({ label: 'คืนเงิน', onClick: () => refundDialog(o) }, { label: 'ยกเลิกบิล', class: 'danger', onClick: () => voidDialog(o) });
    if (o.source === 'mobile_pickup' && o.prep_status !== 'done') acts.push({ label: 'ลูกค้ารับอาหารแล้ว', class: 'ok', onClick: async () => { await api.post(`/orders/${o.id}/complete`); toast('ปิดรายการ Pick Up แล้ว', 'ok'); } });
  } else if (editable) acts.push({ label: 'ยกเลิกบิล', class: 'danger', onClick: () => voidDialog(o) });
  modal(`บิล ${o.bill_no} · คิว ${o.queue_no || '-'}`, h('div', {},
    h('p', {}, h('span', { class: 'badge' }, STATUS_TH[o.status]), ' ', h('span', { class: 'badge' }, SOURCE_TH[o.source]), ' ', dineLabel(o.dine_type), o.table_name ? ` · โต๊ะ ${o.table_name}` : '', o.customer_name ? ` · ${o.customer_name}` : ''),
    h('table', { class: 'table' }, h('tbody', {}, o.items.map((i) => h('tr', {}, h('td', {}, `${i.qty - i.void_qty} x ${i.name}`, h('div', { class: 'small muted' }, i.options.map((x) => x.name).join(', '), i.refunded_qty ? ` · คืนแล้ว ${i.refunded_qty}` : '', i.void_qty ? ` · ยกเลิก ${i.void_qty}` : '')),
      h('td', { class: 'r num' }, baht(i.line_total)))))),
    row('ยอดสุทธิ', baht(o.total)), o.refunded_amount ? row('คืนเงินแล้ว', '-' + baht(o.refunded_amount)) : null, row(('จำนวน' + U()), o.bowls),
    o.payments.length ? h('p', { class: 'small' }, 'ชำระ: ', o.payments.map((p) => `${p.method} ${baht(p.amount)}${p.status !== 'paid' ? ' (' + p.status + ')' : ''}`).join(', ')) : null,
    o.payments.some((p) => p.slip_file) ? h('p', {}, o.payments.filter((p) => p.slip_file).map((p) => h('a', { href: p.slip_file, target: '_blank' }, 'ดูสลิป'))) : null,
    h('details', {}, h('summary', {}, 'ประวัติการส่งครัว/พิมพ์'), h('ul', { class: 'small' }, o.print_jobs.map((j) => h('li', {}, `${fmtTime(j.created_at)} · ${j.doc_type} · ${JOB_TH[j.status] || j.status}${j.error ? ' · ' + j.error : ''} `,
      ['failed', 'unknown'].includes(j.status) ? h('button', { class: 'btn sm', onclick: async () => { await api.post(`/print/jobs/${j.id}/retry`).then(() => toast('ส่งพิมพ์ใหม่แล้ว', 'ok')).catch(errToast); } }, 'ลองใหม่') : null))))), { wide: true, actions: acts });
  if (o.status === 'pending_payment' && o.verify_status === 'pending') api.get(`/orders/${o.id}/slips`).then((s) => { const img = s.find((x) => x.url); if (img) window.open(img.url, '_blank'); }).catch(() => {});
}
async function voidDialog(o) {
  const reason = await promptBox('ยกเลิกบิล ' + o.bill_no, { label: 'เหตุผล (บังคับ)' });
  if (!reason) return;
  const body = { reason };
  if (!can(o.status === 'paid' || o.status === 'open' ? 'void_bill' : 'sell')) { const ap = await approverDialog('void_bill'); if (!ap) return; body.approver = ap; }
  await api.post(`/orders/${o.id}/void`, body).then(() => toast('ยกเลิกบิลแล้ว', 'ok')).catch(errToast);
  if (st.cart.order_id === o.id) { st.cart = newCart(); saveCart(); renderCart(); }
}
function refundDialog(o) {
  const qty = new Map();
  const rows = o.items.filter((i) => i.qty - i.void_qty - i.refunded_qty > 0).map((i) => {
    const left = i.qty - i.void_qty - i.refunded_qty;
    const inp = h('input', { class: 'input', type: 'number', min: 0, max: left, value: 0, style: { width: '90px' } });
    inp.addEventListener('input', () => qty.set(i.id, Math.min(left, Math.max(0, Number(inp.value) || 0))));
    return h('tr', {}, h('td', {}, i.name, h('div', { class: 'small muted' }, `คืนได้ ${left}`)), h('td', {}, inp));
  });
  const reason = h('input', { class: 'input', placeholder: 'เหตุผล (บังคับ)' });
  const restock = h('input', { type: 'checkbox', checked: true });
  const idem = uid();
  modal('คืนเงินบางรายการ · ' + o.bill_no, h('div', {}, h('table', { class: 'table' }, h('tbody', {}, rows)), h('label', { class: 'field' }, 'เหตุผล', reason),
    h('label', { class: 'switch' }, restock, 'คืนสต็อก/วัตถุดิบ'), h('p', { class: 'small muted' }, ('ระบบคำนวณยอดคืนจากราคาในบิล (หักส่วนลดตามสัดส่วน) และปรับจำนวน' + U() + ' แต้มสมาชิก ให้อัตโนมัติ'))), { actions: [
    { label: 'ยกเลิก', onClick: () => {} },
    { label: 'คืนเงิน', class: 'danger', onClick: async () => {
      const items = [...qty.entries()].filter(([, q]) => q > 0).map(([item_id, q]) => ({ item_id, qty: q }));
      if (!items.length) { toast('เลือกจำนวนที่จะคืน', 'warn'); return false; }
      const body = { items, reason: reason.value, restock: restock.checked, idempotency_key: idem };
      if (!can('refund')) { const ap = await approverDialog('refund'); if (!ap) return false; body.approver = ap; }
      const r = await api.post(`/orders/${o.id}/refund`, body);
      toast(`คืนเงิน ${baht(r.amount)} บาท · ${r.bowls} ${U()}`, 'ok');
    } }] });
}

// ---------------- mobile QR ----------------
async function mobileQrDialog() {
  const tables = await api.get('/tables');
  const list = await api.get('/mobile/sessions');
  const body = h('div', {},
    h('h4', {}, 'ออกใบ QR ใหม่ (ใช้ได้หนึ่งรอบการใช้บริการ)'),
    h('div', { class: 'row' }, h('button', { class: 'btn big', onclick: () => issue({ mode: 'pickup' }) }, '🥡 Pick Up'),
      tables.filter((t) => t.active).map((t) => h('button', { class: 'btn big', onclick: () => issue({ mode: 'table', table_id: t.id }) }, `โต๊ะ ${t.name}`, h('span', { class: 'badge ' + (t.status === 'free' ? 'ok' : 'warn') }, t.status === 'free' ? 'ว่าง' : 'มีลูกค้า')))),
    h('h4', { style: { marginTop: '1em' } }, 'QR ที่ยังใช้งาน'),
    ...list.filter((s) => s.status === 'active').map((s) => h('div', { class: 'order-row' }, h('strong', {}, s.ref), h('div', {}, s.mode === 'table' ? `โต๊ะ ${s.table_name}` : 'Pick Up', h('div', { class: 'small muted' }, `ถึง ${fmtTime(s.expires_at)} · ส่งแล้ว ${s.used_count} ครั้ง${s.single_use ? ' · ใช้ได้ครั้งเดียว' : ''}`)),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => api.post(`/mobile/sessions/${s.id}/reprint`).then(() => toast('พิมพ์ซ้ำแล้ว (สิทธิ์เดิม)', 'ok')).catch(errToast) }, 'พิมพ์ซ้ำ'),
        h('button', { class: 'btn sm danger', onclick: async () => { if (await confirmBox('ปิดรอบสั่งอาหาร', 'QR นี้จะสั่งเพิ่มไม่ได้ (ลูกค้ายังดูสถานะออเดอร์เดิมได้)', 'ปิดรอบ', true)) { await api.post(`/mobile/sessions/${s.id}/close`, { reason: 'staff' }); dlg.close(); mobileQrDialog(); } } }, 'ปิดรอบสั่ง')))));
  const issue = async (b) => { const r = await api.post('/mobile/sessions', b).catch(errToast); if (!r) return; toast(r.jobs.length ? 'กำลังพิมพ์ใบ QR' : 'สร้าง QR แล้ว (ยังไม่ได้ตั้งเครื่องพิมพ์สำหรับใบ Mobile Ordering)', 'ok');
    modal('QR สั่งอาหาร ' + r.session.ref, h('div', { style: { textAlign: 'center' } }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(location.origin + '/m/#' + r.session.token), style: { width: '240px' } }), h('p', { class: 'small muted' }, 'ให้ลูกค้าสแกนจากหน้าจอนี้ได้ด้วย'))); };
  const dlg = modal('ใบ QR สำหรับ Mobile Ordering', body, { wide: true });
}

// ---------------- shift ----------------
function openShiftDialog() {
  if (!can('shift')) return toast('ยังไม่เปิดรอบการขาย — ให้ผู้มีสิทธิ์เปิดรอบ', 'warn');
  const cash = h('input', { class: 'input', inputmode: 'decimal', placeholder: '0.00' });
  const note = h('input', { class: 'input', placeholder: 'หมายเหตุ' });
  modal('เปิดรอบการขาย', h('div', {}, h('p', { class: 'muted' }, `${st.terminal.name} · ${st.staff.name} · ${new Date().toLocaleString('th-TH')}`), h('label', { class: 'field' }, 'เงินสดเริ่มต้นในลิ้นชัก (บาท)', cash), keypad(cash, { decimal: true }), h('label', { class: 'field', style: { marginTop: '.8em' } }, 'หมายเหตุ', note)),
    { actions: [{ label: 'ภายหลัง', onClick: () => {} }, { label: 'เปิดรอบ', class: 'primary', onClick: async () => { st.shift = await api.post('/shifts/open', { opening_cash: toSatang(cash.value), note: note.value }); toast('เปิดรอบแล้ว', 'ok'); renderTop(); } }] });
}
async function shiftDialog() {
  const s = await api.get('/shifts/current');
  st.shift = s;
  if (!s) return openShiftDialog();
  const names = Object.fromEntries(st.settings.sale.payment_methods.map((m) => [m.id, m.name]));
  const counted = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'เงินสดที่นับได้' });
  const diffEl = h('div', { class: 'bigsum' });
  counted.addEventListener('input', () => { const d = toSatang(counted.value) - s.expected_cash; diffEl.textContent = counted.value ? (d === 0 ? 'ตรงพอดี' : d > 0 ? `เกิน ${baht(d)}` : `ขาด ${baht(-d)}`) : ''; diffEl.style.color = d === 0 ? 'var(--ok)' : 'var(--bad)'; });
  const body = h('div', { class: 'pay-grid' }, h('div', {},
    row('เปิดรอบ', fmtTime(s.opened_at)), row('เงินสดเริ่มต้น', baht(s.opening_cash)), row('จำนวนบิล', s.bills), row(('จำนวน' + U() + 'สุทธิ'), s.net_bowls), row('ยอดขายสุทธิ', baht(s.net_sales)),
    row('ส่วนลด', baht(s.discount)), row('ยกเลิก', `${s.voids.count} บิล ${baht(s.voids.amount)}`), row('คืนเงิน', `${s.refunds.count} ครั้ง ${baht(s.refunds.amount)}`), h('hr'),
    ...s.payments.map((p) => row(names[p.method] || p.method, baht(p.amount))), row('เงินเข้าลิ้นชัก', baht(s.cash_in)), row('เงินออกลิ้นชัก', baht(s.cash_out)),
    h('div', { class: 'r', style: { display: 'flex', justifyContent: 'space-between', fontWeight: 800 } }, h('span', {}, 'เงินสดที่ควรมี'), h('span', {}, baht(s.expected_cash))),
    can('cash_move') && h('div', { class: 'row', style: { marginTop: '.8em' } }, h('button', { class: 'btn', onclick: () => cashMove('in') }, '+ เงินเข้าลิ้นชัก'), h('button', { class: 'btn', onclick: () => cashMove('out') }, '− เงินออกลิ้นชัก')),
    h('button', { class: 'btn', style: { marginTop: '.5em' }, onclick: () => api.post(`/shifts/${s.id}/print`).then(() => toast('ส่งพิมพ์สรุปแล้ว', 'ok')).catch(errToast) }, '🖨 พิมพ์สรุประหว่างรอบ')),
  h('div', {}, h('h4', {}, 'ปิดรอบ'), h('label', { class: 'field' }, 'เงินสดที่นับได้ (บาท)', counted), keypad(counted, { decimal: true }), diffEl));
  const cashMove = async (type) => {
    const amount = await promptBox(type === 'in' ? 'เงินเข้าลิ้นชัก' : 'เงินออกลิ้นชัก', { label: 'จำนวนเงิน (บาท)', type: 'number' }); if (!amount) return;
    const reason = await promptBox('เหตุผล', { label: 'เช่น ทอนเพิ่ม, ซื้อน้ำแข็ง' }); if (!reason) return;
    await api.post('/shifts/cash', { type, amount: toSatang(amount), reason }).then(() => { toast('บันทึกแล้ว', 'ok'); dlg.close(); shiftDialog(); }).catch(errToast);
  };
  const dlg = modal('รอบการขาย · ' + st.terminal.name, body, { wide: true, actions: can('shift') ? [{ label: 'ปิดรอบและพิมพ์รายงาน', class: 'danger', onClick: async () => {
    if (!counted.value) { toast('กรอกเงินสดที่นับได้', 'warn'); return false; }
    if (!(await confirmBox('ยืนยันปิดรอบ', 'หลังปิดรอบจะแก้ไขได้เฉพาะผู้มีสิทธิ์', 'ปิดรอบ', true))) return false;
    const r = await api.post('/shifts/close', { counted_cash: toSatang(counted.value) });
    st.shift = null; renderTop();
    toast(`ปิดรอบแล้ว · ${r.diff === 0 ? 'เงินตรง' : r.diff > 0 ? 'เกิน ' + baht(r.diff) : 'ขาด ' + baht(-r.diff)}`, r.diff === 0 ? 'ok' : 'warn', 8000);
  } }] : [] });
}

// ---------------- devices: printers + customer display ----------------
async function devicesDialog() {
  const printers = await api.get('/printers');
  const sup = support();
  const body = h('div');
  const draw = () => body.replaceChildren(
    h('h4', {}, '🖨️ เครื่องพิมพ์'),
    h('p', { class: 'small muted' }, `อุปกรณ์นี้รองรับ: ${[sup.usb && 'USB (WebUSB)', sup.serial && 'Serial/COM', sup.bluetooth && 'Bluetooth BLE', sup.bridge && 'Android Bridge'].filter(Boolean).join(', ') || 'ไม่มี (ใช้ Print Agent หรือแอป Android)'} · LAN/USB บน PC ใช้ Print Agent (${agentUrl()})`),
    ...printers.filter((p) => p.active).map((p) => h('div', { class: 'card', style: { marginBottom: '.5em' } },
      h('div', { class: 'row between' }, h('div', {}, h('strong', {}, p.name), h('div', { class: 'small muted' }, `${p.conn.toUpperCase()} ${p.address || ''}${p.port ? ':' + p.port : ''} · ${p.paper} มม. · งาน: ${p.roles.join(', ') || '-'}`),
        h('div', { class: 'small' }, isLinkedHere(p.id) ? h('span', { class: 'badge ok' }, 'เชื่อมต่อกับเครื่องนี้') : h('span', { class: 'badge' }, 'ยังไม่เชื่อมกับเครื่องนี้'), p.status ? ` · สถานะล่าสุด: ${p.status}` : '')),
      h('div', { class: 'row' }, h('button', { class: 'btn sm primary', onclick: async () => { try { const r = await pairPrinter(p); await api.put(`/printers/${p.id}`, { host_terminal_id: st.terminal.id }); toast('เชื่อมต่อแล้ว: ' + r.name, 'ok'); st.host.reload(); draw(); reportDevice(); } catch (e) { errToast(e); } } }, isLinkedHere(p.id) ? 'เชื่อมต่อใหม่' : 'ค้นหา/เชื่อมต่อ'),
        isLinkedHere(p.id) && h('button', { class: 'btn sm', onclick: () => testPrint(p, 'all').then((r) => toast('ทดสอบ: ' + (JOB_TH[r.status] || r.status), 'ok')).catch(errToast) }, 'ทดสอบไทย/โลโก้/QR'),
        isLinkedHere(p.id) && h('button', { class: 'btn sm', onclick: () => testPrint(p, 'cut').then(() => toast('สั่งตัดกระดาษแล้ว', 'ok')).catch(errToast) }, 'ทดสอบตัด'),
        isLinkedHere(p.id) ? h('button', { class: 'btn sm', onclick: () => testPrint(p, 'beep').then(() => toast('ส่งคำสั่งเสียงแล้ว — ถ้าไม่ดัง แสดงว่ารุ่นนี้ไม่มี buzzer', 'ok', 5000)).catch(errToast) }, '🔔 ทดสอบเสียงเครื่องพิมพ์') : null,
        isLinkedHere(p.id) && p.options && p.options.cash_drawer ? h('button', { class: 'btn sm', onclick: () => testPrint(p, 'drawer').catch(errToast) }, '💵 เปิดลิ้นชัก') : null,
        isLinkedHere(p.id) && h('button', { class: 'btn sm ghost', onclick: () => { unpairPrinter(p.id); draw(); } }, 'ยกเลิกเชื่อมต่อ'))))),
    can('manage_printers') && h('button', { class: 'btn', onclick: () => addPrinterDialog(() => devicesDialog()) }, '+ เพิ่มเครื่องพิมพ์'),
    h('div', { class: 'row', style: { marginTop: '.5em' } }, h('button', { class: 'btn sm', onclick: () => playSound({ ...st.settings.sound, enabled: true, output: ['pos'] }, 'printed', 'pos') }, '🔊 ทดสอบเสียงพิมพ์สำเร็จ'),
      h('button', { class: 'btn sm', onclick: () => playSound({ ...st.settings.sound, enabled: true }, 'new_order') }, '🔔 เสียงออเดอร์ใหม่'), h('button', { class: 'btn sm', onclick: () => playSound({ ...st.settings.sound, enabled: true }, 'error') }, '⚠️ เสียงผิดพลาด'),
      h('button', { class: 'btn sm', onclick: async () => { const v = await promptBox('ที่อยู่ Print Agent', { value: agentUrl() }); if (v) { store.set('agent_url', v); draw(); } } }, 'ตั้งค่า Print Agent')),
    h('hr'),
    h('h4', {}, '📺 จอลูกค้า'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: pairDisplay }, 'สร้างรหัสจับคู่ (6 หลัก)'), h('button', { class: 'btn', onclick: openSecondScreen }, '🖥️ เปิดบนจอที่สอง (Dual Screen)')),
    h('p', { class: 'small muted' }, 'จอที่สอง: Chrome/Edge บนคอมพิวเตอร์ใช้ Window Management API, แอป Android ใช้ Presentation/SDK ผ่าน OppaBridge — ถ้าอุปกรณ์ไม่รองรับ ให้เปิด ', h('code', {}, location.origin + '/display/'), ' บนจอลูกค้าแล้วกรอกรหัสจับคู่'));
  draw();
  modal('อุปกรณ์ของเครื่องนี้', body, { wide: true });
}
function addPrinterDialog(after) {
  const name = h('input', { class: 'input', value: 'เครื่องพิมพ์ใบเสร็จ' });
  const conn = h('select', { class: 'input' }, [['usb', 'USB (WebUSB บนเครื่องนี้)'], ['lan', 'LAN (IP + Port ผ่าน Print Agent/แอป)'], ['bluetooth', 'Bluetooth'], ['serial', 'Serial/COM'], ['agent_usb', 'USB ผ่าน Print Agent'], ['browser', 'พิมพ์ผ่านเบราว์เซอร์']].map(([v, t]) => h('option', { value: v }, t)));
  const addr = h('input', { class: 'input', placeholder: '192.168.1.100 หรือ /dev/usb/lp0' });
  const port = h('input', { class: 'input', value: '9100', type: 'number' });
  const paper = h('select', { class: 'input' }, h('option', { value: 80 }, '80 มม.'), h('option', { value: 58 }, '58 มม.'));
  // one printer does everything by default (receipt, kitchen ticket, …) so kitchen tickets print on every order
  const roles = ['receipt', 'kitchen', 'merchant', 'queue', 'mobile_qr', 'refund', 'shift', 'redeem'].map((r) => [r, h('input', { type: 'checkbox', checked: !['queue', 'merchant'].includes(r) })]);
  modal('เพิ่มเครื่องพิมพ์', h('div', {}, h('label', { class: 'field' }, 'ชื่อ', name), h('label', { class: 'field' }, 'การเชื่อมต่อ', conn), h('label', { class: 'field' }, 'IP / Path', addr), h('label', { class: 'field' }, 'Port', port),
    h('label', { class: 'field' }, 'ขนาดกระดาษ', paper), h('div', { class: 'row' }, roles.map(([r, cb]) => h('label', { class: 'switch' }, cb, { receipt: 'ใบเสร็จ', kitchen: 'ใบครัว', merchant: 'ใบสรุปร้านค้า', queue: 'ใบคิว', mobile_qr: 'ใบ Mobile', refund: 'ใบยกเลิก/คืนเงิน', shift: 'สรุปรอบ', redeem: 'แลกรางวัล' }[r]))),
    h('p', { class: 'small muted' }, 'ตั้งค่าละเอียด (สำเนา ระยะขอบ การตัด จุดครัว แม่แบบ) ได้ที่เว็บไซต์จัดการร้าน > เครื่องพิมพ์')), { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => {
    await api.post('/printers', { name: name.value, conn: conn.value, address: addr.value, port: Number(port.value), paper: Number(paper.value), roles: roles.filter(([, cb]) => cb.checked).map(([r]) => r), host_terminal_id: st.terminal.id, options: { buzzer_mode: 'all' } });
    toast('เพิ่มแล้ว กด "ค้นหา/เชื่อมต่อ" เพื่อจับคู่กับเครื่องจริง', 'ok'); after && after();
  } }] });
}
async function pairDisplay() {
  const r = await api.post('/display/pairing', { mode: 'link' });
  const url = location.origin + '/display/?code=' + r.code;
  modal('จับคู่จอลูกค้า', h('div', { style: { textAlign: 'center' } }, h('p', {}, 'บนจอลูกค้า เปิด ', h('strong', {}, location.origin + '/display/'), ' แล้วกรอกรหัส'), h('div', { class: 'qbig' }, r.code),
    h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(url), style: { width: '180px' } }), h('p', { class: 'small muted' }, `หรือสแกน QR · รหัสหมดอายุ ${fmtTime(r.expires_at)} · ใช้ได้ครั้งเดียว`)));
}
async function openSecondScreen() {
  const r = await api.post('/display/pairing', { mode: 'dual' });
  const url = `/display/?code=${r.code}&local=${st.terminal.id}`;
  store.set('dual_screen', true);
  if (window.OppaBridge && window.OppaBridge.openCustomerDisplay) { window.OppaBridge.openCustomerDisplay(location.origin + url); return toast('เปิดจอลูกค้าผ่านแอป Android แล้ว', 'ok'); }
  let feat = 'popup=yes,width=1024,height=600';
  try {
    if ('getScreenDetails' in window) {
      const d = await window.getScreenDetails();
      const other = d.screens.find((s) => s !== d.currentScreen) || null;
      if (other) { feat = `popup=yes,left=${other.availLeft},top=${other.availTop},width=${other.availWidth},height=${other.availHeight}`; store.set('dual_screen_label', other.label || 'จอที่ 2'); }
      else toast('ไม่พบจอที่สอง — เปิดหน้าต่างบนจอนี้แทน', 'warn');
    } else toast('เบราว์เซอร์นี้ควบคุมจอที่สองไม่ได้ — ลากหน้าต่างไปจอลูกค้า หรือใช้การจับคู่ด้วยรหัส', 'warn', 7000);
  } catch { toast('ไม่ได้รับอนุญาตจัดการหน้าต่างบนหลายจอ', 'warn'); }
  const w = window.open(url, 'opp-customer-display', feat);
  if (!w) toast('เบราว์เซอร์บล็อกหน้าต่าง — อนุญาต Pop-up สำหรับเว็บไซต์นี้', 'error', 8000);
}
async function manualCut() {
  const printers = (await api.get('/printers')).filter((p) => p.active);
  modal('ตัดกระดาษ', h('div', { class: 'row' }, printers.map((p) => h('button', { class: 'btn big', onclick: async () => {
    try { if (isLinkedHere(p.id)) { await testPrint(p, 'cut'); await api.post('/print/cut', { printer_id: p.id, local: true }); } else await api.post('/print/cut', { printer_id: p.id }); toast('สั่งตัดกระดาษ ' + p.name, 'ok'); } catch (e) { errToast(e); }
  } }, p.name))));
}
function reportDevice() {
  const sup = support();
  api.post(`/terminals/${st.terminal.id}/report`, { ua: navigator.userAgent, support: sup, printers: Object.keys(store.get('printer_links', {})), dual_screen: !!store.get('dual_screen'), at: new Date().toISOString() }).catch(() => {});
}

// ---------------- scanner (USB/Bluetooth keyboard wedge) ----------------
function setupScanner() {
  let buf = '', last = 0;
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (inField && t.id !== 'search') return; // typing in a form
    if (document.querySelector('.modal-back')) return;
    const now = performance.now();
    if (now - last > 80) buf = '';
    last = now;
    if (e.key === 'Enter') {
      if (buf.length >= 4 && !inField) {
        e.preventDefault();
        const code = buf; buf = '';
        if (addByCode(code)) return;
        // bill barcode from the merchant copy / receipt → open that bill
        if (/^[A-Z]+\d{6}-\d{4}$/i.test(code)) { api.get('/orders/by-bill/' + encodeURIComponent(code)).then((r) => openOrder(r.id)).catch(errToast); return; }
        if (/^[A-Z0-9]{8,12}$/i.test(code) && can('redeem')) couponDialog(code.toUpperCase()); else toast('ไม่พบสินค้าจากบาร์โค้ด ' + code, 'error');
      }
      return;
    }
    if (e.key.length === 1 && !inField) buf += e.key;
  });
}

// ---------------- auto lock ----------------
function setupAutoLock() {
  const mins = Number(st.settings.sale.auto_lock_minutes) || 0;
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { st.lastActivity = Date.now(); }, true));
  if (mins > 0) setInterval(() => { if (!st.locked && Date.now() - st.lastActivity > mins * 60000) lockNow(); }, 15000);
}
function lockNow() {
  st.locked = true;
  const pin = h('input', { class: 'input pin', type: 'password', inputmode: 'numeric', placeholder: 'PIN' });
  const go = async () => { try { const r = await api.post('/auth/unlock', { pin: pin.value }); if (r.ok) { el.remove(); st.locked = false; st.lastActivity = Date.now(); } } catch (e) { errToast(e); pin.value = ''; } };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const el = h('div', { class: 'lock' }, h('div', { class: 'card', style: { width: 'min(380px, 92vw)' } }, h('h3', {}, '🔒 หน้าจอถูกล็อก'), h('p', { class: 'muted' }, st.staff.name), pin, h('div', { style: { marginTop: '.6em' } }, keypad(pin, { onEnter: go })),
    h('button', { class: 'btn ghost block', style: { marginTop: '.5em' }, onclick: logout }, 'สลับผู้ใช้')));
  document.body.append(el); pin.focus();
}
async function logout() { await api.post('/auth/logout').catch(() => {}); store.del('staff_token'); location.reload(); }

window.addEventListener('beforeunload', () => { if (st.sock) pushDisplay({ phase: 'idle' }); });
boot().catch((e) => { console.error(e); app.replaceChildren(h('div', { class: 'empty' }, 'โหลดไม่สำเร็จ: ' + e.message, h('br'), h('button', { class: 'btn', onclick: () => location.reload() }, 'ลองใหม่'))); });
storageWarning();
