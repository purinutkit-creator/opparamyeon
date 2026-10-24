// Product barcode labels: one renderer for the admin preview, browser/PDF printing and ESC/POS raster printing.
// Sizes in the config are millimetres (layout) and "points" for text (= printer dots at 203 dpi, scaled for other resolutions).
import { baht, code128, ean13, isEan13 } from './core.js';
import { familyCss } from './fonts.js';
import { wrap } from './render.js';

export const LABEL_DEFAULTS = {
  width_mm: 50, height_mm: 30, cols: 1, gap_mm: 2, padding_mm: 1.5, font: 'Sarabun', align: 'center',
  show_store: false, show_name: true, show_price: true, show_digits: true, show_code: false, custom_text: '',
  store_size: 16, name_size: 24, name_weight: 700, name_lines: 2, price_size: 34, text_size: 18, digits_size: 18,
  barcode_height_mm: 12, bar_width: 2, type: 'auto', border: false, price_prefix: '', price_suffix: ' ฿', cut_each: false, feed_mm: 2,
};
export const LABEL_PRESETS = [['50x30', 'สติกเกอร์ 50 × 30 มม.'], ['40x30', 'สติกเกอร์ 40 × 30 มม.'], ['50x25', 'สติกเกอร์ 50 × 25 มม.'], ['60x40', 'สติกเกอร์ 60 × 40 มม.'],
  ['32x25', 'สติกเกอร์เล็ก 32 × 25 มม.'], ['48x30', 'กระดาษใบเสร็จ 58 มม. (48 × 30)'], ['72x40', 'กระดาษใบเสร็จ 80 มม. (72 × 40)']];
export const labelCfg = (c) => ({ ...LABEL_DEFAULTS, ...(c || {}) });

export function barcodeModules(value, type = 'auto') {
  const v = String(value || '');
  if (!v) return null;
  if (type === 'ean13' || (type === 'auto' && isEan13(v))) return { kind: 'EAN-13', mods: ean13(v) };
  return { kind: 'Code128', mods: code128(v) };
}

// size of one row of labels in device dots
export function labelRowDots(cfg, dpm = 8) {
  const c = labelCfg(cfg);
  const cols = Math.max(1, Math.min(4, Number(c.cols) || 1));
  return { w: Math.round((cols * c.width_mm + (cols - 1) * c.gap_mm) * dpm), h: Math.round(c.height_mm * dpm), cols };
}

// Draw one label with its top-left corner at (x, y). Returns warnings (empty when everything fits).
export function drawLabel(ctx, x, y, cfg, item, dpm = 8) {
  const c = labelCfg(cfg);
  const k = dpm / 8; // text sizes are given for 203 dpi
  const W = Math.round(c.width_mm * dpm), H = Math.round(c.height_mm * dpm), pad = Math.round(c.padding_mm * dpm);
  const innerW = W - pad * 2;
  const warnings = [];
  const font = (size, weight = 400) => { ctx.font = `${weight} ${Math.round(size * k)}px ${familyCss(c.font)}`; };
  const lh = (size) => Math.round(size * k * 1.25);
  // blocks measured first, then the barcode takes whatever height is left (up to its setting)
  const blocks = [];
  const textBlock = (str, size, weight, maxLines = 3) => {
    if (!str) return;
    font(size, weight);
    let lines = wrap(ctx, str, innerW);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/.$/u, '…'); }
    blocks.push({ kind: 'text', lines, size, weight, h: lines.length * lh(size) });
  };
  if (c.show_store) textBlock(item.store, c.store_size, 600, 1);
  if (c.show_name) textBlock(item.name, c.name_size, c.name_weight, Number(c.name_lines) || 2);
  let bc = null;
  const value = item.barcode || item.code;
  try { bc = barcodeModules(value, c.type); } catch { warnings.push(`บาร์โค้ด "${value}" ใช้กับชนิดที่เลือกไม่ได้ — ใช้ตัวอักษรอังกฤษ/ตัวเลข หรือ EAN-13 ที่ถูกต้อง`); }
  if (bc) blocks.push({ kind: 'barcode', h: 0 });
  if (bc && c.show_digits) { font(c.digits_size, 400); blocks.push({ kind: 'text', lines: [String(value)], size: c.digits_size, weight: 400, h: lh(c.digits_size), digits: true }); }
  const priceText = c.show_price && item.price !== undefined && item.price !== null ? `${c.price_prefix || ''}${baht(item.price)}${c.price_suffix || ''}` : '';
  const codeText = c.show_code && item.code ? item.code : '';
  if (priceText || codeText) blocks.push({ kind: 'price', h: lh(Math.max(priceText ? c.price_size : 0, codeText ? c.text_size : 0)), priceText, codeText });
  if (c.custom_text) textBlock(c.custom_text, c.text_size, 400, 2);
  const gap = Math.round(0.6 * dpm);
  const fixed = blocks.reduce((s, b) => s + b.h, 0) + gap * Math.max(0, blocks.length - 1);
  const free = H - pad * 2 - fixed;
  const bh = bc ? Math.min(Math.round(c.barcode_height_mm * dpm), Math.max(0, free)) : 0;
  if (bc && bh < 4 * dpm) warnings.push('พื้นที่ไม่พอสำหรับบาร์โค้ด — ลดขนาดตัวอักษร ปิดบางข้อมูล หรือเพิ่มความสูงฉลาก');
  if (fixed > H - pad * 2) warnings.push('ข้อมูลยาวเกินฉลาก — ลดขนาดตัวอักษรหรือจำนวนบรรทัดชื่อ');
  const total = fixed + bh;
  let cy = y + pad + Math.max(0, Math.round((H - pad * 2 - total) / 2));
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, W, H); ctx.clip();
  ctx.fillStyle = '#fff'; ctx.fillRect(x, y, W, H);
  ctx.fillStyle = '#000'; ctx.textBaseline = 'top';
  const ax = (tw) => (c.align === 'left' ? x + pad : c.align === 'right' ? x + W - pad - tw : x + (W - tw) / 2);
  for (const b of blocks) {
    if (b.kind === 'text') {
      font(b.size, b.weight);
      for (const ln of b.lines) { const tw = ctx.measureText(ln).width; ctx.fillText(ln, b.digits ? x + (W - tw) / 2 : ax(tw), cy + (lh(b.size) - b.size * k) / 2); cy += lh(b.size); }
    } else if (b.kind === 'barcode') {
      const quiet = bc.kind === 'EAN-13' ? 9 : 10; // quiet zone in modules on each side
      const totalMods = bc.mods.reduce((a, m) => a + m, 0) + quiet * 2;
      const want = Math.max(1, Math.round(Number(c.bar_width) * k));
      const mw = Math.max(1, Math.min(want, Math.floor(innerW / totalMods)));
      if (Math.floor(innerW / totalMods) < Math.max(1, Math.round(k))) warnings.push('บาร์โค้ดยาวเกินความกว้างฉลาก — อาจสแกนไม่ได้ ใช้ฉลากที่กว้างขึ้นหรือรหัสที่สั้นลง');
      const bw = (totalMods - quiet * 2) * mw;
      let bx = Math.round(x + (W - bw) / 2);
      bc.mods.forEach((m, i) => { if (i % 2 === 0) ctx.fillRect(bx, cy, m * mw, bh); bx += m * mw; });
      cy += bh;
    } else if (b.kind === 'price') {
      if (b.codeText && b.priceText) {
        font(c.text_size, 400); ctx.fillText(b.codeText, x + pad, cy + (b.h - c.text_size * k) / 2);
        font(c.price_size, 800); const tw = ctx.measureText(b.priceText).width; ctx.fillText(b.priceText, x + W - pad - tw, cy + (b.h - c.price_size * k) / 2);
      } else {
        const t = b.priceText || b.codeText, size = b.priceText ? c.price_size : c.text_size;
        font(size, b.priceText ? 800 : 400); const tw = ctx.measureText(t).width; ctx.fillText(t, ax(tw), cy + (b.h - size * k) / 2);
      }
      cy += b.h;
    }
    cy += gap;
  }
  ctx.restore();
  if (c.border) { ctx.strokeStyle = '#000'; ctx.lineWidth = Math.max(1, Math.round(0.25 * dpm)); ctx.strokeRect(x + ctx.lineWidth / 2, y + ctx.lineWidth / 2, W - ctx.lineWidth, H - ctx.lineWidth); }
  return warnings;
}

// One row of labels (multi-column sticker rolls) on a fresh canvas
export function renderLabelRow(cfg, items, dpm = 8, canvas = document.createElement('canvas')) {
  const c = labelCfg(cfg);
  const { w, h } = labelRowDots(c, dpm);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  const warnings = [];
  items.forEach((it, i) => { if (it) warnings.push(...drawLabel(ctx, Math.round(i * (c.width_mm + c.gap_mm) * dpm), 0, c, it, dpm)); });
  return { canvas, warnings: [...new Set(warnings)] };
}
