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
export const AREAS = { global: 'ทั้งระบบ', pos: 'หน้าขาย POS', display: 'จอลูกค้า', member: 'เว็บไซต์สมาชิก', mobile: 'Mobile Ordering', admin: 'เว็บไซต์จัดการร้าน', reports: 'รายงาน', receipt: 'ใบเสร็จ/เอกสาร', kitchen: 'ใบครัว' };

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
  return [family && `"${family}"`, fallback || "'Sarabun', 'Noto Sans Thai', sans-serif"].filter(Boolean).join(', ');
}
// Apply settings.fonts for an area to the page (CSS variables used by style.css)
export async function applyFonts(settingsFonts, area) {
  const f = settingsFonts || {};
  const fam = f[area] || f.global || 'Sarabun';
  await loadFont(fam);
  const root = document.documentElement.style;
  root.setProperty('--app-font', `"${fam}"`);
  document.body.style.fontFamily = familyCss(fam, f.fallback);
  if (f.size) root.setProperty('--app-size', f.size + 'px');
  if (f.line_height) root.setProperty('--app-lh', f.line_height);
  if (f.letter_spacing) root.setProperty('--app-ls', f.letter_spacing + 'px');
  return fam;
}
