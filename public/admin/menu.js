import { h, toast, errToast, modal, confirmBox, fmtTime } from '/shared/ui.js';
import { baht, toSatang } from '/shared/core.js';
import { api, can, page, card, form, table, saveBtn, upload } from './common.js';
import { drawStaffCard, printCards } from '/shared/staffcard.js';

// square centre crop (≤ 720 px) so a profile photo looks right inside a circle
async function squareCrop(fileOrBlob, size = 720) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const side = Math.min(im.naturalWidth, im.naturalHeight), out = Math.min(size, side);
    const c = document.createElement('canvas'); c.width = c.height = out;
    c.getContext('2d').drawImage(im, (im.naturalWidth - side) / 2, (im.naturalHeight - side) / 2, side, side, 0, 0, out, out);
    return await new Promise((res) => c.toBlob((b) => res(new File([b], 'staff.jpg', { type: 'image/jpeg' })), 'image/jpeg', 0.9));
  } finally { URL.revokeObjectURL(url); }
}
// take a profile photo with the device camera, framed by a circle
function cameraDialog(onPhoto) {
  const video = h('video', { autoplay: true, playsinline: true, muted: true });
  const status = h('p', { class: 'small muted', style: { textAlign: 'center' } }, 'กำลังเปิดกล้อง…');
  let stream = null, facing = 'user';
  const start = async () => {
    if (stream) stream.getTracks().forEach((t) => t.stop());
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1080 }, height: { ideal: 1080 } }, audio: false }); video.srcObject = stream; status.textContent = 'จัดหน้าให้อยู่ในวงกลม แล้วกดถ่าย'; }
    catch (e) { status.textContent = 'เปิดกล้องไม่ได้ — อนุญาตกล้องในเบราว์เซอร์ หรือใช้ "เลือกรูป" แทน'; }
  };
  const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); };
  modal('ถ่ายรูปพนักงาน', h('div', {}, h('div', { class: 'cam-circle' }, video, h('i')), status), { onClose: stop, actions: [
    { label: '🔄 สลับกล้อง', close: false, onClick: () => { facing = facing === 'user' ? 'environment' : 'user'; start(); } },
    { label: '📸 ถ่าย', class: 'primary', onClick: async () => {
      if (!video.videoWidth) return false;
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      const x = c.getContext('2d'); if (facing === 'user') { x.translate(c.width, 0); x.scale(-1, 1); } x.drawImage(video, 0, 0);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.92));
      stop(); onPhoto(await squareCrop(blob));
    } }] });
  start();
}

// ---------------- menu ----------------
export async function menuPage(set) {
  const cat = await api.get('/catalog?all=1');
  const ingredients = can('manage_stock') || can('manage_menu') ? await api.get('/ingredients') : [];
  let tab = 'products', filter = '';
  const box = h('div');
  const reload = async () => { Object.assign(cat, await api.get('/catalog?all=1')); draw(); };
  const draw = () => {
    const tabs = h('div', { class: 'tabs', style: { marginBottom: '1em' } }, [['products', 'สินค้า/เมนู'], ['categories', 'หมวดหมู่'], ['options', 'ตัวเลือก/ท็อปปิ้ง'], ['ingredients', 'วัตถุดิบ'], ['stations', 'จุดครัวและการแบ่งใบ'], ['import', '📥 นำเข้าจาก Google Sheet']].map(([k, t]) =>
      h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; draw(); } }, t)));
    let body;
    if (tab === 'products') {
      const q = h('input', { class: 'input', placeholder: 'ค้นหา', value: filter, style: { maxWidth: '260px' } });
      q.addEventListener('input', () => { filter = q.value; drawList(); });
      const list = h('div');
      const drawList = () => list.replaceChildren(table([
        { t: '', f: (p) => (p.image ? h('img', { src: p.image, style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '8px' } }) : '🍜') },
        { t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' }, { t: 'หมวด', f: (p) => (cat.categories.find((c) => c.id === p.category_id) || {}).name || '' },
        { t: 'ราคา', r: 1, f: (p) => baht(p.price) }, can('view_cost') ? { t: 'ต้นทุน', r: 1, f: (p) => (p.cost !== undefined ? baht(p.cost) : '') } : null, { t: 'ชาม', r: 1, k: 'bowl_count' },
        { t: 'สต็อก', r: 1, f: (p) => (p.track_stock ? p.stock : '-') }, { t: 'สถานะ', f: (p) => h('span', { class: 'badge ' + (!p.active ? 'bad' : p.sold_out ? 'warn' : 'ok') }, !p.active ? 'ปิดขาย' : p.sold_out ? 'หมด' : 'ขาย') }].filter(Boolean),
      cat.products.filter((p) => !filter || p.name.includes(filter) || p.code.includes(filter) || p.barcodes.some((b) => b.includes(filter))), { onRow: (p) => productDialog(p, cat, ingredients, reload) }));
      drawList();
      body = h('div', {}, h('div', { class: 'bar' }, q, h('button', { class: 'btn primary', onclick: () => productDialog(null, cat, ingredients, reload) }, '+ เพิ่มเมนู')), list);
    } else if (tab === 'import') {
      body = importBox(reload);
    } else if (tab === 'categories') {
      body = simpleList('categories', cat.categories, [{ k: 'name', label: 'ชื่อหมวด' }, { k: 'sort', label: 'ลำดับ', type: 'number' }, { k: 'color', label: 'สี', type: 'color' }, { k: 'active', label: 'แสดง', type: 'bool' }], reload);
    } else if (tab === 'options') {
      body = h('div', {}, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => optionGroupDialog(null, ingredients, reload) }, '+ เพิ่มกลุ่มตัวเลือก'),
        h('button', { class: 'btn', onclick: () => optionGroupDialog(null, ingredients, reload, { name: 'แบบไข่', min_select: 1, max_select: 1, display: 'quick',
          options: [{ name: 'ออนเซ็น', rename_to: 'ไข่ออนเซ็น' }, { name: 'ไข่ตี', rename_to: 'ไข่ตี' }, { name: 'ต้มสุก', rename_to: 'ไข่ต้มสุก' }].map((o) => ({ ...o, price: 0, cost: 0, recipe: [], active: true })) }) }, '⚡ ตัวอย่าง: แบบไข่ (ออนเซ็น / ไข่ตี / ต้มสุก)'),
        h('button', { class: 'btn', onclick: () => optionGroupDialog(null, ingredients, reload, { name: 'โรยสาหร่ายไหม', topic: 'โรยสาหร่าย', min_select: 1, max_select: 1, display: 'normal',
          options: [{ name: 'โรย', mark: 'yes' }, { name: 'ไม่โรย', mark: 'no' }].map((o) => ({ ...o, price: 0, cost: 0, recipe: [], active: true })) }) }, '✓✕ ตัวอย่าง: โรยสาหร่ายไหม (โรย ✓ / ไม่โรย ✕)')),
        table([{ t: 'กลุ่ม', f: (g) => [g.name, g.display === 'quick' ? h('span', { class: 'badge brand', style: { marginLeft: '.4em' } }, '⚡ เลือกด่วน') : null] }, { t: 'บังคับเลือกอย่างน้อย', r: 1, k: 'min_select' }, { t: 'เลือกได้สูงสุด', r: 1, k: 'max_select' }, { t: 'ตัวเลือก', f: (g) => g.options.map((o) => `${o.mark === 'yes' ? '✓ ' : o.mark === 'no' ? '✕ ' : ''}${o.name}${o.price ? ' +' + baht(o.price) : ''}`).join(', ') }],
          cat.option_groups, { onRow: (g) => optionGroupDialog(g, ingredients, reload) }));
    } else if (tab === 'ingredients') {
      body = simpleList('ingredients', ingredients, [{ k: 'name', label: 'ชื่อวัตถุดิบ' }, { k: 'unit', label: 'หน่วย' }, { k: 'cost', label: 'ต้นทุน/หน่วย (บาท)', type: 'money' }, { k: 'low_stock', label: 'แจ้งเตือนเมื่อเหลือ', type: 'number' }],
        async () => { ingredients.splice(0, ingredients.length, ...(await api.get('/ingredients'))); draw(); }, (x) => `คงเหลือ ${x.stock} ${x.unit || ''}`);
    } else {
      body = h('div', {}, h('p', { class: 'muted' }, 'แต่ละจุดเตรียมอาหารเลือกรูปแบบใบครัวได้: พิมพ์รวมทั้งออเดอร์, แยกตามสินค้า, แยกหนึ่งใบต่อหนึ่งชาม, แยกตามกลุ่มชาม (ท็อปปิ้งอยู่ใบเดียวกับชาม) และตัดทุก N ชาม — การแบ่งใบไม่เปลี่ยนยอดเงินหรือจำนวนสินค้า'),
        simpleList('stations', cat.stations, [{ k: 'name', label: 'ชื่อจุด' }, { k: 'split_mode', label: 'รูปแบบใบครัว', type: 'select', options: [['order', 'พิมพ์รวมทั้งออเดอร์ ตัดครั้งเดียว'], ['item', 'แยกใบตามสินค้า'], ['bowl', 'หนึ่งใบต่อหนึ่งชาม'], ['bowl_group', 'แยกตามกลุ่มชาม (ชามที่ 1, 2…)']] },
          { k: 'bowls_per_ticket', label: 'ตัดทุกกี่ชาม', type: 'number' }, { k: 'sort', label: 'ลำดับ', type: 'number' }], reload, (s) => ({ order: 'รวมทั้งออเดอร์', item: 'แยกตามสินค้า', bowl: 'ใบละชาม', bowl_group: 'ตามกลุ่มชาม' })[s.split_mode] + ` · ตัดทุก ${s.bowls_per_ticket} ชาม`));
    }
    box.replaceChildren(tabs, body);
  };
  draw();
  return page('เมนูและสินค้า', box);
}
function simpleList(path, rows, fields, reload, sub) {
  const open = (row) => {
    const f = form(fields, row || { active: true, sort: 0, bowls_per_ticket: 1, split_mode: 'order' });
    modal(row ? 'แก้ไข' : 'เพิ่ม', f, { actions: [row ? { label: 'ลบ', class: 'danger', onClick: async () => { if (await confirmBox('ลบ', 'ยืนยันการลบ?', 'ลบ', true)) { await api.del(`/${path}/${row.id}`); reload(); } else return false; } } : null,
      { label: 'บันทึก', class: 'primary', onClick: async () => { const v = f.value(); if (row) await api.put(`/${path}/${row.id}`, v); else await api.post('/' + path, v); toast('บันทึกแล้ว', 'ok'); reload(); } }].filter(Boolean) });
  };
  return h('div', {}, h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่ม'), table([{ t: 'ชื่อ', k: 'name' }, { t: '', f: (r) => (sub ? sub(r) : '') }], rows, { onRow: open }));
}
function productDialog(p, cat, ingredients, reload) {
  const v = p ? { ...p, barcodes: (p.barcodes || []).join(', ') } : { active: true, mobile: true, price: 0, cost: 0, bowl_count: 1, unit: 'ที่', kind: 'simple', option_groups: [], recipe: [] };
  const f = form([
    { k: 'code', label: 'รหัสสินค้า *' }, { k: 'name', label: 'ชื่อ *' }, { k: 'barcodes', label: 'บาร์โค้ด (คั่นด้วย ,)', hint: 'หนึ่งสินค้ามีได้หลายบาร์โค้ด' },
    { k: 'category_id', label: 'หมวดหมู่', type: 'select', options: [['', '-'], ...cat.categories.map((c) => [c.id, c.name])] },
    { k: 'price', label: 'ราคาขาย (บาท)', type: 'money' }, { k: 'cost', label: 'ต้นทุน (บาท)', type: 'money', hint: 'เมนูแบบสูตรใช้ต้นทุนวัตถุดิบ ณ เวลาขาย' },
    { k: 'unit', label: 'หน่วยนับ' }, { k: 'kind', label: 'ประเภท', type: 'select', options: [['simple', 'สินค้าสำเร็จรูป'], ['recipe', 'เมนูมีสูตรวัตถุดิบ']] },
    { k: 'bowl_count', label: 'นับเป็นกี่ชาม', type: 'number', step: '1', hint: 'มาม่า=1, เซตคู่=2, ไข่/ชีส/เครื่องดื่ม=0' }, { k: 'per_bowl_limit', label: 'ใส่ได้สูงสุดต่อชาม', type: 'number', hint: '0 = ไม่จำกัด เช่น เส้น 2 ซองต่อชาม' },
    { k: 'station_id', label: 'จุดครัวที่รับรายการ', type: 'select', options: [['', '-'], ...cat.stations.map((s) => [s.id, s.name])] },
    { k: 'option_groups', label: 'ตัวเลือก/ท็อปปิ้ง', type: 'multi', options: cat.option_groups.map((g) => [g.id, g.name]), wide: true },
    { k: 'description', label: 'คำอธิบาย', type: 'textarea', wide: true }, { k: 'image', label: 'รูปภาพ', type: 'image' },
    { k: 'track_stock', label: 'นับสต็อกสินค้านี้', type: 'bool' }, { k: 'low_stock', label: 'แจ้งเตือนใกล้หมดเมื่อเหลือ', type: 'number' },
    { k: 'active', label: 'เปิดขาย', type: 'bool' }, { k: 'sold_out', label: 'สินค้าหมด', type: 'bool' }, { k: 'mobile', label: 'แสดงใน Mobile Ordering', type: 'bool' },
      { k: 'big_options', label: '✨ Add-on พิเศษ: ตัวเลือกปุ่มใหญ่ กดง่าย (หน้าขาย POS)', type: 'bool' }, { k: 'sort', label: 'ลำดับแสดง', type: 'number' },
  ], v);
  const recipe = (p && p.recipe ? p.recipe : []).map((r) => ({ ...r }));
  const rbox = h('div');
  const drawRecipe = () => rbox.replaceChildren(h('h4', {}, 'สูตรวัตถุดิบ (ตัดสต็อกตามสูตรเมื่อขาย)'), ...recipe.map((r, i) => {
    const s = h('select', { class: 'input' }, ingredients.map((x) => h('option', { value: x.id, selected: x.id === r.ingredient_id }, `${x.name} (${x.unit || ''})`)));
    const q = h('input', { class: 'input', type: 'number', step: 'any', value: r.qty, style: { width: '100px' } });
    s.onchange = () => { r.ingredient_id = s.value; }; q.oninput = () => { r.qty = Number(q.value); };
    if (!r.ingredient_id && ingredients[0]) r.ingredient_id = ingredients[0].id;
    return h('div', { class: 'row', style: { marginBottom: '.3em' } }, s, q, h('button', { class: 'btn sm', onclick: () => { recipe.splice(i, 1); drawRecipe(); } }, 'ลบ'));
  }), h('button', { class: 'btn sm', onclick: () => { recipe.push({ ingredient_id: ingredients[0] && ingredients[0].id, qty: 1 }); drawRecipe(); } }, '+ วัตถุดิบ'));
  drawRecipe();
  const reason = h('input', { class: 'input', placeholder: 'เหตุผลการแก้ไข (บันทึกในประวัติ)' });
  modal(p ? 'แก้ไข ' + p.name : 'เพิ่มเมนู', h('div', {}, f, rbox, h('label', { class: 'field', style: { marginTop: '1em' } }, 'เหตุผล', reason),
    h('p', { class: 'small muted' }, 'บิลที่ขายแล้วเก็บชื่อ ราคา ต้นทุน และตัวเลือกเดิมไว้ การแก้ไขมีผลกับบิลใหม่เท่านั้น')), { wide: true, actions: [
    p ? { label: 'ปิดการขาย', class: 'danger', onClick: async () => { await api.del('/products/' + p.id); reload(); } } : null,
    { label: 'บันทึก', class: 'primary', onClick: async () => {
      const val = f.value();
      val.barcodes = String(val.barcodes || '').split(',').map((x) => x.trim()).filter(Boolean);
      val.recipe = recipe.filter((r) => r.ingredient_id && r.qty);
      val.reason = reason.value;
      if (p) await api.put('/products/' + p.id, val); else await api.post('/products', val);
      toast('บันทึกแล้ว — POS ได้รับการเปลี่ยนแปลงอัตโนมัติ', 'ok'); reload();
    } }].filter(Boolean) });
}
function optionGroupDialog(g, ingredients, reload, preset = null) {
  const start = g || preset || { min_select: 0, max_select: 1, display: 'normal' };
  const f = form([{ k: 'name', label: 'ชื่อกลุ่ม เช่น ชนิดเส้น / ระดับความเผ็ด / แบบไข่' }, { k: 'min_select', label: 'ต้องเลือกอย่างน้อย', type: 'number' }, { k: 'max_select', label: 'เลือกได้สูงสุด (0=ไม่จำกัด)', type: 'number' }, { k: 'sort', label: 'ลำดับ', type: 'number' },
    { k: 'display', label: 'รูปแบบการเลือกที่หน้าขาย', type: 'select', wide: true, options: [['normal', 'ปกติ — แสดงในหน้าต่างตัวเลือก'], ['quick', '⚡ เลือกด่วน — แตะสินค้าแล้วขึ้นปุ่มใหญ่ (มีรูปได้) แตะครั้งเดียวเข้าบิล เช่น ไข่ไก่ → ออนเซ็น / ไข่ตี / ต้มสุก']],
      hint: 'เลือกด่วนเหมาะกับ "ตัวเลือกของสินค้ารายการเดียวกัน" ที่ต้องเลือก 1 อย่าง · ถ้าไม่บังคับเลือก จะมีปุ่ม "แบบปกติ" ให้ด้วย' },
    { k: 'rename_all', label: 'ใช้ "ชื่อใหม่เมื่อเลือก" ในใบเสร็จ หน้าจอขาย จอลูกค้า และรายงานด้วย (ไม่ติ๊ก = เปลี่ยนชื่อเฉพาะใบครัว/จอครัว)', type: 'bool', wide: true },
    { k: 'topic', label: 'หัวข้อบนจอลูกค้า (ใช้กับตัวเลือกที่ตั้ง ✓ / ✗)', wide: true, placeholder: 'เช่น โรยสาหร่าย — เว้นว่าง = ใช้ชื่อกลุ่มตัดคำว่า "ไหม" ออก',
      hint: 'จอลูกค้าจะแสดง "✓ โรยสาหร่าย" เมื่อเลือกตัวเลือกที่ตั้งเป็น ✓ และ "✕ โรยสาหร่าย" เมื่อเลือกตัวเลือกที่ตั้งเป็น ✗ (ตั้งที่ช่อง "จอลูกค้า" ของแต่ละตัวเลือกด้านล่าง)' }], start);
  const opts = (start.options || []).map((o) => ({ ...o, recipe: o.recipe || [] }));
  const box = h('div');
  const draw = () => box.replaceChildren(h('h4', {}, 'ตัวเลือก'), ...opts.map((o, i) => {
    const n = h('input', { class: 'input', value: o.name, placeholder: 'ชื่อ' }); const pr = h('input', { class: 'input', type: 'number', step: '0.01', value: (o.price || 0) / 100, style: { width: '100px' } });
    const co = h('input', { class: 'input', type: 'number', step: '0.01', value: (o.cost || 0) / 100, style: { width: '100px' } });
    const ing = h('select', { class: 'input', style: { width: '160px' } }, h('option', { value: '' }, 'ไม่ตัดวัตถุดิบ'), ingredients.map((x) => h('option', { value: x.id, selected: o.recipe[0] && o.recipe[0].ingredient_id === x.id }, x.name)));
    const iq = h('input', { class: 'input', type: 'number', step: 'any', value: o.recipe[0] ? o.recipe[0].qty : 1, style: { width: '80px' } });
    const act = h('input', { type: 'checkbox', checked: o.active !== false });
    const mk = h('select', { class: 'input og-mark', title: 'จอลูกค้าแสดงตัวเลือกนี้อย่างไร' }, [['', 'จอลูกค้า: ชื่อตัวเลือก'], ['yes', 'จอลูกค้า: ✓ ติ๊กถูก'], ['no', 'จอลูกค้า: ✕ กากบาท']].map(([v, t]) => h('option', { value: v, selected: (o.mark || '') === v }, t)));
    mk.addEventListener('change', () => { o.mark = mk.value; });
    const rn = h('input', { class: 'input og-rename', value: o.rename_to || '', placeholder: 'ชื่อใหม่เมื่อเลือก เช่น ไข่ออนเซ็น (ไม่บังคับ)', title: 'ถ้าเลือกตัวเลือกนี้ ใบครัวจะพิมพ์ชื่อรายการเป็นชื่อนี้แทน' });
    rn.addEventListener('input', () => { o.rename_to = rn.value; });
    // picture for the big quick-pick button (optional)
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    file.onchange = async () => { try { const r = await upload(file.files[0]); o.image = r.url; draw(); } catch (e) { errToast(e); } };
    const pic = h('button', { class: 'og-pic', type: 'button', title: 'รูปของตัวเลือก (ไม่บังคับ)', onclick: () => file.click() }, o.image ? h('img', { src: o.image, alt: '' }) : '🖼️');
    const unpic = o.image ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { o.image = ''; draw(); } }, 'ลบรูป') : null;
    const sync = () => { o.name = n.value; o.price = toSatang(pr.value); o.cost = toSatang(co.value); o.active = act.checked; o.recipe = ing.value ? [{ ingredient_id: ing.value, qty: Number(iq.value) || 1 }] : []; };
    [n, pr, co, ing, iq, act].forEach((x) => x.addEventListener('input', sync)); ing.addEventListener('change', sync); act.addEventListener('change', sync);
    n.classList.add('og-name');
    return h('div', { class: 'og-row' }, pic, file, unpic, n, h('span', { class: 'small' }, '→ ใบครัว:'), rn, mk, h('span', { class: 'small' }, 'ราคา+'), pr, h('span', { class: 'small' }, 'ต้นทุน'), co, ing, iq, h('label', { class: 'switch' }, act, 'ใช้'), h('button', { class: 'btn sm', onclick: () => { opts.splice(i, 1); draw(); } }, 'ลบ'));
  }), h('button', { class: 'btn sm', onclick: () => { opts.push({ name: '', price: 0, cost: 0, recipe: [], active: true }); draw(); } }, '+ ตัวเลือก'));
  draw();
  modal(g ? 'แก้ไขตัวเลือก' : 'เพิ่มกลุ่มตัวเลือก', h('div', {}, f, box, h('p', { class: 'small muted' }, 'อย่าลืมเลือกกลุ่มนี้ที่สินค้า (เมนูและสินค้า → แก้ไขสินค้า → ตัวเลือก/ท็อปปิ้ง)')), { wide: true, actions: [g ? { label: 'ลบกลุ่ม', class: 'danger', onClick: async () => { await api.del('/option-groups/' + g.id); reload(); } } : null,
    { label: 'บันทึก', class: 'primary', onClick: async () => { const v = { ...f.value(), options: opts.filter((o) => o.name) }; if (g) await api.put('/option-groups/' + g.id, v); else await api.post('/option-groups', v); reload(); } }].filter(Boolean) });
}

// ---------------- stock ----------------
export async function stockPage() {
  const s = await api.get('/stock');
  const adjust = (type, item) => {
    const qty = h('input', { class: 'input', type: 'number', step: 'any' });
    const mode = h('select', { class: 'input' }, h('option', { value: 'add' }, 'รับเข้า/ปรับเพิ่ม-ลด (+/-)'), h('option', { value: 'set' }, 'นับจริง (ตั้งค่าใหม่)'));
    const reason = h('input', { class: 'input', placeholder: 'เหตุผล เช่น รับของ, นับสต็อก, ของเสีย' });
    modal(`ปรับสต็อก: ${item.name} (คงเหลือ ${item.stock})`, h('div', {}, h('label', { class: 'field' }, 'วิธี', mode), h('label', { class: 'field' }, 'จำนวน', qty), h('label', { class: 'field' }, 'เหตุผล', reason)), { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => {
      await api.post('/stock/adjust', { item_type: type, item_id: item.id, qty: Number(qty.value), mode: mode.value, reason: reason.value }); toast('บันทึกแล้ว', 'ok'); location.hash = '#/stock'; window.dispatchEvent(new HashChangeEvent('hashchange'));
    } }] });
  };
  const low = (x) => (x.stock <= x.low_stock ? h('span', { class: 'badge bad' }, 'ใกล้หมด') : h('span', { class: 'badge ok' }, 'ปกติ'));
  return page('สต็อก',
    card(h('h3', {}, 'วัตถุดิบ'), table([{ t: 'ชื่อ', k: 'name' }, { t: 'คงเหลือ', r: 1, f: (x) => `${Math.round(x.stock * 100) / 100} ${x.unit || ''}` }, { t: 'แจ้งเตือน', r: 1, k: 'low_stock' }, { t: '', f: low }], s.ingredients, { onRow: (x) => adjust('ingredient', x) })),
    card(h('h3', {}, 'สินค้าที่นับสต็อก'), table([{ t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' }, { t: 'คงเหลือ', r: 1, k: 'stock' }, { t: '', f: low }], s.products, { onRow: (x) => adjust('product', x) })),
    card(h('h3', {}, 'ความเคลื่อนไหวล่าสุด'), table([{ t: 'เวลา', f: (m) => fmtTime(m.created_at) }, { t: 'ประเภท', k: 'item_type' }, { t: 'รายการ', f: (m) => ((m.item_type === 'ingredient' ? s.ingredients : s.products).find((x) => x.id === m.item_id) || {}).name || m.item_id },
      { t: 'จำนวน', r: 1, f: (m) => Math.round(m.qty * 100) / 100 }, { t: 'เหตุผล', k: 'reason' }, { t: 'อ้างอิง', k: 'ref' }], s.moves)));
}

// ---------------- staff & roles ----------------
export async function staffPage() {
  const [staff, rr] = await Promise.all([api.get('/staff'), api.get('/roles')]);
  const roleName = (s) => (rr.roles.find((r) => r.id === s.role_id) || {}).name || '';
  const open = (s) => {
    const f = form([{ k: 'code', label: 'รหัสพนักงาน' }, { k: 'name', label: 'ชื่อ' }, { k: 'last_name', label: 'นามสกุล' }, { k: 'nickname', label: 'ชื่อเล่น' },
      { k: 'role_id', label: 'ตำแหน่ง (สิทธิ์)', type: 'select', options: rr.roles.map((r) => [r.id, r.name]) }, { k: 'title', label: 'ตำแหน่งบนบัตร (ไม่ใส่ = ใช้ชื่อตำแหน่ง)' },
      { k: 'pin', label: s ? 'PIN ใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'PIN 4-6 หลัก', type: 'password' }, { k: 'active', label: 'ใช้งาน', type: 'bool' }, { k: 'reason', label: 'เหตุผลการแก้ไข' }], s || { active: true, role_id: 'cashier' });
    let photo = (s && s.photo) || '';
    const preview = h('div', { class: 'staff-photo' });
    const drawPhoto = () => preview.replaceChildren(photo ? h('img', { src: photo, alt: '' }) : h('span', {}, '👤'));
    drawPhoto();
    const file = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    file.onchange = async () => { if (!file.files[0]) return; try { photo = (await upload(await squareCrop(file.files[0]))).url; drawPhoto(); } catch (e) { errToast(e); } file.value = ''; };
    const photoBox = h('div', { class: 'staff-photo-box' }, preview, h('div', { class: 'row', style: { flexWrap: 'wrap' } },
      h('button', { class: 'btn primary', type: 'button', onclick: () => cameraDialog(async (blob) => { try { photo = (await upload(blob)).url; drawPhoto(); } catch (e) { errToast(e); } }) }, '📷 ถ่ายรูป'),
      h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, '🖼️ เลือกรูป'), photo ? h('button', { class: 'btn ghost', type: 'button', onclick: () => { photo = ''; drawPhoto(); } }, 'ลบรูป') : null, file),
      h('small', { class: 'muted' }, 'รูปโปรไฟล์จะแสดงเป็นวงกลมบนบัตรพนักงาน และตอนสแกนบัตรเข้าระบบ'));
    modal(s ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน', h('div', {}, photoBox, f), { wide: true, actions: [
      s ? { label: '🪪 บัตรพนักงาน', close: false, onClick: () => cardDialog([s]) } : null,
      { label: 'บันทึก', class: 'primary', onClick: async () => { const v = { ...f.value(), photo }; if (!v.pin) delete v.pin; if (s) await api.put('/staff/' + s.id, v); else await api.post('/staff', v); toast('บันทึกแล้ว', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); } }].filter(Boolean) });
  };
  // staff ID cards: drawn in the browser, downloaded as PNG or printed on A4
  const cardDialog = async (list) => {
    const st = (await api.get('/settings')), shop = { store: st.store.name, logo: st.store.logo };
    const box = h('div', { class: 'cards-grid' }, h('div', { class: 'muted' }, 'กำลังสร้างบัตร…'));
    const canvases = [];
    modal(list.length > 1 ? `บัตรพนักงาน (${list.length} ใบ)` : 'บัตรพนักงาน · ' + list[0].name, box, { wide: true, actions: [
      { label: '🖨 พิมพ์ (A4 ขนาดบัตรจริง)', close: false, onClick: () => printCards(canvases) },
      list.length === 1 ? { label: '⬇️ ดาวน์โหลดรูป', class: 'primary', close: false, onClick: () => { const a = document.createElement('a'); a.href = canvases[0].toDataURL('image/png'); a.download = `staff-${list[0].code}.png`; a.click(); } } : null].filter(Boolean) });
    const out = [];
    for (const s of list) {
      const { url } = await api.get(`/staff/${s.id}/card`);
      const cv = await drawStaffCard({ ...s, role_name: roleName(s) }, shop, /^https?:/.test(url) ? url : location.origin + url, st.fonts);
      canvases.push(cv); out.push(h('img', { src: cv.toDataURL('image/png'), alt: s.name, class: 'staff-card-img' }));
    }
    box.replaceChildren(...out, h('p', { class: 'small muted', style: { gridColumn: '1 / -1' } }, 'QR บนบัตร: ยิงที่หน้าเข้าสู่ระบบ POS เพื่อเลือกพนักงาน แล้วใส่ PIN · สแกนด้วยมือถือเพื่อดูข้อมูลพนักงาน · ตั้งฟอนต์บัตรได้ที่ ฟอนต์ → บัตรพนักงาน'));
  };
  const roleBox = h('div', {}, rr.roles.map((r) => {
    const set = new Set(r.perms);
    return h('details', { class: 'card', style: { marginBottom: '.5em' } }, h('summary', {}, h('strong', {}, r.name), ` · ${r.perms.length} สิทธิ์`),
      h('div', { class: 'grid2', style: { marginTop: '.6em' } }, Object.entries(rr.perms).map(([k, t]) => { const cb = h('input', { type: 'checkbox', checked: set.has(k) }); cb.onchange = () => (cb.checked ? set.add(k) : set.delete(k)); return h('label', { class: 'switch' }, cb, t); })),
      saveBtn('บันทึกสิทธิ์ ' + r.name, () => api.put('/roles/' + r.id, { name: r.name, perms: [...set] })));
  }));
  // ---- roster (set by the owner): how many scan in at opening each weekday, special days with people on leave / joining later ----
  const C0 = (await api.get('/settings')).crew || {};
  const crew = { weekly: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, ...(C0.weekly || {}) }, dates: { ...(C0.dates || {}) }, max: C0.max || 8 };
  const plan = await api.get('/crew/today').catch(() => null);
  const DAYS = [[1, 'จันทร์'], [2, 'อังคาร'], [3, 'พุธ'], [4, 'พฤหัส'], [5, 'ศุกร์'], [6, 'เสาร์'], [0, 'อาทิตย์']];
  const wIn = Object.fromEntries(DAYS.map(([d]) => [d, h('input', { class: 'input', type: 'number', min: 1, max: 12, value: crew.weekly[d] })]));
  const active = staff.filter((x) => x.active);
  const nameOf = (id) => { const x = staff.find((y) => y.id === id); return x ? x.nickname || x.name : '(ลบแล้ว)'; };
  const thDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const saveCrew = () => api.put('/settings/crew', { value: { weekly: Object.fromEntries(DAYS.map(([d]) => [d, Number(wIn[d].value) || 1])), dates: crew.dates, max: crew.max } });
  const specialBox = h('div');
  const drawSpecial = () => {
    const today = plan ? plan.date : new Date().toISOString().slice(0, 10);
    const rows = Object.entries(crew.dates).filter(([d]) => d >= today).sort(([a], [b]) => a.localeCompare(b));
    specialBox.replaceChildren(rows.length ? table([
      { t: 'วันที่', f: ([d]) => thDate(d) + (d === today ? ' (วันนี้)' : '') },
      { t: 'เข้างานตอนเปิด', f: ([d, x]) => { const wd = new Date(d + 'T12:00:00Z').getUTCDay(); const base = x.count || Number(wIn[wd].value) || 1; return `${Math.max(1, base - (x.leave || []).length)} คน` + (x.count ? ' (ตั้งพิเศษ)' : ''); } },
      { t: '🏖️ ลาหยุด', f: ([, x]) => (x.leave || []).map(nameOf).join(', ') || '-' },
      { t: '⏰ เข้าทีหลัง', f: ([, x]) => (x.late || []).map(nameOf).join(', ') || '-' },
      { t: 'หมายเหตุ', f: ([, x]) => x.note || '' },
      { t: '', f: ([d]) => h('button', { class: 'btn sm danger', onclick: async (e) => { e.stopPropagation(); delete crew.dates[d]; await saveCrew(); toast('ลบวันพิเศษแล้ว', 'ok'); drawSpecial(); } }, 'ลบ') },
    ], rows, { onRow: ([d]) => editDay(d) }) : h('p', { class: 'small muted' }, 'ยังไม่มีวันพิเศษ'));
  };
  const editDay = (d0) => {
    const x = crew.dates[d0] || {};
    const date = h('input', { class: 'input', type: 'date', value: d0 || (plan ? plan.date : '') });
    const count = h('input', { class: 'input', type: 'number', min: 1, max: 12, placeholder: 'ตามตารางประจำสัปดาห์', value: x.count || '' });
    const note = h('input', { class: 'input', placeholder: 'เช่น งานวัด ลูกค้าเยอะ', value: x.note || '' });
    const pick = (sel) => active.map((st) => { const cb = h('input', { type: 'checkbox', checked: (sel || []).includes(st.id) }); return [st.id, cb, h('label', { class: 'switch' }, cb, `${st.name}${st.nickname ? ` (${st.nickname})` : ''}`)]; });
    const leave = pick(x.leave), late = pick(x.late);
    modal(d0 ? 'แก้วันพิเศษ' : 'เพิ่มวันพิเศษ', h('div', {},
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'วันที่', date), h('label', { class: 'field' }, 'จำนวนคนเข้างาน (ไม่กรอก = ตามตารางประจำสัปดาห์)', count)),
      h('h4', {}, '🏖️ ลาหยุด (หักออกจากจำนวนคน และเข้าระบบ POS วันนั้นไม่ได้)'), h('div', { class: 'grid2' }, leave.map((r) => r[2])),
      h('h4', {}, '⏰ เข้างานเพิ่มแต่มาทีหลัง (ไม่ต้องสแกนตอนเปิดร้าน มาถึงแล้วสแกนเข้ารอบที่ POS → ⋯ → พนักงานเข้างานเพิ่ม)'), h('div', { class: 'grid2' }, late.map((r) => r[2])),
      h('label', { class: 'field' }, 'หมายเหตุ', note)), { wide: true, actions: [
      { label: 'ยกเลิก', onClick: () => {} },
      { label: 'บันทึก', class: 'primary', onClick: async () => {
        if (!date.value) { toast('เลือกวันที่', 'warn'); return false; }
        const on = (list) => list.filter((r) => r[1].checked).map((r) => r[0]);
        const lv = on(leave), lt = on(late).filter((i) => !lv.includes(i));
        if (d0 && d0 !== date.value) delete crew.dates[d0];
        crew.dates[date.value] = { count: count.value ? Number(count.value) : null, leave: lv, late: lt, note: note.value.trim() };
        await saveCrew(); toast('บันทึกวันพิเศษแล้ว', 'ok'); drawSpecial();
      } }] });
  };
  drawSpecial();
  const todayLine = plan ? h('div', { class: 'crew-today' },
    h('b', {}, `วันนี้ ${thDate(plan.date)} · สแกนเข้างานตอนเปิดร้าน ${plan.need} คน`),
    plan.leave.length ? h('span', { class: 'badge bad' }, '🏖️ ลา: ' + plan.leave.join(', ')) : null,
    plan.late.length ? h('span', { class: 'badge info' }, '⏰ เข้าทีหลัง: ' + plan.late.map((x) => x.name + (x.joined ? ' ✓' : '')).join(', ')) : null) : null;
  const crewCard = card(h('h3', {}, '👥 ตารางเข้างาน'),
    h('p', { class: 'small muted' }, 'ร้านตั้งว่าแต่ละวันมีพนักงานเข้างานกี่คน · ถ้ามากกว่า 1 คน หน้าเข้าสู่ระบบ POS จะให้ทุกคนสแกนบัตร + ใส่ PIN จนครบ แล้วเลือกคนหลัก (ชื่อที่ใช้เข้าระบบ) · ทุกคนถูกบันทึกในรอบการขายและรายงานปิดรอบ'),
    todayLine,
    h('h4', {}, 'ตารางประจำสัปดาห์ (จำนวนคนที่สแกนเข้างานตอนเปิดร้าน)'),
    h('div', { class: 'week-grid' }, DAYS.map(([d, t]) => h('label', { class: 'field' }, t, wIn[d]))),
    h('div', { style: { marginTop: '.4em' } }, saveBtn('บันทึกตารางประจำสัปดาห์', saveCrew)),
    h('div', { class: 'row between', style: { marginTop: '1em' } }, h('h4', { style: { margin: 0 } }, 'วันพิเศษ (ลาหยุด / มีคนเข้าเพิ่มทีหลัง / จำนวนคนไม่เหมือนปกติ)'), h('button', { class: 'btn', onclick: () => editDay(null) }, '+ เพิ่มวันพิเศษ')),
    specialBox);
  return page('พนักงานและสิทธิ์', h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มพนักงาน'),
      h('button', { class: 'btn', onclick: () => cardDialog(staff.filter((x) => x.active)) }, '🪪 บัตรพนักงานทั้งหมด')),
    card(table([{ t: '', f: (s) => h('div', { class: 'staff-photo sm' }, s.photo ? h('img', { src: s.photo, alt: '' }) : h('span', {}, (s.name || '?')[0])) },
      { t: 'รหัส', k: 'code' }, { t: 'ชื่อ', f: (s) => `${s.name} ${s.last_name || ''}${s.nickname ? ` (${s.nickname})` : ''}` }, { t: 'ตำแหน่ง', f: (s) => s.title || roleName(s) }, { t: 'สถานะ', f: (s) => h('span', { class: 'badge ' + (s.active ? 'ok' : 'bad') }, s.active ? 'ใช้งาน' : 'ปิด') },
      { t: 'ล็อกถึง', f: (s) => (s.locked_until && new Date(s.locked_until) > new Date() ? fmtTime(s.locked_until) : '') },
      { t: '', f: (s) => h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); cardDialog([s]); } }, '🪪 บัตร') }], staff, { onRow: open })),
    crewCard, h('h3', {}, 'สิทธิ์ตามบทบาท'), roleBox);
}

// ---------------- tables ----------------
export async function tablesPage() {
  const rows = await api.get('/tables');
  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const open = (t) => {
    const f = form([{ k: 'name', label: 'ชื่อ/หมายเลขโต๊ะ' }, { k: 'zone', label: 'โซน' }, { k: 'seats', label: 'จำนวนที่นั่ง', type: 'number' }, { k: 'sort', label: 'ลำดับแสดง', type: 'number' }, { k: 'active', label: 'เปิดใช้งาน', type: 'bool' },
      { k: 'status', label: 'สถานะ', type: 'select', options: [['free', 'ว่าง'], ['occupied', 'มีลูกค้า'], ['disabled', 'ปิดใช้งาน']] }], t || { active: true, seats: 2, status: 'free' });
    modal(t ? 'แก้ไขโต๊ะ' : 'เพิ่มโต๊ะ', f, { actions: [t ? { label: 'ลบ', class: 'danger', onClick: async () => { await api.del('/tables/' + t.id); reload(); } } : null,
      t && t.status === 'occupied' ? { label: 'ปิดโต๊ะ (ปิดรอบ QR)', onClick: async () => { await api.post(`/tables/${t.id}/close`, {}); reload(); } } : null,
      { label: 'บันทึก', class: 'primary', onClick: async () => { if (t) await api.put('/tables/' + t.id, f.value()); else await api.post('/tables', f.value()); reload(); } }].filter(Boolean) });
  };
  return page('โต๊ะ', h('p', { class: 'muted' }, 'ถ้าไม่มีโต๊ะ Mobile Ordering จะแสดง Pick Up เป็นตัวเลือกหลัก'), h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มโต๊ะ'),
    card(table([{ t: 'โต๊ะ', k: 'name' }, { t: 'โซน', k: 'zone' }, { t: 'ที่นั่ง', r: 1, k: 'seats' }, { t: 'สถานะ', f: (t) => h('span', { class: 'badge ' + (!t.active ? 'bad' : t.status === 'free' ? 'ok' : 'warn') }, !t.active ? 'ปิดใช้งาน' : { free: 'ว่าง', occupied: 'มีลูกค้า', disabled: 'ปิดใช้งาน' }[t.status]) }], rows, { onRow: open })));
}

// ---------------- Google Sheets / CSV import ----------------
function importBox(reload) {
  const url = h('input', { class: 'input', placeholder: 'https://docs.google.com/spreadsheets/d/…/edit#gid=0' });
  const file = h('input', { type: 'file', accept: '.csv,text/csv' });
  const dl = h('input', { type: 'checkbox', checked: true });
  const out = h('div');
  const download = async (path, name) => {
    const r = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + JSON.parse(localStorage.getItem('opp.admin_token')) } });
    if (!r.ok) return toast('ดาวน์โหลดไม่ได้', 'error');
    const a = h('a', { href: URL.createObjectURL(await r.blob()), download: name }); a.click();
  };
  const source = async () => (file.files[0] ? { csv: await file.files[0].text() } : url.value.trim() ? { url: url.value.trim() } : null);
  const run = async (dry) => {
    const src = await source();
    if (!src) return toast('วางลิงก์ Google Sheet หรือเลือกไฟล์ CSV', 'warn');
    out.replaceChildren(h('div', { class: 'empty' }, dry ? 'กำลังอ่านข้อมูล…' : 'กำลังนำเข้า…'));
    try {
      const r = await api.post('/import/products', { ...src, dry_run: dry, download_images: dl.checked });
      if (dry) {
        out.replaceChildren(h('p', {}, h('strong', {}, `พบ ${r.count} รายการ`), ` · สร้างใหม่ ${r.preview.filter((p) => p.action === 'create').length} · อัปเดต ${r.preview.filter((p) => p.action === 'update').length}`),
          r.errors.length ? h('div', { class: 'card', style: { background: 'var(--warn-soft)' } }, r.errors.map((e) => h('div', { class: 'small' }, `แถว ${e.row}: ${e.error}`))) : null,
          table([{ t: 'แถว', k: 'row' }, { t: '', f: (p) => h('span', { class: 'badge ' + (p.action === 'create' ? 'ok' : 'info') }, p.action === 'create' ? 'ใหม่' : 'อัปเดต') }, { t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' },
            { t: 'หมวด', f: (p) => [p.category, p.new_category ? ' (ใหม่)' : ''].join('') }, { t: 'ราคา', r: 1, f: (p) => baht(p.price) }, { t: 'จุดครัว', f: (p) => [p.station, p.new_station ? ' (ใหม่)' : ''].join('') },
            { t: 'รูป', f: (p) => (p.image_url ? '🖼️' : '') }], r.preview),
          h('button', { class: 'btn primary big', style: { marginTop: '1em' }, onclick: () => run(false) }, `ยืนยันนำเข้า ${r.count} รายการ`));
      } else {
        out.replaceChildren(h('div', { class: 'card', style: { background: 'var(--ok-soft)' } }, h('h3', {}, '✅ นำเข้าสำเร็จ'), h('p', {}, `สร้างใหม่ ${r.created} · อัปเดต ${r.updated} · บันทึกรูป ${r.images}`),
          ...r.errors.map((e) => h('div', { class: 'small' }, `แถว ${e.row}: ${e.error}`))));
        reload();
      }
    } catch (e) { out.replaceChildren(h('div', { class: 'card', style: { background: 'var(--bad-soft)' } }, '⚠️ ', e.message)); }
  };
  return h('div', {},
    h('div', { class: 'card', style: { marginBottom: '1em' } }, h('h3', {}, '1. ดาวน์โหลดไฟล์ต้นแบบ'),
      h('p', { class: 'muted' }, 'ไฟล์ต้นแบบมีคอลัมน์ รหัส ชื่อ หมวดหมู่ ราคา ต้นทุน หน่วย จำนวนหน่วยที่นับ จุดครัว บาร์โค้ด ลิงก์รูป คำอธิบาย กลุ่มตัวเลือก สถานะ และสต็อก พร้อมตัวอย่าง'),
      h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => download('/import/template.csv', 'oppa-products-template.csv') }, '⬇ ไฟล์ต้นแบบ (CSV)'),
        h('button', { class: 'btn', onclick: () => download('/import/export.csv', 'oppa-products.csv') }, '⬇ เมนูปัจจุบันทั้งหมด (แก้แล้วนำเข้ากลับได้)'))),
    h('div', { class: 'card', style: { marginBottom: '1em' } }, h('h3', {}, '2. เปิดใน Google Sheets'),
      h('ol', { class: 'small' }, h('li', {}, 'ไปที่ ', h('a', { href: 'https://sheets.new', target: '_blank' }, 'sheets.new'), ' → ไฟล์ → นำเข้า → อัปโหลดไฟล์ต้นแบบ'),
        h('li', {}, 'กรอกสินค้า 1 แถวต่อ 1 รายการ (ห้ามแก้หัวตาราง) · หมวดหมู่/จุดครัวที่ยังไม่มี ระบบสร้างให้อัตโนมัติ · กลุ่มตัวเลือกต้องตรงกับชื่อที่มีในระบบ'),
        h('li', {}, 'รูปภาพ: ใส่ลิงก์รูป หรือลิงก์ Google Drive (ตั้งแชร์ไฟล์เป็น "ทุกคนที่มีลิงก์")'),
        h('li', {}, 'กด แชร์ → ทั่วไป → "ทุกคนที่มีลิงก์" เป็นผู้ดู แล้วคัดลอกลิงก์มาวางด้านล่าง'))),
    h('div', { class: 'card' }, h('h3', {}, '3. นำเข้า'), h('label', { class: 'field' }, 'ลิงก์ Google Sheet', url), h('label', { class: 'field' }, 'หรือเลือกไฟล์ CSV', file),
      h('label', { class: 'switch' }, dl, 'คัดลอกรูปภาพเข้ามาเก็บในระบบ (แนะนำ — รูปไม่หายถ้าลิงก์เดิมถูกลบ)'),
      h('div', { class: 'row', style: { marginTop: '.8em' } }, h('button', { class: 'btn primary', onclick: () => run(true) }, 'ตรวจสอบและดูตัวอย่างก่อนนำเข้า')), out));
}
