// Product assistant: any product photo (barcode optional) → AI identifies it, writes many Thai/English names and
// many good-looking photos are gathered; a barcode in the photo is read in the browser and looked up too.
// Staff always type the price and pick the category themselves before saving.
import { h, toast, errToast, modal } from '/shared/ui.js';
import { baht, toSatang } from '/shared/core.js';
import { api, page, card, upload, can, form } from './common.js';

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


// ---------- read the text printed on the pack (no AI, runs in the browser; Thai + English) ----------
let ocrWorker;
async function ocrWords(file, onProgress) {
  if (!window.Tesseract) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/tesseract.min.js'; s.onload = res; s.onerror = () => rej(new Error('โหลดตัวอ่านตัวอักษรไม่สำเร็จ')); document.head.append(s); });
  ocrWorker ||= window.Tesseract.createWorker(['eng', 'tha'], 1, { workerPath: '/vendor/tesseract-worker.min.js', corePath: '/vendor/tesseract-core', langPath: '/vendor/tessdata' });
  const worker = await ocrWorker;
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
  // two passes: as photographed (dark text) and high-contrast grey (light text on colour); each finds words the other misses
  const passes = ['none', 'grayscale(1) contrast(1.4)'];
  const seen = new Map();
  for (let i = 0; i < passes.length; i++) {
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    const x = c.getContext('2d'); x.filter = passes[i]; x.drawImage(img, 0, 0, c.width, c.height);
    const { data } = await worker.recognize(c);
    if (onProgress) onProgress((i + 1) / passes.length);
    // big, confident words are the brand / product name; small print is ingredients
    for (const w of data.words || []) {
      const t = String(w.text || '').replace(/[^\p{L}\p{N}&'.-]/gu, '').replace(/^[.'-]+|[.'-]+$/g, '');
      const thai = /[\u0E00-\u0E7F]/.test(t);
      if (w.confidence < (thai ? 70 : 60) || t.length < (thai ? 3 : 3) || /^\d+$/.test(t) || !/\p{L}/u.test(t)) continue;
      const h = w.bbox ? w.bbox.y1 - w.bbox.y0 : 10;
      const key = t.toLowerCase(), score = h * (w.confidence / 100);
      if (!seen.has(key) || seen.get(key).score < score) seen.set(key, { text: t, score });
    }
  }
  URL.revokeObjectURL(img.src);
  return [...seen.values()].sort((a, b) => b.score - a.score).map((w) => w.text).slice(0, 16);
}

// phone photos are several MB: send the AI a ≤1280 px JPEG
async function toJpegDataUrl(file, max = 1280) {
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  URL.revokeObjectURL(img.src);
  return c.toDataURL('image/jpeg', 0.85);
}
// "make my photo look like a promo shot": square crop, soft blurred backdrop, a little more light, contrast and colour
async function enhancePhoto(file, size = 1080) {
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  const c = document.createElement('canvas'); c.width = c.height = size;
  const x = c.getContext('2d');
  const cover = Math.max(size / img.naturalWidth, size / img.naturalHeight) * 1.15;
  x.filter = 'blur(28px) brightness(1.08) saturate(1.2)';
  x.drawImage(img, (size - img.naturalWidth * cover) / 2, (size - img.naturalHeight * cover) / 2, img.naturalWidth * cover, img.naturalHeight * cover);
  x.filter = 'none';
  const g = x.createRadialGradient(size / 2, size / 2, size * 0.2, size / 2, size / 2, size * 0.75);
  g.addColorStop(0, 'rgba(255,255,255,0.35)'); g.addColorStop(1, 'rgba(0,0,0,0.25)');
  x.fillStyle = g; x.fillRect(0, 0, size, size);
  const fit = Math.min(size * 0.86 / img.naturalWidth, size * 0.86 / img.naturalHeight);
  const w = img.naturalWidth * fit, hh = img.naturalHeight * fit;
  x.shadowColor = 'rgba(0,0,0,0.35)'; x.shadowBlur = 40; x.shadowOffsetY = 18;
  x.filter = 'brightness(1.06) contrast(1.08) saturate(1.15)';
  x.drawImage(img, (size - w) / 2, (size - hh) / 2, w, hh);
  URL.revokeObjectURL(img.src);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
  return new File([blob], 'product-enhanced.jpg', { type: 'image/jpeg' });
}

export async function assistantPage() {
  const [catalog, conf0] = await Promise.all([api.get('/catalog?all=1'), api.get('/assistant/config')]);
  let conf = conf0;
  const added = [];
  const root = h('div');
  let photo = null; // { file, objectUrl }
  let enhanced = null; // { file, objectUrl }

  const settingsDialog = () => {
    const f = form([
      { k: 'anthropic_api_key', label: `Claude API Key (${conf.model}) — วิเคราะห์รูปสินค้าและตั้งชื่อ`, type: 'password', placeholder: conf.ai ? `บันทึกแล้ว (${conf.hints.anthropic}) — เว้นว่างเพื่อใช้ค่าเดิม` : 'sk-ant-… จาก console.anthropic.com', wide: true },
      { k: 'pexels_api_key', label: 'Pexels API Key (ฟรี) — รูปโปรโมทคุณภาพสูง', type: 'password', placeholder: conf.pexels ? `บันทึกแล้ว (${conf.hints.pexels})` : 'จาก pexels.com/api', wide: true },
      { k: 'serper_api_key', label: 'Serper API Key (ฟรี 2,500 ครั้ง) — ค้นรูปสินค้าจาก Google Images', type: 'password', placeholder: conf.serper ? `บันทึกแล้ว (${conf.hints.serper})` : 'จาก serper.dev', wide: true }], {});
    modal('⚙️ ตัวเลือกเพิ่มเติม (ไม่บังคับ)', h('div', {}, f,
      h('p', { class: 'small muted' }, 'ทั้งหมดนี้ไม่บังคับ — ไม่ใส่อะไรเลย ระบบก็อ่านชื่อจากรูปและค้นหาชื่อ/รูปจากเว็บได้ · คีย์เก็บไว้ที่เซิร์ฟเวอร์เท่านั้น · Claude (ถ้าใส่) ช่วยระบุสินค้าที่ไม่มีตัวหนังสือชัด ๆ ค่าใช้ประมาณ 1 บาทต่อรูป')),
    { wide: true, actions: [{ label: 'ลบคีย์ทั้งหมด', class: 'ghost', onClick: async () => { if (!confirm('ลบคีย์ AI และแหล่งรูปทั้งหมด?')) return false; await api.put('/assistant/config', { clear: ['anthropic_api_key', 'pexels_api_key', 'serper_api_key'] }); conf = await api.get('/assistant/config'); draw(); } },
      { label: 'บันทึก', class: 'primary', onClick: async () => { await api.put('/assistant/config', f.value()); conf = await api.get('/assistant/config'); toast('บันทึกแล้ว', 'ok'); draw(); } }] });
  };
  const status = () => card(h('div', { class: 'as-conf' },
    h('div', {}, h('b', { class: 'ok' }, conf.ai ? '✅ พร้อม — ใช้ AI ช่วยดูรูป (เปิดอยู่)' : '✅ พร้อมใช้ ไม่ต้องใช้ AI — ระบบอ่านชื่อบนซอง/บาร์โค้ดจากรูป แล้วค้นหาชื่อและรูปจากเว็บให้เอง'),
      h('small', {}, ' แหล่ง: เว็บ (DuckDuckGo) · Open Food Facts · Openverse · Wikimedia', conf.pexels ? ' · Pexels' : '', conf.serper ? ' · Google Images' : '')),
    can('settings') ? h('button', { class: 'btn ghost', onclick: settingsDialog }, '⚙️ ตัวเลือกเพิ่มเติม (ไม่บังคับ)') : null));

  const step1 = () => {
    const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', style: { display: 'none' } });
    const pick = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    const code = h('input', { class: 'input', placeholder: 'บาร์โค้ด (ไม่บังคับ — ยิงเครื่องสแกนได้)', inputmode: 'numeric', autocomplete: 'off' });
    const text = h('input', { class: 'input', placeholder: 'หรือพิมพ์ชื่อสินค้า เช่น ซัมยัง บูลดัก คาโบนาร่า' });
    const msg = h('div', { class: 'as-status' });
    const wordBox = h('div', { class: 'as-words' });
    let picked = [];
    const drawWords = (all) => wordBox.replaceChildren(...(all.length ? [h('small', { class: 'muted' }, 'คำที่อ่านได้จากรูป — แตะเพื่อเลือก/ไม่เลือกเป็นคำค้นหา: '),
      ...all.map((w) => h('button', { class: 'chip' + (picked.includes(w) ? ' on' : ''), onclick: () => { picked = picked.includes(w) ? picked.filter((x) => x !== w) : [...picked, w]; text.value = picked.join(' '); drawWords(all); } }, w)),
      h('button', { class: 'btn sm', onclick: go }, '🔎 ค้นหาใหม่ด้วยคำที่เลือก')] : []));
    const preview = h('div', { class: 'as-photo' }, h('span', {}, '📦'), h('small', {}, 'ถ่ายรูปสินค้าได้เลย ไม่ต้องเห็นบาร์โค้ด'));
    const onFile = async (f) => {
      if (!f) return;
      if (photo) URL.revokeObjectURL(photo.objectUrl);
      if (enhanced) { URL.revokeObjectURL(enhanced.objectUrl); enhanced = null; }
      photo = { file: f, objectUrl: URL.createObjectURL(f) };
      const img = h('img', { src: photo.objectUrl, alt: '' });
      preview.replaceChildren(img);
      msg.className = 'as-status'; msg.textContent = '🔎 กำลังดูรูป…';
      code.value = ''; wordBox.replaceChildren();
      try { await img.decode(); const v = await readBarcode(img).catch(() => null); if (v) { code.value = v; msg.textContent = '🔎 อ่านบาร์โค้ดได้ ' + v + ' — กำลังค้นหาข้อมูลและรูปภาพ…'; } } catch { /* identify still works without a barcode */ }
      if (!conf.ai) {
        // no AI: read the name printed on the pack and search with it
        try {
          msg.className = 'as-status'; msg.textContent = '🔤 กำลังอ่านชื่อสินค้าบนซอง…';
          const all = await ocrWords(f, (p) => { msg.textContent = `🔤 กำลังอ่านชื่อสินค้าบนซอง… ${Math.round(p * 100)}%`; });
          picked = all.slice(0, Math.min(4, all.length));
          if (picked.length) { text.value = picked.join(' '); drawWords(all); }
          else if (!code.value) { msg.className = 'as-status warn'; msg.textContent = 'อ่านชื่อบนรูปไม่ออก — พิมพ์ชื่อสินค้าสั้น ๆ แล้วกดค้นหา (ยังใช้รูปนี้เป็นรูปสินค้าได้)'; text.focus(); return; }
        } catch (e) { if (!code.value) { msg.className = 'as-status warn'; msg.textContent = e.message + ' — พิมพ์ชื่อสินค้าแล้วกดค้นหา'; return; } }
      }
      go();
    };
    const go = async () => {
      if (!photo && !text.value.trim() && !code.value.trim()) return toast('ถ่ายรูปสินค้า หรือพิมพ์ชื่อ/บาร์โค้ดก่อน', 'warn');
      msg.className = 'as-status'; msg.textContent = conf.ai ? '🤖 AI กำลังวิเคราะห์สินค้า ตั้งชื่อ และค้นหารูปภาพ… (ประมาณ 10–20 วินาที)' : `🔎 กำลังค้นหา "${text.value.trim() || code.value.trim()}" จากเว็บ…`;
      result.replaceChildren(card(h('div', { class: 'as-loading' }, h('i'), h('i'), h('i'), h('span', {}, msg.textContent))));
      try {
        const body = { barcode: code.value.trim(), text: text.value.trim() };
        if (photo && conf.ai) body.image = await toJpegDataUrl(photo.file); // the photo only leaves the shop when AI is switched on
        const info = await api.post('/products/identify', body);
        msg.className = 'as-status ok'; msg.textContent = '✅ เสร็จแล้ว — ตรวจข้อมูลด้านล่าง';
        showResult(info);
      } catch (e) { msg.className = 'as-status warn'; msg.textContent = e.message; result.replaceChildren(); }
    };
    camera.onchange = () => onFile(camera.files[0]); pick.onchange = () => onFile(pick.files[0]);
    for (const i of [code, text]) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    return card(h('h3', {}, '1. ถ่ายรูปสินค้า หรือพิมพ์ชื่อ'),
      h('div', { class: 'as-step1' }, preview,
        h('div', { class: 'as-actions' },
          h('div', { class: 'row' }, h('button', { class: 'btn primary big', style: { flex: 1 }, onclick: () => camera.click() }, '📷 ถ่ายรูปสินค้า'), h('button', { class: 'btn big', style: { flex: 1 }, onclick: () => pick.click() }, '🖼️ เลือกรูป')),
          text, wordBox, code, h('button', { class: 'btn', onclick: go }, '🔎 ค้นหาข้อมูลและรูปภาพ'), msg, camera, pick)));
  };

  const result = h('div');
  const showResult = (info) => {
    if (info.exists) return result.replaceChildren(card(h('h3', {}, 'สินค้านี้มีในระบบแล้ว'), h('p', {}, h('b', {}, info.exists.name), ` · ${baht(info.exists.price)} ฿ · บาร์โค้ด ${info.barcode}`), h('a', { class: 'btn', href: '#/menu' }, 'ไปแก้ไขที่เมนูและสินค้า')));
    if (info.need_text || (!info.names.length && !info.images.length)) {
      return result.replaceChildren(card(h('h3', {}, 'ยังหาสินค้าไม่เจอ'),
        h('p', {}, info.ai_error || 'พิมพ์ชื่อสินค้าสั้น ๆ (เช่น ยี่ห้อ + ชื่อรุ่น) ในช่องด้านบน แล้วกดค้นหาอีกครั้ง')));
    }
    result.replaceChildren(step2(info));
  };

  const step2 = (info) => {
    // option type t: url | photo | enhanced | none; image kind (product | promo) stays in .kind
    let chosen = info.images[0] ? { ...info.images[0], t: 'url' } : photo ? { t: 'photo' } : { t: 'none' };
    let filter = 'all';
    const name = h('input', { class: 'input', value: info.names[0] || '', placeholder: 'ชื่อสินค้า' });
    const codeIn = h('input', { class: 'input', value: info.suggested_code || '', placeholder: 'รหัสสินค้า (ไม่ซ้ำ) — เว้นว่างให้ระบบตั้ง' });
    const bcIn = h('input', { class: 'input', value: info.barcode || '', placeholder: 'ไม่มีก็ได้' });
    const price = h('input', { class: 'input must', type: 'number', step: '0.01', min: 0, placeholder: 'ตั้งราคาเอง (บาท)', inputmode: 'decimal' });
    const cat = h('select', { class: 'input must' }, h('option', { value: '' }, '— เลือกหมวดหมู่ —'), catalog.categories.filter((c) => c.active !== 0).map((c) => h('option', { value: c.id }, c.name)));
    const hint = info.suggested_category_id && catalog.categories.find((c) => c.id === info.suggested_category_id);
    const urlIn = h('input', { class: 'input', placeholder: 'วางลิงก์รูปสินค้าที่ต้องการ (https://…)' });
    const grid = h('div', { class: 'as-imgs' });
    const tabs = h('div', { class: 'tabs', style: { margin: '.4em 0 .6em' } });
    const extra = [];
    const thai = (n) => /[฀-๿]/.test(n);
    const chipBox = h('div', { class: 'as-names' });
    const drawNames = () => chipBox.replaceChildren(
      ...[['🇹🇭 ภาษาไทย', info.names.filter(thai)], ['🔤 อังกฤษ/อื่น ๆ', info.names.filter((n) => !thai(n))]].filter(([, l]) => l.length).map(([t, l]) => h('div', {}, h('small', { class: 'muted' }, t),
        h('div', { class: 'row', style: { gap: '.35em', marginTop: '.2em' } }, l.map((n) => h('button', { class: 'chip' + (name.value === n ? ' on' : ''), onclick: () => { name.value = n; drawNames(); } }, n))))));
    name.addEventListener('input', drawNames);
    const opts = () => {
      const all = [...info.images.map((im) => ({ ...im, t: 'url' })), ...extra.map((u) => ({ url: u, thumb: u, source: 'ลิงก์ที่วาง', kind: 'product', t: 'url' }))];
      const list = filter === 'all' ? all : filter === 'mine' ? [] : all.filter((o) => o.kind === filter);
      if (photo && (filter === 'all' || filter === 'mine')) { list.push({ t: 'photo' }); if (enhanced) list.push({ t: 'enhanced' }); }
      if (filter === 'all') list.push({ t: 'none' });
      return list;
    };
    const drawImgs = () => {
      const counts = { product: info.images.filter((x) => x.kind === 'product').length, promo: info.images.filter((x) => x.kind === 'promo').length };
      tabs.replaceChildren(...[['all', `ทั้งหมด (${info.images.length + extra.length})`], ['product', `รูปสินค้า (${counts.product})`], ['promo', `รูปโปรโมทสวย ๆ (${counts.promo})`], photo ? ['mine', 'รูปที่ถ่าย'] : null].filter(Boolean)
        .map(([k, t]) => h('button', { class: 'tab' + (filter === k ? ' active' : ''), onclick: () => { filter = k; drawImgs(); } }, t)));
      const list = opts();
      grid.replaceChildren(...(list.length ? list.map((o) => {
        const on = chosen.t === o.t && (o.t !== 'url' || chosen.url === o.url);
        const src = o.t === 'url' ? o.thumb || o.url : o.t === 'photo' ? photo.objectUrl : o.t === 'enhanced' ? enhanced.objectUrl : null;
        return h('button', { class: 'as-img' + (on ? ' on' : ''), title: o.title || '', onclick: () => { chosen = o; drawImgs(); } },
          src ? h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => { e.target.closest('.as-img').classList.add('broken'); } }) : h('span', { class: 'none' }, 'ไม่ใส่รูป'),
          h('small', {}, o.t === 'url' ? o.source || '' : o.t === 'photo' ? 'รูปที่ถ่าย' : o.t === 'enhanced' ? '✨ รูปที่ถ่าย (ปรับให้สวย)' : ''), on ? h('i', {}, '✓') : null);
      }) : [h('div', { class: 'empty' }, 'ไม่มีรูปในหมวดนี้')]));
    };
    drawImgs(); drawNames();
    const makePretty = async (e) => {
      e.target.disabled = true;
      try { const f = await enhancePhoto(photo.file); if (enhanced) URL.revokeObjectURL(enhanced.objectUrl); enhanced = { file: f, objectUrl: URL.createObjectURL(f) }; chosen = { t: 'enhanced' }; filter = 'mine'; drawImgs(); }
      catch (er) { errToast(er); } finally { e.target.disabled = false; }
    };
    const googleQ = () => `https://www.google.com/search?tbm=isch&q=${encodeURIComponent([info.brand, name.value || info.barcode].filter(Boolean).join(' '))}`;
    const save = async (e) => {
      const nm = name.value.trim();
      if (!nm) { name.focus(); return toast('กรุณาใส่ชื่อสินค้า', 'warn'); }
      if (price.value === '' || Number(price.value) < 0) { price.focus(); price.classList.add('bad'); return toast('กรุณาตั้งราคาเอง', 'warn'); }
      if (!cat.value) { cat.focus(); cat.classList.add('bad'); return toast('กรุณาเลือกหมวดหมู่', 'warn'); }
      e.target.disabled = true;
      try {
        let image = '';
        if (chosen.t === 'url') image = (await api.post('/products/import-image', { url: chosen.url }).catch(async (er) => (chosen.thumb && chosen.thumb !== chosen.url ? api.post('/products/import-image', { url: chosen.thumb }) : Promise.reject(er)))).url;
        else if (chosen.t === 'photo') image = (await upload(photo.file)).url;
        else if (chosen.t === 'enhanced') image = (await upload(enhanced.file)).url;
        const code = codeIn.value.trim() || 'P' + Date.now().toString().slice(-8);
        const r = await api.post('/products', { code, name: nm, price: toSatang(price.value), category_id: cat.value, image, barcodes: [bcIn.value.trim()].filter(Boolean), active: true, mobile: true });
        added.unshift({ id: r.id, name: nm, price: toSatang(price.value), image, cat: cat.selectedOptions[0].textContent });
        toast('เพิ่มสินค้าแล้ว: ' + nm, 'ok');
        photo = null; enhanced = null; result.replaceChildren(); draw();
      } catch (er) { errToast(er); } finally { e.target.disabled = false; }
    };
    const facts = [info.product_type, info.brand && 'แบรนด์ ' + info.brand, info.flavor, info.quantity].filter(Boolean).join(' · ') || (info.query ? `ค้นหา "${info.query}" · พบ ${info.names.length} ชื่อ ${info.images.length} รูป` : '');
    return card(h('h3', {}, '2. เลือกชื่อและรูป แล้วตั้งราคาและหมวดหมู่'),
      h('div', { class: 'as-src ' + (info.identified ? 'ok' : 'warn') }, info.identified ? `✅ ${info.source}: ` : `⚠️ ${info.source || 'ข้อมูลไม่ครบ'} — ตรวจสอบก่อนบันทึก: `, facts || 'ไม่ทราบรายละเอียด',
        info.ai_error ? h('small', {}, ' · AI: ' + info.ai_error) : null),
      h('label', { class: 'field' }, `ชื่อสินค้า — แตะชื่อที่ชอบ (${info.names.length} ชื่อ) หรือแก้เอง`, name), chipBox,
      h('div', { class: 'form-grid', style: { marginTop: '.8em' } },
        h('label', { class: 'field' }, h('span', {}, 'ราคาขาย ', h('b', { class: 'req' }, '* ตั้งเอง')), price),
        h('label', { class: 'field' }, h('span', {}, 'หมวดหมู่ ', h('b', { class: 'req' }, '* เลือกเอง')), cat,
          hint ? h('button', { class: 'chip', style: { marginTop: '.3em' }, onclick: () => { cat.value = hint.id; cat.classList.remove('bad'); } }, `แนะนำ: ${hint.name}`) : null),
        h('label', { class: 'field' }, 'บาร์โค้ด', bcIn), h('label', { class: 'field' }, 'รหัสสินค้า', codeIn)),
      h('h4', {}, `🖼️ รูปสินค้า — พบ ${info.images.length} รูป`), tabs, grid,
      h('div', { class: 'row', style: { marginTop: '.6em' } },
        photo ? h('button', { class: 'btn', onclick: makePretty }, '✨ ปรับรูปที่ถ่ายให้สวยแบบรูปโปรโมท') : null,
        h('a', { class: 'btn', href: '#', onclick: (e) => { e.preventDefault(); window.open(googleQ(), '_blank'); } }, '🔍 หารูปเพิ่มใน Google')),
      h('div', { class: 'row', style: { marginTop: '.5em' } }, urlIn,
        h('button', { class: 'btn', onclick: () => { const u = urlIn.value.trim(); if (!/^https?:\/\//i.test(u)) return toast('วางลิงก์รูปที่ขึ้นต้นด้วย https://', 'warn'); extra.push(u); chosen = { t: 'url', url: u, thumb: u }; urlIn.value = ''; filter = 'all'; drawImgs(); } }, 'ใช้ลิงก์นี้')),
      h('p', { class: 'small muted' }, 'รูปที่เลือกถูกดาวน์โหลดเก็บไว้ในระบบของร้าน · รูปจาก Google Images เป็นของเว็บต้นทาง ควรใช้รูปที่ร้านมีสิทธิ์ใช้ (รูปจาก Pexels/Openverse ใช้เชิงพาณิชย์ได้ตามสัญญาอนุญาต)', info.errors && info.errors.length ? ` · แหล่งที่ตอบไม่ได้: ${info.errors.length}` : ''),
      h('div', { class: 'row', style: { marginTop: '1em' } }, h('button', { class: 'btn primary big', onclick: save }, '✅ บันทึกสินค้า'), h('button', { class: 'btn', onclick: () => result.replaceChildren() }, 'ยกเลิก')));
  };

  const draw = () => root.replaceChildren(status(), step1(), result,
    added.length ? card(h('h3', {}, `เพิ่มแล้วรอบนี้ (${added.length})`), h('div', { class: 'as-added' }, added.map((a) => h('div', {}, a.image ? h('img', { src: a.image, alt: '' }) : h('span', {}, '📦'), h('b', {}, a.name), h('small', {}, `${baht(a.price)} ฿ · ${a.cat}`)))),
      h('a', { class: 'btn', href: '#/menu' }, 'ไปที่เมนูและสินค้า')) : null);
  draw();
  return page('✨ ผู้ช่วยเพิ่มสินค้า', h('p', { class: 'muted' }, 'ถ่ายรูปสินค้า (ไม่ต้องเห็นบาร์โค้ด) — ระบบอ่านชื่อบนซอง ค้นหาชื่อสินค้าหลายแบบทั้งไทยและอังกฤษ และรูปสวย ๆ จากเว็บมาให้เลือก · ร้านตั้งราคาและหมวดหมู่เอง'), root);
}
