import { store, socket, storageWarning } from '/shared/api.js';
import { loginHero } from '/shared/ui.js';
import { h, $, toast, errToast, modal, keypad, fmtTime, fmtDateOnly, STATUS_TH, SOURCE_TH, PREP_TH, debounce } from '/shared/ui.js';
import { baht, dineLabel, latestOnly, VERSION } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { applyFonts } from '/shared/fonts.js';
import { api, ctx, can, page, card, kpi, money, table, barChart } from './common.js';
import { menuPage, stockPage, staffPage, tablesPage } from './menu.js';
import { membersPage, memberDetail, resetsPage, tiersPage, rewardsPage } from './members.js';
import { settingsPage, displayPage, fontsPage, printersPage, devicesPage, auditPage, paymentsPage } from './settings.js';
import { designerPage } from './designer.js';
import { livePage } from './live.js';
import { labelsPage } from './labels.js';
import { themePage } from './theme.js';
import { assistantPage } from './assistant.js';

const U = () => (ctx.settings && ctx.settings.sale.count_unit) || 'ชาม';
const app = $('#app');
let sock = null;
const ROUTES = [
  ['ภาพรวม', [['dashboard', '📊 ยอดขายวันนี้', 'view_sales'], ['live', '🔴 Live View หน้าร้าน', 'view_sales'], ['bills', '🧾 ประวัติบิล', 'view_sales'], ['reports', '📈 รายงาน', 'view_sales']]],
  ['ร้าน', [['menu', '🍜 เมนูและสินค้า', 'manage_menu'], ['assistant', '✨ ผู้ช่วยเพิ่มสินค้า', 'manage_menu'], ['labels', '🏷️ พิมพ์บาร์โค้ดสินค้า', 'manage_menu'], ['stock', '📦 สต็อก', 'manage_stock'], ['tables', '🪑 โต๊ะ', 'manage_tables'], ['staff', '👥 พนักงานและสิทธิ์', 'manage_staff']]],
  ['สมาชิก', [['members', '⭐ สมาชิก', 'manage_members'], ['resets', '🔑 คำขอรีเซ็ตรหัส', 'member_reset'], ['tiers', '👑 Tier Member', 'settings'], ['rewards', '🎁 ของรางวัล', 'manage_members']]],
  ['ตั้งค่า', [['settings', '⚙️ ตั้งค่าร้าน', 'settings'], ['theme', '🎨 ธีมและรูปแบบ', 'settings'], ['payments', '💳 การรับชำระเงิน', 'settings'], ['designer', '🖨️ ออกแบบเอกสาร', 'settings'], ['fonts', '🔤 ฟอนต์', 'settings'],
    ['display', '📺 จอลูกค้า', 'settings'], ['printers', '🖨️ เครื่องพิมพ์', 'manage_printers'], ['devices', '💻 เครื่องขาย/อุปกรณ์', 'settings'], ['audit', '📜 ประวัติการแก้ไข', 'settings']]],
];

async function boot() {
  if (!store.get('admin_token')) return login();
  try { ctx.staff = (await api.get('/auth/me')).staff; } catch { return login(); }
  ctx.settings = await api.get('/settings');
  applyFonts(ctx.settings.fonts, 'admin'); applyTheme(ctx.settings.theme);
  sock = await socket({ kind: 'staff', token: store.get('admin_token') });
  window.addEventListener('hashchange', route);
  route();
}
function login() {
  const code = h('input', { class: 'input', placeholder: 'รหัสพนักงาน', inputmode: 'numeric', autocomplete: 'username' });
  const pin = h('input', { class: 'input', type: 'password', placeholder: 'PIN', inputmode: 'numeric', autocomplete: 'current-password' });
  const go = async () => { try { const r = await api.post('/auth/login', { code: code.value, pin: pin.value }, { token: null }); store.set('admin_token', r.token); store.del('admin_from_pos'); location.reload(); } catch (e) { errToast(e); } };
  pin.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  app.replaceChildren(loginHero('เว็บไซต์จัดการร้าน', 'ดูยอดขายวันนี้ รายงาน เมนู สมาชิก และตั้งค่าร้านได้จากทุกที่', h('div', { class: 'card' }, h('h2', {}, 'เข้าสู่ระบบ'), h('p', { class: 'muted' }, 'สำหรับเจ้าของและผู้จัดการ'),
    h('label', { class: 'field' }, 'รหัสพนักงาน', code), h('label', { class: 'field' }, 'PIN', pin), keypad(pin, { onEnter: go }), h('p', { class: 'version' }, 'v' + VERSION))));
}
const fromPos = !!store.get('admin_from_pos');
function backToPos(e) { e && e.preventDefault(); store.del('admin_token'); store.del('admin_from_pos'); location.href = '/pos/'; }
function shell(r, content) {
  const side = h('nav', { class: 'side' }, h('div', { class: 'brandbox' }, h('img', { src: '/assets/bowl.svg', alt: '' }),
      h('div', {}, h('b', {}, ctx.settings.store.name), h('small', {}, ctx.staff.name, ' · ', ctx.staff.role_name))),
    ...ROUTES.flatMap(([g, items]) => {
      const vis = items.filter(([, , p]) => can(p));
      return vis.length ? [h('h4', {}, g), ...vis.map(([k, t]) => h('a', { href: '#/' + k, class: r === k ? 'on' : '', onclick: () => side.classList.remove('open') }, t))] : [];
    }),
    // opened from the POS app: everything stays in this window, and leaving goes back to the sales screen (the POS session stays signed in)
    ...(fromPos ? [h('h4', {}, 'ลิงก์'), h('a', { href: '/kitchen/' }, '👩‍🍳 จอครัว'), h('a', { href: '/guide/' }, '📖 คู่มือ'), h('a', { href: '/pos/', class: 'backpos', onclick: backToPos }, '← กลับหน้าขาย POS')]
      : [h('h4', {}, 'ลิงก์'), h('a', { href: '/pos/', target: '_blank' }, '🛒 หน้าขาย POS'), h('a', { href: '/kitchen/', target: '_blank' }, '👩‍🍳 จอครัว'), h('a', { href: '/display/', target: '_blank' }, '📺 จอลูกค้า'),
        h('a', { href: '/member/', target: '_blank' }, '⭐ เว็บไซต์สมาชิก'), h('a', { href: '/guide/', target: '_blank' }, '📖 คู่มือ'),
        h('a', { href: '#', onclick: async (e) => { e.preventDefault(); await api.post('/auth/logout').catch(() => {}); store.del('admin_token'); location.reload(); } }, '🚪 ออกจากระบบ')]),
    h('p', { class: 'version', style: { padding: '0 .5em' } }, `เวอร์ชัน ${VERSION}`));
  app.replaceChildren(h('div', { class: 'topm' }, h('button', { class: 'btn sm', onclick: () => side.classList.toggle('open') }, '☰'), h('strong', {}, ctx.settings.store.name),
      fromPos ? h('a', { href: '/pos/', class: 'btn sm primary', style: { marginLeft: 'auto' }, onclick: backToPos }, '← หน้าขาย') : null),
    fromPos ? h('a', { href: '/pos/', class: 'backpos-fab', onclick: backToPos }, '← กลับหน้าขาย POS') : null,
    h('div', { class: 'layout' }, side, h('main', { class: 'content', id: 'content' }, content)));
}
async function route() {
  const [, r0, arg] = location.hash.split('/');
  const first = ROUTES.flatMap(([, i]) => i).find(([, , p]) => can(p));
  const r = r0 || (can('view_sales') ? 'dashboard' : first ? first[0] : 'dashboard');
  document.querySelectorAll('.modal-back').forEach((m) => m.remove()); // navigating closes open dialogs
  if (r !== 'theme') applyTheme(ctx.settings.theme); // drop an unsaved theme preview
  sock.off('sales:changed'); sock.off('connect'); sock.off('disconnect'); sock.off('live:update');
  shell(r, h('div', { class: 'empty' }, 'กำลังโหลด…'));
  const set = (node) => { const c = $('#content'); if (c) c.replaceChildren(node); };
  try {
    if (r === 'bill' && arg) { // from the QR on the merchant copy
      const found = await api.get('/orders/by-bill/' + encodeURIComponent(decodeURIComponent(arg)));
      location.hash = '#/bills'; setTimeout(() => billDetail(found.id), 300); return;
    }
    const pages = { dashboard, live: () => livePage(sock), labels: labelsPage, theme: themePage, assistant: assistantPage, bills: billsPage, reports: reportsPage, menu: menuPage, stock: stockPage, tables: tablesPage, staff: staffPage, members: arg ? () => memberDetail(arg) : membersPage,
      resets: resetsPage, tiers: tiersPage, rewards: rewardsPage, settings: settingsPage, payments: paymentsPage, designer: designerPage, fonts: fontsPage, display: displayPage,
      printers: printersPage, devices: devicesPage, audit: auditPage };
    const fn = pages[r] || dashboard;
    set(await fn(set));
  } catch (e) { set(h('div', { class: 'card' }, h('h3', {}, '⚠️ ', e.message), h('button', { class: 'btn', onclick: route }, 'ลองใหม่'))); }
}

// ---------------- dashboard (today first) ----------------
async function dashboard() {
  const box = h('div');
  const status = h('div', { class: 'row' });
  const guard = latestOnly();
  let lastOk = null, stale = false;
  const names = Object.fromEntries(ctx.settings.sale.payment_methods.map((m) => [m.id, m.name]));
  names.online = 'ออนไลน์ (Gateway)';
  const draw = (d) => {
    box.replaceChildren(
      h('div', { class: 'cards' },
        kpi('ยอดขายสุทธิวันนี้', money(d.net_sales), `ยอดขาย ${baht(d.gross_sales)} − ยกเลิก/คืน ${baht(d.voids.amount + d.refunds.amount)}`, true),
        kpi('บิลที่ชำระสำเร็จ', d.bills_paid.toLocaleString(), `ยกเลิก ${d.bills_voided} บิล`, true),
        kpi(('จำนวน' + U() + 'สุทธิ'), d.bowls_net.toLocaleString(), `ขาย ${d.bowls_sold} · ยกเลิก/คืน ${d.bowls_cancelled}`, true),
        d.cost !== undefined ? kpi('ต้นทุนขาย', money(d.cost), 'ต้นทุน ณ เวลาขาย') : null,
        d.gross_profit !== undefined ? kpi('กำไรขั้นต้น', money(d.gross_profit), `อัตรากำไร ${d.margin_pct}% · ยังไม่หักค่าใช้จ่ายร้าน`) : null,
        kpi('ส่วนลด', money(d.discount)), kpi('คืนเงิน', money(d.refunds.amount), `${d.refunds.count} ครั้ง`), kpi('บิลยกเลิก', money(d.voids.amount), `${d.voids.count} บิล`),
        kpi('รอชำระ (ไม่นับเป็นยอดขาย)', money(d.pending_payment.amount), `${d.pending_payment.count} ออเดอร์`)),
      card(h('h3', {}, 'ยอดรับเงินจริงแยกช่องทาง'), table([{ t: 'ช่องทาง', f: (p) => names[p.method] || p.method }, { t: 'รับ', r: 1, f: (p) => baht(p.amount) }, { t: 'คืน', r: 1, f: (p) => baht(p.refunded) }, { t: 'สุทธิ', r: 1, f: (p) => baht(p.net) }, { t: 'รายการ', r: 1, k: 'count' }], d.payments)),
      card(h('h3', {}, 'ยอดขายรายชั่วโมง (บาท)'), barChart(Object.entries(d.by_hour).sort().map(([k, v]) => ({ x: k + ':00', short: k, y: v / 100 })), { fmt: (v) => Math.round(v).toLocaleString() })),
      card(h('h3', {}, 'บิลล่าสุด'), table([{ t: 'เวลา', f: (o) => fmtTime(o.paid_at) }, { t: 'บิล', k: 'bill_no' }, { t: 'คิว', k: 'queue_no' }, { t: 'ที่มา', f: (o) => SOURCE_TH[o.source] },
        { t: 'ประเภท', f: (o) => dineLabel(o.dine_type) }, { t: 'สถานะ', f: (o) => STATUS_TH[o.status] }, { t: (U()), r: 1, k: 'bowls' }, { t: 'ยอด', r: 1, f: (o) => baht(o.total) }], d.recent, { onRow: (o) => billDetail(o.id) })),
      h('p', { class: 'small muted' }, `วันขาย ${fmtDateOnly(d.business_date)} · ช่วงเวลาจริง ${d.range.start} ถึงก่อน ${d.range.end} (${d.range.timezone})`, d.profit_note ? ' · ' + d.profit_note : ''));
  };
  const drawStatus = () => status.replaceChildren(
    h('button', { class: 'btn primary', id: 'refresh', onclick: () => refresh(true) }, '⟳ Refresh'),
    h('a', { class: 'btn live-btn', href: '#/live' }, h('i'), 'Live View หน้าร้าน'),
    h('span', { class: 'small muted' }, lastOk ? `อัปเดตสำเร็จล่าสุด ${lastOk.toLocaleTimeString('th-TH')}` : 'กำลังโหลด…'),
    !sock.connected || stale ? h('span', { class: 'stale' }, '⚠️ ขาดการเชื่อมต่อ — ข้อมูลอาจยังไม่อัปเดต') : h('span', { class: 'badge ok' }, '● เรียลไทม์'));
  // rapid clicks are coalesced; an older response never overwrites a newer one; this is read-only so totals can't double
  const refresh = async (manual) => {
    try {
      const r = await guard(() => api.get('/dashboard'), { coalesce: !manual ? true : true });
      if (r.fresh) { draw(r.value); lastOk = new Date(); stale = false; }
    } catch (e) { stale = true; if (manual) errToast(e); }
    drawStatus();
  };
  sock.on('sales:changed', debounce(() => refresh(false), 600));
  sock.on('connect', () => { drawStatus(); refresh(false); });
  sock.on('disconnect', () => { stale = true; drawStatus(); });
  drawStatus(); refresh(false);
  return page('ยอดขายวันนี้', status, box);
}

// ---------------- bills ----------------
async function billsPage() {
  const terms = await api.get('/terminals');
  const shifts = await api.get('/shifts');
  const f = { q: '', preset: 'today', from: '', to: '', status: '', source: '', dine_type: '', terminal_id: '', shift_id: '' };
  const res = h('div');
  const sel = (k, opts) => { const s = h('select', { class: 'input', style: { width: 'auto' } }, opts.map(([v, t]) => h('option', { value: v }, t))); s.addEventListener('change', () => { f[k] = s.value; load(); }); return s; };
  const q = h('input', { class: 'input', placeholder: 'ค้นหาเลขบิล / เลขคิว / ชื่อลูกค้า', style: { maxWidth: '280px' } });
  q.addEventListener('input', debounce(() => { f.q = q.value; load(); }, 300));
  const from = h('input', { class: 'input', type: 'date', style: { width: 'auto' } }); const to = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  [from, to].forEach((x) => x.addEventListener('change', () => { f.preset = from.value ? 'custom' : 'today'; f.from = from.value; f.to = to.value || from.value; load(); }));
  const load = async () => {
    const p = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const rows = await api.get('/bills?' + p);
    res.replaceChildren(h('p', { class: 'small muted' }, `${rows.length} บิล`), table([{ t: 'เวลา', f: (o) => fmtTime(o.paid_at || o.created_at) }, { t: 'บิล', k: 'bill_no' }, { t: 'คิว', k: 'queue_no' },
      { t: 'สถานะ', f: (o) => h('span', { class: 'badge ' + (o.status === 'paid' ? 'ok' : o.status === 'void' ? 'bad' : 'warn') }, STATUS_TH[o.status]) }, { t: 'ที่มา', f: (o) => SOURCE_TH[o.source] },
      { t: 'ประเภท', f: (o) => dineLabel(o.dine_type) }, { t: 'โต๊ะ/ลูกค้า', f: (o) => [o.table_name, o.customer_name].filter(Boolean).join(' · ') }, { t: 'พนักงาน', k: 'staff_name' }, { t: 'เครื่อง', k: 'terminal_name' },
      { t: (U()), r: 1, k: 'bowls' }, { t: 'ยอด', r: 1, f: (o) => baht(o.total) }, { t: 'คืน', r: 1, f: (o) => (o.refunded_amount ? baht(o.refunded_amount) : '') }], rows, { onRow: (o) => billDetail(o.id, load) }));
  };
  load();
  return page('ประวัติบิล', h('div', { class: 'bar' }, q, sel('preset', [['today', 'วันนี้'], ['yesterday', 'เมื่อวาน'], ['last7', '7 วัน'], ['month', 'เดือนนี้']]), from, to,
    sel('status', [['', 'ทุกสถานะ'], ['paid', 'ชำระแล้ว'], ['void', 'ยกเลิก'], ['pending_payment', 'รอชำระ'], ['held', 'พักบิล'], ['open', 'เปิดบิล'], ['expired', 'หมดอายุ']]),
    sel('source', [['', 'ทุกแหล่ง'], ['pos', 'POS'], ['mobile_table', 'Mobile โต๊ะ'], ['mobile_pickup', 'Mobile Pick Up']]), sel('dine_type', [['', 'ทุกประเภท'], ['dine_in', 'ทานที่ร้าน'], ['takeaway', 'กลับบ้าน'], ['mixed', 'ผสม']]),
    sel('terminal_id', [['', 'ทุกเครื่อง'], ...terms.map((t) => [t.id, t.name])]), sel('shift_id', [['', 'ทุกรอบ'], ...shifts.map((s) => [s.id, `${s.terminal_name} ${fmtTime(s.opened_at)}`])])), res);
}
export async function billDetail(id, after) {
  const o = await api.get('/orders/' + id);
  const names = Object.fromEntries(ctx.settings.sale.payment_methods.map((m) => [m.id, m.name]));
  const acts = [];
  if (o.status === 'paid' && can('refund')) acts.push({ label: 'คืนเงิน', onClick: () => refundDialog(o, after) });
  if (['paid', 'open', 'held', 'pending_payment'].includes(o.status) && can('void_bill')) acts.push({ label: 'ยกเลิกบิล', class: 'danger', onClick: async () => {
    const reason = prompt('เหตุผลการยกเลิก'); if (!reason) return false;
    await api.post(`/orders/${o.id}/void`, { reason }); toast('ยกเลิกแล้ว', 'ok'); after && after();
  } });
  if (o.status === 'paid' && can('reprint')) acts.push({ label: 'พิมพ์ใบเสร็จซ้ำ', close: false, onClick: async () => { await api.post(`/orders/${o.id}/print`, { doc: 'receipt' }); toast('ส่งพิมพ์ซ้ำแล้ว', 'ok'); } });
  modal(`บิล ${o.bill_no}`, h('div', {},
    h('p', {}, h('span', { class: 'badge' }, STATUS_TH[o.status]), ' ', SOURCE_TH[o.source], ' · ', dineLabel(o.dine_type), o.table_name ? ` · โต๊ะ ${o.table_name}` : '', ' · คิว ', o.queue_no || '-'),
    h('p', { class: 'small muted' }, `สร้าง ${fmtTime(o.created_at)} · ชำระ ${fmtTime(o.paid_at)} · วันขาย ${o.paid_business_date || o.business_date} · พนักงาน ${o.staff_name || '-'}${o.member ? ' · สมาชิก ' + o.member.member_no : ''}`),
    table([{ t: 'รายการ', f: (i) => h('div', {}, i.name, h('div', { class: 'small muted' }, i.options.map((x) => x.name).join(', '), i.note ? ' · ' + i.note : '')) }, { t: 'ประเภท', f: (i) => dineLabel(i.dine_type) },
      { t: (U()), f: (i) => (i.bowl_group ? (U() + 'ที่ ') + i.bowl_group : '') }, { t: 'จำนวน', r: 1, f: (i) => i.qty - i.void_qty }, { t: 'คืน', r: 1, k: 'refunded_qty' }, { t: 'ยอด', r: 1, f: (i) => baht(i.line_total) },
      can('view_cost') ? { t: 'ต้นทุน/หน่วย', r: 1, f: (i) => baht(i.cost_unit) } : null].filter(Boolean), o.items),
    h('div', { class: 'cards', style: { marginTop: '1em' } }, kpi('ยอดสุทธิ', money(o.total)), kpi('ส่วนลด', money(o.discount)), kpi('ภาษี', money(o.tax)), kpi(('จำนวน' + U()), o.bowls), o.refunded_amount ? kpi('คืนเงิน', money(o.refunded_amount), `${o.refunded_bowls} ${U()}`) : null,
      can('view_cost') && o.cost_total !== undefined ? kpi('ต้นทุน', money(o.cost_total)) : null),
    h('h4', {}, 'การชำระเงิน'), table([{ t: 'ช่องทาง', f: (p) => names[p.method] || p.method }, { t: 'สถานะ', k: 'status' }, { t: 'ยอด', r: 1, f: (p) => baht(p.amount) }, { t: 'รับ', r: 1, f: (p) => baht(p.received) }, { t: 'ทอน', r: 1, f: (p) => baht(p.change_amount) }, { t: 'เวลา', f: (p) => fmtTime(p.created_at) }], o.payments),
    o.refunds.length ? h('div', {}, h('h4', {}, 'ประวัติยกเลิก/คืนเงิน'), table([{ t: 'เวลา', f: (r) => fmtTime(r.created_at) }, { t: 'ประเภท', f: (r) => (r.kind === 'void' ? 'ยกเลิกบิล' : 'คืนเงิน') }, { t: 'เหตุผล', k: 'reason' },
      { t: 'รายการ', f: (r) => r.items.map((i) => `${i.name}×${i.qty}`).join(', ') }, { t: 'ยอด', r: 1, f: (r) => baht(r.amount) }, { t: (U()), r: 1, k: 'bowls' }], o.refunds)) : null,
    h('h4', {}, 'ใบครัวและงานพิมพ์'), table([{ t: 'เวลา', f: (j) => fmtTime(j.created_at) }, { t: 'เอกสาร', k: 'doc_type' }, { t: 'สถานะ', k: 'status' }, { t: 'ครั้ง', k: 'attempts' }, { t: 'ข้อผิดพลาด', k: 'error' }], o.print_jobs)), { wide: true, actions: acts });
}
function refundDialog(o, after) {
  const qty = new Map();
  const rows = o.items.filter((i) => i.qty - i.void_qty - i.refunded_qty > 0).map((i) => {
    const left = i.qty - i.void_qty - i.refunded_qty;
    const inp = h('input', { class: 'input', type: 'number', min: 0, max: left, value: 0, style: { width: '90px' } });
    inp.addEventListener('input', () => qty.set(i.id, Math.min(left, Math.max(0, Number(inp.value) || 0))));
    return h('tr', {}, h('td', {}, i.name, ` (คืนได้ ${left})`), h('td', {}, inp));
  });
  const reason = h('input', { class: 'input', placeholder: 'เหตุผล' });
  const restock = h('input', { type: 'checkbox', checked: true });
  const key = crypto.randomUUID();
  modal('คืนเงิน ' + o.bill_no, h('div', {}, h('table', { class: 'table' }, h('tbody', {}, rows)), h('label', { class: 'field' }, 'เหตุผล', reason), h('label', { class: 'switch' }, restock, 'คืนสต็อก')), { actions: [{ label: 'คืนเงิน', class: 'danger', onClick: async () => {
    const items = [...qty.entries()].filter(([, q]) => q > 0).map(([item_id, q]) => ({ item_id, qty: q }));
    const r = await api.post(`/orders/${o.id}/refund`, { items, reason: reason.value, restock: restock.checked, idempotency_key: key });
    toast(`คืนเงิน ${baht(r.amount)} บาท`, 'ok'); after && after();
  } }] });
}

// ---------------- reports ----------------
async function reportsPage() {
  const q = { preset: 'today', from: '', to: '', source: '', week_start: ctx.settings.week_start ?? 1 };
  const out = h('div');
  const names = Object.fromEntries(ctx.settings.sale.payment_methods.map((m) => [m.id, m.name])); names.online = 'ออนไลน์';
  const presets = [['today', 'วันนี้'], ['yesterday', 'เมื่อวาน'], ['last7', 'ย้อนหลัง 7 วัน'], ['week', 'สัปดาห์นี้'], ['month', 'เดือนนี้'], ['custom', 'กำหนดเอง']];
  const tabs = h('div', { class: 'tabs' });
  const from = h('input', { class: 'input', type: 'date', style: { width: 'auto' } }); const to = h('input', { class: 'input', type: 'date', style: { width: 'auto' } });
  const src = h('select', { class: 'input', style: { width: 'auto' } }, [['', 'ทุกแหล่งที่มา'], ['pos', 'POS'], ['mobile_table', 'Mobile Ordering แบบโต๊ะ'], ['mobile_pickup', 'Mobile Ordering แบบ Pick Up']].map(([v, t]) => h('option', { value: v }, t)));
  const ws = h('select', { class: 'input', style: { width: 'auto' } }, [[1, 'สัปดาห์เริ่มวันจันทร์'], [0, 'สัปดาห์เริ่มวันอาทิตย์'], [6, 'สัปดาห์เริ่มวันเสาร์']].map(([v, t]) => h('option', { value: v, selected: Number(q.week_start) === v }, t)));
  let mode = 'daily';
  const drawTabs = () => tabs.replaceChildren(...presets.map(([k, t]) => h('button', { class: 'tab' + (q.preset === k ? ' active' : ''), onclick: () => { q.preset = k; drawTabs(); if (k !== 'custom') load(); } }, t)));
  [from, to].forEach((x) => x.addEventListener('change', () => { q.preset = 'custom'; q.from = from.value; q.to = to.value || from.value; drawTabs(); if (q.from) load(); }));
  src.addEventListener('change', () => { q.source = src.value; load(); });
  ws.addEventListener('change', () => { q.week_start = ws.value; load(); });
  const guard = latestOnly();
  const load = async () => {
    const p = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== '')).toString();
    const r = await guard(() => api.get('/reports?' + p), { coalesce: false });
    if (!r.fresh) return;
    const d = r.value, s = d.summary;
    const exp = (w) => h('a', { class: 'btn sm', href: '#', onclick: async (e) => { e.preventDefault(); const res = await fetch(`/api/export/${w}.csv?${p}`, { headers: { Authorization: 'Bearer ' + store.get('admin_token') } }); if (!res.ok) return toast('ส่งออกไม่ได้ (ไม่มีสิทธิ์)', 'error'); const b = await res.blob(); const a = h('a', { href: URL.createObjectURL(b), download: `${w}-${d.range.from}-${d.range.to}.csv` }); a.click(); } }, '⬇ ' + w + '.csv');
    const series = mode === 'daily' ? d.daily.map((x) => ({ x: x.day, short: x.day.slice(8), y: x.net / 100 })) : d.monthly.map((x) => ({ x: x.month, short: x.month.slice(2), y: x.net / 100 }));
    out.replaceChildren(
      h('p', { class: 'small muted' }, `${d.range.label}: วันขาย ${fmtDateOnly(d.range.from)} – ${fmtDateOnly(d.range.to)} · ช่วงเวลาจริง ${d.range.start} ถึงก่อน ${d.range.end} (${d.range.timezone})`),
      h('div', { class: 'cards' }, kpi('ยอดขายสุทธิ', money(s.net_sales), null, true), kpi('ยอดรับเงิน (สุทธิ)', money(s.payments.reduce((a, x) => a + x.net, 0))), kpi('จำนวนบิล', s.bills_paid, `ยกเลิก ${s.bills_voided}`, true),
        kpi(('จำนวน' + U() + 'สุทธิ'), s.bowls_net, `ขาย ${s.bowls_sold} · ยกเลิก/คืน ${s.bowls_cancelled}`, true), s.cost !== undefined ? kpi('ต้นทุนขาย', money(s.cost)) : null,
        s.gross_profit !== undefined ? kpi('กำไรขั้นต้น', money(s.gross_profit), `${s.margin_pct}%`) : null, kpi('ส่วนลด', money(s.discount)), kpi('คืนเงิน', money(s.refunds.amount)), kpi('ยกเลิก', money(s.voids.amount))),
      s.profit_note ? h('p', { class: 'small muted' }, s.profit_note) : null,
      card(h('div', { class: 'row between' }, h('h3', {}, 'ยอดขายสุทธิ (บาท)'), h('div', { class: 'tabs' }, [['daily', 'รายวัน'], ['monthly', 'รายเดือน']].map(([k, t]) => h('button', { class: 'tab' + (mode === k ? ' active' : ''), onclick: () => { mode = k; load(); } }, t)))),
        barChart(series, { fmt: (v) => Math.round(v).toLocaleString() }),
        h('details', {}, h('summary', {}, 'ดูเป็นตาราง'), table([{ t: mode === 'daily' ? 'วัน' : 'เดือน', f: (x) => x.day || x.month }, { t: 'ยอดสุทธิ', r: 1, f: (x) => baht(x.net) }, { t: 'บิล', r: 1, k: 'bills' }, { t: (U()), r: 1, k: 'bowls' }], mode === 'daily' ? d.daily : d.monthly))),
      h('div', { class: 'grid2' },
        card(h('h3', {}, 'ทานที่ร้าน vs กลับบ้าน'), table([{ t: 'ประเภท', f: (x) => dineLabel(x.dine_type) }, { t: 'จำนวน', r: 1, k: 'qty' }, { t: 'ยอด', r: 1, f: (x) => baht(x.amount) }], d.by_dine)),
        card(h('h3', {}, 'ช่องทางชำระ'), table([{ t: 'ช่องทาง', f: (x) => names[x.method] || x.method }, { t: 'รับ', r: 1, f: (x) => baht(x.amount) }, { t: 'คืน', r: 1, f: (x) => baht(x.refunded) }, { t: 'สุทธิ', r: 1, f: (x) => baht(x.net) }], s.payments)),
        card(h('h3', {}, 'แหล่งที่มา'), table([{ t: 'แหล่ง', f: (x) => SOURCE_TH[x.source] || x.source }, { t: 'บิล', r: 1, k: 'bills' }, { t: (U()), r: 1, k: 'bowls' }, { t: 'ยอด', r: 1, f: (x) => baht(x.amount) }], d.by_source)),
        card(h('h3', {}, 'พนักงาน'), table([{ t: 'ชื่อ', k: 'name' }, { t: 'บิล', r: 1, k: 'bills' }, { t: (U()), r: 1, k: 'bowls' }, { t: 'ยอด', r: 1, f: (x) => baht(x.amount) }], d.by_staff))),
      card(h('h3', {}, 'ยอดขายแยกหมวดหมู่'), table([{ t: 'หมวด', k: 'name' }, { t: 'จำนวน', r: 1, k: 'qty' }, { t: 'ยอด', r: 1, f: (x) => baht(x.amount) }, can('view_cost') ? { t: 'ต้นทุน', r: 1, f: (x) => baht(x.cost) } : null].filter(Boolean), d.by_category)),
      card(h('h3', {}, 'ยอดขายแยกสินค้า'), table([{ t: 'สินค้า', k: 'name' }, { t: 'จำนวนสุทธิ', r: 1, k: 'qty' }, { t: 'ยอด', r: 1, f: (x) => baht(x.amount) }, can('view_cost') ? { t: 'ต้นทุน', r: 1, f: (x) => baht(x.cost) } : null,
        can('view_cost') ? { t: 'กำไรขั้นต้น', r: 1, f: (x) => baht(x.amount - x.cost) } : null].filter(Boolean), d.by_product)),
      card(h('h3', {}, 'ของรางวัลที่แลกด้วยแต้ม (ไม่รวมในยอดขาย)'), table([{ t: 'รางวัล', k: 'name' }, { t: 'จำนวน', r: 1, k: 'n' }, { t: 'แต้ม', r: 1, k: 'points' }, can('view_cost') ? { t: 'ต้นทุนรางวัล', r: 1, f: (x) => baht(x.cost) } : null].filter(Boolean), d.rewards)),
      can('export') ? h('div', { class: 'row' }, h('strong', {}, 'ส่งออก:'), exp('bills'), exp('items'), exp('payments'), exp('refunds')) : null);
  };
  drawTabs(); load().catch(errToast);
  return page('รายงาน', h('div', { class: 'bar' }, tabs), h('div', { class: 'bar' }, from, h('span', {}, 'ถึง'), to, src, ws), out);
}

boot().catch((e) => app.replaceChildren(h('div', { class: 'empty' }, e.message)));
storageWarning();
