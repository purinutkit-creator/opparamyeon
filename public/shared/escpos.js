// ESC/POS encoder: canvas → raster image (GS v 0) + paper feed / cut / buzzer commands.
// Raster printing keeps Thai shaping and custom fonts identical to the preview on printers without Thai code pages.
export const ESC = 0x1b, GS = 0x1d, DLE = 0x10;

export function rasterFromCanvas(canvas, { threshold = 160, y0 = 0, y1 = canvas.height } = {}) {
  const w = canvas.width, h = y1 - y0;
  const bytesPerRow = Math.ceil(w / 8);
  const px = canvas.getContext('2d').getImageData(0, y0, w, h).data;
  const out = [];
  // send in bands of ≤ 256 rows: many printers have a small receive buffer for GS v 0
  for (let band = 0; band < h; band += 256) {
    const bh = Math.min(256, h - band);
    const head = [GS, 0x76, 0x30, 0x00, bytesPerRow & 0xff, bytesPerRow >> 8, bh & 0xff, bh >> 8];
    const body = new Uint8Array(bytesPerRow * bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < w; x++) {
      const i = ((band + y) * w + x) * 4;
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      if (px[i + 3] > 128 && lum < threshold) body[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
    out.push(Uint8Array.from(head), body);
  }
  return concat(out);
}
export function concat(parts) {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
export const init = () => Uint8Array.from([ESC, 0x40]);
export const feed = (lines) => Uint8Array.from([ESC, 0x64, Math.max(0, Math.min(255, lines | 0))]);
// GS V 0 = full cut, GS V 1 = partial cut (only on printers that support it)
export const cut = (mode = 'full') => (mode === 'none' ? new Uint8Array() : Uint8Array.from([GS, 0x56, mode === 'partial' ? 0x01 : 0x00]));
// ESC B n t: buzzer on Epson-compatible printers with a beeper (Xprinter/Rongta models with buzzer). Ignored by others.
export const beep = (times = 4, dur = 2) => Uint8Array.from([ESC, 0x42, Math.min(9, times), Math.min(9, dur)]);
// DLE EOT n — real-time status. n=1 printer, 2 offline cause, 4 paper sensor
export const statusQuery = (n = 4) => Uint8Array.from([DLE, 0x04, n]);
export function parseStatus(n, byte) {
  if (byte === undefined) return { known: false };
  if (n === 4) return { known: true, paperOut: (byte & 0x60) === 0x60, paperNearEnd: (byte & 0x0c) === 0x0c };
  if (n === 2) return { known: true, coverOpen: !!(byte & 0x04), paperOut: !!(byte & 0x20), error: !!(byte & 0x40) };
  return { known: true, online: !(byte & 0x08) };
}

// ESC p m t1 t2: pulse the cash drawer (pin 2 or pin 5)
export const drawer = (pin = 0) => Uint8Array.from([ESC, 0x70, pin ? 1 : 0, 25, 250]);

// Build the full byte stream for one document: segments split at template "cut" points

export function buildJob(canvas, { cuts = [], feedBefore = 3, feedAfter = 1, cutMode = 'full', buzzer = false, beepCount = 4, beepDuration = 2, threshold = 160, topFeed = 0 } = {}) {
  const parts = [init()];
  if (topFeed) parts.push(feed(topFeed));
  const bounds = [0, ...cuts.filter((y) => y > 0 && y < canvas.height), canvas.height];
  for (let i = 0; i < bounds.length - 1; i++) {
    parts.push(rasterFromCanvas(canvas, { y0: bounds[i], y1: bounds[i + 1], threshold }));
    parts.push(feed(feedBefore), cut(cutMode));
  }
  if (feedAfter) parts.push(feed(feedAfter));
  if (buzzer) parts.push(beep(beepCount, beepDuration));
  return concat(parts);
}

// ESC J n: feed exactly n dots (8 dots = 1 mm at 203 dpi); longer feeds are sent in pieces
export const feedDots = (dots) => { const out = []; let n = Math.max(0, Math.round(dots)); while (n > 0) { const k = Math.min(255, n); out.push(Uint8Array.from([ESC, 0x4a, k])); n -= k; } return concat(out); };
// GS V 65/66 0: feed just to the cutter, then cut (no extra blank paper)
export const feedCut = (mode = 'full') => (mode === 'none' ? new Uint8Array() : Uint8Array.from([GS, 0x56, mode === 'partial' ? 0x42 : 0x41, 0]));

// Barcode labels: exactly the labels and the gaps set, nothing before them; rows split at "cut" points are cut at the cutter.
// end: 'cut' (feed to the cutter + cut, if the printer has one), 'feed' (endDots of paper to tear off), 'none'
export function buildLabelJob(canvas, { cuts = [], cutMode = 'full', end = 'cut', endDots = 0, threshold = 160 } = {}) {
  const parts = [init()];
  const bounds = [0, ...cuts.filter((y) => y > 0 && y < canvas.height), canvas.height];
  for (let i = 0; i < bounds.length - 1; i++) {
    parts.push(rasterFromCanvas(canvas, { y0: bounds[i], y1: bounds[i + 1], threshold }));
    if (i < bounds.length - 2 && cutMode !== 'none') parts.push(feedCut(cutMode));
  }
  if (end === 'cut' && cutMode !== 'none') parts.push(feedCut(cutMode));
  else if (end !== 'none' && endDots > 0) parts.push(feedDots(endDots));
  return concat(parts);
}
