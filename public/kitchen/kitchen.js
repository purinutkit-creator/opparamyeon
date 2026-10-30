import { makeApi, store, socket, uid } from '/shared/api.js';
import { h, $, toast, errToast, modal, keypad, JOB_TH, loginHero } from '/shared/ui.js';
import { dineLabel, VERSION, isAddon } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { applyFonts } from '/shared/fonts.js';
import { PrintHost, pairPrinter, isLinkedHere, testPrint } from '/shared/printers.js';
import { playSound, unlock } from '/shared/sound.js';

const api = makeApi({ tokenKey: 'kitchen_token', onUnauthorized: () => { store.del('kitchen_token'); location.reload(); } });
const app = $('#app');
let settings, staff, tickets = [], stations = [], station = store.get('kitchen_station', 'all'), sock, host;
const U = () => (settings && settings.sale.count_unit) || 'ชาม';
const deviceId = store.get('kitchen_device') || (store.set('kitchen_device', 'kitchen-' + uid().slice(0, 8)), store.get('kitchen_device'));

async function boot() {
  settings = await fetch('/api/settings/public').then((r) => r.json());
  applyFonts(settings.fonts, 'kitchen_screen'); applyTheme(settings.theme);
  document.addEventListener('pointerdown', unlock);
  if (!store.get('kitchen_token')) return login();
  try { staff = (await api.get('/auth/me')).staff; } catch { return login(); }
  stations = await api.get('/stations');
  await load();
  sock = await socket({ kind: 'staff', token: store.get('kitchen_token') });
  sock.on('kitchen:ticket', (t) => {
    tickets.push({ ...t, status: t.kind === 'void' ? 'void' : 'new', created_at: new Date().toISOString() });
    if (station === 'all' || t.station_id === station) { playSound(settings.sound, t.kind === 'void' ? 'error' : 'new_order', 'kitchen'); toast(t.kind === 'void' ? `ยกเลิกรายการ คิว ${t.content.queue_no}` : `ออเดอร์ใหม่ คิว ${t.content.queue_no}`, t.kind === 'void' ? 'error' : 'warn'); }
    draw();
  });
  sock.on('kitchen:status', (e) => { const t = tickets.find((x) => x.id === e.id); if (t) { t.status = e.status; draw(); } });
  // the "ติ๊ด ๆ ๆ ๆ" on the kitchen device follows the printer's real result (printed / accepted)
  sock.on('print:status', (j) => {
    if (j.doc_type !== 'kitchen') return;
    if (j.status === 'printed' || (j.status === 'sent' && settings.sound.on === 'sent')) { if (!host || !host.mine().some((p) => p.id === j.printer_id)) playSound(settings.sound, 'printed', 'kitchen'); }
    if (j.status === 'failed') playSound(settings.sound, 'error', 'kitchen');
  });
  sock.on('connect', load);
  host = new PrintHost({ api, sock, terminalId: deviceId, settings, device: 'kitchen', onChange: () => drawTop() });
  host.start().catch(() => {});
  setInterval(draw, 30000);
}
async function load() { tickets = await api.get('/kitchen/tickets'); draw(); }
function login() {
  const code = h('input', { class: 'input', placeholder: 'รหัสพนักงาน', inputmode: 'numeric' });
  const pin = h('input', { class: 'input', type: 'password', placeholder: 'PIN', inputmode: 'numeric' });
  const go = async () => { try { const r = await api.post('/auth/login', { code: code.value, pin: pin.value }, { token: null }); store.set('kitchen_token', r.token); location.reload(); } catch (e) { errToast(e); } };
  app.replaceChildren(loginHero('จอครัว', 'ใบครัวเรียลไทม์ แยกตามจุดเตรียมอาหาร พร้อมเสียงแจ้งเตือน', h('div', { class: 'card' }, h('h2', {}, '👩‍🍳 เข้าสู่ระบบครัว'), h('label', { class: 'field' }, 'รหัสพนักงาน', code), h('label', { class: 'field' }, 'PIN', pin), keypad(pin, { onEnter: go }))));
}
function drawTop() {
  const top = $('.k-top'); if (!top) return;
  top.replaceChildren(h('strong', {}, '👩‍🍳 ครัว'), h('div', { class: 'tabs' }, [{ id: 'all', name: 'ทุกจุด' }, ...stations].map((s) => h('button', { class: 'tab' + (station === s.id ? ' active' : ''), onclick: () => { station = s.id; store.set('kitchen_station', s.id); draw(); } }, s.name))),
    h('span', { style: { flex: 1 } }),
    h('button', { class: 'btn', onclick: printersDialog }, '🖨️ เครื่องพิมพ์ครัว'),
    staff.perms.includes('cut_paper') ? h('button', { class: 'btn', onclick: cut }, '✂️ ตัดกระดาษ') : null,
    h('button', { class: 'btn', onclick: () => playSound({ ...settings.sound, enabled: true, output: ['kitchen'] }, 'printed', 'kitchen') }, '🔊 ทดสอบเสียง'),
    h('span', { class: 'version' }, staff.name + ' · v' + VERSION));
}
function draw() {
  if (!$('.k-top')) app.replaceChildren(h('div', { class: 'k-top' }), h('div', { class: 'board', id: 'board' }));
  drawTop();
  const list = tickets.filter((t) => t.status !== 'done' && (station === 'all' || t.station_id === station)).sort((a, b) => a.created_at.localeCompare(b.created_at));
  $('#board').replaceChildren(...(list.length ? list.map(card) : [h('div', { class: 'empty' }, 'ไม่มีออเดอร์ค้าง')]));
}
function card(t) {
  const c = t.content;
  const age = Math.floor((Date.now() - new Date(t.created_at)) / 60000);
  const set = (status) => api.post(`/kitchen/tickets/${t.id}/status`, { status }).then(() => { t.status = status; draw(); }).catch(errToast);
  return h('div', { class: `tk ${t.kind} ${t.status}` },
    h('div', { class: 'hd' }, h('div', {}, h('div', { class: 'q' }, c.queue_no || '-'), h('div', { class: 'small' }, c.kind_label, c.part ? ' · ' + c.part : ''), c.cooker ? h('div', { class: 'cookertag' }, c.bowl_part ? c.bowl_part + ' · ' : '', '🔥 ', c.cooker) : null),
      h('div', { style: { textAlign: 'right' } }, c.dine_type === 'takeaway' ? h('div', { class: 'tw' }, 'กลับบ้าน') : h('div', { class: 'badge info' }, dineLabel(c.dine_type)),
        c.table ? h('div', { style: { fontWeight: 800, fontSize: '1.2em' } }, 'โต๊ะ ' + c.table) : null, c.customer ? h('div', {}, c.customer) : null, h('div', { class: 'small age' }, `${age} นาที · ${c.station}`))),
    h('ul', {}, c.lines.map((l) => h('li', {}, h('strong', {}, `${l.qty} × ${l.name}`), l.bowl_label ? h('span', { class: 'badge info' }, ' ' + l.bowl_label) : null,
      l.dine_type === 'takeaway' && c.dine_type !== 'takeaway' ? h('span', { class: 'tw', style: { fontSize: '.8em', marginLeft: '.3em' } }, 'กลับบ้าน') : null,
      l.options.filter((o) => !isAddon(o)).length ? h('div', { class: 'o' }, l.options.filter((o) => !isAddon(o)).map((o) => o.name).join(' · ')) : null,
      l.options.filter(isAddon).length ? h('div', { class: 'adds' }, l.options.filter(isAddon).map((o) => h('span', {}, '+ ' + o.name))) : null, l.note ? h('div', { class: 'note' }, '⚠ ' + l.note) : null))),
    c.note ? h('div', { style: { padding: '0 .8em' } }, h('span', { class: 'note' }, 'หมายเหตุ: ' + c.note)) : null,
    c.ref ? h('div', { class: 'small', style: { padding: '0 .8em' } }, c.ref) : null,
    h('div', { class: 'ft' }, t.kind === 'void' ? h('button', { class: 'btn', onclick: () => set('done') }, 'รับทราบ') : [
      t.status === 'new' ? h('button', { class: 'btn', onclick: () => set('cooking') }, 'เริ่มทำ') : null,
      t.status !== 'ready' ? h('button', { class: 'btn ok', onclick: () => set('ready') }, 'พร้อมเสิร์ฟ') : null,
      h('button', { class: 'btn', onclick: () => set('done') }, 'เสร็จ')]));
}
async function printersDialog() {
  const printers = (await api.get('/printers')).filter((p) => p.active && p.roles.includes('kitchen'));
  modal('เครื่องพิมพ์ใบครัวบนอุปกรณ์นี้', h('div', {}, printers.map((p) => h('div', { class: 'card', style: { marginBottom: '.5em' } }, h('strong', {}, p.name), ' ', isLinkedHere(p.id) ? h('span', { class: 'badge ok' }, 'เชื่อมต่อแล้ว') : h('span', { class: 'badge' }, 'ยังไม่เชื่อม'),
    h('div', { class: 'row', style: { marginTop: '.4em' } }, h('button', { class: 'btn sm primary', onclick: async () => { try { await pairPrinter(p); await api.put(`/printers/${p.id}`, { host_terminal_id: deviceId }).catch(() => toast('บันทึกเครื่องที่รับงานไม่ได้ (ต้องมีสิทธิ์ตั้งค่าเครื่องพิมพ์)', 'warn')); host.reload(); toast('เชื่อมต่อแล้ว', 'ok'); } catch (e) { errToast(e); } } }, 'เชื่อมต่อ'),
      isLinkedHere(p.id) ? h('button', { class: 'btn sm', onclick: () => testPrint(p).then((r) => toast(JOB_TH[r.status] || r.status, 'ok')).catch(errToast) }, 'ทดสอบ') : null))),
  h('h4', {}, 'ประวัติล่าสุดของอุปกรณ์นี้'), h('ul', { class: 'small' }, (host.log || []).map((l) => h('li', {}, `${l.at.toLocaleTimeString('th-TH')} · ${l.printer} · ${l.doc} · ${JOB_TH[l.status] || l.status}${l.note ? ' · ' + l.note : ''}`)))), { wide: true });
}
async function cut() {
  const printers = (await api.get('/printers')).filter((p) => p.active);
  modal('ตัดกระดาษ', h('div', { class: 'row' }, printers.map((p) => h('button', { class: 'btn big', onclick: async () => {
    try { if (isLinkedHere(p.id)) { await testPrint(p, 'cut'); await api.post('/print/cut', { printer_id: p.id, local: true }); } else await api.post('/print/cut', { printer_id: p.id }); toast('ตัดกระดาษแล้ว', 'ok'); } catch (e) { errToast(e); }
  } }, p.name))));
}
boot().catch((e) => { app.replaceChildren(h('div', { class: 'empty' }, e.message)); });
