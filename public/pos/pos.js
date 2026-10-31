import { makeApi, store, socket, uid, storageWarning } from '/shared/api.js';
import { loginHero, h, $, toast, errToast, modal, confirmBox, promptBox, keypad, fmtTime, STATUS_TH, PREP_TH, SOURCE_TH, JOB_TH, debounce } from '/shared/ui.js';
import { baht, toSatang, addToCart, computeTotals, countBowls, dineLabel, lineUnitTotal, lineTotal, orderDineType, promptPayPayload, VERSION, maskPhone, pointsFor, isAddon, renamedLine, markOf, displayOption, fromThaiKeys, billTokenOf } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { rememberTap, flyToCart, countTo, lineChanges, setFxLevel } from './fx.js';
import { flip, leave } from '/shared/motion.js';
import { selfieBox, SELFIE_CSS } from '/shared/selfie.js';
import { shiftDetailsView, shiftStats, SHIFT_CSS } from '/shared/shiftview.js';
document.head.append(Object.assign(document.createElement('style'), { textContent: SHIFT_CSS }));
document.head.append(Object.assign(document.createElement('style'), { textContent: SELFIE_CSS }));
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
  applyFonts(st.settings.fonts, 'pos'); applyTheme(st.settings.theme); setFxLevel((st.settings.theme || {}).pos_fx);
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
  loadCrewPlan();
  if (justIn()) { justIn(false); const p = $('.pos'); p.classList.add('enter'); setTimeout(() => { p.classList.remove('enter'); document.documentElement.classList.remove('just-in'); }, 1200); }
  await connect();
  let later = false; try { later = !!sessionStorage.getItem('opp.shift_later'); sessionStorage.removeItem('opp.shift_later'); } catch { /* storage blocked */ }
  if (!st.shift && !later) openShiftDialog();
  setupScanner();
  setupAutoLock();
  // in the Android app on a two-screen device: put the customer display on the second screen by itself
  try { if (window.OppaBridge && window.OppaBridge.hasSecondScreen && window.OppaBridge.hasSecondScreen() && !window.OppaBridge.customerDisplayOpen()) openSecondScreen().catch(() => {}); } catch { /* older app */ }
  reportDevice();
}

// Login: scan the QR on the staff card (fills the staff and shows who it is on the left), then the PIN on a big keypad
const staffTokenOf = (text) => { const m = /(?:\/st\/#|^)([A-Za-z0-9_-]{1,20}\.[0-9a-f]{12})\s*$/i.exec(String(text || '').trim()); return m ? m[1] : null; };
// "just signed in" flag for the reload: the POS then fades in out of the brand colour
function justIn(v) {
  try { if (v === undefined) return !!sessionStorage.getItem('opp.just_in'); if (v) sessionStorage.setItem('opp.just_in', '1'); else sessionStorage.removeItem('opp.just_in'); } catch { /* storage blocked */ }
  return false;
}
// morph between two screens with the View Transitions API (Chrome/Android); plain swap elsewhere — the CSS entrances still play
const motionOk = () => !matchMedia('(prefers-reduced-motion: reduce)').matches;
function morph(update, kind) {
  if (!document.startViewTransition || !motionOk()) { update(); return Promise.resolve(); }
  document.documentElement.dataset.vt = kind;
  // data-vt stays set afterwards: removing it would switch the CSS entrance animations back on and replay them
  return document.startViewTransition(update).finished.catch(() => {});
}
async function loginScreen() {
  document.documentElement.classList.remove('just-in'); justIn(false);
  // today's roster from the owner (how many scan in at opening); a shift already open on this device = a normal single sign-in
  const plan = await fetch('/api/crew/today?terminal=' + encodeURIComponent(store.get('terminal_id') || '')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  // steps: "scan" popup (card, or the code typed by hand) → "pin" big keypad with the person on the left.
  // Days the owner set for 2+ people (จัดการร้าน → พนักงาน → ตารางเข้างาน): everyone scans in one after another until the count is reached,
  // then "main" picks who the POS signs in as. No shift open yet → "shift" opens it right here. Steps morph into each other.
  const need = plan && !plan.shift_open ? plan.need : 1;
  const crewMode = need >= 2;
  const max = Math.max(need, (plan && plan.max) || 8);
  let pin = '', who = null, step = 'scan', busy = false, chosen = null, lastAdded = null;
  const crew = []; // { s: staff details, pin } — PINs stay in memory only until sign-in
  const root = h('div', { class: 'login-staff' });
  const shop = st.settings ? st.settings.store.name || 'Oppa Ramyeon' : 'Oppa Ramyeon';
  const vtn = (id) => 'cp-' + String(id).replace(/[^A-Za-z0-9_-]/g, '');
  const named = (s) => (s && s.code && !s.typed ? `view-transition-name:${vtn(s.code)}` : ''); // the same person morphs between steps
  const initial = (n) => (String(n || '?').replace(/^[เแโใไ]/, '')[0] || '?'); // "เจ้าของ" → จ, not the leading vowel
  const avatar = (s, cls = 'av') => h('span', { class: cls, style: named(s) }, s.selfie || s.photo ? h('img', { src: s.selfie || s.photo, alt: '' }) : initial(s.name));
  const dots = h('div', { class: 'pin-dots' });
  const drawDots = () => dots.replaceChildren(...Array.from({ length: Math.max(4, Math.min(6, pin.length + (pin.length < 6 ? 1 : 0))) }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
  const version = () => h('p', { class: 'version' }, `เวอร์ชัน ${VERSION} · `, h('a', { href: '/guide/' }, 'คู่มือการใช้งาน'));
  const bg = () => h('div', { class: 'ls-bg' }, h('i', { class: 'blob b1' }), h('i', { class: 'blob b2' }), h('i', { class: 'blob b3' }), h('img', { class: 'bowl', src: '/assets/bowl.svg', alt: '' }), h('h1', {}, '🍜 ', shop, h('br'), 'หน้าขาย POS'));
  const shake = () => { pin = ''; drawDots(); dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); };
  const face = new Map(); // details (photos) of everyone who signed in, for the shift step

  // ---- signing in ----
  const finish = (name, line) => {
    document.removeEventListener('keydown', onKey, true);
    justIn(true);
    if (motionOk()) {
      root.append(h('div', { class: 'ls-flood' }, h('div', { class: 'ls-welcome' }, h('b', {}, '✓'), h('span', {}, line || 'ยินดีต้อนรับ ' + name))));
      setTimeout(() => location.reload(), 1100);
    } else location.reload();
  };
  const signIn = async (main, others) => {
    const r = await api.post('/auth/login', { code: main.code, pin: main.pin, at: main.at, ticket: main.ticket, face: main.face, crew: others, terminal_id: store.get('terminal_id') }, { token: null });
    store.set('staff_token', r.token); store.set('last_code', main.code);
    crew.length = 0; // forget the PINs
    const tid = store.get('terminal_id');
    if (tid && (r.staff.perms || []).includes('shift')) {
      const [shift, terms, lastOpen] = await Promise.all([api.get('/shifts/current').catch(() => 'unknown'), api.get('/terminals').catch(() => []), api.get('/shifts/last-opening').catch(() => null)]);
      if (shift === null) { r.terminal = (terms.find((t) => t.id === tid) || {}).name; r.lastOpen = lastOpen; return morph(() => shiftStep(r), 'shift'); }
    }
    finish(r.staff.name);
  };
  const go = async () => {
    if (!who || busy) return;
    if (!pin) return toast('กรุณาใส่ PIN', 'warn');
    busy = true;
    try {
      const at = new Date().toISOString(); // clock-in time = when this person's PIN was accepted
      if (!crewMode && !selfieOn) { face.set('main', who); await signIn({ code: who.code, pin, at }, []); return; }
      const s = await api.post('/auth/verify', { code: who.code, pin }, { token: null });
      const entry = { s: { ...who, ...s, typed: false }, pin, at, ticket: s.ticket };
      who = null; pin = '';
      // PIN accepted → the selfie (every sign-in, or the first of the day if the shop set it so)
      if (selfieOn && (plan.selfie_when !== 'first' || !s.clocked_today)) return morph(() => selfieStep(entry), 'in');
      await proceed(entry);
    } catch (e) { errToast(e); shake(); } finally { busy = false; }
  };
  const selfieOn = !!(plan && plan.selfie && plan.selfie !== 'off');
  // PIN (and selfie) done for one person: sign in, or add them to the crew strip
  const proceed = async (entry) => {
    if (!crewMode) { face.set('main', entry.s); busy = true; try { await signIn({ code: entry.s.code, pin: entry.pin, at: entry.at, ticket: entry.ticket, face: entry.face }, []); } catch (e) { busy = false; errToast(e); morph(scanStep, 'back'); } return; }
    const i = crew.findIndex((c) => c.s.id === entry.s.id);
    if (i >= 0) crew[i] = { ...entry, at: crew[i].at }; else crew.push(entry);
    lastAdded = entry.s.id;
    if (navigator.vibrate) navigator.vibrate(30);
    await morph(scanStep, 'add'); // the photo flies down into the crew strip
    if (crew.length >= need) { toast(`ครบ ${need} คนตามตารางแล้ว · เลือกคนหลัก`, 'ok'); setTimeout(toMain, 500); }
  };
  const ofEntry = (c) => ({ code: c.s.code, pin: c.pin, at: c.at, ticket: c.ticket, face: c.face });
  const toMain = () => {
    if (!crew.length) return;
    if (crew.length === 1) { const c = crew[0]; face.set('main', c.s); busy = true; return signIn(ofEntry(c), []).catch((e) => { busy = false; errToast(e); }); }
    morph(mainStep, 'main');
  };
  const press = (k) => { if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'C') pin = ''; else if (pin.length < 6) pin += k; drawDots(); if (pin.length === 6) go(); };
  const keys = (onKey2, list = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫']) => h('div', { class: 'bigpad' }, list.map((k, i) => h('button', { type: 'button', class: 'key' + (k === 'C' || k === '⌫' ? ' fn' : ''), style: `--i:${i}`, 'data-key': k, onclick: () => onKey2(k) }, k)));

  // ---- step: scan ----
  let code = null;
  const scanStep = () => {
    step = 'scan'; who = null; pin = '';
    code = h('input', { class: 'input', placeholder: 'รหัสพนักงาน', inputmode: 'numeric', autocomplete: 'username' });
    const manual = h('form', { class: 'ls-manual', hidden: true, onsubmit: (e) => {
      e.preventDefault(); const c = code.value.trim();
      if (!c) return toast('กรอกรหัสพนักงาน', 'warn');
      toPin({ code: c, typed: true });
    } }, code, h('button', { class: 'btn primary', type: 'submit' }, 'ถัดไป'));
    const toggle = h('button', { type: 'button', class: 'ls-link', onclick: () => { manual.hidden = false; toggle.hidden = true; code.focus(); } }, '⌨️ หรือกรอกรหัสพนักงาน');
    const n = crew.length;
    root.className = 'login-staff step-scan' + (crewMode ? ' crew' : '');
    const info = crewMode && plan ? [plan.leave.length ? '🏖️ ลา: ' + plan.leave.join(', ') : '', plan.late.length ? '⏰ มาทีหลัง: ' + plan.late.map((x) => x.name).join(', ') : ''].filter(Boolean).join(' · ') : '';
    root.replaceChildren(bg(), h('div', { class: 'ls-pop' },
      crewMode ? h('div', { class: 'ls-chip' }, `📋 วันนี้เข้างาน ${need} คน · สแกนแล้ว ${n}/${need}`, h('span', { class: 'ls-prog' }, h('i', { style: `--p:${Math.min(1, n / need)}` }))) : null,
      h('div', { class: 'ls-beam' }, h('span', { class: 'cardico' }, '🪪'), h('i', { class: 'line' })),
      h('h2', {}, !crewMode ? 'สแกนบัตรพนักงาน' : n ? `สแกนคนที่ ${n + 1}` : 'สแกนบัตรพนักงานคนแรก'),
      h('p', { class: 'muted' }, crewMode && n ? 'ยิง QR บนบัตรของคนถัดไป หรือกดเสร็จแล้วเพื่อเลือกคนหลัก' : 'ยิง QR บนบัตรพนักงานด้วยเครื่องยิงได้เลย'),
      crewMode && n ? h('div', { class: 'crew-strip' }, crew.map((c) => h('div', { class: 'cs' + (c.s.id === lastAdded ? ' new' : '') }, avatar(c.s), h('small', {}, c.s.nickname || c.s.name)))) : null,
      h('div', { class: 'ls-wait' }, h('i'), h('i'), h('i'), h('span', {}, 'รอสแกน')),
      crewMode && n >= need ? h('button', { class: 'btn primary big block crew-done', onclick: toMain }, `ครบแล้ว · เลือกคนหลัก (${n} คน)`) : null,
      info ? h('p', { class: 'ls-info' }, info) : null,
      toggle, manual,
      crewMode && n && n < need ? h('button', { type: 'button', class: 'ls-link sm', onclick: async () => {
        if (await confirmBox('ยังมาไม่ครบ', `ตารางวันนี้ ${need} คน สแกนแล้ว ${n} คน — คนที่มาทีหลังสแกนเข้ารอบได้ที่ ⋯ → พนักงานเข้างานเพิ่ม`, 'ไปต่อเลย')) toMain();
      } }, `ยังมาไม่ครบ · ไปต่อก่อน (${n}/${need})`) : null,
      version()));
    lastAdded = null;
  };
  const toPin = (s) => {
    if (document.startViewTransition && motionOk()) return morph(() => pinStep(s), 'in');
    const pop = root.querySelector('.ls-pop'); if (pop) pop.classList.add('ok');
    setTimeout(() => pinStep(s), 450);
  };
  const back = () => {
    who = null;
    if (document.startViewTransition && motionOk()) return morph(scanStep, 'back');
    root.classList.add('leaving'); setTimeout(scanStep, 320);
  };

  // ---- step: PIN ----
  const pinStep = (s) => {
    step = 'pin'; who = s; pin = ''; drawDots();
    root.className = 'login-staff step-pin';
    const pic = s.selfie || s.photo ? h('img', { src: s.selfie || s.photo, alt: '' }) : (s.typed ? '👤' : initial(s.name));
    root.replaceChildren(
      h('div', { class: 'ls-art' }, h('div', { class: 'ls-staff' },
        h('div', { class: 'ph', style: named(s) }, pic),
        h('div', { class: 'hello' }, crewMode ? `คนที่ ${crew.length + 1} 👋` : 'สวัสดี 👋'),
        s.typed ? h('h1', {}, 'รหัส ', s.code) : h('h1', {}, s.name, s.last_name ? h('span', {}, ' ' + s.last_name) : null),
        s.nickname ? h('div', { class: 'nick' }, `(${s.nickname})`) : null,
        s.typed ? null : h('span', { class: 'role' }, s.title || s.role_name),
        s.typed ? null : h('div', { class: 'code' }, 'รหัสพนักงาน ', h('b', {}, s.code)))),
      h('div', { class: 'ls-form' }, h('div', { class: 'card' },
        h('h2', {}, '🔒 ใส่ PIN'), h('p', { class: 'muted' }, s.typed ? `รหัสพนักงาน ${s.code}` : `${s.name} · รหัส ${s.code}`),
        dots, keys(press),
        h('button', { class: 'btn primary big block', onclick: go }, crewMode ? 'ยืนยันตัวตน' : 'เข้าสู่ระบบ'),
        h('button', { class: 'btn ghost block ls-back', onclick: back }, crewMode ? '← กลับไปหน้าสแกน' : '← เปลี่ยนพนักงาน / สแกนบัตรใหม่'),
        version())));
  };

  // ---- step: clock-in selfie (camera here, or the person's phone through a QR) ----
  let selfieBoxEl = null;
  const selfieStep = (entry) => {
    step = 'selfie';
    root.className = 'login-staff step-pin step-selfie';
    const s = entry.s;
    const leaveSelfie = () => { if (selfieBoxEl) selfieBoxEl.stop(); selfieBoxEl = null; };
    selfieBoxEl = selfieBox({ ticket: entry.ticket, phoneUrl: location.origin + '/selfie/#' + encodeURIComponent(entry.ticket), allowSkip: plan.selfie === 'optional',
      onUse: (res) => { leaveSelfie(); entry.face = { ok: res.face_ok, score: res.score }; entry.s.selfie = res.url; next(); },
      onSkip: () => { leaveSelfie(); next(); } });
    const next = () => proceed(entry);
    root.replaceChildren(
      h('div', { class: 'ls-art' }, h('div', { class: 'ls-staff' },
        h('div', { class: 'ph', style: named(s) }, s.photo ? h('img', { src: s.photo, alt: '' }) : initial(s.name)),
        h('div', { class: 'hello' }, '📸 ถ่ายรูปเข้างาน'),
        h('h1', {}, s.name, s.last_name ? h('span', {}, ' ' + s.last_name) : null),
        h('div', { class: 'code' }, 'ยืนยันตัวตนด้วยใบหน้า · ระบบตรวจว่าเป็นคนจริง'))),
      h('div', { class: 'ls-form' }, h('div', { class: 'card' },
        h('h2', {}, '📸 ถ่ายรูปเข้างาน'), selfieBoxEl,
        h('button', { class: 'btn ghost block ls-back', onclick: () => { leaveSelfie(); back(); } }, '← ยกเลิก / สแกนบัตรใหม่'))));
  };

  // ---- step: pick the main person (crew days) ----
  const mainStep = () => {
    step = 'main'; who = null;
    if (!chosen || !crew.some((c) => c.s.id === chosen)) chosen = crew[0].s.id;
    root.className = 'login-staff step-main';
    const grid = h('div', { class: 'crew-pick' });
    const btn = h('button', { class: 'btn primary big block crew-go' });
    const draw = () => {
      grid.querySelectorAll('.cp').forEach((el) => el.classList.toggle('on', el.dataset.id === chosen));
      btn.textContent = `เข้าสู่ระบบ · ${crew.find((c) => c.s.id === chosen).s.name} เป็นคนหลัก`;
    };
    grid.replaceChildren(...crew.map((c, i) => h('button', { type: 'button', class: 'cp', 'data-id': c.s.id, style: `--i:${i}`, onclick: () => { chosen = c.s.id; draw(); } },
      h('span', { class: 'crown' }, '👑'), avatar(c.s, 'av big'), h('b', {}, c.s.name), h('small', {}, c.s.title || c.s.role_name || ''),
      h('span', { class: 'rm', title: 'เอาออก', onclick: (e) => { e.stopPropagation(); crew.splice(crew.indexOf(c), 1); morph(crew.length > 1 ? mainStep : scanStep, 'back'); } }, '✕'))));
    draw();
    btn.onclick = async () => {
      if (busy) return; busy = true; btn.disabled = true;
      const main = crew.find((c) => c.s.id === chosen);
      for (const c of crew) face.set(c.s.id, c.s);
      face.set('main', main.s);
      try { await signIn(ofEntry(main), crew.filter((c) => c !== main).map(ofEntry)); }
      catch (e) { errToast(e); busy = false; btn.disabled = false; }
    };
    root.replaceChildren(bg(), h('div', { class: 'ls-pop wide' },
      h('h2', {}, '👑 เลือกคนหลักของรอบนี้'),
      h('p', { class: 'muted' }, `เข้างาน ${crew.length} คน · คนหลักคือชื่อที่ใช้เข้าระบบ POS คนอื่นจะถูกบันทึกว่าอยู่ในรอบด้วย`),
      grid, btn,
      h('button', { type: 'button', class: 'ls-link', onclick: () => morph(scanStep, 'back') }, '+ สแกนเพิ่มอีกคน')));
  };

  // ---- step: open the shift ----
  let cash = '', note = null, openShiftNow = null;
  const shiftStep = (r) => {
    step = 'shift'; cash = ''; busy = false;
    root.className = 'login-staff step-shift';
    const main = face.get('main') || r.staff;
    const people = [{ ...main, id: r.staff.id, main: true }, ...(r.crew || []).map((c) => ({ ...(face.get(c.id) || {}), ...c }))];
    const amt = h('div', { class: 'cash-amt' }, h('small', {}, '฿'), h('span', {}, '0'));
    const drawAmt = () => { amt.lastChild.textContent = cash ? (cash.endsWith('.') ? Number(cash).toLocaleString('th-TH') + '.' : Number(cash).toLocaleString('th-TH', { maximumFractionDigits: 2 })) : '0'; amt.classList.remove('bump'); void amt.offsetWidth; amt.classList.add('bump'); };
    const pressCash = (k) => {
      if (k === '⌫') cash = cash.slice(0, -1); else if (k === 'C') cash = '';
      else if (k === '.') { if (!cash.includes('.')) cash = (cash || '0') + '.'; }
      else if (!(cash.includes('.') && cash.split('.')[1].length >= 2) && cash.replace('.', '').length < 8) cash = cash === '0' ? k : cash + k;
      drawAmt();
    };
    note = h('input', { class: 'input', placeholder: 'หมายเหตุ (ถ้ามี)' });
    const card = h('div', { class: 'card' });
    const btn = h('button', { class: 'btn primary big block' }, '🔓 เปิดรอบการขาย');
    openShiftNow = async () => {
      if (busy) return; busy = true; btn.disabled = true;
      try {
        await api.post('/shifts/open', { opening_cash: toSatang(cash || '0'), note: note.value });
        card.classList.add('done');
        finish(main.name, `เปิดรอบแล้ว · ยินดีต้อนรับ ${main.name}`);
      } catch (e) { errToast(e); busy = false; btn.disabled = false; }
    };
    btn.onclick = openShiftNow;
    const lo = r.lastOpen;
    const yest = plan ? new Date(Date.parse(plan.date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10) : '';
    const loDay = lo ? new Date(lo.business_date + 'T12:00:00Z').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }) : '';
    const same = lo ? h('button', { type: 'button', class: 'same-cash', onclick: () => { cash = String(lo.amount / 100); drawAmt(); same.classList.add('on'); } },
      h('b', {}, '↺ ', lo.business_date === yest ? 'ใส่เท่าเมื่อวาน' : 'ใส่เท่ารอบก่อน', ' · ', baht(lo.amount), ' ฿'), h('small', {}, 'วันที่ ' + loDay)) : null;
    card.append(h('h2', {}, '💰 เงินสดเริ่มต้นในลิ้นชัก'), h('p', { class: 'muted' }, 'ใส่จำนวนเงินทอนที่มีในลิ้นชักตอนเปิดร้าน'), amt, same,
      h('div', { class: 'cash-quick' }, ['500', '1000', '2000', '3000'].map((v) => h('button', { type: 'button', class: 'chip', onclick: () => { cash = v; drawAmt(); } }, Number(v).toLocaleString('th-TH')))),
      keys(pressCash, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']), note, btn,
      h('button', { class: 'btn ghost block ls-back', onclick: () => { try { sessionStorage.setItem('opp.shift_later', '1'); } catch { /* storage blocked */ } finish(main.name); } }, 'ภายหลัง'));
    root.replaceChildren(
      h('div', { class: 'ls-art' }, h('div', { class: 'ls-shift' },
        h('div', { class: 'shift-crew' }, people.map((p, i) => h('div', { class: 'sc' + (p.main ? ' lead' : ''), style: `--i:${i}` }, p.main ? h('span', { class: 'crown' }, '👑') : null, avatar(p, 'av'), h('small', {}, p.nickname || p.name)))),
        h('h1', {}, 'เปิดรอบการขาย'),
        h('p', {}, [r.terminal, new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'short' })].filter(Boolean).join(' · ')),
        people.length > 1 ? h('p', { class: 'small' }, `คนหลัก ${main.name} · เข้างาน ${people.length} คน`) : null)),
      h('div', { class: 'ls-form' }, card));
  };

  // ---- keyboard: a fast burst is a card scan (also typed with a Thai keyboard); otherwise keys drive the current step ----
  let burst = '', last = 0, fromBurst = 0, timer = null;
  const scan = async (raw) => {
    const tok = staffTokenOf(fromThaiKeys(raw));
    if (!tok) return toast('ไม่ใช่บัตรพนักงาน ลองสแกนใหม่อีกครั้ง', 'warn');
    try {
      const r = await fetch('/api/public/staff/' + encodeURIComponent(tok)); const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      if (!s.active) return toast('บัตรนี้ถูกปิดใช้งาน', 'error');
      if (crewMode && crew.some((c) => c.s.code === s.code)) return toast(`${s.name} สแกนเข้างานแล้ว`, 'info');
      if (navigator.vibrate) navigator.vibrate(40);
      const pop = root.querySelector('.ls-pop');
      if (pop && step === 'scan') { // found: the card turns into the staff photo with a ring burst, then the photo morphs into the big avatar
        const beam = pop.querySelector('.ls-beam');
        beam.replaceChildren(s.photo ? h('img', { src: s.photo, alt: '' }) : h('span', { class: 'ini' }, initial(s.name)));
        beam.setAttribute('style', named(s));
        pop.querySelector('h2').textContent = 'พบบัตรแล้ว · ' + s.name;
        pop.querySelector('p').textContent = 'กำลังไปหน้าใส่ PIN…';
        pop.classList.add('found');
        await new Promise((res) => setTimeout(res, 700));
      }
      toPin(s);
    } catch (e) { errToast(e); }
  };
  const endBurst = () => {
    clearTimeout(timer); timer = null;
    const b = burst; burst = '';
    if (b.length >= 10 && (step === 'scan' || step === 'pin')) {
      pin = pin.slice(0, Math.max(0, pin.length - fromBurst)); drawDots();
      if (code && document.activeElement === code) code.value = code.value.slice(0, Math.max(0, code.value.length - b.length));
      scan(b);
    }
    fromBurst = 0;
  };
  const onKey = (e) => {
    if (!document.body.contains(root)) return document.removeEventListener('keydown', onKey, true);
    if (e.target && e.target.tagName === 'INPUT' && e.target !== code) return; // the shift note
    const inCode = code && e.target === code;
    const now = performance.now();
    if (now - last > 60) { if (burst) endBurst(); burst = ''; fromBurst = 0; }
    last = now;
    if (step === 'shift') {
      if (e.key === 'Enter') { e.preventDefault(); openShiftNow && openShiftNow(); }
      else if (/^[\d.]$/.test(e.key) || e.key === 'Backspace') { e.preventDefault(); root.querySelector(`.bigpad .key[data-key="${e.key === 'Backspace' ? '⌫' : e.key}"]`)?.click(); }
      return;
    }
    if (step === 'selfie') { if (e.key === 'Escape') { e.preventDefault(); root.querySelector('.ls-back')?.click(); } return; }
    if (step === 'main') {
      if (e.key === 'Enter') { e.preventDefault(); root.querySelector('.crew-go')?.click(); }
      if (e.key === 'Escape') { e.preventDefault(); morph(scanStep, 'back'); }
      return;
    }
    const onPin = step === 'pin';
    if (e.key === 'Enter') {
      if (burst.length >= 10) { e.preventDefault(); endBurst(); } else if (onPin) { e.preventDefault(); go(); }
      return; // the code form submits itself
    }
    if (e.key === 'Escape' && onPin) { e.preventDefault(); back(); return; }
    if (e.key === 'Backspace' && onPin) { e.preventDefault(); press('⌫'); return; }
    if (e.key.length !== 1) return;
    burst += e.key; clearTimeout(timer); timer = setTimeout(endBurst, 90);
    if (inCode) return; // typing the code by hand
    e.preventDefault();
    if (onPin && /\d/.test(e.key) && pin.length < 6) { pin += e.key; fromBurst++; drawDots(); }
  };
  document.addEventListener('keydown', onKey, true);
  // big clock with seconds and the date, kept still while the steps morph
  const clock = h('div', { class: 'ls-clock' }, h('b'), h('span'));
  const tick = () => {
    if (!document.body.contains(clock)) return clearInterval(clockTimer);
    const d = new Date();
    clock.firstChild.textContent = d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    clock.lastChild.textContent = d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  const clockTimer = setInterval(tick, 1000);
  scanStep();
  app.replaceChildren(root, clock);
  tick();
  // the shift was just closed (and this device signed out): show its summary once
  const closed = store.get('closed_shift');
  if (closed) {
    store.del('closed_shift');
    modal('ปิดรอบแล้ว · ' + (closed.terminal_name || ''), h('div', { class: 'pay-grid shift-grid' }, h('div', { class: 'shift-left' }, shiftStats(closed, U()), shiftDetailsView(closed, closed.names || {}, U())),
      closed.qr ? h('div', { class: 'shift-qr' }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(closed.qr), alt: '' }), h('small', {}, 'สแกนเก็บรายงานรอบนี้ไว้ดูบนมือถือ')) : null), { wide: true });
  }
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
  s.on('connect', () => { setNet(true); pushDisplay(); refreshBadges(); loadCookers(); checkVersion(); });
  s.on('disconnect', () => setNet(false));
  s.on('catalog:changed', async () => { st.catalog = await api.get('/catalog'); renderMenu(); });
  // stock went down (a sale) or up (stock page): "เหลือ N" / "หมด" on the menu right away
  s.on('stock:changed', (x) => {
    const p = st.catalog && st.catalog.products.find((q) => q.id === x.id); if (!p) return;
    const old = Number(p.stock);
    p.stock = x.stock; p.low_stock = x.low_stock;
    if (p.track_stock) { if (x.stock <= 0) p.sold_out = true; else if (x.stock > old) p.sold_out = false; } // restocked → on sale again
    renderMenu();
  });
  s.on('settings:changed', async () => { loadCrewPlan(); st.settings = await fetch('/api/settings/public').then((r) => r.json()); applyTheme(st.settings.theme); setFxLevel((st.settings.theme || {}).pos_fx); render(); });
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
  s.on('cookers:changed', debounce(loadCookers, 300));
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
// ---------------- noodle cookers (estimated time) ----------------
// st.cookers comes from the server; times are re-counted locally every few seconds so the strip keeps ticking
const cookbar = h('div', { class: 'cookbar' });
let cookSkew = 0;
async function loadCookers() {
  try { st.cookers = await api.get('/cookers/status'); cookSkew = Date.parse(st.cookers.now) - Date.now(); } catch { return; }
  renderCookers(); renderCartEta();
}
setInterval(() => { renderCookers(); renderCartEta(); }, 10000);
setInterval(loadCookers, 60000);
const nowMs = () => Date.now() + cookSkew;
// a server-clock time as the shop's local hh:mm
const clockAt = (ms) => new Date(ms - cookSkew).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
// per machine: bowls still waiting/cooking, when it is free, and when its current bowl is done
function cookerView() {
  const c = st.cookers; if (!c || !c.enabled) return null;
  const t = nowMs(), per = c.minutes_per_bowl * 60000;
  return c.machines.map((m) => {
    const q = m.queue.filter((j) => Date.parse(j.end_at) > t);
    const bowls = q.reduce((a, j) => a + Math.min(j.bowls, Math.ceil((Date.parse(j.end_at) - t) / per)), 0);
    const free = Math.max(t, ...q.map((j) => Date.parse(j.end_at)));
    const firstEnd = q.length ? Math.min(...q.map((j) => Date.parse(j.end_at) - (Math.min(j.bowls, Math.ceil((Date.parse(j.end_at) - t) / per)) - 1) * per)) : null;
    return { no: m.no, name: m.name, bowls, free, mins: Math.max(0, Math.ceil((free - t) / 60000)), next: firstEnd ? Math.max(0, Math.ceil((firstEnd - t) / 60000)) : 0, queues: [...new Set(q.map((j) => j.queue_no).filter(Boolean))] };
  });
}
function renderCookers() {
  const v = cookerView();
  cookbar.hidden = !v;
  if (!v) return;
  const busy = v.filter((m) => m.bowls);
  const nextAll = busy.length ? Math.min(...busy.map((m) => m.next)) : 0;
  const at = (mins) => clockAt(nowMs() + mins * 60000);
  cookbar.replaceChildren(
    h('div', { class: 'ck-sum' }, h('b', {}, '🍜 เครื่องต้ม'), h('small', {}, busy.length ? `ชามถัดไปคาดว่าเสร็จตอน ${at(Math.max(1, nextAll))}` : 'ว่างทุกเครื่อง พร้อมต้ม')),
    ...v.map((m) => h('div', { class: 'ck' + (m.bowls ? ' busy' : ' free'), title: m.queues.length ? 'คิว ' + m.queues.join(', ') : '' },
      h('span', { class: 'ck-no' }, m.no), h('div', { class: 'ck-t' }, h('b', {}, m.name), h('small', {}, m.bowls ? `เหลือ ${m.bowls} ${U()} · คาดว่าว่างตอน ${clockAt(m.free)}` : 'ว่าง')),
      h('span', { class: 'ck-pots' }, Array.from({ length: Math.min(6, m.bowls) }, (_, i) => h('i', { class: i === 0 ? 'on' : '' }))))));
}
// estimate for the bowls in the cart that are not in the kitchen yet: each bowl goes to the cooker free first
function cartEta() {
  const v = cookerView(); if (!v || !st.cart) return null;
  const unsent = st.cart.lines.map((l) => ({ ...l, qty: l.qty - (l.sent_qty || 0) })).filter((l) => l.qty > 0);
  const n = countBowls(unsent); if (!n) return null;
  const per = st.cookers.minutes_per_bowl * 60000, free = v.map((m) => m.free), used = new Set();
  for (let i = 0; i < n; i++) { let k = 0; for (let j = 1; j < free.length; j++) if (free[j] < free[k]) k = j; free[k] += per; used.add(v[k].no); }
  const done = Math.max(...free.filter((f, i) => used.has(v[i].no)));
  return { bowls: n, mins: Math.max(1, Math.ceil((done - nowMs()) / 60000)), at: new Date(done - cookSkew), machines: [...used].sort() };
}
function renderCartEta() {
  const el = $('#cartEta'); if (!el) return;
  const e = cartEta();
  el.hidden = !e;
  if (e) el.replaceChildren(h('span', {}, '⏱'), h('div', {}, h('b', {}, `ส่งตอนนี้ คาดว่าจะเสร็จตอน ${clockAt(e.at.getTime() + cookSkew)} น.`),
    h('small', {}, `${e.bowls} ${U()} → ${e.machines.map((no) => (st.cookers.machines[no - 1] || {}).name || 'เครื่อง ' + no).join(' + ')}`)));
}
// after ส่งครัว / payment: which cooker each bowl went to
function cookerPopup(jobs, title) {
  if (!jobs || !jobs.length) return;
  const old = $('.cookpop'); if (old) old.remove();
  const fmt = (iso) => new Date(Date.parse(iso) - cookSkew).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });
  const box = h('div', { class: 'cookpop', onclick: () => box.remove() }, h('div', { class: 'cp-h' }, h('b', {}, '🔥 ', title), h('small', {}, 'แตะเพื่อปิด')),
    ...jobs.map((j, i) => h('div', { class: 'cp-r', style: `animation-delay:${i * 80}ms` }, h('span', { class: 'cp-n' }, j.machine), h('div', {}, h('b', {}, j.name), h('small', {}, `${j.bowls} ${U()} · คาดว่าจะเสร็จตอน ${fmt(j.end_at)} น.`)))));
  document.body.append(box);
  setTimeout(() => box.classList.add('out'), 7000); setTimeout(() => box.remove(), 7600);
}
function renderTop() {
  const t = $('#top'); if (!t) return;
  const badge = (n, pulse) => (n ? h('span', { class: 'count' + (pulse ? ' pulse' : '') }, n) : null);
  t.replaceChildren(
    h('span', { class: 'brand' }, h('img', { src: st.settings.store.logo || '/assets/bowl.svg', alt: '' }), st.settings.store.name), h('span', { id: 'net', class: 'status-dot ' + (online ? 'ok' : 'bad') }),
    h('span', { class: 'who muted' }, `${st.terminal.name} · ${st.staff.name}`),
    st.shift ? h('span', { class: 'badge ok' }, 'รอบเปิดอยู่') : h('button', { class: 'btn sm danger', onclick: openShiftDialog }, 'ยังไม่เปิดรอบ'),
    lateWaiting().length ? h('button', { class: 'btn sm late-chip', onclick: joinDialog }, '⏰ รอเข้างาน: ' + lateWaiting().join(', ')) : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: ordersDialog }, '🧾 บิล/ออเดอร์', badge(st.pending.mobile, st.pending.mobile > 0)),
    can('redeem') && h('button', { class: 'btn', onclick: () => couponDialog() }, '🎁 แลกรางวัล'),
    st.pending.verify ? h('button', { class: 'btn', onclick: verifyDialog }, '🔐 ยืนยันสมาชิก', badge(st.pending.verify, true)) : null,
    can('print_mobile_qr') && h('button', { class: 'btn', onclick: mobileQrDialog }, '📱 QR สั่งอาหาร'),
    h('button', { class: 'btn', onclick: shiftDialog }, '💰 รอบการขาย'),
    h('button', { class: 'btn', onclick: devicesDialog }, '🖨️ อุปกรณ์'),
    can('cut_paper') && h('button', { class: 'btn', onclick: manualCut }, '✂️ ตัดกระดาษ'),
    h('button', { class: 'btn icon-refresh', title: 'รีเฟรชข้อมูลให้เป็นปัจจุบัน', 'aria-label': 'รีเฟรช', onclick: refreshAll }, '⟳'),
    h('button', { class: 'btn', onclick: moreMenu, 'aria-label': 'เมนูเพิ่มเติม' }, '⋯'),
    h('span', { class: 'version' }, 'v' + VERSION));
}

// ---------------- staff joining the open shift later (roster: "มาทีหลัง") ----------------
async function loadCrewPlan() {
  try { st.crewPlan = await fetch('/api/crew/today?terminal=' + encodeURIComponent(st.terminal.id)).then((r) => r.json()); } catch { /* offline */ }
  renderTop();
}
const lateWaiting = () => (st.shift && st.crewPlan ? st.crewPlan.late.filter((x) => !x.joined).map((x) => x.name) : []);
function joinDialog() {
  if (!st.shift) return toast('ยังไม่เปิดรอบการขาย', 'warn');
  const who = h('div', { class: 'jd-who' });
  const inShift = () => (st.shift.crew || []).map((c) => (c.main ? '👑 ' : '') + c.name).join(', ');
  const idle = () => who.replaceChildren(h('div', { class: 'jd-ph' }, '🪪'), h('b', {}, 'สแกนบัตรพนักงาน'), h('small', {}, 'ยิง QR บนบัตร หรือกรอกรหัส แล้วใส่ PIN'),
    lateWaiting().length ? h('div', { class: 'badge warn' }, '⏰ ตามตาราง: ' + lateWaiting().join(', ')) : null,
    h('small', { class: 'muted' }, 'ในรอบตอนนี้: ' + (inShift() || '-')));
  idle();
  const code = h('input', { class: 'input', placeholder: 'รหัสพนักงาน', autocomplete: 'off' });
  const pin = h('input', { class: 'input', type: 'password', inputmode: 'numeric', placeholder: 'PIN', autocomplete: 'off' });
  // the scanner types the card link into the code box (also with a Thai keyboard): turn it into the person
  code.addEventListener('input', debounce(async () => {
    const tok = staffTokenOf(fromThaiKeys(code.value)); if (!tok) return;
    try {
      const r = await fetch('/api/public/staff/' + encodeURIComponent(tok)); const s = await r.json();
      if (!r.ok) throw new Error(s.error);
      code.value = s.code;
      who.replaceChildren(h('div', { class: 'jd-ph' }, s.photo ? h('img', { src: s.photo, alt: '' }) : (s.name || '?')[0]), h('b', {}, s.name + (s.last_name ? ' ' + s.last_name : '')), h('small', {}, s.title || s.role_name || ''));
      pin.focus();
    } catch (e) { errToast(e); code.value = ''; }
  }, 120));
  const dlg = modal('👥 พนักงานเข้างานเพิ่ม', h('div', { class: 'join-grid' }, who, h('div', {}, h('label', { class: 'field' }, 'รหัสพนักงาน (หรือสแกนบัตร)', code), h('label', { class: 'field' }, 'PIN', pin), keypad(pin, { onEnter: () => go() }))),
    { actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: 'เข้ารอบนี้', class: 'primary', onClick: () => go() }] });
  const join = async (extra = {}) => {
    const r = await api.post('/shifts/join', { code: code.value.trim(), pin: pin.value, at, ...extra });
    st.shift = { ...st.shift, crew: r.crew };
    toast(`👋 ${r.name} เข้างานในรอบนี้แล้ว`, 'ok');
    dlg.close(); loadCrewPlan();
  };
  let at = null;
  const go = async () => {
    if (!code.value.trim() || !pin.value) { toast('สแกนบัตร/กรอกรหัส และใส่ PIN', 'warn'); return false; }
    try {
      at = new Date().toISOString();
      const mode = (st.crewPlan && st.crewPlan.selfie) || 'off';
      if (mode === 'off') { await join(); return false; }
      const v = await api.post('/auth/verify', { code: code.value.trim(), pin: pin.value }, { token: null });
      if (st.crewPlan.selfie_when === 'first' && v.clocked_today) { await join(); return false; }
      // first clock-in today: the selfie, in this dialog (camera here, or the phone through the QR)
      const box = selfieBox({ ticket: v.ticket, phoneUrl: location.origin + '/selfie/#' + encodeURIComponent(v.ticket), allowSkip: mode === 'optional',
        onUse: (res) => join({ ticket: v.ticket, face: { ok: res.face_ok, score: res.score } }).catch(errToast), onSkip: () => join().catch(errToast) });
      dlg.box.querySelector('.modal-body').replaceChildren(h('div', { class: 'jd-selfie' }, h('b', {}, `📸 ${v.name} · ถ่ายรูปเข้างาน`), box));
      const foot = dlg.box.querySelector('.modal-actions'); if (foot) foot.remove();
      const stop = new MutationObserver(() => { if (!document.body.contains(box)) { box.stop(); stop.disconnect(); } });
      stop.observe(document.body, { childList: true, subtree: true });
    } catch (e) { errToast(e); pin.value = ''; return false; }
    return false;
  };
}
// a newer version on the server: reload once nothing is being keyed — this device also prints, so it must run the latest code
async function checkVersion() {
  try {
    const v = (await fetch('/api/settings/public', { cache: 'no-store' }).then((r) => r.json())).version;
    if (!v || v === VERSION) return;
    if (st.cart.lines.length || st.locked || document.querySelector('.modal-back, .leave-print')) return; // try again later
    toast(`กำลังอัปเดตเป็นเวอร์ชัน ${v}…`, 'info', 2000);
    setTimeout(() => location.reload(), 1500);
  } catch { /* offline */ }
}
setInterval(checkVersion, 3 * 60e3);
// ⟳ in the top bar: menu, stock, shift, settings and badges fetched again (the bill being keyed stays as it is)
async function refreshAll(e) {
  const b = e && e.currentTarget; if (b) { b.classList.add('spin'); b.disabled = true; }
  try {
    const [cat, sh, set] = await Promise.all([api.get('/catalog'), api.get('/shifts/current'), fetch('/api/settings/public').then((r) => r.json())]);
    st.catalog = cat; st.shift = sh; st.settings = set;
    applyTheme(set.theme); setFxLevel((set.theme || {}).pos_fx);
    renderMenu(); renderCart(); renderTop(); refreshBadges(); loadCookers(); loadCrewPlan();
    toast('✓ อัปเดตข้อมูลล่าสุดแล้ว', 'ok', 1800);
  } catch (er) { errToast(er); }
  finally { const nb = $('.icon-refresh'); if (nb) { nb.classList.remove('spin'); nb.disabled = false; } }
}
// shop management inside the same app window (no new tab / browser, no second login):
// the admin site reuses this staff session and shows a "back to sales" button
function openAdminInApp(hash = '') {
  store.set('admin_token', store.get('staff_token'));
  store.set('admin_from_pos', true);
  location.href = '/admin/' + hash;
}
// secondary actions live in a small menu so the top bar stays readable on tablets
function moreMenu(e) {
  e.stopPropagation();
  const old = $('.menu-pop:not(.closing)'); if (old) return leave(old, 'closing', () => old.remove(), 180);
  const pop = h('div', { class: 'menu-pop', role: 'menu' },
    h('a', { href: '/guide/' }, '📖 คู่มือการใช้งาน'),
    (can('view_sales') || can('settings')) && h('a', { href: '/admin/', onclick: (e) => { e.preventDefault(); openAdminInApp(); } }, '📊 จัดการร้าน'),
    h('a', { href: '/kitchen/' }, '👩‍🍳 จอครัว'),
    h('button', { onclick: () => { pop.remove(); joinDialog(); } }, '👥 พนักงานเข้างานเพิ่ม'),
    h('button', { onclick: async () => { pop.remove(); try { const r = await api.post('/stock/print', {}); toast(`🖨 พิมพ์รายงานสต็อก ${r.count} รายการ (ใกล้หมด ${r.low}) ที่ ${r.printer}`, 'ok', 5000); } catch (e) { errToast(e); } } }, '📦 พิมพ์รายงานสต็อก'),
    h('button', { onclick: () => { pop.remove(); lockNow(); } }, '🔒 ล็อกหน้าจอ'),
    h('button', { onclick: logout }, '🚪 ออกจากระบบ / สลับผู้ใช้'),
    h('div', { class: 'version', style: { padding: '.4em .8em' } }, `${st.staff.name} · ${st.terminal.name} · เวอร์ชัน ${VERSION}`));
  document.body.append(pop);
  setTimeout(() => document.addEventListener('click', () => leave(pop, 'closing', () => pop.remove(), 180), { once: true }));
}

function renderMenu() {
  const m = $('#menu'); if (!m) return;
  const cats = st.catalog.categories;
  const search = h('input', { class: 'input', id: 'search', placeholder: '🔍 ค้นหาชื่อ / รหัสสินค้า / สแกนบาร์โค้ด', value: st.q, autocomplete: 'off' });
  search.addEventListener('input', debounce(() => {
    const v = search.value.trim(), k = fromThaiKeys(v);
    if (openBillLink(k)) { search.value = ''; st.q = ''; renderGrid(); return; }
    if (v.length >= 3 && exactCode(v) && addByCode(v)) { search.value = ''; st.q = ''; renderGrid(); return; }
    // scanned with the keyboard in Thai: the converted text is an exact product code
    if (k !== v && k.length >= 3 && exactCode(k) && addByCode(k)) { search.value = ''; st.q = ''; renderGrid(); return; }
    st.q = search.value; renderGrid();
  }, 250));
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const v = search.value.trim(), k = fromThaiKeys(v);
    if (v && (openBillLink(k) || addByCode(v) || (k !== v && addByCode(k)))) { search.value = ''; st.q = ''; renderGrid(); }
    else if (v) { const list = filtered(); if (list.length === 1) { pickProduct(list[0]); search.value = ''; st.q = ''; renderGrid(); } }
  });
  m.replaceChildren(cookbar,
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
  const enter = g.dataset.key !== st.cat + '|' + st.q; g.dataset.key = st.cat + '|' + st.q; // new category/search → cards cascade in
  let ix = 0;
  g.replaceChildren(...(list.length ? list.map((p) => h('button', { class: 'prod' + (enter ? ' fx-in' : '') + (p.sold_out ? ' out' : '') + (inCart.get(p.id) ? ' picked' : ''), style: `--i:${Math.min(ix++, 24)};` + (catColor[p.category_id] ? `--cat:${catColor[p.category_id]}` : ''),
    onclick: (e) => { rememberTap(e.currentTarget); pickProduct(p); }, oncontextmenu: (e) => { e.preventDefault(); soldOutToggle(p); } },
    h('div', { class: 'img' + (p.image ? '' : ' noimg'), style: p.image ? { backgroundImage: `url(${p.image})` } : {} }, p.image ? null : h('img', { src: '/assets/bowl.svg', alt: '' }),
      inCart.get(p.id) ? h('span', { class: 'incart' }, '×' + inCart.get(p.id)) : null, p.sold_out ? h('span', { class: 'soldout' }, 'หมด')
        : p.track_stock && Number(p.stock) <= Number(p.low_stock || 0) ? h('span', { class: 'lowleft' }, `เหลือ ${Math.max(0, Math.round(p.stock * 100) / 100)}`) : null),
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
// a code that matches one product exactly and is not the start of a longer code (so "R01" never fires while typing "R010")
function exactCode(v) {
  const q = v.toLowerCase();
  const codes = st.catalog.products.filter((x) => x.active).flatMap((x) => [x.code.toLowerCase(), ...x.barcodes.map((b) => b.toLowerCase())]).filter(Boolean);
  return codes.includes(q) && !codes.some((c) => c !== q && c.startsWith(q));
}
function addByCode(code) {
  const p = st.catalog.products.find((x) => x.active && (x.barcodes.includes(code) || x.code.toLowerCase() === code.toLowerCase()));
  if (!p) return false;
  pickProduct(p, { fromScan: true });
  return true;
}
function currentBowlGroup() { return st.activeBowl || null; }
function pickProduct(p, { fromScan = false } = {}) {
  if (p.sold_out) return toast('สินค้าหมด: ' + p.name, 'warn');
  // counted stock: no more than what is left (everything already in this bill counts)
  if (p.track_stock) {
    const inBill = st.cart.lines.filter((l) => l.product_id === p.id).reduce((a, l) => a + l.qty, 0); // stock is taken at payment
    if (inBill + 1 > Number(p.stock)) return toast(`${p.name} เหลือ ${Math.max(0, Number(p.stock))} — อยู่ในบิลแล้ว ${inBill}`, 'warn');
  }
  if (p.option_groups.length) {
    // "เลือกด่วน" groups (e.g. egg style): big picture buttons right away, one tap adds the item
    const groups = p.option_groups.map((gid) => st.catalog.option_groups.find((g) => g.id === gid)).filter(Boolean);
    if (groups.length && groups.every((g) => g.display === 'quick')) return quickPick(p, groups);
    return optionsDialog(p);
  }
  // toppings (0 bowls) go into the currently selected bowl so they print with it
  const bowl = !p.bowl_count ? currentBowlGroup() : null;
  addToCart(st.cart, p, { dine_type: st.cart.dine_type, bowl_group: bowl });
  if (fromScan) toast(`+1 ${p.name}`, 'ok', 900);
  saveCart(); renderCart();
}
function quickPick(p, groups, chosenSoFar = []) {
  const g = groups[0];
  if (!g) {
    const bowl = p.bowl_count ? nextBowlGroup() : currentBowlGroup();
    const l = addToCart(st.cart, p, { qty: 1, options: chosenSoFar, dine_type: st.cart.dine_type, note: '', bowl_group: bowl });
    if (p.bowl_count && l.qty === 1) st.activeBowl = l.bowl_group;
    toast(`+1 ${p.name}${chosenSoFar.length ? ' · ' + chosenSoFar.map((o) => o.name).join(', ') : ''}`, 'ok', 1200);
    saveCart(); renderCart();
    return;
  }
  const opt = (o) => ({ group_id: g.id, group: g.name, id: o.id, name: o.name, price: o.price, addon: !g.min_select, ...(o.rename_to ? { rename_to: o.rename_to, rename_all: !!g.rename_all } : {}), ...markOf(g, o) });
  const multi = g.max_select !== 1;
  const picked = new Set();
  const grid = h('div', { class: 'qp-grid' });
  let m;
  const next = (list) => { m.close(); quickPick(p, groups.slice(1), [...chosenSoFar, ...list]); };
  const tile = (o) => h('button', { class: 'qp-tile' + (picked.has(o.id) ? ' on' : ''), onclick: () => {
    if (!multi) return next([opt(o)]);
    if (picked.has(o.id)) picked.delete(o.id); else if (!g.max_select || picked.size < g.max_select) picked.add(o.id); else return toast(`เลือกได้ไม่เกิน ${g.max_select}`, 'warn');
    draw();
  } }, h('span', { class: 'qp-img' }, o.image ? h('img', { src: o.image, alt: '' }) : h('b', {}, o.name.slice(0, 2))), h('strong', {}, o.name), h('small', {}, o.price ? `+${baht(o.price)} ฿` : 'ไม่เพิ่มราคา'),
    picked.has(o.id) ? h('i', {}, '✓') : null);
  const draw = () => grid.replaceChildren(...g.options.map(tile),
    !g.min_select && !multi ? h('button', { class: 'qp-tile plain', onclick: () => next([]) }, h('span', { class: 'qp-img' }, h('b', {}, '—')), h('strong', {}, 'แบบปกติ'), h('small', {}, 'ไม่เลือก')) : null);
  draw();
  m = modal(`${p.name} · ${g.name}`, h('div', {}, h('p', { class: 'muted', style: { margin: '0 0 .6em' } }, multi ? `แตะเลือก${g.max_select ? `ได้ไม่เกิน ${g.max_select}` : ''} แล้วกด "เพิ่มลงบิล"` : 'แตะครั้งเดียว เพิ่มลงบิลทันที'), grid),
    { wide: true, autofocus: false, actions: [{ label: '📝 หมายเหตุ / จำนวน', onClick: () => { optionsDialog(p); } },
      multi ? { label: 'เพิ่มลงบิล', class: 'primary', onClick: () => {
        if (picked.size < (g.min_select || 0)) { toast(`กรุณาเลือก ${g.name}`, 'warn'); return false; }
        next(g.options.filter((o) => picked.has(o.id)).map(opt)); return false;
      } } : { label: 'ยกเลิก', onClick: () => {} }] });
}
function optionsDialog(p, editLine = null) {
  const groups = p.option_groups.map((gid) => st.catalog.option_groups.find((g) => g.id === gid)).filter(Boolean);
  const chosen = new Map(groups.map((g) => [g.id, new Set((editLine ? editLine.options : []).filter((o) => o.group_id === g.id).map((o) => o.id))]));
  // nothing is pre-selected: the cashier taps what the customer asked for
  let tried = false;
  let qty = editLine ? editLine.qty : 1;
  let dine = editLine ? editLine.dine_type : st.cart.dine_type;
  const note = h('input', { class: 'input', placeholder: 'หมายเหตุ เช่น ไม่ใส่ต้นหอม', value: editLine ? editLine.note : '' });
  // the note is optional: hidden behind a button so the keyboard only opens when the cashier wants to type
  let showNote = !!(editLine && editLine.note);
  // "Add-on พิเศษ": products flagged big_options get large, easy-to-tap option tiles
  const big = !!p.big_options;
  const body = h('div', { class: big ? 'bigopts' : '' });
  const draw = () => {
    const price = p.price + groups.reduce((s, g) => s + g.options.filter((o) => chosen.get(g.id).has(o.id)).reduce((a, o) => a + o.price, 0), 0);
    body.replaceChildren(
      ...groups.map((g) => { const need = chosen.get(g.id).size < (g.min_select || 0);
        return h('div', { class: 'opt-group' + (g.min_select ? ' req' : ' addon') + (g.display === 'quick' ? ' quick' : '') + (tried && need ? ' missing' : ''), 'data-g': g.id }, h('h4', {}, big ? h('span', { class: 'gtag' }, g.min_select ? 'เลือก' : '✨ ADD-ON') : null, g.name,
          h('span', { class: big ? 'gnote' : 'muted small' }, g.min_select ? ` บังคับ${g.max_select > 1 ? ` · เลือกได้ ${g.max_select}` : ' · เลือก 1'}` : g.max_select ? ` ไม่บังคับ · เพิ่มได้ไม่เกิน ${g.max_select}` : ' ไม่บังคับ'),
          g.min_select ? (need ? h('span', { class: 'pickhint' }, '👆 กดที่รายการที่ต้องการ') : h('span', { class: 'pickhint ok' }, '✓ เลือกแล้ว')) : null),
        h('div', { class: 'opts' }, g.options.map((o) => h('button', { class: 'opt' + (chosen.get(g.id).has(o.id) ? ' on' : ''), onclick: () => {
          const set = chosen.get(g.id);
          if (set.has(o.id)) { if (!(g.min_select && set.size <= g.min_select)) set.delete(o.id); }
          else { if (g.max_select === 1) set.clear(); if (!g.max_select || set.size < g.max_select) set.add(o.id); else toast(`เลือกได้ไม่เกิน ${g.max_select}`, 'warn'); }
          draw();
        } }, big || g.display === 'quick' ? [chosen.get(g.id).has(o.id) ? h('span', { class: 'tick' }, '✓') : null, o.image ? h('img', { class: 'oimg', src: o.image, alt: '' }) : null, h('b', {}, o.name), h('small', {}, o.price ? `+${baht(o.price)} ฿` : 'ไม่เพิ่มราคา')]
          : [o.name, o.price ? ` +${baht(o.price)}` : ''])))); }),
      // dine-in/takeaway comes from the bill (top of the cart); change a single line with its chip in the cart
      h('div', { class: 'row', style: { marginBottom: '.8em', justifyContent: 'space-between' } },
        h('span', { class: 'dine-note ' + dine }, dine === 'takeaway' ? '🥡 กลับบ้าน' : '🍽️ ทานที่ร้าน', h('small', {}, ' ตามบิล')),
        h('div', { class: 'qty' }, h('button', { onclick: () => { qty = Math.max(1, qty - 1); draw(); } }, '−'), h('span', {}, qty), h('button', { onclick: () => { qty++; draw(); } }, '+'))),
      showNote ? h('label', { class: 'field' }, 'หมายเหตุ (ไม่บังคับ)', note)
        : h('button', { class: 'chip', style: { marginBottom: '.6em' }, onclick: () => { showNote = true; draw(); setTimeout(() => note.focus(), 30); } }, '📝 เพิ่มหมายเหตุ (ไม่บังคับ)'),
      h('div', { class: 'bigsum' }, baht(price * qty), ' ฿'));
  };
  draw();
  modal((big ? '✨ ' : '') + p.name, body, { autofocus: false, wide: big, actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: editLine ? 'บันทึก' : 'เพิ่มลงบิล', class: 'primary', onClick: () => {
    const missing = groups.find((g) => chosen.get(g.id).size < g.min_select);
    if (missing) { tried = true; draw(); body.querySelectorAll('.opt-group.missing').forEach((x) => x.classList.add('shake')); toast('กรุณาเลือก ' + missing.name, 'warn'); const el = body.querySelector(`.opt-group[data-g="${missing.id}"]`); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); return false; }
    const options = groups.flatMap((g) => g.options.filter((o) => chosen.get(g.id).has(o.id)).map((o) => ({ group_id: g.id, group: g.name, id: o.id, name: o.name, price: o.price, addon: !g.min_select, ...(o.rename_to ? { rename_to: o.rename_to, rename_all: !!g.rename_all } : {}), ...markOf(g, o) })));
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
// cart lines glide to their new places when one is added or removed
function renderCart() { flip(() => $('#cart .lines'), renderCartNow, { enter: false }); }
function renderCartNow() {
  const c = $('#cart'); if (!c) return;
  const cart = st.cart;
  const t = previewTotals();
  const ch = lineChanges(cart.lines, fxKey);
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
    h('div', { class: 'lines' }, cart.lines.length ? cart.lines.map((l) => lineView(l, ch))
      : h('div', { class: 'cart-empty' }, h('img', { src: '/assets/bowl.svg', alt: '' }), h('b', {}, 'ยังไม่มีสินค้าในบิล'), h('span', {}, 'แตะเมนูทางซ้าย หรือสแกนบาร์โค้ดได้เลย'))),
    h('div', { class: 'cart-eta', id: 'cartEta', hidden: true }),
    h('div', { class: 'totals' },
      row('รวมสินค้า', baht(t.items_total)),
      t.discount ? row('ส่วนลด' + (t.tierAmt ? ' (รวมสิทธิ์ Tier)' : ''), '-' + baht(t.discount)) : null,
      t.packaging ? row('ค่าบรรจุภัณฑ์', baht(t.packaging)) : null,
      t.tax ? row(st.settings.sale.tax_inclusive ? 'VAT (รวมในราคา)' : 'VAT', baht(t.tax)) : null,
      row(h('span', {}, ('จำนวน' + U() + ' '), h('strong', {}, t.bowls)), h('span', { class: 'grand num', id: 'cartGrand' }, baht(prevGrand ?? t.total) + ' ฿'))),
    h('div', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => saveOrder('hold'), disabled: !cart.lines.length }, '⏸ พักบิล'),
      h('button', { class: 'btn', onclick: () => saveOrder('send'), disabled: !cart.lines.length }, '🔥 ส่งครัว'),
      h('button', { class: 'btn', onclick: discountDialog, disabled: !cart.lines.length || !can('discount') }, '％ ส่วนลด'),
      h('button', { class: 'btn', onclick: bowlPicker }, `🥣 ${U()} ${st.activeBowl || '-'}`),
      h('button', { class: 'btn primary pay', onclick: payDialog, disabled: !cart.lines.length }, h('span', {}, '💳 ชำระเงิน'), h('span', { class: 'amt num', id: 'payAmt' }, `${baht(prevGrand ?? t.total)} ฿`))));
  renderGrid();
  renderCartEta();
  // effects: count the total, glow the line that just changed, and fly the tapped item in
  const fmt = (v) => baht(v) + ' ฿';
  for (const id of ['cartGrand', 'payAmt']) { const el = $('#' + id); if (el) { el.dataset.v = prevGrand ?? t.total; countTo(el, t.total, fmt); } }
  prevGrand = t.total;
  if (ch.fresh.size || ch.more.size) { flyToCart(); const hot = $('#cart .line.fx-latest'); if (hot) hot.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
}
let prevGrand = null;
const fxKey = (l) => l.product_id + '|' + JSON.stringify((l.options || []).map((o) => o.id)) + '|' + (l.dine_type || '') + '|' + (l.bowl_group || '') + '|' + (l.note || '');
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
function lineView(l, ch = { fresh: new Set(), more: new Set(), latest: null }) {
  const k = fxKey(l);
  const sent = l.sent_qty || 0;
  const setQty = (q) => {
    if (q < sent && !can('void_item')) return toast('รายการนี้ส่งครัวแล้ว ต้องมีสิทธิ์ยกเลิกรายการ', 'warn');
    const prod = q > l.qty && st.catalog.products.find((x) => x.id === l.product_id);
    if (prod && prod.track_stock) { const inBill = st.cart.lines.filter((x) => x.product_id === prod.id).reduce((t, x) => t + x.qty, 0); if (inBill - l.qty + q > Number(prod.stock)) return toast(`${prod.name} เหลือ ${Math.max(0, Number(prod.stock))}`, 'warn'); }
    if (q <= 0) st.cart.lines = st.cart.lines.filter((x) => x !== l); else l.qty = q;
    saveCart(); renderCart();
  };
  const rn = renamedLine(l.name, l.options || [], 'everywhere');
  const kitchenAs = renamedLine(rn.name, rn.options, 'kitchen');
  return h('div', { class: 'line' + (ch.fresh.has(k) ? ' fx-new' : ch.more.has(k) ? ' fx-more' : '') + (ch.latest === k ? ' fx-latest' : ''), 'data-k': k },
    h('div', { class: 'top' }, h('div', { class: 'nm' }, rn.name, kitchenAs.options.length || kitchenAs.name !== rn.name ? h('div', { class: 'optchips' },
      kitchenAs.name !== rn.name ? h('span', { class: 'oc kitchen', title: 'ชื่อที่พิมพ์ในใบครัว' }, '👩‍🍳 ', kitchenAs.name) : null, kitchenAs.options.map((o) => isAddon(o)
      ? h('span', { class: 'oc add' }, '+ ', o.name, o.price ? h('small', {}, ` ${baht(o.price)}`) : null)
      : h('span', { class: 'oc' }, o.name, o.price ? h('small', {}, ` +${baht(o.price)}`) : null))) : null,
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
    else {
      const prev = new Set(st.cart.cook_tickets || []);
      loadOrderIntoCart(r); toast(`ส่งครัวแล้ว · คิว ${r.queue_no}`, 'ok');
      st.cart.cook_tickets = (r.cooker_jobs || []).map((j) => j.ticket_id);
      cookerPopup((r.cooker_jobs || []).filter((j) => !prev.has(j.ticket_id)), `ส่งครัวแล้ว · คิว ${r.queue_no || '-'}`);
    }
    saveCart(); renderCart();
  } catch (e) { errToast(e); if (e.code === 'no_shift') openShiftDialog(); if (e.code === 'version') reloadOrder(); }
}
async function reloadOrder() { if (st.cart.order_id) loadOrderIntoCart(await api.get('/orders/' + st.cart.order_id)); renderCart(); }
function loadOrderIntoCart(o) {
  st.cart = { ...newCart(), cart_id: st.cart.order_id === o.id ? st.cart.cart_id : uid(), order_id: o.id, bill_no: o.bill_no, queue_no: o.queue_no, version: o.version,
    dine_type: o.dine_type === 'takeaway' ? 'takeaway' : 'dine_in', table_id: o.table_id, table_name: o.table_name, customer_name: o.customer_name || '', note: o.note || '',
    member: o.member ? { ...o.member, tier: null } : null, discount: o.discount_info && o.discount_info.manual ? { type: o.discount_info.manual.type, value: o.discount_info.manual.value } : null,
    lines: o.items.filter((i) => i.qty - i.void_qty > 0).map((i) => ({ key: i.id, id: i.id, id_locked: true, product_id: i.product_id, name: i.name, qty: i.qty - i.void_qty, unit_price: i.unit_price,
      options: i.options, note: i.note, dine_type: i.dine_type, bowl_group: i.bowl_group, bowl_count: i.bowl_count, sent_qty: i.sent_qty })), source: o.source, status: o.status,
    cook_tickets: (o.cooker_jobs || []).map((j) => j.ticket_id) };
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
      h('div', { class: 'pay-methods' }, methods.map((m) => h('button', { class: 'btn big' + (method === m.id ? ' on' : ''), onclick: () => { method = m.id; fillAmt(); drawLeft(); drawRight(); } }, m.name))),
      h('div', { style: { marginTop: '1em' } }, h('label', { class: 'switch' }, printReceipt, 'พิมพ์ใบเสร็จ'), ' ', h('label', { class: 'switch' }, printQueue, 'พิมพ์ใบเลขคิว'), ' ',
        h('label', { class: 'switch' }, printMerchant, 'พิมพ์ใบสรุปร้านค้า'), ' ', h('label', { class: 'switch' }, printMobile, 'พิมพ์ใบ Mobile Ordering')));
  };
  const drawRight = () => {
    const rem = remaining();
    const received = toSatang(amt.value);
    const quick = [rem, ...[2000, 10000, 50000, 100000].filter((x) => x > rem)].slice(0, 5);
    // nothing is filled in for the cashier: they type (or tap) what they actually received
    amt.placeholder = method === 'cash' ? 'ใส่จำนวนเงินที่รับมา' : `ใส่จำนวนเงิน (คงเหลือ ${baht(rem)})`;
    right.replaceChildren(
      h('label', { class: 'field' }, method === 'cash' ? 'รับเงินสด (บาท)' : 'จำนวนเงิน (บาท)', amt),
      method === 'cash' ? h('div', { class: 'row' }, [...new Set(quick)].map((q) => h('button', { class: 'btn', onclick: () => { amt.value = (q / 100).toFixed(2); drawRight(); } }, q === rem ? 'พอดี ' + baht(q) : baht(q)))) : null,
      method === 'cash' && received > rem ? h('div', { class: 'bigsum', style: { color: 'var(--ok)' } }, 'ทอน ', baht(received - rem)) : null,
      method === 'promptpay' && st.settings.payment.promptpay_enabled ? h('div', { style: { textAlign: 'center' } }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(qrPayload(Math.min(rem, toSatang(amt.value) || rem))), style: { width: '200px' }, alt: 'PromptPay QR' }),
        h('div', { class: 'small muted' }, 'แสดงบนจอลูกค้าด้วย · ตรวจสอบยอดเงินเข้าก่อนกดยืนยัน'),
        h('button', { class: 'btn block', style: { marginTop: '.5em' }, onclick: () => printPayQr(Math.min(rem, toSatang(amt.value) || rem), false) }, '🖨 พิมพ์ QR ชำระเงิน')) : null,
      keypad(amt, { decimal: true }),
      h('div', { class: 'row', style: { marginTop: '.6em' } }, h('button', { class: 'btn block', onclick: addPay }, '+ เพิ่มช่องทางนี้ (แบ่งจ่าย)')));
    if (method === 'promptpay' && st.settings.payment.promptpay_enabled) printPayQr(rem, true);
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
    fillAmt(); drawLeft(); drawRight();
  };
  // cash: the cashier keys what they received; QR/transfer/card: the amount is the bill (what is left of it)
  const fillAmt = () => { amt.value = method === 'cash' ? '' : (remaining() / 100).toFixed(2); };
  fillAmt();
  drawLeft(); drawRight();
  const idem = st.cart.idem; // same key on retry → never double charged
  modal('ชำระเงิน', h('div', { class: 'pay-grid' }, left, right), { wide: true, onClose: () => pushDisplay(), actions: [
    { label: 'ยกเลิก', onClick: () => {} },
    { label: 'ยืนยันรับเงิน', class: 'ok big', onClick: async () => {
      const list = pays.slice();
      if (paid() < t.total) {
        const v = toSatang(amt.value); const rem = remaining();
        if (!(v > 0)) { toast(method === 'cash' ? 'กรุณาใส่จำนวนเงินที่รับมา' : 'กรุณาใส่จำนวนเงิน', 'warn'); return false; }
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
// printed PromptPay QR slip: auto (shop setting decides, once per bill+amount on the server) or on demand
async function printPayQr(amount, auto) {
  if (!(amount > 0)) return;
  const ref = st.cart.cart_id || st.cart.idem;
  if (auto) { st.payqrAsked = st.payqrAsked || new Set(); if (st.payqrAsked.has(ref + ':' + amount)) return; st.payqrAsked.add(ref + ':' + amount); }
  try {
    const r = await api.post('/print/payqr', { amount, auto, ref, order_id: st.cart.order_id || null, queue_no: st.cart.queue_no || '' });
    if (r.printed) toast(`🖨 พิมพ์ QR ชำระเงิน ${baht(amount)} ฿`, 'ok');
  } catch (e) { if (!auto) errToast(e); }
}
const qrPayload = (amount) => (st.settings.payment.promptpay_enabled ? promptPayPayload(st.settings.payment.promptpay_id || '', amount) : null);
function done(o) {
  const change = o.change_amount;
  const methods = (o.payments || []).map((p) => (st.settings.sale.payment_methods.find((x) => x.id === p.method) || {}).name || p.method);
  // the thank-you screen stays on the customer display until the cashier presses "เสร็จ"
  pushDisplay({ phase: 'done', queue_no: o.queue_no, change, total: o.total, received: o.paid_amount + change, dine_type: o.dine_type, bill_no: o.bill_no, methods: [...new Set(methods)],
    livePay: { done: true, bill_no: o.bill_no, method: methods.join(' + '), change } });
  modal('ชำระเงินสำเร็จ', h('div', { style: { textAlign: 'center' } }, h('div', { class: 'muted' }, 'เลขคิว'), h('div', { class: 'qbig' }, o.queue_no || '-'),
    h('div', { class: 'badge ' + (o.dine_type === 'takeaway' ? 'takeaway' : 'info'), style: { fontSize: '1.2em' } }, dineLabel(o.dine_type)),
    change ? h('div', { class: 'bigsum', style: { color: 'var(--ok)', marginTop: '.4em' } }, 'เงินทอน ', baht(change), ' ฿') : null,
    h('p', { class: 'muted' }, `บิล ${o.bill_no} · ${o.bowls} ${U()}`), o.claim_token ? h('p', { class: 'small muted' }, 'ใบเสร็จมี QR ให้ลูกค้าสมัครสมาชิก/รับแต้มย้อนหลัง') : null),
  { onClose: () => { st.displayHold = false; pushDisplay({ phase: 'idle' }); }, actions: [{ label: '✓ เสร็จ · บิลถัดไป', class: 'primary big', onClick: () => {} }] });
  const prevCook = new Set(st.cart.cook_tickets || []);
  cookerPopup((o.cooker_jobs || []).filter((j) => !prevCook.has(j.ticket_id)), `ส่งครัว · คิว ${o.queue_no || '-'}`);
  st.displayHold = true;
  st.cart = newCart(); st.activeBowl = null; saveCart(); renderCart();
  st.shift && api.get('/shifts/current').then((s) => { st.shift = s; }).catch(() => {});
}

// ---------------- customer display ----------------
let lastPhase = 'idle';
// discount lines for the customer display (manual bill discount and member tier discount)
function discountRows(c, t) {
  const rows = [];
  const manual = (t.discount || 0) - (t.tierAmt || 0);
  if (manual > 0 && c.discount) rows.push({ label: 'ส่วนลด' + (c.discount.type === 'percent' ? ` ${c.discount.value}%` : '') + (c.discount.reason ? ` · ${c.discount.reason}` : ''), amount: manual });
  if (t.tierAmt > 0) rows.push({ label: `ส่วนลดสมาชิก ${(c.member.tier && c.member.tier.name) || ''} ${c.member.tier.discount_pct}%`.replace(/\s+/g, ' '), amount: t.tierAmt });
  return rows;
}
function pushDisplay(extra = {}) {
  if (!st.cart || !st.sock) return;
  const { livePay, ...ex } = extra;
  // keep the thank-you screen until the cashier finishes (or starts keying the next bill)
  if (st.displayHold && !extra.phase) { if (!st.cart.lines.length) return; st.displayHold = false; }
  const t = previewTotals();
  const phase = extra.phase || (st.cart.lines.length ? 'cart' : 'idle');
  lastPhase = phase;
  const m = st.cart.member;
  const state = { cart_id: st.cart.cart_id, phase, dine_type: orderDineType(st.cart.lines.length ? st.cart.lines : [{ qty: 1, dine_type: st.cart.dine_type }]),
    lines: st.cart.lines.map((l) => { const rn = renamedLine(l.name, l.options || [], 'everywhere'); return { name: rn.name, qty: l.qty, options: rn.options.map(displayOption), price: lineTotal(l), dine_type: l.dine_type, bowl_group: l.bowl_group }; }),
    items_total: t.items_total, discount: t.discount, packaging: t.packaging, tax: t.tax, total: t.total, bowls: t.bowls, table: st.cart.table_name,
    member: m && st.settings.members.show_on_display ? { name: (m.first_name || m.nickname || '').slice(0, 2) + '***', points: m.points, tier: m.tier && m.tier.name, earn: previewEarn(st.cart, t) } : null,
    queue_no: st.cart.queue_no || '', discounts: discountRows(st.cart, t),
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
// the merchant summary roll (58 mm, no cut per slip) was fed out at close: tear it off, feed more, or cut (printers with a cutter)
function rollBox(roll, onPress) {
  if (!roll.length) return null;
  const cut = roll.some((p) => p.cut), canCut = roll.some((p) => p.can_cut);
  const say = h('small', {}, cut ? '✂️ ป้อนกระดาษและตัดให้แล้ว' : '⬆️ ป้อนกระดาษออกมาแล้ว ฉีกได้เลย');
  const send = async (lines, doCut, msg) => {
    onPress();
    try { await api.post('/print/merchant-feed', { lines, cut: doCut }); say.textContent = msg; say.classList.remove('flash'); void say.offsetWidth; say.classList.add('flash'); } catch (e) { errToast(e); }
  };
  return h('div', { class: 'roll-box' },
    h('b', {}, '🧻 ใบสรุปร้านค้า · ', roll.map((p) => p.name).join(', ')), say,
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', onclick: () => send(4, false, '⬆️ ป้อนเพิ่มแล้ว') }, '⬆️ ป้อนกระดาษเพิ่ม'),
      canCut ? h('button', { class: 'btn', onclick: () => send(2, true, '✂️ ตัดแล้ว') }, '✂️ ตัดกระดาษ') : null));
}
// after closing a shift: stay a few seconds so this device (the print host) finishes the report, then sign out
// merchant summary of the whole shift, printed at close: confirm the paper (58 mm warning), print, wait until it's done
function mcBox(r, hold) {
  const mc = r.merchant_close || {};
  if (!mc.enabled) return null;
  const box = h('div', { class: 'mc-box' });
  const head = h('b', {}, `🧾 ใบสรุปร้านค้า (ทั้งรอบ) · ${mc.paper} มม.`, mc.printer ? ' · ' + mc.printer.name : '');
  if (!mc.printer) { box.append(head, h('small', { class: 'bad' }, '⚠️ ยังไม่ได้ตั้งเครื่องพิมพ์ใบสรุปร้านค้า — ตั้งที่ จัดการร้าน → เครื่องพิมพ์')); return box; }
  let jobs = [], since = 0;
  const confirm = () => {
    hold(true);
    box.className = 'mc-box ask';
    box.replaceChildren(head,
      mc.paper === 58 ? h('div', { class: 'mc-warn' }, h('b', {}, '⚠️ ตรวจกระดาษก่อนพิมพ์'), h('span', {}, 'ใส่ม้วนกระดาษ 58 มม. แล้วหรือยัง? ถ้าเครื่องยังเป็นกระดาษ 80 มม. อย่าลืมเปลี่ยนเป็น 58 มม. ก่อนกดพิมพ์'),
        mc.printer.paper && Number(mc.printer.paper) !== 58 ? h('small', {}, `(เครื่องนี้ตั้งไว้ ${mc.printer.paper} มม. — ใบนี้จะพิมพ์กว้าง 58 มม.)`) : null)
        : h('small', {}, 'พิมพ์กว้าง 80 มม.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: () => { hold(false); box.replaceChildren(head, h('small', {}, 'ข้าม ไม่พิมพ์ใบสรุปร้านค้า')); } }, 'ไม่พิมพ์'),
        h('button', { class: 'btn primary', onclick: print }, '🖨️ ยืนยัน พิมพ์เลย')));
  };
  const print = async () => {
    box.className = 'mc-box busy';
    box.replaceChildren(head, h('div', { class: 'spinner sm' }), h('small', {}, 'กำลังพิมพ์… ระบบจะกลับหน้าหลักเมื่อพิมพ์เสร็จ'));
    try { const x = await api.post(`/shifts/${r.id}/merchant-print`, { paper: mc.paper }); jobs = x.jobs; since = Date.now(); watch(); }
    catch (e) { failed(e.message); }
  };
  const failed = (msg) => {
    box.className = 'mc-box bad';
    box.replaceChildren(head, h('small', {}, '⚠️ ' + msg), h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', onclick: () => { hold(false); box.replaceChildren(head, h('small', {}, 'ไม่ได้พิมพ์')); } }, 'ข้าม'),
      h('button', { class: 'btn primary', onclick: print }, '↻ พิมพ์ใหม่')));
  };
  const watch = async () => {
    if (!document.body.contains(box)) return;
    try {
      const st2 = await api.get('/print/jobs/status?ids=' + jobs.join(','));
      if (st2.length && st2.every((j) => j.status === 'printed' || j.status === 'sent')) {
        box.className = 'mc-box good'; box.replaceChildren(head, h('small', {}, '✓ พิมพ์เสร็จแล้ว')); hold(false, 3); return;
      }
      const bad = st2.find((j) => ['failed', 'unknown', 'cancelled'].includes(j.status));
      if (bad) return failed(bad.error || 'พิมพ์ไม่สำเร็จ — ตรวจกระดาษ/การเชื่อมต่อเครื่องพิมพ์');
      if (Date.now() - since > 45000) box.querySelector('small').textContent = 'ยังไม่ออก? ตรวจว่าเครื่องพิมพ์เปิดอยู่และเชื่อมกับเครื่องนี้ · ยังรออยู่…';
    } catch { /* keep waiting */ }
    setTimeout(watch, 1000);
  };
  setTimeout(confirm, 0);
  return box;
}
function leaveAfterPrint(r, secs = 10) {
  let left = secs, held = false;
  const num = h('b', { class: 'lp-num' }, String(left));
  const ring = h('i', { class: 'lp-ring', style: `--s:${secs}s` });
  const box = h('div', { class: 'leave-print' }, h('div', { class: 'card' },
    h('div', { class: 'lp-clock' }, ring, num),
    h('h2', {}, '✓ ปิดรอบแล้ว'),
    h('p', {}, '🖨️ กำลังพิมพ์รายงานปิดรอบ… อย่าเพิ่งปิดเครื่อง'),
    h('p', { class: 'muted' }, r.diff === 0 ? 'เงินสดตรงพอดี' : r.diff > 0 ? `เงินสดเกิน ${baht(r.diff)} บาท` : `เงินสดขาด ${baht(-r.diff)} บาท`),
    rollBox(r.roll || [], () => { if (left < 4) { left = 4; num.textContent = '4'; } }),
    // printing the shift's merchant summary: the countdown waits until it is printed (then 3 s more)
    mcBox(r, (on, after) => { held = on; box.classList.toggle('held', on); if (!on && after) { left = after; num.textContent = String(left); ring.style.setProperty('--s', left + 's'); ring.style.animation = 'none'; void ring.offsetWidth; ring.style.animation = ''; } }),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('button', { class: 'btn', onclick: () => { left += 10; num.textContent = String(left); ring.style.setProperty('--s', left + 's'); ring.style.animation = 'none'; void ring.offsetWidth; ring.style.animation = ''; } }, '+10 วินาที'),
      h('button', { class: 'btn primary', onclick: () => { clearInterval(t); logout(); } }, 'ออกจากระบบเลย'))));
  document.body.append(box);
  const t = setInterval(() => { if (held) return; left--; num.textContent = String(Math.max(0, left)); if (left <= 0) { clearInterval(t); logout(); } }, 1000);
}
async function shiftDialog() {
  const s = await api.get('/shifts/current');
  st.shift = s;
  if (!s) return openShiftDialog();
  const names = Object.fromEntries(st.settings.sale.payment_methods.map((m) => [m.id, m.name]));
  const counted = h('input', { class: 'input', inputmode: 'decimal', placeholder: 'เงินสดที่นับได้' });
  const diffEl = h('div', { class: 'bigsum' });
  counted.addEventListener('input', () => { const d = toSatang(counted.value) - s.expected_cash; diffEl.textContent = counted.value ? (d === 0 ? 'ตรงพอดี' : d > 0 ? `เกิน ${baht(d)}` : `ขาด ${baht(-d)}`) : ''; diffEl.style.color = d === 0 ? 'var(--ok)' : 'var(--bad)'; });
  const link = await api.get(`/shifts/${s.id}/link`).catch(() => null);
  const qrUrl = link && link.url ? (/^https?:/.test(link.url) ? link.url : location.origin + link.url) : null;
  const body = h('div', { class: 'pay-grid shift-grid' }, h('div', { class: 'shift-left' },
    shiftStats(s, U()), shiftDetailsView(s, names, U()),
    can('cash_move') && h('div', { class: 'row', style: { marginTop: '.8em' } }, h('button', { class: 'btn', onclick: () => cashMove('in') }, '+ เงินเข้าลิ้นชัก'), h('button', { class: 'btn', onclick: () => cashMove('out') }, '− เงินออกลิ้นชัก')),
    h('button', { class: 'btn', style: { marginTop: '.5em' }, onclick: () => api.post(`/shifts/${s.id}/print`).then(() => toast('ส่งพิมพ์สรุปแล้ว', 'ok')).catch(errToast) }, '🖨 พิมพ์สรุประหว่างรอบ')),
  h('div', {}, h('h4', {}, 'ปิดรอบ'), h('label', { class: 'field' }, 'เงินสดที่นับได้ (บาท)', counted), keypad(counted, { decimal: true }), diffEl,
    qrUrl ? h('div', { class: 'shift-qr' }, h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(qrUrl), alt: 'QR รายงานรอบ' }), h('small', {}, 'สแกนดูรายงานรอบนี้บนมือถือ (ไม่ต้องเข้าสู่ระบบ)')) : null));
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
    // closing the shift signs this device out; the summary is shown on the login screen
    store.set('closed_shift', { ...r, names, qr: qrUrl });
    leaveAfterPrint(r);
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
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: pairDisplay }, 'สร้างรหัสจับคู่ (6 หลัก)'), h('button', { class: 'btn', onclick: openSecondScreen }, '🖥️ เปิดบนจอที่สอง (Dual Screen)'),
      h('button', { class: 'btn', onclick: () => dualScreenGuide() }, '📱 วิธีเชื่อมเครื่อง Android 2 จอ (iMin / Sunmi)')),
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
  // the shop's Android app (android/ in this repo): the customer display goes on the built-in second screen, no mirroring
  if (window.OppaBridge && window.OppaBridge.openCustomerDisplay) {
    const ok = window.OppaBridge.openCustomerDisplay(location.origin + url);
    return ok === false ? toast('ไม่พบจอที่สองบนเครื่องนี้', 'warn', 6000) : toast('🖥️ เปิดจอลูกค้าบนจอที่สองแล้ว', 'ok');
  }
  // Android 2-screen POS (iMin, Sunmi ...): Chrome can show a page on the built-in second screen via the Presentation API
  if (/Android/i.test(navigator.userAgent)) {
    if ('PresentationRequest' in window) {
      try {
        const conn = await new PresentationRequest([location.origin + url]).start();
        st.presentation = conn;
        return toast('เปิดจอลูกค้าบนจอที่สองแล้ว', 'ok');
      } catch (e) {
        if (e && e.name === 'AbortError') return; // the cashier closed the screen picker
        toast('Chrome บนเครื่องนี้ส่งหน้าไปจอที่สองไม่ได้ — ดูวิธีอื่นในคู่มือ', 'warn', 6000);
      }
    }
    return dualScreenGuide(r.code);
  }
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
// how to connect the customer display on Android two-screen POS devices (iMin Swan 2, Sunmi D3 ...)
function dualScreenGuide(code) {
  const url = location.origin + '/display/';
  const step = (n, title, ...body) => h('div', { class: 'dg-step' }, h('b', { class: 'n' }, n), h('div', {}, h('strong', {}, title), ...body));
  modal('📱 เชื่อมจอลูกค้า เครื่อง Android 2 จอ', h('div', { class: 'dualguide' },
    h('p', { class: 'muted' }, 'สำหรับเครื่อง POS แบบ 2 จอ เช่น iMin Swan 2 / Swan 1 / D4 / Falcon 2, Sunmi D3 Pro / T2s / D2s และรุ่นอื่นที่จอลูกค้าต่ออยู่กับเครื่องเดียวกัน — ลองทีละวิธีตามลำดับ'),
    step('★', 'แนะนำ: ติดตั้งแอป Oppa POS (จอที่สองไม่สะท้อนจอ)', h('p', {}, 'บนเครื่อง POS เปิด ', h('a', { href: 'https://github.com/purinutkit-creator/opparamyeon/releases/tag/android-latest', target: '_blank' }, 'หน้าดาวน์โหลดแอป'),
      ' → ดาวน์โหลด OppaPOS-dual-screen.apk → เปิดไฟล์ → อนุญาตติดตั้งแอปจากแหล่งนี้ → ติดตั้ง แล้วเปิดแอป "Oppa POS" เข้าสู่ระบบตามปกติ จอลูกค้าจะขึ้นบนจอที่สองเองทุกครั้ง'),
      h('p', { class: 'small muted' }, 'แอปใช้จอที่สองของ Android โดยตรง (iMin Swan / D4 / Falcon, Sunmi D3 ...) — กล้อง เครื่องพิมพ์ LAN/Bluetooth ใช้ได้ในแอป')),
    step('1', 'ปุ่ม "🖥️ เปิดบนจอที่สอง" ใน Chrome', h('p', {}, 'เปิด POS ด้วย Google Chrome (อัปเดตล่าสุด) → อุปกรณ์ → เปิดบนจอที่สอง → ถ้ามีหน้าต่างให้เลือกจอ ให้เลือกจอที่สอง/Built-in display หน้าจอลูกค้าจะขึ้นบนจอฝั่งลูกค้าและอัปเดตเรียลไทม์'),
      h('p', { class: 'small muted' }, 'ใช้ Presentation API ของ Chrome — ขึ้นกับรุ่นและเฟิร์มแวร์ ถ้าไม่มีจอให้เลือก ให้ใช้วิธีที่ 2–4')),
    step('2', 'เปิดเบราว์เซอร์บนจอที่สองเอง แล้วกรอกรหัส', h('p', {}, 'บางรุ่นย้ายแอปไปจอที่สองได้ (แอปจัดการจอที่สองของผู้ผลิต หรือ ตั้งค่า → ตัวเลือกสำหรับนักพัฒนา → "บังคับโหมดเดสก์ท็อป"/"Force desktop mode" แล้วรีสตาร์ต) เมื่อเปิด Chrome บนจอที่สองได้ ให้เข้า ',
      h('code', {}, url), ' แล้วกรอกรหัส 6 หลัก', code ? [' ', h('b', { class: 'dg-code' }, code)] : ' (กด "สร้างรหัสจับคู่" ในเมนูอุปกรณ์)')),
    step('3', 'แอป Android ของร้าน (OppaBridge)', h('p', {}, 'แอปห่อเว็บ POS ที่เรียก SDK จอที่สองของ iMin/Sunmi โดยตรง — เปิดจอลูกค้าอัตโนมัติและพิมพ์ด้วยเครื่องพิมพ์ในตัวได้ ระบบรองรับแล้ว (ดูสัญญา OppaBridge ในคู่มือ) ต้องติดตั้งแอปที่สร้างสำหรับรุ่นนั้น')),
    step('4', 'ทางเลือกเมื่อยังเชื่อมจอที่สองไม่ได้', h('p', {}, 'ใช้แท็บเล็ต/มือถือเครื่องใดก็ได้เป็นจอลูกค้า (เปิดลิงก์ด้านบน + รหัส 6 หลัก) หรือให้ระบบ ', h('b', {}, 'พิมพ์ใบ QR ชำระเงิน'), ' ออกจากเครื่องพิมพ์ให้ลูกค้าสแกนจ่าย (ตั้งค่าได้ที่ จัดการร้าน → ตั้งค่าร้าน → ลำดับและเอกสารที่พิมพ์)'))),
    { wide: true, autofocus: false, actions: [{ label: 'เปิดคู่มือฉบับเต็ม', onClick: () => { window.open('/guide/#display-android', '_blank'); return false; } }, { label: 'เข้าใจแล้ว', class: 'primary', onClick: () => {} }] });
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
// QR from the merchant slip (signed bill link) → open that bill
function openBillLink(code) {
  const tok = billTokenOf(code);
  if (!tok) return false;
  api.get('/orders/by-bill/' + encodeURIComponent(tok.split('.')[0])).then((r) => openOrder(r.id)).catch(errToast);
  return true;
}
function setupScanner() {
  // A barcode scanner "types" the digits very fast. A burst is handled as soon as it ends,
  // with or without the Enter key that some scanners send.
  let buf = '', last = 0, fast = true, timer = null;
  const handle = (raw, enter) => {
    const code = fromThaiKeys(raw); // device keyboard set to Thai: "คคถ-ต/" → "885392"
    if (openBillLink(code)) return;
    if (addByCode(code)) return;
    // bill barcode from the merchant copy / receipt → open that bill
    if (/^[A-Z]+\d{6}-\d{4}$/i.test(code)) { api.get('/orders/by-bill/' + encodeURIComponent(code)).then((r) => openOrder(r.id)).catch(errToast); return; }
    if (/^[A-Z0-9]{8,12}$/i.test(code) && can('redeem')) return couponDialog(code.toUpperCase());
    if (enter || code.length >= 6) toast('ไม่พบสินค้าจากบาร์โค้ด ' + code, 'error');
  };
  const flush = (enter) => {
    clearTimeout(timer); timer = null;
    const code = buf, wasFast = fast; buf = ''; fast = true;
    if (code.length >= 4 && (enter || wasFast)) { handle(code, enter); return true; }
    return false;
  };
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const inField = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (inField) return; // typing in a form (the search box handles its own codes)
    if (st.locked || document.querySelector('.modal-back:not(.closing)')) return;
    const now = performance.now();
    if (now - last > 300) { buf = ''; fast = true; }
    else if (buf && now - last > 60) fast = false; // human typing speed
    last = now;
    if (e.key === 'Enter') { if (buf && flush(true)) e.preventDefault(); return; }
    if (e.key.length !== 1) return;
    buf += e.key;
    clearTimeout(timer);
    timer = setTimeout(() => flush(false), 120);
  });
}

// ---------------- auto lock ----------------
// ---------------- screen lock when nobody touches the POS (จัดการร้าน → ล็อกหน้าจอ) ----------------
let lockTimer = null, warnEl = null;
const lockCfg = () => ({ enabled: true, seconds: 300, warn: 10, action: 'lock', keep_with_bill: false, ...((st.settings && st.settings.lock) || {}) });
const dropWarn = () => { if (warnEl) { const w = warnEl; warnEl = null; leave(w, 'out', () => w.remove(), 260); } };
function setupAutoLock() {
  st.lastActivity = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => document.addEventListener(ev, () => { st.lastActivity = Date.now(); dropWarn(); }, { capture: true, passive: true }));
  clearInterval(lockTimer);
  lockTimer = setInterval(checkIdle, 1000); // settings changes apply on the next tick (they arrive over the socket)
}
function checkIdle() {
  const c = lockCfg();
  if (!c.enabled || st.locked || document.querySelector('.leave-print') || (c.keep_with_bill && st.cart && st.cart.lines.length)) { if (!st.locked) st.lastActivity = Date.now(); return dropWarn(); } // off / on hold: the idle time starts again afterwards
  const left = Math.ceil(c.seconds - (Date.now() - st.lastActivity) / 1000);
  if (left <= 0) { dropWarn(); return c.action === 'logout' ? logout() : lockNow(); }
  if (c.warn && left <= c.warn) {
    if (!warnEl) {
      warnEl = h('div', { class: 'idle-warn' }, h('div', { class: 'card' }, h('b', { class: 'iw-num' }),
        h('div', {}, h('strong', {}, c.action === 'logout' ? 'จะออกจากระบบ' : 'จะล็อกหน้าจอ'), h('small', {}, 'ไม่มีการใช้งาน · แตะหน้าจอเพื่อใช้งานต่อ'))));
      document.body.append(warnEl);
    }
    warnEl.querySelector('.iw-num').textContent = left;
  }
}
function lockNow() {
  if (st.locked) return;
  st.locked = true;
  let pin = '';
  const dots = h('div', { class: 'pin-dots' });
  const draw = () => dots.replaceChildren(...Array.from({ length: Math.max(4, Math.min(6, pin.length + (pin.length < 6 ? 1 : 0))) }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
  draw();
  const time = h('b', { class: 'lk-time' }), date = h('span', { class: 'lk-date' });
  const tick = () => {
    const d = new Date();
    time.textContent = d.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    date.textContent = d.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  };
  tick(); const ct = setInterval(tick, 1000);
  const unlock = () => {
    clearInterval(ct); document.removeEventListener('keydown', onKey, true);
    st.locked = false; st.lastActivity = Date.now();
    leave(el, 'out', () => el.remove(), 420);
  };
  const go = async () => {
    if (!pin) return toast('ใส่ PIN', 'warn');
    try { const r = await api.post('/auth/unlock', { pin }); if (!r.ok) throw new Error('PIN ไม่ถูกต้อง'); unlock(); }
    catch (e) { errToast(e); pin = ''; draw(); dots.classList.remove('shake'); void dots.offsetWidth; dots.classList.add('shake'); }
  };
  const press = (k) => { if (k === '⌫') pin = pin.slice(0, -1); else if (k === 'C') pin = ''; else if (pin.length < 6) pin += k; draw(); if (pin.length === 6) go(); };
  const onKey = (e) => {
    if (!document.body.contains(el)) return document.removeEventListener('keydown', onKey, true);
    e.stopPropagation();
    if (/^\d$/.test(e.key)) { e.preventDefault(); press(e.key); } else if (e.key === 'Backspace') { e.preventDefault(); press('⌫'); } else if (e.key === 'Enter') { e.preventDefault(); go(); }
  };
  document.addEventListener('keydown', onKey, true);
  const pic = st.staff.photo ? h('img', { src: st.staff.photo, alt: '' }) : (String(st.staff.name || '?').replace(/^[เแโใไ]/, '')[0] || '?');
  const el = h('div', { class: 'lock lock2' },
    h('div', { class: 'lk-left' }, time, date, h('div', { class: 'lk-who' }, h('span', { class: 'lk-ph' }, pic), h('b', {}, st.staff.name), h('small', {}, st.terminal.name))),
    h('div', { class: 'card lk-card' }, h('h2', {}, '🔒 หน้าจอถูกล็อก'), h('p', { class: 'muted' }, 'ไม่มีการใช้งาน · ใส่ PIN ของ ' + st.staff.name + ' เพื่อใช้งานต่อ'),
      dots, h('div', { class: 'bigpad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'].map((k, i) => h('button', { type: 'button', class: 'key' + (k === 'C' || k === '⌫' ? ' fn' : ''), style: `--i:${i}`, onclick: () => press(k) }, k))),
      h('button', { class: 'btn primary big block', onclick: go }, 'ปลดล็อก'),
      h('button', { class: 'btn ghost block', style: { marginTop: '.5em' }, onclick: logout }, '🔄 สลับผู้ใช้ / สแกนบัตรคนอื่น')));
  document.body.append(el);
}
async function logout() { await api.post('/auth/logout').catch(() => {}); store.del('staff_token'); location.reload(); }

window.addEventListener('beforeunload', () => { if (st.sock) pushDisplay({ phase: 'idle' }); });
boot().catch((e) => { console.error(e); app.replaceChildren(h('div', { class: 'empty' }, 'โหลดไม่สำเร็จ: ' + e.message, h('br'), h('button', { class: 'btn', onclick: () => location.reload() }, 'ลองใหม่'))); });
storageWarning();
