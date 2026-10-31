// "Which product is this?" for photos sent in LINE: read a barcode in the photo, or compare the photo with the
// product pictures in the shop (a small fingerprint of shape + colours), or ask Claude when the shop has set an AI key.
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import ZX from '@zxing/library';
import Anthropic from '@anthropic-ai/sdk';
import { db } from '../db.js';
import { AI_MODEL, aiKeys } from './productai.js';

export function decodeImage(buf, mime = '') {
  try {
    if (/png/.test(mime) || (buf[0] === 0x89 && buf[1] === 0x50)) { const p = PNG.sync.read(buf); return { width: p.width, height: p.height, data: p.data }; }
    if (/jpe?g/.test(mime) || (buf[0] === 0xff && buf[1] === 0xd8)) { const j = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 256 }); return { width: j.width, height: j.height, data: j.data }; }
  } catch { /* not an image we can read */ }
  return null;
}
// grey copy, scaled so the longer side is at most `max` (box sampling), optionally turned 90°
function grey(img, max, rotate = false) {
  const k = Math.min(1, max / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = Math.min(img.width - 1, Math.floor(x / k)), sy = Math.min(img.height - 1, Math.floor(y / k)), i = (sy * img.width + sx) * 4;
    out[y * w + x] = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
  }
  if (!rotate) return { w, h, g: out };
  const r = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) r[x * h + (h - 1 - y)] = out[y * w + x];
  return { w: h, h: w, g: r };
}
export function readBarcode(img) {
  const reader = new ZX.MultiFormatReader();
  const hints = new Map();
  hints.set(ZX.DecodeHintType.TRY_HARDER, true);
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF, ZX.BarcodeFormat.QR_CODE]);
  reader.setHints(hints);
  for (const max of [1200, 800, 1800]) for (const rot of [false, true]) {
    try {
      const { w, h, g } = grey(img, max, rot);
      return reader.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.RGBLuminanceSource(g, w, h)))).getText();
    } catch { /* not found at this size / turn */ }
  }
  return null;
}

// fingerprint: 64-bit difference hash of the shape + average colour of a 4×4 grid (centre-cropped square)
export function fingerprint(img) {
  const side = Math.min(img.width, img.height), ox = (img.width - side) >> 1, oy = (img.height - side) >> 1;
  const at = (fx, fy) => { const x = Math.min(img.width - 1, ox + Math.floor(fx * side)), y = Math.min(img.height - 1, oy + Math.floor(fy * side)); const i = (y * img.width + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
  const avg = (x0, y0, x1, y1) => { let r = 0, g = 0, b = 0, n = 0; for (let y = y0; y < y1; y += (y1 - y0) / 6) for (let x = x0; x < x1; x += (x1 - x0) / 6) { const p = at(x, y); r += p[0]; g += p[1]; b += p[2]; n++; } return [r / n, g / n, b / n]; };
  const gray = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 9; x++) { const p = avg(x / 9, y / 8, (x + 1) / 9, (y + 1) / 8); gray.push(p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114); }
  const bits = []; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits.push(gray[y * 9 + x] > gray[y * 9 + x + 1] ? 1 : 0);
  const col = []; for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) col.push(...avg(x / 4, y / 4, (x + 1) / 4, (y + 1) / 4));
  return { bits, col };
}
export function similarity(a, b) {
  let ham = 0; for (let i = 0; i < 64; i++) if (a.bits[i] !== b.bits[i]) ham++;
  let d = 0; for (let i = 0; i < a.col.length; i++) d += Math.abs(a.col[i] - b.col[i]);
  const colour = 1 - Math.min(1, d / a.col.length / 128);
  return Math.round(((1 - ham / 64) * 0.5 + colour * 0.5) * 100) / 100;
}
// product pictures stored in the shop (JPEG/PNG), fingerprinted once
const prints = new Map();
async function productPrint(url) {
  if (prints.has(url)) return prints.get(url);
  let fp = null;
  const m = /^\/files\/([\w-]+)$/.exec(url || '');
  if (m) {
    const f = await db.get('SELECT data, mime FROM files WHERE id = ?', [m[1]]);
    const img = f && f.data ? decodeImage(Buffer.from(f.data, 'base64'), f.mime) : null;
    if (img) fp = fingerprint(img);
  }
  prints.set(url, fp);
  return fp;
}
export async function similarProducts(img, limit = 3) {
  const fp = fingerprint(img);
  const prods = await db.all("SELECT id, name, image FROM products WHERE active = 1 AND image IS NOT NULL AND image <> ''");
  const out = [];
  for (const p of prods) { const q = await productPrint(p.image); if (q) out.push({ id: p.id, name: p.name, score: similarity(fp, q) }); }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// Claude picks which of the shop's products the photo shows (only when the shop set an AI key)
export async function aiMatch(buf, mime) {
  const key = (await aiKeys()).anthropic;
  if (!key) return null;
  const prods = await db.all('SELECT id, name, code FROM products WHERE active = 1 ORDER BY name');
  if (!prods.length) return null;
  const client = new Anthropic({ apiKey: key, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 45000, maxRetries: 1 });
  const res = await client.beta.messages.create({
    model: AI_MODEL, max_tokens: 600, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: { type: 'object', additionalProperties: false, required: ['index', 'confidence', 'barcode'],
      properties: { index: { type: 'integer', description: 'number of the matching product in the list, or -1 if none matches' }, confidence: { type: 'number', description: '0 to 1' }, barcode: { type: 'string', description: 'barcode digits if readable in the photo, else empty' } } } } },
    messages: [{ role: 'user', content: [
      { type: 'image', source: { type: 'base64', media_type: /png/.test(mime) ? 'image/png' : 'image/jpeg', data: buf.toString('base64') } },
      { type: 'text', text: `A shop owner photographed an item to check its stock. Which product in this list is it? Answer -1 if none.\n${prods.map((p, i) => `${i}. ${p.name} (${p.code})`).join('\n')}` }] }],
  });
  const block = res.content.find((b) => b.type === 'text');
  try { const j = JSON.parse(block.text); const p = prods[j.index]; return { product: p ? { id: p.id, name: p.name } : null, confidence: j.confidence, barcode: j.barcode }; } catch { return null; }
}
