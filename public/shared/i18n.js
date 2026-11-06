// Customer pages in ไทย / English / 中文 / 日本語 / 한국어.
// Text is written in Thai in the code and passed through t('…'); the other languages come from the shop's
// translations (จัดการร้าน → เมนูและสินค้า → 🌐 ภาษา → ให้ AI แปล), so a missing one simply shows the Thai.
// {0} {1} … in the text are filled with the extra arguments: t('รวม {0} บาท', amount).
export const LANGS = [['th', 'ไทย', '🇹🇭'], ['en', 'English', '🇬🇧'], ['zh', '中文', '🇨🇳'], ['ja', '日本語', '🇯🇵'], ['ko', '한국어', '🇰🇷']];
const KEY = 'opp.lang';
let dict = {}, cur = 'th';
const fill = (s, a) => (a.length ? String(s).replace(/\{(\d+)\}/g, (m, i) => (a[i] !== undefined && a[i] !== null ? a[i] : '')) : s);
export const t = (s, ...a) => fill((cur !== 'th' && dict[s]) || s, a);
export const lang = () => cur;
const guess = () => { const n = String(navigator.language || '').toLowerCase(); return LANGS.find(([c]) => c !== 'th' && n.startsWith(c)) ? n.slice(0, 2) : 'th'; };
// call once before drawing the page
export async function initLang() {
  try { cur = localStorage.getItem(KEY) || guess(); } catch { cur = guess(); }
  if (!LANGS.some(([c]) => c === cur)) cur = 'th';
  await loadDict(cur);
  document.documentElement.lang = cur;
  return cur;
}
async function loadDict(code) {
  dict = {};
  if (code === 'th') return;
  try { dict = await fetch('/api/public/i18n/' + code).then((r) => (r.ok ? r.json() : {})); } catch { dict = {}; }
}
export async function setLang(code, redraw) {
  cur = code; try { localStorage.setItem(KEY, code); } catch { /* private mode */ }
  await loadDict(code); document.documentElement.lang = code;
  if (redraw) redraw();
}
// product / option names from the catalog's translations
export function trName(catalog, kind, id, field, fallback) {
  if (cur === 'th') return fallback;
  const x = (((catalog && catalog.translations) || {})[kind] || {})[id];
  return (x && x[cur] && x[cur][field]) || fallback;
}
// a small 🌐 menu: flag + language name
export function langPicker(h, redraw, style = {}) {
  const sel = h('select', { class: 'lang-pick', 'aria-label': 'Language', style: { font: 'inherit', padding: '.35em .5em', borderRadius: '10px', border: '1px solid rgb(0 0 0 / .15)', background: 'rgb(255 255 255 / .9)', color: '#222', ...style },
    onchange: () => setLang(sel.value, redraw) }, LANGS.map(([c, n, f]) => h('option', { value: c, selected: c === cur }, `${f} ${n}`)));
  return sel;
}
