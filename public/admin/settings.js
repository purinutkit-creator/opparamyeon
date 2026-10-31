import { h, toast, errToast, modal, fmtTime, JOB_TH } from '/shared/ui.js';
import { baht } from '/shared/core.js';
import { GOOGLE_FONTS, SAMPLE, AREAS, loadFont, hasThai, fontCatalog, familyCss, fontStack } from '/shared/fonts.js';
import { api, ctx, can, page, card, form, table, saveBtn, upload } from './common.js';
import { DISPLAY_TEXTS, DISPLAY_STYLE_DEFAULTS } from '/shared/displaytexts.js';

const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const saveKey = async (key, value, reason) => { const v = await api.put('/settings/' + key, { value, reason }); ctx.settings[key] = v; return v; };

export async function settingsPage() {
  const s = await api.get('/settings');
  ctx.settings = s;
  const store = form([{ k: 'name', label: 'ชื่อร้าน' }, { k: 'branch', label: 'สาขา' }, { k: 'phone', label: 'เบอร์โทร' }, { k: 'tax_id', label: 'เลขผู้เสียภาษี' }, { k: 'address', label: 'ที่อยู่', type: 'textarea', wide: true },
    { k: 'footer', label: 'ข้อความท้ายบิล', wide: true }, { k: 'contact_line', label: 'LINE ID / ช่องทางติดต่อ' }, { k: 'logo', label: 'โลโก้', type: 'image' }], s.store);
  const sale = form([{ k: 'tax_rate', label: 'VAT %', type: 'number' }, { k: 'tax_inclusive', label: 'ราคารวม VAT แล้ว', type: 'bool' }, { k: 'packaging_fee', label: 'ค่าบรรจุภัณฑ์กลับบ้าน (บาท)', type: 'money' },
    { k: 'packaging_mode', label: 'คิดค่าบรรจุภัณฑ์', type: 'select', options: [['per_bowl', 'ต่อชามกลับบ้าน'], ['per_order', 'ต่อออเดอร์ที่มีกลับบ้าน']] },
    { k: 'kitchen_send', label: 'ส่งครัว', type: 'select', options: [['after_payment', 'อัตโนมัติหลังรับชำระ'], ['manual', 'พนักงานกดส่งครัวก่อนชำระได้ (ที่ยังไม่ส่งจะส่งตอนชำระ)']] },
    { k: 'count_unit', label: 'ชื่อหน่วยที่นับ (แทนคำว่า "ชาม")', placeholder: 'ชาม / จาน / ที่ / แก้ว', hint: 'ใช้ในหน้าขาย ใบครัว ใบเสร็จ จอลูกค้า และรายงาน' }], s.sale);
  const pm = s.sale.payment_methods.map((m) => ({ ...m }));
  const pmBox = h('div', {}, pm.map((m) => { const cb = h('input', { type: 'checkbox', checked: m.enabled }); const n = h('input', { class: 'input', value: m.name, style: { maxWidth: '220px' } }); cb.onchange = () => (m.enabled = cb.checked); n.oninput = () => (m.name = n.value);
    return h('div', { class: 'row', style: { marginBottom: '.3em' } }, h('label', { class: 'switch' }, cb, m.id), n); }), h('button', { class: 'btn sm', onclick: () => { const id = prompt('รหัสช่องทาง (ภาษาอังกฤษ) เช่น truemoney'); if (id) { pm.push({ id, name: id, enabled: true }); reload(); } } }, '+ ช่องทางอื่น'));
  const disc = form([{ k: 'cashier', label: 'แคชเชียร์ ส่วนลดสูงสุด %', type: 'number' }, { k: 'manager', label: 'ผู้จัดการ %', type: 'number' }, { k: 'owner', label: 'เจ้าของ %', type: 'number' }], s.sale.max_discount_pct);
  const queue = form([{ k: 'enabled', label: 'ใช้เลขคิว', type: 'bool' }, { k: 'digits', label: 'จำนวนหลัก (3=001)', type: 'number' }, { k: 'start', label: 'เริ่มที่เลข', type: 'number' }, { k: 'separate', label: 'แยกคิวทานที่ร้าน/กลับบ้าน', type: 'bool' },
    { k: 'dine_in_prefix', label: 'ตัวนำหน้า ทานที่ร้าน' }, { k: 'takeaway_prefix', label: 'ตัวนำหน้า กลับบ้าน' }, { k: 'prefix', label: 'ตัวนำหน้า (ไม่แยก)' },
    { k: 'mixed_series', label: 'บิลที่มีทั้งสองแบบใช้คิว', type: 'select', options: [['dine_in', 'ทานที่ร้าน'], ['takeaway', 'กลับบ้าน']] },
    { k: 'scope', label: 'ชุดเลขคิว', type: 'select', options: [['shared', 'ใช้ร่วมกันทุกเครื่อง'], ['terminal', 'แยกตามเครื่องขาย']] },
    { k: 'reset', label: 'รีเซ็ตเลขคิว', type: 'select', options: [['business_day', 'ทุกวันขาย'], ['shift', 'ทุกรอบการขาย'], ['manual', 'สั่งรีเซ็ตเอง']] }], s.queue);
  const sound = form([{ k: 'enabled', label: 'เปิดเสียง', type: 'bool' }, { k: 'volume', label: 'ระดับเสียง (0-1)', type: 'number', step: '0.1' }, { k: 'count', label: 'จำนวนครั้ง ติ๊ด', type: 'number' },
    { k: 'output', label: 'เสียงออกที่', type: 'multi', options: [['kitchen', 'อุปกรณ์ครัว'], ['pos', 'เครื่อง POS']], hint: 'buzzer ของเครื่องพิมพ์ตั้งที่หน้าเครื่องพิมพ์' },
    { k: 'docs', label: 'เสียงบนอุปกรณ์ดังเมื่อพิมพ์', type: 'select', options: [['all', 'ทุกเอกสาร (ใบเสร็จ ใบครัว ฯลฯ)'], ['kitchen', 'เฉพาะใบครัว']] },
    { k: 'on', label: 'ดังเมื่อ', type: 'select', options: [['sent', 'เครื่องพิมพ์รับงานแล้ว หรือยืนยันพิมพ์สำเร็จ'], ['printed', 'เฉพาะเมื่อเครื่องยืนยันพิมพ์สำเร็จ']] },
    { k: 'file', label: 'ไฟล์เสียงพิมพ์สำเร็จ (เว้นว่าง = ติ๊ด ๆ ๆ ๆ)', type: 'image', kind: 'audio', accept: 'audio/*' }, { k: 'new_order_file', label: 'ไฟล์เสียงออเดอร์ใหม่', type: 'image', kind: 'audio', accept: 'audio/*' },
    { k: 'error_file', label: 'ไฟล์เสียงพิมพ์ผิดพลาด', type: 'image', kind: 'audio', accept: 'audio/*' }], s.sound);
  const mobile = form([{ k: 'enabled', label: 'เปิด Mobile Ordering', type: 'bool' }, { k: 'table_enabled', label: 'ทานที่ร้าน (เลือกโต๊ะ)', type: 'bool' }, { k: 'pickup_enabled', label: 'Pick Up', type: 'bool' },
    { k: 'pickup_phone_required', label: 'Pick Up ต้องกรอกเบอร์', type: 'bool' }, { k: 'pay_cashier', label: 'ชำระที่แคชเชียร์', type: 'bool' }, { k: 'pay_online', label: 'ชำระออนไลน์', type: 'bool' },
    { k: 'qr_hours', label: 'QR หมดอายุใน (ชั่วโมง)', type: 'number' }, { k: 'single_order', label: 'QR ส่งออเดอร์ได้ครั้งเดียว (ค่าเริ่มต้น)', type: 'bool' }, { k: 'allow_table_change', label: 'อนุญาตเปลี่ยนโต๊ะจาก QR โต๊ะ', type: 'bool' },
    { k: 'table_kitchen', label: 'ออเดอร์โต๊ะส่งครัว', type: 'select', options: [['immediately', 'ทันที'], ['after_payment', 'หลังชำระ']] },
    { k: 'pickup_kitchen', label: 'Pick Up ส่งครัว', type: 'select', options: [['after_payment', 'หลังชำระ (แนะนำ)'], ['immediately', 'ทันที']] },
    { k: 'cashier_expire_minutes', label: 'ออเดอร์รอชำระหมดอายุใน (นาที)', type: 'number' }], s.mobile);
  const mem = form([{ k: 'enabled', label: 'เปิดระบบสมาชิก', type: 'bool' }, { k: 'web_signup', label: 'เปิดสมัครผ่านเว็บไซต์', type: 'bool' }, { k: 'signup_from_display', label: 'สมัครจากหน้าจอลูกค้าได้', type: 'bool' },
    { k: 'show_on_receipt', label: 'แสดงชื่อสมาชิกบนใบเสร็จ', type: 'bool' }, { k: 'show_on_display', label: 'แสดงชื่อสมาชิกบนจอลูกค้า', type: 'bool' },
    { k: 'sensitive_verify', label: 'ยืนยันเพิ่มเติมก่อนรับแต้ม/แลก/แก้ข้อมูลสำคัญ', type: 'select', options: [['staff', 'ให้พนักงานยืนยัน (ลูกค้าแสดงรหัสที่เคาน์เตอร์)'], ['otp', 'OTP ผ่าน SMS webhook'], ['none', 'ไม่ตรวจเพิ่ม (ไม่แนะนำ)']] },
    { k: 'claim_verify', label: 'รับแต้มจาก QR ใบเสร็จ', type: 'select', options: [['none', 'สแกนแล้วรับแต้มทันที (ไม่ต้องใส่รหัส)'], ['staff', 'ให้พนักงานยืนยัน'], ['otp', 'OTP']] },
    { k: 'otp_webhook_url', label: 'OTP webhook URL (POST {phone,message})', wide: true }], s.members);
  const fieldsCfg = s.members.fields;
  const fieldBox = h('div', { class: 'grid2' }, Object.entries(fieldsCfg).map(([k, c]) => { const on = h('input', { type: 'checkbox', checked: c.on }); const req = h('input', { type: 'checkbox', checked: c.req }); on.onchange = () => (c.on = on.checked); req.onchange = () => (c.req = req.checked);
    return h('div', { class: 'row' }, h('strong', { style: { width: '90px' } }, { first_name: 'ชื่อ', last_name: 'นามสกุล', nickname: 'ชื่อเล่น', birthday: 'วันเกิด', email: 'อีเมล', avatar: 'รูปโปรไฟล์' }[k]), h('label', { class: 'switch' }, on, 'เปิด'), h('label', { class: 'switch' }, req, 'บังคับ')); }));
  const customF = h('textarea', { class: 'input', rows: 2 }, JSON.stringify(s.members.custom_fields || []));
  const points = form([{ k: 'enabled', label: 'เปิดระบบแต้ม', type: 'bool' }, { k: 'rate_baht', label: 'ทุกกี่บาทได้ 1 แต้ม', type: 'number' }, { k: 'rounding', label: 'ปัดเศษ', type: 'select', options: [['floor', 'ปัดลง'], ['round', 'ปัดตามปกติ'], ['ceil', 'ปัดขึ้น']] },
    { k: 'base', label: 'คิดจากยอด', type: 'select', options: [['after_discount', 'หลังส่วนลด'], ['before_discount', 'ก่อนส่วนลด']] }, { k: 'include_tax', label: 'รวมภาษี (กรณีแยก VAT)', type: 'bool' }, { k: 'include_packaging', label: 'รวมค่าบรรจุภัณฑ์/ค่าบริการ', type: 'bool' },
    { k: 'min_spend', label: 'ยอดขั้นต่ำ (บาท)', type: 'money' }, { k: 'expire_days', label: 'แต้มหมดอายุใน (วัน, 0=ไม่หมด)', type: 'number' },
    { k: 'excluded_products', label: 'สินค้าที่ไม่ร่วมสะสมแต้ม', type: 'multi', options: [], wide: true },
    { k: 'claim_qr', label: 'ออก QR รับแต้มย้อนหลังบนใบเสร็จบิลใหม่', type: 'bool' }, { k: 'claim_enabled', label: 'เปิดรับแต้มย้อนหลัง', type: 'bool' }, { k: 'claim_hours', label: 'รับแต้มได้ภายใน (ชั่วโมงหลังชำระ)', type: 'number' },
    { k: 'refund_policy', label: 'คืนเงินหลังลูกค้าใช้แต้มไปแล้ว', type: 'select', options: [['negative_allowed', 'หักแต้มได้ติดลบ (แสดงยอดค้างหัก)'], ['cap_at_zero', 'หักได้ถึง 0 เท่านั้น']] },
    { k: 'tier_mode', label: 'การเลื่อน Tier', type: 'select', options: [['auto', 'อัตโนมัติ'], ['manual', 'แอดมินปรับเอง']] }], s.points);
  const cat = await api.get('/catalog?all=1');
  const exBox = points.querySelector('.row');
  if (exBox) { const set = new Set(s.points.excluded_products || []); exBox.replaceChildren(...cat.products.map((p) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', value: p.id, checked: set.has(p.id) }), p.name))); }
  const rules = await api.get('/business-day');
  const eff = h('input', { class: 'input', type: 'date' }); const cut = h('input', { class: 'input', type: 'time', value: '04:00' }); const tz = h('input', { class: 'input', value: 'Asia/Bangkok' });
  return page('ตั้งค่าร้าน',
    card(h('h3', {}, 'ข้อมูลร้าน'), store, saveBtn('บันทึกข้อมูลร้าน', () => saveKey('store', store.value()))),
    card(h('h3', {}, 'การขาย'), sale, h('h4', {}, 'ช่องทางชำระเงิน'), pmBox, h('h4', {}, 'สิทธิ์ส่วนลดตามบทบาท'), disc,
      saveBtn('บันทึกการขาย', () => saveKey('sale', { ...sale.value(), payment_methods: pm, max_discount_pct: disc.value() }))),
    printOrderCard(s),
    card(h('h3', {}, 'เลขคิว'), h('p', { class: 'small muted' }, 'เลขคิวเริ่มใหม่ได้ตามรอบ แต่เลขบิลไม่ซ้ำเสมอ'), queue, h('div', { class: 'row' }, saveBtn('บันทึกเลขคิว', () => saveKey('queue', queue.value())),
      can('reset_queue') ? h('button', { class: 'btn danger', onclick: async () => { const reason = prompt('เหตุผลการรีเซ็ตคิว'); if (reason) { await api.post('/queue/reset', { reason }); toast('รีเซ็ตเลขคิวแล้ว', 'ok'); } } }, 'รีเซ็ตเลขคิวตอนนี้') : null)),
    card(h('h3', {}, 'เวลาเปลี่ยนวันขาย'), h('p', {}, `วันขายปัจจุบัน: ${rules.today}`), table([{ t: 'เริ่มใช้', k: 'effective_from' }, { t: 'ตัดวันเวลา', k: 'cutoff' }, { t: 'เขตเวลา', k: 'timezone' }], rules.rules),
      h('p', { class: 'small muted' }, 'เช่น ตัด 04:00: บิลวันที่ 11 เวลา 01:30 ยังเป็นวันขายวันที่ 10 · การเปลี่ยนต้องกำหนดวันเริ่มใช้ และไม่เปลี่ยนรายงานเก่า'),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'เริ่มใช้วันที่', eff), h('label', { class: 'field' }, 'เวลาตัดวัน', cut), h('label', { class: 'field' }, 'เขตเวลา', tz)),
      saveBtn('เพิ่มกฎตัดวันขาย', async () => { await api.post('/business-day', { effective_from: eff.value, cutoff: cut.value, timezone: tz.value }); reload(); })),
    card(h('h3', {}, 'เสียงแจ้งเตือน'), sound, saveBtn('บันทึกเสียง', () => saveKey('sound', sound.value()))),
    card(h('h3', {}, 'Mobile Ordering'), mobile, saveBtn('บันทึก Mobile Ordering', () => saveKey('mobile', mobile.value()))),
    card(h('h3', {}, 'สมาชิก'), mem, h('h4', {}, 'ช่องข้อมูลที่ให้กรอกตอนสมัคร (เบอร์โทรบังคับเสมอ)'), fieldBox, h('label', { class: 'field' }, 'ช่องข้อมูลเพิ่มเติม JSON [{"key":"line","label":"LINE ID","req":false}]', customF),
      saveBtn('บันทึกสมาชิก', () => saveKey('members', { ...mem.value(), fields: fieldsCfg, custom_fields: JSON.parse(customF.value || '[]') }))),
    card(h('h3', {}, 'แต้มสะสม'), points, saveBtn('บันทึกแต้ม', () => saveKey('points', points.value()))),
    card(h('h3', {}, 'รายงาน'), (() => { const f = form([{ k: 'week_start', label: 'วันเริ่มสัปดาห์', type: 'select', options: [[1, 'จันทร์'], [0, 'อาทิตย์'], [6, 'เสาร์']] }], { week_start: s.week_start }); return h('div', {}, f, saveBtn('บันทึก', () => saveKey('week_start', Number(f.value().week_start)))); })()));
}

function printOrderCard(s) {
  const P = { order: ['receipt', 'kitchen', 'merchant', 'queue'], ...s.print };
  const names = { receipt: 'ใบเสร็จลูกค้า', kitchen: 'ใบครัว', merchant: 'ใบสรุปร้านค้า', queue: 'ใบเลขคิว' };
  const order = [...new Set([...(P.order || []), 'receipt', 'kitchen', 'merchant', 'queue'])];
  const list = h('div');
  const draw = () => list.replaceChildren(...order.map((d, i) => h('div', { class: 'el-row' }, h('strong', {}, `${i + 1}.`), h('span', {}, names[d]),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { order.splice(i - 1, 0, order.splice(i, 1)[0]); draw(); } }, '↑'),
      h('button', { class: 'btn sm', disabled: i === order.length - 1, onclick: () => { order.splice(i + 1, 0, order.splice(i, 1)[0]); draw(); } }, '↓')))));
  draw();
  const f = form([{ k: 'auto_receipt', label: 'พิมพ์ใบเสร็จลูกค้าอัตโนมัติหลังชำระ', type: 'bool' }, { k: 'auto_merchant', label: 'พิมพ์ใบสรุปร้านค้าอัตโนมัติ (มีบาร์โค้ดเลขบิล + QR รายละเอียด)', type: 'bool' },
    { k: 'auto_queue', label: 'พิมพ์ใบเลขคิวอัตโนมัติ', type: 'bool' },
    { k: 'payqr_auto', label: 'พิมพ์ใบ QR ชำระเงิน (พร้อมเพย์) เมื่อเลือกจ่ายด้วย QR', type: 'select', wide: true, options: [['no_display', 'อัตโนมัติ เฉพาะเครื่องที่ไม่มีจอลูกค้าเชื่อมอยู่ (แนะนำ)'], ['always', 'อัตโนมัติทุกครั้ง'], ['off', 'ไม่พิมพ์เอง (กดปุ่มพิมพ์ในหน้าชำระเงินเมื่อต้องการ)']],
      hint: 'ใบ QR มีแค่ QR พร้อมเพย์และยอดเงิน ให้ลูกค้าสแกนจ่าย · ปุ่ม "🖨 พิมพ์ QR ชำระเงิน" ในหน้าชำระเงินกดพิมพ์ได้ทุกเมื่อ' }], { payqr_auto: 'no_display', ...P });
  return card(h('h3', {}, 'ลำดับและเอกสารที่พิมพ์หลังชำระเงิน'),
    h('p', { class: 'small muted' }, 'ถ้าใช้เครื่องพิมพ์เครื่องเดียว เอกสารจะออกตามลำดับนี้ · ใบครัวพิมพ์ทุกครั้งที่มีรายการใหม่ (กดส่งครัว หรือชำระเงิน) ไปยังเครื่องที่ติ๊ก "ใบครัว"'),
    list, f, saveBtn('บันทึกการพิมพ์', () => saveKey('print', { ...f.value(), order })));
}

export async function paymentsPage() {
  const s = await api.get('/settings');
  const pp = form([{ k: 'promptpay_type', label: 'ประเภทพร้อมเพย์', type: 'select', options: [['phone', 'เบอร์โทรศัพท์'], ['national_id', 'เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก'], ['ewallet', 'e-Wallet ID 15 หลัก']] },
    { k: 'promptpay_id', label: 'หมายเลขพร้อมเพย์' }, { k: 'promptpay_name', label: 'ชื่อผู้รับเงิน (แสดงให้ลูกค้าตรวจสอบ)' }, { k: 'slip_upload', label: 'ให้ลูกค้าแนบสลิปส่งให้พนักงานตรวจ', type: 'bool' },
    { k: 'mock_enabled', label: 'โหมดทดสอบ Mock Gateway (ห้ามเปิดตอนใช้งานจริง)', type: 'bool' }], s.payment);
  const beamCfg = (s.payment.providers || {}).beam || {};
  const keys = await api.get('/payments/providers/beam');
  const kf = form([{ k: 'merchant_id', label: 'Merchant ID' }, { k: 'api_key', label: 'API Key', type: 'password', placeholder: keys.api_key_set ? `บันทึกแล้ว (${keys.api_key_hint}) — เว้นว่างเพื่อใช้ค่าเดิม` : 'วาง API Key จาก Beam Lighthouse' },
    { k: 'webhook_secret', label: 'Webhook HMAC Key (base64)', type: 'password', placeholder: keys.webhook_secret_set ? `บันทึกแล้ว (${keys.webhook_secret_hint}) — เว้นว่างเพื่อใช้ค่าเดิม` : 'วาง HMAC Key ของ webhook' }], { merchant_id: keys.merchant_id });
  const testOut = h('span', { class: 'small' });
  const keysBox = h('div', { class: 'card', style: { background: 'var(--surface2)', margin: '.8em 0' } }, h('h4', {}, 'ข้อมูลเชื่อมต่อ (กรอกเอง)'),
    h('p', { class: 'small muted' }, 'นำค่าจาก Beam Lighthouse → Developers มาวาง · เก็บที่เซิร์ฟเวอร์เท่านั้น ไม่แสดงกลับมาที่หน้านี้'), kf,
    h('div', { class: 'row' }, saveBtn('บันทึกคีย์ Beam', async () => { await api.put('/payments/providers/beam', kf.value()); }),
      h('button', { class: 'btn', onclick: async () => { testOut.textContent = 'กำลังทดสอบ…'; const r = await api.post('/payments/providers/beam/test').catch((e) => ({ message: e.message })); testOut.textContent = (r.ok ? '✅ ' : '⚠️ ') + r.message; } }, 'ทดสอบการเชื่อมต่อ'),
      h('button', { class: 'btn ghost', onclick: async () => { if (confirm('ลบคีย์ Beam ทั้งหมด?')) { await api.put('/payments/providers/beam', { clear: true }); reload(); } } }, 'ลบคีย์'), testOut),
    keys.from_env ? h('p', { class: 'small muted' }, 'ขณะนี้ใช้คีย์จาก Environment ของเซิร์ฟเวอร์') : null);
  const beam = form([{ k: 'enabled', label: 'เปิดใช้ Beam Checkout', type: 'bool' }, { k: 'mode', label: 'โหมด', type: 'select', options: [['playground', 'ทดสอบ (playground)'], ['live', 'ใช้งานจริง']] }], beamCfg);
  return page('การรับชำระเงิน',
    card(h('h3', {}, 'พร้อมเพย์ของร้าน'), pp, h('p', { class: 'small', style: { color: 'var(--warn)' } }, '⚠️ การตั้งเลขพร้อมเพย์อย่างเดียวไม่ทำให้ระบบรู้ว่าได้รับเงินจริง — การกด "โอนแล้ว" หรือส่งสลิปของลูกค้าจะไม่เปลี่ยนเป็นชำระแล้ว จนกว่าพนักงานตรวจสอบยอดเงินเข้าและกดยืนยัน'),
      saveBtn('บันทึก', () => saveKey('payment', pp.value()))),
    card(h('h3', {}, 'Payment Gateway: Beam Checkout'), beam,
      keysBox,
      h('p', {}, 'Webhook URL สำหรับตั้งใน Beam Lighthouse: ', h('code', {}, location.origin + '/api/webhooks/beam')),
      h('p', { class: 'small muted' }, 'ระบบตรวจลายเซ็น X-Beam-Signature (HMAC-SHA256) → กัน webhook ซ้ำ → สอบถามสถานะจาก Beam API อีกครั้ง → ตรวจยอดเงินและเลขอ้างอิงก่อนเปลี่ยนเป็นชำระแล้ว · ทดสอบใน playground และตรวจรายละเอียดฟิลด์กับเอกสาร Beam ล่าสุดก่อนเปิดใช้จริง'),
      saveBtn('บันทึก', () => saveKey('payment', { providers: { beam: beam.value() } }))));
}

export async function displayPage() {
  const s = await api.get('/settings');
  const d = { ...s.display, media: [...(s.display.media || [])] };
  const f = form([{ k: 'layout', label: 'รูปแบบขณะขาย', type: 'select', options: [['split', 'แบ่งพื้นที่ โปรโมชั่น + รายการสินค้า'], ['full', 'เต็มจอรายการสินค้า']] },
    { k: 'fit', label: 'สัดส่วนภาพ', type: 'select', options: [['cover', 'เต็มพื้นที่ (ครอบตัด)'], ['contain', 'แสดงทั้งภาพ']] }, { k: 'image_seconds', label: 'เวลาแสดงรูป (วินาที)', type: 'number' },
    { k: 'video_muted', label: 'ปิดเสียงวิดีโอ', type: 'bool' }, { k: 'video_volume', label: 'ระดับเสียงวิดีโอ (0-1)', type: 'number', step: '0.1' }, { k: 'show_qr', label: 'แสดง QR ชำระเงิน', type: 'bool' },
    { k: 'bg', label: 'สีพื้นหลัง', type: 'color' }, { k: 'color', label: 'สีตัวอักษร', type: 'color' }, { k: 'accent', label: 'สีเน้น', type: 'color' }, { k: 'logo', label: 'โลโก้', type: 'image' },
    { k: 'welcome', label: 'ข้อความต้อนรับ', wide: true }, { k: 'thanks', label: 'ข้อความขอบคุณ', wide: true }, { k: 'pairing_minutes', label: 'รหัสจับคู่หมดอายุ (นาที)', type: 'number' },
    { k: 'member_prompt_seconds', label: 'หน้ากรอกสมาชิกปิดอัตโนมัติ (วินาที)', type: 'number' }], d);
  const list = h('div');
  // ---- colours & style: every colour can go back to the built-in look ----
  const style = { ...DISPLAY_STYLE_DEFAULTS, ...(d.style || {}) };
  const texts = { ...(d.texts || {}) };
  const COLORS = [['bg2', 'พื้นหลังไล่สี (มุมบน)', '#1f2937'], ['card', 'สีการ์ด/กล่องกระจก', '#ffffff'], ['highlight', 'สีรายการล่าสุด', d.accent || '#ef4444'], ['qty', 'สีกล่องจำนวน', d.accent || '#ef4444'],
    ['total_from', 'ตัวเลขยอดรวม: สีเริ่ม', '#ffffff'], ['total_to', 'ตัวเลขยอดรวม: สีปลาย', '#fecaca'], ['pay_head', 'การ์ดยอดที่ต้องชำระ', d.accent || '#ef4444'],
    ['ok', 'สีสำเร็จ / เงินทอน', '#22c55e'], ['warn', 'สีเตือน / ยังขาด', '#facc15'], ['gold', 'การ์ดสมาชิก / ท็อปปิ้ง', '#f6c453'], ['member_text', 'ตัวอักษรบนการ์ดสมาชิก', '#3b2304'], ['qr_head', 'หัวการ์ด QR', '#0f2a5f']];
  const colorRow = ([k, label, fallback]) => {
    const custom = !!(d.style && /^#[0-9a-f]{6}$/i.test(d.style[k] || ''));
    const inp = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(style[k] || '') ? style[k] : fallback });
    const def = h('input', { type: 'checkbox', checked: !custom });
    const sync = () => { style[k] = def.checked ? DISPLAY_STYLE_DEFAULTS[k] : inp.value; preview(); };
    inp.addEventListener('input', () => { def.checked = false; sync(); }); def.addEventListener('change', sync);
    return h('div', { class: 'dstyle-row' }, h('span', {}, label), inp, h('label', { class: 'switch small' }, def, 'ค่าเริ่มต้น'));
  };
  const numRow = (k, label, min, max, step = 5, unit = '%') => {
    const out = h('b', {}, style[k] + unit);
    const inp = h('input', { type: 'range', min, max, step, value: style[k] });
    inp.addEventListener('input', () => { style[k] = Number(inp.value); out.textContent = inp.value + unit; preview(); });
    return h('div', { class: 'dstyle-row' }, h('span', {}, label), inp, out);
  };
  const selRow = (k, label, opts) => {
    const sel = h('select', { class: 'input' }, opts.map(([v, t]) => h('option', { value: v, selected: style[k] === v }, t)));
    sel.addEventListener('change', () => { style[k] = sel.value; preview(); });
    return h('div', { class: 'dstyle-row' }, h('span', {}, label), sel);
  };
  const boolRow = (k, label) => { const cb = h('input', { type: 'checkbox', checked: style[k] !== false }); cb.addEventListener('change', () => { style[k] = cb.checked; preview(); }); return h('label', { class: 'switch' }, cb, label); };
  const styleCard = card(h('h3', {}, '🎨 สีและสไตล์'), h('p', { class: 'small muted' }, 'สีหลัก (สีเน้น/พื้นหลัง/ตัวอักษร) ตั้งในหัวข้อ "รูปแบบ" · ติ๊ก "ค่าเริ่มต้น" เพื่อใช้สีที่ระบบคำนวณจากสีเน้นให้เอง'),
    h('div', { class: 'dstyle' }, COLORS.map(colorRow)),
    h('h4', {}, 'ขนาดและรูปทรง'), numRow('card_opacity', 'ความทึบการ์ดกระจก', 0, 40, 1), numRow('items_scale', 'ขนาดตัวอักษรรายการ', 70, 150), numRow('total_scale', 'ขนาดตัวเลขยอดรวม', 60, 150), numRow('queue_scale', 'ขนาดเลขคิวหน้าขอบคุณ', 50, 130),
    selRow('corners', 'มุมการ์ด', [['round', 'โค้งมน'], ['soft', 'โค้งเล็กน้อย'], ['square', 'เหลี่ยม']]));
  const fxCard = card(h('h3', {}, '✨ ลูกเล่นและเอฟเฟกต์'),
    selRow('motion', 'ระดับการเคลื่อนไหว', [['extra', '🔥 จัดเต็ม — เคลื่อนไหวมากที่สุด'], ['normal', 'ปกติ'], ['soft', 'เบาๆ — เฉพาะที่จำเป็น'], ['off', 'ปิด — ภาพนิ่ง (เครื่องแรงน้อย)']]),
    selRow('bg_effect', 'พื้นหลัง', [['blobs', 'วงแสงลอย'], ['aurora', 'แสงออโรร่าหมุน'], ['particles', 'ประกายลอยขึ้น'], ['gradient', 'ไล่สีเรียบๆ'], ['none', 'สีพื้นล้วน']]),
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '.4em 1.2em' } }, boolRow('latest_fx', 'ไฮไลต์รายการล่าสุด'), boolRow('shine', 'แสงวาบวิ่งผ่าน'), boolRow('ring', 'ขอบแสงหมุน (QR/เงินสด)'),
      boolRow('sparks', 'ประกายหน้าชำระเงิน'), boolRow('money_fx', 'เหรียญ/ธนบัตรตอนทอนเงิน'), boolRow('confetti', 'พลุกระดาษหน้าขอบคุณ'), boolRow('fireworks', 'พลุไฟหน้าขอบคุณ'), boolRow('floaters', 'อีโมจิลอย + แสงหมุน')));
  // ---- every text on the screen ----
  const textCard = card(h('h3', {}, '✏️ ข้อความทุกจุดบนจอลูกค้า'), h('p', { class: 'small muted' }, 'เว้นว่าง = ใช้ข้อความเดิม (แสดงเป็นตัวจางในช่อง) · {n} {amount} {points} {lines} {pcs} จะถูกแทนด้วยตัวเลขจริง'),
    ...DISPLAY_TEXTS.map(([sec, rows], i) => h('details', { class: 'dtexts', open: i === 0 }, h('summary', {}, sec, h('span', { class: 'muted small' }, ` (${rows.length})`)),
      h('div', { class: 'grid2' }, rows.map(([k, label, def]) => { const inp = h('input', { class: 'input', value: texts[k] || '', placeholder: def }); inp.addEventListener('input', () => { texts[k] = inp.value; preview(); });
        return h('label', { class: 'field' }, label, inp); })))));
  const PHASES = [['cart', '🛒 ขณะขาย', 'phase=cart'], ['cash', '💵 รับเงินสด', 'phase=pay&demo=1'], ['qr', '📱 QR', 'phase=pay&qr=1'], ['done', '🎉 ขอบคุณ', 'phase=done'], ['bye', '👋 กดเสร็จ', 'phase=done&demo=1'], ['idle', '🏠 ต้อนรับ', 'phase=idle']];
  // previews render at a real 1280×720 screen and are scaled down, so they look exactly like the customer display
  const scaled = (src) => { const fr = h('iframe', { src, style: 'position:absolute;left:0;top:0;width:1280px;height:720px;border:0;transform-origin:0 0' });
    const box = h('div', { style: 'position:relative;width:100%;aspect-ratio:16/9;overflow:hidden;border:1px solid var(--line);border-radius:12px;background:#000' }, fr);
    new ResizeObserver(() => { fr.style.transform = `scale(${box.clientWidth / 1280})`; }).observe(box); return [fr, box]; };
  const [iframe, iframeBox] = scaled('/display/?preview=1&phase=cart');
  const [iframeIdle, iframeIdleBox] = scaled('/display/?preview=1&phase=idle');
  const tabs = h('div', { class: 'seg', style: { flexWrap: 'wrap', marginBottom: '.5em' } });
  const drawTabs = (on) => tabs.replaceChildren(...PHASES.map(([k, t, q]) => h('button', { class: on === k ? 'on' : '', onclick: () => { iframe.src = '/display/?preview=1&' + q + '&r=' + Date.now(); drawTabs(k); } }, t)));
  drawTabs('cart');
  const value = () => ({ ...d, ...f.value(), media: d.media, style: Object.fromEntries(Object.entries(style).filter(([k, v]) => v !== DISPLAY_STYLE_DEFAULTS[k])), texts: Object.fromEntries(Object.entries(texts).filter(([, v]) => String(v || '').trim())) });
  const preview = () => { const v = value(); for (const fr of [iframe, iframeIdle]) fr.contentWindow && fr.contentWindow.postMessage({ display: v }, location.origin); };
  iframe.addEventListener('load', () => setTimeout(preview, 300)); iframeIdle.addEventListener('load', () => setTimeout(preview, 300));
  const drawList = () => list.replaceChildren(...d.media.map((m, i) => h('div', { class: 'el-row' }, m.type === 'video' ? h('video', { src: m.url, muted: true, style: { width: '90px' } }) : h('img', { src: m.url, style: { width: '90px', borderRadius: '6px' } }),
    h('div', { class: 'row' }, h('span', {}, m.type === 'video' ? 'วิดีโอ' : 'รูปภาพ'), m.type !== 'video' ? h('label', { class: 'small' }, 'วินาที ', (() => { const x = h('input', { class: 'input', type: 'number', value: m.seconds || '', style: { width: '80px' } }); x.oninput = () => { m.seconds = Number(x.value) || null; }; return x; })()) : null),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { d.media.splice(i - 1, 0, d.media.splice(i, 1)[0]); drawList(); preview(); } }, '↑'), h('button', { class: 'btn sm', disabled: i === d.media.length - 1, onclick: () => { d.media.splice(i + 1, 0, d.media.splice(i, 1)[0]); drawList(); preview(); } }, '↓'),
      h('button', { class: 'btn sm danger', onclick: () => { d.media.splice(i, 1); drawList(); preview(); } }, 'ลบ')))));
  drawList();
  const file = h('input', { type: 'file', accept: 'image/*,video/mp4,video/webm', multiple: true });
  file.onchange = async () => { for (const fl of file.files) { try { const r = await upload(fl, 'video'); d.media.push({ url: r.url, type: r.mime.startsWith('video') ? 'video' : 'image' }); } catch (e) { errToast(e); } } drawList(); preview(); };
  f.addEventListener('input', preview); f.addEventListener('change', preview);
  return page('จอลูกค้า', h('div', { class: 'designer' }, h('div', {}, card(h('h3', {}, 'สื่อประชาสัมพันธ์ขณะไม่มีการขาย'), h('label', { class: 'field' }, 'อัปโหลดรูป/วิดีโอจากเครื่อง', file), list),
    card(h('h3', {}, 'รูปแบบ'), f), styleCard, fxCard, textCard,
    h('div', { class: 'row' }, h('button', { class: 'btn', onclick: preview }, 'ดูตัวอย่าง'), saveBtn('บันทึก (จอลูกค้าอัปเดตทันที)', () => { const v = value(); return saveKey('display', { ...f.value(), media: d.media, style: v.style, texts: v.texts }); }))),
  h('div', { class: 'dprev' }, h('h4', {}, 'ตัวอย่าง (เปลี่ยนแล้วเห็นทันที)'), tabs, iframeBox, h('h4', {}, 'ตัวอย่างขณะไม่มีการขาย'), iframeIdleBox)));
}

export async function fontsPage() {
  const s = await api.get('/settings');
  let list = await fontCatalog(true);
  const fonts = { ...s.fonts };
  const q = h('input', { class: 'input', placeholder: 'ค้นหาชื่อฟอนต์ Google Fonts (หรือพิมพ์ชื่อฟอนต์อื่นใน Google Fonts)', style: { maxWidth: '380px' } });
  const results = h('div', { class: 'grid2' });
  const sampleCard = (family, extra) => {
    const sm = h('div', { style: { fontFamily: familyCss(family), fontSize: '20px', lineHeight: 1.5 } }, SAMPLE);
    const flag = h('span', { class: 'badge' }, 'ตรวจอักษรไทย…');
    loadFont(family).then((ok) => { const t = ok && hasThai(family); flag.className = 'badge ' + (t ? 'ok' : 'warn'); flag.textContent = !ok ? 'โหลดไม่สำเร็จ (ใช้ฟอนต์สำรอง)' : t ? 'มีอักษรไทย' : 'ไม่มีอักษรไทย → ใช้ฟอนต์สำรองแสดงภาษาไทย'; });
    return h('div', { class: 'card' }, h('div', { class: 'row between' }, h('strong', {}, family), flag), sm, extra);
  };
  const search = () => {
    const term = q.value.trim().toLowerCase();
    const found = GOOGLE_FONTS.filter(([n]) => !term || n.toLowerCase().includes(term)).slice(0, 12);
    if (term && !found.some(([n]) => n.toLowerCase() === term)) found.unshift([q.value.trim(), null]);
    results.replaceChildren(...found.map(([n]) => {
      const ws = [300, 400, 500, 600, 700, 800].map((w) => [w, h('input', { type: 'checkbox', checked: w === 400 || w === 700 })]);
      return sampleCard(n, h('div', {}, h('div', { class: 'row small' }, ws.map(([w, cb]) => h('label', { class: 'switch' }, cb, w))),
        h('button', { class: 'btn sm primary', onclick: async () => { await api.post('/fonts/google', { family: n, weights: ws.filter(([, cb]) => cb.checked).map(([w]) => w), has_thai: hasThai(n) }); toast('เพิ่มฟอนต์แล้ว', 'ok'); reload(); } }, 'เพิ่มฟอนต์นี้')));
    }));
  };
  q.addEventListener('input', search); search();
  const file = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2' });
  const fam = h('input', { class: 'input', placeholder: 'ชื่อฟอนต์ (family)' });
  const families = ['Sarabun', ...new Set(list.map((x) => x.family))];
  // per area: body font + heading/big-number font; optional separate English font for each (Thai/English split)
  const fv = { ...fonts };
  const split = h('input', { type: 'checkbox', checked: !!fv.split_lang });
  const grid = h('div', { class: 'fontgrid' });
  const pick = (key, placeholder) => {
    const sel = h('select', { class: 'input' }, h('option', { value: '' }, placeholder), families.map((x) => h('option', { value: x, selected: fv[key] === x }, x)));
    sel.addEventListener('change', () => { fv[key] = sel.value; drawSamples(); });
    return sel;
  };
  const samples = [];
  const drawSamples = async () => {
    for (const [el, area] of samples) {
      const [b, hd] = await Promise.all([fontStack({ ...fv, split_lang: split.checked }, area), fontStack({ ...fv, split_lang: split.checked }, area, '_head')]);
      el.replaceChildren(h('b', { style: { fontFamily: familyCss(hd || b || 'Prompt') } }, 'คิว A12 · 1,234 ฿'), h('span', { style: { fontFamily: familyCss(b || 'Sarabun') } }, ' มาม่าเกาหลี Ramyeon 라면'));
    }
  };
  const drawGrid = () => {
    samples.length = 0;
    const sp = split.checked;
    const inherit = (k) => (k === 'global' ? 'ค่าเริ่มต้น' : ['receipt', 'kitchen'].includes(k) ? '(ตามแม่แบบเอกสาร)' : '(ตามทั้งระบบ)');
    grid.replaceChildren(h('div', { class: 'fg-row fg-head' + (sp ? ' sp' : '') }, h('span', {}, 'ส่วน'), h('span', {}, sp ? 'ทั่วไป · ไทย' : 'ตัวอักษรทั่วไป'), sp ? h('span', {}, 'ทั่วไป · อังกฤษ') : null,
      h('span', {}, sp ? 'หัวข้อ/ตัวเลข · ไทย' : 'หัวข้อ / ตัวเลขใหญ่'), sp ? h('span', {}, 'หัวข้อ/ตัวเลข · อังกฤษ') : null, h('span', {}, 'ตัวอย่าง')),
      ...Object.entries(AREAS).map(([k, t]) => {
        const sm = h('div', { class: 'fg-sample' }); samples.push([sm, k]);
        return h('div', { class: 'fg-row' + (sp ? ' sp' : '') }, h('b', {}, t), pick(k, inherit(k)), sp ? pick(k + '_en', 'ใช้ฟอนต์เดียวกับไทย') : null,
          pick(k + '_head', k === 'global' ? 'Prompt' : inherit(k)), sp ? pick(k + '_head_en', 'ใช้ฟอนต์เดียวกับไทย') : null, sm);
      }));
    drawSamples();
  };
  split.addEventListener('change', drawGrid); drawGrid();
  const assign = form([{ k: 'fallback', label: 'ฟอนต์สำรอง (CSS)', wide: true }, { k: 'size', label: 'ขนาดตัวอักษรหน้าจอ (px)', type: 'number' }, { k: 'weight', label: 'น้ำหนัก', type: 'number' },
    { k: 'line_height', label: 'ระยะบรรทัด', type: 'number', step: '0.05' }, { k: 'letter_spacing', label: 'ระยะตัวอักษร (px)', type: 'number', step: '0.1' }], fonts);
  return page('ศูนย์จัดการฟอนต์',
    card(h('h3', {}, 'ฟอนต์ที่ใช้ในแต่ละส่วน'), h('p', { class: 'small muted' }, 'แต่ละส่วนตั้งฟอนต์ตัวอักษรทั่วไป และฟอนต์หัวข้อ/ตัวเลขใหญ่ (เช่น เลขคิว ยอดเงิน) แยกกันได้ · ไม่เลือก = ใช้ตามทั้งระบบ · ฟอนต์ใบเสร็จ/ใบครัวที่ตั้งตรงนี้ใช้แทนฟอนต์หลักของแม่แบบ (องค์ประกอบที่ตั้งฟอนต์ไว้เองในตัวออกแบบยังใช้ฟอนต์นั้น)'),
      h('label', { class: 'switch', style: { margin: '.4em 0 .8em' } }, split, h('span', {}, h('b', {}, 'แยกฟอนต์ภาษาไทย / ภาษาอังกฤษ'), h('small', { class: 'muted' }, ' — ตัวอักษรไทยใช้ฟอนต์หนึ่ง ตัวอังกฤษ ตัวเลข และสัญลักษณ์ใช้อีกฟอนต์'))),
      grid, h('h4', {}, 'ค่าอื่นๆ'), assign,
      saveBtn('บันทึกการใช้ฟอนต์', () => { const v = { ...fv, ...assign.value(), split_lang: split.checked }; for (const k of Object.keys(v)) if (v[k] === '') delete v[k]; return saveKey('fonts', v); })),
    card(h('h3', {}, 'ฟอนต์ในระบบ'), table([{ t: 'ชื่อ', k: 'family' }, { t: 'แหล่ง', f: (x) => (x.source === 'google' ? 'Google Fonts' : 'อัปโหลด ' + x.format) }, { t: 'อักษรไทย', f: (x) => (x.has_thai === null ? '?' : x.has_thai ? 'มี' : 'ไม่มี') },
      { t: 'ตัวอย่าง', f: (x) => { const e = h('span', { style: { fontFamily: familyCss(x.family) } }, 'มาม่าเกาหลี 123'); loadFont(x.family); return e; } },
      { t: '', f: (x) => h('button', { class: 'btn sm danger', onclick: async (e) => { e.stopPropagation(); await api.del('/fonts/' + x.id); reload(); } }, 'ลบ') }], list)),
    card(h('h3', {}, 'อัปโหลดไฟล์ฟอนต์'), h('div', { class: 'row' }, file, fam, h('button', { class: 'btn primary', onclick: async () => {
      if (!file.files[0]) return toast('เลือกไฟล์', 'warn');
      const fd = new FormData(); fd.append('file', file.files[0]); fd.append('family', fam.value || file.files[0].name.replace(/\.[^.]+$/, ''));
      try {
        const r = await api.post('/fonts/upload', fd);
        const ff = new FontFace(r.family, `url(${r.url})`); await ff.load(); document.fonts.add(ff);
        const thai = hasThai(r.family);
        await api.put('/fonts/' + r.id, { has_thai: thai });
        toast(thai ? 'อัปโหลดแล้ว — ฟอนต์มีอักษรไทย' : 'อัปโหลดแล้ว — ฟอนต์นี้ไม่มีอักษรไทย ระบบจะใช้ฟอนต์สำรองแสดงภาษาไทย', thai ? 'ok' : 'warn', 6000); reload();
      } catch (e) { errToast(e); }
    } }, 'ตรวจสอบและอัปโหลด')), h('p', { class: 'small muted' }, 'รองรับ TTF, OTF, WOFF, WOFF2 · ระบบตรวจรูปแบบไฟล์ก่อนบันทึก และทดสอบว่ามีอักษรไทยหรือไม่')),
    card(h('h3', {}, 'เพิ่มจาก Google Fonts'), q, results));
}

export async function printersPage() {
  const [printers, tpl, cat, terms, jobs] = await Promise.all([api.get('/printers'), api.get('/templates'), api.get('/catalog?all=1'), api.get('/terminals'), api.get('/print/jobs')]);
  const open = (p) => {
    const roles = [['receipt', 'ใบเสร็จ'], ['kitchen', 'ใบครัว'], ['merchant', 'ใบสรุปร้านค้า'], ['queue', 'ใบเลขคิว'], ['mobile_qr', 'ใบ Mobile Ordering'], ['refund', 'ใบยกเลิก/คืนเงิน'], ['shift', 'สรุปรอบ'], ['redeem', 'หลักฐานแลกรางวัล'], ['payqr', 'ใบ QR ชำระเงิน (ไม่เลือก = ใช้เครื่องพิมพ์ใบเสร็จ)']];
    const f = form([{ k: 'name', label: 'ชื่อเครื่อง' }, { k: 'conn', label: 'ช่องทาง', type: 'select', options: [['usb', 'USB (WebUSB)'], ['lan', 'LAN (IP:Port)'], ['bluetooth', 'Bluetooth'], ['serial', 'Serial/COM'], ['agent_usb', 'USB ผ่าน Print Agent'], ['browser', 'เบราว์เซอร์ (A4/ทั่วไป)']] },
      { k: 'address', label: 'IP / Path' }, { k: 'port', label: 'Port', type: 'number' }, { k: 'paper', label: 'กระดาษ', type: 'select', options: [[80, '80 มม.'], [58, '58 มม.']] }, { k: 'margin', label: 'ระยะขอบ (จุด)', type: 'number' },
      { k: 'copies', label: 'จำนวนสำเนา', type: 'number' }, { k: 'cut_mode', label: 'การตัด', type: 'select', options: [['full', 'ตัดเต็ม'], ['partial', 'ตัดบางส่วน (ถ้ารองรับ)'], ['none', 'ไม่ตัด']] },
      { k: 'feed_before', label: 'ป้อนกระดาษก่อนตัด (บรรทัด)', type: 'number' }, { k: 'feed_after', label: 'ป้อนกระดาษหลังพิมพ์ (บรรทัด)', type: 'number' },
      { k: 'beep_count', label: 'จำนวนครั้งเสียง buzzer', type: 'number' },
      { k: 'roles', label: 'งานที่รับผิดชอบ', type: 'multi', options: roles, wide: true }, { k: 'station_ids', label: 'จุดครัวที่รับ (ไม่เลือก = ทุกจุด)', type: 'multi', options: cat.stations.map((s) => [s.id, s.name]), wide: true },
      { k: 'host_terminal_id', label: 'อุปกรณ์ที่เชื่อมเครื่องพิมพ์', type: 'select', options: [['', '- อุปกรณ์ใดก็ได้ที่จับคู่ -'], ...terms.map((t) => [t.id, t.name])] }, { k: 'active', label: 'ใช้งาน', type: 'bool' }], p || { active: true, paper: 80, port: 9100, copies: 1, feed_before: 3, feed_after: 1, cut_mode: 'full', roles: ['receipt', 'kitchen', 'refund', 'shift'], beep_count: 3 });
    const po = (p && p.options) || {};
    const of = form([
      { k: 'density', label: 'ความเข้มการพิมพ์ (80 จาง – 230 เข้ม)', type: 'number', hint: 'ค่าเริ่มต้น 160' }, { k: 'scale', label: 'ขยาย/ย่อตัวอักษรทั้งใบ (0.7–1.5)', type: 'number', step: '0.05' },
      { k: 'width_dots', label: 'ความกว้างพื้นที่พิมพ์ (จุด, 0 = อัตโนมัติ)', type: 'number', hint: '58 มม. = 384 · 80 มม. = 576 · บางรุ่น 80 มม. = 512' },
      { k: 'top_feed', label: 'เว้นบรรทัดก่อนเริ่มพิมพ์', type: 'number' },
      { k: 'buzzer_mode', label: 'เสียงจากเครื่องพิมพ์ (buzzer)', type: 'select', options: [['all', 'ดังทุกครั้งที่พิมพ์'], ['kitchen', 'เฉพาะใบครัว'], ['receipt', 'เฉพาะใบเสร็จ'], ['off', 'ปิดเสียง']] },
      { k: 'beep_duration', label: 'ความยาวเสียงแต่ละครั้ง (1–9)', type: 'number' },
      { k: 'cash_drawer', label: 'เปิดลิ้นชักเงินสดเมื่อรับเงินสด', type: 'bool' }, { k: 'drawer_pin', label: 'ขาลิ้นชัก', type: 'select', options: [[0, 'Pin 2 (ทั่วไป)'], [1, 'Pin 5']] },
      { k: 'print_logo', label: 'พิมพ์โลโก้/รูปภาพ', type: 'bool' }, { k: 'reprint_mark', label: 'พิมพ์คำว่า "สำเนา/พิมพ์ซ้ำ" เมื่อพิมพ์ซ้ำ', type: 'bool' },
    ], { density: 160, scale: 1, width_dots: 0, top_feed: 0, buzzer_mode: 'all', beep_duration: 2, print_logo: true, reprint_mark: true, ...po, drawer_pin: po.drawer_pin || 0 });
    const copyIn = Object.fromEntries(roles.map(([r]) => [r, h('input', { class: 'input', type: 'number', min: 0, max: 9, placeholder: 'ตามแม่แบบ', value: po.copies_by_doc && po.copies_by_doc[r] !== undefined ? po.copies_by_doc[r] : '' })]));
    const tsel = Object.fromEntries(roles.map(([r, t]) => [r, h('select', { class: 'input' }, h('option', { value: '' }, 'ค่าเริ่มต้น'), tpl.templates.filter((x) => x.doc_type === r).map((x) => h('option', { value: x.id, selected: p && p.templates[r] === x.id }, x.name)))]));
    modal(p ? 'ตั้งค่าเครื่องพิมพ์' : 'เพิ่มเครื่องพิมพ์', h('div', {}, h('h4', {}, 'การเชื่อมต่อและงาน'), f,
      h('h4', {}, 'คุณภาพการพิมพ์ เสียง และลิ้นชัก'), of,
      h('h4', {}, 'จำนวนสำเนาแยกตามเอกสาร (0 = ไม่พิมพ์ที่เครื่องนี้)'), h('div', { class: 'form-grid' }, roles.map(([r, t]) => h('label', { class: 'field' }, t, copyIn[r]))),
      h('h4', {}, 'แม่แบบที่ใช้กับเครื่องนี้'), h('div', { class: 'form-grid' }, roles.map(([r, t]) => h('label', { class: 'field' }, t, tsel[r]))),
      h('p', { class: 'small muted' }, 'การค้นหา/จับคู่และทดสอบพิมพ์ต้องทำที่อุปกรณ์หน้างาน (POS → 🖨️ อุปกรณ์) เพราะต้องเข้าถึงฮาร์ดแวร์จริง สถานะจะรายงานกลับมาที่หน้านี้')), { wide: true, actions: [
      p ? { label: 'ปิดใช้งาน', class: 'danger', onClick: async () => { await api.del('/printers/' + p.id); reload(); } } : null,
      p ? { label: 'ส่งหน้าทดสอบไปที่อุปกรณ์', close: false, onClick: async () => { const r = await api.post('/print/test', { printer_id: p.id }); toast(r.jobs.length ? 'ส่งงานทดสอบแล้ว' : 'ไม่ได้สร้างงาน', 'ok'); } } : null,
      { label: 'บันทึก', class: 'primary', onClick: async () => {
        const v = { ...f.value(), paper: Number(f.value().paper), templates: Object.fromEntries(Object.entries(tsel).filter(([, s]) => s.value).map(([r, s]) => [r, s.value])),
          options: { ...of.value(), drawer_pin: Number(of.value().drawer_pin), copies_by_doc: Object.fromEntries(Object.entries(copyIn).filter(([, i]) => i.value !== '').map(([r, i]) => [r, Number(i.value)])) } };
        if (p) await api.put('/printers/' + p.id, v); else await api.post('/printers', v); reload();
      } }].filter(Boolean) });
  };
  // ---- noodle cookers: queue, estimated time, and which printer each cooker's tickets go to ----
  const all = await api.get('/settings');
  const ck = { enabled: true, count: 2, minutes_per_bowl: 4, split_by_bowl: true, machines: [], ...(all.cookers || {}) };
  const markAdd = h('input', { type: 'checkbox', checked: !!(all.print || {}).mark_additions });
  const cf = form([{ k: 'enabled', label: 'ใช้ระบบเครื่องต้ม (จัดคิว + เวลาโดยประมาณ)', type: 'bool' }, { k: 'count', label: 'จำนวนเครื่องต้ม', type: 'number' },
    { k: 'minutes_per_bowl', label: 'เวลาต้ม 1 ชาม (นาที)', type: 'number', step: '0.5' },
    { k: 'split_by_bowl', label: 'แยกใบครัว 1 ใบต่อ 1 ชาม เพื่อกระจายไปเครื่องที่ว่างก่อน', type: 'bool', wide: true }], ck);
  const rowsBox = h('div', { class: 'form-grid' });
  const names = [], prs = [];
  const drawRows = () => {
    const n = Math.max(1, Math.min(8, Number(cf.value().count) || 2));
    rowsBox.replaceChildren(...Array.from({ length: n }, (_, i) => {
      const m = ck.machines[i] || {};
      names[i] = names[i] || h('input', { class: 'input', value: m.name || `เครื่องต้ม ${i + 1}` });
      prs[i] = prs[i] || h('select', { class: 'input' }, h('option', { value: '' }, '— ใช้เครื่องพิมพ์ตามจุดครัว —'), printers.filter((x) => x.active).map((x) => h('option', { value: x.id, selected: m.printer_id === x.id }, x.name)));
      return h('div', { class: 'card', style: { margin: 0 } }, h('strong', {}, `🔥 เครื่องที่ ${i + 1}`), h('label', { class: 'field' }, 'ชื่อ', names[i]), h('label', { class: 'field' }, 'พิมพ์ใบครัวที่', prs[i]));
    }));
  };
  cf.addEventListener('input', drawRows); drawRows();
  const cookerCard = card(h('h3', {}, '🍜 เครื่องต้ม · จัดคิวอัตโนมัติ'),
    h('p', { class: 'small muted' }, 'ทุกชามที่ส่งครัวจะไปที่เครื่องที่ว่างก่อน (สลับกันไปเมื่อคิวยาว) · หน้าขาย POS แสดงจำนวนชามที่เหลือและเวลาโดยประมาณของแต่ละเครื่อง · ใบครัวพิมพ์ "ชามที่ x/y" ตัวใหญ่และ "ต้มโดยเครื่องที่…" · ครัวกด "เสร็จ/พร้อมเสิร์ฟ" ที่จอครัว คิวจะขยับเร็วขึ้นทันที'),
    cf, rowsBox,
    h('label', { class: 'switch', style: { marginTop: '.6em' } }, markAdd, 'พิมพ์ "+++ สั่งเพิ่ม +++" เมื่อส่งครัวบิลเดิมซ้ำ (ไม่ติ๊ก = พิมพ์เป็นใบปกติ)'),
    h('div', { style: { marginTop: '.6em' } }, saveBtn('บันทึกเครื่องต้ม', async () => {
      const v = cf.value(); const n = Math.max(1, Math.min(8, Number(v.count) || 2));
      await saveKey('cookers', { enabled: !!v.enabled, count: n, minutes_per_bowl: Math.max(0.5, Number(v.minutes_per_bowl) || 4), split_by_bowl: !!v.split_by_bowl,
        machines: Array.from({ length: n }, (_, i) => ({ name: (names[i] && names[i].value.trim()) || `เครื่องต้ม ${i + 1}`, printer_id: (prs[i] && prs[i].value) || '' })) });
      await saveKey('print', { ...((await api.get('/settings')).print || {}), mark_additions: markAdd.checked });
    })));
  // ---- merchant summary: usual slip, or a compact continuous roll on another (58 mm) printer ----
  const P0 = all.print || {};
  const mTpls = tpl.templates.filter((x) => x.doc_type === 'merchant');
  const mStyle = h('select', { class: 'input' }, [['normal', 'แบบเดิม — ใบสรุปเต็ม ตัดกระดาษทุกใบ'], ['compact', 'แบบย่อ — ต่อเนื่อง ไม่ตัดกระดาษ (เหมาะกับเครื่อง 58 มม.)']].map(([v, t]) => h('option', { value: v, selected: (P0.merchant_style || 'normal') === v }, t)));
  const mPrinter = h('select', { class: 'input' }, h('option', { value: '' }, '— เครื่องที่ตั้งงาน "ใบสรุปร้านค้า" ไว้ —'), printers.filter((x) => x.active).map((x) => h('option', { value: x.id, selected: P0.merchant_printer_id === x.id }, `${x.name} (${x.paper} มม.)`)));
  const mTpl = h('select', { class: 'input' }, h('option', { value: '' }, 'ใบสรุปย่อ 58 มม. (ค่าเริ่มต้น)'), mTpls.map((x) => h('option', { value: x.id, selected: P0.merchant_template_id === x.id }, x.name)));
  const mAuto = h('input', { type: 'checkbox', checked: !!P0.auto_merchant });
  const tplRow = h('label', { class: 'field' }, 'แม่แบบแบบย่อ (แก้หน้าตาได้ที่ ออกแบบเอกสาร → ใบสรุปร้านค้า)', mTpl);
  // ---- what the compact slip shows: switches over the chosen template's elements ----
  const C = tpl.compact_merchant;
  const isEl = (pred) => (e) => { try { return pred(e); } catch { return false; } };
  const PARTS = [
    ['store', 'ชื่อร้าน', isEl((e) => e.type === 'field' && e.field === 'store_name')],
    ['queue', 'เลขคิว', isEl((e) => e.type === 'field' && e.field === 'queue_no')],
    ['bill', 'เลขบิล', isEl((e) => e.type === 'text' && e.text === '{bill_no}')],
    ['time', 'วันเวลา', isEl((e) => e.type === 'field' && e.field === 'datetime')],
    ['dine', 'ทานที่ร้าน / กลับบ้าน', isEl((e) => e.type === 'field' && e.field === 'dine_type')],
    ['table', 'โต๊ะ', isEl((e) => e.type === 'field' && e.field === 'table')],
    ['staff', 'พนักงาน', isEl((e) => e.type === 'field' && e.field === 'staff')],
    ['items', 'รายการสินค้า', isEl((e) => e.type === 'items')],
    ['options', '↳ ตัวเลือกของสินค้า (เส้น/เผ็ด/ท็อปปิ้ง)', isEl((e) => e.type === 'items'), 'show_options'],
    ['prices', '↳ ราคาแต่ละรายการ', isEl((e) => e.type === 'items'), 'show_price'],
    ['discount', 'ส่วนลด', isEl((e) => e.type === 'totals'), 'discount'],
    ['vat', 'VAT / ค่าบรรจุภัณฑ์', isEl((e) => e.type === 'totals'), 'vat'],
    ['total', 'ยอดสุทธิ', isEl((e) => e.type === 'totals')],
    ['pay', 'วิธีชำระ / เงินทอน', isEl((e) => e.type === 'payments')],
    ['qr', 'QR เปิดดูบิล (ไม่ต้องเข้าสู่ระบบ)', isEl((e) => e.type === 'qr')],
    ['barcode', 'บาร์โค้ดเลขบิล', isEl((e) => e.type === 'barcode')],
    ['sep', 'เส้นคั่นระหว่างบิล', null],
  ];
  const partsBox = h('div', { class: 'mparts' });
  let tdata = null;
  const compactTpl = () => tpl.templates.find((x) => x.id === mTpl.value) || tpl.templates.find((x) => x.doc_type === 'merchant' && x.name === tpl.compact_merchant_name);
  const drawParts = () => {
    const t = compactTpl();
    if (!t) return partsBox.replaceChildren(h('p', { class: 'small muted' }, 'ไม่พบแม่แบบแบบย่อ'));
    tdata = structuredClone(t.data);
    const els = tdata.elements;
    const lastDiv = () => [...els].reverse().find((e) => e.type === 'divider');
    // an element the template does not have yet comes from the built-in compact layout, placed before the next known one
    const ensure = (pred) => {
      let e = els.find(pred); if (e) return e;
      const ci = C.elements.findIndex(pred); if (ci < 0) return null;
      e = structuredClone(C.elements[ci]);
      const after = C.elements.slice(ci + 1).map((x) => els.findIndex((y) => JSON.stringify(y.type + (y.field || y.text || '')) === JSON.stringify(x.type + (x.field || x.text || '')))).find((i) => i >= 0);
      els.splice(after ?? els.length, 0, e); return e;
    };
    const on = ([k, , pred, flag]) => {
      if (k === 'sep') { const d = lastDiv(); return !!d && !d.hidden; }
      const e = els.find(pred); if (!e || e.hidden) return false;
      if (flag === 'discount') return (e.show || []).includes('discount');
      if (flag === 'vat') return (e.show || []).includes('tax');
      if (flag) return e[flag] !== false;
      return true;
    };
    const set = ([k, , pred, flag], v) => {
      if (k === 'sep') { const d = lastDiv() || (els.push({ type: 'divider', style: 'dash' }), els[els.length - 1]); d.hidden = !v; return; }
      const e = v ? ensure(pred) : els.find(pred); if (!e) return;
      if (flag === 'discount' || flag === 'vat') {
        const keys = flag === 'vat' ? ['packaging', 'tax'] : ['discount'];
        e.show = (e.show || ['total']).filter((x) => !keys.includes(x)); if (v) e.show = [...keys, ...e.show];
        e.show.sort((a, b) => ['items_total', 'discount', 'packaging', 'tax', 'total'].indexOf(a) - ['items_total', 'discount', 'packaging', 'tax', 'total'].indexOf(b));
        if (v) e.hidden = false;
      } else if (flag) { e[flag] = v; if (v) e.hidden = false; }
      else e.hidden = !v;
    };
    const feed = h('input', { class: 'input', type: 'number', min: 0, max: 8, value: tdata.feed_after ?? 1, style: { width: '80px' } });
    const fs = h('input', { type: 'range', min: 80, max: 130, step: 5, value: 100 });
    const fsOut = h('b', {}, '100%');
    fs.addEventListener('input', () => { fsOut.textContent = fs.value + '%'; });
    partsBox.replaceChildren(h('div', { class: 'mparts-grid' }, PARTS.map((p) => { const cb = h('input', { type: 'checkbox', checked: on(p) }); cb.addEventListener('change', () => set(p, cb.checked)); return h('label', { class: 'switch' }, cb, p[1]); })),
      h('div', { class: 'row', style: { marginTop: '.6em', flexWrap: 'wrap', gap: '1em' } }, h('label', { class: 'small' }, 'เว้นกระดาษระหว่างบิล (บรรทัด) ', feed), h('label', { class: 'small' }, 'ขนาดตัวอักษร ', fs, ' ', fsOut),
        h('a', { href: '#/designer', class: 'small' }, 'ปรับละเอียด (ขนาด ตำแหน่ง ฟอนต์) ในหน้าออกแบบเอกสาร →')));
    partsBox._save = async () => {
      tdata.feed_after = Math.max(0, Math.min(8, Number(feed.value) || 0));
      const k = Number(fs.value) / 100;
      if (k !== 1) for (const e of tdata.elements) { for (const f of ['size', 'total_size']) if (e[f]) e[f] = Math.max(12, Math.round(e[f] * k)); if (e.size_mm) e.size_mm = Math.max(12, Math.round(e.size_mm * k)); }
      await api.put('/templates/' + t.id, { data: tdata });
      t.data = structuredClone(tdata);
    };
  };
  const partsRow = h('div', {}, h('h4', {}, 'แสดงอะไรบ้างในใบสรุปแบบย่อ'), partsBox);
  // closing the shift: feed the roll out to tear it off, or feed + cut on printers with a cutter
  const endFeed = h('input', { class: 'input', type: 'number', min: 1, max: 30, value: P0.merchant_end_feed ?? 6 });
  const endCut = h('input', { type: 'checkbox', checked: P0.merchant_end_cut !== false });
  const endRow = h('div', {}, h('h4', {}, '🧻 ตอนปิดรอบ'), h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'ป้อนกระดาษออกมา (บรรทัด) ให้ฉีกได้', endFeed)),
    h('label', { class: 'switch' }, endCut, 'ตัดกระดาษด้วย (เฉพาะเครื่องที่มี auto cut — ตั้ง "การตัด" ของเครื่องไว้ไม่ใช่ "ไม่ตัด")'),
    h('p', { class: 'small muted' }, 'หน้าปิดรอบบน POS มีปุ่ม "ป้อนกระดาษเพิ่ม" และ "ตัดกระดาษ" ระหว่างนับถอยหลัง'));
  mTpl.addEventListener('change', drawParts);
  // the whole shift's merchant summary, printed at close (the POS confirms the paper and waits until it's printed)
  const mClose = h('input', { type: 'checkbox', checked: !!P0.merchant_close });
  const mClosePaper = h('select', { class: 'input' }, [[58, '58 มม. (POS จะเตือนให้เช็ก/เปลี่ยนกระดาษก่อนพิมพ์)'], [80, '80 มม.']].map(([v, t]) => h('option', { value: v, selected: Number(P0.merchant_close_paper || 58) === v }, t)));
  const mClosePrinter = h('select', { class: 'input' }, h('option', { value: '' }, '— เครื่องเดียวกับใบสรุปร้านค้า —'), printers.filter((x) => x.active).map((x) => h('option', { value: x.id, selected: P0.merchant_close_printer_id === x.id }, `${x.name} (${x.paper} มม.)`)));
  const closeRow = h('div', {}, h('h4', {}, '🧾 พิมพ์ใบสรุปร้านค้าตอนปิดรอบ (รวมทุกบิลของรอบ)'),
    h('label', { class: 'switch' }, mClose, 'พิมพ์ตอนปิดรอบ — ระบบรอจนพิมพ์เสร็จแล้วจึงกลับหน้าหลัก'),
    h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'ขนาดกระดาษ', mClosePaper), h('label', { class: 'field' }, 'พิมพ์ที่เครื่อง', mClosePrinter)),
    h('p', { class: 'small muted' }, 'ถ้าไม่ต้องการใบสรุปทุกบิล ให้ปิด "พิมพ์ใบสรุปร้านค้าอัตโนมัติทุกครั้งที่ชำระเงิน" ด้านบน แล้วใช้แบบตอนปิดรอบแทน'));
  const syncM = () => { tplRow.hidden = partsRow.hidden = endRow.hidden = mStyle.value !== 'compact'; if (mStyle.value === 'compact') drawParts(); };
  mStyle.addEventListener('change', syncM); syncM();
  const merchantCard = card(h('h3', {}, '🧾 ใบสรุปร้านค้า (ทุกบิล)'),
    h('p', { class: 'small muted' }, 'แบบย่อพิมพ์บิลละไม่กี่บรรทัด: เลขคิว เลขบิล เวลา ยอดเงิน วิธีชำระ และ QR ดูรายละเอียดบิล ต่อกันเป็นม้วนโดยไม่ตัดกระดาษ — ฉีกออกตอนปิดรอบได้เลย'),
    h('label', { class: 'switch' }, mAuto, 'พิมพ์ใบสรุปร้านค้าอัตโนมัติทุกครั้งที่ชำระเงิน'),
    h('div', { class: 'form-grid', style: { marginTop: '.6em' } }, h('label', { class: 'field' }, 'รูปแบบ', mStyle), h('label', { class: 'field' }, 'พิมพ์ที่เครื่อง', mPrinter), tplRow),
    partsRow, endRow, closeRow,
    h('div', { style: { marginTop: '.6em' } }, saveBtn('บันทึกใบสรุปร้านค้า', async () => {
      const cur = (await api.get('/settings')).print || {};
      if (mStyle.value === 'compact' && partsBox._save) await partsBox._save();
      await saveKey('print', { ...cur, auto_merchant: mAuto.checked, merchant_style: mStyle.value, merchant_printer_id: mPrinter.value, merchant_template_id: mTpl.value,
        merchant_end_feed: Math.max(1, Math.min(30, Number(endFeed.value) || 6)), merchant_end_cut: endCut.checked,
        merchant_close: mClose.checked, merchant_close_paper: Number(mClosePaper.value), merchant_close_printer_id: mClosePrinter.value });
    })));
  return page('เครื่องพิมพ์', cookerCard, merchantCard, h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มเครื่องพิมพ์'),
    h('p', { class: 'small muted' }, 'หลายงานที่ใช้เครื่องเดียวกันจะเข้าคิวพิมพ์ทีละงานตามลำดับ ไม่ปะปน · สถานะ "เครื่องรับงานแล้ว" หมายถึงส่งข้อมูลถึงเครื่องแต่เครื่องไม่รายงานผลพิมพ์ · "พิมพ์สำเร็จ" เฉพาะเมื่อเครื่องตอบสถานะปกติ'),
    card(table([{ t: 'ชื่อ', k: 'name' }, { t: 'ช่องทาง', f: (p) => `${p.conn} ${p.address || ''}${p.port ? ':' + p.port : ''}` }, { t: 'กระดาษ', f: (p) => p.paper + ' มม.' }, { t: 'งาน', f: (p) => p.roles.join(', ') },
      { t: 'อุปกรณ์', f: (p) => (terms.find((t) => t.id === p.host_terminal_id) || {}).name || p.host_terminal_id || '-' }, { t: 'สถานะล่าสุด', f: (p) => (p.status ? `${p.status} (${fmtTime(p.status_at)})` : '-') }, { t: '', f: (p) => (p.active ? '' : 'ปิด') }], printers, { onRow: open })),
    card(h('h3', {}, 'ประวัติงานพิมพ์'), table([{ t: 'เวลา', f: (j) => fmtTime(j.created_at) }, { t: 'เครื่อง', k: 'printer_name' }, { t: 'เอกสาร', k: 'doc_type' }, { t: 'สถานะ', f: (j) => h('span', { class: 'badge ' + (j.status === 'printed' ? 'ok' : j.status === 'sent' ? 'info' : ['failed', 'unknown'].includes(j.status) ? 'bad' : '') }, JOB_TH[j.status] || j.status) },
      { t: 'ครั้ง', r: 1, k: 'attempts' }, { t: 'ข้อผิดพลาด', k: 'error' }, { t: '', f: (j) => h('div', { class: 'row' }, ['failed', 'unknown'].includes(j.status) ? h('button', { class: 'btn sm', onclick: async () => { await api.post(`/print/jobs/${j.id}/retry`); reload(); } }, 'ลองใหม่') : null,
        ['queued', 'failed', 'unknown'].includes(j.status) ? h('button', { class: 'btn sm ghost', onclick: async () => { await api.post(`/print/jobs/${j.id}/cancel`); reload(); } }, 'ยกเลิก') : null) }], jobs)));
}

export async function devicesPage() {
  const [terms, pairings] = await Promise.all([api.get('/terminals'), api.get('/display/pairings')]);
  return page('เครื่องขายและอุปกรณ์',
    card(h('h3', {}, 'เครื่องขาย'), h('button', { class: 'btn', onclick: async () => { const n = prompt('ชื่อเครื่องขาย'); if (n) { await api.post('/terminals', { name: n }); reload(); } } }, '+ เพิ่มเครื่องขาย'),
      table([{ t: 'ชื่อ', k: 'name' }, { t: 'ออนไลน์ล่าสุด', f: (t) => fmtTime(t.last_seen) }, { t: 'อุปกรณ์รายงาน', f: (t) => { const i = t.info ? JSON.parse(t.info) : null; return i ? `USB:${i.support.usb ? '✓' : '✗'} Serial:${i.support.serial ? '✓' : '✗'} BT:${i.support.bluetooth ? '✓' : '✗'} Android:${i.support.bridge ? '✓' : '✗'} · เครื่องพิมพ์ที่จับคู่ ${i.printers.length} · Dual Screen ${i.dual_screen ? 'ใช้' : '-'}` : '-'; } }], terms)),
    card(h('h3', {}, 'จอลูกค้าที่จับคู่'), table([{ t: 'เครื่องขาย', k: 'terminal_name' }, { t: 'รูปแบบ', f: (p) => (p.mode === 'dual' ? 'Dual Screen' : 'ลิงก์+รหัส') }, { t: 'สัมผัสได้', f: (p) => (p.touch ? 'ใช่' : 'ไม่') }, { t: 'จับคู่เมื่อ', f: (p) => fmtTime(p.used_at) },
      { t: 'ออนไลน์ล่าสุด', f: (p) => fmtTime(p.last_seen) }, { t: '', f: (p) => (p.revoked ? h('span', { class: 'badge bad' }, 'ยกเลิกแล้ว') : can('manage_printers') ? h('button', { class: 'btn sm danger', onclick: async () => { await api.post(`/display/pairings/${p.id}/revoke`); reload(); } }, 'ยกเลิกการจับคู่') : '') }], pairings)));
}

export async function auditPage() {
  const rows = await api.get('/audit');
  return page('ประวัติการแก้ไขสำคัญ', card(table([{ t: 'เวลา', f: (a) => fmtTime(a.created_at) }, { t: 'ผู้ทำ', f: (a) => a.actor_name || a.actor }, { t: 'การกระทำ', k: 'action' }, { t: 'ข้อมูล', f: (a) => `${a.entity} ${a.entity_id || ''}` },
    { t: 'ก่อน', f: (a) => h('code', { class: 'small' }, a.before_val ? JSON.stringify(a.before_val).slice(0, 160) : '') }, { t: 'หลัง', f: (a) => h('code', { class: 'small' }, a.after_val ? JSON.stringify(a.after_val).slice(0, 160) : '') }, { t: 'เหตุผล', k: 'reason' }], rows)));
}

// ---------------- screen lock when the POS is left untouched ----------------
export async function lockPage() {
  const L = { enabled: true, seconds: 300, warn: 10, action: 'lock', keep_with_bill: false, ...((await api.get('/settings')).lock || {}) };
  const on = h('input', { type: 'checkbox', checked: !!L.enabled });
  const PRESETS = [[30, '30 วินาที'], [60, '1 นาที'], [120, '2 นาที'], [180, '3 นาที'], [300, '5 นาที'], [600, '10 นาที'], [900, '15 นาที'], [1800, '30 นาที'], [3600, '1 ชั่วโมง']];
  let secs = L.seconds;
  const num = h('input', { class: 'input', type: 'number', min: 1 });
  const unit = h('select', { class: 'input' }, h('option', { value: 1 }, 'วินาที'), h('option', { value: 60 }, 'นาที'));
  const chips = h('div', { class: 'row' });
  const setSecs = (v) => { secs = v; const m = v % 60 === 0; unit.value = m ? 60 : 1; num.value = m ? v / 60 : v; drawChips(); };
  const drawChips = () => chips.replaceChildren(...PRESETS.map(([v, t]) => h('button', { type: 'button', class: 'chip' + (secs === v ? ' on' : ''), onclick: () => setSecs(v) }, t)));
  const fromInputs = () => { secs = Math.max(15, Math.round((Number(num.value) || 0) * Number(unit.value))); drawChips(); };
  num.oninput = fromInputs; unit.onchange = fromInputs;
  setSecs(secs);
  const warn = h('select', { class: 'input' }, [[0, 'ไม่เตือน'], [5, '5 วินาที'], [10, '10 วินาที'], [15, '15 วินาที'], [30, '30 วินาที']].map(([v, t]) => h('option', { value: v, selected: Number(L.warn) === v }, t)));
  const action = h('select', { class: 'input' }, [['lock', '🔒 ล็อกหน้าจอ — ใส่ PIN คนเดิมเพื่อใช้งานต่อ (หรือสลับผู้ใช้)'], ['logout', '🚪 ออกจากระบบ — กลับหน้าสแกนบัตรพนักงาน']].map(([v, t]) => h('option', { value: v, selected: L.action === v }, t)));
  const keep = h('input', { type: 'checkbox', checked: !!L.keep_with_bill });
  const body = h('div', {}, h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'ไม่มีการใช้งานนานเท่าไหร่', h('div', { style: 'display:grid;grid-template-columns:1fr 130px;gap:8px' }, num, unit)), h('label', { class: 'field' }, 'เตือนนับถอยหลังก่อน', warn)),
    h('div', { style: { margin: '.4em 0 .8em' } }, chips),
    h('label', { class: 'field' }, 'เมื่อครบเวลา', action),
    h('label', { class: 'switch' }, keep, 'ไม่ล็อกระหว่างมีรายการในบิล (กำลังคีย์ขาย)'));
  const sync = () => { body.style.opacity = on.checked ? 1 : 0.45; body.style.pointerEvents = on.checked ? '' : 'none'; };
  on.onchange = sync; sync();
  return page('ล็อกหน้าจอ (Inactive)', card(h('h3', {}, '🔒 ล็อกหน้าจอเมื่อไม่มีการใช้งาน'),
    h('p', { class: 'small muted' }, 'ถ้าไม่มีใครแตะหน้าจอ POS หรือกดปุ่มเลยตามเวลาที่ตั้ง ระบบจะล็อกหน้าจอ (หรือออกจากระบบ) ให้เอง · ก่อนล็อกมีนับถอยหลังให้แตะเพื่อใช้งานต่อ · มีผลกับทุกเครื่องขายทันทีที่บันทึก'),
    h('label', { class: 'switch', style: { margin: '.4em 0 1em', fontWeight: 800 } }, on, 'เปิดใช้การล็อกหน้าจออัตโนมัติ (ปิด = ไม่ล็อกเลย)'),
    body,
    h('div', { style: { marginTop: '1em' } }, saveBtn('บันทึก', () => saveKey('lock', { enabled: on.checked, seconds: secs, warn: Number(warn.value), action: action.value, keep_with_bill: keep.checked })))));
}
