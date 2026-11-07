import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFilter, toGray, dither, DITHERS, FILTERS } from '../public/photo/thermal.js';

const ramp = (w = 64, h = 16) => { const d = new Uint8ClampedArray(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = (y * w + x) * 4, v = Math.round((x / (w - 1)) * 255); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; } return { data: d, width: w, height: h }; };

test('ภาพขาวดำสำหรับเครื่องพิมพ์ใบเสร็จ: ทุกวิธีให้แค่จุดดำ/ขาว และความเข้มตามภาพจริง', () => {
  for (const m of DITHERS) {
    const bits = dither(toGray(ramp()), m);
    assert.ok(bits.every((b) => b === 0 || b === 255), m);
    const dark = (x0, x1) => { let n = 0, t = 0; for (let y = 0; y < 16; y++) for (let x = x0; x < x1; x++) { t++; if (!bits[y * 64 + x]) n++; } return n / t; };
    assert.ok(dark(0, 16) > dark(48, 64), `${m}: ซ้ายมืดกว่าขวา`);
    if (m !== 'threshold') assert.ok(dark(24, 40) > 0.2 && dark(24, 40) < 0.8, `${m}: กลางภาพเป็นลายจุดสีเทา`);
  }
});
test('ปรับความสว่าง/คอนทราสต์ และฟิลเตอร์ไม่ทำภาพพัง', () => {
  const g0 = toGray(ramp()).g, g1 = toGray(ramp(), { brightness: 30 }).g;
  assert.ok(g1[10] > g0[10]);
  for (const f of FILTERS) { const im = applyFilter(ramp(), f); assert.equal(im.data.length, 64 * 16 * 4); assert.ok(im.data.every((v) => v >= 0 && v <= 255)); }
});
