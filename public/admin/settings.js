import { h, toast, errToast, modal, fmtTime, JOB_TH } from '/shared/ui.js';
import { baht } from '/shared/core.js';
import { GOOGLE_FONTS, SAMPLE, AREAS, loadFont, hasThai, fontCatalog, familyCss } from '/shared/fonts.js';
import { api, ctx, can, page, card, form, table, saveBtn, upload } from './common.js';

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
    { k: 'auto_lock_minutes', label: 'ล็อกหน้าจออัตโนมัติ (นาที, 0=ปิด)', type: 'number' }], s.sale);
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

export async function paymentsPage() {
  const s = await api.get('/settings');
  const pp = form([{ k: 'promptpay_type', label: 'ประเภทพร้อมเพย์', type: 'select', options: [['phone', 'เบอร์โทรศัพท์'], ['national_id', 'เลขบัตรประชาชน/เลขผู้เสียภาษี 13 หลัก'], ['ewallet', 'e-Wallet ID 15 หลัก']] },
    { k: 'promptpay_id', label: 'หมายเลขพร้อมเพย์' }, { k: 'promptpay_name', label: 'ชื่อผู้รับเงิน (แสดงให้ลูกค้าตรวจสอบ)' }, { k: 'slip_upload', label: 'ให้ลูกค้าแนบสลิปส่งให้พนักงานตรวจ', type: 'bool' },
    { k: 'mock_enabled', label: 'โหมดทดสอบ Mock Gateway (ห้ามเปิดตอนใช้งานจริง)', type: 'bool' }], s.payment);
  const beamCfg = (s.payment.providers || {}).beam || {};
  const beam = form([{ k: 'enabled', label: 'เปิดใช้ Beam Checkout', type: 'bool' }, { k: 'mode', label: 'โหมด', type: 'select', options: [['playground', 'ทดสอบ (playground)'], ['live', 'ใช้งานจริง']] }], beamCfg);
  return page('การรับชำระเงิน',
    card(h('h3', {}, 'พร้อมเพย์ของร้าน'), pp, h('p', { class: 'small', style: { color: 'var(--warn)' } }, '⚠️ การตั้งเลขพร้อมเพย์อย่างเดียวไม่ทำให้ระบบรู้ว่าได้รับเงินจริง — การกด "โอนแล้ว" หรือส่งสลิปของลูกค้าจะไม่เปลี่ยนเป็นชำระแล้ว จนกว่าพนักงานตรวจสอบยอดเงินเข้าและกดยืนยัน'),
      saveBtn('บันทึก', () => saveKey('payment', pp.value()))),
    card(h('h3', {}, 'Payment Gateway: Beam Checkout'), beam,
      h('p', {}, 'ข้อมูลลับเก็บที่ฝั่งเซิร์ฟเวอร์เท่านั้น (ตั้งใน Render → Environment): ', h('code', {}, 'BEAM_MERCHANT_ID'), ', ', h('code', {}, 'BEAM_API_KEY'), ', ', h('code', {}, 'BEAM_WEBHOOK_SECRET'),
        ' — สถานะ: ', beamCfg.secret_set ? h('span', { class: 'badge ok' }, 'ตั้งค่าแล้ว') : h('span', { class: 'badge warn' }, 'ยังไม่ตั้ง')),
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
  const iframe = h('iframe', { src: '/display/?preview=1', style: { width: '100%', aspectRatio: '16/9', border: '1px solid var(--line)', borderRadius: '12px' } });
  const iframeIdle = h('iframe', { src: '/display/?preview=1&phase=idle', style: { width: '100%', aspectRatio: '16/9', border: '1px solid var(--line)', borderRadius: '12px' } });
  const preview = () => { const v = { ...d, ...f.value(), media: d.media }; for (const fr of [iframe, iframeIdle]) fr.contentWindow && fr.contentWindow.postMessage({ display: v }, location.origin); };
  const drawList = () => list.replaceChildren(...d.media.map((m, i) => h('div', { class: 'el-row' }, m.type === 'video' ? h('video', { src: m.url, muted: true, style: { width: '90px' } }) : h('img', { src: m.url, style: { width: '90px', borderRadius: '6px' } }),
    h('div', { class: 'row' }, h('span', {}, m.type === 'video' ? 'วิดีโอ' : 'รูปภาพ'), m.type !== 'video' ? h('label', { class: 'small' }, 'วินาที ', (() => { const x = h('input', { class: 'input', type: 'number', value: m.seconds || '', style: { width: '80px' } }); x.oninput = () => { m.seconds = Number(x.value) || null; }; return x; })()) : null),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { d.media.splice(i - 1, 0, d.media.splice(i, 1)[0]); drawList(); preview(); } }, '↑'), h('button', { class: 'btn sm', disabled: i === d.media.length - 1, onclick: () => { d.media.splice(i + 1, 0, d.media.splice(i, 1)[0]); drawList(); preview(); } }, '↓'),
      h('button', { class: 'btn sm danger', onclick: () => { d.media.splice(i, 1); drawList(); preview(); } }, 'ลบ')))));
  drawList();
  const file = h('input', { type: 'file', accept: 'image/*,video/mp4,video/webm', multiple: true });
  file.onchange = async () => { for (const fl of file.files) { try { const r = await upload(fl, 'video'); d.media.push({ url: r.url, type: r.mime.startsWith('video') ? 'video' : 'image' }); } catch (e) { errToast(e); } } drawList(); preview(); };
  f.addEventListener('input', preview); f.addEventListener('change', preview);
  return page('จอลูกค้า', h('div', { class: 'designer' }, h('div', {}, card(h('h3', {}, 'สื่อประชาสัมพันธ์ขณะไม่มีการขาย'), h('label', { class: 'field' }, 'อัปโหลดรูป/วิดีโอจากเครื่อง', file), list),
    card(h('h3', {}, 'รูปแบบ'), f), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: preview }, 'ดูตัวอย่าง'), saveBtn('บันทึก (จอลูกค้าอัปเดตทันที)', () => saveKey('display', { ...f.value(), media: d.media })))),
  h('div', {}, h('h4', {}, 'ตัวอย่างขณะขาย'), iframe, h('h4', {}, 'ตัวอย่างขณะไม่มีการขาย'), iframeIdle)));
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
  const assign = form([...Object.entries(AREAS).map(([k, t]) => ({ k, label: t, type: 'select', options: [['', k === 'global' ? 'Sarabun' : '(ใช้ฟอนต์หลักทั้งระบบ)'], ...families.map((x) => [x, x])] })),
    { k: 'fallback', label: 'ฟอนต์สำรอง (CSS)', wide: true }, { k: 'size', label: 'ขนาดตัวอักษรหน้าจอ (px)', type: 'number' }, { k: 'weight', label: 'น้ำหนัก', type: 'number' },
    { k: 'line_height', label: 'ระยะบรรทัด', type: 'number', step: '0.05' }, { k: 'letter_spacing', label: 'ระยะตัวอักษร (px)', type: 'number', step: '0.1' }], fonts);
  return page('ศูนย์จัดการฟอนต์',
    card(h('h3', {}, 'ฟอนต์ที่ใช้ในแต่ละส่วน'), h('p', { class: 'small muted' }, 'ฟอนต์ในใบเสร็จ/ใบครัวพิมพ์แบบเรนเดอร์ภาพ (raster) จึงได้รูปแบบตรงกับตัวอย่าง แม้เครื่องพิมพ์ไม่รองรับฟอนต์นั้นโดยตรง — ข้อจำกัด: พิมพ์ช้ากว่าโหมดข้อความเล็กน้อย และความคมชัดขึ้นกับความละเอียด 203 dpi'),
      assign, saveBtn('บันทึกการใช้ฟอนต์', () => saveKey('fonts', assign.value()))),
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
    const roles = [['receipt', 'ใบเสร็จ'], ['kitchen', 'ใบครัว'], ['queue', 'ใบเลขคิว'], ['mobile_qr', 'ใบ Mobile Ordering'], ['refund', 'ใบยกเลิก/คืนเงิน'], ['shift', 'สรุปรอบ'], ['redeem', 'หลักฐานแลกรางวัล']];
    const f = form([{ k: 'name', label: 'ชื่อเครื่อง' }, { k: 'conn', label: 'ช่องทาง', type: 'select', options: [['usb', 'USB (WebUSB)'], ['lan', 'LAN (IP:Port)'], ['bluetooth', 'Bluetooth'], ['serial', 'Serial/COM'], ['agent_usb', 'USB ผ่าน Print Agent'], ['browser', 'เบราว์เซอร์ (A4/ทั่วไป)']] },
      { k: 'address', label: 'IP / Path' }, { k: 'port', label: 'Port', type: 'number' }, { k: 'paper', label: 'กระดาษ', type: 'select', options: [[80, '80 มม.'], [58, '58 มม.']] }, { k: 'margin', label: 'ระยะขอบ (จุด)', type: 'number' },
      { k: 'copies', label: 'จำนวนสำเนา', type: 'number' }, { k: 'cut_mode', label: 'การตัด', type: 'select', options: [['full', 'ตัดเต็ม'], ['partial', 'ตัดบางส่วน (ถ้ารองรับ)'], ['none', 'ไม่ตัด']] },
      { k: 'feed_before', label: 'ป้อนกระดาษก่อนตัด (บรรทัด)', type: 'number' }, { k: 'feed_after', label: 'ป้อนกระดาษหลังพิมพ์ (บรรทัด)', type: 'number' },
      { k: 'buzzer', label: 'ใช้ buzzer ของเครื่อง (ใบครัว)', type: 'bool' }, { k: 'beep_count', label: 'จำนวนครั้ง buzzer', type: 'number' },
      { k: 'roles', label: 'งานที่รับผิดชอบ', type: 'multi', options: roles, wide: true }, { k: 'station_ids', label: 'จุดครัวที่รับ (ไม่เลือก = ทุกจุด)', type: 'multi', options: cat.stations.map((s) => [s.id, s.name]), wide: true },
      { k: 'host_terminal_id', label: 'อุปกรณ์ที่เชื่อมเครื่องพิมพ์', type: 'select', options: [['', '- อุปกรณ์ใดก็ได้ที่จับคู่ -'], ...terms.map((t) => [t.id, t.name])] }, { k: 'active', label: 'ใช้งาน', type: 'bool' }], p || { active: true, paper: 80, port: 9100, copies: 1, feed_before: 3, feed_after: 1, cut_mode: 'full', roles: ['receipt'] });
    const tsel = Object.fromEntries(roles.map(([r, t]) => [r, h('select', { class: 'input' }, h('option', { value: '' }, 'ค่าเริ่มต้น'), tpl.templates.filter((x) => x.doc_type === r).map((x) => h('option', { value: x.id, selected: p && p.templates[r] === x.id }, x.name)))]));
    modal(p ? 'ตั้งค่าเครื่องพิมพ์' : 'เพิ่มเครื่องพิมพ์', h('div', {}, f, h('h4', {}, 'แม่แบบที่ใช้กับเครื่องนี้'), h('div', { class: 'form-grid' }, roles.map(([r, t]) => h('label', { class: 'field' }, t, tsel[r]))),
      h('p', { class: 'small muted' }, 'การค้นหา/จับคู่และทดสอบพิมพ์ต้องทำที่อุปกรณ์หน้างาน (POS → 🖨️ อุปกรณ์) เพราะต้องเข้าถึงฮาร์ดแวร์จริง สถานะจะรายงานกลับมาที่หน้านี้')), { wide: true, actions: [
      p ? { label: 'ปิดใช้งาน', class: 'danger', onClick: async () => { await api.del('/printers/' + p.id); reload(); } } : null,
      p ? { label: 'ส่งหน้าทดสอบไปที่อุปกรณ์', close: false, onClick: async () => { const r = await api.post('/print/test', { printer_id: p.id }); toast(r.jobs.length ? 'ส่งงานทดสอบแล้ว' : 'ไม่ได้สร้างงาน', 'ok'); } } : null,
      { label: 'บันทึก', class: 'primary', onClick: async () => {
        const v = { ...f.value(), paper: Number(f.value().paper), templates: Object.fromEntries(Object.entries(tsel).filter(([, s]) => s.value).map(([r, s]) => [r, s.value])) };
        if (p) await api.put('/printers/' + p.id, v); else await api.post('/printers', v); reload();
      } }].filter(Boolean) });
  };
  return page('เครื่องพิมพ์', h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มเครื่องพิมพ์'),
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
