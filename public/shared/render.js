// Document renderer: template JSON + data → canvas (1 px = 1 printer dot, 203 dpi ≈ 8 dots/mm).
// The same output is used for the on-screen preview and for raster printing, so what you see is what prints.
import { baht, dineLabel, fillVars, code128, isAddon } from './core.js';
import { loadFont, familyCss } from './fonts.js';
import { drawLabel, labelCfg, labelRowDots } from './labels.js';

export const DOTS_PER_MM = 8;
export const paperDots = (paper) => (Number(paper) === 58 ? 384 : 576);
export const FIELD_LABELS = {
  store_name: 'ชื่อร้าน', branch: 'สาขา', address: 'ที่อยู่', phone: 'เบอร์โทร', tax_id: 'เลขผู้เสียภาษี', bill_no: 'เลขบิล', queue_no: 'เลขคิว', table: 'โต๊ะ',
  customer: 'ชื่อลูกค้า', member: 'สมาชิก', staff: 'พนักงาน', datetime: 'วันเวลา', dine_type: 'ทานที่ร้าน/กลับบ้าน', order_note: 'หมายเหตุออเดอร์', bowls: 'จำนวนชาม',
  ticket_kind: 'ประเภทใบ (ใหม่/เพิ่ม/ยกเลิก)', received_time: 'เวลารับออเดอร์', print_time: 'เวลาพิมพ์', table_or_type: 'โต๊ะ หรือ ทานที่ร้าน/กลับบ้าน (ตัวใหญ่)',
  pay_methods: 'ช่องทางชำระ', ticket_part: 'ใบที่/ชามที่', bowl_part: 'ชามที่ x/y', cooker: 'ต้มโดยเครื่องต้ม…', cooker_ready: 'คาดว่าจะเสร็จตอน…', station: 'จุดครัว', reason: 'เหตุผล', refund_amount: 'ยอดคืน', mobile_target: 'โต๊ะ/Pick Up',
  mobile_ref: 'เลขอ้างอิง QR', mobile_expires: 'วันหมดอายุ QR', reward_name: 'ชื่อรางวัล', coupon_code: 'โค้ดคูปอง', points_used: 'แต้มที่ใช้',
  pay_amount: 'ยอดชำระ (QR)', promptpay_name: 'ชื่อบัญชีพร้อมเพย์', promptpay_masked: 'เลขพร้อมเพย์ (ปิดบางส่วน)',
};
export const ELEMENT_TYPES = { logo: 'โลโก้', field: 'ข้อมูลจากระบบ', text: 'ข้อความอิสระ', items: 'รายการสินค้า', totals: 'ยอดรวม', payments: 'การชำระเงิน', divider: 'เส้นคั่น',
  space: 'ช่องว่าง', image: 'รูปภาพ', barcode: 'บาร์โค้ด', qr: 'QR Code', cut: 'จุดตัดกระดาษ', shift_summary: 'สรุปรอบการขาย', points: 'กรอบสะสมแต้ม (QR รับแต้ม / แต้มสมาชิก)' };
export const VARS = ['detail_url', 'queue_number', 'bill_no', 'table_name', 'customer_name', 'member_name', 'total', 'store_name', 'datetime', 'staff', 'claim_url', 'mobile_url', 'footer', 'phone', 'pay_qr'];

const imgCache = new Map();
function loadImage(src) {
  if (!src) return Promise.resolve(null);
  if (!imgCache.has(src)) imgCache.set(src, new Promise((res) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; }));
  return imgCache.get(src);
}
const qrCache = new Map();
async function qrMatrix(text) {
  if (!qrCache.has(text)) qrCache.set(text, fetch('/api/qr-matrix?d=' + encodeURIComponent(text)).then((r) => r.json()).catch(() => null));
  return qrCache.get(text);
}

// Thai has no spaces between words: break on word segments, then on graphemes (never inside a cluster with its vowels/tone marks)
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'word' }) : null;
const gseg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('th', { granularity: 'grapheme' }) : null;
export function wrap(ctx, text, maxW) {
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = seg ? [...seg.segment(para)].map((s) => s.segment) : para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      if (ctx.measureText(line + w).width <= maxW) { line += w; continue; }
      if (line) { out.push(line.trimEnd()); line = ''; }
      if (ctx.measureText(w).width <= maxW) { line = w.trimStart(); continue; }
      for (const g of gseg ? [...gseg.segment(w)].map((x) => x.segment) : [...w]) {
        if (ctx.measureText(line + g).width > maxW && line) { out.push(line); line = ''; }
        line += g;
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

function valueOf(field, d) {
  switch (field) {
    case 'dine_type': return d.dine_label || dineLabel(d.dine_type);
    case 'bowls': return d.bowls ? `${d.bowls} ${d.count_unit || 'ชาม'}` : '';
    case 'print_time': return d.print_time_now || d.print_time || '';
    case 'refund_amount': return d.refund_amount ? `${d.refund_amount} บาท` : '';
    default: return d[field] ?? '';
  }
}

export async function renderDoc(tpl, data, opts = {}) {
  const width = opts.width || tpl.width_dots || paperDots(tpl.paper);
  let margin = Number(tpl.margin ?? 8);
  let inner = width - margin * 2; // narrowed while drawing inside a framed element (e.box)
  const baseFamily = tpl.font || 'Sarabun';
  const families = new Set([baseFamily, ...tpl.elements.map((e) => e.font).filter(Boolean)]);
  await Promise.all([...families].map((f) => loadFont(f)));
  const vars = { ...data, queue_number: data.queue_no, table_name: data.table_name ?? data.table, customer_name: data.customer_name ?? data.customer, member_name: data.member_name ?? data.member,
    total: data.total ?? (data.totals ? baht(data.totals.total) : '') };
  data = { ...data, print_time_now: data.print_time_now || new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }) };
  const warnings = [];
  const images = new Map();
  for (const e of tpl.elements) {
    // logo element: the shop logo, or any picture uploaded for this template (e.src)
    if (e.type === 'logo' && !opts.noLogo) images.set(e, await loadImage(e.src || data.logo));
    if (e.type === 'image') images.set(e, await loadImage(e.src));
    if (e.type === 'qr') { const v = fillVars(e.value, vars); if (v) images.set(e, await qrMatrix(v)); }
    if (e.type === 'points' && data.points_mode === 'claim' && data.claim_url) images.set(e, await qrMatrix(data.claim_url));
  }
  const run = (ctx, draw) => {
    let y = margin;
    const SC = Number(opts.scale) || 1; // per-printer enlarge/reduce
    const font = (e, size, weight) => { ctx.font = `${e.italic ? 'italic ' : ''}${weight || e.weight || 400} ${Math.round(size * SC)}px ${familyCss(e.font || baseFamily)}`; };
    const lh = (size) => Math.round(size * SC * (tpl.line_height || 1.3));
    const text = (str, e, { size = e.size || tpl.size || 24, weight, align = e.align || 'left', x0 = margin, w = inner, invert = false } = {}) => {
      font(e, size, weight);
      const lines = wrap(ctx, str, w - (invert ? 12 : 0));
      const h = lines.length * lh(size);
      // white-on-black: pad the band so Thai marks above/below the line (่ ้ ุ ู) stay on black and remain visible
      const pad = invert ? Math.round(size * 0.22) : 0;
      if (draw && invert) { ctx.fillStyle = '#000'; ctx.fillRect(x0, y, w, h + pad * 2); }
      y += pad;
      for (const ln of lines) {
        const tw = ctx.measureText(ln).width;
        const x = align === 'center' ? x0 + (w - tw) / 2 : align === 'right' ? x0 + w - tw : x0 + (invert ? 6 : 0);
        if (draw) { ctx.fillStyle = invert ? '#fff' : '#000'; ctx.textBaseline = 'top'; ctx.fillText(ln, x, y + (lh(size) - size) / 2); if (e.underline) ctx.fillRect(x, y + lh(size) - 3, tw, 2); }
        y += lh(size);
      }
      y += pad;
      return h;
    };
    const twoCol = (left, right, e, { size = e.size || tpl.size || 24, weight, invert = false } = {}) => {
      font(e, size, weight);
      const rw = ctx.measureText(right).width;
      const ins = invert ? 10 : 0, pad = invert ? Math.round(size * 0.25) : 0;
      const lines = wrap(ctx, left, inner - rw - 12 - ins * 2);
      if (draw && invert) { ctx.fillStyle = '#000'; ctx.fillRect(margin, y, inner, lines.length * lh(size) + pad * 2); }
      y += pad;
      lines.forEach((ln, i) => {
        if (draw) { ctx.fillStyle = invert ? '#fff' : '#000'; ctx.textBaseline = 'top'; ctx.fillText(ln, margin + ins, y + (lh(size) - size) / 2); if (i === 0 && right) ctx.fillText(right, margin + inner - rw - ins, y + (lh(size) - size) / 2); }
        y += lh(size);
      });
      y += pad;
    };
    // QR matrix drawn as square modules inside the column [x0, x0 + w]
    const qrAt = (m, sizeMm, align, x0 = margin, w = inner) => {
      const target = Math.round((sizeMm || 30) * DOTS_PER_MM);
      const mod = Math.floor(Math.min(target, w) / (m.size + 2));
      if (mod < 3) warnings.push(`QR Code เล็กเกินไป (โมดูล ${mod} จุด) อาจสแกนไม่ได้ — เพิ่มขนาด`);
      const ms = Math.max(3, mod), size = ms * (m.size + 2);
      if (size > w) warnings.push('QR Code กว้างเกินพื้นที่พิมพ์');
      const qx = align === 'left' ? x0 : align === 'right' ? x0 + w - size : x0 + Math.round((w - size) / 2);
      if (draw) { ctx.fillStyle = '#000'; for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.data[r * m.size + c]) ctx.fillRect(qx + (c + 1) * ms, y + (r + 1) * ms, ms, ms); }
      y += size + 4;
    };
    const pair = (left, right, e, { size, weight, x0, w }) => {
      font(e, size, weight);
      const rw = ctx.measureText(right).width;
      if (draw) { ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.fillText(left, x0, y + (lh(size) - size) / 2); ctx.fillText(right, x0 + w - rw, y + (lh(size) - size) / 2); }
      y += lh(size);
    };
    if (data.reprint && opts.reprintMark !== false) text('** สำเนา / พิมพ์ซ้ำ **', { align: 'center' }, { size: 24, weight: 700 });
    for (const e of tpl.elements) {
      if (e.hidden) continue;
      if (e.when && !data[e.when]) continue;
      const startY = y;
      // framed element: draw it narrower, then put a border around whatever it printed
      const boxed = e.box && e.box !== 'none' ? { m: margin, i: inner, pad: 12 } : null;
      if (boxed) { margin += 16; inner -= 32; y += boxed.pad; }
      switch (e.type) {
        case 'logo': case 'image': {
          const img = images.get(e);
          if (!img) break;
          const w = Math.min(inner, Math.round(inner * (e.width_pct || 50) / 100));
          const hgt = Math.round(img.height * (w / img.width)); // keep aspect ratio
          const x = e.align === 'left' ? margin : e.align === 'right' ? margin + inner - w : margin + (inner - w) / 2;
          if (draw) ctx.drawImage(img, x, y, w, hgt);
          y += hgt + 4;
          break;
        }
        case 'field': {
          const v = valueOf(e.field, data);
          if (v === '' || v === null || v === undefined) break;
          const inv = e.invert || (e.invert_if && data.dine_type === e.invert_if);
          text((e.label || '') + v, e, { invert: inv });
          break;
        }
        case 'text': { const v = fillVars(e.text, vars); if (v.trim()) text(v, e, { invert: !!e.invert }); break; }
        case 'divider': {
          const st = e.style || 'dash';
          if (draw) {
            ctx.fillStyle = '#000';
            if (st === 'solid') ctx.fillRect(margin, y + 6, inner, 3);
            else if (st === 'thick') ctx.fillRect(margin, y + 3, inner, 8);
            else if (st === 'double') { ctx.fillRect(margin, y + 3, inner, 2); ctx.fillRect(margin, y + 9, inner, 2); }
            else if (st === 'dots') for (let x = margin + 4; x < margin + inner; x += 16) { ctx.beginPath(); ctx.arc(x, y + 7, 2.6, 0, Math.PI * 2); ctx.fill(); }
            else if (st === 'zigzag') { ctx.strokeStyle = '#000'; ctx.lineWidth = 2.5; ctx.beginPath(); for (let x = margin, i = 0; x <= margin + inner; x += 10, i++) ctx[i ? 'lineTo' : 'moveTo'](x, y + (i % 2 ? 2 : 12)); ctx.stroke(); }
            else if (st === 'stars') { const n = Math.floor(inner / 34); for (let i = 0; i < n; i++) { const cx = margin + 17 + i * (inner / n), cy = y + 7, r = i % 2 ? 4 : 7; ctx.beginPath(); ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r * 0.35, cy - r * 0.35); ctx.lineTo(cx + r, cy); ctx.lineTo(cx + r * 0.35, cy + r * 0.35); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r * 0.35, cy + r * 0.35); ctx.lineTo(cx - r, cy); ctx.lineTo(cx - r * 0.35, cy - r * 0.35); ctx.closePath(); ctx.fill(); } }
            else for (let x = margin; x < margin + inner; x += 14) ctx.fillRect(x, y + 6, 8, 2);
          }
          y += 14;
          break;
        }
        case 'space': y += Number(e.height) || 16; break;
        case 'items': {
          const size = e.size || tpl.size || 24;
          const items = data.items || [];
          const mixed = new Set(items.map((i) => i.dine_type)).size > 1;
          let lastGroup;
          if (e.style === 'kitchen') {
            // big "qty   item" rows like a kitchen printer: qty column on the left, options/notes indented under the name
            const qtyW = Math.round(size * SC * 1.6);
            items.forEach((it, idx) => {
              if (e.group_by_bowl && it.bowl_label && it.bowl_label !== lastGroup) { text(`[ ${it.bowl_label} ]`, e, { size: Math.round(size * 0.6), weight: 800 }); lastGroup = it.bowl_label; }
              const y0 = y;
              font(e, size, e.weight || 700);
              if (draw) { ctx.fillStyle = '#000'; ctx.textBaseline = 'top'; ctx.fillText(String(it.qty), margin, y + (lh(size) - size * SC) / 2); }
              const take = e.show_dine && it.dine_type === 'takeaway' && data.dine_type !== 'takeaway' ? ' (กลับบ้าน)' : '';
              text(it.name + take, e, { size, weight: e.weight || 700, x0: margin + qtyW, w: inner - qtyW });
              if (e.show_options !== false) {
                // choices (noodle, spice...) readable; add-ons printed as black bands so the kitchen can't miss them
                for (const o of (it.options || []).filter((x) => !isAddon(x))) text(`• ${o.group ? o.group + ': ' : ''}${o.name}`, e, { size: Math.round(size * (e.option_ratio || 0.68)), weight: 700, x0: margin + qtyW, w: inner - qtyW });
                // add-ons get a mark: a black box with a white "+" in front (not just heavier text)
                const asz = Math.round(size * (e.addon_ratio || 0.68));
                for (const o of (it.options || []).filter(isAddon)) {
                  const box = Math.round(asz * SC * 1.05), bx = margin + qtyW, by = y + Math.round((lh(asz) - box) / 2);
                  if (draw) {
                    ctx.fillStyle = '#000'; ctx.fillRect(bx, by, box, box);
                    ctx.fillStyle = '#fff'; const bar = Math.max(2, Math.round(box * 0.16)), arm = Math.round(box * 0.62);
                    ctx.fillRect(bx + (box - arm) / 2, by + (box - bar) / 2, arm, bar); ctx.fillRect(bx + (box - bar) / 2, by + (box - arm) / 2, bar, arm);
                  }
                  text(`เพิ่ม ${o.name}`, e, { size: asz, weight: 700, x0: bx + box + 8, w: inner - qtyW - box - 8 });
                }
              }
              if (e.show_note !== false && it.note) text(`⚠ ${it.note}`, e, { size: Math.round(size * 0.62), weight: 800, x0: margin + qtyW, w: inner - qtyW, invert: true });
              if (y === y0) y += lh(size);
              if (e.item_divider && idx < items.length - 1 && draw) { ctx.fillStyle = '#000'; for (let x = margin; x < margin + inner; x += 14) ctx.fillRect(x, y + 6, 8, 2); }
              if (e.item_divider && idx < items.length - 1) y += 14;
            });
            break;
          }
          if (e.style === 'modern') {
            // name (bold) ........ price  /  small "2 × 39.50" and choices underneath
            items.forEach((it, idx) => {
              const price = e.show_price !== false && it.line_total !== null && it.line_total !== undefined ? baht(it.line_total) : '';
              const dine = e.show_dine && (mixed || it.dine_type === 'takeaway') && it.dine_type === 'takeaway' ? '  · กลับบ้าน' : '';
              twoCol(it.name, price, e, { size, weight: 700 });
              const small = Math.round(size * 0.78);
              const unit = it.line_total && it.qty ? baht(Math.round(it.line_total / it.qty)) : '';
              text(`${it.qty} × ${unit}${dine}`, e, { size: small });
              if (e.show_options !== false && (it.options || []).length) text((it.options || []).map((o) => (isAddon(o) ? '+ ' : '') + o.name).join(' · '), e, { size: small, weight: 600 });
              if (e.show_note !== false && it.note) text(`* ${it.note}`, e, { size: small, weight: 700 });
              if (idx < items.length - 1) y += Math.round(size * 0.3);
            });
            break;
          }
          for (const it of items) {
            if (e.group_by_bowl && it.bowl_label && it.bowl_label !== lastGroup) { text(`[ ${it.bowl_label} ]`, e, { size: Math.round(size * 0.85), weight: 800 }); lastGroup = it.bowl_label; }
            const price = e.show_price !== false && it.line_total !== null && it.line_total !== undefined ? baht(it.line_total) : '';
            const dine = e.show_dine && (mixed || it.dine_type === 'takeaway') ? (it.dine_type === 'takeaway' ? ' [กลับบ้าน]' : mixed ? ' [ทานที่ร้าน]' : '') : '';
            twoCol(`${it.qty} x ${it.name}${dine}`, price, e, { size, weight: e.weight });
            if (e.show_options !== false) for (const o of it.options || []) {
              const extra = e.show_price !== false && o.price ? ` (+${baht(o.price)})` : '';
              if (isAddon(o)) text(`   + เพิ่ม ${o.name}${extra}`, e, { size: Math.round(size * 0.85), weight: 700 });
              else text(`   ${o.group ? o.group + ': ' : '- '}${o.name}${extra}`, e, { size: Math.round(size * 0.85), weight: e.weight });
            }
            if (e.show_note !== false && it.note) text(`   * ${it.note}`, e, { size: Math.round(size * 0.9), weight: 800, invert: data.ticket_kind !== undefined });
          }
          break;
        }
        case 'totals': {
          const t = data.totals || {};
          const L = { items_total: 'รวมสินค้า', discount: 'ส่วนลด', packaging: 'ค่าบรรจุภัณฑ์', tax: data.tax_inclusive ? `VAT ${data.tax_rate || 7}% (รวมในราคา)` : `VAT ${data.tax_rate || 7}%`, total: 'ยอดสุทธิ' };
          for (const k of e.show || ['items_total', 'discount', 'total']) {
            if (k !== 'total' && k !== 'items_total' && !t[k]) continue;
            twoCol(L[k], (k === 'discount' ? '-' : '') + baht(t[k] || 0), e, k === 'total' ? { size: e.total_size || 32, weight: 800, invert: !!e.total_invert } : {});
          }
          break;
        }
        case 'payments': {
          for (const p of data.payments || []) {
            twoCol(p.method, baht(p.amount + (p.change || 0)), e);
            if (p.change) twoCol('เงินทอน', baht(p.change), e);
          }
          break;
        }
        case 'qr': {
          const m = images.get(e);
          if (!m) break;
          qrAt(m, e.size_mm, e.align, margin, inner);
          if (e.caption) text(fillVars(e.caption, vars), { ...e, align: 'center' }, { size: e.caption_size || 22 });
          break;
        }
        case 'points': {
          // framed loyalty box: "scan to collect N points" with the claim QR, or the attached member's earned/total points
          const mode = data.points_mode;
          if (!mode) break;
          const size = e.size || 24, pad = 14, x0 = margin + pad, w = inner - pad * 2, y0 = y;
          const band = (t) => { y += 6; text(t, e, { size: Math.round(size * 1.15), weight: 800, align: 'center', x0: margin + 6, w: inner - 12, invert: true }); y += 4; };
          if (mode === 'claim') {
            band(e.title || '★ สแกนสะสมแต้ม ★');
            if (data.claim_points > 0) {
              text('บิลนี้รับได้', e, { size, weight: 600, align: 'center', x0, w });
              text(`${data.claim_points} แต้ม`, e, { size: Math.round(size * 2), weight: 800, align: 'center', x0, w });
            }
            const m = images.get(e);
            if (m) qrAt(m, e.size_mm || 30, 'center', x0, w);
            text(e.caption || 'สแกนด้วยกล้องมือถือ รับแต้มทันที ไม่ต้องกรอกรหัส', e, { size: Math.round(size * 0.85), weight: 700, align: 'center', x0, w });
            text('ยังไม่เป็นสมาชิก? สแกนแล้วสมัครได้เลย', e, { size: Math.round(size * 0.78), align: 'center', x0, w });
            if (data.claim_deadline) text(`รับแต้มได้ถึง ${data.claim_deadline}`, e, { size: Math.round(size * 0.75), align: 'center', x0, w });
          } else {
            band(e.member_title || '★ คะแนนสมาชิก ★');
            if (data.member_display) text(data.member_display, e, { size, weight: 700, align: 'center', x0, w });
            if (data.member_tier) text(`ระดับ ${data.member_tier}`, e, { size: Math.round(size * 0.8), align: 'center', x0, w });
            y += 4;
            pair('ได้รับจากบิลนี้', `+${data.points_earned || 0} แต้ม`, e, { size: Math.round(size * 1.1), weight: 800, x0, w });
            pair('แต้มสะสมทั้งหมด', `${data.member_points ?? 0} แต้ม`, e, { size: Math.round(size * 1.1), weight: 800, x0, w });
            if (data.points_earned === 0 && data.points_note) text(data.points_note, e, { size: Math.round(size * 0.75), align: 'center', x0, w });
          }
          y += 8;
          if (draw) {
            // double rounded frame
            ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
            const rr = (o, r) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(margin + o, y0 + o, inner - o * 2, y - y0 - o * 2, r); else ctx.rect(margin + o, y0 + o, inner - o * 2, y - y0 - o * 2); ctx.stroke(); };
            rr(1.5, 16); ctx.lineWidth = 1.5; rr(6, 12);
          }
          break;
        }
        case 'barcode': {
          const v = fillVars(e.value, vars);
          if (!v) break;
          let mods; try { mods = code128(v); } catch { warnings.push('บาร์โค้ดรองรับเฉพาะตัวอักษรภาษาอังกฤษ/ตัวเลข'); break; }
          const total = mods.reduce((a, b) => a + b, 0) + 20;
          const mw = Math.max(2, Math.min(e.module || 3, Math.floor(inner / total)));
          if (Math.floor(inner / total) < 2) warnings.push('บาร์โค้ดยาวเกินพื้นที่พิมพ์ — ลดความยาวข้อมูล');
          const bh = e.height || 80;
          let x = margin + Math.round((inner - total * mw) / 2) + 10 * mw;
          if (draw) { ctx.fillStyle = '#000'; mods.forEach((w, i) => { if (i % 2 === 0) ctx.fillRect(x, y, w * mw, bh); x += w * mw; }); }
          y += bh + 2;
          text(v, { ...e, align: 'center' }, { size: 20 });
          break;
        }
        case 'shift_summary': {
          const s = data.shift || {};
          const rows = [['เครื่องขาย', s.terminal_name || ''], ['พนักงาน', s.staff_name || ''], ['เปิดรอบ', s.opened_at ? new Date(s.opened_at).toLocaleString('th-TH') : ''],
            ['ปิดรอบ', s.closed_at ? new Date(s.closed_at).toLocaleString('th-TH') : '-'], ['เงินสดเริ่มต้น', baht(s.opening_cash)], ['จำนวนบิล', String(s.bills ?? '')],
            ['จำนวนชามสุทธิ', String(s.net_bowls ?? '')], ['ยอดขายสุทธิ', baht(s.net_sales)], ['ส่วนลด', baht(s.discount)],
            ['ยกเลิก', `${(s.voids || {}).count || 0} บิล ${baht((s.voids || {}).amount)}`], ['คืนเงิน', `${(s.refunds || {}).count || 0} ครั้ง ${baht((s.refunds || {}).amount)}`]];
          for (const [a, b] of rows) twoCol(a, b, e);
          text('— แยกช่องทางรับเงิน —', { ...e, align: 'center' });
          for (const p of s.payments || []) twoCol(`${p.name || p.method} (${p.count})`, baht(p.amount), e);
          twoCol('เงินเข้าลิ้นชัก', baht(s.cash_in), e); twoCol('เงินออกลิ้นชัก', baht(s.cash_out), e);
          twoCol('เงินสดที่ควรมี', baht(s.expected_cash), e, { weight: 800 });
          if (s.counted_cash !== null && s.counted_cash !== undefined) { twoCol('เงินสดที่นับได้', baht(s.counted_cash), e); twoCol('ขาด/เกิน', baht(s.diff), e, { weight: 800 }); }
          break;
        }
        case 'label': {
          // one row of product barcode labels (see labels.js), drawn at printer resolution
          const c = labelCfg(e.cfg);
          const { h: rowH } = labelRowDots(c, DOTS_PER_MM);
          if (draw) (e.items || []).forEach((it, i) => { if (it) warnings.push(...drawLabel(ctx, margin + Math.round(i * (c.width_mm + c.gap_mm) * DOTS_PER_MM), y, c, it, DOTS_PER_MM)); });
          y += rowH;
          break;
        }
        case 'cut': if (draw && opts.cutMarks) { ctx.strokeStyle = '#999'; ctx.setLineDash([6, 6]); ctx.beginPath(); ctx.moveTo(0, y + 6); ctx.lineTo(width, y + 6); ctx.stroke(); ctx.setLineDash([]); } (opts.cuts || []).push(y); y += 12; break;
        default: break;
      }
      if (boxed) {
        margin = boxed.m; inner = boxed.i;
        if (y > startY + boxed.pad) {
          y += boxed.pad;
          if (draw) {
            ctx.strokeStyle = '#000'; ctx.lineWidth = e.box === 'bold' ? 5 : 3;
            const x = margin + 2, w = inner - 4, hh = y - startY, r = e.box === 'round' || e.box === 'dashed' ? 18 : 0;
            ctx.setLineDash(e.box === 'dashed' ? [10, 7] : []);
            ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, startY + 1, w, hh - 2, r); else ctx.rect(x, startY + 1, w, hh - 2); ctx.stroke();
            if (e.box === 'double') { ctx.lineWidth = 2; ctx.strokeRect(x + 6, startY + 7, w - 12, hh - 14); }
            ctx.setLineDash([]);
          }
        } else y = startY;
      }
      if (e.gap ?? tpl.section_gap) y += (y > startY ? Number(e.gap ?? tpl.section_gap) : 0);
    }
    if (data.copies > 1) text(`สำเนา ${data.copy}/${data.copies}`, { align: 'center' }, { size: 18 });
    return y + margin;
  };
  const probe = (opts.canvas ? opts.canvas : document.createElement('canvas'));
  probe.width = width; probe.height = 10;
  const height = Math.ceil(run(probe.getContext('2d'), false));
  const canvas = opts.canvas || document.createElement('canvas');
  canvas.width = width; canvas.height = Math.max(40, height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, canvas.height);
  const cuts = []; opts.cuts = cuts;
  run(ctx, true);
  // overflow check: any ink beyond the printable width is impossible here, but text wider than the column is wrapped;
  // warn when a single grapheme cluster is wider than the column (font too large)
  for (const e of tpl.elements) if ((e.size || 0) > inner / 2) warnings.push(`ขนาดตัวอักษรขององค์ประกอบ "${ELEMENT_TYPES[e.type] || e.type}" ใหญ่เกินพื้นที่พิมพ์`);
  return { canvas, height: canvas.height, width, warnings: [...new Set(warnings)], cuts };
}

// Built-in test page (Thai text, numbers, logo, fonts, barcode, QR, cut)
export function testTemplate(paper, font) {
  return { paper, margin: 8, line_height: 1.3, font: font || 'Sarabun', size: 24, elements: [
    { type: 'logo', width_pct: 40, align: 'center' },
    { type: 'text', text: 'ทดสอบเครื่องพิมพ์ Oppa Ramyeon', align: 'center', size: 30, weight: 800 },
    { type: 'text', text: 'ภาษาไทย: กขฃคฅฆง จฉชซฌญ ฎฏฐฑฒณ ดตถทธน บปผฝพฟภม ยรลวศษสหฬอฮ\nสระ/วรรณยุกต์: กิ กี กึ กื กุ กู เก แก โก ใก ไก ก่ ก้ ก๊ ก๋ กำ', size: 24 },
    { type: 'text', text: 'ตัวเลข 0123456789 ฿1,234.50  한국어 라면', size: 24 },
    { type: 'divider', style: 'dash' },
    { type: 'text', text: 'ซ้าย', align: 'left' }, { type: 'text', text: 'กลาง', align: 'center' }, { type: 'text', text: 'ขวา', align: 'right' },
    { type: 'text', text: 'ตัวหนา 800', weight: 800 }, { type: 'field', field: 'dine_type', align: 'center', size: 34, weight: 800, invert: true },
    { type: 'barcode', value: 'OPPA12345', height: 70 },
    { type: 'qr', value: 'https://opparamyeon.onrender.com', size_mm: 30, align: 'center', caption: 'QR ขนาด 30 มม.' },
    { type: 'text', text: '{datetime}', align: 'center', size: 20 },
  ] };
}
