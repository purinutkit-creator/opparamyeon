import { makeApi, store, socket } from '/shared/api.js';
import { h, $, toast, errToast, modal, fmtTime } from '/shared/ui.js';
import { baht, code128, VERSION, maskPhone } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { applyFonts } from '/shared/fonts.js';
import { countTo, setFxLevel } from '/pos/fx.js';
import { t as tx, initLang, langPicker } from '/shared/i18n.js';

const api = makeApi({ tokenKey: 'member_token', onUnauthorized: () => { store.del('member_token'); } });
const app = $('#app');
let cfg, me = null;

const go = (r) => { location.hash = '#/' + r; };
window.addEventListener('hashchange', route);

async function boot() {
  await initLang();
  cfg = await api.get('/c/config', { token: null });
  applyFonts(cfg.fonts, 'member');
  setFxLevel((cfg.theme || {}).pos_fx);
  if (cfg.theme && Object.keys(cfg.theme).length) applyTheme(cfg.theme); else document.documentElement.style.setProperty('--brand', cfg.colors.accent || '#d4202f');
  if (store.get('member_token')) {
    const s = await socket({ kind: 'member', token: store.get('member_token') }).catch(() => null);
    if (s) { s.on('coupon:used', () => { toast(tx('คูปองถูกใช้แล้ว'), 'ok'); route(); }); s.on('verification', (v) => window.dispatchEvent(new CustomEvent('verification', { detail: v }))); }
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
  const titles = { home: tx('บัตรสมาชิกของคุณ'), rewards: tx('ของรางวัล'), coupons: tx('คูปองของฉัน'), history: tx('ประวัติการซื้อ'), points: tx('ประวัติแต้ม'), benefits: tx('สิทธิประโยชน์'), account: tx('บัญชีของฉัน'), claim: tx('รับแต้มจากใบเสร็จ'), scan: tx('สแกน QR สะสมแต้ม'), register: tx('สมัครสมาชิก'), forgot: tx('ลืมรหัสผ่าน'), contact: tx('ติดต่อร้าน') };
  app.replaceChildren(h('header', { class: 'mhead' }, h('div', { class: 'bubbles' }, Array.from({ length: 8 }, (_, i) => h('i', { style: `left:${(i * 13 + 5) % 100}%;animation-delay:${-i * 1.7}s;animation-duration:${8 + (i % 4) * 2}s;--s:${0.5 + (i % 3) * 0.35}` }))), h('div', { class: 'row1' }, h('div', { class: 'logo' }, cfg.store.logo ? h('img', { src: cfg.store.logo, alt: '' }) : '🍜'),
      h('div', {}, h('div', { class: 'name' }, cfg.store.name), h('div', { class: 'sub' }, me ? tx('สวัสดี {0} 👋', me.first_name || me.nickname || '') : (titles[r] || tx('สมาชิก'))))),
    h('div', { class: 'bowlwrap' }, h('div', { class: 'steam' }, h('i'), h('i'), h('i')), h('img', { class: 'bowl', src: '/assets/bowl.svg', alt: '' })),
    langPicker(h, () => route(), { position: 'absolute', top: '10px', right: '10px', zIndex: 3, fontSize: '.85em', maxWidth: '120px' })),
    h('div', { class: 'wrap enter' }, ...kids),
    me ? h('nav', { class: 'bot' }, [['home', '🏠', tx('หน้าหลัก')], ['rewards', '🎁', tx('รางวัล')], ['scan', '', tx('สแกนแต้ม')], ['coupons', '🎟️', tx('คูปอง')], ['account', '👤', tx('บัญชี')]].map(([k, i, t]) =>
      k === 'scan' ? h('a', { href: '#/scan', class: 'scanfab' + (r === k ? ' on' : '') }, h('span', { class: 'fab' }, scanIcon()), t)
        : h('a', { href: '#/' + k, class: r === k ? 'on' : '' }, h('span', {}, i), t))) : null);
};
const loading = () => shell(h('div', { class: 'card skeleton', style: { height: '180px' } }, '.'), h('div', { class: 'card skeleton', style: { height: '90px' } }, '.'));

async function route() {
  const [, r = 'home', arg] = location.hash.split('/');
  if (!cfg.enabled) return shell(h('div', { class: 'empty' }, tx('ร้านยังไม่เปิดระบบสมาชิก')));
  stopScan();
  if (r === 'claim') return claimPage(arg);
  if (r === 'scan') return scanPage();
  if (r === 'reset') return resetPage(arg);
  if (r === 'register') return registerPage();
  if (r === 'forgot') return forgotPage();
  if (r === 'contact') return contactPage();
  loading();
  try { if (!(await loadMe())) return loginPage(); }
  catch (e) { return shell(h('div', { class: 'card' }, h('h3', {}, tx('⚠️ โหลดข้อมูลไม่สำเร็จ')), h('p', {}, e.message), h('button', { class: 'btn primary', onclick: route }, tx('ลองใหม่')))); }
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
const pwInput = (ph = tx('รหัสผ่าน')) => {
  const i = h('input', { class: 'input', type: 'password', placeholder: ph, autocomplete: 'current-password' });
  const b = h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { i.type = i.type === 'password' ? 'text' : 'password'; b.textContent = i.type === 'password' ? tx('แสดง') : tx('ซ่อน'); } }, tx('แสดง'));
  return { el: h('div', { class: 'pw' }, i, b), input: i };
};
function loginPage(after = null) {
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: tx('เบอร์โทรศัพท์'), autocomplete: 'username' });
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
  shell(h('form', { class: 'card', onsubmit: submit }, h('h2', {}, tx('เข้าสู่ระบบสมาชิก')), h('label', { class: 'field' }, tx('เบอร์โทรศัพท์'), phone), h('label', { class: 'field' }, tx('รหัสผ่าน'), pw.el),
    h('p', { class: 'small muted' }, tx('สมาชิกใหม่: รหัสผ่านเริ่มต้นคือเลข 4 ตัวท้ายของเบอร์โทร')),
    h('button', { class: 'btn primary big block', type: 'submit' }, tx('เข้าสู่ระบบ')),
    h('div', { class: 'row between', style: { marginTop: '.8em' } }, h('a', { href: '#/forgot' }, tx('ลืมรหัสผ่าน')), cfg.signup ? h('a', { href: '#/register' + (after ? '' : '') }, tx('สมัครสมาชิก')) : h('span', { class: 'small muted' }, tx('ปิดรับสมัครชั่วคราว')))),
  h('a', { class: 'scan-cta', href: '#/scan' }, h('span', { class: 'ic' }, scanIcon()), h('span', {}, h('b', {}, tx('มีใบเสร็จ? สแกนรับแต้มเลย')), h('small', {}, tx('สแกนแล้วเข้าสู่ระบบหรือสมัครสมาชิก แต้มเข้าบัญชีทันที'))), h('span', { class: 'go' }, '›')),
  h('a', { href: '#/contact', class: 'small', style: { textAlign: 'center' } }, tx('ติดต่อร้าน')));
}
function registerPage(after = null) {
  if (!cfg.signup) return shell(h('div', { class: 'card' }, h('h3', {}, tx('ร้านปิดรับสมัครสมาชิกใหม่ชั่วคราว')), h('p', {}, tx('สมาชิกเดิมยังเข้าสู่ระบบได้ตามปกติ')), h('a', { class: 'btn block', href: '#/home' }, tx('เข้าสู่ระบบ'))));
  const f = cfg.fields;
  const L = { first_name: tx('ชื่อ'), last_name: tx('นามสกุล'), nickname: tx('ชื่อเล่น'), birthday: tx('วันเกิด'), email: tx('อีเมล') };
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: '08xxxxxxxx', required: true });
  const fields = Object.fromEntries(Object.keys(L).filter((k) => f[k] && f[k].on).map((k) => [k, h('input', { class: 'input', type: k === 'birthday' ? 'date' : k === 'email' ? 'email' : 'text', required: !!f[k].req })]));
  const extra = Object.fromEntries((cfg.custom_fields || []).map((c) => [c.key, h('input', { class: 'input', required: !!c.req })]));
  const submit = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post('/c/register', { phone: phone.value, ...Object.fromEntries(Object.entries(fields).map(([k, el]) => [k, el.value])), extra: Object.fromEntries(Object.entries(extra).map(([k, el]) => [k, el.value])) }, { token: null });
      store.set('member_token', r.token); store.set('suggest_pw', true);
      toast(tx('สมัครสมาชิกสำเร็จ · ') + r.default_password_hint, 'ok', 6000);
      const back = store.get('return_to'); store.del('return_to');
      if (back) location.hash = back; else go('home');
      route();
    } catch (er) { errToast(er); }
  };
  shell(h('form', { class: 'card', onsubmit: submit }, h('h2', {}, tx('สมัครสมาชิก')), h('label', { class: 'field' }, tx('เบอร์โทรศัพท์ (ใช้เข้าสู่ระบบ) *'), phone),
    ...Object.entries(fields).map(([k, el]) => h('label', { class: 'field' }, L[k] + (f[k].req ? ' *' : ''), el)),
    ...(cfg.custom_fields || []).map((c) => h('label', { class: 'field' }, c.label + (c.req ? ' *' : ''), extra[c.key])),
    h('p', { class: 'small muted' }, tx('รหัสผ่านเริ่มต้นจะเป็นเลข 4 ตัวท้ายของเบอร์โทร เปลี่ยนได้ภายหลังที่ "บัญชีของฉัน"')),
    h('button', { class: 'btn primary big block', type: 'submit' }, tx('สมัครสมาชิก')), h('p', { style: { textAlign: 'center' } }, h('a', { href: '#/home' }, tx('มีบัญชีแล้ว? เข้าสู่ระบบ')))));
}
function forgotPage() {
  const phone = h('input', { class: 'input', inputmode: 'tel', placeholder: tx('เบอร์โทรศัพท์') });
  const out = h('div');
  shell(h('div', { class: 'card' }, h('h2', {}, tx('ลืมรหัสผ่าน')), h('p', { class: 'muted' }, tx('ส่งคำขอถึงร้าน พนักงานจะยืนยันตัวตนของคุณก่อนส่งลิงก์ตั้งรหัสผ่านใหม่ (ใช้ได้ครั้งเดียว)')),
    h('label', { class: 'field' }, tx('เบอร์โทรศัพท์'), phone),
    h('button', { class: 'btn primary block', onclick: async (e) => { e.target.disabled = true; try { const r = await api.post('/c/forgot', { phone: phone.value }, { token: null }); out.replaceChildren(h('p', { class: 'badge ok', style: { whiteSpace: 'normal' } }, r.message)); } catch (er) { errToast(er); e.target.disabled = false; } } }, tx('ส่งคำขอ')), out,
    h('p', { class: 'small muted' }, tx('สถานะคำขอ: รอดำเนินการ → กำลังตรวจสอบ → สำเร็จ/ปฏิเสธ/หมดอายุ — ร้านจะติดต่อกลับทางเบอร์ที่ลงทะเบียนไว้')),
    h('a', { href: '#/home' }, tx('← กลับ'))));
}
function resetPage(tok) {
  const pw = pwInput(tx('รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)'));
  shell(h('div', { class: 'card' }, h('h2', {}, tx('ตั้งรหัสผ่านใหม่')), pw.el, h('button', { class: 'btn primary block', style: { marginTop: '.8em' }, onclick: async () => {
    try { await api.post('/c/reset', { token: tok, password: pw.input.value }, { token: null }); toast(tx('ตั้งรหัสผ่านใหม่แล้ว กรุณาเข้าสู่ระบบ'), 'ok'); store.del('member_token'); go('home'); } catch (e) { errToast(e); }
  } }, tx('บันทึก'))));
}

// ---------- extra verification (OTP or show code to staff) ----------
async function verify(purpose, ref) {
  if ((purpose === 'claim' ? cfg.claim_verify : cfg.verify) === 'none') return null;
  const v = await api.post('/c/verify/start', { purpose, ref });
  if (v.method === 'none') return null;
  return new Promise((resolve, reject) => {
    let done = false;
    if (v.method === 'otp') {
      const code = h('input', { class: 'input', inputmode: 'numeric', placeholder: tx('รหัส OTP 6 หลัก') });
      modal(tx('ยืนยันด้วย OTP'), h('div', {}, h('p', {}, v.message), code), { onClose: () => { if (!done) reject(new Error(tx('ยกเลิกการยืนยัน'))); }, actions: [{ label: tx('ยืนยัน'), class: 'primary', onClick: async () => { await api.post('/c/verify/otp', { id: v.id, code: code.value }); done = true; resolve(v.id); } }] });
    } else {
      const status = h('p', { class: 'muted' }, tx('รอพนักงานยืนยัน…'));
      const m = modal(tx('ยืนยันตัวตนกับพนักงาน'), h('div', { style: { textAlign: 'center' } }, h('p', {}, v.message), h('div', { style: { fontSize: '3em', fontWeight: 800, letterSpacing: '.2em' } }, v.code), status,
        h('p', { class: 'small muted' }, tx('เพื่อความปลอดภัย เพราะรหัสผ่านเริ่มต้นอาจถูกคาดเดาได้'))), { onClose: () => { if (!done) reject(new Error(tx('ยกเลิกการยืนยัน'))); } });
      const check = async () => {
        const s = await api.get('/c/verify/' + v.id).catch(() => null);
        if (s && s.status === 'approved') { done = true; m.close(); resolve(v.id); return true; }
        if (s && s.status === 'rejected') { status.textContent = tx('พนักงานปฏิเสธคำขอ'); return true; }
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
  const box = h('div', { class: 'card' }, h('h2', {}, tx('🧾 รับแต้มจากใบเสร็จ')),
    h('p', {}, tx('บิล '), h('strong', {}, c.bill_no), ' · ', fmtTime(c.paid_at)),
    h('p', {}, tx('ยอดที่ใช้คำนวณแต้ม: '), h('strong', {}, baht(c.base), tx(' บาท'))),
    c.claimable ? h('div', { style: { fontSize: '2em', fontWeight: 800, color: 'var(--brand)' } }, tx('+{0} แต้ม', c.points)) : h('p', { class: 'badge bad', style: { whiteSpace: 'normal' } }, c.reason),
    h('p', { class: 'small muted' }, tx('รับแต้มได้ถึง '), fmtTime(c.deadline), tx(' · รับได้ครั้งเดียวต่อบิล')));
  if (!c.claimable) return shell(box, h('a', { class: 'btn block', href: '#/home' }, tx('ไปหน้าสมาชิก')));
  if (!me) {
    store.set('return_to', '#/claim/' + tok);
    return shell(box, h('div', { class: 'card' }, h('p', {}, tx('เข้าสู่ระบบหรือสมัครสมาชิกเพื่อรับแต้มจากบิลนี้')),
      h('button', { class: 'btn primary big block', onclick: () => { loginPage(() => { location.hash = '#/claim/' + tok; route(); }); } }, tx('เข้าสู่ระบบ')),
      cfg.signup ? h('button', { class: 'btn big block', style: { marginTop: '.5em' }, onclick: () => go('register') }, tx('สมัครสมาชิกใหม่แล้วรับแต้ม')) : null));
  }
  // logged in → claim straight away (no button, no code) unless the shop requires verification for claims
  const doClaim = async () => {
    const vid = await verify('claim', c.bill_no);
    const r = await api.post('/c/claim/' + tok, { verification_id: vid });
    store.del('return_to');
    shell(h('div', { class: 'success-card' }, h('div', { class: 'rays' }), h('div', { class: 'burst' }, '🎉'), h('h2', {}, tx('รับแต้มสำเร็จ')), h('div', { class: 'big-pts', id: 'gotpts' }, '+0'),
      h('p', {}, tx('บิล {0} · แต้มคงเหลือ ', r.bill_no), h('strong', {}, r.balance.toLocaleString())), h('a', { class: 'btn primary big block', href: '#/home' }, tx('ไปหน้าสมาชิก'))));
    const g = $('#gotpts'); g.dataset.v = 0; countTo(g, r.points, (v) => '+' + v.toLocaleString(), 1200);
    confetti(); if (navigator.vibrate) navigator.vibrate([40, 60, 40]);
  };
  if (cfg.claim_verify === 'none') {
    shell(box, h('div', { class: 'card', style: { textAlign: 'center' } }, h('div', { class: 'spinner' }), h('p', {}, tx('กำลังรับแต้มเข้าบัญชี '), h('strong', {}, `${me.first_name || ''} (${me.member_no})`))));
    try { await doClaim(); } catch (er) { shell(box, h('div', { class: 'card' }, h('p', { class: 'badge bad', style: { whiteSpace: 'normal' } }, er.message), h('a', { class: 'btn block', href: '#/home' }, tx('ไปหน้าสมาชิก')))); }
    return;
  }
  shell(box, h('p', {}, tx('รับแต้มเข้าบัญชี '), h('strong', {}, `${me.first_name || ''} (${me.member_no})`)), h('button', { class: 'btn primary big block', onclick: async (e) => {
    e.target.disabled = true;
    try { await doClaim(); } catch (er) { errToast(er); e.target.disabled = false; }
  } }, tx('ยืนยันรับแต้ม')));
}

// ---------- pages ----------
function homePage() {
  const m = me;
  const tier = m.tier || {};
  const pr = m.progress && m.progress.next;
  const suggest = store.get('suggest_pw') && m.password_is_default;
  shell(
    suggest ? h('div', { class: 'card', style: { background: 'var(--warn-soft)' } }, h('strong', {}, tx('แนะนำให้เปลี่ยนรหัสผ่าน')), h('p', { class: 'small' }, tx('คุณยังใช้รหัสเริ่มต้น (4 ตัวท้ายของเบอร์) — เปลี่ยนตอนนี้หรือภายหลังก็ได้')),
      h('div', { class: 'row' }, h('a', { class: 'btn sm primary', href: '#/account' }, tx('เปลี่ยนตอนนี้')), h('button', { class: 'btn sm', onclick: () => { store.del('suggest_pw'); homePage(); } }, tx('ไว้ภายหลัง')))) : null,
    h('div', { class: 'mcard', id: 'mcard', style: `--tier:${/^#[0-9a-f]{3,8}$/i.test(tier.color || '') ? tier.color : '#e8321f'}` }, h('i', { class: 'holo' }),
      h('div', { class: 'row between' }, h('div', { class: 'chip' }), h('span', { class: 'badge', style: { background: '#fff', color: '#111' } }, tier.icon || '⭐', ' ', tier.name || 'Member')),
      h('div', { style: { marginTop: '1em' } }, h('div', { class: 'small' }, tx('แต้มคงเหลือ')), h('div', { class: 'pts', id: 'mpts' }, '0'),
        m.reserved_points ? h('div', { class: 'small' }, tx('สำรองไว้สำหรับคูปอง {0} แต้ม', m.reserved_points)) : null,
        m.expiring_points ? h('div', { class: 'small' }, tx('⏳ {0} แต้มจะหมดอายุ {1}', m.expiring_points, fmtTime(m.expiring_first))) : null),
      h('div', { class: 'no', style: { marginTop: '1em' } }, `${m.first_name || ''} ${m.last_name || ''} · ${m.member_no}`),
      pr ? h('div', { style: { marginTop: '.6em' } }, h('div', { class: 'small' }, tx('ความคืบหน้าสู่ {0} {1}%', pr.name, m.progress.pct)), h('div', { class: 'prog' }, h('i', { style: `--w:${Math.max(0, Math.min(100, Number(m.progress.pct) || 0))}%` })),
        h('div', { class: 'small' }, m.progress.need.map((n) => (n.kind === 'spent' ? tx('ยอดซื้อ {0}/{1} บาท', baht(n.have), baht(n.need)) : tx('มาใช้บริการ {0}/{1} ครั้ง', n.have, n.need))).join(' · '))) : h('div', { class: 'small', style: { marginTop: '.6em' } }, tx('คุณอยู่ระดับสูงสุดแล้ว 🎉'))),
    h('div', { class: 'barcode-card' }, h('canvas', { id: 'mbc', width: 320, height: 70 }), h('div', { class: 'small muted' }, tx('แสดงบาร์โค้ดนี้หรือบอกเบอร์โทรเพื่อสะสมแต้มที่ร้าน'))),
    h('a', { class: 'scan-cta', href: '#/scan' }, h('span', { class: 'ic' }, scanIcon()),
      h('span', {}, h('b', {}, tx('สแกน QR ใบเสร็จ สะสมแต้ม')), h('small', {}, tx('เปิดกล้องแล้วส่องที่ QR ท้ายใบเสร็จ รับแต้มทันที'))), h('span', { class: 'go' }, '›')),
    h('div', { class: 'quick' },
      h('a', { class: 'btn', href: '#/rewards' }, h('b', {}, '🎁'), tx('แลกของรางวัล')),
      h('a', { class: 'btn', href: '#/history' }, h('b', {}, '🧾'), tx('ประวัติการซื้อ')),
      h('a', { class: 'btn', href: '#/coupons' }, h('b', {}, '🎟️'), tx('คูปอง ({0})', m.coupons_active)),
      cfg.mobile ? h('a', { class: 'btn', href: '#/contact', onclick: (e) => { e.preventDefault(); toast(tx('สแกน QR สั่งอาหารที่โต๊ะ หรือขอใบ QR จากพนักงาน'), 'info', 5000); } }, h('b', {}, '🍜'), tx('สั่งอาหาร')) : null,
      h('a', { class: 'btn', href: '#/points' }, h('b', {}, '⭐'), tx('ประวัติแต้ม')),
      h('a', { class: 'btn', href: '#/benefits' }, h('b', {}, '👑'), tx('สิทธิประโยชน์'))));
  drawBarcode($('#mbc'), m.member_no);
  // points count up from what the member saw last time (first visit: from 0)
  const pts = $('#mpts'); const seen = Number(store.get('seen_points') ?? 0);
  pts.dataset.v = seen; countTo(pts, m.points, (v) => v.toLocaleString(), 1100);
  if (m.points > seen && seen) setTimeout(() => sparkle($('#mcard')), 700);
  store.set('seen_points', m.points);
  tilt($('#mcard'));
}
// the membership card leans toward your finger / mouse and its holographic sheen follows
function tilt(card) {
  if (!card || matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.posFx === 'off') return;
  const move = (x, y) => { const r = card.getBoundingClientRect(); const px = (x - r.left) / r.width - 0.5, py = (y - r.top) / r.height - 0.5;
    card.style.transform = `perspective(800px) rotateY(${px * 14}deg) rotateX(${-py * 12}deg) translateZ(0)`; card.style.setProperty('--mx', (px + 0.5) * 100 + '%'); card.style.setProperty('--my', (py + 0.5) * 100 + '%'); };
  card.addEventListener('pointermove', (e) => move(e.clientX, e.clientY));
  card.addEventListener('pointerleave', () => { card.style.transform = ''; });
  // phones: lean with the device when the browser allows it without asking
  if (window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission !== 'function') {
    const on = (e) => { if (!document.body.contains(card)) return window.removeEventListener('deviceorientation', on); if (e.gamma == null) return;
      const r = card.getBoundingClientRect(); move(r.left + r.width * (0.5 + Math.max(-0.5, Math.min(0.5, e.gamma / 60))), r.top + r.height * (0.5 + Math.max(-0.5, Math.min(0.5, (e.beta - 40) / 60)))); };
    window.addEventListener('deviceorientation', on);
  }
}
function sparkle(host) {
  if (!host) return;
  const box = h('div', { class: 'sparkles' }, Array.from({ length: 14 }, (_, i) => h('i', { style: `left:${10 + Math.random() * 80}%;top:${10 + Math.random() * 70}%;animation-delay:${i * 60}ms` }, i % 2 ? '✨' : '⭐')));
  host.append(box); setTimeout(() => box.remove(), 1600);
}
function confetti() {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || document.documentElement.dataset.posFx === 'off') return;
  const colors = ['#facc15', '#f97316', '#ef4444', '#22c55e', '#3b82f6', '#ec4899'];
  const box = h('div', { class: 'mconfetti' }, Array.from({ length: 70 }, (_, i) => h('i', { style: `left:${Math.random() * 100}%;background:${colors[i % colors.length]};animation-delay:${Math.random() * 0.5}s;animation-duration:${1.8 + Math.random() * 1.6}s;--r:${Math.round(Math.random() * 720)}deg` })));
  document.body.append(box); setTimeout(() => box.remove(), 4200);
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
const loadJsQR = () => (jsqrLoad ||= new Promise((res, rej) => { if (window.jsQR) return res(window.jsQR); const sc = document.createElement('script'); sc.src = '/vendor/jsQR.js'; sc.onload = () => res(window.jsQR); sc.onerror = () => { jsqrLoad = null; rej(new Error(tx('โหลดตัวอ่าน QR ไม่สำเร็จ'))); }; document.head.append(sc); }));
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
  if (!tok) { toast(tx('QR นี้ไม่ใช่ QR รับแต้มจากใบเสร็จของร้าน'), 'warn'); return false; }
  if (navigator.vibrate) navigator.vibrate(60);
  stopScan();
  location.hash = '#/claim/' + tok;
  return true;
}
async function scanPage() {
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  const status = h('div', { class: 'scan-status' }, tx('กำลังเปิดกล้อง…'));
  const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    try {
      const img = new Image(); img.src = URL.createObjectURL(f); await img.decode();
      const text = await (await decoder())(img);
      URL.revokeObjectURL(img.src);
      if (!text) return toast(tx('ไม่พบ QR ในรูปนี้ ลองถ่ายให้ชัดและเห็น QR ทั้งหมด'), 'warn', 4000);
      onScanned(text);
    } catch (e) { errToast(e); }
    file.value = '';
  };
  shell(h('div', { class: 'scan-card' },
    h('div', { class: 'viewfinder' }, video, h('div', { class: 'frame' }, h('i', { class: 'c1' }), h('i', { class: 'c2' }), h('i', { class: 'c3' }), h('i', { class: 'c4' }), h('b', { class: 'laser' }))),
    status,
    h('div', { class: 'scan-steps' }, h('div', {}, h('b', {}, '1'), tx('ส่องกล้องที่ QR ท้ายใบเสร็จ')), h('div', {}, h('b', {}, '2'), tx('ระบบอ่านอัตโนมัติ')), h('div', {}, h('b', {}, '3'), tx('รับแต้มเข้าบัญชีทันที'))),
    h('button', { class: 'btn block', onclick: () => file.click() }, tx('🖼️ เลือกรูปใบเสร็จจากคลังภาพ')), file,
    h('p', { class: 'small muted', style: { textAlign: 'center', margin: 0 } }, tx('รับได้ครั้งเดียวต่อบิล และภายในเวลาที่ร้านกำหนด'))));
  const st = (scanState = { stop: false, stream: null });
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw Object.assign(new Error(tx('อุปกรณ์นี้เปิดกล้องจากเว็บไม่ได้')), { name: 'NotSupported' });
    st.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    if (st.stop) { st.stream.getTracks().forEach((t) => t.stop()); return; }
    video.srcObject = st.stream; await video.play().catch(() => {});
    status.textContent = tx('ส่องกล้องให้ QR อยู่ในกรอบ');
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
    status.textContent = e.name === 'NotAllowedError' ? tx('ไม่ได้รับอนุญาตให้ใช้กล้อง — อนุญาตกล้องในการตั้งค่าเบราว์เซอร์ หรือเลือกรูปใบเสร็จจากคลังภาพแทน')
      : (e.message || tx('เปิดกล้องไม่สำเร็จ')) + tx(' — เลือกรูปใบเสร็จจากคลังภาพแทนได้');
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
  shell(h('h2', {}, tx('ของรางวัล')), h('p', { class: 'muted' }, tx('แต้มคงเหลือ {0}', me.points)), ...(list.length ? list.map((r) => h('div', { class: 'card' },
    r.image ? h('img', { src: r.image, style: { width: '100%', borderRadius: '12px' } }) : null, h('h3', {}, r.name), r.description ? h('p', {}, r.description) : null,
    h('p', { class: 'small muted' }, tx('ใช้ {0} แต้ม · คูปองใช้ได้ {1} วันหลังแลก{2}{3}', r.points, r.coupon_days, r.ends_at ? tx(' · แลกได้ถึง ') + fmtTime(r.ends_at) : '', r.remaining !== null ? tx(' · เหลือ {0} สิทธิ์', r.remaining) : '')),
    r.terms ? h('p', { class: 'small' }, tx('เงื่อนไข: '), r.terms) : null,
    h('p', { class: 'small muted' }, r.return_policy === 'forfeit' ? tx('หากคูปองหมดอายุจะไม่คืนแต้ม') : tx('หากคูปองหมดอายุหรือยกเลิก ระบบคืนแต้มให้')),
    r.unavailable ? h('span', { class: 'badge' }, r.unavailable) : h('button', { class: 'btn primary block', onclick: async (e) => {
      e.target.disabled = true;
      try {
        const vid = await verify('redeem', r.id);
        const c = await api.post(`/c/rewards/${r.id}/redeem`, { verification_id: vid });
        toast(tx('แลกสำเร็จ แสดงคูปองที่เคาน์เตอร์'), 'ok'); go('coupons');
      } catch (er) { errToast(er); e.target.disabled = false; }
    } }, tx('แลก {0} แต้ม', r.points)))) : [h('div', { class: 'empty' }, tx('ยังไม่มีของรางวัล'))]));
}
async function couponsPage() {
  loading();
  const list = await api.get('/c/coupons');
  const TH = { reserved: tx('ใช้ได้'), used: tx('ใช้แล้ว'), expired: tx('หมดอายุ'), cancelled: tx('ยกเลิก') };
  shell(h('h2', {}, tx('คูปองของฉัน')), ...(list.length ? list.map((c) => {
    const live = c.status === 'reserved' && new Date(c.expires_at) > new Date();
    const cv = h('canvas', { width: 300, height: 70 });
    const el = h('div', { class: 'coupon', style: live ? {} : { opacity: .55 } }, h('strong', {}, c.reward_name), h('div', {}, h('span', { class: 'badge ' + (live ? 'ok' : '') }, live ? TH.reserved : TH[c.status] || tx('หมดอายุ'))),
      live ? cv : null, h('div', { class: 'code' }, c.code), h('div', { class: 'small muted' }, live ? tx('ใช้ได้ถึง {0}', fmtTime(c.expires_at)) : c.used_at ? tx('ใช้เมื่อ {0}', fmtTime(c.used_at)) : ''),
      live ? h('button', { class: 'btn sm ghost', onclick: async () => { if (confirm(tx('ยกเลิกคูปองและคืนแต้มตามเงื่อนไข?'))) { await api.post(`/c/coupons/${c.id}/cancel`).catch(errToast); couponsPage(); } } }, tx('ยกเลิกคูปอง')) : null);
    if (live) setTimeout(() => drawBarcode(cv, c.code));
    return el;
  }) : [h('div', { class: 'empty' }, tx('ยังไม่มีคูปอง'))]));
}
async function historyPage() {
  loading();
  const bills = await api.get('/c/bills');
  const SRC = { pos: tx('หน้าร้าน'), mobile_table: tx('สั่งที่โต๊ะ'), mobile_pickup: 'Pick Up' };
  shell(h('h2', {}, tx('ประวัติการซื้อ')), h('div', { class: 'row' }, h('a', { class: 'btn sm', href: '#/points' }, tx('ประวัติแต้ม'))),
    ...(bills.length ? bills.map((b) => h('button', { class: 'card', style: { textAlign: 'left' }, onclick: () => billDetail(b.id) }, h('div', { class: 'row between' }, h('strong', {}, b.bill_no), h('strong', {}, baht(b.total - b.refunded_amount), tx(' ฿'))),
      h('div', { class: 'small muted' }, tx('{0} · {1} · {2} ชาม · +{3} แต้ม{4}', fmtTime(b.paid_at), SRC[b.source] || b.source, b.bowls, b.points_earned, b.status === 'void' ? tx(' · ยกเลิก') : '')))) : [h('div', { class: 'empty' }, tx('ยังไม่มีประวัติการซื้อ'))]));
}
async function billDetail(id) {
  const b = await api.get('/c/bills/' + id);
  modal(tx('บิล ') + b.bill_no, h('div', {}, h('p', { class: 'small muted' }, fmtTime(b.paid_at), b.queue_no ? tx(' · คิว ') + b.queue_no : ''),
    h('table', { class: 'table' }, h('tbody', {}, b.items.map((i) => h('tr', {}, h('td', {}, `${i.qty - i.void_qty} × ${i.name}`, h('div', { class: 'small muted' }, i.options.map((o) => o.name).join(', '))), h('td', { class: 'r' }, baht(i.line_total)))))),
    b.discount ? h('p', {}, tx('ส่วนลด '), baht(b.discount)) : null, h('p', {}, h('strong', {}, tx('รวม '), baht(b.total), tx(' บาท'))), b.refunded_amount ? h('p', {}, tx('คืนเงิน '), baht(b.refunded_amount)) : null, h('p', {}, tx('แต้มที่ได้ {0}', b.points_earned))));
}
async function pointsPage() {
  loading();
  const rows = await api.get('/c/points');
  const K = { earn: tx('สะสม'), redeem_hold: tx('สำรองแลก'), redeem: tx('แลกรางวัล'), redeem_release: tx('คืนแต้ม'), adjust: tx('ปรับโดยร้าน'), refund: tx('ปรับจากการคืนเงิน'), expire: tx('หมดอายุ') };
  shell(h('h2', {}, tx('ประวัติแต้ม')), h('div', { class: 'card' }, rows.length ? h('table', { class: 'table' }, h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, K[r.kind] || r.kind, h('div', { class: 'small muted' }, fmtTime(r.created_at), r.reason ? ' · ' + r.reason : '')),
    h('td', { class: 'r', style: { color: r.delta >= 0 ? 'var(--ok)' : 'var(--bad)', fontWeight: 800 } }, (r.delta > 0 ? '+' : '') + r.delta), h('td', { class: 'r small muted' }, r.balance_after)))))
    : h('div', { class: 'empty' }, tx('ยังไม่มีรายการ'))));
}
async function benefitsPage() {
  loading();
  const tiers = await api.get('/c/benefits');
  shell(h('h2', {}, tx('สิทธิประโยชน์สมาชิก')), ...tiers.map((t) => h('div', { class: 'card', style: { borderLeft: `6px solid ${t.color}` } }, h('h3', {}, t.icon || '⭐', ' ', t.name, me.tier && me.tier.id === t.id ? h('span', { class: 'badge ok' }, tx(' ระดับของคุณ')) : null),
    h('p', {}, t.benefits || ''), h('p', { class: 'small muted' }, [t.min_spent ? tx('ยอดซื้อ {0} บาท', baht(t.min_spent)) : null, t.min_visits ? tx('มาใช้บริการ {0} ครั้ง', t.min_visits) : null].filter(Boolean).join(tx(' และ ')) || tx('สมัครสมาชิก')),
    h('p', { class: 'small' }, tx('แต้ม x{0}{1}', t.multiplier, t.discount_pct ? tx(' · ส่วนลด {0}%', t.discount_pct) : '')))));
}
function accountPage() {
  const m = me;
  const cur = pwInput(tx('รหัสผ่านปัจจุบัน')); const nx = pwInput(tx('รหัสผ่านใหม่ (อย่างน้อย 6 ตัว)'));
  const f = cfg.fields;
  const inputs = Object.fromEntries(['first_name', 'last_name', 'nickname', 'birthday'].filter((k) => f[k] && f[k].on).map((k) => [k, h('input', { class: 'input', type: k === 'birthday' ? 'date' : 'text', value: m[k] || '' })]));
  const L = { first_name: tx('ชื่อ'), last_name: tx('นามสกุล'), nickname: tx('ชื่อเล่น'), birthday: tx('วันเกิด') };
  shell(h('h2', {}, tx('บัญชีของฉัน')),
    h('div', { class: 'card' }, h('p', {}, tx('เบอร์โทร '), maskPhone(m.phone), ' · ', m.member_no), ...Object.entries(inputs).map(([k, el]) => h('label', { class: 'field' }, L[k], el)),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.put('/c/me', Object.fromEntries(Object.entries(inputs).map(([k, el]) => [k, el.value]))); toast(tx('บันทึกแล้ว'), 'ok'); } catch (e) { errToast(e); } } }, tx('บันทึกข้อมูล'))),
    h('div', { class: 'card' }, h('h3', {}, tx('เปลี่ยนรหัสผ่าน')), m.password_is_default ? h('p', { class: 'small muted' }, tx('ตอนนี้ใช้รหัสเริ่มต้น (4 ตัวท้ายของเบอร์) — ไม่บังคับเปลี่ยน')) : null,
      h('label', { class: 'field' }, tx('รหัสผ่านปัจจุบัน'), cur.el), h('label', { class: 'field' }, tx('รหัสผ่านใหม่'), nx.el),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.post('/c/password', { current: cur.input.value, next: nx.input.value }); store.del('suggest_pw'); toast(tx('เปลี่ยนรหัสผ่านแล้ว'), 'ok'); } catch (e) { errToast(e); } } }, tx('เปลี่ยนรหัสผ่าน'))),
    h('a', { class: 'btn block', href: '#/forgot' }, tx('ลืมรหัสผ่าน / สถานะคำขอ')), h('a', { class: 'btn block', href: '#/contact' }, tx('ติดต่อร้าน')),
    h('button', { class: 'btn danger block', onclick: async () => { await api.post('/c/logout').catch(() => {}); store.del('member_token'); me = null; go('home'); route(); } }, tx('ออกจากระบบ')),
    h('p', { class: 'version', style: { textAlign: 'center' } }, 'v' + VERSION));
}
function contactPage() {
  shell(h('div', { class: 'card' }, h('h2', {}, tx('ติดต่อร้าน')), h('p', {}, cfg.store.name), cfg.store.address ? h('p', {}, '📍 ', cfg.store.address) : null,
    cfg.store.phone ? h('p', {}, '📞 ', h('a', { href: 'tel:' + cfg.store.phone }, cfg.store.phone)) : null, cfg.store.contact_line ? h('p', {}, 'LINE: ', cfg.store.contact_line) : null,
    h('a', { class: 'btn block', href: '#/home' }, tx('← กลับ'))));
}
boot().catch((e) => app.replaceChildren(h('div', { class: 'empty' }, e.message)));
