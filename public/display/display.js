import { makeApi, store, socket } from '/shared/api.js';
import { h, $, toast, errToast, keypad } from '/shared/ui.js';
import { baht, dineLabel, VERSION } from '/shared/core.js';
import { applyFonts } from '/shared/fonts.js';
import { TEXT_DEFAULTS, DISPLAY_STYLE_DEFAULTS } from '/shared/displaytexts.js';

const qs = new URLSearchParams(location.search);
const preview = qs.get('preview') === '1';
const api = makeApi({ tokenKey: 'display_token' });
const root = $('#root');
let settings, state = { phase: 'idle' }, prompt = null, sock = null, slideTimer = null;

async function boot() {
  settings = await fetch('/api/settings/public').then((r) => r.json());
  if (preview) {
    window.addEventListener('message', (e) => { if (e.origin === location.origin && e.data && e.data.display) { settings.display = { ...settings.display, ...e.data.display }; applyTheme(); rerender(); } });
    state = qs.get('phase') === 'idle' ? { phase: 'idle' } : sampleState();
    applyTheme(); renderAll();
    // ?demo=1 plays the cash flow: nothing received → partly received → paid with change
    // ?phase=cart&demo=1 keeps adding items so the list has to follow the newest one
    if (qs.get('demo') && state.phase === 'cart') {
      const menu = [['ต็อกบกกีชีส', 8900], ['ไส้กรอกทอด', 2500], ['โคล่า', 2000], ['คิมบับ', 6900], ['ไก่ทอดเกาหลี', 12900], ['น้ำแร่', 1500], ['ราเมงต้มยำ', 9900]];
      let i = 0;
      const add = () => { i++;
        let lines;
        if (i % 3 === 0) { lines = state.lines.map((l, j) => (j === 1 ? { ...l, qty: l.qty + 1, price: Math.round(l.price / l.qty * (l.qty + 1)) } : l)); } // same item again: stays in place
        else { const [name, price] = menu[i % menu.length]; lines = [...state.lines, { name, qty: 1 + (i % 2), options: i % 4 ? [] : ['เผ็ดน้อย'], price: price * (1 + (i % 2)) }]; }
        const total = lines.reduce((a, l) => a + l.price, 0); state = { ...state, lines, items_total: total, total, discount: 0, discounts: [], at: Date.now() }; renderAll(); };
      setInterval(add, 1200);
    }
    // ?phase=done&demo=1 shows the thank-you screen, then plays the cashier pressing เสร็จ
    if (qs.get('demo') && state.phase === 'done') setTimeout(() => { state = { phase: 'idle', at: Date.now() }; renderAll(); }, 3000);
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
  sock.on('settings:changed', async () => { settings = await fetch('/api/settings/public').then((r) => r.json()); applyTheme(); rerender(); });
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

// shop-editable text: T('key', { n: 3 }) → string; with a Node as a value → array of parts (for bold amounts)
function T(key, vars = {}) {
  const custom = (settings.display.texts || {})[key];
  const raw = custom !== undefined && custom !== null && String(custom).trim() !== '' ? String(custom) : TEXT_DEFAULTS[key] ?? key;
  const parts = raw.split(/(\{\w+\})/).filter((x) => x !== '').map((x) => { const m = /^\{(\w+)\}$/.exec(x); return m && m[1] in vars ? vars[m[1]] : x; });
  return parts.some((x) => x instanceof Node) ? parts : parts.join('');
}
const dineText = (d) => (d === 'takeaway' ? T('takeaway') : d === 'mixed' ? T('mixed') : T('dine_in'));
function applyTheme() {
  const d = settings.display;
  const r = document.documentElement.style;
  r.setProperty('--d-bg', d.bg || '#111827'); r.setProperty('--d-fg', d.color || '#fff'); r.setProperty('--d-accent', d.accent || '#ef4444'); r.setProperty('--fit', d.fit || 'cover');
  // colours / sizes / effects the shop picked (empty = built-in look)
  const st = { ...DISPLAY_STYLE_DEFAULTS, ...(d.style || {}) };
  const hex = (v) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : '');
  const setC = (name, v) => (hex(v) ? r.setProperty(name, v) : r.removeProperty(name));
  setC('--d-bg2', st.bg2); setC('--d-card', st.card); setC('--d-ok', st.ok); setC('--d-warn', st.warn); setC('--d-gold', st.gold); setC('--d-hl', st.highlight);
  setC('--d-qty', st.qty); setC('--d-tot1', st.total_from); setC('--d-tot2', st.total_to); setC('--d-qrh', st.qr_head); setC('--d-payhead', st.pay_head); setC('--d-memtxt', st.member_text);
  const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  r.setProperty('--d-card-op', num(st.card_opacity, 0, 40, 8) + '%');
  r.setProperty('--d-isc', num(st.items_scale, 70, 150, 100) / 100); r.setProperty('--d-tsc', num(st.total_scale, 60, 150, 100) / 100); r.setProperty('--d-qsc', num(st.queue_scale, 50, 130, 100) / 100);
  const ds = document.documentElement.dataset;
  ds.motion = ['off', 'soft', 'normal', 'extra'].includes(st.motion) ? st.motion : 'normal';
  ds.bg = ['blobs', 'aurora', 'particles', 'gradient', 'none'].includes(st.bg_effect) ? st.bg_effect : 'blobs';
  ds.corners = ['round', 'soft', 'square'].includes(st.corners) ? st.corners : 'round';
  for (const [k, attr] of [['confetti', 'fxConfetti'], ['fireworks', 'fxFireworks'], ['floaters', 'fxFloaters'], ['money_fx', 'fxMoney'], ['shine', 'fxShine'], ['ring', 'fxRing'], ['latest_fx', 'fxLatest'], ['sparks', 'fxSparks']]) ds[attr] = st[k] === false ? '0' : '1';
  const fx = $('.bgfx');
  if (fx && !fx.querySelector('.aur')) fx.append(h('span', { class: 'aur' }), h('span', { class: 'aur a2' }),
    ...Array.from({ length: 26 }, (_, i) => h('span', { class: 'pt', style: `left:${(i * 41) % 100}%;animation-duration:${9 + (i % 7) * 2}s;animation-delay:${-(i * 1.3) % 14}s;transform:scale(${0.6 + (i % 4) * 0.25})` })));
  applyFonts(settings.fonts, 'display');
}
function onState(s) {
  if (!s || (s.at && state.at && s.at < state.at)) return; // ignore out-of-order updates
  if (prompt && s.cart_id && prompt.cart_id !== s.cart_id) { prompt = null; renderPrompt(); } // bill changed → close member entry
  state = s;
  renderAll();
}

// settings changed: rebuild everything (the payment and thank-you screens normally keep their DOM)
function rerender() { root.replaceChildren(); document.querySelectorAll('.done').forEach((x) => x.remove()); renderAll(); }
function renderAll() {
  const d = settings.display;
  const active = state.phase && state.phase !== 'idle';
  const paying = state.phase === 'pay';
  // while paying, the payment panel (total + QR) replaces the promotion half — order list stays on the other half
  const wrap = h('div', { class: `disp ${d.layout === 'full' && !paying ? 'full' : 'split'}${active ? ' active' : ''}${paying ? ' paying' : ''}` },
    h('div', { class: 'promo', id: 'promo' }), h('div', { class: 'panel', id: 'panel' }));
  const old = $('.disp');
  if (old && old.className === wrap.className) { renderPanel(); if (paying) renderPay(); return renderDone(); }
  if ($('.done:not(.leaving)') && state.phase !== 'done') wrap.classList.add('welcome-in');
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
    const top = h('div', { class: 'paytop' }, h('div', { class: 'pclock' }, h('b', { id: 'payTime' }, timeText()), h('span', { id: 'payDate' }, dateText())), h('div', { id: 'payQueue' }));
    const head = h('div', { class: 'payhead' }, h('i', { class: 'shine' }), h('div', { class: 'lbl' }, T('pay_due'), h('span', { id: 'payUnit' })), h('div', { class: 'amt' }, h('span', { id: 'payAmt' }), h('small', {}, '฿')),
      h('div', { class: 'paybreak', id: 'payBreak' }));
    let body;
    if (showQr) {
      const img = h('img', { class: 'qrimg', alt: 'QR พร้อมเพย์', src: '/api/qr.svg?d=' + encodeURIComponent(s.qr) });
      const frame = h('div', { class: 'qrframe' }, h('div', { class: 'qrskel' }, h('div', { class: 'orb' }, h('i'), h('i'), h('i'), h('b', { html: QR_ICON })), h('strong', {}, T('qr_loading'), h('em', {}, h('i', {}, '.'), h('i', {}, '.'), h('i', {}, '.'))), h('div', { class: 'qbar' }, h('i'))), img, h('b', { class: 'cn tl' }), h('b', { class: 'cn tr' }), h('b', { class: 'cn bl' }), h('b', { class: 'cn br' }), h('i', { class: 'scan' }));
      // reveal once the code has really loaded (never show a half-drawn QR)
      const t0 = performance.now();
      const ready = () => setTimeout(() => frame.classList.add('ready'), Math.max(0, 700 - (performance.now() - t0)));
      img.onerror = () => { frame.querySelector('.qrskel strong').textContent = T('qr_error'); };
      if (img.complete && img.naturalWidth) ready(); else img.onload = ready;
      const acc = settings.payment.promptpay_name || settings.store.name || '';
      body = h('div', { class: 'payarea' }, h('div', { class: 'qrcard' },
        h('div', { class: 'qrtitle' }, h('span', { class: 'qi', html: QR_ICON }), h('div', {}, h('b', {}, T('qr_title')), h('small', {}, T('qr_sub')))),
        h('div', { class: 'qrwell' }, frame),
        h('div', { class: 'qrfoot' },
          h('div', { class: 'qacc' }, h('span', { class: 'av' }, (acc.trim()[0] || '฿').toUpperCase()), h('div', {}, h('small', {}, T('qr_account')), h('b', {}, acc || '-'))),
          h('div', { class: 'qamt' }, h('small', {}, T('qr_scan')), h('b', {}, h('span', { id: 'qrAmt' }), ' ฿'))),
        h('div', { class: 'qbanks' }, h('span', { class: 'dots' }, ['#138f2d', '#4e2e7f', '#1e4598', '#00a6e6', '#fec43b', '#ec1c24'].map((c, i) => h('i', { style: `background:${c};animation-delay:${i * 0.15}s` }))), T('qr_banks'))));
    } else {
      body = h('div', { class: 'cashcard' },
        h('div', { class: 'cc-head' }, h('span', { class: 'bill', html: BILL_SVG + BILL_SVG }), h('div', {}, h('b', {}, T('cash_title')), h('small', {}, T('cash_sub')))),
        h('div', { class: 'cc-row recv' }, h('span', {}, T('received')), h('b', { id: 'ccRecv' }, baht(0))),
        h('div', { class: 'cc-bar' }, h('i', { id: 'ccBar' })),
        h('div', { class: 'cc-state', id: 'ccState' }),
        h('div', { class: 'cc-change', id: 'ccChange' }, h('span', {}, T('change')), h('b', { id: 'ccChangeAmt' })));
    }
    el.replaceChildren(h('div', { class: 'paybox' + (showQr ? ' isqr' : ' iscash') }, h('div', { class: 'sparks' }, Array.from({ length: 14 }, (_, i) => h('i', { style: `left:${(i * 37) % 100}%;animation-delay:${(i * 0.53) % 6}s;animation-duration:${5 + (i % 5)}s` }))), top, head, body,
      h('div', { class: 'paystatus', id: 'payStatus' }, h('i'), showQr ? T('status_wait_qr') : T('status_wait'))));
    el._prev = {};
  }
  const prev = el._prev || {};
  $('#payUnit').textContent = s.bowls ? ` · ${s.bowls} ${unit}` : '';
  $('#payQueue').replaceChildren(s.queue_no ? h('span', { class: 'qchip' }, h('small', {}, T('queue')), s.queue_no) : h('span', { class: 'qchip soft' }, '🍜 ', settings.store.name || 'ขอบคุณที่มาอุดหนุน'));
  renderBreak(s);
  tween($('#payAmt'), s.total);
  if (showQr) { tween($('#qrAmt'), s.total); return; }
  const recv = s.received || 0, change = s.change || 0, short = Math.max(0, s.total - recv);
  const rv = $('#ccRecv');
  tween(rv, recv); rv.classList.toggle('zero', !recv);
  const pct = s.total ? Math.min(100, Math.round(recv / s.total * 100)) : 0;
  const bar = $('#ccBar'); bar.style.width = pct + '%'; bar.classList.toggle('full', recv > 0 && short === 0);
  const st = $('#ccState'), card = st.closest('.cashcard');
  card.classList.toggle('ok', recv > 0 && short === 0);
  $('#payStatus').replaceChildren(h('i'), recv > 0 && short === 0 ? (change ? T('status_paid_change') : T('status_paid')) : T('status_wait'));
  $('#payStatus').classList.toggle('ok', recv > 0 && short === 0);
  if (!recv) { st.className = 'cc-state none'; st.replaceChildren(); }
  else if (short) { st.className = 'cc-state short'; st.replaceChildren(...[T('short', { amount: h('b', {}, baht(short)) })].flat()); }
  else if (change) { st.className = 'cc-state none'; st.replaceChildren(); }
  else { st.className = 'cc-state paid'; st.replaceChildren(T('paid_exact')); }
  const ch = $('#ccChange');
  const show = recv > 0 && short === 0 && change > 0;
  ch.classList.toggle('show', show);
  if (show) tween($('#ccChangeAmt'), change);
  if (show && !(prev.change > 0)) coinBurst(ch);
  if (recv && recv !== prev.recv) { const b = rv; b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse'); }
  if (show && !(prev.change > 0)) cashRain(card);
  el._prev = { change: show ? change : 0, recv };
}
// subtotal / discounts / packaging / VAT under the big amount (only when there is something to explain)
function renderBreak(s) {
  const box = $('#payBreak'); if (!box) return;
  const disc = s.discounts || [];
  const key = JSON.stringify([s.items_total, disc, s.packaging, s.tax, s.member && s.member.earn]);
  if (box.dataset.k === key) return;
  box.dataset.k = key;
  const saved = disc.reduce((a, d) => a + d.amount, 0) || s.discount || 0;
  const rows = [];
  if (saved || s.packaging || s.tax) rows.push([T('subtotal'), baht(s.items_total), '']);
  if (disc.length) for (const d of disc) rows.push(['🏷️ ' + d.label, '−' + baht(d.amount), 'disc']);
  else if (s.discount) rows.push(['🏷️ ' + T('discount'), '−' + baht(s.discount), 'disc']);
  if (s.packaging) rows.push([T('packaging'), baht(s.packaging), '']);
  if (s.tax) rows.push([T('vat'), baht(s.tax), '']);
  const earn = s.member && s.member.earn;
  box.replaceChildren(...rows.map(([a, b, c], i) => h('div', { class: 'br ' + c, style: `animation-delay:${0.15 + i * 0.12}s` }, h('span', {}, a), h('b', {}, b))),
    saved || earn ? h('div', { class: 'perks' }, saved ? h('span', { class: 'save' }, T('saved', { amount: baht(saved) })) : null, earn ? h('span', { class: 'earn' }, T('earn', { points: earn.toLocaleString() })) : null) : null);
}
function cashRain(host) {
  const box = h('div', { class: 'rain' }, Array.from({ length: 16 }, (_, i) => h('i', { style: `left:${Math.random() * 96}%;animation-delay:${i * 60}ms;--r:${Math.round(Math.random() * 60 - 30)}deg` }, i % 2 ? '💸' : '💵')));
  host.append(box); setTimeout(() => box.remove(), 2600);
}
const QR_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3M21 14v.01M14 21h7M21 17v4"/></svg>';
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
          h('h1', {}, settings.store.name || 'Welcome'), d.welcome ? h('p', {}, d.welcome) : null, T('idle_pill') ? h('span', { class: 'pill' }, T('idle_pill')) : null)),
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
const timeText = () => new Date().toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dateText = () => new Date().toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
setInterval(() => { const c = $('#clock'); if (c) c.textContent = clockText(); }, 15000);
setInterval(() => { const t = $('#payTime'); if (t) { t.textContent = timeText(); $('#payDate').textContent = dateText(); } }, 1000);
let prevQty = new Map(), prevTotal = null, latestKey = null;
function renderPanel() {
  const p = $('#panel'); if (!p) return;
  const s = state;
  if (!s.phase || s.phase === 'idle') { p.replaceChildren(); prevQty = new Map(); prevTotal = null; latestKey = null; return; }
  const unit = settings.sale.count_unit || 'ชาม';
  const lines = s.lines || [];
  // lines that were just added (or got more) slide in and glow
  // brand-new lines slide in; a line that only got more stays where it is and bumps.
  // The most recent one keeps a soft highlight ("ล่าสุด") until something else is added.
  const now = new Map(), fresh = new Set(), more = new Set();
  let last = null;
  for (const l of lines) { const k = l.name + '|' + (l.options || []).join(','); now.set(k, (now.get(k) || 0) + l.qty); }
  for (const [k, q] of now) { const was = prevQty.get(k) || 0; if (q > was) { (was ? more : fresh).add(k); last = k; } }
  prevQty = now;
  if (last) latestKey = last; else if (latestKey && !now.has(latestKey)) latestKey = null;
  const bump = prevTotal !== null && prevTotal !== s.total; prevTotal = s.total;
  const m = s.member;
  const oldItems = p.querySelector('.items'), oldTop = oldItems ? oldItems.scrollTop : 0;
  const pcs = lines.reduce((a, l) => a + l.qty, 0);
  p.replaceChildren(
    h('div', { class: 'ph' }, h('h2', {}, h('small', {}, T('order_kicker')), T('order_title')),
      h('div', { class: 'chips' }, h('span', { class: 'chip-d ' + (s.dine_type === 'takeaway' ? 'takeaway' : 'dinein') }, dineText(s.dine_type)),
        s.table ? h('span', { class: 'chip-d' }, T('table') + ' ' + s.table) : null)),
    m ? h('div', { class: 'mem' }, h('div', { class: 'av' }, '⭐'), h('div', {}, h('b', {}, `${T('member_hello')} ${m.name}`), h('span', {}, m.tier ? `${T('member_tier')} ${m.tier}` : T('member_tier'))),
      h('div', { class: 'pts' }, Number(m.points || 0).toLocaleString(), h('small', {}, T('member_points')))) : null,
    h('div', { class: 'itemswrap' }, h('div', { class: 'more up' }), h('div', { class: 'items' }, lines.map((l) => {
      const k = l.name + '|' + (l.options || []).join(',');
      const opts = (l.options || []).map((o) => { const t = String(o);
        if (t.startsWith('✓ ')) return h('span', { class: 'yes' }, h('i', {}, '✓'), t.slice(2));
        if (t.startsWith('✗ ')) return h('span', { class: 'no' }, h('i', {}, '✕'), t.slice(2));
        return t.startsWith('+ ') ? h('span', { class: 'add' }, t) : h('span', {}, t); });
      if (l.dine_type === 'takeaway' && s.dine_type === 'mixed') opts.push(h('span', { class: 'tw' }, T('takeaway_tag')));
      const isLatest = k === latestKey;
      return h('div', { class: 'it' + (fresh.has(k) ? ' new' : more.has(k) ? ' more-q' : '') + (isLatest ? ' latest' : ''), 'data-k': k },
        h('span', { class: 'q' }, l.qty), h('div', { class: 'n' }, h('b', {}, l.name, isLatest ? h('em', { class: 'ltag' }, T('latest')) : null), opts.length ? h('small', {}, opts) : null), h('span', { class: 'p' }, baht(l.price)));
    })), h('div', { class: 'more down' })),
    h('div', { class: 'sum' },
      s.discount || s.packaging || s.tax ? r(T('subtotal'), baht(s.items_total)) : null, s.discount ? r(T('discount'), '−' + baht(s.discount)) : null,
      s.packaging ? r(T('packaging'), baht(s.packaging)) : null, s.tax ? r(T('vat'), baht(s.tax)) : null,
      h('div', { class: 'grand' }, h('span', {}, T('total'), h('small', {}, T('count', { lines: lines.length, pcs }), s.bowls && unit !== 'ชิ้น' ? ` · ${s.bowls} ${unit}` : '')), h('span', { class: 'total' + (bump ? ' bump' : '') }, baht(s.total)))),
  );
  followItems(oldTop);
}
// long bills: keep the newest (or just changed) item in view, sliding smoothly from where the list was,
// and say how many items are out of view above / below
function followItems(oldTop) {
  const box = $('#panel .items'); if (!box) return;
  box.scrollTop = oldTop;
  const changed = box.querySelector('.it.latest.new, .it.latest.more-q');
  const max = box.scrollHeight - box.clientHeight;
  let to = Math.min(oldTop, max);
  if (changed) {
    // added at the end → go all the way down; an existing line → just bring it into view where it is
    if (changed === box.lastElementChild) to = max;
    else { const t = changed.offsetTop, b = t + changed.offsetHeight; if (b > to + box.clientHeight) to = b - box.clientHeight; else if (t < to) to = t; }
  }
  to = Math.max(0, Math.min(max, to));
  box.scrollTo({ top: to, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  countHidden(box, to);
}
function countHidden(box, top) {
  const its = [...box.children];
  const above = its.filter((x) => x.offsetTop + x.offsetHeight / 2 < top).length;
  const below = its.filter((x) => x.offsetTop + x.offsetHeight / 2 > top + box.clientHeight).length;
  const wrap = box.parentElement;
  const set = (el, n, txt) => { el.classList.toggle('show', n > 0); if (n > 0) el.textContent = txt(n); };
  set(wrap.querySelector('.more.up'), above, (n) => T('more_up', { n }));
  set(wrap.querySelector('.more.down'), below, (n) => T('more_down', { n }));
  box.classList.toggle('fade-up', above > 0); box.classList.toggle('fade-down', below > 0);
}
const r = (a, b) => h('div', { class: 'r' }, h('span', {}, a), h('span', {}, b));
let fireTimer = null, wordTimer = null;
function renderDone() {
  const old = $('.done:not(.leaving)');
  if (old && state.phase === 'done' && old._at === state.at) return;
  clearInterval(fireTimer); clearInterval(wordTimer);
  if (old && state.phase !== 'done') return leaveDone(old);
  document.querySelectorAll('.done').forEach((x) => x.remove());
  if (state.phase !== 'done') return;
  const s = state;
  const colors = ['#facc15', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899', '#ffffff'];
  // confetti keeps falling while the screen is up (each piece loops)
  const confetti = h('div', { class: 'confetti' }, Array.from({ length: 60 }, (_, i) => h('i', { style: `left:${Math.random() * 100}vw;background:${colors[i % colors.length]};animation-duration:${3 + Math.random() * 3}s;animation-delay:${Math.random() * 3 - (i < 30 ? 0 : 3)}s;--s:${0.6 + Math.random() * 0.8}` })));
  const floaters = h('div', { class: 'floaters' }, Array.from({ length: 16 }, (_, i) => h('i', { style: `left:${(i * 61) % 100}%;animation-delay:${(i * 0.7) % 8}s;animation-duration:${7 + (i % 4)}s;font-size:${3 + (i % 3)}vh` }, ['🍜', '💛', '⭐', '🥢', '🎉', '❤️', '✨', '🍥'][i % 8])));
  const fireworks = h('div', { class: 'fireworks' });
  const check = h('div', { class: 'check', html: '<span class="ripple"></span><span class="ripple r2"></span><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>' });
  const thanks = settings.display.thanks || 'ขอบคุณค่ะ';
  const words = [thanks, ...T('thanks_more').split('|').map((w) => w.trim()).filter((w) => w && !thanks.includes(w))];
  const word = h('div', { class: 'word' }, wave(words[0]));
  const saved = (s.discounts || []).reduce((a, d) => a + d.amount, 0) || s.discount || 0;
  const earn = s.member && s.member.earn;
  const stat = (icon, lbl, val, cls = '', i = 0) => h('div', { class: 'stat ' + cls, style: `animation-delay:${0.9 + i * 0.12}s` }, h('span', { class: 'ic' }, icon), h('small', {}, lbl), h('b', {}, val));
  const stats = [stat('🧾', T('done_total'), baht(s.total) + ' ฿', '', 0)];
  if ((s.methods || []).length) stats.push(stat('💳', T('done_method'), s.methods.join(' + '), '', stats.length));
  if (s.change) stats.push(stat('💰', T('done_change'), baht(s.change) + ' ฿', 'green', stats.length));
  if (saved) stats.push(stat('🏷️', T('done_saved'), baht(saved) + ' ฿', 'gold', stats.length));
  if (earn) stats.push(stat('⭐', T('done_points'), '+' + earn.toLocaleString(), 'gold', stats.length));
  const dineCls = s.dine_type === 'takeaway' ? 'takeaway' : 'dinein';
  const box = h('div', { class: 'done' }, h('div', { class: 'rays' }), confetti, floaters, fireworks,
    h('div', { class: 'card2' },
      h('div', { class: 'toprow' }, check, h('div', { class: 'lead' }, T('done_title'), h('small', {}, T('done_sub')))),
      s.queue_no ? h('div', { class: 'qwrap' }, h('div', { class: 'qlabel' }, T('done_queue')), h('div', { class: 'q' }, h('span', {}, s.queue_no))) : null,
      h('span', { class: 'chip-d ' + dineCls }, dineText(s.dine_type)),
      h('div', { class: 'stats' }, stats),
      word,
      h('div', { class: 'hint' }, s.queue_no ? T('hint_queue') : T('hint_noqueue'))));
  box._at = s.at;
  document.body.append(box);
  const burst = () => {
    const x = 10 + Math.random() * 80, y = 10 + Math.random() * 45, c = colors[Math.floor(Math.random() * 6)];
    const fw = h('div', { class: 'fw', style: `left:${x}%;top:${y}%;--c:${c}` }, Array.from({ length: 16 }, (_, i) => h('i', { style: `--a:${i * 22.5}deg` })));
    fireworks.append(fw); setTimeout(() => fw.remove(), 1400);
  };
  burst(); setTimeout(burst, 300); fireTimer = setInterval(burst, 1100);
  let wi = 0;
  wordTimer = setInterval(() => { wi = (wi + 1) % words.length; word.replaceChildren(wave(words[wi])); }, 2600);
}
// cashier pressed "เสร็จ": say goodbye, fly the content away and close like an iris onto the normal screen
function leaveDone(el) {
  el.classList.add('leaving');
  el.append(h('div', { class: 'bye' }, h('span', { class: 'hand' }, '👋'), h('b', {}, wave(T('bye'))), h('small', {}, T('bye_sub'))));
  setTimeout(() => el.remove(), 2200);
}
// each character bounces in turn (grapheme-aware so Thai vowels and tone marks stay on their letter)
function wave(text) {
  const parts = typeof Intl !== 'undefined' && Intl.Segmenter ? [...new Intl.Segmenter('th', { granularity: 'grapheme' }).segment(text)].map((x) => x.segment) : [...text];
  return parts.map((c, i) => h('span', { style: `animation-delay:${i * 0.06}s` }, c === ' ' ? ' ' : c));
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
  return { phase: ['cart', 'pay', 'done'].includes(qs.get('phase')) ? qs.get('phase') : 'pay', queue_no: 'D012', dine_type: 'mixed', table: 'A1', member: { name: 'จี***', points: 120, tier: 'Gold', earn: 22 }, methods: [qs.get('qr') ? 'พร้อมเพย์' : 'เงินสด'],
    lines: [{ name: 'มาม่าเกาหลีต้นตำรับ', qty: 1, options: ['ชินราเมียน', 'เผ็ดกลาง', '+ ชีส', '✓ โรยสาหร่าย', '✗ ใส่ผักชี'], price: 10400 }, { name: 'ไข่ออนเซ็น', qty: 2, options: [], price: 3000 }, { name: 'ชาเย็น', qty: 2, options: ['หวานน้อย'], price: 9000, dine_type: 'takeaway' }],
    items_total: 23580, discount: 1180, discounts: [{ label: 'ส่วนลดสมาชิก Gold 5%', amount: 1180 }], packaging: 0, tax: 0, total: 22400, bowls: 1, received: qs.get('qr') ? 0 : 50000, change: qs.get('qr') ? 0 : 27600, qr: qs.get('qr') ? '00020101021229370016A000000677010111011300668012345675802TH530376454031796304ABCD' : null };
}
boot().catch((e) => { console.error(e); root.replaceChildren(h('div', { class: 'empty' }, 'โหลดไม่สำเร็จ ', e.message)); setTimeout(() => location.reload(), 10000); });
