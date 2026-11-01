import { h, toast, errToast, modal, confirmBox, fmtTime } from '/shared/ui.js';
import { baht, toSatang, fromThaiKeys } from '/shared/core.js';
import { api, can, page, card, form, table, saveBtn, upload, keyHelp } from './common.js';
import { store } from '/shared/api.js';
import { drawStaffCard, printCards } from '/shared/staffcard.js';
import { scanWithCamera, BARCODECAM_CSS } from '/shared/barcodecam.js';
import { isLinkedHere, printDocument } from '/shared/printers.js';
document.head.append(Object.assign(document.createElement('style'), { textContent: BARCODECAM_CSS }));

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
  let tab = 'products', filter = '', stFilter = '';
  const box = h('div');
  const reload = async () => { Object.assign(cat, await api.get('/catalog?all=1')); draw(); };
  const draw = () => {
    const tabs = h('div', { class: 'tabs', style: { marginBottom: '1em' } }, [['products', 'สินค้า/เมนู'], ['categories', 'หมวดหมู่'], ['countries', '🌏 ประเทศ'], ['options', 'ตัวเลือก/ท็อปปิ้ง'], ['ingredients', 'วัตถุดิบ'], ['stations', 'จุดครัวและการแบ่งใบ'], ['import', '📥 นำเข้าจาก Google Sheet']].map(([k, t]) =>
      h('button', { class: 'tab' + (tab === k ? ' active' : ''), onclick: () => { tab = k; draw(); } }, t)));
    let body;
    if (tab === 'products') {
      const q = h('input', { class: 'input', placeholder: 'ค้นหา', value: filter, style: { maxWidth: '260px' } });
      q.addEventListener('input', () => { filter = q.value; drawList(); });
      // status filter: "ปิดขายอยู่" finds the items nobody sells any more
      const stSel = h('select', { class: 'input', style: { maxWidth: '170px' } }, [['', 'ทุกสถานะ'], ['on', 'ขายอยู่'], ['off', 'ปิดขายอยู่']].map(([v, t]) => h('option', { value: v, selected: v === stFilter }, t)));
      stSel.addEventListener('change', () => { stFilter = stSel.value; drawList(); });
      const picked = new Set();
      const delBtn = h('button', { class: 'btn danger', style: { display: 'none' }, onclick: () => deleteProducts([...picked], cat, reload) });
      // quick kitchen station for the ticked items
      const stBulk = h('select', { class: 'input', style: { display: 'none', maxWidth: '230px' }, onchange: async () => {
        if (stBulk.value === '_') return;
        try { await api.post('/products/station', { ids: [...picked], station_id: stBulk.value }); toast(`ตั้งจุดครัว ${picked.size} เมนูแล้ว`, 'ok'); reload(); } catch (e) { errToast(e); stBulk.value = '_'; }
      } }, h('option', { value: '_' }, '🍳 ตั้งจุดครัวให้ที่เลือก…'), ...cat.stations.map((x) => h('option', { value: x.id }, x.name)), h('option', { value: '' }, 'ไม่ระบุจุดครัว'));
      const syncDel = () => { delBtn.style.display = stBulk.style.display = picked.size ? '' : 'none'; delBtn.textContent = `🗑 ลบที่เลือก (${picked.size})`; stBulk.value = '_'; };
      // one tap sets the station that prints this item
      const stationChips = (p) => h('div', { class: 'st-chips', onclick: (e) => e.stopPropagation() }, cat.stations.map((x) => h('button', { type: 'button', class: 'st-chip' + (p.station_id === x.id ? ' on' : ''), title: 'พิมพ์ใบครัวที่ ' + x.name,
        onclick: async (e) => { const box = e.currentTarget.parentElement; const to = p.station_id === x.id ? '' : x.id; try { await api.post('/products/station', { ids: [p.id], station_id: to }); p.station_id = to || null;
          box.querySelectorAll('.st-chip').forEach((b, i) => b.classList.toggle('on', cat.stations[i].id === to)); toast(to ? `${p.name} → ${x.name}` : `${p.name}: ไม่ระบุจุดครัว`, 'ok', 1400); } catch (er) { errToast(er); } } }, x.name)));
      const shown = () => cat.products.filter((p) => (!filter || p.name.includes(filter) || p.code.includes(filter) || p.barcodes.some((b) => b.includes(filter)))
        && (!stFilter || (stFilter === 'on' ? p.active : !p.active)));
      const all = h('input', { type: 'checkbox', title: 'เลือกทั้งหมดที่แสดง', onchange: () => { for (const p of shown()) all.checked ? picked.add(p.id) : picked.delete(p.id); syncDel(); drawList(); } });
      const list = h('div');
      const drawList = () => list.replaceChildren(table([
        { t: all, f: (p) => h('input', { type: 'checkbox', checked: picked.has(p.id), onclick: (e) => e.stopPropagation(), onchange: (e) => { e.target.checked ? picked.add(p.id) : picked.delete(p.id); syncDel(); } }) },
        { t: '', f: (p) => (p.image ? h('img', { src: p.image, style: { width: '44px', height: '44px', objectFit: 'cover', borderRadius: '8px' } }) : '🍜') },
        { t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' }, { t: 'หมวด', f: (p) => (cat.categories.find((c) => c.id === p.category_id) || {}).name || '' },
        { t: 'ราคา', r: 1, f: (p) => baht(p.price) }, can('view_cost') ? { t: 'ต้นทุน', r: 1, f: (p) => (p.cost !== undefined ? baht(p.cost) : '') } : null, { t: 'ชาม', r: 1, k: 'bowl_count' },
        { t: 'สต็อก', r: 1, f: (p) => (p.track_stock ? p.stock : '-') }, cat.stations.length ? { t: 'จุดพิมพ์ใบครัว', f: stationChips } : null,
        { t: 'สถานะ', f: (p) => h('span', { class: 'badge ' + (!p.active ? 'bad' : p.sold_out ? 'warn' : 'ok') }, !p.active ? 'ปิดขาย' : p.sold_out ? 'หมด' : 'ขาย') }].filter(Boolean),
      shown(), { onRow: (p) => productDialog(p, cat, ingredients, reload) }));
      drawList(); syncDel();
      body = h('div', {}, h('style', {}, MENU_LIST_CSS), h('div', { class: 'bar' }, q, stSel, h('button', { class: 'btn primary', onclick: () => productDialog(null, cat, ingredients, reload) }, '+ เพิ่มเมนู'),
        h('button', { class: 'btn', onclick: () => sortDialog(cat, reload) }, '↕ จัดเรียงลำดับ'), stBulk, delBtn), list);
    } else if (tab === 'import') {
      body = importBox(reload);
    } else if (tab === 'countries') {
      body = countriesTab(cat, reload);
    } else if (tab === 'categories') {
      body = simpleList('categories', cat.categories, [{ k: 'name', label: 'ชื่อหมวด' }, { k: 'sort', label: 'ลำดับ', type: 'number' }, { k: 'color', label: 'สี', type: 'color' }, { k: 'active', label: 'แสดง', type: 'bool' },
        { k: 'sort_by', label: 'เรียงสินค้าในหมวดนี้ตาม', type: 'select', options: SORT_BY_OPTS }], reload, (r) => (SORT_BY_OPTS.find(([v]) => v === (r.sort_by || 'sort')) || [])[1] || '');
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
const SORT_BY_OPTS = [['sort', 'ลำดับแสดงที่ตั้งในสินค้า'], ['code_asc', 'รหัสสินค้า น้อย → มาก'], ['code_desc', 'รหัสสินค้า มาก → น้อย'], ['name_asc', 'ชื่อสินค้า ก → ฮ / A → Z'], ['name_desc', 'ชื่อสินค้า ฮ → ก / Z → A']];
const MENU_LIST_CSS = `
  .st-chips { display: flex; flex-wrap: wrap; gap: 4px; min-width: 250px; max-width: 360px; }
  .st-chip { border: 1px solid var(--line); background: var(--surface); color: var(--muted); border-radius: 99px; padding: 3px 9px; font: inherit; font-size: .8em; font-weight: 700; cursor: pointer; white-space: nowrap; transition: background .15s, color .15s; }
  .st-chip.on { background: var(--brand); border-color: var(--brand); color: #fff; }
  .sort-list { display: grid; gap: 6px; max-height: 62vh; overflow: auto; padding: 2px; overscroll-behavior: contain; }
  .sort-row { display: grid; grid-template-columns: 40px 30px 44px 1fr auto; gap: 10px; align-items: center; padding: 8px 10px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); user-select: none; -webkit-user-select: none; }
  .sort-row.dragging { position: relative; z-index: 5; box-shadow: 0 14px 30px rgb(0 0 0 / .18); border-color: var(--brand); transition: box-shadow .2s; }
  .sort-row .sort-h { cursor: grab; touch-action: none; font-size: 22px; color: var(--muted); display: grid; place-items: center; height: 40px; border-radius: 10px; background: var(--surface2); }
  .sort-row.dragging .sort-h { cursor: grabbing; color: var(--brand); }
  .sort-row .no { color: var(--muted); font-weight: 800; text-align: right; font-variant-numeric: tabular-nums; }
  .sort-row img, .sort-row .ph { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; background: var(--surface2); display: grid; place-items: center; }
  .sort-row b { display: block; line-height: 1.25; } .sort-row small { color: var(--muted); }
  .sort-row .ud { display: flex; gap: 4px; } .sort-row .ud button { width: 34px; height: 34px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; font-size: 14px; }
`;
// drag rows by the ⠿ handle (mouse or finger); the others slide out of the way
function sortable(list, onChange) {
  const rows = () => [...list.children];
  const slide = (moveFn) => { // FLIP: rows other than the dragged one glide to their new place
    const before = new Map(rows().filter((r) => !r.classList.contains('dragging')).map((r) => [r, r.getBoundingClientRect().top]));
    moveFn();
    for (const [r, top] of before) { const d = top - r.getBoundingClientRect().top; if (!d) continue; r.style.transition = 'none'; r.style.transform = `translateY(${d}px)`; requestAnimationFrame(() => { r.style.transition = 'transform .22s cubic-bezier(.22,1,.36,1)'; r.style.transform = ''; }); }
  };
  list.addEventListener('pointerdown', (e) => {
    const hdl = e.target.closest('.sort-h'); if (!hdl) return;
    const row = hdl.closest('.sort-row'); e.preventDefault();
    hdl.setPointerCapture(e.pointerId);
    row.classList.add('dragging');
    const grab = e.clientY - row.getBoundingClientRect().top;
    let y = e.clientY, raf = 0;
    const place = () => {
      row.style.transform = '';
      const natural = row.getBoundingClientRect().top;
      row.style.transform = `translateY(${y - grab - natural}px)`;
    };
    const move = (ev) => {
      y = ev.clientY;
      const others = rows().filter((r) => r !== row);
      const idx = others.filter((r) => { const b = r.getBoundingClientRect(); return b.top + b.height / 2 < y; }).length;
      if (rows().indexOf(row) !== idx) slide(() => list.insertBefore(row, others[idx] || null));
      place();
      // near the top/bottom edge: scroll the list
      const lb = list.getBoundingClientRect();
      cancelAnimationFrame(raf);
      const edge = y < lb.top + 40 ? -10 : y > lb.bottom - 40 ? 10 : 0;
      if (edge) { const tick = () => { list.scrollTop += edge; place(); raf = requestAnimationFrame(tick); }; raf = requestAnimationFrame(tick); }
    };
    const up = () => {
      cancelAnimationFrame(raf);
      hdl.removeEventListener('pointermove', move); hdl.removeEventListener('pointerup', up); hdl.removeEventListener('pointercancel', up);
      row.style.transition = 'transform .2s cubic-bezier(.22,1,.36,1)'; row.style.transform = '';
      setTimeout(() => { row.classList.remove('dragging'); row.style.transition = ''; }, 200);
      onChange();
    };
    hdl.addEventListener('pointermove', move); hdl.addEventListener('pointerup', up); hdl.addEventListener('pointercancel', up);
  });
  return { slide };
}
// "จัดเรียงลำดับ": one category at a time, drag (or ▲▼), save → the POS shows this order
function sortDialog(cat, reload) {
  const cats = cat.categories.filter((c) => cat.products.some((p) => p.category_id === c.id));
  let catId = (cats[0] || {}).id || '';
  let dirty = false;
  const list = h('div', { class: 'sort-list' });
  const note = h('p', { class: 'small muted', style: { margin: '.4em 0' } });
  const renumber = () => [...list.children].forEach((r, i) => { r.querySelector('.no').textContent = i + 1; });
  const sorter = sortable(list, () => { dirty = true; renumber(); });
  const draw = () => {
    const c = cat.categories.find((x) => x.id === catId);
    const ps = cat.products.filter((p) => (catId ? p.category_id === catId : !p.category_id)).sort((a, b) => (a.sort || 0) - (b.sort || 0) || a.name.localeCompare(b.name, 'th'));
    note.textContent = c && c.sort_by && c.sort_by !== 'sort' ? '⚠️ หมวดนี้ตั้งให้เรียงตามรหัส/ชื่ออยู่ — กดบันทึกแล้วจะเปลี่ยนเป็นเรียงตามลำดับที่จัดตรงนี้' : 'ลากที่ ⠿ เพื่อย้าย (หรือกด ▲ ▼) แล้วกดบันทึก — หน้า POS เรียงตามนี้ทันที';
    list.replaceChildren(...ps.map((p, i) => h('div', { class: 'sort-row', 'data-id': p.id },
      h('div', { class: 'sort-h', title: 'ลากเพื่อย้าย' }, '⠿'), h('span', { class: 'no' }, i + 1),
      p.image ? h('img', { src: p.image, alt: '' }) : h('span', { class: 'ph' }, '🍜'),
      h('div', {}, h('b', {}, p.name), h('small', {}, p.code + ' · ' + baht(p.price) + (p.active ? '' : ' · ปิดขาย'))),
      h('div', { class: 'ud' }, h('button', { type: 'button', title: 'ขึ้น', onclick: (e) => { const r = e.target.closest('.sort-row'); if (r.previousElementSibling) { sorter.slide(() => list.insertBefore(r, r.previousElementSibling)); dirty = true; renumber(); } } }, '▲'),
        h('button', { type: 'button', title: 'ลง', onclick: (e) => { const r = e.target.closest('.sort-row'); if (r.nextElementSibling) { sorter.slide(() => list.insertBefore(r.nextElementSibling, r)); dirty = true; renumber(); } } }, '▼')))));
    if (!ps.length) list.replaceChildren(h('div', { class: 'empty' }, 'ไม่มีเมนูในหมวดนี้'));
  };
  const save = async () => {
    const ids = [...list.querySelectorAll('.sort-row')].map((r) => r.dataset.id);
    if (!ids.length) return;
    await api.post('/products/reorder', { ids, category_id: catId || null });
    for (const [i, pid] of ids.entries()) { const p = cat.products.find((x) => x.id === pid); if (p) p.sort = (i + 1) * 10; }
    const c = cat.categories.find((x) => x.id === catId); if (c) c.sort_by = 'sort';
    dirty = false; toast('บันทึกลำดับแล้ว', 'ok');
  };
  const sel = h('select', { class: 'input', style: { maxWidth: '320px' } }, cats.map((c) => h('option', { value: c.id }, c.name)),
    cat.products.some((p) => !p.category_id) ? h('option', { value: '' }, '(ไม่มีหมวด)') : null);
  sel.addEventListener('change', async () => { if (dirty && await confirmBox('บันทึกก่อนไหม', 'ลำดับในหมวดนี้ยังไม่ได้บันทึก — บันทึกก่อนเปลี่ยนหมวด?', 'บันทึก')) await save().catch(errToast); dirty = false; catId = sel.value; draw(); });
  draw();
  modal('↕ จัดเรียงลำดับเมนู', h('div', {}, h('style', {}, MENU_LIST_CSS), h('label', { class: 'field' }, 'หมวด', sel), note, list), { wide: true, onClose: () => { if (dirty) reload(); }, actions: [
    { label: 'ปิด', onClick: () => { reload(); } },
    { label: '💾 บันทึกลำดับ', class: 'primary', onClick: async () => { await save(); reload(); } }] });
}
// search the web about this product and pick what to use (filled into the form; nothing is saved until "บันทึก")
const RESEARCH_CSS = `
  .rs-load { display: grid; place-items: center; gap: 10px; padding: 40px 10px; color: var(--muted); text-align: center; }
  .rs-load .sp { width: 44px; height: 44px; border-radius: 50%; border: 4px solid var(--surface2); border-top-color: var(--brand); animation: rsspin .9s linear infinite; }
  @keyframes rsspin { to { transform: rotate(360deg); } }
  .rs-sec { margin-top: 14px; } .rs-sec h4 { margin: 0 0 8px; }
  .rs-opt { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 10px 12px; border: 2px solid var(--line); border-radius: 14px; margin-bottom: 8px; cursor: pointer; transition: border-color .15s, background .15s; }
  .rs-opt.on { border-color: var(--brand); background: var(--brand-soft); }
  .rs-opt small { color: var(--muted); font-weight: 800; display: block; margin-bottom: 2px; }
  .rs-opt textarea { width: 100%; box-sizing: border-box; border: 0; background: transparent; font: inherit; resize: vertical; min-height: 3.2em; color: inherit; }
  .rs-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .rs-chip { display: inline-flex; gap: 6px; align-items: center; padding: 6px 12px; border-radius: 99px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; font-weight: 700; }
  .rs-chip.on { background: var(--brand); border-color: var(--brand); color: #fff; }
  .rs-facts { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: .95em; }
  .rs-facts b { color: var(--muted); }
  .rs-src a { display: block; font-size: .85em; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rs-eng { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; } @media (max-width: 720px) { .rs-eng { grid-template-columns: 1fr; } }
  .rs-e { text-align: left; display: grid; gap: 3px; padding: 10px 12px; border-radius: 14px; border: 2px solid var(--line); background: var(--surface); cursor: pointer; font: inherit; color: inherit; }
  .rs-e.on { border-color: var(--brand); background: var(--brand-soft); } .rs-e.off { opacity: .7; }
  .rs-e small { color: var(--muted); line-height: 1.3; } .rs-e .rs-k { font-size: .78em; font-weight: 800; color: var(--muted); }
  .rs-g { display: grid; gap: 8px; max-height: 340px; overflow: auto; padding-right: 4px; }
  .rs-gi { padding: 10px 12px; border-radius: 12px; background: var(--surface2); display: grid; gap: 3px; }
  .rs-gi a { font-weight: 800; color: #1a0dab; text-decoration: none; } .rs-gi a:hover { text-decoration: underline; }
  .rs-gi small { color: #188038; } .rs-gi p { margin: 2px 0 4px; font-size: .92em; line-height: 1.45; } .rs-gi .btn { justify-self: start; }
`;
// which search: Google + AI writes · Google only · Claude searches the web itself (remembered on this device)
const ENGINES = [['google_ai', '🔎 Google + AI เขียนให้', 'ค้น Google แล้วให้ Claude สรุปเป็นคำอธิบาย/สรรพคุณ/ความเผ็ด', ['serper', 'ai']],
  ['google', '🔎 Google อย่างเดียว', 'ใช้ข้อความจากผลค้น Google ตรง ๆ (ไม่ใช้ AI)', ['serper']],
  ['claude', '🤖 Claude AI ค้นเว็บเอง', 'Claude ค้นหาจากหลายเว็บแล้วสรุปให้', ['ai']]];
async function researchDialog(f, p) {
  let conf = await api.get('/assistant/config').catch(() => ({}));
  const has = (e) => ENGINES.find((x) => x[0] === e)[3].every((k) => conf[k]);
  let engine = store.get('research_engine') || '';
  if (!engine || !has(engine)) engine = (ENGINES.find((x) => has(x[0])) || ENGINES[0])[0];
  const engBox = h('div', { class: 'rs-eng' });
  const drawEng = () => engBox.replaceChildren(...ENGINES.map(([id, t, sub, need]) => h('button', { type: 'button', class: 'rs-e' + (engine === id ? ' on' : '') + (has(id) ? '' : ' off'), onclick: () => { engine = id; store.set('research_engine', id); drawEng(); if (!has(id)) help.open = true; } },
    h('b', {}, t), h('small', {}, sub), h('span', { class: 'rs-k' }, need.map((k) => (conf[k] ? '✓ ' : '✗ ') + (k === 'ai' ? 'Claude key' : 'Serper key')).join(' · ')))));
  drawEng();
  // keys saved from the help panel: refresh the ✓/✗ and pick a search that now works
  const refresh = async () => { conf = await api.get('/assistant/config'); if (!has(engine)) engine = (ENGINES.find((x) => has(x[0])) || ENGINES[0])[0]; drawEng(); const fresh = keyHelp({ conf, onSaved: refresh }); help.replaceWith(fresh); help = fresh; };
  let help = keyHelp({ conf, open: !ENGINES.some((x) => has(x[0])), onSaved: refresh });
  const cur = f.value();
  const q = h('input', { class: 'input', value: cur.name || '', placeholder: 'ชื่อสินค้าที่จะค้นหา' });
  const bc = h('input', { class: 'input', value: String(cur.barcodes || '').split(',')[0].trim(), placeholder: 'บาร์โค้ด (ถ้ามี)' });
  const note = h('input', { class: 'input', placeholder: 'เพิ่มเติม เช่น รสชาติ ขนาด (ไม่บังคับ)' });
  const out = h('div');
  let picked = null, chosen = new Set(), spice = null, addFacts = false, data = null;
  const draw = () => {
    if (!data) return;
    const descs = data.descriptions || [];
    out.replaceChildren(
      h('div', { class: 'small', style: { padding: '8px 12px', borderRadius: '12px', background: data.found ? 'var(--ok-soft)' : 'var(--warn-soft)', color: data.found ? 'var(--ok)' : 'var(--warn)', fontWeight: 700 } },
        (data.engine === 'google' ? '🔎 ค้นจาก Google · ' : '🤖 ค้นโดย AI · ') + (data.found ? '✓ พบข้อมูล: ' : '⚠️ ไม่พบสินค้านี้ตรง ๆ — ข้อมูลด้านล่างเป็นแบบทั่วไป ตรวจก่อนใช้: ') + (data.summary_th || '')),
      h('div', { class: 'rs-sec' }, h('h4', {}, '📝 เลือกคำอธิบาย (แก้ข้อความได้)'),
        ...descs.map((d, i) => { const ta = h('textarea', { rows: 2, oninput: () => { d.text = ta.value; } }, d.text);
          // a click anywhere on the card (the text too) picks it; the radio again un-picks it; no redraw, so typing keeps its place
          const card = h('div', { class: 'rs-opt' + (picked === i ? ' on' : ''), onclick: (e) => {
            const off = e.target.type === 'radio' && picked === i;
            picked = off ? null : i;
            out.querySelectorAll('.rs-opt').forEach((c, k) => { c.classList.toggle('on', k === picked); c.querySelector('input').checked = k === picked; });
          } }, h('input', { type: 'radio', name: 'rsdesc', checked: picked === i }), h('div', {}, h('small', {}, d.style), ta));
          return card; })),
      (data.highlights || []).length ? h('div', { class: 'rs-sec' }, h('h4', {}, '✅ เลือกสรรพคุณ / จุดเด่น (เลือกได้หลายข้อ)'),
        h('div', { class: 'rs-chips' }, data.highlights.map((t) => h('span', { class: 'rs-chip' + (chosen.has(t) ? ' on' : ''), onclick: () => { chosen.has(t) ? chosen.delete(t) : chosen.add(t); draw(); } }, (chosen.has(t) ? '✓ ' : '+ ') + t)))) : null,
      data.spice_unknown ? h('div', { class: 'rs-sec' }, h('h4', {}, '🌶️ ความเผ็ด'), h('div', { class: 'small muted' }, data.spice_reason)) : h('div', { class: 'rs-sec' }, h('h4', {}, '🌶️ ความเผ็ดที่แนะนำ'),
        h('label', { class: 'rs-chip' + (spice !== null ? ' on' : ''), onclick: () => { spice = spice === null ? data.spice_level : null; draw(); } },
          (spice !== null ? '✓ ' : '+ ') + (data.spice_level ? '🌶️'.repeat(data.spice_level) + ` ระดับ ${data.spice_level}/5` : 'ไม่เผ็ด')),
        data.spice_reason ? h('div', { class: 'small muted', style: { marginTop: '4px' } }, data.spice_reason) : null),
      (data.facts || []).length ? h('div', { class: 'rs-sec' }, h('h4', {}, 'ℹ️ ข้อมูลที่พบ'), h('div', { class: 'rs-facts' }, data.facts.flatMap((x) => [h('b', {}, x.label), h('span', {}, x.value)])),
        h('label', { class: 'switch', style: { marginTop: '6px' } }, h('input', { type: 'checkbox', checked: addFacts, onchange: (e) => { addFacts = e.target.checked; } }), 'ต่อท้ายข้อมูลนี้ในคำอธิบายด้วย')) : null,
      (data.google || []).length ? h('div', { class: 'rs-sec' }, h('h4', {}, `🔎 ผลการค้นหา Google (${data.google.length})`),
        h('div', { class: 'rs-g' }, data.google.map((g) => h('div', { class: 'rs-gi' }, h('a', { href: g.url, target: '_blank', rel: 'noopener' }, g.title), h('small', {}, (() => { try { return new URL(g.url).hostname; } catch { return ''; } })()), h('p', {}, g.snippet),
          h('button', { type: 'button', class: 'btn sm', onclick: () => { data.descriptions = [...(data.descriptions || []), { style: 'จาก Google · ' + g.title.slice(0, 40), text: g.snippet.replace(/\s*\.\.\.\s*$/, '') }]; picked = data.descriptions.length - 1; draw(); toast('เพิ่มเป็นตัวเลือกคำอธิบายแล้ว (แก้ข้อความได้)', 'ok', 1800); } }, '＋ ใช้เป็นคำอธิบาย'))))) : null,
      !(data.google || []).length && (data.sources || []).length ? h('div', { class: 'rs-sec rs-src' }, h('h4', {}, '🔗 แหล่งข้อมูล'), data.sources.map((x) => h('a', { href: x.url, target: '_blank', rel: 'noopener' }, x.title))) : null);
  };
  const search = async (e) => {
    const btn = e && e.currentTarget; if (btn) btn.disabled = true;
    data = null; picked = null; chosen = new Set(); spice = null;
    out.replaceChildren(h('div', { class: 'rs-load' }, h('div', { class: 'sp' }), h('b', {}, 'กำลังค้นหาข้อมูล…'), h('span', { class: 'small' }, 'ค้นจาก Google แล้วสรุปเป็นตัวเลือก — ใช้เวลาประมาณ 10–40 วินาที')));
    try {
      if (!has(engine)) { help.open = true; throw new Error('ยังไม่มีคีย์สำหรับวิธีค้นหานี้ — ดู "วิธีเอา API Key" ด้านบน'); }
      data = await api.post('/products/research', { engine, name: q.value, barcode: bc.value, note: note.value, category_id: cur.category_id || null, product_id: p ? p.id : null });
      picked = (data.descriptions || []).length ? 0 : null;
      draw();
    } catch (er) { out.replaceChildren(h('div', { class: 'rs-load' }, h('b', {}, '❌ ' + (er.message || 'ค้นหาไม่สำเร็จ')), h('span', { class: 'small' }, 'แก้ชื่อสินค้าแล้วลองใหม่ได้'))); }
    finally { if (btn) btn.disabled = false; }
  };
  const apply = () => {
    if (!data) return false;
    const I = f.inputs;
    let desc = picked !== null ? data.descriptions[picked].text.trim() : null;
    if (addFacts && (data.facts || []).length) desc = [desc ?? I.description.value.trim(), data.facts.map((x) => `${x.label}: ${x.value}`).join(' · ')].filter(Boolean).join('\n');
    if (desc !== null) I.description.value = desc;
    if (chosen.size) { const have = I.highlights.value.split('\n').map((x) => x.trim()).filter(Boolean); I.highlights.value = [...new Set([...have, ...chosen])].join('\n'); }
    if (spice !== null) I.spice_level.value = String(spice);
    if (desc === null && !chosen.size && spice === null) { toast('ยังไม่ได้เลือกอะไร', 'warn'); return false; }
    toast('ใส่ข้อมูลในฟอร์มแล้ว — ตรวจแล้วกด "บันทึก"', 'ok', 4000);
  };
  modal('🔍 ค้นหาข้อมูลสินค้า', h('div', {}, h('style', {}, RESEARCH_CSS),
    h('div', { class: 'small muted', style: { fontWeight: 800, marginBottom: '6px' } }, 'ค้นด้วย'), engBox, help,
    h('div', { class: 'form-grid' }, h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, 'ค้นหา', q), h('label', { class: 'field' }, 'บาร์โค้ด', bc), h('label', { class: 'field' }, 'หมายเหตุ', note)),
    h('button', { class: 'btn primary', style: { marginTop: '8px' }, onclick: search }, '🔍 ค้นหา'), out),
  { wide: true, actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: '✓ ใช้ข้อมูลที่เลือก', class: 'primary', onClick: apply }] });
  if ((q.value || bc.value) && has(engine)) search();
}
// ---------- 🌏 countries: where products come from (name + flag), tick which products ----------
const COUNTRY_PRESETS = [['kr', 'เกาหลีใต้', '🇰🇷'], ['jp', 'ญี่ปุ่น', '🇯🇵'], ['cn', 'จีน', '🇨🇳'], ['th', 'ไทย', '🇹🇭'], ['tw', 'ไต้หวัน', '🇹🇼'], ['hk', 'ฮ่องกง', '🇭🇰'],
  ['sg', 'สิงคโปร์', '🇸🇬'], ['my', 'มาเลเซีย', '🇲🇾'], ['id', 'อินโดนีเซีย', '🇮🇩'], ['vn', 'เวียดนาม', '🇻🇳'], ['ph', 'ฟิลิปปินส์', '🇵🇭'], ['us', 'สหรัฐอเมริกา', '🇺🇸'],
  ['it', 'อิตาลี', '🇮🇹'], ['de', 'เยอรมนี', '🇩🇪'], ['fr', 'ฝรั่งเศส', '🇫🇷'], ['au', 'ออสเตรเลีย', '🇦🇺']];
const flagEl = (f, size = '1.6em') => (/^(\/|https:)/.test(f || '') ? h('img', { src: f, alt: '', style: { height: size, borderRadius: '4px', boxShadow: '0 0 0 1px rgb(0 0 0 / .08)', verticalAlign: 'middle' } }) : h('span', { style: { fontSize: size, lineHeight: 1 } }, f || '🌏'));
function countriesTab(cat, reload) {
  const list = (cat.countries || []).slice();
  const save = async (next, msg) => { await api.put('/settings/countries', { value: next }); toast(msg || 'บันทึกแล้ว', 'ok'); await reload(); };
  const count = (id) => cat.products.filter((p) => p.country === id).length;
  const presets = COUNTRY_PRESETS.filter(([id]) => !list.some((c) => c.id === id));
  return h('div', {},
    h('p', { class: 'small muted' }, 'ตั้งว่าสินค้ามาจากประเทศไหน — จอลูกค้าจะขึ้น "สินค้าจาก 🇰🇷 เกาหลีใต้" ในการ์ดสินค้าที่เพิ่มล่าสุดและป๊อปอัปรายละเอียด · ธงใช้อีโมจิ หรืออัปโหลดรูปธงเองได้'),
    list.length ? h('div', { class: 'ct-grid' }, list.map((c) => h('div', { class: 'card ct-card' },
      h('div', { class: 'ct-flag' }, flagEl(c.flag, '2.6em')), h('div', {}, h('b', {}, c.name), h('div', { class: 'small muted' }, `${count(c.id)} สินค้า`)),
      h('div', { class: 'row', style: { gap: '6px' } }, h('button', { class: 'btn sm primary', onclick: () => countryProducts(c, cat, reload) }, '✓ เลือกสินค้า'), h('button', { class: 'btn sm', onclick: () => countryDialog(c, list, save) }, 'แก้ไข'))))) : h('div', { class: 'empty' }, 'ยังไม่มีประเทศ — กดเพิ่มจากรายการด้านล่าง'),
    h('h4', { style: { margin: '1.2em 0 .5em' } }, '+ เพิ่มประเทศ'),
    h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } }, presets.map(([id, name, flag]) => h('button', { class: 'chip', onclick: () => save([...list, { id, name, flag }], `เพิ่ม ${name} แล้ว`) }, flag + ' ' + name)),
      h('button', { class: 'chip', onclick: () => countryDialog(null, list, save) }, '✏️ เพิ่มประเทศเอง')),
    h('style', {}, '.ct-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; } .ct-card { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; align-items: center; margin: 0 !important; } .ct-card .row { grid-column: 1 / -1; } .ct-flag { width: 3.2em; text-align: center; }'));
}
function countryDialog(c, list, save) {
  const name = h('input', { class: 'input', value: c ? c.name : '', placeholder: 'เช่น เกาหลีใต้' });
  const flag = h('input', { class: 'input', value: c && !/^(\/|https:)/.test(c.flag || '') ? c.flag : '', placeholder: 'อีโมจิธง เช่น 🇰🇷', style: { maxWidth: '160px' } });
  let pic = c && /^(\/|https:)/.test(c.flag || '') ? c.flag : '';
  const prev = h('span');
  const showPrev = () => prev.replaceChildren(flagEl(pic || flag.value, '2.4em'));
  flag.addEventListener('input', () => { if (flag.value) pic = ''; showPrev(); });
  const file = h('input', { type: 'file', accept: 'image/*', onchange: async () => { try { pic = (await upload(file.files[0])).url; flag.value = ''; showPrev(); } catch (e) { errToast(e); } } });
  showPrev();
  modal(c ? 'แก้ไขประเทศ' : 'เพิ่มประเทศ', h('div', {}, h('label', { class: 'field' }, 'ชื่อประเทศ', name),
    h('div', { class: 'row', style: { gap: '12px', alignItems: 'end' } }, h('label', { class: 'field' }, 'ธง (อีโมจิ)', flag), h('label', { class: 'field' }, 'หรืออัปโหลดรูปธง', file), prev)),
  { actions: [c ? { label: 'ลบ', class: 'danger', onClick: async () => { if (!await confirmBox('ลบประเทศ', `ลบ "${c.name}"? สินค้าที่ตั้งไว้จะกลายเป็นไม่ระบุประเทศ`, 'ลบ', true)) return false; await save(list.filter((x) => x.id !== c.id), 'ลบแล้ว'); } } : null,
    { label: 'บันทึก', class: 'primary', onClick: async () => {
      if (!name.value.trim()) { toast('ใส่ชื่อประเทศ', 'warn'); return false; }
      const item = { id: c ? c.id : 'c' + Date.now().toString(36), name: name.value.trim(), flag: pic || flag.value.trim() };
      await save(c ? list.map((x) => (x.id === c.id ? item : x)) : [...list, item]);
    } }].filter(Boolean) });
}
function countryProducts(c, cat, reload) {
  const picked = new Set(cat.products.filter((p) => p.country === c.id).map((p) => p.id));
  let q = '', onlyNone = false;
  const list = h('div', { style: { maxHeight: '56vh', overflow: 'auto', display: 'grid', gap: '4px' } });
  const other = (p) => p.country && p.country !== c.id && (cat.countries || []).find((x) => x.id === p.country);
  const draw = () => list.replaceChildren(...cat.products.filter((p) => (!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)) && (!onlyNone || !p.country || p.country === c.id)).map((p) => {
    const o = other(p);
    return h('label', { class: 'switch', style: { padding: '6px 8px', borderRadius: '10px', background: picked.has(p.id) ? 'var(--brand-soft)' : '' } },
      h('input', { type: 'checkbox', checked: picked.has(p.id), onchange: (e) => { e.target.checked ? picked.add(p.id) : picked.delete(p.id); draw(); } }),
      p.image ? h('img', { src: p.image, style: { width: '34px', height: '34px', objectFit: 'cover', borderRadius: '8px' } }) : '🍜',
      h('span', {}, p.name, h('small', { class: 'muted' }, '  ' + p.code), o ? h('small', { style: { color: 'var(--warn)' } }, `  (ตอนนี้: ${o.name} — ติ๊กแล้วจะย้ายมา)`) : null));
  }));
  const search = h('input', { class: 'input', placeholder: 'ค้นหาสินค้า', oninput: (e) => { q = e.target.value.toLowerCase(); draw(); } });
  draw();
  modal(h('span', {}, flagEl(c.flag, '1.3em'), ` สินค้าจาก${c.name}`), h('div', {}, h('div', { class: 'row', style: { gap: '10px', marginBottom: '8px' } }, search,
    h('label', { class: 'switch' }, h('input', { type: 'checkbox', onchange: (e) => { onlyNone = e.target.checked; draw(); } }), 'เฉพาะที่ยังไม่ระบุประเทศ'),
    h('button', { class: 'btn sm', type: 'button', onclick: () => { for (const el of list.querySelectorAll('input')) el.checked = true; cat.products.forEach((p) => { if ((!q || p.name.toLowerCase().includes(q) || p.code.toLowerCase().includes(q)) && (!onlyNone || !p.country || p.country === c.id)) picked.add(p.id); }); draw(); } }, 'เลือกทั้งหมดที่แสดง')), list),
  { wide: true, actions: [{ label: 'ยกเลิก', onClick: () => {} }, { label: '💾 บันทึก', class: 'primary', onClick: async () => { await api.post(`/countries/${c.id}/products`, { ids: [...picked] }); toast(`สินค้าจาก${c.name}: ${picked.size} รายการ`, 'ok'); reload(); } }] });
}
// delete menu items (asks first); sold items stay in old bills and reports, everything else is removed for good
async function deleteProducts(ids, cat, reload) {
  const names = ids.map((id) => (cat.products.find((p) => p.id === id) || {}).name).filter(Boolean);
  const list = names.slice(0, 8).join(', ') + (names.length > 8 ? ` และอีก ${names.length - 8} รายการ` : '');
  if (!await confirmBox('ลบเมนู', `ลบ ${names.length} เมนูนี้ออกจากร้าน? ${list} — เมนูที่เคยขายแล้ว บิลเก่าและรายงานยังแสดงชื่อเดิมได้ · รหัสสินค้าและบาร์โค้ดของเมนูที่ลบจะใช้ซ้ำกับเมนูใหม่ได้`, 'ลบเมนู', true)) return false;
  const r = await api.post('/products/delete', { ids });
  toast(`ลบแล้ว ${r.removed + r.archived} เมนู`, 'ok');
  reload();
  return true;
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
    { k: 'description', label: 'คำอธิบาย / รายละเอียดสินค้า (แสดงบนจอลูกค้า)', type: 'textarea', wide: true }, { k: 'image', label: 'รูปภาพ', type: 'image' },
    { k: 'highlights', label: 'สรรพคุณ / จุดเด่น (บรรทัดละข้อ เช่น เส้นเหนียวนุ่ม, ซุปเข้มข้น)', type: 'textarea', wide: true },
    { k: 'country', label: '🌏 สินค้าจากประเทศ', type: 'select', options: [['', '— ไม่ระบุ —'], ...(cat.countries || []).map((c) => [c.id, `${/^(\/|https:)/.test(c.flag || '') ? '' : (c.flag || '') + ' '}${c.name}`])], hint: 'เพิ่ม/แก้รายชื่อประเทศได้ที่แท็บ 🌏 ประเทศ' },
    { k: 'spice_level', label: '🌶️ ระดับความเผ็ด', type: 'select', options: [[0, 'ไม่เผ็ด'], [1, '🌶️ เผ็ดน้อย'], [2, '🌶️🌶️'], [3, '🌶️🌶️🌶️ เผ็ดกลาง'], [4, '🌶️🌶️🌶️🌶️'], [5, '🌶️🌶️🌶️🌶️🌶️ เผ็ดมาก']] },
    { k: 'show_details', label: '👁 แสดงรายละเอียดบนจอลูกค้าทุกครั้งที่เพิ่มลงบิล', type: 'bool' },
    { k: 'track_stock', label: 'นับสต็อกสินค้านี้', type: 'bool' }, { k: 'low_stock', label: 'แจ้งเตือนใกล้หมดเมื่อเหลือ', type: 'number' },
    { k: 'active', label: 'เปิดขาย', type: 'bool' }, { k: 'sold_out', label: 'สินค้าหมด', type: 'bool' }, { k: 'mobile', label: 'แสดงใน Mobile Ordering', type: 'bool' },
      { k: 'big_options', label: '✨ Add-on พิเศษ: ตัวเลือกปุ่มใหญ่ กดง่าย (หน้าขาย POS)', type: 'bool' }, { k: 'sort', label: 'ลำดับแสดง', type: 'number' },
  ], v);
  // "ค้นหาข้อมูลสินค้านี้": right under the description box
  const descLabel = f.inputs.description && f.inputs.description.parentElement;
  if (descLabel) descLabel.append(h('button', { type: 'button', class: 'btn sm', style: { marginTop: '6px', alignSelf: 'flex-start' }, onclick: () => researchDialog(f, p) }, '🔍 ค้นหาข้อมูลสินค้านี้ (คำอธิบาย สรรพคุณ ความเผ็ด)'));
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
    p ? { label: '🗑 ลบเมนู', class: 'danger', onClick: async () => { const ok = await deleteProducts([p.id], cat, reload); if (!ok) return false; } } : null,
    p && p.active ? { label: 'ปิดการขาย', onClick: async () => { await api.del('/products/' + p.id); reload(); } } : null,
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
  const num = (v) => Math.round(Number(v || 0) * 100) / 100;
  const prods = s.products, ings = s.ingredients;
  const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
  const isLow = (x) => (x.track_stock !== false) && Number(x.stock) <= Number(x.low_stock || 0);
  const status = (x) => (x.track_stock === false ? h('span', { class: 'badge' }, 'ไม่นับสต็อก') : Number(x.stock) <= 0 ? h('span', { class: 'badge bad' }, 'หมด')
    : isLow(x) ? h('span', { class: 'badge warn' }, 'ใกล้หมด') : h('span', { class: 'badge ok' }, 'ปกติ'));

  // ---- quick adjust: add / count, optional note, low-stock level ----
  let fromCamera = false;
  const adjust = (type, item) => {
    const tracked = type === 'ingredient' || item.track_stock;
    let mode = 'add';
    const qty = h('input', { class: 'input st-qty', type: 'number', step: 'any', inputmode: 'decimal', placeholder: '0' });
    const after = h('b', {});
    const note = h('input', { class: 'input', placeholder: 'หมายเหตุ (ไม่ใส่ก็ได้) เช่น รับของจากร้าน A, ของเสีย' });
    const low = h('input', { class: 'input', type: 'number', min: 0, step: 'any', value: item.low_stock ?? 0 });
    const calc = () => { const q = Number(qty.value) || 0; after.textContent = `${num(mode === 'set' ? q : Number(item.stock) + q)} ${item.unit || ''}`; };
    qty.oninput = calc;
    const step = (d) => { qty.value = num((Number(qty.value) || 0) + d); calc(); };
    const quick = h('div', { class: 'st-quick' });
    const seg = h('div', { class: 'seg st-seg' });
    const drawMode = () => {
      seg.replaceChildren(h('button', { type: 'button', class: mode === 'add' ? 'on' : '', onclick: () => { mode = 'add'; drawMode(); } }, '➕ เพิ่ม / รับเข้า'), h('button', { type: 'button', class: mode === 'set' ? 'on' : '', onclick: () => { mode = 'set'; qty.value = num(item.stock); drawMode(); } }, '📋 นับจริง (ตั้งยอดใหม่)'));
      quick.replaceChildren(...(mode === 'add' ? [1, 6, 12, 24, 48].map((n) => h('button', { type: 'button', class: 'chip', onclick: () => step(n) }, '+' + n)).concat([h('button', { type: 'button', class: 'chip', onclick: () => step(-1) }, '−1')]) : []));
      if (mode === 'add' && Number(qty.value) === num(item.stock)) qty.value = '';
      calc();
    };
    drawMode();
    const save = async (again) => {
      if (qty.value === '' && Number(low.value) === Number(item.low_stock ?? 0) && tracked) { toast('ใส่จำนวน', 'warn'); return false; }
      const r = await api.post('/stock/adjust', { item_type: type, item_id: item.id, qty: qty.value === '' ? undefined : Number(qty.value), mode, note: note.value, low_stock: low.value, track: !tracked });
      toast(`✓ ${item.name} คงเหลือ ${num(r.item.stock)} ${item.unit || ''}`, 'ok');
      reload();
      if (again) setTimeout(() => (fromCamera ? cam() : document.querySelector('.st-scan input') && document.querySelector('.st-scan input').focus()), 400);
    };
    modal('📦 ' + item.name, h('div', { class: 'st-panel' },
      h('div', { class: 'st-head' }, item.image ? h('img', { src: item.image, alt: '' }) : h('span', { class: 'st-ico' }, type === 'ingredient' ? '🧂' : '📦'),
        h('div', {}, h('small', { class: 'muted' }, [item.code, ...(item.barcodes || [])].filter(Boolean).join(' · ')), h('div', { class: 'st-now' }, num(item.stock), h('small', {}, ' ' + (item.unit || ''))), status(item))),
      tracked ? null : h('p', { class: 'st-note' }, 'สินค้านี้ยังไม่ได้นับสต็อก — บันทึกแล้วจะเริ่มนับ และ POS จะขึ้น "หมด" เมื่อเหลือ 0'),
      seg, h('div', { class: 'st-row' }, h('button', { type: 'button', class: 'btn big', onclick: () => step(-1) }, '−'), qty, h('button', { type: 'button', class: 'btn big', onclick: () => step(1) }, '+')), quick,
      h('div', { class: 'st-after' }, 'หลังบันทึก: ', after),
      h('label', { class: 'field' }, 'หมายเหตุ', note),
      h('label', { class: 'field' }, '🔔 แจ้งเตือนว่าใกล้หมดเมื่อเหลือไม่เกิน', low)), { autofocus: false, actions: [
      { label: '🛒 ใส่รายการที่ต้องซื้อ', onClick: () => toList(type, item) },
      { label: 'บันทึก', onClick: () => save(false) },
      { label: '✓ บันทึก แล้วสแกนต่อ', class: 'primary', onClick: () => save(true) }] });
    setTimeout(() => qty.focus(), 80);
  };

  // ---- find by barcode (scanner, also typed with a Thai keyboard), code or name ----
  const find = (raw) => {
    const q = fromThaiKeys(String(raw || '').trim());
    if (!q) return;
    const hit = prods.find((p) => p.code === q || p.barcodes.includes(q));
    if (hit) return adjust('product', hit);
    const byName = [...prods.map((p) => ['product', p]), ...ings.map((x) => ['ingredient', x])].filter(([, x]) => x.name.toLowerCase().includes(String(raw).trim().toLowerCase()));
    if (byName.length === 1) return adjust(byName[0][0], byName[0][1]);
    if (byName.length > 1) return modal('เลือกรายการ', h('div', { class: 'st-pick' }, byName.slice(0, 30).map(([t, x]) => h('button', { class: 'btn block', onclick: (e) => { e.currentTarget.closest('.modal-back').remove(); adjust(t, x); } }, `${x.name} · คงเหลือ ${num(x.stock)}`))));
    toast(`ไม่พบสินค้าบาร์โค้ด/รหัส "${q}" — เพิ่มสินค้าได้ที่ เมนูและสินค้า หรือ ผู้ช่วยเพิ่มสินค้า`, 'warn', 6000);
  };
  const box = h('input', { class: 'input', placeholder: 'ยิงบาร์โค้ด / พิมพ์รหัส หรือชื่อสินค้า แล้วกด Enter', autocomplete: 'off', onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = box.value; box.value = ''; fromCamera = false; find(v); } } });
  const cam = () => { fromCamera = true; scanWithCamera((code) => find(code)); };
  setTimeout(() => box.focus(), 300);

  const lows = [...prods.filter((p) => p.track_stock && isLow(p)).map((p) => ['product', p]), ...ings.filter(isLow).map((x) => ['ingredient', x])];
  // ---- shopping list (also on LINE): what to buy; bought → into stock ----
  const shop = await api.get('/shopping').catch(() => ({ open: [] }));
  const toList = async (t, x) => { await api.post('/shopping', { item_type: t, item_id: x.id, qty: Math.max(1, Math.ceil(Number(x.low_stock || 0) * 2 - Number(x.stock || 0))) }); toast(`🛒 ใส่ ${x.name} ในรายการที่ต้องซื้อแล้ว`, 'ok'); reload(); };
  const other = h('input', { class: 'input', placeholder: 'เพิ่มของอื่น เช่น ถุงหิ้ว, น้ำแข็ง' });
  const listCard = card(h('h3', {}, `🛒 รายการที่ต้องซื้อ (${shop.open.length})`),
    h('div', { class: 'shop-list' }, shop.open.length ? shop.open.map((l) => {
      const q = h('input', { class: 'input', type: 'number', min: 0, step: 'any', value: num(l.qty) });
      return h('div', { class: 'sl-row' }, h('span', {}, l.name, h('small', { class: 'muted' }, l.unit ? ' ' + l.unit : '')), q,
        h('button', { class: 'btn sm primary', onclick: async () => { await api.put('/shopping/' + l.id, { status: 'bought', qty: Number(q.value), restock: !!l.item_id }); toast(l.item_id ? `✓ ซื้อแล้ว · เติมสต็อก +${q.value}` : '✓ ซื้อแล้ว', 'ok'); reload(); } }, l.item_id ? '✓ ซื้อแล้ว + เติมสต็อก' : '✓ ซื้อแล้ว'),
        h('button', { class: 'btn sm ghost', title: 'เอาออก', onclick: async () => { await api.del('/shopping/' + l.id); reload(); } }, '✕'));
    }) : h('p', { class: 'small muted' }, 'ยังไม่มีของที่ต้องซื้อ — กด 🛒 ที่สินค้าใกล้หมด หรือกดในการแจ้งเตือนทาง LINE')),
    h('div', { class: 'sl-add' }, other, h('button', { class: 'btn', onclick: async () => { if (!other.value.trim()) return; await api.post('/shopping', { name: other.value.trim() }); reload(); } }, '+ เพิ่ม'),
      lows.length ? h('button', { class: 'btn', onclick: async () => { for (const [t, x] of lows) if (!shop.open.some((l) => l.item_id === x.id)) await api.post('/shopping', { item_type: t, item_id: x.id, qty: Math.max(1, Math.ceil(Number(x.low_stock || 0) * 2 - Number(x.stock || 0))) }); reload(); } }, `🛒 ใส่ของใกล้หมดทั้งหมด (${lows.length})`) : null));
  const alert = lows.length
    ? h('div', { class: 'st-alert' }, h('b', {}, `⚠️ สินค้า/วัตถุดิบเหลือน้อย ${lows.length} รายการ`),
      h('div', { class: 'st-alert-list' }, lows.map(([t, x]) => h('button', { class: 'st-low' + (Number(x.stock) <= 0 ? ' out' : ''), onclick: () => adjust(t, x) }, h('span', {}, x.name), h('b', {}, Number(x.stock) <= 0 ? 'หมด' : `เหลือ ${num(x.stock)}`), h('small', {}, `แจ้งเตือนที่ ≤ ${num(x.low_stock)}`)))))
    : h('div', { class: 'st-alert ok' }, '✓ ทุกรายการยังมีของพอ');
  const tracked = prods.filter((p) => p.track_stock), others = prods.filter((p) => !p.track_stock);
  // stock report on a receipt printer (compact; under N left printed white on black)
  const printReport = async () => {
    const printers = (await api.get('/printers')).filter((x) => x.active);
    if (!printers.length) return toast('ยังไม่มีเครื่องพิมพ์ — เพิ่มที่ จัดการร้าน → เครื่องพิมพ์', 'warn');
    const first = (printers.find((x) => x.roles.includes('receipt')) || printers[0]).id;
    const sel = h('select', { class: 'input' }, printers.map((x) => h('option', { value: x.id, selected: x.id === first }, `${x.name} (${x.paper} มม.)${isLinkedHere(x.id) ? ' · เชื่อมกับเครื่องนี้' : ''}`)));
    const lowIn = h('input', { class: 'input', type: 'number', min: 0, value: 5 });
    modal('🖨 พิมพ์รายงานสต็อก', h('div', {}, h('label', { class: 'field' }, 'เครื่องพิมพ์', sel), h('label', { class: 'field' }, 'ขึ้นแถบดำ "ใกล้หมด" เมื่อเหลือน้อยกว่า', lowIn),
      h('p', { class: 'small muted' }, 'พิมพ์แบบย่อบนกระดาษใบเสร็จ: ชื่อสินค้า + จำนวนคงเหลือ · รายการที่ใกล้หมด/หมดขึ้นก่อนเป็นแถบขาวดำ')), { actions: [{ label: 'พิมพ์', class: 'primary', onClick: async () => {
      const body = { printer_id: sel.value, low: Number(lowIn.value) };
      if (isLinkedHere(sel.value)) { const r = await api.post('/stock/print', { ...body, local: true }); await printDocument(r.printer, r.template, r.data, 'stock'); toast('🖨 พิมพ์รายงานสต็อกแล้ว', 'ok'); }
      else { const r = await api.post('/stock/print', body); toast(`ส่งพิมพ์แล้วที่ ${r.printer} — ออกเมื่ออุปกรณ์ที่เชื่อมเครื่องพิมพ์ (เช่น POS) เปิดอยู่`, 'ok', 6000); }
    } }] });
  };
  return page('สต็อก',
    alert, listCard,
    card(h('div', { class: 'st-scan' }, h('span', { class: 'st-scan-ico' }, '🔎'), box, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: cam }, '📷 สแกนด้วยกล้อง'), h('button', { class: 'btn', onclick: printReport }, '🖨 พิมพ์รายงานสต็อก'))),
      h('p', { class: 'small muted', style: { margin: '.5em 0 0' } }, 'ยิงบาร์โค้ดด้วยเครื่องยิง (ภาษาไทยก็อ่านได้) หรือเปิดกล้องสแกน → เพิ่มสต็อก/นับจริง ใส่หมายเหตุหรือไม่ใส่ก็ได้ · ตั้งได้ว่าเหลือเท่าไหร่ถึงเรียกว่าใกล้หมด · สินค้าเหลือ 0 จะขึ้น "หมด" ที่ POS ทันที')),
    card(h('h3', {}, 'สินค้าที่นับสต็อก'), table([{ t: '', f: (x) => (x.image ? h('img', { class: 'st-thumb', src: x.image, alt: '' }) : '') }, { t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' },
      { t: 'คงเหลือ', r: 1, f: (x) => `${num(x.stock)} ${x.unit || ''}` }, { t: 'เตือนที่ ≤', r: 1, f: (x) => num(x.low_stock) }, { t: '', f: status }], tracked, { onRow: (x) => adjust('product', x), empty: 'ยังไม่มีสินค้าที่นับสต็อก — สแกนสินค้าเพื่อเริ่มนับ' })),
    card(h('h3', {}, 'วัตถุดิบ'), table([{ t: 'ชื่อ', k: 'name' }, { t: 'คงเหลือ', r: 1, f: (x) => `${num(x.stock)} ${x.unit || ''}` }, { t: 'เตือนที่ ≤', r: 1, f: (x) => num(x.low_stock) }, { t: '', f: status }], ings, { onRow: (x) => adjust('ingredient', x) })),
    others.length ? h('details', { class: 'card' }, h('summary', {}, `สินค้าที่ยังไม่นับสต็อก (${others.length}) — แตะเพื่อเริ่มนับ`),
      table([{ t: 'รหัส', k: 'code' }, { t: 'ชื่อ', k: 'name' }, { t: '', f: () => h('span', { class: 'badge' }, 'ไม่นับสต็อก') }], others, { onRow: (x) => adjust('product', x) })) : null,
    card(h('h3', {}, 'ความเคลื่อนไหวล่าสุด'), table([{ t: 'เวลา', f: (m) => fmtTime(m.created_at) }, { t: 'รายการ', f: (m) => ((m.item_type === 'ingredient' ? ings : prods).find((x) => x.id === m.item_id) || {}).name || m.item_id },
      { t: 'จำนวน', r: 1, f: (m) => (m.qty > 0 ? '+' : '') + num(m.qty) }, { t: 'หมายเหตุ / เหตุผล', k: 'reason' }, { t: 'อ้างอิง', f: (m) => ({ add: 'ปรับ/รับเข้า', set: 'นับจริง' })[m.ref] || m.ref }], s.moves)));
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
  const crew = { weekly: { 0: 1, 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, ...(C0.weekly || {}) }, dates: { ...(C0.dates || {}) }, max: C0.max || 8, print: C0.print === 'off' ? 'off' : 'always', printer_id: C0.printer_id || '', selfie: C0.selfie || 'required', selfie_when: C0.selfie_when || 'every' };
  const printers = await api.get('/printers').catch(() => []);
  const attPrint = h('select', { class: 'input' }, [['always', 'ทุกครั้งที่มีคนเข้างาน (รวมคนแรกและคนที่มาทีหลัง)'], ['off', 'ไม่พิมพ์ (บันทึกเวลาอย่างเดียว)']].map(([v, t]) => h('option', { value: v, selected: crew.print === v }, t)));
  const attSelfie = h('select', { class: 'input' }, [['required', 'บังคับ — ต้องถ่ายรูปและผ่านการตรวจใบหน้าก่อนเข้างาน'], ['optional', 'ถ่ายได้ มีปุ่มข้าม'], ['off', 'ไม่ถ่ายรูป']].map(([v, t]) => h('option', { value: v, selected: crew.selfie === v }, t)));
  const attWhen = h('select', { class: 'input' }, [['every', 'ทุกครั้งที่เข้าระบบ POS'], ['first', 'เฉพาะครั้งแรกของวัน (เข้าซ้ำไม่ต้องถ่าย)']].map(([v, t]) => h('option', { value: v, selected: crew.selfie_when === v }, t)));
  const attPrinter = h('select', { class: 'input' }, h('option', { value: '' }, '— เครื่องพิมพ์ใบเสร็จของเครื่องขายนั้น —'), (printers || []).filter((x) => x.active).map((x) => h('option', { value: x.id, selected: crew.printer_id === x.id }, `${x.name} (${x.paper} มม.)`)));
  const plan = await api.get('/crew/today').catch(() => null);
  const DAYS = [[1, 'จันทร์'], [2, 'อังคาร'], [3, 'พุธ'], [4, 'พฤหัส'], [5, 'ศุกร์'], [6, 'เสาร์'], [0, 'อาทิตย์']];
  const wIn = Object.fromEntries(DAYS.map(([d]) => [d, h('input', { class: 'input', type: 'number', min: 1, max: 12, value: crew.weekly[d] })]));
  const active = staff.filter((x) => x.active);
  const nameOf = (id) => { const x = staff.find((y) => y.id === id); return x ? x.nickname || x.name : '(ลบแล้ว)'; };
  const thDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' });
  const saveCrew = () => api.put('/settings/crew', { value: { weekly: Object.fromEntries(DAYS.map(([d]) => [d, Number(wIn[d].value) || 1])), dates: crew.dates, max: crew.max, print: attPrint.value, printer_id: attPrinter.value, selfie: attSelfie.value, selfie_when: attWhen.value } });
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
    h('h4', {}, '🕘 ลงเวลาเข้างาน · พิมพ์ใบลงเวลา (ชื่อ + เวลาเข้า + QR ให้เจ้าของร้านสแกนดู)'),
    h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'พิมพ์เมื่อ', attPrint), h('label', { class: 'field' }, 'พิมพ์ที่เครื่อง', attPrinter),
      h('label', { class: 'field' }, '📸 ถ่ายรูปตอนเข้างาน (เครื่องไม่มีกล้อง = สแกน QR ถ่ายด้วยมือถือ)', attSelfie), h('label', { class: 'field' }, 'ถ่ายรูปเมื่อ', attWhen)),
    h('div', { class: 'row', style: { marginTop: '.4em' } }, saveBtn('บันทึกตารางและการลงเวลา', saveCrew),
      h('button', { class: 'btn', onclick: async () => { const { url } = await api.get('/attendance/link'); const u = /^https?:/.test(url) ? url : location.origin + url;
        // inside the POS app stay in the same window (no browser tab), elsewhere a new tab
        if (matchMedia('(display-mode: standalone)').matches || localStorage.getItem('opp.admin_from_pos')) location.href = u; else window.open(u, '_blank'); } }, '🕘 ดูเวลาเข้างาน')),
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
