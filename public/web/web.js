// Customer website (/web): shop info, open now, menu with pictures, hours, map and contact — all from the shop settings.
import { h } from '/shared/ui.js';
import { baht } from '/shared/core.js';
import { applyTheme } from '/shared/theme.js';
import { applyFonts } from '/shared/fonts.js';
import { t as tx, initLang, langPicker, trName } from '/shared/i18n.js';

const DAYS_OF = () => [tx('อาทิตย์'), tx('จันทร์'), tx('อังคาร'), tx('พุธ'), tx('พฤหัสบดี'), tx('ศุกร์'), tx('เสาร์')];
const app = document.getElementById('app');
let D = null, cat = 'all', q = '';

const statusText = (o) => (o.open ? tx('เปิดอยู่ · ปิด {0} น.', o.until) : o.next ? tx('ปิดอยู่ · เปิด{0} {1} น.', o.next_day === o.day ? tx('วันนี้') : tx('วัน') + DAYS[o.next_day], o.next) : tx('ปิดอยู่'));
const chili = (n) => (n > 0 ? h('span', { class: 'chili', title: tx('เผ็ด {0}/5', n) }, '🌶️'.repeat(n)) : null);
const mapsLink = () => D.web.map_url || (D.store.address ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${D.store.name} ${D.store.address}`) : '');
const mapsEmbed = () => (/\/maps\/embed/.test(D.web.map_url) ? D.web.map_url : D.store.address ? 'https://www.google.com/maps?output=embed&q=' + encodeURIComponent(D.store.address) : '');
const lineLink = () => D.web.line_url || (D.store.line ? 'https://line.me/R/ti/p/' + encodeURIComponent(D.store.line.startsWith('@') ? D.store.line : '@' + D.store.line) : '');

// menu names / words in the chosen language (Thai kept to switch back)
function localize() {
  const m = D && D.menu; if (!m) return;
  for (const p of m.products) {
    p._th ||= { name: p.name, description: p.description, highlights: p.highlights };
    p.name = trName(m, 'product', p.id, 'name', p._th.name); p.description = trName(m, 'product', p.id, 'description', p._th.description);
    const hl = trName(m, 'product', p.id, 'highlights', ''); p.highlights = hl ? hl.split('\n').map((x) => x.trim()).filter(Boolean) : p._th.highlights;
  }
  for (const c of m.categories) { c._th ||= c.name; c.name = trName(m, 'category', c.id, 'name', c._th); }
  D._spice_th ||= D.spice_words || [];
  D.spice_words = D._spice_th.map((w, i) => trName(m, 'spice', String(i), 'name', w));
}
async function load() {
  await initLang();
  D = await fetch('/api/public/web', { cache: 'no-store' }).then((r) => r.json());
  localize();
  document.title = D.store.name + (D.enabled && D.web.tagline ? ' · ' + D.web.tagline : '');
  if (!D.enabled) return app.replaceChildren(h('div', { class: 'closed-page' }, h('div', {}, h('h1', {}, D.store.name), h('p', { class: 'lead' }, tx('เว็บไซต์ร้านปิดปรับปรุงชั่วคราว')))));
  try { applyFonts(D.fonts, 'mobile'); if (D.theme && Object.keys(D.theme).length) applyTheme(D.theme); } catch { /* keep the built-in look */ }
  render();
}

function dishCard(p) {
  return h('button', { class: 'dish reveal', onclick: () => sheet(p) },
    h('div', { class: 'ph' + (p.image ? '' : ' none') }, h('img', { src: p.image || '/assets/bowl.svg', alt: p.name, loading: 'lazy' }), p.sold_out ? h('div', { class: 'out' }, tx('หมดชั่วคราว')) : null),
    h('div', { class: 'bd' }, h('div', { class: 'row2' }, h('b', {}, p.name), chili(p.spice)),
      p.description ? h('div', { class: 'ds' }, p.description) : null,
      p.price != null ? h('div', { class: 'pr' }, baht(p.price) + tx(' ฿')) : null));
}

function sheet(p) {
  const close = () => { el.remove(); document.removeEventListener('keydown', esc); };
  const esc = (e) => { if (e.key === 'Escape') close(); };
  const el = h('div', { class: 'sheet', onclick: (e) => { if (e.target === el) close(); } },
    h('div', { class: 'card2', role: 'dialog', 'aria-label': p.name },
      h('button', { class: 'x', onclick: close, 'aria-label': tx('ปิด') }, '✕'),
      h('div', { class: 'im' + (p.image ? '' : ' none') }, h('img', { src: p.image || '/assets/bowl.svg', alt: p.name })),
      h('div', { class: 'bd' }, h('h3', {}, p.name),
        p.price != null ? h('div', { class: 'pr', style: { fontFamily: 'var(--head-font)', fontWeight: 800, color: 'var(--brand)', fontSize: '1.4em' } }, baht(p.price) + tx(' ฿')) : null,
        p.spice === null ? null : h('div', {}, tx('ความเผ็ด '), chili(p.spice), ` ${(D.spice_words || [])[p.spice] || ''}${p.spice ? ` (${p.spice}/5)` : ''}`),
        p.sold_out ? h('div', { class: 'note' }, tx('⏳ หมดชั่วคราว')) : null,
        p.description ? h('p', { class: 'about', style: { margin: 0 } }, p.description) : null,
        p.highlights.length ? h('ul', {}, p.highlights.map((x) => h('li', {}, x))) : null)));
  document.addEventListener('keydown', esc);
  document.body.append(el);
}

function menuList() {
  const M = D.menu;
  const words = q.trim().toLowerCase();
  const match = (p) => !words || (p.name + ' ' + p.description + ' ' + p.highlights.join(' ')).toLowerCase().includes(words);
  const cats = M.categories.filter((c) => cat === 'all' || c.id === cat);
  const blocks = cats.map((c) => {
    const ps = M.products.filter((p) => p.category_id === c.id && match(p));
    return ps.length ? h('div', { class: 'cat' }, h('h3', {}, h('i', { style: c.color ? { background: c.color } : {} }), c.name), h('div', { class: 'grid' }, ps.map(dishCard))) : null;
  }).filter(Boolean);
  const other = cat === 'all' ? M.products.filter((p) => !M.categories.some((c) => c.id === p.category_id) && match(p)) : [];
  if (other.length) blocks.push(h('div', { class: 'cat' }, h('h3', {}, h('i'), tx('อื่น ๆ')), h('div', { class: 'grid' }, other.map(dishCard))));
  return blocks.length ? blocks : [h('div', { class: 'empty' }, tx('ไม่พบเมนูที่ค้นหา'))];
}

function render() {
  const { store: S, web: W, open: O } = D;
  const today = O.day;
  const list = h('div');
  const drawMenu = () => { list.replaceChildren(...menuList()); observe(list); };
  const tabs = D.menu ? h('div', { class: 'tabs' }, [['all', tx('ทั้งหมด')], ...D.menu.categories.map((c) => [c.id, c.name])].map(([id, name]) =>
    h('button', { class: cat === id ? 'on' : '', onclick: (e) => { cat = id; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); drawMenu(); } }, name))) : null;
  const featured = D.menu ? W.featured.map((id) => D.menu.products.find((p) => p.id === id)).filter(Boolean) : [];
  const L = (href, ic, t, sub) => (href ? h('a', { href, target: href.startsWith('tel:') ? null : '_blank', rel: 'noopener' }, h('span', { class: 'ic' }, ic), h('span', {}, t, sub ? h('small', {}, sub) : null)) : null);
  const contact = [L(S.phone ? 'tel:' + S.phone.replace(/[^\d+]/g, '') : '', '📞', tx('โทรหาร้าน'), S.phone), L(lineLink(), '💬', 'LINE', S.line || tx('แชทกับร้าน')),
    L(W.facebook, '📘', 'Facebook'), L(W.instagram, '📸', 'Instagram'), L(W.tiktok, '🎵', 'TikTok')].filter(Boolean);
  const delivery = [L(W.grab_url, '🛵', tx('สั่งผ่าน GrabFood')), L(W.lineman_url, '🟢', tx('สั่งผ่าน LINE MAN'))].filter(Boolean);
  const embed = mapsEmbed();

  app.replaceChildren(
    h('header', { class: 'top' }, h('div', { class: 'wrap' },
      h('a', { class: 'brand', href: '#top' }, h('span', { class: 'lg' }, h('img', { src: S.logo || '/assets/icon.svg', alt: '' })), h('span', {}, S.name)),
      h('nav', { class: 'nav' }, D.menu ? h('a', { href: '#menu' }, tx('เมนู')) : null, h('a', { href: '#hours' }, tx('เวลาเปิด')), h('a', { href: '#contact' }, tx('ติดต่อ')), W.about ? h('a', { href: '#about' }, tx('เกี่ยวกับร้าน')) : null),
      langPicker(h, () => { localize(); render(); }, { fontSize: '.8em', maxWidth: '108px', marginRight: '6px' }),
      h('span', { class: 'status' + (O.open ? ' open' : '') }, O.open ? tx('เปิดอยู่') : tx('ปิดอยู่')))),
    D.members ? h('section', { class: 'member-top', style: { paddingTop: '16px', paddingBottom: 0 } }, h('div', { class: 'wrap' }, h('div', { class: 'member' },
      h('div', {}, h('h2', { style: { color: '#fff' } }, tx('สมัครสมาชิก สะสมแต้ม')), h('p', {}, tx('ทุกการสั่งได้แต้ม แลกของรางวัลและส่วนลดที่ร้าน'))),
      h('a', { class: 'cta', href: '/member/' }, tx('⭐ สมัคร / เข้าสู่ระบบสมาชิก'))))) : null,
    h('section', { class: 'hero', id: 'top' }, h('div', { class: 'wrap' },
      h('div', {},
        S.branch ? h('span', { class: 'eyebrow' }, S.branch) : null,
        h('h1', {}, h('em', {}, S.name)),
        W.tagline ? h('p', { class: 'tag' }, W.tagline) : null,
        h('div', { class: 'meta' }, h('span', { class: 'status' + (O.open ? ' open' : '') }, statusText(O)), S.address ? h('span', {}, '📍 ' + S.address) : null),
        h('div', { class: 'ctas' }, D.menu ? h('a', { class: 'cta main', href: '#menu' }, tx('🍜 ดูเมนู')) : null,
          S.phone ? h('a', { class: 'cta', href: 'tel:' + S.phone.replace(/[^\d+]/g, '') }, tx('📞 โทร')) : null,
          mapsLink() ? h('a', { class: 'cta', href: mapsLink(), target: '_blank', rel: 'noopener' }, tx('🧭 เส้นทาง')) : null,
          lineLink() ? h('a', { class: 'cta', href: lineLink(), target: '_blank', rel: 'noopener' }, '💬 LINE') : null),
        W.announcement ? h('div', { class: 'note' }, '📣', h('span', {}, W.announcement)) : null),
      h('div', { class: 'art' + (W.hero_image ? '' : ' ill') }, h('img', { src: W.hero_image || '/assets/bowl.svg', alt: S.name })))),
    featured.length ? h('section', { style: { paddingTop: '8px' } }, h('div', { class: 'wrap' }, h('span', { class: 'eyebrow' }, 'Recommended'), h('h2', {}, tx('เมนูแนะนำ')),
      h('div', { class: 'feat' }, featured.map(dishCard)))) : null,
    D.menu ? h('section', { id: 'menu', style: { paddingTop: featured.length ? '8px' : null } }, h('div', { class: 'wrap' },
      h('span', { class: 'eyebrow' }, 'Menu'), h('h2', {}, tx('เมนูของเรา')),
      h('input', { class: 'search', type: 'search', placeholder: tx('🔍 ค้นหาเมนู'), oninput: (e) => { q = e.target.value; drawMenu(); } }),
      tabs, list)) : null,
    W.about ? h('section', { id: 'about' }, h('div', { class: 'wrap' }, h('span', { class: 'eyebrow' }, 'About'), h('h2', {}, tx('เกี่ยวกับร้าน')), h('p', { class: 'about reveal' }, W.about))) : null,
    h('section', { id: 'hours' }, h('div', { class: 'wrap' }, h('span', { class: 'eyebrow' }, 'Visit us'), h('h2', {}, tx('เวลาเปิดและที่ตั้ง')),
      h('div', { class: 'info' },
        h('div', { class: 'box reveal' }, h('h3', {}, tx('🕒 เวลาเปิด-ปิด')),
          h('table', { class: 'hours' }, [1, 2, 3, 4, 5, 6, 0].map((d) => { const x = W.hours[d]; return h('tr', { class: d === today ? 'today' : '' }, h('td', {}, DAYS_OF()[d]), h('td', {}, x.closed ? tx('หยุด') : `${x.open} – ${x.close}`)); })),
          W.hours_note ? h('p', { class: 'small muted', style: { margin: '12px 0 0' } }, W.hours_note) : null),
        h('div', { class: 'box reveal' }, h('h3', {}, tx('📍 ที่ตั้งร้าน')), h('p', { style: { margin: 0 } }, S.address || '—'),
          embed ? h('iframe', { class: 'map', src: embed, loading: 'lazy', referrerpolicy: 'no-referrer-when-downgrade', title: tx('แผนที่') }) : null,
          mapsLink() ? h('div', { class: 'links', style: { marginTop: '12px' } }, L(mapsLink(), '🧭', tx('เปิดใน Google Maps'), tx('นำทางมาที่ร้าน'))) : null)))),
    h('section', { id: 'contact', style: { paddingTop: 0 } }, h('div', { class: 'wrap' }, h('div', { class: 'info' },
      contact.length ? h('div', { class: 'box reveal' }, h('h3', {}, tx('☎️ ติดต่อร้าน')), h('div', { class: 'links' }, contact)) : null,
      delivery.length ? h('div', { class: 'box reveal' }, h('h3', {}, tx('🛵 สั่งเดลิเวอรี่')), h('div', { class: 'links' }, delivery)) : null))),
    h('footer', {}, h('div', { class: 'wrap' }, `© ${new Date().getFullYear()} ${S.name}`, S.branch ? ' · ' + S.branch : '')));
  drawMenu();
  observe(app);
}

// cards and boxes slide in as they come into view
let io = null;
function observe(root) {
  if (!('IntersectionObserver' in window)) { root.querySelectorAll('.reveal').forEach((e) => e.classList.add('in')); return; }
  io = io || new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -40px 0px' });
  root.querySelectorAll('.reveal:not(.in)').forEach((e) => io.observe(e));
}

load().catch((e) => app.replaceChildren(h('div', { class: 'closed-page' }, h('div', { class: 'empty' }, tx('โหลดไม่สำเร็จ '), e.message))));
// open/closed and sold-out stay current while the page is open
setInterval(() => { if (!document.hidden && !document.querySelector('.sheet')) fetch('/api/public/web', { cache: 'no-store' }).then((r) => r.json()).then((d) => { if (d.enabled && JSON.stringify(d.open) + JSON.stringify(d.menu) !== JSON.stringify(D.open) + JSON.stringify(D.menu)) { const y = scrollY; D = d; render(); scrollTo(0, y); } }).catch(() => {}); }, 120e3);
