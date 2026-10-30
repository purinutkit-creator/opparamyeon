// Shift report as HTML: used by the POS shift dialog and the public page behind the QR on the shift slip.
import { h } from './ui.js';
import { baht } from './core.js';

const t = (iso) => (iso ? new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' }) : '-');
const d = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' }) : '-');
// first – last bill: times only on the same day, otherwise with the date
const day = (iso) => new Date(iso).toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', day: 'numeric', month: 'short' });
const span = (a, b) => (!a ? '-' : day(a) === day(b) ? `${t(a)} – ${t(b)}` : `${day(a)} ${t(a)} – ${day(b)} ${t(b)}`);
const DINE = { dine_in: '🍽️ ทานที่ร้าน', takeaway: '🥡 กลับบ้าน', mixed: '🍽️+🥡 ผสม' }, SRC = { pos: 'หน้าร้าน', mobile_table: 'สั่งที่โต๊ะ', mobile_pickup: 'Pick Up' };
const row = (a, b, cls = '') => h('div', { class: 'sv-r ' + cls }, h('span', {}, a), h('b', {}, b));
const sec = (title, ...kids) => h('section', { class: 'sv-sec' }, h('h4', {}, title), ...kids);
// bar = share of the biggest value, for a quick visual
const bars = (list, label, val, fmt) => { const max = Math.max(1, ...list.map(val)); return list.map((x) => h('div', { class: 'sv-bar' }, h('span', {}, label(x)), h('i', { style: `--w:${Math.round(val(x) / max * 100)}%` }), h('b', {}, fmt(x)))); };

export function shiftStats(s, unit = 'ชาม') {
  return h('div', { class: 'sv-kpis' },
    [['ยอดขายสุทธิ', baht(s.net_sales) + ' ฿', 'big'], ['บิล', String(s.bills)], ['เฉลี่ย/บิล', baht(s.avg_bill || 0)], [unit, String(s.net_bowls)], ['ชิ้น', String(s.items_count || 0)]]
      .map(([a, b, c]) => h('div', { class: 'sv-kpi ' + (c || '') }, h('small', {}, a), h('b', {}, b))));
}
export function shiftDetailsView(s, names = {}, unit = 'ชาม', { cash = true } = {}) {
  const pays = s.payments || [];
  return h('div', { class: 'sv' },
    sec('⏱ เวลา', row('เปิดรอบ', d(s.opened_at)), s.closed_at ? row('ปิดรอบ', d(s.closed_at)) : null, row('บิลแรก – บิลสุดท้าย', span(s.first_bill_at, s.last_bill_at)),
      row('เครื่องขาย / พนักงาน', `${s.terminal_name || '-'} · ${s.staff_name || '-'}`),
      (s.crew || []).length > 1 ? row(`พนักงานในรอบ (${s.crew.length} คน)`, s.crew.map((c) => (c.main ? '👑 ' : c.late ? '⏰ ' : '') + c.name).join(', ')) : null),
    sec('💳 ช่องทางรับเงิน', ...bars(pays, (p) => `${names[p.method] || p.method} (${p.count})`, (p) => p.amount, (p) => baht(p.amount))),
    cash ? sec('💵 เงินสดในลิ้นชัก', row('เงินสดเริ่มต้น', baht(s.opening_cash)), row('รับเงินสด', baht(s.cash_sales || 0)), row('เงินเข้าลิ้นชัก', baht(s.cash_in)), row('เงินออกลิ้นชัก', baht(s.cash_out)),
      s.cash_refunds ? row('คืนเงินสด', '-' + baht(s.cash_refunds)) : null, row('เงินสดที่ควรมี', baht(s.expected_cash), 'strong'),
      s.counted_cash !== null && s.counted_cash !== undefined ? [row('เงินสดที่นับได้', baht(s.counted_cash)), row('ขาด / เกิน', s.diff === 0 ? 'ตรงพอดี' : (s.diff > 0 ? '+' : '') + baht(s.diff), s.diff ? 'bad' : 'ok')] : null,
      (s.cash_moves || []).length ? h('div', { class: 'sv-moves' }, s.cash_moves.map((m) => h('div', {}, `${t(m.created_at)} ${m.type === 'in' ? '+' : '−'}${baht(m.amount)} · ${m.reason || ''}`))) : null) : null,
    sec('🧾 ยอดขาย', row('ยอดขายรวม', baht(s.gross_sales || 0)), row('ส่วนลด', `${baht(s.discount)}${s.discount_bills ? ` (${s.discount_bills} บิล)` : ''}`),
      s.packaging ? row('ค่าบรรจุภัณฑ์', baht(s.packaging)) : null, s.tax ? row('VAT', baht(s.tax)) : null,
      row('ยกเลิกบิล', `${s.voids.count} บิล · ${baht(s.voids.amount)}`), row('คืนเงิน', `${s.refunds.count} ครั้ง · ${baht(s.refunds.amount)}`), row('ยอดขายสุทธิ', baht(s.net_sales), 'strong')),
    s.by_dine && Object.keys(s.by_dine).length ? sec('🍜 ทานที่ร้าน / กลับบ้าน', ...bars(Object.entries(s.by_dine), ([k, v]) => `${DINE[k] || k} (${v.n})`, ([, v]) => v.amount, ([, v]) => baht(v.amount))) : null,
    s.by_source && Object.keys(s.by_source).length > 1 ? sec('📱 ช่องทางสั่ง', ...bars(Object.entries(s.by_source), ([k, v]) => `${SRC[k] || k} (${v.n})`, ([, v]) => v.amount, ([, v]) => baht(v.amount))) : null,
    s.member_bills ? sec('⭐ สมาชิก', row('บิลของสมาชิก', `${s.member_bills} บิล · ${baht(s.member_sales)}`), row('แต้มที่ให้', String(s.points_given || 0))) : null,
    (s.top_items || []).length ? sec('🏆 ขายดี', ...bars(s.top_items, (x) => x.name, (x) => x.qty, (x) => `×${x.qty} · ${baht(x.amount)}`)) : null,
    (s.categories || []).length ? sec('🗂 ตามหมวด', ...bars(s.categories, (x) => `${x.name} (${x.qty})`, (x) => x.amount, (x) => baht(x.amount))) : null,
    (s.hours || []).length ? sec('🕒 ตามช่วงเวลา', ...bars(s.hours, (x) => `${String(x.hour).padStart(2, '0')}:00`, (x) => x.amount, (x) => `${x.n} บิล · ${baht(x.amount)}`)) : null);
}
export const SHIFT_CSS = `
.sv-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: .5em; margin-bottom: .8em; }
.sv-kpi { background: var(--surface2, #f6f1ee); border-radius: 14px; padding: .55em .75em; } .sv-kpi small { display: block; color: var(--muted); font-weight: 700; font-size: .8em; }
.sv-kpi b { font-size: 1.25em; font-variant-numeric: tabular-nums; } .sv-kpi.big { background: var(--grad, #d4202f); color: #fff; grid-column: span 2; } .sv-kpi.big small { color: rgb(255 255 255 / .85); }
.sv-sec { margin: .2em 0 .9em; } .sv-sec h4 { margin: .2em 0 .4em; font-size: 1em; }
.sv-r { display: flex; justify-content: space-between; gap: 1em; padding: .22em 0; border-bottom: 1px dashed var(--line, #eee); } .sv-r b { font-variant-numeric: tabular-nums; text-align: right; }
.sv-r.strong b { font-size: 1.1em; } .sv-r.bad b { color: var(--bad, #c62828); } .sv-r.ok b { color: var(--ok, #16a34a); }
.sv-bar { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(40px, 1fr) auto; gap: .6em; align-items: center; padding: .2em 0; font-size: .95em; }
.sv-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; } .sv-bar i { height: 10px; border-radius: 99px; background: linear-gradient(90deg, var(--brand, #d4202f) var(--w), var(--surface2, #f1ebe7) var(--w)); }
.sv-bar b { font-variant-numeric: tabular-nums; white-space: nowrap; } .sv-moves { font-size: .85em; color: var(--muted); margin-top: .3em; }
`;
