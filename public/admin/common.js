import { makeApi, store } from '/shared/api.js';
import { h, $, toast, errToast } from '/shared/ui.js';
import { baht, toSatang } from '/shared/core.js';

export const api = makeApi({ tokenKey: 'admin_token', onUnauthorized: () => { store.del('admin_token'); location.reload(); } });
export const ctx = { staff: null, settings: null, perms: {} };
export const can = (p) => ctx.staff && ctx.staff.perms.includes(p);

// Form builder: fields [{ k, label, type: text|number|money|bool|select|textarea|date|time|color|file|multi, options, hint, step }]
export function form(fields, value = {}) {
  const inputs = {};
  const el = h('div', { class: 'form-grid' }, fields.map((f) => {
    let inp;
    const v = value[f.k];
    if (f.type === 'bool') { inp = h('input', { type: 'checkbox', checked: !!v }); return h('label', { class: 'switch field', style: { flexDirection: 'row' } }, (inputs[f.k] = inp), f.label); }
    if (f.type === 'select') inp = h('select', { class: 'input' }, f.options.map(([ov, ol]) => h('option', { value: ov, selected: String(v ?? '') === String(ov) }, ol)));
    else if (f.type === 'multi') {
      const set = new Set(v || []);
      inp = h('div', { class: 'row' }, f.options.map(([ov, ol]) => h('label', { class: 'switch' }, h('input', { type: 'checkbox', value: ov, checked: set.has(ov) }), ol)));
      inp.getValue = () => [...inp.querySelectorAll('input:checked')].map((x) => x.value);
    } else if (f.type === 'textarea') inp = h('textarea', { class: 'input', rows: f.rows || 3 }, v ?? '');
    else if (f.type === 'image') {
      const prev = h('img', { src: v || '', style: { maxWidth: '120px', maxHeight: '80px', display: v ? 'block' : 'none', borderRadius: '8px' } });
      const hidden = { value: v || '' };
      const file = h('input', { type: 'file', accept: f.accept || 'image/*' });
      file.addEventListener('change', async () => { try { const r = await upload(file.files[0], f.kind || 'image'); hidden.value = r.url; prev.src = r.url; prev.style.display = 'block'; } catch (e) { errToast(e); } });
      inp = h('div', {}, prev, file, h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { hidden.value = ''; prev.style.display = 'none'; } }, 'ลบรูป'));
      inp.getValue = () => hidden.value;
    } else inp = h('input', { class: 'input', type: f.type === 'money' ? 'number' : f.type || 'text', step: f.type === 'money' ? '0.01' : f.step, value: f.type === 'money' ? (v ? v / 100 : v === 0 ? 0 : '') : v ?? '', placeholder: f.placeholder || '' });
    inputs[f.k] = inp;
    return h('label', { class: 'field', style: f.wide ? { gridColumn: '1 / -1' } : {} }, f.label, inp, f.hint ? h('span', { class: 'hint' }, f.hint) : null);
  }));
  el.value = () => Object.fromEntries(fields.map((f) => {
    const i = inputs[f.k];
    if (f.type === 'bool') return [f.k, i.checked];
    if (i.getValue) return [f.k, i.getValue()];
    if (f.type === 'money') return [f.k, toSatang(i.value)];
    if (f.type === 'number') return [f.k, i.value === '' ? null : Number(i.value)];
    return [f.k, i.value];
  }));
  return el;
}
export async function upload(file, kind = 'image') {
  if (!file) throw new Error('ไม่ได้เลือกไฟล์');
  const fd = new FormData(); fd.append('file', file); fd.append('kind', kind);
  return api.post('/files', fd);
}
export const page = (title, ...kids) => h('div', {}, h('div', { class: 'page-head' }, h('h2', {}, title)), ...kids);
export const card = (...kids) => h('div', { class: 'card', style: { marginBottom: '1em' } }, ...kids);
export const kpi = (label, value, sub, hero) => h('div', { class: 'card kpi' + (hero ? ' hero' : '') }, h('div', { class: 'lbl' }, label), h('div', { class: 'val' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
export const money = (v) => baht(v) + ' ฿';
export function table(cols, rows, { empty = 'ไม่มีข้อมูล', onRow } = {}) {
  if (!rows.length) return h('div', { class: 'empty' }, empty);
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', {}, h('tr', {}, cols.map((c) => h('th', { class: c.r ? 'r' : '' }, c.t)))),
    h('tbody', {}, rows.map((r) => h('tr', { style: onRow ? { cursor: 'pointer' } : {}, onclick: onRow ? () => onRow(r) : null }, cols.map((c) => h('td', { class: c.r ? 'r num' : '' }, c.f ? c.f(r) : r[c.k] ?? '')))))));
}
// Single-series bar chart (one hue, rounded data-ends, hover tooltip; the table next to it is the accessible view)
export function barChart(points, { fmt = (v) => v, label = (p) => p.x, height = 220 } = {}) {
  const W = Math.max(320, points.length * 28), H = height, pad = { l: 56, r: 8, t: 10, b: 28 };
  const max = Math.max(1, ...points.map((p) => p.y));
  const step = (W - pad.l - pad.r) / Math.max(1, points.length);
  const bw = Math.max(4, Math.min(36, step - 2));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  const add = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; svg.append(e); return e; };
  for (let i = 0; i <= 4; i++) { const v = (max * i) / 4; add('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'grid' }); add('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmt(v)); }
  const tt = $('#tt');
  const every = Math.ceil(points.length / 14);
  points.forEach((p, i) => {
    const x = pad.l + i * step + (step - bw) / 2;
    const top = y(Math.max(0, p.y)), hgt = Math.max(0, H - pad.b - top);
    const r = Math.min(4, bw / 2, hgt);
    // rounded top, square at the baseline
    add('path', { class: 'b', d: `M${x},${H - pad.b} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - pad.b} Z` });
    const hit = add('rect', { x: pad.l + i * step, y: pad.t, width: step, height: H - pad.t - pad.b, fill: 'transparent' });
    hit.addEventListener('mousemove', (e) => { tt.style.display = 'block'; tt.style.left = e.clientX + 12 + 'px'; tt.style.top = e.clientY - 30 + 'px'; tt.textContent = `${label(p)} · ${fmt(p.y)}`; });
    hit.addEventListener('mouseleave', () => { tt.style.display = 'none'; });
    if (i % every === 0) add('text', { x: x + bw / 2, y: H - 8, 'text-anchor': 'middle' }, p.short || p.x);
  });
  return h('div', { style: { overflowX: 'auto' } }, svg);
}
export function saveBtn(label, fn) {
  return h('button', { class: 'btn primary', onclick: async (e) => { e.target.disabled = true; try { await fn(); toast('บันทึกแล้ว', 'ok'); } catch (er) { errToast(er); } finally { e.target.disabled = false; } } }, label);
}
