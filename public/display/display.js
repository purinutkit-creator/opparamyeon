import { makeApi, store, socket } from '/shared/api.js';
import { h, $, toast, errToast, keypad } from '/shared/ui.js';
import { baht, dineLabel, VERSION } from '/shared/core.js';
import { applyFonts } from '/shared/fonts.js';

const qs = new URLSearchParams(location.search);
const preview = qs.get('preview') === '1';
const api = makeApi({ tokenKey: 'display_token' });
const root = $('#root');
let settings, state = { phase: 'idle' }, prompt = null, sock = null, slideTimer = null, doneTimer = null;

async function boot() {
  settings = await fetch('/api/settings/public').then((r) => r.json());
  if (preview) {
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.display) { settings.display = { ...settings.display, ...e.data.display }; applyTheme(); renderAll(); } });
    state = qs.get('phase') === 'idle' ? { phase: 'idle' } : sampleState();
    applyTheme(); renderAll();
    // ?demo=1 plays the cash flow: nothing received → partly received → paid with change
    if (qs.get('demo') && state.phase === 'pay' && !state.qr) {
      state.received = 0; state.change = 0; renderAll();
      [10000, 20000, 50000].forEach((r, i) => setTimeout(() => { state = { ...state, received: r, change: Math.max(0, r - state.total) }; renderAll(); }, 1200 + i * 1400));
    }
    return;
  }
  const code = qs.get('code');
  if (code && !store.get('display_token')) {
    try { const r = await api.post('/display/pair', { code, touch: matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 }, { token: null }); store.set('display_token', r.token); history.replaceState(null, '', location.pathname + (qs.get('local') ? '?local=' + qs.get('local') : '')); }
    catch (e) { errToast(e); }
  }
  if (!store.get('display_token')) return pairing();
  try { await api.get('/display/me'); } catch (e) { if (e.status === 403) { store.del('display_token'); return pairing(); } }
  applyTheme(); renderAll();
  sock = await socket({ kind: 'display', token: store.get('display_token') });
  sock.on('connect', () => net(true));
  sock.on('disconnect', () => net(false));
  sock.on('display:state', onState);
  sock.on('display:revoked', () => { store.del('display_token'); location.reload(); });
  sock.on('settings:changed', async () => { settings = await fetch('/api/settings/public').then((r) => r.json()); applyTheme(); renderAll(); });
  sock.on('member:prompt', (p) => { prompt = { ...p, value: '', results: null }; renderPrompt(); });
  sock.on('member:prompt_closed', () => { prompt = null; renderPrompt(); });
  // Dual Screen on the same device: also listen locally (keeps working for a moment if the network blips)
  const local = qs.get('local');
  if (local) try { new BroadcastChannel('opp-display-' + local).onmessage = (e) => onState(e.data); } catch { /* */ }
  setInterval(() => { if (prompt && new Date(prompt.expires_at) < new Date()) { prompt = null; renderPrompt(); } }, 1000);
}
function net(ok) { let n = $('.net'); if (!n) { n = h('div', { class: 'net' }); document.body.append(n); } n.textContent = ok ? `● เชื่อมต่อแล้ว · v${VERSION}` : '○ ขาดการเชื่อมต่อ กำลังเชื่อมต่อใหม่…'; }

function pairing() {
  const inp = h('input', { class: 'input', inputmode: 'numeric', maxlength: 6, placeholder: '______', style: { fontSize: '2.4em', textAlign: 'center', letterSpacing: '.3em' } });
  const go = async () => {
    try { const r = await api.post('/display/pair', { code: inp.value, touch: navigator.maxTouchPoints > 0 }, { token: null }); store.set('display_token', r.token); location.reload(); }
    catch (e) { errToast(e); inp.value = ''; }
  };
  root.replaceChildren(h('div', { class: 'pairing' }, h('div', { class: 'pbox' },
    h('h2', {}, '📺 จับคู่จอลูกค้า'), h('ol', { class: 'muted' }, h('li', {}, 'ที่เครื่อง POS กด 🖨️ อุปกรณ์ → "สร้างรหัสจับคู่"'), h('li', {}, 'กรอกรหัส 6 หลักที่แสดงบน POS')),
    inp, h('div', { style: { marginTop: '.8em' } }, keypad(inp, { onEnter: go })), h('p', { class: 'version' }, 'v' + VERSION))));
}

function applyTheme() {
  const d = settings.display;
  const r = document.documentElement.style;
  r.setProperty('--d-bg', d.bg || '#111827'); r.setProperty('--d-fg', d.color || '#fff'); r.setProperty('--d-accent', d.accent || '#ef4444'); r.setProperty('--fit', d.fit || 'cover');
  applyFonts(settings.fonts, 'display');
}
function onState(s) {
  if (!s || (s.at && state.at && s.at < state.at)) return; // ignore out-of-order updates
  if (prompt && s.cart_id && prompt.cart_id !== s.cart_id) { prompt = null; renderPrompt(); } // bill changed → close member entry
  state = s;
  renderAll();
}

function renderAll() {
  const d = settings.display;
  const active = state.phase && state.phase !== 'idle';
  const paying = state.phase === 'pay';
  // while paying, the payment panel (total + QR) replaces the promotion half — order list stays on the other half
  const wrap = h('div', { class: `disp ${d.layout === 'full' && !paying ? 'full' : 'split'}${active ? ' active' : ''}${paying ? ' paying' : ''}` },
    h('div', { class: 'promo', id: 'promo' }), h('div', { class: 'panel', id: 'panel' }));
  const old = $('.disp');
  if (old && old.className === wrap.className) { renderPanel(); if (paying) renderPay(); return renderDone(); }
  root.replaceChildren(wrap);
  if (paying) renderPay(); else renderPromo();
  renderPanel(); renderDone(); renderPrompt();
}
// smooth number change (counts from the previous value)
function tween(node, to, ms = 520) {
  if (!node) return;
  const from = node._v ?? 0;
  node._v = to;
  if (from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = baht(to); return; }
  const t0 = performance.now();
  cancelAnimationFrame(node._raf);
  const step = (t) => { const k = Math.min(1, (t - t0) / ms), e = 1 - Math.pow(1 - k, 3); node.textContent = baht(Math.round(from + (to - from) * e)); if (k < 1) node._raf = requestAnimationFrame(step); };
  node._raf = requestAnimationFrame(step);
}
function coinBurst(host) {
  const box = h('div', { class: 'coins' }, Array.from({ length: 18 }, (_, i) => h('i', { style: `--dx:${((Math.random() * 2 - 1) * 22).toFixed(1)}vh;--dy:${(-(8 + Math.random() * 18)).toFixed(1)}vh;--r:${Math.round(Math.random() * 540)}deg;animation-delay:${i * 18}ms` }, i % 3 ? '🪙' : '✨')));
  host.append(box); setTimeout(() => box.remove(), 1600);
}
const BILL_SVG = '<svg viewBox="0 0 64 40"><rect x="2" y="4" width="60" height="32" rx="6" fill="#22c55e"/><rect x="7" y="9" width="50" height="22" rx="4" fill="none" stroke="#bbf7d0" stroke-width="2"/><circle cx="32" cy="20" r="7" fill="#bbf7d0"/><text x="32" y="24.5" font-size="11" text-anchor="middle" fill="#15803d" font-weight="800">฿</text></svg>';

// The payment half is built once per payment mode and then updated in place, so its animations never restart while the cashier types.
function renderPay() {
  const el = $('#promo'); if (!el) return;
  clearTimeout(slideTimer);
  const s = state;
  const unit = settings.sale.count_unit || 'ชาม';
  const showQr = s.qr && settings.display.show_qr !== false;
  const mode = showQr ? 'qr:' + s.qr : 'cash';
  if (el.dataset.mode !== mode) {
    el.dataset.mode = mode;
    const head = h('div', { class: 'payhead' }, h('div', { class: 'lbl' }, 'ยอดที่ต้องชำระ', h('span', { id: 'payUnit' })), h('div', { class: 'amt' }, h('span', { id: 'payAmt' }), h('small', {}, '฿')));
    let body;
    if (showQr) {
      const img = h('img', { class: 'qrimg', alt: 'QR พร้อมเพย์', src: '/api/qr.svg?d=' + encodeURIComponent(s.qr) });
      const frame = h('div', { class: 'qrframe' }, h('div', { class: 'qrskel' }, h('span', {}, 'กำลังสร้าง QR…')), img, h('b', { class: 'cn tl' }), h('b', { class: 'cn tr' }), h('b', { class: 'cn bl' }), h('b', { class: 'cn br' }), h('i', { class: 'scan' }));
      // reveal once the code has really loaded (never show a half-drawn QR)
      const t0 = performance.now();
      const ready = () => setTimeout(() => frame.classList.add('ready'), Math.max(0, 700 - (performance.now() - t0)));
      img.onerror = () => { frame.querySelector('.qrskel span').textContent = 'โหลด QR ไม่สำเร็จ · แจ้งพนักงาน'; };
      if (img.complete && img.naturalWidth) ready(); else img.onload = ready;
      body = h('div', { class: 'payarea' }, h('div', { class: 'qrcard' }, h('div', { class: 'qrtitle' }, h('span', { class: 'pp' }, 'PromptPay'), 'THAI QR PAYMENT'), frame,
        h('div', { class: 'qracc' }, 'ชื่อบัญชี: ', settings.payment.promptpay_name || '-'), h('div', { class: 'qracc big' }, 'สแกนจ่าย ', h('span', { id: 'qrAmt' }), ' บาท')));
    } else {
      body = h('div', { class: 'cashcard' },
        h('div', { class: 'cc-head' }, h('span', { class: 'bill', html: BILL_SVG + BILL_SVG }), h('div', {}, h('b', {}, 'ชำระด้วยเงินสด'), h('small', {}, 'Cash payment'))),
        h('div', { class: 'cc-row recv' }, h('span', {}, '💵 รับเงิน'), h('b', { id: 'ccRecv' }, baht(0))),
        h('div', { class: 'cc-bar' }, h('i', { id: 'ccBar' })),
        h('div', { class: 'cc-state', id: 'ccState' }),
        h('div', { class: 'cc-change', id: 'ccChange' }, h('span', {}, '💰 เงินทอน'), h('b', { id: 'ccChangeAmt' })));
    }
    el.replaceChildren(h('div', { class: 'paybox' + (showQr ? ' isqr' : ' iscash') }, head, body,
      h('div', { class: 'paystatus', id: 'payStatus' }, h('i'), showQr ? 'รอชำระเงิน · สแกนด้วยแอปธนาคารใดก็ได้' : 'รอชำระเงิน')));
    el._prev = {};
  }
  const prev = el._prev || {};
  $('#payUnit').textContent = s.bowls ? ` · ${s.bowls} ${unit}` : '';
  tween($('#payAmt'), s.total);
  if (showQr) { tween($('#qrAmt'), s.total); return; }
  const recv = s.received || 0, change = s.change || 0, short = Math.max(0, s.total - recv);
  const rv = $('#ccRecv');
  tween(rv, recv); rv.classList.toggle('zero', !recv);
  const pct = s.total ? Math.min(100, Math.round(recv / s.total * 100)) : 0;
  const bar = $('#ccBar'); bar.style.width = pct + '%'; bar.classList.toggle('full', recv > 0 && short === 0);
  const st = $('#ccState'), card = st.closest('.cashcard');
  card.classList.toggle('ok', recv > 0 && short === 0);
  $('#payStatus').replaceChildren(h('i'), recv > 0 && short === 0 ? (change ? 'รับเงินครบ · รอรับเงินทอน' : 'รับเงินครบ') : 'รอชำระเงิน');
  $('#payStatus').classList.toggle('ok', recv > 0 && short === 0);
  if (!recv) { st.className = 'cc-state wait'; st.replaceChildren(h('span', { class: 'hand' }, '🙏'), ' กรุณาส่งเงินให้พนักงาน'); }
  else if (short) { st.className = 'cc-state short'; st.replaceChildren('ยังขาดอีก ', h('b', {}, baht(short)), ' บาท'); }
  else { st.className = 'cc-state paid'; st.replaceChildren('✓ รับเงินครบแล้ว', change ? '' : ' · พอดี ไม่มีเงินทอน'); }
  const ch = $('#ccChange');
  const show = recv > 0 && short === 0 && change > 0;
  ch.classList.toggle('show', show);
  if (show) tween($('#ccChangeAmt'), change);
  if (show && !(prev.change > 0)) coinBurst(ch);
  el._prev = { change: show ? change : 0 };
}
function renderPromo() {
  const d = settings.display;
  const el = $('#promo'); if (!el) return;
  clearTimeout(slideTimer);
  const media = (d.media || []).filter((m) => m.url);
  const logo = d.logo || settings.store.logo;
  const bar = () => h('div', { class: 'glassbar' }, logo ? h('img', { src: logo, alt: '' }) : null,
    h('div', { class: 't' }, h('b', {}, settings.store.name || ''), d.welcome ? h('span', {}, d.welcome) : null), h('div', { class: 'clock', id: 'clock' }, clockText()));
  const show = (i) => {
    if (!media.length) {
      // no promotion media: an animated welcome scene in the shop colour
      el.replaceChildren(h('div', { class: 'hero' }, h('span', { class: 'ring' }), h('span', { class: 'ring' }), h('span', { class: 'ring' }),
        h('div', { class: 'inner' }, h('div', { style: { position: 'relative' } }, h('div', { class: 'steam' }, h('i'), h('i'), h('i')), h('img', { class: 'bowl', src: logo || '/assets/bowl.svg', alt: '' })),
          h('h1', {}, settings.store.name || 'Welcome'), d.welcome ? h('p', {}, d.welcome) : null, h('span', { class: 'pill' }, '🍜 สั่งได้เลยที่เคาน์เตอร์ · 감사합니다'))),
        h('div', { class: 'glassbar', style: { left: 'auto', width: 'auto' } }, h('div', { class: 'clock', id: 'clock' }, clockText())));
      return;
    }
    const m = media[i % media.length];
    const node = m.type === 'video'
      ? h('video', { src: m.url, autoplay: true, muted: d.video_muted !== false, playsinline: true, loop: media.length === 1, style: { objectFit: m.fit || d.fit || 'cover' } })
      : h('img', { src: m.url, alt: '', style: { objectFit: m.fit || d.fit || 'cover' } });
    el.replaceChildren(node, h('div', { class: 'shade' }), bar());
    if (m.type === 'video') {
      node.volume = Number(d.video_volume ?? 0.5);
      node.play().catch(() => { node.muted = true; node.play().catch(() => {}); });
      if (media.length > 1) node.onended = () => show(i + 1);
    } else if (media.length > 1) slideTimer = setTimeout(() => show(i + 1), (Number(m.seconds) || Number(d.image_seconds) || 8) * 1000);
  };
  show(0);
}
const clockText = () => new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
setInterval(() => { const c = $('#clock'); if (c) c.textContent = clockText(); }, 15000);
let prevQty = new Map(), prevTotal = null;
function renderPanel() {
  const p = $('#panel'); if (!p) return;
  const s = state;
  if (!s.phase || s.phase === 'idle') { p.replaceChildren(); prevQty = new Map(); prevTotal = null; return; }
  const unit = settings.sale.count_unit || 'ชาม';
  const lines = s.lines || [];
  // lines that were just added (or got more) slide in and glow
  const now = new Map(), hot = new Set();
  for (const l of lines) { const k = l.name + '|' + (l.options || []).join(','); now.set(k, (now.get(k) || 0) + l.qty); if ((prevQty.get(k) || 0) < now.get(k)) hot.add(k); }
  prevQty = now;
  const bump = prevTotal !== null && prevTotal !== s.total; prevTotal = s.total;
  const shown = lines.slice(-8);
  const m = s.member;
  p.replaceChildren(
    h('div', { class: 'ph' }, h('h2', {}, h('small', {}, 'Your order'), 'รายการของคุณ'),
      h('div', { class: 'chips' }, h('span', { class: 'chip-d ' + (s.dine_type === 'takeaway' ? 'takeaway' : 'dinein') }, s.dine_type === 'takeaway' ? '🥡 กลับบ้าน' : s.dine_type === 'mixed' ? '🍽️ ทานที่ร้าน + 🥡' : '🍽️ ทานที่ร้าน'),
        s.table ? h('span', { class: 'chip-d' }, '🪑 โต๊ะ ' + s.table) : null)),
    m ? h('div', { class: 'mem' }, h('div', { class: 'av' }, '⭐'), h('div', {}, h('b', {}, `สวัสดีคุณ ${m.name}`), h('span', {}, m.tier ? `สมาชิก ${m.tier}` : 'สมาชิก')),
      h('div', { class: 'pts' }, Number(m.points || 0).toLocaleString(), h('small', {}, 'แต้มสะสม'))) : null,
    lines.length > shown.length ? h('div', { class: 'more' }, `+ อีก ${lines.length - shown.length} รายการด้านบน`) : null,
    h('div', { class: 'items' }, shown.map((l) => {
      const k = l.name + '|' + (l.options || []).join(',');
      const opts = (l.options || []).map((o) => (String(o).startsWith('+ ') ? h('span', { class: 'add' }, o) : h('span', {}, o)));
      if (l.dine_type === 'takeaway' && s.dine_type === 'mixed') opts.push(h('span', { class: 'tw' }, 'กลับบ้าน'));
      return h('div', { class: 'it' + (hot.has(k) ? ' new' : '') }, h('span', { class: 'q' }, l.qty), h('div', { class: 'n' }, h('b', {}, l.name), opts.length ? h('small', {}, opts) : null), h('span', { class: 'p' }, baht(l.price)));
    })),
    h('div', { class: 'sum' },
      s.discount || s.packaging || s.tax ? r('รวมค่าอาหาร', baht(s.items_total)) : null, s.discount ? r('ส่วนลด', '−' + baht(s.discount)) : null,
      s.packaging ? r('ค่าบรรจุภัณฑ์', baht(s.packaging)) : null, s.tax ? r('VAT', baht(s.tax)) : null,
      h('div', { class: 'grand' }, h('span', {}, 'ยอดรวม', h('small', {}, `${lines.reduce((a, l) => a + l.qty, 0)} รายการ · ${s.bowls || 0} ${unit}`)), h('span', { class: 'total' + (bump ? ' bump' : '') }, baht(s.total)))),
  );
}
const r = (a, b) => h('div', { class: 'r' }, h('span', {}, a), h('span', {}, b));
function renderDone() {
  const old = $('.done'); if (old) old.remove();
  clearTimeout(doneTimer);
  if (state.phase !== 'done') return;
  const colors = ['#facc15', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#ffffff'];
  const confetti = h('div', { class: 'confetti' }, Array.from({ length: 70 }, (_, i) => h('i', { style: { left: Math.random() * 100 + 'vw', background: colors[i % colors.length],
    animationDuration: 2.4 + Math.random() * 2.6 + 's', animationDelay: Math.random() * .8 + 's', transform: `rotate(${Math.random() * 360}deg)` } })));
  const check = h('div', { class: 'check', html: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' });
  document.body.append(h('div', { class: 'done' }, confetti, h('div', { class: 'card2' }, check, h('div', { class: 'lead' }, 'ชำระเงินเรียบร้อย'),
    state.queue_no ? [h('div', { class: 'qlabel' }, 'เลขคิวของคุณ · Queue'), h('div', { class: 'q' }, state.queue_no)] : null,
    h('span', { class: 'chip-d ' + (state.dine_type === 'takeaway' ? 'takeaway' : 'dinein') }, state.dine_type === 'takeaway' ? '🥡 กลับบ้าน' : dineLabel(state.dine_type)),
    state.change ? h('div', { class: 'change' }, '💰 เงินทอน ', baht(state.change), ' บาท') : null,
    h('div', { class: 'thanks' }, settings.display.thanks || 'ขอบคุณค่ะ'))));
  doneTimer = setTimeout(() => { state = { phase: 'idle' }; renderAll(); }, 9000);
}

// ---------- customer member entry (opened only by staff) ----------
function renderPrompt() {
  const old = $('.overlay'); if (old) old.remove();
  if (!prompt) return;
  const val = h('div', { class: 'val' }, prompt.value || ' ');
  const inp = { value: prompt.value, dispatchEvent: () => {} };
  const left = h('div', { class: 'small muted', style: { textAlign: 'center' } });
  const tick = () => { const s = Math.max(0, Math.round((new Date(prompt.expires_at) - Date.now()) / 1000)); left.textContent = `ปิดอัตโนมัติใน ${s} วินาที`; };
  tick(); const t = setInterval(() => { if (!document.body.contains(left)) return clearInterval(t); tick(); }, 1000);
  const box = h('div', { class: 'box' });
  const search = async () => {
    try {
      const r2 = await api.post('/member-prompt/lookup', { prompt_id: prompt.id, q: inp.value });
      prompt.results = r2.results; drawResults();
    } catch (e) { errToast(e); if (e.code === 'prompt_closed') { prompt = null; renderPrompt(); } }
  };
  const drawKeys = () => {
    const proxy = document.createElement('input'); proxy.value = inp.value;
    proxy.addEventListener('input', () => { inp.value = proxy.value.replace(/\D/g, '').slice(0, 10); prompt.value = inp.value; val.textContent = inp.value || ' '; });
    box.replaceChildren(h('h2', {}, 'กรอกเบอร์โทร หรือ หมายเลขสมาชิก'), val, keypad(proxy, { onEnter: search }), left,
      h('p', { class: 'small muted' }, 'ใช้เพื่อระบุสมาชิกสำหรับบิลนี้เท่านั้น'));
  };
  const drawResults = () => {
    const list = prompt.results || [];
    box.replaceChildren(h('h2', {}, list.length ? 'ใช่คุณหรือไม่?' : 'ไม่พบสมาชิก'),
      ...list.map((m) => h('button', { class: 'btn big block', style: { marginBottom: '.5em' }, onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { await api.post('/member-prompt/confirm', { prompt_id: prompt.id, member_id: m.id }); toast('ยืนยันแล้ว ขอบคุณค่ะ', 'ok'); prompt = null; renderPrompt(); } catch (er) { errToast(er); }
      } }, `${m.name} · ${m.phone}`)),
      !list.length && prompt.allow_signup ? h('button', { class: 'btn primary big block', onclick: signup }, 'สมัครสมาชิกใหม่ด้วยเบอร์นี้') : null,
      h('button', { class: 'btn block', style: { marginTop: '.5em' }, onclick: () => { prompt.results = null; drawKeys(); } }, 'กรอกใหม่'), left);
  };
  const signup = () => {
    const name = h('input', { class: 'input', placeholder: 'ชื่อ' });
    box.replaceChildren(h('h2', {}, 'สมัครสมาชิก'), h('p', {}, 'เบอร์โทร: ', inp.value), h('label', { class: 'field' }, 'ชื่อ', name),
      h('p', { class: 'small muted' }, 'รหัสผ่านเริ่มต้นสำหรับเว็บไซต์สมาชิก คือเลข 4 ตัวท้ายของเบอร์โทร'),
      h('button', { class: 'btn primary big block', onclick: async () => {
        try { const r2 = await api.post('/member-prompt/signup', { prompt_id: prompt.id, phone: inp.value, first_name: name.value }); toast('สมัครสำเร็จ ' + r2.member_no, 'ok'); prompt = null; renderPrompt(); } catch (e) { errToast(e); }
      } }, 'สมัคร'), left);
  };
  if (prompt.mode === 'phone_qr') {
    box.replaceChildren(h('h2', {}, 'สแกนเพื่อกรอกเบอร์สมาชิกบนมือถือ'), h('img', { class: 'qr', src: '/api/qr.svg?d=' + encodeURIComponent(location.origin + '/display/member.html#' + prompt.id) }), left);
  } else drawKeys();
  document.body.append(h('div', { class: 'overlay' }, box));
}

function sampleState() {
  return { phase: ['cart', 'pay', 'done'].includes(qs.get('phase')) ? qs.get('phase') : 'pay', queue_no: 'D012', dine_type: 'mixed', table: 'A1', member: { name: 'จี***', points: 120, tier: 'Gold' },
    lines: [{ name: 'มาม่าเกาหลีต้นตำรับ', qty: 1, options: ['ชินราเมียน', 'เผ็ดกลาง', '+ ชีส'], price: 10400 }, { name: 'ไข่ออนเซ็น', qty: 2, options: [], price: 3000 }, { name: 'ชาเย็น', qty: 2, options: ['หวานน้อย'], price: 9000, dine_type: 'takeaway' }],
    items_total: 22400, discount: 0, packaging: 0, tax: 0, total: 22400, bowls: 1, received: qs.get('qr') ? 0 : 50000, change: qs.get('qr') ? 0 : 27600, qr: qs.get('qr') ? '00020101021229370016A000000677010111011300668012345675802TH530376454031796304ABCD' : null };
}
boot().catch((e) => { console.error(e); root.replaceChildren(h('div', { class: 'empty' }, 'โหลดไม่สำเร็จ ', e.message)); setTimeout(() => location.reload(), 10000); });
