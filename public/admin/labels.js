// Product barcode labels: pick products and quantities, set size / fields / font, preview, then print
// on a shop printer (ESC/POS) or through the browser (any sticker printer with a driver, or save as PDF).
import { h, toast, errToast, debounce } from '/shared/ui.js';
import { baht, isEan13 } from '/shared/core.js';
import { fontCatalog, loadFont } from '/shared/fonts.js';
import { LABEL_PRESETS, labelCfg, labelRowDots, renderLabelRow } from '/shared/labels.js';
import { api, ctx, page, card } from './common.js';
import { pairPrinter, isLinkedHere, printDocument, support } from '/shared/printers.js';

const bestBarcode = (codes) => codes.find(isEan13) || codes[0] || '';

export async function labelsPage() {
  const [catalog, saved, printers, fonts] = await Promise.all([api.get('/catalog'), api.get('/labels/config'), api.get('/printers'), fontCatalog(true).catch(() => [])]);
  const cfg = labelCfg(saved);
  const families = [...new Set(['Sarabun', ...fonts.map((f) => f.family)])];
  const qty = new Map(); // product id → number of labels
  let q = '', cat = '';
  const store = ctx.settings.store.name;
  const itemOf = (p) => ({ name: p.name, price: p.price, code: p.code, barcode: bestBarcode(p.barcodes), store });

  // ---- product picker ----
  const listBox = h('div', { class: 'lbl-list' });
  const summary = h('div', { class: 'row between', style: { marginTop: '.6em' } });
  const visible = () => catalog.products.filter((p) => (!cat || p.category_id === cat) && (!q || `${p.name} ${p.code} ${p.barcodes.join(' ')}`.toLowerCase().includes(q)));
  const drawList = () => {
    const list = visible();
    listBox.replaceChildren(...(list.length ? list.map((p) => {
      const n = qty.get(p.id) || 0;
      const num = h('input', { class: 'input', type: 'number', min: 0, max: 200, value: n || '', placeholder: '0', style: { width: '76px', textAlign: 'center' } });
      num.addEventListener('input', () => { const v = Math.max(0, Math.min(200, Math.round(Number(num.value) || 0))); if (v) qty.set(p.id, v); else qty.delete(p.id); row.classList.toggle('on', !!v); drawSummary(); preview(); });
      const step = (d) => { num.value = Math.max(0, (Number(num.value) || 0) + d) || ''; num.dispatchEvent(new Event('input')); };
      const bc = bestBarcode(p.barcodes);
      const row = h('div', { class: 'lbl-row' + (n ? ' on' : '') },
        h('div', { class: 'nm' }, h('b', {}, p.name), h('small', {}, `${p.code} · ${baht(p.price)} ฿ · `, bc ? h('span', { class: 'mono' }, bc) : h('span', { class: 'badge warn' }, 'ไม่มีบาร์โค้ด (ใช้รหัสสินค้า)'))),
        h('div', { class: 'qtyc' }, h('button', { class: 'btn sm', onclick: () => step(-1) }, '−'), num, h('button', { class: 'btn sm', onclick: () => step(1) }, '+')));
      return row;
    }) : [h('div', { class: 'empty' }, 'ไม่พบสินค้า')]));
  };
  const total = () => [...qty.values()].reduce((a, b) => a + b, 0);
  const drawSummary = () => summary.replaceChildren(h('strong', {}, `เลือก ${qty.size} สินค้า · ${total()} ดวง`),
    h('div', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => { for (const p of visible()) if (!qty.get(p.id)) qty.set(p.id, 1); drawList(); drawSummary(); preview(); } }, 'เลือกทั้งหมดที่แสดง (1 ดวง)'),
      h('button', { class: 'btn sm', onclick: () => { qty.clear(); drawList(); drawSummary(); preview(); } }, 'ล้าง')));
  const search = h('input', { class: 'input', placeholder: '🔍 ค้นหาชื่อ / รหัส / บาร์โค้ด' });
  search.addEventListener('input', debounce(() => { q = search.value.trim().toLowerCase(); drawList(); }, 200));
  const catSel = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'ทุกหมวด'), catalog.categories.map((c) => h('option', { value: c.id }, c.name)));
  catSel.addEventListener('change', () => { cat = catSel.value; drawList(); });
  const genBtn = h('button', { class: 'btn', onclick: async () => {
    const ids = [...qty.keys()].filter((id) => !catalog.products.find((p) => p.id === id).barcodes.length);
    const target = ids.length ? ids : catalog.products.filter((p) => !p.barcodes.length).map((p) => p.id);
    if (!target.length) return toast('ทุกสินค้ามีบาร์โค้ดแล้ว', 'ok');
    if (!confirm(`สร้างบาร์โค้ด EAN-13 ภายในร้าน (ขึ้นต้น 20) ให้ ${target.length} สินค้าที่ยังไม่มี?`)) return;
    try {
      const r = await api.post('/products/barcodes/generate', { product_ids: target });
      for (const m of r.created) { const p = catalog.products.find((x) => x.id === m.product_id); if (p) p.barcodes.push(m.barcode); }
      toast(`สร้างบาร์โค้ดแล้ว ${r.created.length} สินค้า`, 'ok'); drawList(); preview();
    } catch (e) { errToast(e); }
  } }, '✨ สร้างบาร์โค้ดให้สินค้าที่ยังไม่มี');

  // ---- settings ----
  const inputs = {};
  const num = (k, label, step = 1, min = 0) => { const i = h('input', { class: 'input', type: 'number', step, min, value: cfg[k] }); i.addEventListener('input', () => { cfg[k] = Number(i.value) || 0; preview(); }); inputs[k] = i; return h('label', { class: 'field' }, label, i); };
  const sel = (k, label, opts) => { const i = h('select', { class: 'input' }, opts.map(([v, t]) => h('option', { value: v, selected: String(cfg[k]) === String(v) }, t))); i.addEventListener('change', () => { cfg[k] = isNaN(i.value) || i.value === '' ? i.value : Number(i.value); preview(); }); inputs[k] = i; return h('label', { class: 'field' }, label, i); };
  const chk = (k, label) => { const i = h('input', { type: 'checkbox', checked: !!cfg[k] }); i.addEventListener('change', () => { cfg[k] = i.checked; preview(); }); inputs[k] = i; return h('label', { class: 'switch' }, i, label); };
  const txt = (k, label, ph = '') => { const i = h('input', { class: 'input', value: cfg[k] || '', placeholder: ph }); i.addEventListener('input', () => { cfg[k] = i.value; preview(); }); inputs[k] = i; return h('label', { class: 'field' }, label, i); };
  const preset = h('select', { class: 'input' }, h('option', { value: '' }, '— กำหนดเอง —'), LABEL_PRESETS.map(([v, t]) => h('option', { value: v, selected: `${cfg.width_mm}x${cfg.height_mm}` === v }, t)));
  preset.addEventListener('change', () => { if (!preset.value) return; const [w, hh] = preset.value.split('x').map(Number); cfg.width_mm = w; cfg.height_mm = hh; inputs.width_mm.value = w; inputs.height_mm.value = hh; preview(); checkFit(); });
  const settings = h('div', { class: 'lbl-settings' },
    h('h4', {}, '📐 ขนาดฉลาก'),
    h('div', { class: 'form-grid' }, h('label', { class: 'field', style: { gridColumn: '1 / -1' } }, 'ขนาดสำเร็จรูป', preset), num('width_mm', 'กว้าง (มม.)', 1, 15), num('height_mm', 'สูง (มม.)', 1, 10),
      sel('cols', 'จำนวนดวงต่อแถว', [[1, '1 ดวง'], [2, '2 ดวง'], [3, '3 ดวง'], [4, '4 ดวง']]), num('gap_mm', 'ระยะห่างระหว่างดวง (มม.)', 0.5), num('padding_mm', 'ขอบใน (มม.)', 0.5)),
    h('h4', {}, '🧾 ข้อมูลบนฉลาก'),
    h('div', { class: 'chk-grid' }, chk('show_name', 'ชื่อสินค้า'), chk('show_price', 'ราคา'), chk('show_digits', 'ตัวเลขใต้บาร์โค้ด'), chk('show_code', 'รหัสสินค้า'), chk('show_store', 'ชื่อร้าน'), chk('border', 'เส้นกรอบ')),
    h('div', { class: 'form-grid' }, txt('custom_text', 'ข้อความเพิ่มเติม (เช่น วันผลิต/หมดอายุ)', 'เว้นว่างได้'), txt('price_prefix', 'ข้อความหน้าราคา', 'เช่น ราคา '), txt('price_suffix', 'ข้อความหลังราคา', ' ฿'),
      sel('name_lines', 'ชื่อสินค้าไม่เกิน', [[1, '1 บรรทัด'], [2, '2 บรรทัด'], [3, '3 บรรทัด']]), sel('align', 'จัดตำแหน่งข้อความ', [['center', 'กลาง'], ['left', 'ซ้าย'], ['right', 'ขวา']])),
    h('h4', {}, '🔤 ฟอนต์และขนาดตัวอักษร'),
    h('div', { class: 'form-grid' }, sel('font', 'ฟอนต์', families.map((f) => [f, f])), sel('name_weight', 'ความหนาชื่อสินค้า', [[400, 'ปกติ'], [600, 'กึ่งหนา'], [700, 'หนา'], [800, 'หนามาก']]),
      num('name_size', 'ขนาดชื่อสินค้า (จุด)'), num('price_size', 'ขนาดราคา (จุด)'), num('digits_size', 'ขนาดตัวเลขบาร์โค้ด (จุด)'), num('text_size', 'ขนาดรหัส/ข้อความเพิ่ม (จุด)'), num('store_size', 'ขนาดชื่อร้าน (จุด)')),
    h('h4', {}, '▮▯ บาร์โค้ด'),
    h('div', { class: 'form-grid' }, sel('type', 'ชนิด', [['auto', 'อัตโนมัติ (EAN-13 ถ้าเป็นเลข 13 หลักที่ถูกต้อง ไม่งั้น Code128)'], ['code128', 'Code128 (ตัวอักษร+ตัวเลข)'], ['ean13', 'EAN-13 (ตัวเลข 13 หลัก)']]),
      num('barcode_height_mm', 'ความสูงแท่ง (มม.)', 1, 4), sel('bar_width', 'ความหนาแท่ง', [[1, 'บาง'], [2, 'ปกติ'], [3, 'หนา'], [4, 'หนามาก']])),
    h('h4', {}, '🏷 ชนิดเครื่องพิมพ์'),
    h('div', { class: 'form-grid' }, sel('lang', 'เครื่องที่ใช้พิมพ์ฉลาก', [['tspl', 'เครื่องพิมพ์สติกเกอร์/ฉลาก (TSPL) — กระดาษออกพอดีทีละดวง ✅ แนะนำ'], ['escpos', 'เครื่องพิมพ์ใบเสร็จ (ESC/POS)']]),
      chk('flip', 'ฉลากออกมากลับหัว (เฉพาะเครื่องพิมพ์สติกเกอร์)')),
    h('p', { class: 'small muted' }, 'เครื่องพิมพ์สติกเกอร์ (เช่น Xprinter XP-365B / XP-420B / XP-470B, Gprinter, TSC) ให้เลือก "เครื่องพิมพ์สติกเกอร์ (TSPL)" — เครื่องจะใช้เซนเซอร์จับช่องว่างระหว่างดวง พิมพ์พอดีทีละดวงและหยุดตรงรอยฉีก ไม่เสียกระดาษเปล่า · ใช้ "ระยะห่างระหว่างแถว" ด้านล่างเป็นช่องว่างระหว่างดวงบนม้วน (ปกติ 2 มม.) · ถ้าเครื่องยังป้อนไม่ตรง ให้ปิดเครื่อง กดปุ่ม FEED ค้างแล้วเปิดเครื่อง (คาลิเบรตเซนเซอร์) 1 ครั้ง · ถ้าเครื่องเป็นโหมดใบเสร็จ (ESC/POS) ข้อความจะออกมาเป็นตัวอักษรแปลกๆ ให้เปลี่ยนกลับ'),
    h('h4', {}, '🖨 การพิมพ์ด้วยเครื่องพิมพ์ใบเสร็จ (ESC/POS)'),
    h('div', { class: 'form-grid' }, chk('cut_each', 'ตัดกระดาษทุกแถว'), num('feed_mm', 'ระยะห่างระหว่างแถว (มม.) — 0 = ติดกันพอดี', 0.5),
      sel('end', 'จบงานพิมพ์', [['cut', 'ป้อนถึงมีดแล้วตัด (เครื่องที่มีมีดตัด)'], ['gap', 'ป้อนถึงต้นดวงถัดไป (เครื่องที่มีเซนเซอร์ช่องว่าง)'], ['feed', 'ป้อนกระดาษเพื่อฉีก ตามระยะด้านขวา'], ['none', 'ไม่ป้อนเพิ่ม (พอดีฉลากตัวสุดท้าย)']]),
      num('end_feed_mm', 'ระยะป้อนตอนจบ (มม.) ถ้าเลือก "ป้อนเพื่อฉีก"', 1),
      num('back_mm', 'ถอยกระดาษก่อนพิมพ์ (มม.) — มีกระดาษเปล่าด้านบนเยอะ ให้ใส่ประมาณระยะที่เกิน', 1)),
    h('p', { class: 'small muted' }, 'กระดาษที่ออกมาเท่ากับขนาดฉลากที่ตั้งพอดี ไม่ป้อนกระดาษเปล่าก่อน/หลังแต่ละแถว (มีแค่ระยะห่างระหว่างแถวที่ตั้ง) · กระดาษเปล่าด้านบนที่เหลือมักมาจากระยะระหว่างหัวพิมพ์กับมีดตัดหลังการตัดครั้งก่อน — เลือกจบงานแบบ "ไม่ป้อนเพิ่ม" หรือใส่ "ถอยกระดาษก่อนพิมพ์" (เครื่องที่ถอยกระดาษได้) แล้วกด "🧪 พิมพ์ทดสอบ 1 ดวง" เพื่อปรับ'));

  // ---- preview ----
  const canvasBox = h('div', { class: 'lbl-canvas' });
  const warnBox = h('div');
  const sizeNote = h('div', { class: 'small muted', style: { textAlign: 'center' } });
  const sample = { name: 'มาม่าเกาหลีต้นตำรับ', price: 7900, code: 'R001', barcode: '8850001000035', store };
  const firstItems = () => {
    const out = [];
    for (const [id, n] of qty) { const p = catalog.products.find((x) => x.id === id); for (let i = 0; i < n && out.length < 4; i++) out.push(itemOf(p)); }
    return out.length ? out : [sample];
  };
  const preview = debounce(async () => {
    await loadFont(cfg.font).catch(() => {});
    const { cols } = labelRowDots(cfg);
    const items = firstItems();
    const row = Array.from({ length: cols }, (_, i) => items[i] || null);
    const { canvas, warnings } = renderLabelRow(cfg, row, 12);
    canvas.style.width = `${(cols * cfg.width_mm + (cols - 1) * cfg.gap_mm) * 7}px`; // 7 px per mm on screen
    canvasBox.replaceChildren(canvas);
    sizeNote.textContent = `ตัวอย่าง ${cfg.width_mm} × ${cfg.height_mm} มม. · ${cols} ดวงต่อแถว${qty.size ? '' : ' · (ตัวอย่างสินค้า — เลือกสินค้าทางซ้าย)'}`;
    warnBox.replaceChildren(...warnings.map((w) => h('div', { class: 'badge warn', style: { whiteSpace: 'normal', display: 'block', marginTop: '.3em' } }, '⚠️ ', w)));
  }, 120);

  // ---- output ----
  const allItems = () => { const out = []; for (const [id, n] of qty) { const p = catalog.products.find((x) => x.id === id); for (let i = 0; i < n; i++) out.push(itemOf(p)); } return out; };
  const active = printers.filter((p) => p.active);
  const printerSel = h('select', { class: 'input' }, active.map((p) => h('option', { value: p.id, selected: p.id === cfg.printer_id }, `${p.name} (${p.paper} มม.)`)));
  const printableMm = () => { const p = active.find((x) => x.id === printerSel.value); return p ? (Number(p.paper) === 58 ? 48 : 72) : 0; };
  const fitNote = h('div', { class: 'small' });
  const checkFit = () => {
    const mm = printableMm(); if (!mm) return fitNote.replaceChildren();
    const { cols } = labelRowDots(cfg); const need = cols * cfg.width_mm + (cols - 1) * cfg.gap_mm;
    fitNote.replaceChildren(need > mm ? h('span', { class: 'badge warn', style: { whiteSpace: 'normal' } }, `⚠️ ฉลากกว้าง ${need} มม. เกินพื้นที่พิมพ์ ${mm} มม. ของเครื่องนี้ — กด "พอดีกระดาษ"`)
      : h('span', { class: 'muted' }, `✓ พอดีกระดาษ (ใช้ ${need} จาก ${mm} มม.)`));
  };
  // connect the printer to this computer → print right here (no POS needed)
  const linkBox = h('div', { class: 'lbl-link' });
  const drawLink = () => {
    const p = active.find((x) => x.id === printerSel.value);
    if (!p) return linkBox.replaceChildren();
    if (isLinkedHere(p.id)) return linkBox.replaceChildren(h('span', { class: 'badge ok' }, '🔌 เชื่อมกับเครื่องนี้แล้ว — กดพิมพ์แล้วออกที่เครื่องพิมพ์ทันที'));
    const sp = support();
    const can = { usb: sp.usb, serial: sp.serial, bluetooth: sp.bluetooth || sp.bridge, lan: true, agent_usb: true, browser: true }[p.conn] !== false;
    linkBox.replaceChildren(h('button', { class: 'btn', type: 'button', disabled: !can, onclick: async () => {
      try { const r = await pairPrinter(p); toast('เชื่อมต่อแล้ว: ' + r.name, 'ok'); drawLink(); } catch (e) { errToast(e); }
    } }, '🔌 เชื่อมเครื่องพิมพ์กับเครื่องนี้'), h('small', { class: 'muted' }, can ? ' เชื่อมครั้งเดียว ครั้งต่อไปพิมพ์ได้เลย (ถ้าไม่เชื่อม งานจะไปพิมพ์ที่อุปกรณ์ที่เชื่อมเครื่องพิมพ์ไว้ เช่น POS)'
      : ' เบราว์เซอร์นี้เชื่อมแบบ ' + p.conn + ' ไม่ได้ — ใช้ Chrome/Edge บนคอมพิวเตอร์ หรือส่งไปพิมพ์ที่ POS'));
  };
  printerSel.addEventListener('change', () => { cfg.printer_id = printerSel.value; checkFit(); drawLink(); });
  drawLink();
  const fitPaper = () => {
    const mm = printableMm(); if (!mm) return;
    const { cols } = labelRowDots(cfg);
    cfg.width_mm = Math.floor((mm - (cols - 1) * cfg.gap_mm) / cols);
    inputs.width_mm.value = cfg.width_mm; preview(); checkFit();
    toast(`ตั้งความกว้างฉลากเป็น ${cfg.width_mm} มม. ให้พอดีกระดาษ`, 'ok');
  };
  const printShop = async (e, test = false) => {
    if (!test && !total()) return toast('เลือกสินค้าและจำนวนก่อน', 'warn');
    e.target.disabled = true;
    try {
      // test: one label of the first chosen product (or the first product) to check where the paper starts and ends
      const items = test ? [{ product_id: [...qty.keys()][0] || catalog.products[0].id, qty: 1 }] : [...qty].map(([product_id, n]) => ({ product_id, qty: n }));
      if (isLinkedHere(printerSel.value)) { // connected to this computer: print right now
        const r = await api.post('/print/labels', { printer_id: printerSel.value, items, cfg, local: true });
        toast(`กำลังพิมพ์ ${r.count} ดวง…`, 'info', 2000);
        const res = await printDocument(r.printer, r.template, r.data, 'label');
        toast(`🖨 พิมพ์ ${r.count} ดวงแล้ว` + (res.note ? ' · ' + res.note : ''), 'ok', 5000);
      } else {
        const r = await api.post('/print/labels', { printer_id: printerSel.value, items, cfg });
        // jobs print on the device the printer is linked to (POS / Print Agent / Android app), like receipts
        toast(`ส่งพิมพ์ ${r.count} ดวงแล้ว — จะออกเมื่ออุปกรณ์ที่เชื่อมเครื่องพิมพ์ (เช่น POS) เปิดอยู่ · กด "🔌 เชื่อมเครื่องพิมพ์กับเครื่องนี้" เพื่อพิมพ์จากหน้านี้ได้เลย`, 'ok', 7000);
      }
      if (!cfg.printer_id || cfg.printer_id !== printerSel.value) { cfg.printer_id = printerSel.value; api.put('/labels/config', { value: { printer_id: cfg.printer_id } }).catch(() => {}); }
    }
    catch (er) { errToast(er); } finally { e.target.disabled = false; }
  };
  const printBrowser = async () => {
    const items = allItems();
    if (!items.length) return toast('เลือกสินค้าและจำนวนก่อน', 'warn');
    if (items.length > 500) return toast('พิมพ์ได้ครั้งละไม่เกิน 500 ดวง', 'warn');
    await loadFont(cfg.font).catch(() => {});
    const { cols } = labelRowDots(cfg);
    const pageW = cols * cfg.width_mm + (cols - 1) * cfg.gap_mm;
    const imgs = [];
    for (let i = 0; i < items.length; i += cols) imgs.push(renderLabelRow(cfg, Array.from({ length: cols }, (_, j) => items[i + j] || null), 12).canvas.toDataURL('image/png'));
    const w = window.open('', '_blank');
    if (!w) return toast('เบราว์เซอร์บล็อกหน้าต่าง — อนุญาต Pop-up', 'error');
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>ฉลากบาร์โค้ด ${items.length} ดวง</title><style>@page{size:${pageW}mm ${cfg.height_mm}mm;margin:0}html,body{margin:0;padding:0}
      img{display:block;width:${pageW}mm;height:${cfg.height_mm}mm;page-break-after:always;break-after:page}img:last-child{page-break-after:auto;break-after:auto}
      @media screen{body{background:#eee;padding:12px}img{background:#fff;margin:0 auto 8px;box-shadow:0 1px 4px rgba(0,0,0,.2)}}</style></head><body>${imgs.map((s) => `<img src="${s}">`).join('')}
      <script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body></html>`);
    w.document.close();
  };
  const saveCfg = async (e) => { e.target.disabled = true; try { Object.assign(cfg, await api.put('/labels/config', { value: cfg })); toast('บันทึกการตั้งค่าฉลากแล้ว', 'ok'); } catch (er) { errToast(er); } finally { e.target.disabled = false; } };

  drawList(); drawSummary(); preview(); checkFit();
  for (const k of ['width_mm', 'cols', 'gap_mm']) inputs[k].addEventListener('change', checkFit);
  return page('🏷️ พิมพ์บาร์โค้ดสินค้า',
    h('div', { class: 'lbl-layout' },
      h('div', {}, card(h('h3', {}, '1. เลือกสินค้าและจำนวนดวง'), h('div', { class: 'row' }, search, catSel), listBox, summary, h('div', { style: { marginTop: '.6em' } }, genBtn),
        h('p', { class: 'small muted' }, 'สินค้าที่ไม่มีบาร์โค้ดจะใช้รหัสสินค้าเป็นบาร์โค้ด Code128 (สแกนเข้าขายได้เช่นกัน) หรือกดสร้าง EAN-13 ภายในร้านให้')),
        card(h('h3', {}, '2. ตั้งค่าฉลาก'), settings, h('div', { class: 'row', style: { marginTop: '.8em' } }, h('button', { class: 'btn', onclick: saveCfg }, '💾 บันทึกเป็นค่าเริ่มต้น')))),
      h('div', { class: 'lbl-side' }, card(h('h3', {}, '3. ตัวอย่างและพิมพ์'), canvasBox, sizeNote, warnBox,
        h('div', { class: 'lbl-out' },
          h('h4', {}, '🖨 เครื่องพิมพ์ใบเสร็จในระบบ (58/80 มม.)'),
          active.length ? [printerSel, linkBox, h('div', { class: 'row', style: { marginTop: '.5em' } }, h('button', { class: 'btn', style: { flex: 1 }, onclick: fitPaper, title: 'ปรับความกว้างฉลากให้เต็มกระดาษของเครื่องที่เลือก' }, '↔ พอดีกระดาษ'), h('button', { class: 'btn primary', style: { flex: 1 }, onclick: printShop }, '🖨 พิมพ์ด้วยเครื่องนี้')),
            h('button', { class: 'btn block', style: { marginTop: '.4em' }, onclick: (e) => printShop(e, true) }, '🧪 พิมพ์ทดสอบ 1 ดวง (ปรับระยะกระดาษ)'), fitNote,
            h('p', { class: 'small muted' }, 'ใช้เครื่องพิมพ์ใบเสร็จเครื่องเดียวกับที่พิมพ์ใบเสร็จได้เลย ฉลากพิมพ์ต่อกันเป็นแถว (ตั้ง "ตัดกระดาษทุกแถว" ได้ในส่วนตั้งค่า) · ระบบจำเครื่องพิมพ์ที่เลือกไว้ใช้ครั้งหน้า')]
            : h('div', {}, h('p', { class: 'small muted' }, 'ยังไม่มีเครื่องพิมพ์ใบเสร็จในระบบ — เพิ่มเครื่องพิมพ์ก่อน แล้วกลับมาที่หน้านี้'), h('a', { class: 'btn', href: '#/printers' }, '➕ เพิ่มเครื่องพิมพ์')),
          h('h4', {}, '🏷️ เครื่องพิมพ์สติกเกอร์ / PDF'), h('button', { class: 'btn primary block', onclick: printBrowser }, 'พิมพ์ผ่านเบราว์เซอร์ / บันทึกเป็น PDF'),
          h('p', { class: 'small muted' }, 'ใช้กับเครื่องพิมพ์สติกเกอร์ทุกยี่ห้อที่ติดตั้งไดรเวอร์ในคอมพิวเตอร์ (เช่น Xprinter, Gprinter, TSC, Godex, Zebra) — ในหน้าต่างพิมพ์ ให้ตั้งขนาดกระดาษตรงกับฉลาก ระยะขอบ "ไม่มี" และสเกล 100%'))))));
}
