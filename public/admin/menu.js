import { h, toast, errToast, modal, confirmBox, fmtTime } from '/shared/ui.js';
import { baht, toSatang } from '/shared/core.js';
import { api, can, page, card, form, table, saveBtn } from './common.js';

// ---------------- menu ----------------
export async function menuPage(set) {
  const cat = await api.get('/catalog?all=1');
  const ingredients = can('manage_stock') || can('manage_menu') ? await api.get('/ingredients') : [];
  let tab = 'products', filter = '';
  const box = h('div');
  const reload = async () => { Object.assign(cat, await api.get('/catalog?all=1')); draw(); };
  const draw = () => {
    const tabs = h('div', { class: 'tabs', style: { marginBottom: '1em' } }, [['products', 'สินค้า/เมนู'], ['categories', 'หมวดหมู่'], ['options', 'ตัวเลือก/ท็อปปิ้ง'], ['ingredients', 'วัตถุดิบ'], ['stations', 'จุดครัวและการแบ่งใบ']].map(([k, t]) =>
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
    } else if (tab === 'categories') {
      body = simpleList('categories', cat.categories, [{ k: 'name', label: 'ชื่อหมวด' }, { k: 'sort', label: 'ลำดับ', type: 'number' }, { k: 'color', label: 'สี', type: 'color' }, { k: 'active', label: 'แสดง', type: 'bool' }], reload);
    } else if (tab === 'options') {
      body = h('div', {}, h('button', { class: 'btn primary', onclick: () => optionGroupDialog(null, ingredients, reload) }, '+ เพิ่มกลุ่มตัวเลือก'),
        table([{ t: 'กลุ่ม', k: 'name' }, { t: 'บังคับเลือกอย่างน้อย', r: 1, k: 'min_select' }, { t: 'เลือกได้สูงสุด', r: 1, k: 'max_select' }, { t: 'ตัวเลือก', f: (g) => g.options.map((o) => `${o.name}${o.price ? ' +' + baht(o.price) : ''}`).join(', ') }],
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
    { k: 'active', label: 'เปิดขาย', type: 'bool' }, { k: 'sold_out', label: 'สินค้าหมด', type: 'bool' }, { k: 'mobile', label: 'แสดงใน Mobile Ordering', type: 'bool' }, { k: 'sort', label: 'ลำดับแสดง', type: 'number' },
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
function optionGroupDialog(g, ingredients, reload) {
  const f = form([{ k: 'name', label: 'ชื่อกลุ่ม เช่น ชนิดเส้น / ระดับความเผ็ด' }, { k: 'min_select', label: 'ต้องเลือกอย่างน้อย', type: 'number' }, { k: 'max_select', label: 'เลือกได้สูงสุด (0=ไม่จำกัด)', type: 'number' }, { k: 'sort', label: 'ลำดับ', type: 'number' }], g || { min_select: 0, max_select: 1 });
  const opts = (g ? g.options : []).map((o) => ({ ...o, recipe: o.recipe || [] }));
  const box = h('div');
  const draw = () => box.replaceChildren(h('h4', {}, 'ตัวเลือก'), ...opts.map((o, i) => {
    const n = h('input', { class: 'input', value: o.name, placeholder: 'ชื่อ' }); const pr = h('input', { class: 'input', type: 'number', step: '0.01', value: (o.price || 0) / 100, style: { width: '100px' } });
    const co = h('input', { class: 'input', type: 'number', step: '0.01', value: (o.cost || 0) / 100, style: { width: '100px' } });
    const ing = h('select', { class: 'input', style: { width: '160px' } }, h('option', { value: '' }, 'ไม่ตัดวัตถุดิบ'), ingredients.map((x) => h('option', { value: x.id, selected: o.recipe[0] && o.recipe[0].ingredient_id === x.id }, x.name)));
    const iq = h('input', { class: 'input', type: 'number', step: 'any', value: o.recipe[0] ? o.recipe[0].qty : 1, style: { width: '80px' } });
    const act = h('input', { type: 'checkbox', checked: o.active !== false });
    const sync = () => { o.name = n.value; o.price = toSatang(pr.value); o.cost = toSatang(co.value); o.active = act.checked; o.recipe = ing.value ? [{ ingredient_id: ing.value, qty: Number(iq.value) || 1 }] : []; };
    [n, pr, co, ing, iq, act].forEach((x) => x.addEventListener('input', sync)); ing.addEventListener('change', sync); act.addEventListener('change', sync);
    return h('div', { class: 'row', style: { marginBottom: '.4em' } }, n, h('span', { class: 'small' }, 'ราคา+'), pr, h('span', { class: 'small' }, 'ต้นทุน'), co, ing, iq, h('label', { class: 'switch' }, act, 'ใช้'), h('button', { class: 'btn sm', onclick: () => { opts.splice(i, 1); draw(); } }, 'ลบ'));
  }), h('button', { class: 'btn sm', onclick: () => { opts.push({ name: '', price: 0, cost: 0, recipe: [], active: true }); draw(); } }, '+ ตัวเลือก'));
  draw();
  modal(g ? 'แก้ไขตัวเลือก' : 'เพิ่มกลุ่มตัวเลือก', h('div', {}, f, box), { wide: true, actions: [g ? { label: 'ลบกลุ่ม', class: 'danger', onClick: async () => { await api.del('/option-groups/' + g.id); reload(); } } : null,
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
  const open = (s) => {
    const f = form([{ k: 'code', label: 'รหัสพนักงาน' }, { k: 'name', label: 'ชื่อ' }, { k: 'role_id', label: 'ตำแหน่ง', type: 'select', options: rr.roles.map((r) => [r.id, r.name]) },
      { k: 'pin', label: s ? 'PIN ใหม่ (เว้นว่างถ้าไม่เปลี่ยน)' : 'PIN 4-6 หลัก', type: 'password' }, { k: 'photo', label: 'รูปพนักงาน', type: 'image' }, { k: 'active', label: 'ใช้งาน', type: 'bool' }, { k: 'reason', label: 'เหตุผลการแก้ไข' }], s || { active: true, role_id: 'cashier' });
    modal(s ? 'แก้ไขพนักงาน' : 'เพิ่มพนักงาน', f, { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => { const v = f.value(); if (!v.pin) delete v.pin; if (s) await api.put('/staff/' + s.id, v); else await api.post('/staff', v); toast('บันทึกแล้ว', 'ok'); window.dispatchEvent(new HashChangeEvent('hashchange')); } }] });
  };
  const roleBox = h('div', {}, rr.roles.map((r) => {
    const set = new Set(r.perms);
    return h('details', { class: 'card', style: { marginBottom: '.5em' } }, h('summary', {}, h('strong', {}, r.name), ` · ${r.perms.length} สิทธิ์`),
      h('div', { class: 'grid2', style: { marginTop: '.6em' } }, Object.entries(rr.perms).map(([k, t]) => { const cb = h('input', { type: 'checkbox', checked: set.has(k) }); cb.onchange = () => (cb.checked ? set.add(k) : set.delete(k)); return h('label', { class: 'switch' }, cb, t); })),
      saveBtn('บันทึกสิทธิ์ ' + r.name, () => api.put('/roles/' + r.id, { name: r.name, perms: [...set] })));
  }));
  return page('พนักงานและสิทธิ์', h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มพนักงาน'),
    card(table([{ t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' }, { t: 'ตำแหน่ง', f: (s) => (rr.roles.find((r) => r.id === s.role_id) || {}).name }, { t: 'สถานะ', f: (s) => h('span', { class: 'badge ' + (s.active ? 'ok' : 'bad') }, s.active ? 'ใช้งาน' : 'ปิด') },
      { t: 'ล็อกถึง', f: (s) => (s.locked_until && new Date(s.locked_until) > new Date() ? fmtTime(s.locked_until) : '') }], staff, { onRow: open })),
    h('h3', {}, 'สิทธิ์ตามบทบาท'), roleBox);
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
