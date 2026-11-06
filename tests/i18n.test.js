import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extract } from '../scripts/i18n-extract.mjs';

test('รายการข้อความหน้าเว็บ/ใบเสร็จสำหรับแปลภาษาเป็นปัจจุบัน (รัน node scripts/i18n-extract.mjs)', () => {
  const file = JSON.parse(readFileSync(new URL('../server/lib/ui-strings.json', import.meta.url), 'utf8'));
  assert.deepEqual(file, extract());
  assert.ok(file.includes('ตะกร้า') && file.includes('ยอดสุทธิ') && file.includes('สมัครสมาชิก'));
});

test('t(): แทนค่า {0} {1} และใช้ภาษาไทยเมื่อยังไม่มีคำแปล', async () => {
  globalThis.navigator ||= { language: 'th-TH' };
  const { t } = await import('../public/shared/i18n.js');
  assert.equal(t('รวม {0} บาท', 25), 'รวม 25 บาท');
  assert.equal(t('ตะกร้า'), 'ตะกร้า');
});
