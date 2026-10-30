// Font center: Google Fonts + uploaded fonts, per-area assignment with Thai fallback.
export const GOOGLE_FONTS = [
  // Thai-capable
  ['Sarabun', true], ['Noto Sans Thai', true], ['Noto Sans Thai Looped', true], ['Noto Serif Thai', true], ['IBM Plex Sans Thai', true], ['IBM Plex Sans Thai Looped', true],
  ['Prompt', true], ['Kanit', true], ['Mitr', true], ['Anuphan', true], ['Bai Jamjuree', true], ['Chakra Petch', true], ['K2D', true], ['Krub', true], ['KoHo', true],
  ['Kodchasan', true], ['Niramit', true], ['Mali', true], ['Athiti', true], ['Pridi', true], ['Taviraj', true], ['Trirong', true], ['Maitree', true], ['Chonburi', true],
  ['Itim', true], ['Pattaya', true], ['Sriracha', true], ['Charm', true], ['Charmonman', true], ['Fahkwang', true], ['Thasadith', true], ['Srisakdi', true],
  // Korean / Latin (no Thai — fallback is used for Thai letters)
  ['Noto Sans KR', false], ['Black Han Sans', false], ['Do Hyeon', false], ['Jua', false], ['Gowun Dodum', false], ['Inter', false], ['Roboto', false], ['Poppins', false],
];
export const SAMPLE = 'มาม่าเกาหลี ต๊อกบกกี ชีสยืด ๆ ฿1,234.50 — Ramyeon 라면 0123456789 !@#%&*()';
export const AREAS = { global: 'ทั้งระบบ', pos: 'หน้าขาย POS', display: 'จอลูกค้า', kitchen_screen: 'จอครัว', staff_card: 'บัตรพนักงาน', member: 'เว็บไซต์สมาชิก', mobile: 'Mobile Ordering', admin: 'เว็บไซต์จัดการร้าน', reports: 'รายงาน', receipt: 'ใบเสร็จ/เอกสารที่พิมพ์', kitchen: 'ใบครัวที่พิมพ์' };
// each area has a body font and a heading/big-number font; with split_lang on, Thai and English letters can use different fonts
export const FONT_ROLES = { '': 'ตัวอักษรทั่วไป', _head: 'หัวข้อ / ตัวเลขใหญ่' };
const PRINT_AREAS = ['receipt', 'kitchen'];

const loaded = new Map();
let fontList = null;
export async function fontCatalog(force = false) {
  if (!fontList || force) fontList = await fetch('/api/fonts').then((r) => r.json()).catch(() => []);
  return fontList;
}
// Load a family by name: uploaded fonts (FontFace) first, then Google Fonts. Resolves even on failure (fallback is used).
export async function loadFont(family, weights = [400, 700]) {
  if (!family) return false;
  const key = family + weights.join();
  if (loaded.has(key)) return loaded.get(key);
  const p = (async () => {
    const list = await fontCatalog();
    const up = list.find((f) => f.family === family && f.source === 'upload');
    try {
      if (up) {
        const ff = new FontFace(family, `url(/files/${up.file_id})`, { weight: '100 900' });
        await ff.load(); document.fonts.add(ff);
        return true;
      }
      const g = list.find((f) => f.family === family && f.source === 'google');
      const ws = g ? JSON.parse(g.weights || '[400,700]') : weights;
      const href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${[...new Set(ws)].sort((a, b) => a - b).join(';')}&display=swap`;
      if (!document.querySelector(`link[data-font="${family}"]`)) {
        const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = href; l.dataset.font = family; document.head.append(l);
        await new Promise((res) => { l.onload = res; l.onerror = res; setTimeout(res, 4000); });
      }
      await Promise.race([document.fonts.load(`400 20px "${family}"`, 'กขค Aa'), new Promise((r) => setTimeout(r, 3000))]);
      return document.fonts.check(`400 20px "${family}"`);
    } catch { return false; }
  })();
  loaded.set(key, p);
  return p;
}
// Does the family really contain Thai glyphs? Compare text width against two different fallbacks.
export function hasThai(family) {
  const c = document.createElement('canvas').getContext('2d');
  const txt = 'กขฃคฅฆงจฉชซฌญฎฏ่้๊๋ำ';
  const w = (f) => { c.font = `40px ${f}`; return c.measureText(txt).width; };
  // with Thai glyphs both stacks render with the family itself; without them they fall back to different fonts
  const a = w(`"${family}", monospace`), b = w(`"${family}", serif`);
  return a === b && a !== w('monospace');
}
export function familyCss(family, fallback) {
  // an already built stack ("A EN", "B TH") is used as it is
  const fam = family && (/^["']/.test(family) || family.includes(',') ? family : `"${family}"`);
  return [fam, fallback || "'Sarabun', 'Noto Sans Thai', sans-serif"].filter(Boolean).join(', ');
}

// ---- Thai / English split: a copy of each font limited to its script (unicode-range), under its own name ----
const THAI_RANGE = 'U+0E00-0E7F', OTHER_RANGE = 'U+0000-0DFF, U+0E80-FFFF';
const subsets = new Map();
async function subsetFamily(family, part) {
  const alias = `${family} ${part === 'thai' ? 'TH' : 'EN'}`;
  if (subsets.has(alias)) return subsets.get(alias);
  const p = (async () => {
    const list = await fontCatalog();
    const up = list.find((f) => f.family === family && f.source === 'upload');
    try {
      if (up) {
        const ff = new FontFace(alias, `url(/files/${up.file_id})`, { weight: '100 900', unicodeRange: part === 'thai' ? THAI_RANGE : OTHER_RANGE });
        await ff.load(); document.fonts.add(ff); return alias;
      }
      const g = list.find((f) => f.family === family && f.source === 'google');
      const ws = g ? JSON.parse(g.weights || '[400,700]') : [300, 400, 500, 600, 700, 800];
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family).replace(/%20/g, '+')}:wght@${[...new Set(ws)].sort((a, b) => a - b).join(';')}&display=swap`;
      const css = await fetch(url).then((r) => r.text());
      // Google labels every @font-face with its subset (/* thai */, /* latin */ …): keep only the script we want
      const blocks = [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*\{[^}]*\})/g)].map((m) => ({ sub: m[1], css: m[2] }));
      const keep = blocks.filter((b) => (part === 'thai' ? b.sub === 'thai' : b.sub !== 'thai'));
      const use = keep.length ? keep : blocks;
      // each subset keeps its own unicode-range, so the EN copy simply has no Thai letters and the TH copy only Thai
      const out = use.map((b) => b.css.replace(/font-family:\s*['"][^'"]+['"]/, `font-family: '${alias}'`)).join('\n');
      const st = document.createElement('style'); st.dataset.fontAlias = alias; st.textContent = out; document.head.append(st);
      await Promise.race([document.fonts.load(`400 20px "${alias}"`, part === 'thai' ? 'กขค' : 'Aa1'), new Promise((r) => setTimeout(r, 3000))]);
      return alias;
    } catch { return null; }
  })();
  subsets.set(alias, p);
  return p;
}
// the CSS font list for an area and role ('' body, '_head' headings); null when nothing is set for it
export async function fontStack(f, area, role = '') {
  f = f || {};
  const th = f[area + role] || (PRINT_AREAS.includes(area) ? '' : f['global' + role]) || '';
  const en = f.split_lang ? f[area + role + '_en'] || (PRINT_AREAS.includes(area) ? '' : f['global' + role + '_en']) || '' : '';
  if (en && th && en !== th) {
    const [a, b] = await Promise.all([subsetFamily(en, 'latin'), subsetFamily(th, 'thai')]);
    if (a && b) return `"${a}", "${b}"`;
  }
  if (en && !th) { await loadFont(en); return `"${en}"`; }
  if (!th) return null;
  await loadFont(th);
  return `"${th}"`;
}
// printed documents (canvas): the font chosen for ใบเสร็จ / ใบครัว overrides the template's base font
let docFonts = null;
export const docFontStack = (docType) => (docFonts ? fontStack(docFonts, docType === 'kitchen' ? 'kitchen' : 'receipt') : Promise.resolve(null));
// Apply settings.fonts for an area to the page (CSS variables used by style.css)
export async function applyFonts(settingsFonts, area) {
  const f = settingsFonts || {};
  docFonts = f;
  const [body, head] = await Promise.all([fontStack(f, area), fontStack(f, area, '_head')]);
  const fam = body || '"Sarabun"';
  const root = document.documentElement.style;
  root.setProperty('--app-font', fam);
  if (head) root.setProperty('--app-head', head); else root.removeProperty('--app-head');
  document.body.style.fontFamily = familyCss(fam, f.fallback);
  if (f.size) root.setProperty('--app-size', f.size + 'px');
  if (f.line_height) root.setProperty('--app-lh', f.line_height);
  if (f.letter_spacing) root.setProperty('--app-ls', f.letter_spacing + 'px');
  return fam;
}
