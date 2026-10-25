// Shop theme: preset or custom brand colour, light/dark mode, corner style, text size and POS layout.
// Everything is CSS variables on <html>, so every page (POS, admin, kitchen, member site, mobile ordering) follows it.
export const THEME_PRESETS = {
  gochujang: { name: 'โกชูจัง (แดงส้ม)', brand: '#e8321f', accent: '#ffb35c', deep: '#2b1712' },
  kimchi: { name: 'กิมจิ (แดงเข้ม)', brand: '#c92a2a', accent: '#ff8787', deep: '#2a1010' },
  mango: { name: 'มะม่วง (ส้มเหลือง)', brand: '#e8590c', accent: '#ffd43b', deep: '#2b1a0a' },
  matcha: { name: 'มัทฉะ (เขียว)', brand: '#2f9e44', accent: '#a9e34b', deep: '#10261a' },
  ocean: { name: 'โอเชียน (ฟ้า)', brand: '#1c7ed6', accent: '#66d9e8', deep: '#0d1d33' },
  grape: { name: 'องุ่น (ม่วง)', brand: '#7048e8', accent: '#da77f2', deep: '#1a1333' },
  sakura: { name: 'ซากุระ (ชมพู)', brand: '#e64980', accent: '#ffa8c5', deep: '#2e1220' },
  classic: { name: 'คลาสสิก (ดำ-เทา)', brand: '#343a40', accent: '#adb5bd', deep: '#111315' },
};
export const THEME_DEFAULT = { preset: 'gochujang', brand: '', accent: '', mode: 'auto', radius: 'round', text: 'normal', pos_layout: 'grid', shapes: true, pos_fx: 'normal' };

const hex = (c) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(c || '').trim()); return m ? m[1].toLowerCase() : null; };
const toRgb = (c) => { const h = hex(c) || 'e8321f'; return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)); };
const toHex = (rgb) => '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t)); // t = share of b
const lum = (c) => { const [r, g, b] = toRgb(c).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };

export function themeOf(t) {
  const th = { ...THEME_DEFAULT, ...(t || {}) };
  const p = THEME_PRESETS[th.preset] || THEME_PRESETS.gochujang;
  const brand = hex(th.brand) ? '#' + hex(th.brand) : p.brand;
  const accent = hex(th.accent) ? '#' + hex(th.accent) : th.brand && th.preset === 'custom' ? mix(brand, '#ffd43b', 0.55) : p.accent;
  const deep = th.preset === 'custom' || hex(th.brand) ? mix(brand, '#0b0706', 0.82) : p.deep;
  return { ...th, brandHex: brand, accentHex: accent, deepHex: deep };
}

// CSS variables for a theme in the given mode ('light' | 'dark')
export function themeVars(t, mode = 'light') {
  const { brandHex: b, accentHex: a, deepHex: d, radius, text } = themeOf(t);
  const dark = mode === 'dark';
  const v = {
    '--brand': dark ? mix(b, '#ffffff', 0.12) : b, '--brand-2': mix(b, '#000000', 0.18), '--brand-3': a,
    '--brand-rgb': toRgb(b).join(' '), '--brand-soft': dark ? mix(d, b, 0.22) : mix('#ffffff', b, 0.13),
    '--grad': `linear-gradient(135deg, ${mix(b, a, 0.35)} 0%, ${b} 45%, ${mix(b, '#000000', 0.25)} 100%)`,
    '--grad-warm': `linear-gradient(135deg, ${a} 0%, ${mix(a, b, 0.55)} 55%, ${b} 100%)`,
    '--deep': d, '--deep-2': mix(d, b, 0.12), '--deep-3': mix(d, b, 0.3), '--accent': lum(a) > 0.45 ? a : mix(a, '#ffffff', 0.45),
    '--shadow-rgb': toRgb(mix(d, b, 0.3)).join(' '),
    '--radius': { round: '22px', normal: '14px', square: '6px' }[radius] || '22px',
    '--app-size': { normal: '16px', large: '17.5px', xlarge: '19px' }[text] || '16px',
  };
  if (dark) Object.assign(v, { '--bg': mix(d, '#000000', 0.35), '--surface': mix(d, '#ffffff', 0.06), '--surface2': mix(d, '#ffffff', 0.1), '--line': mix(d, '#ffffff', 0.18),
    '--text': mix('#ffffff', b, 0.06), '--muted': mix('#ffffff', d, 0.4), '--ink': mix('#ffffff', b, 0.06), '--cream': mix(d, '#000000', 0.35) });
  else Object.assign(v, { '--bg': mix('#ffffff', b, 0.035), '--surface': '#ffffff', '--surface2': mix('#ffffff', b, 0.06), '--line': mix('#ffffff', mix(b, '#6b6b6b', 0.5), 0.16),
    '--text': d, '--muted': mix(d, '#ffffff', 0.45), '--ink': d, '--cream': mix('#ffffff', b, 0.035) });
  return v;
}

let mq = null, current = null;
// Apply a theme to this page. Pages call it at boot and again when settings change.
export function applyTheme(t) {
  current = t || null;
  const root = document.documentElement;
  if (!t || !Object.keys(t).length) { // shop never picked a theme: keep the built-in look
    for (const k of Object.keys(themeVars({}))) root.style.removeProperty(k);
    for (const k of ['theme', 'radius', 'posLayout', 'shapes']) delete root.dataset[k];
    return;
  }
  const th = themeOf(t);
  const want = th.mode === 'dark' ? 'dark' : th.mode === 'light' ? 'light' : (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  root.dataset.theme = want;
  root.dataset.radius = th.radius;
  root.dataset.posLayout = th.pos_layout;
  root.dataset.shapes = th.shapes === false ? 'off' : 'on';
  for (const [k, val] of Object.entries(themeVars(th, want))) root.style.setProperty(k, val);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', th.brandHex);
  if (th.mode === 'auto' && !mq) { mq = matchMedia('(prefers-color-scheme: dark)'); mq.addEventListener('change', () => applyTheme(current)); }
}
