import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';
import { openState, cleanWeb } from '../server/routes/system.js';

let S, owner;
before(async () => { S = await startServer(); owner = await S.login(); });
after(async () => { await S.close(); });

const H = (o, c, closed = false) => Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open: o, close: c, closed }]));
// 2026-11-02 is a Monday; Bangkok = UTC+7
const at = (hhmm, day = '2026-11-02') => new Date(`${day}T${hhmm}:00+07:00`);

test('เว็บไซต์ร้าน: เปิดอยู่/ปิดอยู่ตามเวลาไทย รวมเปิดข้ามเที่ยงคืน', () => {
  assert.deepEqual(openState(H('10:00', '21:00'), at('12:00')), { open: true, until: '21:00', day: 1 });
  assert.equal(openState(H('10:00', '21:00'), at('21:00')).open, false, 'ปิดตรงเวลาปิด');
  assert.deepEqual(openState(H('10:00', '21:00'), at('08:00')), { open: false, next: '10:00', next_day: 1, day: 1 }, 'ยังไม่เปิด: เปิดวันนี้');
  assert.equal(openState(H('10:00', '21:00'), at('22:00')).next_day, 2, 'ปิดแล้ว: เปิดพรุ่งนี้');
  assert.deepEqual(openState(H('18:00', '02:00'), at('01:00')), { open: true, until: '02:00', day: 1 }, 'ตี 1 ยังอยู่ในรอบของเมื่อวาน');
  const h = H('10:00', '21:00'); h[2].closed = true;
  assert.equal(openState(h, at('22:00')).next_day, 3, 'ข้ามวันหยุด');
  assert.deepEqual(openState(H('10:00', '21:00', true), at('12:00')), { open: false, day: 1 });
});

test('เว็บไซต์ร้าน: ลิงก์ต้องเป็น http(s) เท่านั้น เวลาผิดรูปแบบใช้ค่าเริ่ม', () => {
  const w = cleanWeb({ facebook: 'javascript:alert(1)', instagram: 'https://instagram.com/oppa', hours: { 1: { open: '25:00', close: '9pm' } } });
  assert.equal(w.facebook, ''); assert.equal(w.instagram, 'https://instagram.com/oppa');
  assert.deepEqual(w.hours[1], { open: '10:00', close: '21:00', closed: false });
});

test('เว็บไซต์ร้าน: ข้อมูลสาธารณะไม่ต้องล็อกอิน มีเมนูเฉพาะที่แสดงลูกค้า ไม่มีต้นทุน/สต็อก ปิดเว็บได้', async () => {
  const save = await S.call('PUT', '/api/settings/web', { value: { tagline: 'ร้อน ๆ', show_prices: false, featured: ['p_r001'], tiktok: 'ftp://x' } }, { token: owner });
  assert.equal(save.status, 200); assert.equal(save.body.tiktok, '');
  const r = await S.call('GET', '/api/public/web');
  assert.equal(r.status, 200);
  assert.equal(r.body.enabled, true); assert.equal(r.body.web.tagline, 'ร้อน ๆ');
  assert.ok(r.body.menu.products.length > 0);
  const p = r.body.menu.products[0];
  assert.equal(p.price, null, 'ซ่อนราคาได้');
  for (const k of ['cost', 'stock', 'recipe', 'low_stock']) assert.equal(p[k], undefined, 'ไม่ส่ง ' + k);
  assert.ok(Array.isArray(p.highlights));
  assert.equal(typeof r.body.open.open, 'boolean');
  assert.equal(r.body.store.tax_id, undefined);
  await S.call('PUT', '/api/settings/web', { value: { enabled: false } }, { token: owner });
  const off = await S.call('GET', '/api/public/web');
  assert.deepEqual(Object.keys(off.body).sort(), ['enabled', 'store']);
  await S.call('PUT', '/api/settings/web', { value: { enabled: true } }, { token: owner });
  assert.equal((await S.call('GET', '/api/public/web')).body.web.tagline, 'ร้อน ๆ', 'บันทึกบางช่องไม่ล้างช่องอื่น');
});
