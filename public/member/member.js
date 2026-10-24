import { makeApi, store, socket } from '/shared/api.js';
import { h, $, toast, errToast, modal, fmtTime } from '/shared/ui.js';
import { baht, code128, VERSION, maskPhone } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { applyFonts } from '/shared/fonts.js';

const api = makeApi({ tokenKey: 'member_token', onUnauthorized: () => { store.del('member_token'); } });
const app = $('#app');
let cfg, me = null;

const go = (r) => { location.hash = '#/' + r; };
window.addEventListener('hashchange', route);

async function boot() {
  cfg = await api.get('/c/config', { token: null });
  applyFonts(cfg.fonts, 'member');
  if (cfg.theme && Object.keys(cfg.theme).length) applyTheme(cfg.theme); else document.documentElement.style.setProperty('--brand', cfg.colors.accent || '#d4202f');
  if (store.get('member_token')) {
    const s = await socket({ kind: 'member', token: store.get('member_token') }).catch(() => null);
    if (s) { s.on('coupon:used', () => { toast('คูปองถูกใช้แล้ว', 'ok'); route(); }); s.on('verification', (v) => window.dispatchEvent(new CustomEvent('verification', { detail: v }))); }
  }
  route();
}
async function loadMe() {
  if (!store.get('member_token')) return (me = null);
  try { me = await api.get('/c/me'); } catch (e) {
    if (e.status === 401) { store.del('member_token'); me = null; return null; }
    throw e; // network/server error: show an error state, never "0 points"
  }
  return me;
}
const shell = (...kids) => {
  const r = location.hash.split('/')[1] || 'home';
  const titles = { home: 'บัตรสมาชิกของคุณ', rewards: 'ของรางวัล', coupons: 'คูปองของฉัน', history: 'ประวัติการซื้อ', points: 'ประวัติแต้ม', benefits: 'สิทธิประโยชน์', account: 'บัญชีของฉัน', claim: 'รับแต้มจากใบเสร็จ', scan: 'สแกน QR สะสมแต้ม', register: 'สมัครสมาชิก', forgot: 'ลืมรหัสผ่าน', contact: 'ติดต่อร้าน' };
  app.replaceChildren(h('header', { class: 'mhead' }, h('div', { class: 'row1' }, h('div', { class: 'logo' }, cfg.store.logo ? h('img', { src: cfg.store.logo, alt: '' }) : '🍜'),
      h('div', {}, h('div', { class: 'name' }, cfg.store.name), h('div', { class: 'sub' }, me ? `สวัสดี ${me.first_name || me.nickname || ''} 👋` : (titles[r] || 'สมาชิก')))),
    h('img', { class: 'bowl', src: '/assets/bowl.svg', alt: '' })),
    h('div', { class: 'wrap' }, ...kids),
    me ? h('nav', { class: 'bot' }, [['home', '🏠', 'หน้าหลัก'], ['rewards', '🎁', 'รางวัล'], ['scan', '', 'สแกนแต้ม'], ['coupons', '🎟️', 'คูปอง'], ['account', '👤', 'บัญชี']].map(([k, i, t]) =>
      k === 'scan' ? h('a', { href: '#/scan', class: 'scanfab' + (r === k ? ' on' : '') }, h('span', { class: 'fab' }, scanIcon()), t)
        : h('a', { href: '#/' + k, class: r === k ? 'on' : '' }, h('span', {}, i), t))) : null);
};
const loading = () => shell(h('div', { class: 'card skeleton', style: { height: '180px' } }, '.'), h('div', { class: 'card skeleton', style: { height: '90px' } }, '.'));

async function route() {
  const [, r = 'home', arg] = location.hash.split('/');
  if (!cfg.enabled) return shell(h('div', { class: 'empty' }, 'ร้านยังไม่เปิดระบบสมาชิก'));
  stopScan();
  if (r === 'claim') return claimPage(arg);
  if (r === 'scan') return scanPage();
  if (r === 'reset') return resetPage(arg);
  if (r === 'register') return registerPage();
  if (r === 'forgot') return forgotPage();
  if (r === 'contact') return contactPage();
  loading();
  try { if (!(await loadMe())) return loginPage(); }
  catch (e) { return shell(h('div', { class: 'card' }, h('h3', {}, '⚠️ โหลดข้อมูลไม่สำเร็จ'), h('p', {}, e.message), h('button', { class: 'btn primary', onclick: route }, 'ลองใหม่'))); }
  if (r === 'home') return homePage();
  if (r === 'rewards') return rewardsPage();
  if (r === 'coupons') return couponsPage();
  if (r === 'history') return historyPage();
  if (r === 'points') return pointsPage();
  if (r === 'benefits') return benefitsPage();
  if (r === 'account') return accountPage();
  return homePage();
}

// ---------- auth ----------
const pwInput = (ph = 'รหัสผ่าน') => {
  const i = h('input', { class: 'input', type: 'password', placeholder: ph, autocomplete: 'current-password' });
  const b = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? 'แสดง' : 'ซ่อน'; } }, 'แสดง');
  return { el: h('div', { class: 'pw' }, i, b), input: i };
};
function loginPage(after = null) {
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: 'เบอร์โทรศัพท์', autocomplete: 'username' });
  const pw = pwInput();
  const submit = async (e) => {
    e && e.preventDefault();
    try {
      const r = await api.post('/c/login', { phone: phone.value, password: pw.input.value }, { token: null });
      store.set('member_token', r.token);
      if (r.password_is_default) store.set('suggest_pw', true);
      if (after) after(); else { go('home'); route(); }
    } catch (er) { errToast(er); }
  };
  shell(h('form', { class: 'card', onsubmit: submit }, h('h2', {}, 'เข้าสู่ระบบสมาชิก'), h('label', { class: 'field' }, 'เบอร์โทรศัพท์', phone), h('label', { class: 'field' }, 'รหัสผ่าน', pw.el),
    h('p', { class: 'small muted' }, 'สมาชิกใหม่: รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทร'),
    h('button', { class: 'btn primary big block', type: 'submit' }, 'เข้าสู่ระบบ'),
    h('div', { class: 'row between', style: { marginTop: '.8em' } }, h('a', { href: '#/forgot' }, 'ลืมรหัสผ่าน'), cfg.signup ? h('a', { href: '#/register' + (after ? '' : '') }, 'สมัครสมาชิก') : h('span', { class: 'small muted' }, 'ปิดรับสมัครชั่วคราว'))),
  h('a', { class: 'scan-cta', href: '#/scan' }, h('span', { class: 'ic' }, scanIcon()), h('span', {}, h('b', {}, 'มีใบเสร็จ? สแกนรับแต้มเลย'), h('small', {}, 'สแกนแล้วเข้าสู่ระบบหรือสมัครสมาชิก แต้มเข้าบัญชีทันที')), h('span', { class: 'go' }, '›')),
  h('a', { href: '#/contact', class: 'small', style: { textAlign: 'center' } }, 'ติดต่อร้าน'));
}
function registerPage(after = null) {
  if (!cfg.signup) return shell(h('div', { class: 'card' }, h('h3', {}, 'ร้านปิดรับสมัครสมาชิกใหม่ชั่วคราว'), h('p', {}, 'สมาชิกเดิมยังเข้าสู่ระบบได้ตามปกติ'), h('a', { class: 'btn block', href: '#/home' }, 'เข้าสู่ระบบ')));
  const f = cfg.fields;
  const L = { first_name: 'ชื่อ', last_name: 'นามสกุล', nickname: 'ชื่อเล่น', birthday: 'วันเกิด', email: 'อีเมล' };
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: '08xxxxxxxx', required: true });
  const fields = Object.fromEntries(Object.keys(L).filter((k) => f[k] && f[k].on).map((k) => [k, h('input', { class: 'input', type: k === 'birthday' ? 'date' : k === 'email' ? 'email' : 'text', required: !!f[k].req })]));
  const extra = Object.fromEntries((cfg.custom_fields || []).map((c) => [c.key, h('input', { class: 'input', required: !!c.req })]));
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/c/register', { phone: phone.value, ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])), extra: Object.fromEntries(Object.entries(extra).map(([k, el]) => [k, el.value])) }, { token: null });
      store.set('member_token', r.token); store.set('suggest_pw', true);
      toast('สมัครสมาชิกสำเร็จ · ' + r.default_password_hint, 'ok', 6000);
      const back = store.get('return_to'); store.del('return_to');
      if (back) location.hash = back; else go('home');
      route();
    } catch (er) { errToast(er); }
  };
  shell(h('form', { class: 'card', onsubmit: submit }, h('h2', {}, 'สมัครสมาชิก'), h('label', { class: 'field' }, 'เบอร์โทรศัพท์ (ใช้เข้าสู่ระบบ) *', phone),
    ...Object.entries(fields).map(([k, el]) => h('label', { class: 'field' }, L[k] + (f[k].req ? ' *' : ''), el)),
    ...(cfg.custom_fields || []).map((c) => h('label', { class: 'field' }, c.label + (c.req ? ' *' : ''), extra[c.key])),
    h('p', { class: 'small muted' }, 'รหัสผ่านเริ่มต้นจะเป็นเลข 4 ตัวท้ายของเบอร์โทร เปลี่ยนได้ภายหลังที่ "บัญชีของฉัน"'),
    h('button', { class: 'btn primary big block', type: 'submit' }, 'สมัครสมาชิก'), h('p', { style: { textAlign: 'center' } }, h('a', { href: '#/home' }, 'มีบัญชีแล้ว? เข้าสู่ระบบ'))));
}
function forgotPage() {
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: 'เบอร์โทรศัพท์' });
  const out = h('div');
  shell(h('div', { class: 'card' }, h('h2', {}, 'ลืมรหัสผ่าน'), h('p', { class: 'muted' }, 'ส่งคำขอถึงร้าน พนักงานจะยืนยันตัวตนของคุณก่อนส่งลิงก์ตั้งรหัสผ่านใหม่ (ใช้ได้ครั้งเดียว)'),
    h('label', { class: 'field' }, 'เบอร์โทรศัพท์', phone),
    h('button', { class: 'btn primary block', onclick: async (e) => { e.target.disabled = true; try { const r = await api.post('/c/forgot', { phone: phone.value }, { token: null }); out.replaceChildren(h('p', { class: 'badge ok', style: { whiteSpace: 'normal' } }, r.message)); } catch (er) { errToast(er); e.target.disabled = false; } } }, 'ส่งคำขอ'), out,
    h('p', { class: 'small muted' }, 'สถานะคำขอ: รอดำเนินการ → กำลังตรวจสอบ → สำเร็จ/ปฏิเสธ/หมดอายุ — ร้านจะติดต่อกลับทางเบอร์ที่ลงทะเบียนไว้'),
    h('a', { href: '#/home' }, '← กลับ')));
}
function resetPage(tok) {
  const pw = pwInput('รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)');
  shell(h('div', { class: 'card' }, h('h2', {}, 'ตั้งรหัสผ่านใหม่'), pw.el, h('button', { class: 'btn primary block', style: { marginTop: '.8em' }, onclick: async () => {
    try { await api.post('/c/reset', { token: tok, password: pw.input.value }, { token: null }); toast('ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบ', 'ok'); store.del('member_token'); go('home'); } catch (e) { errToast(e); }
  } }, 'บันทึก')));
}

// ---------- extra verification (OTP or show code to staff) ----------
async function verify(purpose, ref) {
  if ((purpose === 'claim' ? cfg.claim_verify : cfg.verify) === 'none') return null;
  const v = await api.post('/c/verify/start', { purpose, ref });
  if (v.method === 'none') return null;
  return new Promise((resolve, reject) => {
    let done = false;
    if (v.method === 'otp') {
      const code = h('input', { class: 'input', inputmode: 'numeric', placeholder: 'รหัส OTP 6 หลัก' });
      modal('ยืนยันด้วย OTP', h('div', {}, h('p', {}, v.message), code), { onClose: () => { if (!done) reject(new Error('ยกเลิกการยืนยัน')); }, actions: [{ label: 'ยืนยัน', class: 'primary', onClick: async () => { await api.post('/c/verify/otp', { id: v.id, code: code.value }); done = true; resolve(v.id); } }] });
    } else {
      const status = h('p', { class: 'muted' }, 'รอพนักงานยืนยัน…');
      const m = modal('ยืนยันตัวตนกับพนักงาน', h('div', { style: { textAlign: 'center' } }, h('p', {}, v.message), h('div', { style: { fontSize: '3em', fontWeight: 800, letterSpacing: '.2em' } }, v.code), status,
        h('p', { class: 'small muted' }, 'เพื่อความปลอดภัย เพราะรหัสผ่านเริ่มต้นอาจถูกคาดเดาได้')), { onClose: () => { if (!done) reject(new Error('ยกเลิกการยืนยัน')); } });
      const check = async () => {
        const s = await api.get('/c/verify/' + v.id).catch(() => null);
        if (s && s.status === 'approved') { done = true; m.close(); resolve(v.id); return true; }
        if (s && s.status === 'rejected') { status.textContent = 'พนักงานปฏิเสธคำขอ'; return true; }
        return false;
      };
      window.addEventListener('verification', function f(e) { if (e.detail.id === v.id) { check(); window.removeEventListener('verification', f); } });
      const t = setInterval(async () => { if (done || !document.body.contains(status) || await check()) clearInterval(t); }, 3000);
    }
  });
}

// ---------- claim from receipt ----------
async function claimPage(tok) {
  loading();
  let c;
  try { c = await api.get('/c/claim/' + tok); } catch (e) { return shell(h('div', { class: 'card' }, h('h3', {}, '⚠️ ', e.message))); }
  await loadMe();
  const box = h('div', { class: 'card' }, h('h2', {}, '🧾 รับแต้มจากใบเสร็จ'),
    h('p', {}, 'บิล ', h('strong', {}, c.bill_no), ' · ', fmtTime(c.paid_at)),
    h('p', {}, 'ยอดที่ใช้คำนวณแต้ม: ', h('strong', {}, baht(c.base), ' บาท')),
    c.claimable ? h('div', { style: { fontSize: '2em', fontWeight: 800, color: 'var(--brand)' } }, `+${c.points} แต้ม`) : h('p', { class: 'badge bad', style: { whiteSpace: 'normal' } }, c.reason),
    h('p', { class: 'small muted' }, 'รับแต้มได้ถึง ', fmtTime(c.deadline), ' · รับได้ครั้งเดียวต่อบิล'));
  if (!c.claimable) return shell(box, h('a', { class: 'btn block', href: '#/home' }, 'ไปหน้าสมาชิก'));
  if (!me) {
    store.set('return_to', '#/claim/' + tok);
    return shell(box, h('div', { class: 'card' }, h('p', {}, 'เข้าสู่ระบบหรือสมัครสมาชิกเพื่อรับแต้มจากบิลนี้'),
      h('button', { class: 'btn primary big block', onclick: () => { loginPage(() => { location.hash = '#/claim/' + tok; route(); }); } }, 'เข้าสู่ระบบ'),
      cfg.signup ? h('button', { class: 'btn big block', style: { marginTop: '.5em' }, onclick: () => go('register') }, 'สมัครสมาชิกใหม่แล้วรับแต้ม') : null));
  }
  // logged in → claim straight away (no button, no code) unless the shop requires verification for claims
  const doClaim = async () => {
    const vid = await verify('claim', c.bill_no);
    const r = await api.post('/c/claim/' + tok, { verification_id: vid });
    store.del('return_to');
    shell(h('div', { class: 'success-card' }, h('div', { class: 'burst' }, '🎉'), h('h2', {}, 'รับแต้มสำเร็จ'), h('div', { class: 'big-pts' }, `+${r.points}`),
      h('p', {}, `บิล ${r.bill_no} · แต้มคงเหลือ `, h('strong', {}, r.balance.toLocaleString())), h('a', { class: 'btn primary big block', href: '#/home' }, 'ไปหน้าสมาชิก')));
  };
  if (cfg.claim_verify === 'none') {
    shell(box, h('div', { class: 'card', style: { textAlign: 'center' } }, h('div', { class: 'spinner' }), h('p', {}, 'กำลังรับแต้มเข้าบัญชี ', h('strong', {}, `${me.first_name || ''} (${me.member_no})`))));
    try { await doClaim(); } catch (er) { shell(box, h('div', { class: 'card' }, h('p', { class: 'badge bad', style: { whiteSpace: 'normal' } }, er.message), h('a', { class: 'btn block', href: '#/home' }, 'ไปหน้าสมาชิก'))); }
    return;
  }
  shell(box, h('p', {}, 'รับแต้มเข้าบัญชี ', h('strong', {}, `${me.first_name || ''} (${me.member_no})`)), h('button', { class: 'btn primary big block', onclick: async (e) => {
    e.target.disabled = true;
    try { await doClaim(); } catch (er) { errToast(er); e.target.disabled = false; }
  } }, 'ยืนยันรับแต้ม'));
}

// ---------- pages ----------
function homePage() {
  const m = me;
  const tier = m.tier || {};
  const pr = m.progress && m.progress.next;
  const suggest = store.get('suggest_pw') && m.password_is_default;
  shell(
    suggest ? h('div', { class: 'card', style: { background: 'var(--warn-soft)' } }, h('strong', {}, 'แนะนำให้เปลี่ยนรหัสผ่าน'), h('p', { class: 'small' }, 'คุณยังใช้รหัสเริ่มต้น (4 ตัวท้ายของเบอร์) — เปลี่ยนตอนนี้หรือภายหลังก็ได้'),
      h('div', { class: 'row' }, h('a', { class: 'btn sm primary', href: '#/account' }, 'เปลี่ยนตอนนี้'), h('button', { class: 'btn sm', onclick: () => { store.del('suggest_pw'); homePage(); } }, 'ไว้ภายหลัง'))) : null,
    h('div', { class: 'mcard', style: { '--tier': tier.color || '#e8321f' } },
      h('div', { class: 'row between' }, h('div', { class: 'chip' }), h('span', { class: 'badge', style: { background: '#fff', color: '#111' } }, tier.icon || '⭐', ' ', tier.name || 'Member')),
      h('div', { style: { marginTop: '1em' } }, h('div', { class: 'small' }, 'แต้มคงเหลือ'), h('div', { class: 'pts' }, m.points.toLocaleString()),
        m.reserved_points ? h('div', { class: 'small' }, `สำรองไว้สำหรับคูปอง ${m.reserved_points} แต้ม`) : null,
        m.expiring_points ? h('div', { class: 'small' }, `⏳ ${m.expiring_points} แต้มจะหมดอายุ ${fmtTime(m.expiring_first)}`) : null),
      h('div', { class: 'no', style: { marginTop: '1em' } }, `${m.first_name || ''} ${m.last_name || ''} · ${m.member_no}`),
      pr ? h('div', { style: { marginTop: '.6em' } }, h('div', { class: 'small' }, `ความคืบหน้าสู่ ${pr.name} ${m.progress.pct}%`), h('div', { class: 'prog' }, h('i', { style: { width: m.progress.pct + '%' } })),
        h('div', { class: 'small' }, m.progress.need.map((n) => (n.kind === 'spent' ? `ยอดซื้อ ${baht(n.have)}/${baht(n.need)} บาท` : `มาใช้บริการ ${n.have}/${n.need} ครั้ง`)).join(' · '))) : h('div', { class: 'small', style: { marginTop: '.6em' } }, 'คุณอยู่ระดับสูงสุดแล้ว 🎉')),
    h('div', { class: 'barcode-card' }, h('canvas', { id: 'mbc', width: 320, height: 70 }), h('div', { class: 'small muted' }, 'แสดงบาร์โค้ดนี้หรือบอกเบอร์โทรเพื่อสะสมแต้มที่ร้าน')),
    h('a', { class: 'scan-cta', href: '#/scan' }, h('span', { class: 'ic' }, scanIcon()),
      h('span', {}, h('b', {}, 'สแกน QR ใบเสร็จ สะสมแต้ม'), h('small', {}, 'เปิดกล้องแล้วส่องที่ QR ท้ายใบเสร็จ รับแต้มทันที')), h('span', { class: 'go' }, '›')),
    h('div', { class: 'quick' },
      h('a', { class: 'btn', href: '#/rewards' }, h('b', {}, '🎁'), 'แลกของรางวัล'),
      h('a', { class: 'btn', href: '#/history' }, h('b', {}, '🧾'), 'ประวัติการซื้อ'),
      h('a', { class: 'btn', href: '#/coupons' }, h('b', {}, '🎟️'), `คูปอง (${m.coupons_active})`),
      cfg.mobile ? h('a', { class: 'btn', href: '#/contact', onclick: (e) => { e.preventDefault(); toast('สแกน QR สั่งอาหารที่โต๊ะ หรือขอใบ QR จากพนักงาน', 'info', 5000); } }, h('b', {}, '🍜'), 'สั่งอาหาร') : null,
      h('a', { class: 'btn', href: '#/points' }, h('b', {}, '⭐'), 'ประวัติแต้ม'),
      h('a', { class: 'btn', href: '#/benefits' }, h('b', {}, '👑'), 'สิทธิประโยชน์')));
  drawBarcode($('#mbc'), m.member_no);
}

// ---------- scan a receipt QR inside the member site ----------
function scanIcon() {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', '26'); svg.setAttribute('height', '26'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '2.2'); svg.setAttribute('stroke-linecap', 'round');
  svg.innerHTML = '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><path d="M7 12h10"/>';
  return svg;
}
// claim token from a scanned text: the receipt QR is <origin>/member/#/claim/<token>
export function claimTokenOf(text) {
  const m = /#\/claim\/([A-Za-z0-9_-]{8,})/.exec(String(text || ''));
  return m ? m[1] : null;
}
let scanState = null;
function stopScan() {
  if (!scanState) return;
  scanState.stop = true;
  if (scanState.stream) scanState.stream.getTracks().forEach((t) => t.stop());
  scanState = null;
}
let jsqrLoad;
const loadJsQR = () => (jsqrLoad ||= new Promise((res, rej) => { if (window.jsQR) return res(window.jsQR); const sc = document.createElement('script'); sc.src = '/vendor/jsQR.js'; sc.onload = () => res(window.jsQR); sc.onerror = () => { jsqrLoad = null; rej(new Error('โหลดตัวอ่าน QR ไม่สำเร็จ')); }; document.head.append(sc); }));
async function decoder() {
  if ('BarcodeDetector' in window) {
    try { const f = await window.BarcodeDetector.getSupportedFormats(); if (f.includes('qr_code')) { const d = new window.BarcodeDetector({ formats: ['qr_code'] }); return async (src) => { const r = await d.detect(src); return r[0] ? r[0].rawValue : null; }; } } catch { /* fall back to jsQR */ }
  }
  const jsQR = await loadJsQR();
  const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
  return async (src) => {
    const w0 = src.videoWidth || src.naturalWidth || src.width, h0 = src.videoHeight || src.naturalHeight || src.height;
    if (!w0 || !h0) return null;
    const k = Math.min(1, 720 / Math.max(w0, h0));
    cv.width = Math.round(w0 * k); cv.height = Math.round(h0 * k);
    cx.drawImage(src, 0, 0, cv.width, cv.height);
    const img = cx.getImageData(0, 0, cv.width, cv.height);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' });
    return r ? r.data : null;
  };
}
function onScanned(text) {
  const tok = claimTokenOf(text);
  if (!tok) { toast('QR นี้ไม่ใช่ QR รับแต้มจากใบเสร็จของร้าน', 'warn'); return false; }
  if (navigator.vibrate) navigator.vibrate(60);
  stopScan();
  location.hash = '#/claim/' + tok;
  return true;
}
async function scanPage() {
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  const status = h('div', { class: 'scan-status' }, 'กำลังเปิดกล้อง…');
  const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
      const text = await (await decoder())(img);
      URL.revokeObjectURL(img.src);
      if (!text) return toast('ไม่พบ QR ในรูปนี้ ลองถ่ายให้ชัดและเห็น QR ทั้งหมด', 'warn', 4000);
      onScanned(text);
    } catch (e) { errToast(e); }
    file.value = '';
  };
  shell(h('div', { class: 'scan-card' },
    h('div', { class: 'viewfinder' }, video, h('div', { class: 'frame' }, h('i', { class: 'c1' }), h('i', { class: 'c2' }), h('i', { class: 'c3' }), h('i', { class: 'c4' }), h('b', { class: 'laser' }))),
    status,
    h('div', { class: 'scan-steps' }, h('div', {}, h('b', {}, '1'), 'ส่องกล้องที่ QR ท้ายใบเสร็จ'), h('div', {}, h('b', {}, '2'), 'ระบบอ่านอัตโนมัติ'), h('div', {}, h('b', {}, '3'), 'รับแต้มเข้าบัญชีทันที')),
    h('button', { class: 'btn block', onclick: () => file.click() }, '🖼️ เลือกรูปใบเสร็จจากคลังภาพ'), file,
    h('p', { class: 'small muted', style: { textAlign: 'center', margin: 0 } }, 'รับได้ครั้งเดียวต่อบิล และภายในเวลาที่ร้านกำหนด')));
  const st = (scanState = { stop: false, stream: null });
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error('อุปกรณ์นี้เปิดกล้องจากเว็บไม่ได้'), { name: 'NotSupported' });
    st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (st.stop) { st.stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = st.stream; await video.play().catch(() => {});
    status.textContent = 'ส่องกล้องให้ QR อยู่ในกรอบ';
    const read = await decoder();
    let busy = false, last = 0;
    const tick = async (ts) => {
      if (st.stop) return;
      if (!busy && ts - last > 180 && video.readyState >= 2) {
        busy = true; last = ts;
        try { const text = await read(video); if (text && onScanned(text)) return; } catch { /* keep scanning */ }
        busy = false;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    status.classList.add('err');
    status.textContent = e.name === 'NotAllowedError' ? 'ไม่ได้รับอนุญาตให้ใช้กล้อง — อนุญาตกล้องในการตั้งค่าเบราว์เซอร์ หรือเลือกรูปใบเสร็จจากคลังภาพแทน'
      : (e.message || 'เปิดกล้องไม่สำเร็จ') + ' — เลือกรูปใบเสร็จจากคลังภาพแทนได้';
  }
}
function drawBarcode(canvas, text) {
  if (!canvas) return;
  const mods = code128(text);
  const total = mods.reduce((a, b) => a + b, 0) + 20;
  const mw = Math.max(1, Math.floor(canvas.width / total));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  let x = Math.floor((canvas.width - total * mw) / 2) + 10 * mw;
  mods.forEach((w, i) => { if (i % 2 === 0) ctx.fillRect(x, 4, w * mw, canvas.height - 8); x += w * mw; });
}
async function rewardsPage() {
  loading();
  const list = await api.get('/c/rewards');
  shell(h('h2', {}, 'ของรางวัล'), h('p', { class: 'muted' }, `แต้มคงเหลือ ${me.points}`), ...(list.length ? list.map((r) => h('div', { class: 'card' },
    r.image ? h('img', { src: r.image, style: { width: '100%', borderRadius: '12px' } }) : null, h('h3', {}, r.name), r.description ? h('p', {}, r.description) : null,
    h('p', { class: 'small muted' }, `ใช้ ${r.points} แต้ม · คูปองใช้ได้ ${r.coupon_days} วันหลังแลก${r.ends_at ? ' · แลกได้ถึง ' + fmtTime(r.ends_at) : ''}${r.remaining !== null ? ` · เหลือ ${r.remaining} สิทธิ์` : ''}`),
    r.terms ? h('p', { class: 'small' }, 'เงื่อนไข: ', r.terms) : null,
    h('p', { class: 'small muted' }, r.return_policy === 'forfeit' ? 'หากคูปองหมดอายุจะไม่คืนแต้ม' : 'หากคูปองหมดอายุหรือยกเลิก ระบบคืนแต้มให้'),
    r.unavailable ? h('span', { class: 'badge' }, r.unavailable) : h('button', { class: 'btn primary block', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const vid = await verify('redeem', r.id);
        const c = await api.post(`/c/rewards/${r.id}/redeem`, { verification_id: vid });
        toast('แลกสำเร็จ แสดงคูปองที่เคาน์เตอร์', 'ok'); go('coupons');
      } catch (er) { errToast(er); e.target.disabled = false; }
    } }, `แลก ${r.points} แต้ม`))) : [h('div', { class: 'empty' }, 'ยังไม่มีของรางวัล')]));
}
async function couponsPage() {
  loading();
  const list = await api.get('/c/coupons');
  const TH = { reserved: 'ใช้ได้', used: 'ใช้แล้ว', expired: 'หมดอายุ', cancelled: 'ยกเลิก' };
  shell(h('h2', {}, 'คูปองของฉัน'), ...(list.length ? list.map((c) => {
    const live = c.status === 'reserved' && new Date(c.expires_at) > new Date();
    const cv = h('canvas', { width: 300, height: 70 });
    const el = h('div', { class: 'coupon', style: live ? {} : { opacity: .55 } }, h('strong', {}, c.reward_name), h('div', {}, h('span', { class: 'badge ' + (live ? 'ok' : '') }, live ? TH.reserved : TH[c.status] || 'หมดอายุ')),
      live ? cv : null, h('div', { class: 'code' }, c.code), h('div', { class: 'small muted' }, live ? `ใช้ได้ถึง ${fmtTime(c.expires_at)}` : c.used_at ? `ใช้เมื่อ ${fmtTime(c.used_at)}` : ''),
      live ? h('button', { class: 'btn sm ghost', onclick: async () => { if (confirm('ยกเลิกคูปองและคืนแต้มตามเงื่อนไข?')) { await api.post(`/c/coupons/${c.id}/cancel`).catch(errToast); couponsPage(); } } }, 'ยกเลิกคูปอง') : null);
    if (live) setTimeout(() => drawBarcode(cv, c.code));
    return el;
  }) : [h('div', { class: 'empty' }, 'ยังไม่มีคูปอง')]));
}
async function historyPage() {
  loading();
  const bills = await api.get('/c/bills');
  const SRC = { pos: 'หน้าร้าน', mobile_table: 'สั่งที่โต๊ะ', mobile_pickup: 'Pick Up' };
  shell(h('h2', {}, 'ประวัติการซื้อ'), h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '#/points' }, 'ประวัติแต้ม')),
    ...(bills.length ? bills.map((b) => h('button', { class: 'card', style: { textAlign: 'left' }, onclick: () => billDetail(b.id) }, h('div', { class: 'row between' }, h('strong', {}, b.bill_no), h('strong', {}, baht(b.total - b.refunded_amount), ' ฿')),
      h('div', { class: 'small muted' }, `${fmtTime(b.paid_at)} · ${SRC[b.source] || b.source} · ${b.bowls} ชาม · +${b.points_earned} แต้ม${b.status === 'void' ? ' · ยกเลิก' : ''}`))) : [h('div', { class: 'empty' }, 'ยังไม่มีประวัติการซื้อ')]));
}
async function billDetail(id) {
  const b = await api.get('/c/bills/' + id);
  modal('บิล ' + b.bill_no, h('div', {}, h('p', { class: 'small muted' }, fmtTime(b.paid_at), b.queue_no ? ' · คิว ' + b.queue_no : ''),
    h('table', { class: 'table' }, h('tbody', {}, b.items.map((i) => h('tr', {}, h('td', {}, `${i.qty - i.void_qty} × ${i.name}`, h('div', { class: 'small muted' }, i.options.map((o) => o.name).join(', '))), h('td', { class: 'r' }, baht(i.line_total)))))),
    b.discount ? h('p', {}, 'ส่วนลด ', baht(b.discount)) : null, h('p', {}, h('strong', {}, 'รวม ', baht(b.total), ' บาท')), b.refunded_amount ? h('p', {}, 'คืนเงิน ', baht(b.refunded_amount)) : null, h('p', {}, `แต้มที่ได้ ${b.points_earned}`)));
}
async function pointsPage() {
  loading();
  const rows = await api.get('/c/points');
  const K = { earn: 'สะสม', redeem_hold: 'สำรองแลก', redeem: 'แลกรางวัล', redeem_release: 'คืนแต้ม', adjust: 'ปรับโดยร้าน', refund: 'ปรับจากการคืนเงิน', expire: 'หมดอายุ' };
  shell(h('h2', {}, 'ประวัติแต้ม'), h('div', { class: 'card' }, rows.length ? h('table', { class: 'table' }, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, K[r.kind] || r.kind, h('div', { class: 'small muted' }, fmtTime(r.created_at), r.reason ? ' · ' + r.reason : '')),
    h('td', { class: 'r', style: { color: r.delta >= 0 ? 'var(--ok)' : 'var(--bad)', fontWeight: 800 } }, (r.delta > 0 ? '+' : '') + r.delta), h('td', { class: 'r small muted' }, r.balance_after)))))
    : h('div', { class: 'empty' }, 'ยังไม่มีรายการ')));
}
async function benefitsPage() {
  loading();
  const tiers = await api.get('/c/benefits');
  shell(h('h2', {}, 'สิทธิประโยชน์สมาชิก'), ...tiers.map((t) => h('div', { class: 'card', style: { borderLeft: `6px solid ${t.color}` } }, h('h3', {}, t.icon || '⭐', ' ', t.name, me.tier && me.tier.id === t.id ? h('span', { class: 'badge ok' }, ' ระดับของคุณ') : null),
    h('p', {}, t.benefits || ''), h('p', { class: 'small muted' }, [t.min_spent ? `ยอดซื้อ ${baht(t.min_spent)} บาท` : null, t.min_visits ? `มาใช้บริการ ${t.min_visits} ครั้ง` : null].filter(Boolean).join(' และ ') || 'สมัครสมาชิก'),
    h('p', { class: 'small' }, `แต้ม x${t.multiplier}${t.discount_pct ? ` · ส่วนลด ${t.discount_pct}%` : ''}`))));
}
function accountPage() {
  const m = me;
  const cur = pwInput('รหัสผ่านปัจจุบัน'); const nx = pwInput('รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)');
  const f = cfg.fields;
  const inputs = Object.fromEntries(['first_name', 'last_name', 'nickname', 'birthday'].filter((k) => f[k] && f[k].on).map((k) => [k, h('input', { class: 'input', type: k === 'birthday' ? 'date' : 'text', value: m[k] || '' })]));
  const L = { first_name: 'ชื่อ', last_name: 'นามสกุล', nickname: 'ชื่อเล่น', birthday: 'วันเกิด' };
  shell(h('h2', {}, 'บัญชีของฉัน'),
    h('div', { class: 'card' }, h('p', {}, 'เบอร์โทร ', maskPhone(m.phone), ' · ', m.member_no), ...Object.entries(inputs).map(([k, el]) => h('label', { class: 'field' }, L[k], el)),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.put('/c/me', Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); toast('บันทึกแล้ว', 'ok'); } catch (e) { errToast(e); } } }, 'บันทึกข้อมูล')),
    h('div', { class: 'card' }, h('h3', {}, 'เปลี่ยนรหัสผ่าน'), m.password_is_default ? h('p', { class: 'small muted' }, 'ตอนนี้ใช้รหัสเริ่มต้น (4 ตัวท้ายของเบอร์) — ไม่บังคับเปลี่ยน') : null,
      h('label', { class: 'field' }, 'รหัสผ่านปัจจุบัน', cur.el), h('label', { class: 'field' }, 'รหัสผ่านใหม่', nx.el),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.post('/c/password', { current: cur.input.value, next: nx.input.value }); store.del('suggest_pw'); toast('เปลี่ยนรหัสผ่านแล้ว', 'ok'); } catch (e) { errToast(e); } } }, 'เปลี่ยนรหัสผ่าน')),
    h('a', { class: 'btn block', href: '#/forgot' }, 'ลืมรหัสผ่าน / สถานะคำขอ'), h('a', { class: 'btn block', href: '#/contact' }, 'ติดต่อร้าน'),
    h('button', { class: 'btn danger block', onclick: async () => { await api.post('/c/logout').catch(() => {}); store.del('member_token'); me = null; go('home'); route(); } }, 'ออกจากระบบ'),
    h('p', { class: 'version', style: { textAlign: 'center' } }, 'v' + VERSION));
}
function contactPage() {
  shell(h('div', { class: 'card' }, h('h2', {}, 'ติดต่อร้าน'), h('p', {}, cfg.store.name), cfg.store.address ? h('p', {}, '📍 ', cfg.store.address) : null,
    cfg.store.phone ? h('p', {}, '📞 ', h('a', { href: 'tel:' + cfg.store.phone }, cfg.store.phone)) : null, cfg.store.contact_line ? h('p', {}, 'LINE: ', cfg.store.contact_line) : null,
    h('a', { class: 'btn block', href: '#/home' }, '← กลับ')));
}
boot().catch((e) => app.replaceChildren(h('div', { class: 'empty' }, e.message)));
