// Theme & style: preset colours or a custom brand colour, light/dark, corners, text size, POS menu layout, decorations.
// Changes preview live on this page; saving applies to every screen of the shop right away.
import { h, toast, errToast } from '/shared/ui.js';
import { THEME_PRESETS, THEME_DEFAULT, themeOf, applyTheme } from '/shared/theme.js';
import { api, ctx, page, card } from './common.js';

export async function themePage() {
  const saved = { ...THEME_DEFAULT, ...(ctx.settings.theme || {}) };
  const t = { ...saved };
  const box = h('div');
  const apply = () => { applyTheme(t); draw(); };
  const seg = (k, opts) => h('div', { class: 'th-seg' }, opts.map(([v, label, sub]) => h('button', { class: 'th-opt' + (String(t[k]) === String(v) ? ' on' : ''), onclick: () => { t[k] = v; apply(); } }, h('b', {}, label), sub ? h('small', {}, sub) : null)));

  const draw = () => {
    const th = themeOf(t);
    const swatches = Object.entries(THEME_PRESETS).map(([k, p]) => h('button', { class: 'th-preset' + (t.preset === k ? ' on' : ''), onclick: () => { Object.assign(t, { preset: k, brand: '', accent: '' }); apply(); } },
      h('span', { class: 'sw' }, h('i', { style: { background: p.brand } }), h('i', { style: { background: p.accent } }), h('i', { style: { background: p.deep } })), h('b', {}, p.name)));
    const color = h('input', { type: 'color', value: th.brandHex, class: 'th-color' });
    color.addEventListener('input', () => { Object.assign(t, { preset: 'custom', brand: color.value }); applyTheme(t); });
    color.addEventListener('change', () => apply());
    const accent = h('input', { type: 'color', value: th.accentHex, class: 'th-color' });
    accent.addEventListener('input', () => { t.accent = accent.value; if (t.preset !== 'custom') { t.preset = 'custom'; t.brand = th.brandHex; } applyTheme(t); });
    accent.addEventListener('change', () => apply());
    box.replaceChildren(
      h('div', { class: 'th-layout' },
        h('div', {},
          card(h('h3', {}, '🎨 ชุดสี'), h('div', { class: 'th-presets' }, swatches),
            h('div', { class: 'th-custom' }, h('label', { class: 'field' }, 'สีหลักของร้าน (กำหนดเอง)', h('div', { class: 'row' }, color, h('span', { class: 'mono' }, th.brandHex))),
              h('label', { class: 'field' }, 'สีรอง (ไล่สี/จุดเด่น)', h('div', { class: 'row' }, accent, h('span', { class: 'mono' }, th.accentHex))),
              t.preset === 'custom' ? h('span', { class: 'badge brand' }, 'ใช้สีกำหนดเอง') : null)),
          card(h('h3', {}, '🌗 โหมดสว่าง/มืด'), seg('mode', [['auto', 'อัตโนมัติ', 'ตามเครื่อง'], ['light', 'สว่าง', 'พื้นขาว'], ['dark', 'มืด', 'พื้นเข้ม ถนอมสายตา']])),
          card(h('h3', {}, '🔲 รูปทรง'), seg('radius', [['round', 'โค้งมน', 'นุ่มนวล'], ['normal', 'โค้งเล็กน้อย', 'เรียบร้อย'], ['square', 'เหลี่ยม', 'ทันสมัย/มินิมอล']]),
            h('label', { class: 'switch', style: { marginTop: '.8em' } }, (() => { const c = h('input', { type: 'checkbox', checked: t.shapes !== false }); c.onchange = () => { t.shapes = c.checked; apply(); }; return c; })(), 'ลวดลายตกแต่ง (วงกลม/วงแหวน/คลื่น)')),
          card(h('h3', {}, '🔠 ขนาดตัวอักษรทั้งระบบ'), seg('text', [['normal', 'ปกติ'], ['large', 'ใหญ่'], ['xlarge', 'ใหญ่มาก', 'อ่านง่ายบนจอไกล']])),
          card(h('h3', {}, '🛒 รูปแบบเมนูหน้าขาย POS'), seg('pos_layout', [['grid', 'การ์ดรูปภาพ', 'ค่าเริ่มต้น'], ['large', 'การ์ดใหญ่', 'แตะง่ายบนแท็บเล็ต'], ['compact', 'การ์ดเล็ก', 'เห็นเมนูได้มาก'], ['list', 'รายการ', 'รูปเล็ก + ชื่อยาวได้']])),
          card(h('h3', {}, '✨ ลูกเล่นหน้าขาย POS'), seg('pos_fx', [['extra', 'จัดเต็ม', 'เด้ง เรือง บินเข้าตะกร้า'], ['normal', 'ปกติ', 'สวยและลื่น'], ['off', 'ปิด', 'นิ่ง (เครื่องแรงน้อย)']]))),
        h('div', { class: 'th-side' }, card(h('h3', {}, '👀 ตัวอย่าง'), preview(th),
          h('div', { class: 'row', style: { marginTop: '1em' } },
            h('button', { class: 'btn primary', onclick: save }, '💾 บันทึกและใช้กับทุกหน้าจอ'),
            h('button', { class: 'btn', onclick: () => { Object.assign(t, saved); apply(); } }, 'ยกเลิกการแก้ไข'),
            h('button', { class: 'btn ghost', onclick: () => { Object.assign(t, THEME_DEFAULT); apply(); } }, 'ค่าเริ่มต้น')),
          h('p', { class: 'small muted' }, 'มีผลกับ หน้าขาย POS, จอครัว, เว็บไซต์จัดการร้าน, เว็บไซต์สมาชิก, Mobile Ordering และหน้าแรก — เครื่องที่เปิดอยู่เปลี่ยนตามทันทีหลังบันทึก · จอลูกค้าตั้งสีแยกได้ที่เมนู "จอลูกค้า"')))));
  };
  const preview = (th) => h('div', { class: 'th-preview' },
    h('div', { class: 'tp-top' }, h('img', { src: '/assets/bowl.svg', alt: '' }), h('b', {}, ctx.settings.store.name), h('span', { class: 'tp-pill' }, '🧾 บิล'), h('span', { class: 'tp-pill' }, '💰 รอบ')),
    h('div', { class: 'tp-body' },
      h('div', { class: 'tp-tabs' }, h('span', { class: 'on' }, 'ทั้งหมด'), h('span', {}, 'มาม่าเกาหลี'), h('span', {}, 'ท็อปปิ้ง')),
      h('div', { class: 'tp-grid' }, [['มาม่าต้นตำรับ', '79.00'], ['มาม่าชีสยืด', '99.00'], ['ไข่ออนเซ็น', '15.00']].map(([n, p], i) => h('div', { class: 'tp-card' + (i === 1 ? ' picked' : '') },
        h('div', { class: 'tp-img' }, h('img', { src: '/assets/bowl.svg', alt: '' })), h('b', {}, n), h('div', { class: 'tp-price' }, p + ' ฿')))),
      h('div', { class: 'tp-pay' }, h('span', {}, '💳 ชำระเงิน'), h('b', {}, '178.00 ฿')),
      h('div', { class: 'row', style: { marginTop: '.6em' } }, h('span', { class: 'badge brand' }, 'คิว D012'), h('span', { class: 'badge ok' }, 'ชำระแล้ว'), h('span', { class: 'chip-x' }, '+ ชีส'))));
  const save = async (e) => {
    e.target.disabled = true;
    try { const v = await api.put('/settings/theme', { value: t }); ctx.settings.theme = v; Object.assign(saved, v); toast('บันทึกธีมแล้ว — ทุกหน้าจอเปลี่ยนตามทันที', 'ok'); }
    catch (er) { errToast(er); } finally { e.target.disabled = false; }
  };
  draw();
  return page('🎨 ธีมและรูปแบบ', h('p', { class: 'muted' }, 'เปลี่ยนสี โหมดสว่าง/มืด รูปทรง ขนาดตัวอักษร และรูปแบบเมนูหน้าขาย — ดูผลทันทีบนหน้านี้ กดบันทึกเพื่อใช้กับทุกเครื่อง'), box);
}
