// Image processing for the photo booth: colour filters, tone controls, and black & white for a thermal printer.
// Works on ImageData-like objects { data: Uint8ClampedArray RGBA, width, height } so it runs in the browser and in tests.

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
export const FILTERS = ['original', 'bw', 'contrast', 'korean', 'vintage', 'retro', 'film', 'soft', 'pixel'];

// colour look (also what the download copy keeps)
export function applyFilter(img, name, amount = 1) {
  const d = img.data, n = d.length, w = img.width, h = img.height;
  const k = Math.max(0, Math.min(1, amount));
  if (name === 'pixel') {
    const b = 6;
    for (let y = 0; y < h; y += b) for (let x = 0; x < w; x += b) {
      const i0 = (y * w + x) * 4;
      for (let yy = y; yy < Math.min(h, y + b); yy++) for (let xx = x; xx < Math.min(w, x + b); xx++) { const i = (yy * w + xx) * 4; d[i] = d[i0]; d[i + 1] = d[i0 + 1]; d[i + 2] = d[i0 + 2]; }
    }
    return img;
  }
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let i = 0; i < n; i += 4) {
    let r = d[i], g = d[i + 1], b = d[i + 2];
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    let R = r, G = g, B = b;
    switch (name) {
      case 'bw': R = G = B = y; break;
      case 'contrast': R = (r - 128) * 1.45 + 128; G = (g - 128) * 1.45 + 128; B = (b - 128) * 1.45 + 128; break;
      case 'korean': R = r * 0.96 + 18; G = g * 0.97 + 14; B = b * 0.95 + 16; R = (R - 128) * 0.9 + 138; G = (G - 128) * 0.9 + 136; B = (B - 128) * 0.9 + 134; break; // bright, soft, creamy
      case 'vintage': R = 0.393 * r + 0.769 * g + 0.189 * b; G = 0.349 * r + 0.686 * g + 0.168 * b; B = 0.272 * r + 0.534 * g + 0.131 * b; R = R * 0.85 + 25; G = G * 0.85 + 22; B = B * 0.85 + 18; break;
      case 'retro': R = (r - 128) * 1.25 + 140; G = (g - 128) * 1.15 + 126; B = (b - 128) * 1.1 + 105; break;
      case 'film': { const gr = rnd() * 38; R = r * 0.9 + 16 + gr; G = g * 0.9 + 14 + gr; B = b * 0.88 + 18 + gr; break; }
      case 'soft': R = r * 0.8 + 45; G = g * 0.8 + 45; B = b * 0.8 + 45; break;
      default: break;
    }
    d[i] = clamp(r + (R - r) * k); d[i + 1] = clamp(g + (G - g) * k); d[i + 2] = clamp(b + (B - b) * k);
  }
  if (name === 'retro' || name === 'vintage') vignette(img, 0.35 * k);
  return img;
}
function vignette(img, s) {
  const d = img.data, w = img.width, h = img.height, cx = w / 2, cy = h / 2, R = Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const f = 1 - s * Math.pow(Math.hypot(x - cx, y - cy) / R, 2), i = (y * w + x) * 4;
    d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
  }
}

// grey levels with brightness / contrast / exposure / gamma, then optional sharpening
export function toGray(img, { brightness = 0, contrast = 0, exposure = 0, gamma = 1, sharpness = 0 } = {}) {
  const { width: w, height: h, data: d } = img;
  const g = new Float32Array(w * h);
  const c = (259 * (contrast * 2.55 + 255)) / (255 * (259 - contrast * 2.55)), ex = Math.pow(2, exposure), inv = 1 / Math.max(0.1, gamma);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    let v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * ex + brightness * 2.55;
    v = c * (v - 128) + 128;
    v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, inv);
    g[p] = v;
  }
  if (sharpness > 0) {
    const out = new Float32Array(g.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) { out[p] = g[p]; continue; }
      const blur = (g[p - 1] + g[p + 1] + g[p - w] + g[p + w]) / 4;
      out[p] = g[p] + (g[p] - blur) * sharpness;
    }
    return { w, h, g: out };
  }
  return { w, h, g };
}

// grey → 1-bit (0 black / 255 white) for the printer. strength scales the diffused error (0 = plain threshold look)
const BAYER = [0, 32, 8, 40, 2, 34, 10, 42, 48, 16, 56, 24, 50, 18, 58, 26, 12, 44, 4, 36, 14, 46, 6, 38, 60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41, 51, 19, 59, 27, 49, 17, 57, 25, 15, 47, 7, 39, 13, 45, 5, 37, 63, 31, 55, 23, 61, 29, 53, 21];
export const DITHERS = ['floyd', 'atkinson', 'bayer', 'threshold'];
export function dither({ w, h, g }, method = 'floyd', { strength = 1, threshold = 128 } = {}) {
  const v = Float32Array.from(g), out = new Uint8ClampedArray(w * h);
  const s = Math.max(0, Math.min(1.2, strength));
  const spread = (x, y, e) => { if (x >= 0 && x < w && y < h) v[y * w + x] += e; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x, old = v[p];
    if (method === 'bayer') { const t = (BAYER[(y % 8) * 8 + (x % 8)] + 0.5) * 4; out[p] = old * s + threshold * (1 - s) > t ? 255 : 0; continue; }
    const nw = old >= threshold ? 255 : 0;
    out[p] = nw;
    if (method === 'threshold') continue;
    const err = (old - nw) * s;
    if (method === 'atkinson') { const e = err / 8; spread(x + 1, y, e); spread(x + 2, y, e); spread(x - 1, y + 1, e); spread(x, y + 1, e); spread(x + 1, y + 1, e); spread(x, y + 2, e); }
    else { spread(x + 1, y, err * 7 / 16); spread(x - 1, y + 1, err * 3 / 16); spread(x, y + 1, err * 5 / 16); spread(x + 1, y + 1, err / 16); }
  }
  return out;
}
// 1-bit levels back into RGBA (for a canvas / PNG)
export function bitsToImageData(bits, w, h, into) {
  const d = into || new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < bits.length; p++, i += 4) { d[i] = d[i + 1] = d[i + 2] = bits[p]; d[i + 3] = 255; }
  return d;
}
