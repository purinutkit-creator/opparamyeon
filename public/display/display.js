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
    applyTheme(); renderAll(); return;
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
  root.replaceChildren(h('div', { class: 'pairing' }, h('div', { class: 'card', style: { width: 'min(460px, 100%)' } },
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
  const wrap = h('div', { class: `disp ${d.layout === 'full' ? 'full' : 'split'}${active ? ' active' : ''}` }, h('div', { class: 'promo', id: 'promo' }), h('div', { class: 'panel', id: 'panel' }));
  const old = $('.disp');
  if (old && old.className === wrap.className) { renderPanel(); return renderDone(); }
  root.replaceChildren(wrap);
  renderPromo(); renderPanel(); renderDone(); renderPrompt();
}
function renderPromo() {
  const d = settings.display;
  const el = $('#promo'); if (!el) return;
  clearTimeout(slideTimer);
  const media = (d.media || []).filter((m) => m.url);
  const logo = d.logo || settings.store.logo;
  const show = (i) => {
    if (!media.length) { el.replaceChildren(h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', fontSize: '12vh' } }, '🍜'), logo ? h('img', { class: 'logo', src: logo, alt: '' }) : null, h('div', { class: 'welcome' }, d.welcome || '')); return; }
    const m = media[i % media.length];
    const node = m.type === 'video'
      ? h('video', { src: m.url, autoplay: true, muted: d.video_muted !== false, playsinline: true, loop: media.length === 1, style: { objectFit: m.fit || d.fit || 'cover' } })
      : h('img', { src: m.url, alt: '', style: { objectFit: m.fit || d.fit || 'cover' } });
    el.replaceChildren(node, logo ? h('img', { class: 'logo', src: logo, alt: '' }) : null, d.welcome ? h('div', { class: 'welcome' }, d.welcome) : null);
    if (m.type === 'video') {
      node.volume = Number(d.video_volume ?? 0.5);
      node.play().catch(() => { node.muted = true; node.play().catch(() => {}); });
      if (media.length > 1) node.onended = () => show(i + 1);
    } else if (media.length > 1) slideTimer = setTimeout(() => show(i + 1), (Number(m.seconds) || Number(d.image_seconds) || 8) * 1000);
  };
  show(0);
}
function renderPanel() {
  const p = $('#panel'); if (!p) return;
  const s = state;
  if (!s.phase || s.phase === 'idle') { p.replaceChildren(); return; }
  p.replaceChildren(
    h('div', { class: 'dine' + (s.dine_type === 'takeaway' ? ' takeaway' : '') }, s.dine_type === 'takeaway' ? '🥡 กลับบ้าน' : s.dine_type === 'mixed' ? '🍽️ ทานที่ร้าน + 🥡 กลับบ้าน' : '🍽️ ทานที่ร้าน', s.table ? ` · โต๊ะ ${s.table}` : ''),
    s.member ? h('div', { class: 'member' }, `⭐ สมาชิก ${s.member.name}`, s.member.tier ? ` · ${s.member.tier}` : '', ` · ${s.member.points} แต้ม`) : null,
    h('div', { class: 'items' }, (s.lines || []).slice(-12).map((l) => h('div', { class: 'it' }, h('div', {}, `${l.qty} × ${l.name}`, l.dine_type === 'takeaway' && s.dine_type === 'mixed' ? ' (กลับบ้าน)' : '',
      l.options && l.options.length ? h('small', {}, l.options.join(', ')) : null), h('strong', {}, baht(l.price))))),
    h('div', { class: 'sum' },
      r('รวม', baht(s.items_total)), s.discount ? r('ส่วนลด', '-' + baht(s.discount)) : null, s.packaging ? r('ค่าบรรจุภัณฑ์', baht(s.packaging)) : null, s.tax ? r('VAT', baht(s.tax)) : null,
      r(`ยอดชำระ · ${s.bowls || 0} ชาม`, h('span', { class: 'total' }, baht(s.total) + ' ฿')),
      s.phase === 'pay' && s.received ? r('รับเงิน', baht(s.received)) : null, s.phase === 'pay' && s.change ? r('เงินทอน', h('strong', {}, baht(s.change))) : null),
    s.phase === 'pay' && s.qr && settings.display.show_qr !== false ? h('div', {}, h('img', { class: 'qr', src: '/api/qr.svg?d=' + encodeURIComponent(s.qr), alt: 'QR พร้อมเพย์' }),
      h('div', { style: { textAlign: 'center' } }, `สแกนจ่าย พร้อมเพย์ ${settings.payment.promptpay_name || ''} · ${baht(s.total)} บาท`)) : null,
    s.phase === 'pay' ? h('div', { style: { textAlign: 'center', opacity: .8 } }, 'สถานะ: รอชำระเงิน') : null);
}
const r = (a, b) => h('div', { class: 'r' }, h('span', {}, a), h('span', {}, b));
function renderDone() {
  const old = $('.done'); if (old) old.remove();
  clearTimeout(doneTimer);
  if (state.phase !== 'done') return;
  document.body.append(h('div', { class: 'done' }, h('div', {}, h('div', { style: { fontSize: '4vh' } }, 'ชำระเงินเรียบร้อย · เลขคิวของคุณ'), h('div', { class: 'q' }, state.queue_no || ''),
    h('div', { class: 'dine' + (state.dine_type === 'takeaway' ? ' takeaway' : ''), style: { display: 'inline-block', margin: '2vh 0' } }, dineLabel(state.dine_type)),
    state.change ? h('div', { style: { fontSize: '5vh' } }, 'เงินทอน ', baht(state.change), ' บาท') : null,
    h('div', { style: { fontSize: '4.5vh', marginTop: '2vh' } }, settings.display.thanks || 'ขอบคุณค่ะ'))));
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
  return { phase: 'pay', dine_type: 'mixed', table: 'A1', member: { name: 'จี***', points: 120, tier: 'Gold' },
    lines: [{ name: 'มาม่าเกาหลีต้นตำรับ', qty: 1, options: ['ชินราเมียน', 'เผ็ดกลาง', 'ไข่'], price: 8900 }, { name: 'ชาเย็น', qty: 2, options: ['หวานน้อย'], price: 9000, dine_type: 'takeaway' }],
    items_total: 17900, discount: 0, packaging: 0, tax: 0, total: 17900, bowls: 1, received: 20000, change: 2100, qr: null };
}
boot().catch((e) => { console.error(e); root.replaceChildren(h('div', { class: 'empty' }, 'โหลดไม่สำเร็จ ', e.message)); setTimeout(() => location.reload(), 10000); });
