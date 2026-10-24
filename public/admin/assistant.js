// Product assistant: photo of the pack → barcode read in the browser → name and product photos looked up online.
// Staff always type the price and pick the category themselves before saving.
import { h, toast, errToast } from '/shared/ui.js';
import { baht, toSatang } from '/shared/core.js';
import { api, page, card, upload } from './common.js';

// ---------- barcode from a photo ----------
const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf'];
let zxLoad;
const loadZX = () => (zxLoad ||= new Promise((res, rej) => { if (window.ZXing) return res(window.ZXing); const s = document.createElement('script'); s.src = '/vendor/zxing.min.js'; s.onload = () => res(window.ZXing); s.onerror = () => { zxLoad = null; rej(new Error('โหลดตัวอ่านบาร์โค้ดไม่สำเร็จ')); }; document.head.append(s); }));
function drawScaled(img, maxSide, rotate) {
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), hgt = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  c.width = rotate ? hgt : w; c.height = rotate ? w : hgt;
  const x = c.getContext('2d', { willReadFrequently: true });
  if (rotate) { x.translate(hgt, 0); x.rotate(Math.PI / 2); }
  x.drawImage(img, 0, 0, w, hgt);
  return c;
}
export async function readBarcode(img) {
  if ('BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const fm = FORMATS.filter((f) => sup.includes(f));
      if (fm.length) { const r = await new window.BarcodeDetector({ formats: fm }).detect(img); if (r[0]) return r[0].rawValue; }
    } catch { /* fall back to ZXing */ }
  }
  const ZX = await loadZX();
  const hints = new Map();
  hints.set(ZX.DecodeHintType.TRY_HARDER, true);
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF]);
  const reader = new ZX.MultiFormatReader();
  reader.setHints(hints);
  // phone photos are big and often sideways: try a few sizes and both orientations
  for (const side of [1400, 900, 2000]) for (const rot of [false, true]) {
    try {
      const c = drawScaled(img, side, rot);
      const bmp = new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(c)));
      return reader.decode(bmp).getText();
    } catch { /* not found at this size/orientation */ }
  }
  return null;
}

export async function assistantPage() {
  const catalog = await api.get('/catalog?all=1');
  const added = [];
  const root = h('div');
  let photo = null; // { file, objectUrl }

  const step1 = () => {
    const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } });
    const pick = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const code = h('input', { class: 'input big-code', placeholder: 'หรือพิมพ์ / ยิงเครื่องสแกนบาร์โค้ดที่นี่', inputmode: 'numeric', autocomplete: 'off' });
    const status = h('div', { class: 'as-status' });
    const preview = h('div', { class: 'as-photo' }, h('span', {}, '📦'), h('small', {}, 'ถ่ายรูปให้เห็นบาร์โค้ดชัด ๆ'));
    const onFile = async (f) => {
      if (!f) return;
      if (photo) URL.revokeObjectURL(photo.objectUrl);
      photo = { file: f, objectUrl: URL.createObjectURL(f) };
      const img = h('img', { src: photo.objectUrl, alt: '' });
      preview.replaceChildren(img);
      status.className = 'as-status'; status.textContent = '🔎 กำลังอ่านบาร์โค้ดจากรูป…';
      try {
        await img.decode();
        const v = await readBarcode(img);
        if (!v) { status.className = 'as-status warn'; status.textContent = 'ไม่พบบาร์โค้ดในรูป — ลองถ่ายใหม่ให้บาร์โค้ดใหญ่และไม่เบลอ หรือพิมพ์เลขเอง (ยังใช้รูปนี้เป็นรูปสินค้าได้)'; code.focus(); return; }
        code.value = v; status.className = 'as-status ok'; status.textContent = '✅ อ่านบาร์โค้ดได้: ' + v;
        lookup(v);
      } catch (e) { status.className = 'as-status warn'; status.textContent = e.message; }
    };
    camera.onchange = () => onFile(camera.files[0]); pick.onchange = () => onFile(pick.files[0]);
    code.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); if (code.value.trim()) lookup(code.value.trim()); } });
    return card(h('h3', {}, '1. ถ่ายรูปสินค้า (เห็นบาร์โค้ด) หรือสแกนบาร์โค้ด'),
      h('div', { class: 'as-step1' }, preview,
        h('div', { class: 'as-actions' },
          h('button', { class: 'btn primary big', onclick: () => camera.click() }, '📷 ถ่ายรูป'), h('button', { class: 'btn big', onclick: () => pick.click() }, '🖼️ เลือกรูปจากเครื่อง'),
          code, h('button', { class: 'btn', onclick: () => code.value.trim() && lookup(code.value.trim()) }, '🔎 ค้นหาข้อมูลสินค้า'), status, camera, pick)));
  };

  const result = h('div');
  const lookup = async (barcode) => {
    result.replaceChildren(card(h('div', { class: 'empty' }, '🔎 กำลังค้นหาข้อมูลสินค้าจากบาร์โค้ด ', barcode, ' …')));
    let info;
    try { info = await api.post('/products/lookup', { barcode }); } catch (e) { result.replaceChildren(); return errToast(e); }
    if (info.exists) {
      return result.replaceChildren(card(h('h3', {}, 'บาร์โค้ดนี้มีในระบบแล้ว'), h('p', {}, h('b', {}, info.exists.name), ` · ${baht(info.exists.price)} ฿`, info.exists.active ? '' : ' (ปิดขาย)'),
        h('a', { class: 'btn', href: '#/menu' }, 'ไปแก้ไขที่เมนูและสินค้า')));
    }
    result.replaceChildren(step2(info));
  };

  const step2 = (info) => {
    let chosen = info.images && info.images[0] ? { kind: 'url', url: info.images[0] } : photo ? { kind: 'photo' } : { kind: 'none' };
    const name = h('input', { class: 'input', value: (info.names && info.names[0]) || '', placeholder: 'ชื่อสินค้า' });
    const codeIn = h('input', { class: 'input', value: info.suggested_code || '', placeholder: 'รหัสสินค้า (ไม่ซ้ำ)' });
    const bcIn = h('input', { class: 'input', value: info.barcode });
    const price = h('input', { class: 'input must', type: 'number', step: '0.01', min: 0, placeholder: 'ตั้งราคาเอง (บาท)', inputmode: 'decimal' });
    const cat = h('select', { class: 'input must' }, h('option', { value: '' }, '— เลือกหมวดหมู่ —'), catalog.categories.filter((c) => c.active !== 0).map((c) => h('option', { value: c.id }, c.name)));
    const hint = info.suggested_category_id && catalog.categories.find((c) => c.id === info.suggested_category_id);
    const urlIn = h('input', { class: 'input', placeholder: 'วางลิงก์รูปสินค้าที่ต้องการ (https://…)' });
    const grid = h('div', { class: 'as-imgs' });
    const extra = [];
    const drawImgs = () => {
      const opts = [...(info.images || []), ...extra].map((u) => ({ kind: 'url', url: u }));
      if (photo) opts.push({ kind: 'photo' });
      opts.push({ kind: 'none' });
      grid.replaceChildren(...opts.map((o) => {
        const on = chosen.kind === o.kind && (o.kind !== 'url' || chosen.url === o.url);
        return h('button', { class: 'as-img' + (on ? ' on' : ''), onclick: () => { chosen = o; drawImgs(); } },
          o.kind === 'url' ? h('img', { src: o.url, alt: '', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.closest('.as-img').classList.add('broken'); } })
            : o.kind === 'photo' ? h('img', { src: photo.objectUrl, alt: '' }) : h('span', { class: 'none' }, 'ไม่ใส่รูป'),
          h('small', {}, o.kind === 'url' ? (info.source || 'จากลิงก์') : o.kind === 'photo' ? 'รูปที่ถ่าย' : ''), on ? h('i', {}, '✓') : null);
      }));
    };
    drawImgs();
    const googleQ = () => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent((name.value || info.barcode) + ' ' + (info.brand || ''))}`;
    const save = async (e) => {
      const nm = name.value.trim();
      if (!nm) { name.focus(); return toast('กรุณาใส่ชื่อสินค้า', 'warn'); }
      if (price.value === '' || Number(price.value) < 0) { price.focus(); price.classList.add('bad'); return toast('กรุณาตั้งราคาเอง', 'warn'); }
      if (!cat.value) { cat.focus(); cat.classList.add('bad'); return toast('กรุณาเลือกหมวดหมู่', 'warn'); }
      e.target.disabled = true;
      try {
        let image = '';
        if (chosen.kind === 'url') image = (await api.post('/products/import-image', { url: chosen.url })).url;
        else if (chosen.kind === 'photo') image = (await upload(photo.file)).url;
        const code = codeIn.value.trim() || 'P' + Date.now().toString().slice(-8);
        const r = await api.post('/products', { code, name: nm, price: toSatang(price.value), category_id: cat.value, image, barcodes: [bcIn.value.trim()].filter(Boolean), active: true, mobile: true });
        added.unshift({ id: r.id, name: nm, price: toSatang(price.value), image, cat: cat.selectedOptions[0].textContent });
        toast('เพิ่มสินค้าแล้ว: ' + nm, 'ok');
        photo = null; result.replaceChildren(); draw();
      } catch (er) { errToast(er); } finally { e.target.disabled = false; }
    };
    return card(h('h3', {}, '2. ตรวจข้อมูล แล้วตั้งราคาและหมวดหมู่'),
      info.found ? h('div', { class: 'as-src ok' }, `✅ พบข้อมูลจาก ${info.source}`, info.brand ? ` · แบรนด์ ${info.brand}` : '', info.quantity ? ` · ${info.quantity}` : '')
        : h('div', { class: 'as-src warn' }, 'ไม่พบข้อมูลสินค้านี้ในฐานข้อมูลออนไลน์ — ตั้งชื่อเอง และใช้รูปที่ถ่าย / ค้นหารูปจาก Google แล้ววางลิงก์', info.errors && info.errors.length ? h('small', {}, ' (' + info.errors.join(', ') + ')') : null),
      h('div', { class: 'form-grid' },
        h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, 'ชื่อสินค้า (แก้ไขได้)', name,
          (info.names || []).length > 1 ? h('div', { class: 'row', style: { marginTop: '.3em' } }, info.names.map((n) => h('button', { class: 'chip', onclick: () => { name.value = n; } }, n))) : null),
        h('label', { class: 'field' }, h('span', {}, 'ราคาขาย ', h('b', { class: 'req' }, '* ตั้งเอง')), price),
        h('label', { class: 'field' }, h('span', {}, 'หมวดหมู่ ', h('b', { class: 'req' }, '* เลือกเอง')), cat,
          hint ? h('button', { class: 'chip', style: { marginTop: '.3em' }, onclick: () => { cat.value = hint.id; cat.classList.remove('bad'); } }, `แนะนำ: ${hint.name}`) : null),
        h('label', { class: 'field' }, 'บาร์โค้ด', bcIn), h('label', { class: 'field' }, 'รหัสสินค้า', codeIn)),
      h('h4', {}, '🖼️ รูปสินค้า'), grid,
      h('div', { class: 'row', style: { marginTop: '.5em' } }, urlIn,
        h('button', { class: 'btn', onclick: () => { const u = urlIn.value.trim(); if (!/^https?:\/\//i.test(u)) return toast('วางลิงก์รูปที่ขึ้นต้นด้วย https://', 'warn'); extra.push(u); chosen = { kind: 'url', url: u }; urlIn.value = ''; drawImgs(); } }, 'ใช้ลิงก์นี้'),
        h('a', { class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); window.open(googleQ(), '_blank'); } }, '🔍 ค้นหารูปใน Google')),
      h('p', { class: 'small muted' }, 'รูปที่เลือกจะถูกดาวน์โหลดเก็บไว้ในระบบของร้าน (ไม่หายแม้เว็บต้นทางลบรูป)'),
      h('div', { class: 'row', style: { marginTop: '1em' } }, h('button', { class: 'btn primary big', onclick: save }, '✅ บันทึกสินค้า'), h('button', { class: 'btn', onclick: () => result.replaceChildren() }, 'ยกเลิก')));
  };

  const draw = () => root.replaceChildren(step1(), result,
    added.length ? card(h('h3', {}, `เพิ่มแล้วรอบนี้ (${added.length})`), h('div', { class: 'as-added' }, added.map((a) => h('div', {}, a.image ? h('img', { src: a.image, alt: '' }) : h('span', {}, '📦'), h('b', {}, a.name), h('small', {}, `${baht(a.price)} ฿ · ${a.cat}`)))),
      h('a', { class: 'btn', href: '#/menu' }, 'ไปที่เมนูและสินค้า')) : null);
  draw();
  return page('✨ ผู้ช่วยเพิ่มสินค้า', h('p', { class: 'muted' }, 'ถ่ายรูปสินค้า ระบบอ่านบาร์โค้ด ค้นหาชื่อและรูปสินค้าให้ — ร้านตั้งราคาและหมวดหมู่เอง แล้วกดบันทึก'), root);
}
