import { h, toast, errToast, modal, confirmBox } from '/shared/ui.js';
import { renderDoc, paperDots, ELEMENT_TYPES, FIELD_LABELS, VARS } from '/shared/render.js';
import { fontCatalog } from '/shared/fonts.js';
import { api, ctx, page, card } from './common.js';

const SAMPLES = {
  short: { label: 'บิลสั้น', items: [{ name: 'มาม่าเกาหลีต้นตำรับ', qty: 1, options: [{ name: 'ชินราเมียน' }, { name: 'เผ็ดกลาง' }], line_total: 7900, dine_type: 'dine_in', bowl_group: 1, bowl_label: 'ชามที่ 1' }],
    totals: { items_total: 7900, discount: 0, packaging: 0, tax: 0, total: 7900 }, bowls: 1, dine_type: 'dine_in' },
  long: { label: 'บิลยาว', items: Array.from({ length: 9 }, (_, i) => ({ name: ['มาม่าชีสยืด', 'ต๊อกบกกีทอด', 'ชาเย็น', 'ไข่ออนเซ็น', 'คิมบับ'][i % 5], qty: (i % 3) + 1, options: i % 2 ? [{ name: 'เผ็ดมาก', price: 0 }, { name: 'ชีส', price: 1500 }] : [], line_total: 5900 * ((i % 3) + 1), dine_type: i % 4 === 0 ? 'takeaway' : 'dine_in', note: i === 2 ? 'ไม่ใส่น้ำแข็ง' : '' })),
    totals: { items_total: 112100, discount: 5000, packaging: 1000, tax: 7400, total: 108100 }, bowls: 5, dine_type: 'mixed' },
  thai: { label: 'ชื่อไทยหลายบรรทัด', items: [{ name: 'มาม่าเกาหลีต้มยำทะเลรวมมิตรชีสเยิ้มพิเศษใส่ไข่ออนเซ็นสองฟองและไส้กรอกจัมโบ้', qty: 2, options: [{ name: 'บูลดักเผ็ดนรก', price: 1000 }, { name: 'เพิ่มต๊อกบกกีชิ้นใหญ่', price: 2000 }], line_total: 33800, dine_type: 'takeaway', note: 'แยกน้ำซุป ไม่ใส่ผักชี ต้นหอม' }],
    totals: { items_total: 33800, discount: 0, packaging: 500, tax: 0, total: 34300 }, bowls: 2, dine_type: 'takeaway' },
};
const base = { store_name: 'Oppa Ramyeon', branch: 'สาขาหลัก', address: '123 ถนนสุขุมวิท กรุงเทพฯ', phone: '02-000-0000', tax_id: '0105500000000', bill_no: 'B261023-0042', queue_no: 'T042',
  table: 'A3', customer: 'คุณมินจู', member: 'จีซู (M000123)', staff: 'แคชเชียร์', datetime: '23/10/2569 19:42', footer: 'ขอบคุณที่อุดหนุน 감사합니다', claim_available: true,
  points_mode: 'claim', claim_points: 43, claim_deadline: '26/10/2569 19:42', points_earned: 43, member_points: 386, member_display: 'จีซู · M000123', member_tier: 'Gold',
  claim_url: location.origin + '/member/#/claim/SAMPLE', mobile_url: location.origin + '/m/#SAMPLE', mobile_ref: 'MO-ABC123', mobile_target: 'โต๊ะ A3', mobile_expires: '23/10/2569 22:42',
  ticket_kind: 'ออเดอร์ใหม่', received_time: '24/10/69 15:38:37', table_or_type: 'โต๊ะ: V.22', detail_url: location.origin + '/admin/#/bill/B261023-0042', pay_methods: 'เงินสด', count_unit: 'ชาม', ticket_part: 'ใบที่ 1/2 · ชามที่ 1', bowl_part: 'ชามที่ 1/2', cooker: 'ต้มโดย เครื่องต้ม 1', cooker_ready: 'คาดว่าจะเสร็จตอน 15:42 น.', station: 'ครัวมาม่า', order_note: 'ลูกค้าแพ้กุ้ง', reason: 'ลูกค้าเปลี่ยนใจ', refund_amount: '79.00', reward_name: 'ไข่ออนเซ็นฟรี',
  coupon_code: 'K7M2Q9XA', points_used: 20, payments: [{ method: 'เงินสด', amount: 7900, change: 2100 }], tax_rate: 7, tax_inclusive: true,
  shift: { terminal_name: 'เครื่องขาย 1', staff_name: 'แคชเชียร์', opened_at: new Date().toISOString(), opening_cash: 100000, bills: 42, net_bowls: 51, net_sales: 452300, discount: 1200, voids: { count: 1, amount: 7900 }, refunds: { count: 0, amount: 0 },
    payments: [{ name: 'เงินสด', count: 30, amount: 300000 }, { name: 'QR พร้อมเพย์', count: 12, amount: 152300 }], cash_in: 0, cash_out: 5000, expected_cash: 395000, counted_cash: 395000, diff: 0 } };

export async function designerPage() {
  const [tp, fonts, printers] = await Promise.all([api.get('/templates'), fontCatalog(true), api.get('/printers')]);
  const families = ['Sarabun', ...new Set(fonts.map((f) => f.family))];
  let docType = 'receipt', current = null, data = null, sel = -1, sample = 'short';
  const listBox = h('div'), editBox = h('div'), propBox = h('div'), warnBox = h('div');
  const canvas = h('canvas');
  const pick = (t) => { current = t; data = structuredClone(t.data); sel = -1; drawEditor(); drawPreview(); };
  const drawList = () => {
    const mine = tp.templates.filter((t) => t.doc_type === docType);
    listBox.replaceChildren(h('div', { class: 'tabs', style: { marginBottom: '.6em' } }, Object.entries(tp.doc_types).map(([k, n]) => h('button', { class: 'tab' + (k === docType ? ' active' : ''), onclick: () => { docType = k; drawList(); const d = tp.templates.find((t) => t.doc_type === k && t.is_default) || tp.templates.find((t) => t.doc_type === k); if (d) pick(d); } }, n))),
      h('div', { class: 'row' }, mine.map((t) => h('button', { class: 'btn sm' + (current && current.id === t.id ? ' primary' : ''), onclick: () => pick(t) }, t.name, t.is_default ? ' ★' : '')),
        h('button', { class: 'btn sm', onclick: async () => { const r = await api.post('/templates', { doc_type: docType, name: 'แม่แบบใหม่', data: tp.defaults[docType] }); await refresh(r.id); } }, '+ แม่แบบใหม่')));
  };
  const refresh = async (selectId) => { Object.assign(tp, await api.get('/templates')); drawList(); const t = tp.templates.find((x) => x.id === (selectId || (current && current.id))); if (t) pick(t); };
  const numIn = (obj, k, label, step = 1) => { const i = h('input', { class: 'input', type: 'number', step, value: obj[k] ?? '' }); i.oninput = () => { obj[k] = i.value === '' ? undefined : Number(i.value); drawPreview(); }; return h('label', { class: 'field' }, label, i); };
  const txtIn = (obj, k, label, area) => { const i = h(area ? 'textarea' : 'input', { class: 'input', rows: 3 }, area ? obj[k] ?? '' : null); if (!area) i.value = obj[k] ?? ''; i.oninput = () => { obj[k] = i.value; drawPreview(); }; return h('label', { class: 'field' }, label, i); };
  const selIn = (obj, k, label, opts) => { const s = h('select', { class: 'input' }, opts.map(([v, t]) => h('option', { value: v, selected: String(obj[k] ?? '') === String(v) }, t))); s.onchange = () => { obj[k] = s.value === '' ? undefined : isNaN(s.value) || s.value === '' ? s.value : Number(s.value); drawPreview(); }; return h('label', { class: 'field' }, label, s); };
  const boolIn = (obj, k, label) => { const c = h('input', { type: 'checkbox', checked: !!obj[k] }); c.onchange = () => { obj[k] = c.checked; drawPreview(); }; return h('label', { class: 'switch' }, c, label); };
  const fontOpts = [['', '(ตามแม่แบบ)'], ...families.map((f) => [f, f])];
  const drawEditor = () => {
    if (!data) return editBox.replaceChildren(h('div', { class: 'empty' }, 'เลือกแม่แบบ'));
    const name = h('input', { class: 'input', value: current.name });
    editBox.replaceChildren(
      h('div', { class: 'row' }, name, h('button', { class: 'btn primary', onclick: async () => { const r = await api.put('/templates/' + current.id, { name: name.value, data }).catch(errToast); if (r) { toast('บันทึกแม่แบบแล้ว', 'ok'); refresh(); } } }, 'บันทึกแม่แบบ'),
        h('button', { class: 'btn', onclick: async () => { const r = await api.post('/templates', { doc_type: docType, name: current.name + ' (สำเนา)', data }); refresh(r.id); } }, 'ทำสำเนา'),
        h('button', { class: 'btn', onclick: async () => { if (await confirmBox('คืนค่าเริ่มต้น', 'แทนที่องค์ประกอบด้วยแม่แบบเริ่มต้น?', 'คืนค่า')) { data = structuredClone(tp.defaults[docType]); drawEditor(); drawPreview(); } } }, 'คืนค่าเริ่มต้น'),
        h('button', { class: 'btn', onclick: async () => { await api.put('/templates/' + current.id, { is_default: true }); refresh(); } }, current.is_default ? '★ แม่แบบหลัก' : 'ตั้งเป็นแม่แบบหลัก'),
        h('button', { class: 'btn danger', onclick: async () => { if (await confirmBox('ลบแม่แบบ', current.name, 'ลบ', true)) { await api.del('/templates/' + current.id); current = null; data = null; refresh(); } } }, 'ลบ')),
      h('div', { class: 'form-grid', style: { marginTop: '.8em' } }, selIn(data, 'paper', 'ขนาดกระดาษ', [[80, '80 มม. (576 จุด)'], [58, '58 มม. (384 จุด)']]), numIn(data, 'width_dots', 'ความกว้างพื้นที่พิมพ์ (จุด, เว้นว่าง=อัตโนมัติ)'),
        numIn(data, 'margin', 'ระยะขอบ (จุด)'), numIn(data, 'section_gap', 'ระยะห่างระหว่างส่วน'), numIn(data, 'line_height', 'ระยะบรรทัด', 0.05), selIn(data, 'font', 'ฟอนต์หลัก', families.map((f) => [f, f])),
        numIn(data, 'size', 'ขนาดตัวอักษรหลัก (จุด)'), numIn(data, 'copies', 'จำนวนสำเนา'), numIn(data, 'feed_after', 'ป้อนกระดาษหลังพิมพ์'),
        selIn(data, 'cut', 'การตัด', [['full', 'ตัดเต็ม'], ['partial', 'ตัดบางส่วน'], ['none', 'ไม่ตัด']])),
      h('h4', {}, 'องค์ประกอบ (ลากเรียงด้วยปุ่ม ↑↓)'),
      ...data.elements.map((e, i) => h('div', { class: 'el-row' + (i === sel ? ' sel' : ''), onclick: () => { sel = i; drawEditor(); } },
        h('label', { class: 'switch', onclick: (ev) => ev.stopPropagation() }, (() => { const c = h('input', { type: 'checkbox', checked: !e.hidden }); c.onchange = () => { e.hidden = !c.checked; drawPreview(); }; return c; })()),
        h('div', {}, h('strong', {}, ELEMENT_TYPES[e.type] || e.type), ' ', h('span', { class: 'small muted' }, e.field ? FIELD_LABELS[e.field] || e.field : e.text ? e.text.slice(0, 30) : e.value || '')),
        h('div', { class: 'row', onclick: (ev) => ev.stopPropagation() }, h('button', { class: 'btn sm', disabled: i === 0, onclick: () => { data.elements.splice(i - 1, 0, data.elements.splice(i, 1)[0]); sel = i - 1; drawEditor(); drawPreview(); } }, '↑'),
          h('button', { class: 'btn sm', disabled: i === data.elements.length - 1, onclick: () => { data.elements.splice(i + 1, 0, data.elements.splice(i, 1)[0]); sel = i + 1; drawEditor(); drawPreview(); } }, '↓'),
          h('button', { class: 'btn sm danger', onclick: () => { data.elements.splice(i, 1); sel = -1; drawEditor(); drawPreview(); } }, '✕')))),
      h('div', { class: 'row' }, h('select', { class: 'input', style: { width: 'auto' }, id: 'addType' }, Object.entries(ELEMENT_TYPES).map(([k, t]) => h('option', { value: k }, t))),
        h('button', { class: 'btn', onclick: () => { const t = document.getElementById('addType').value; const el = { type: t, align: 'left' }; if (t === 'field') el.field = 'store_name'; if (t === 'text') el.text = 'ข้อความ'; if (t === 'qr') Object.assign(el, { value: '{claim_url}', size_mm: 30, align: 'center' }); if (t === 'barcode') Object.assign(el, { value: '{bill_no}', height: 70 }); if (t === 'space') el.height = 20; if (t === 'logo') el.width_pct = 40; if (t === 'points') Object.assign(el, { size_mm: 30, size: 24 });
          data.elements.splice(sel >= 0 ? sel + 1 : data.elements.length, 0, el); sel = sel >= 0 ? sel + 1 : data.elements.length - 1; drawEditor(); drawPreview(); } }, '+ เพิ่มองค์ประกอบ')),
      h('p', { class: 'small muted' }, 'ตัวแปร: ', VARS.map((v) => `{${v}}`).join(' ')));
    drawProps();
  };
  const drawProps = () => {
    const e = data && data.elements[sel];
    if (!e) return propBox.replaceChildren(h('p', { class: 'muted small' }, 'คลิกองค์ประกอบเพื่อแก้ไขรายละเอียด'));
    const common = [selIn(e, 'align', 'ตำแหน่ง', [['left', 'ซ้าย'], ['center', 'กลาง'], ['right', 'ขวา']]), selIn(e, 'font', 'ฟอนต์', fontOpts), numIn(e, 'size', 'ขนาด (จุด)'), selIn(e, 'weight', 'น้ำหนัก', [['', '-'], [400, 'ปกติ'], [600, 'กึ่งหนา'], [700, 'หนา'], [800, 'หนามาก']]),
      boolIn(e, 'italic', 'ตัวเอียง'), boolIn(e, 'underline', 'ขีดเส้นใต้'), boolIn(e, 'invert', 'พื้นดำตัวขาว'), numIn(e, 'gap', 'ระยะห่างหลังองค์ประกอบ'),
      selIn(e, 'when', 'แสดงเมื่อ', [['', 'เสมอ'], ['bowl_part', 'เฉพาะใบที่มีชาม (เครื่องต้ม)'], ['claim_available', 'บิลยังไม่ได้ให้แต้ม (มี QR รับแต้ม)'], ['reprint', 'เฉพาะพิมพ์ซ้ำ'], ['not_new', 'เฉพาะใบสั่งเพิ่ม/ยกเลิก']])];
    const specific = {
      field: [selIn(e, 'field', 'ข้อมูล', Object.entries(FIELD_LABELS)), txtIn(e, 'label', 'ข้อความนำหน้า'), selIn(e, 'invert_if', 'เน้นพื้นดำเมื่อ', [['', '-'], ['takeaway', 'กลับบ้าน']])],
      text: [txtIn(e, 'text', 'ข้อความ (ใช้ตัวแปรได้)', true)],
      items: [selIn(e, 'style', 'รูปแบบรายการ', [['', 'ใบเสร็จ (จำนวน x ชื่อ ..... ราคา)'], ['kitchen', 'ใบครัว (จำนวนตัวใหญ่ | ชื่อตัวใหญ่)']]), boolIn(e, 'item_divider', 'เส้นคั่นระหว่างรายการ'), boolIn(e, 'show_options', 'แสดงตัวเลือก'), boolIn(e, 'show_note', 'แสดงหมายเหตุ'), boolIn(e, 'show_price', 'แสดงราคา'), boolIn(e, 'show_dine', 'แสดงทานที่ร้าน/กลับบ้านรายรายการ'), boolIn(e, 'group_by_bowl', 'จัดกลุ่มตามชาม')],
      totals: [h('div', { class: 'field' }, 'แสดงยอด', ...['items_total', 'discount', 'packaging', 'tax', 'total'].map((k) => { const c = h('input', { type: 'checkbox', checked: (e.show || []).includes(k) }); c.onchange = () => { e.show = ['items_total', 'discount', 'packaging', 'tax', 'total'].filter((x) => (x === k ? c.checked : (e.show || []).includes(x))); drawPreview(); }; return h('label', { class: 'switch' }, c, { items_total: 'รวมสินค้า', discount: 'ส่วนลด', packaging: 'ค่าบรรจุภัณฑ์', tax: 'ภาษี', total: 'ยอดสุทธิ' }[k]); })), numIn(e, 'total_size', 'ขนาดยอดสุทธิ')],
      divider: [selIn(e, 'style', 'รูปแบบ', [['dash', 'เส้นประ'], ['solid', 'เส้นทึบ'], ['double', 'เส้นคู่']])],
      space: [numIn(e, 'height', 'ความสูง (จุด)')],
      logo: [numIn(e, 'width_pct', 'ความกว้าง % (รักษาสัดส่วน)'), selIn(e, 'align', 'ตำแหน่ง', [['center', 'กลาง'], ['left', 'ซ้าย'], ['right', 'ขวา']]),
        h('div', { class: 'field' }, 'รูปที่ใช้', e.src ? h('img', { src: e.src, style: { maxWidth: '160px', background: '#fff', borderRadius: '8px', padding: '4px' } }) : h('span', { class: 'hint' }, 'ตอนนี้ใช้โลโก้ร้าน (ตั้งค่าร้าน)'),
          (() => { const f = h('input', { type: 'file', accept: 'image/*' }); f.onchange = async () => { const fd = new FormData(); fd.append('file', f.files[0]); const r = await api.post('/files', fd); e.src = r.url; drawProps(); drawPreview(); }; return f; })(),
          e.src ? h('button', { class: 'btn sm', onclick: () => { delete e.src; drawProps(); drawPreview(); } }, 'กลับไปใช้โลโก้ร้าน') : null,
          h('span', { class: 'hint' }, 'อัปโหลดรูปใดก็ได้ (เช่น โลโก้แคมเปญ ตราสัญลักษณ์ ภาพโปรโมชั่น) — แนะนำรูปขาวดำพื้นขาว คมชัด'))],
      image: [numIn(e, 'width_pct', 'ความกว้าง % (รักษาสัดส่วน)'), (() => { const f = h('input', { type: 'file', accept: 'image/*' }); f.onchange = async () => { const fd = new FormData(); fd.append('file', f.files[0]); const r = await api.post('/files', fd); e.src = r.url; drawPreview(); }; return h('label', { class: 'field' }, 'อัปโหลดรูป', f); })()],
      qr: [txtIn(e, 'value', 'ข้อมูล QR (ตัวแปร)'), numIn(e, 'size_mm', 'ขนาด (มม., อย่างน้อย 15)'), txtIn(e, 'caption', 'ข้อความใต้ QR'), numIn(e, 'caption_size', 'ขนาดข้อความ')],
      points: [h('p', { class: 'hint' }, 'พิมพ์อัตโนมัติ: บิลที่ยังไม่มีสมาชิก → กรอบ "สแกนสะสมแต้ม" + QR + จำนวนแต้มที่จะได้ · บิลที่ใส่สมาชิกแล้ว → แต้มที่ได้รับจากบิลนี้และแต้มสะสมทั้งหมด'),
        selIn(e, '_preview', 'ตัวอย่างบนจอ', [['claim', 'ยังไม่เป็นสมาชิก (QR รับแต้ม)'], ['member', 'ใส่สมาชิกแล้ว']]),
        txtIn(e, 'title', 'หัวกรอบ (QR)'), txtIn(e, 'caption', 'ข้อความใต้ QR'), txtIn(e, 'member_title', 'หัวกรอบ (สมาชิก)'), numIn(e, 'size_mm', 'ขนาด QR (มม.)'), numIn(e, 'size', 'ขนาดตัวอักษร')],
      barcode: [txtIn(e, 'value', 'ข้อมูลบาร์โค้ด (A-Z, 0-9)'), numIn(e, 'height', 'ความสูง (จุด)'), numIn(e, 'module', 'ความกว้างแท่ง (จุด, ≥2)')],
    }[e.type] || [];
    propBox.replaceChildren(h('h4', {}, 'แก้ไข: ', ELEMENT_TYPES[e.type]), ...specific, ...(['divider', 'space', 'cut', 'image', 'logo'].includes(e.type) ? [common[0], common[7], common[8]] : common));
  };
  let tmr;
  const drawPreview = () => {
    clearTimeout(tmr);
    tmr = setTimeout(async () => {
      if (!data) return;
      const d = { ...base, ...SAMPLES[sample], logo: ctx.settings.store.logo, store_name: ctx.settings.store.name || base.store_name };
      const pe = data.elements.find((x) => x.type === 'points' && x._preview); if (pe) d.points_mode = pe._preview;
      try {
        const r = await renderDoc(data, d, { canvas, cutMarks: true });
        canvas.style.maxWidth = (data.paper === 58 ? 290 : 420) + 'px';
        warnBox.replaceChildren(...(r.warnings.length ? r.warnings.map((w) => h('div', { class: 'badge warn', style: { whiteSpace: 'normal', marginBottom: '.3em' } }, '⚠️ ' + w)) : [h('div', { class: 'small muted' }, `ไม่มีองค์ประกอบเกินพื้นที่ · กว้าง ${r.width} จุด (${paperDots(data.paper) === r.width ? data.paper + ' มม.' : 'กำหนดเอง'}) · ยาว ${Math.round(r.height / 8)} มม.`)]));
      } catch (e) { warnBox.replaceChildren(h('div', { class: 'badge bad' }, e.message)); }
    }, 120);
  };
  const testBtn = h('div', { class: 'row' }, h('select', { class: 'input', id: 'tprinter', style: { width: 'auto' } }, printers.filter((p) => p.active).map((p) => h('option', { value: p.id }, p.name))),
    h('button', { class: 'btn', onclick: async () => { const id = document.getElementById('tprinter').value; if (!id) return toast('ยังไม่มีเครื่องพิมพ์', 'warn');
      const r = await api.post('/print/test', { printer_id: id, template: data, doc_type: docType, data: { ...base, ...SAMPLES[sample] } }).catch(errToast); if (r) toast('ส่งพิมพ์ทดสอบไปยังอุปกรณ์ที่เชื่อมเครื่องพิมพ์แล้ว', 'ok'); } }, '🖨 พิมพ์ทดสอบ'));
  drawList();
  const first = tp.templates.find((t) => t.doc_type === docType && t.is_default) || tp.templates.find((t) => t.doc_type === docType);
  if (first) pick(first); else drawEditor();
  return page('ออกแบบใบเสร็จและเอกสาร', listBox, h('div', { class: 'designer' }, h('div', {}, card(editBox), card(propBox)),
    h('div', { style: { position: 'sticky', top: '1em' } }, h('div', { class: 'tabs', style: { marginBottom: '.5em' } }, Object.entries(SAMPLES).map(([k, s]) => h('button', { class: 'tab' + (k === sample ? ' active' : ''), onclick: (ev) => { sample = k; ev.target.parentNode.querySelectorAll('.tab').forEach((x) => x.classList.remove('active')); ev.target.classList.add('active'); drawPreview(); } }, s.label))),
      h('div', { class: 'paper' }, canvas), warnBox, testBtn, h('p', { class: 'small muted' }, 'ตัวอย่างนี้ใช้ตัวเรนเดอร์เดียวกับการพิมพ์จริง (raster 203 dpi) ผลพิมพ์จึงตรงกับตัวอย่างภายในข้อจำกัดของเครื่องพิมพ์'))));
}
