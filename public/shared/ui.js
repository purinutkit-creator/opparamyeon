// Tiny DOM helpers (no framework): h(), toast, modal, confirm/prompt, keypad.
import { leave } from './motion.js';

// Conditional children (cond ? node : null) are used everywhere; skip null/undefined/false instead of rendering "null".
for (const m of ['replaceChildren', 'append']) {
  const orig = Element.prototype[m];
  Element.prototype[m] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); };
}
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastBox;
export function toast(msg, type = 'info', ms = 3200) {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: 'toast ' + type }, msg);
  toastBox.append(t);
  setTimeout(() => leave(t, 'out', () => t.remove(), 420), ms);
}
export const errToast = (e) => toast(e && e.message ? e.message : String(e), 'error', 5000);

export function modal(title, body, { actions = [], wide = false, onClose = null, closable = true, autofocus = true } = {}) {
  let closed = false;
  const close = () => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey);
    leave(back, 'closing', () => back.remove(), 240); // the dialog sinks and the backdrop fades; onClose runs at once
    onClose && onClose();
  };
  const onKey = (e) => { if (e.key === 'Escape' && closable) close(); };
  const footer = h('div', { class: 'modal-actions' }, actions.map((a) => h('button', { class: 'btn ' + (a.class || ''), onclick: async (e) => {
    if (a.busy) return;
    a.busy = true; e.currentTarget.disabled = true;
    try { const r = await a.onClick(close); if (r !== false && a.close !== false) close(); } catch (err) { errToast(err); }
    finally { a.busy = false; if (e.currentTarget) e.currentTarget.disabled = false; }
  } }, a.label)));
  const box = h('div', { class: 'modal' + (wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h3', {}, title), closable && h('button', { class: 'icon-btn', 'aria-label': 'ปิด', onclick: close }, '✕')),
    h('div', { class: 'modal-body' }, body), actions.length ? footer : null);
  const back = h('div', { class: 'modal-back', onclick: (e) => { if (e.target === back && closable) close(); } }, box);
  document.body.append(back);
  document.addEventListener('keydown', onKey);
  // autofocus:false keeps the on-screen keyboard closed on tablets when typing is optional
  if (autofocus) setTimeout(() => { const f = box.querySelector('input,select,textarea'); if (f) f.focus(); }, 30);
  return { close, box };
}
export function confirmBox(title, text, okLabel = 'ยืนยัน', danger = false) {
  return new Promise((resolve) => {
    modal(title, h('p', {}, text), { onClose: () => resolve(false), actions: [
      { label: 'ยกเลิก', onClick: () => resolve(false) },
      { label: okLabel, class: danger ? 'danger' : 'primary', onClick: () => { resolve(true); } },
    ] });
  });
}
export function promptBox(title, { label = '', value = '', type = 'text', required = true, placeholder = '' } = {}) {
  return new Promise((resolve) => {
    const inp = h('input', { type, value, placeholder, class: 'input' });
    let done = false;
    const m = modal(title, h('label', { class: 'field' }, label, inp), { onClose: () => { if (!done) resolve(null); }, actions: [
      { label: 'ยกเลิก', onClick: () => {} },
      { label: 'ตกลง', class: 'primary', onClick: () => { if (required && !inp.value.trim()) { inp.focus(); return false; } done = true; resolve(inp.value); } },
    ] });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { m.box.querySelector('.btn.primary').click(); } });
  });
}
// On-screen number pad for touch devices
export function keypad(input, { onEnter, decimal = false } = {}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? '.' : 'C', '0', '⌫'];
  return h('div', { class: 'keypad' }, keys.map((k) => h('button', { type: 'button', class: 'key', onclick: () => {
    if (k === '⌫') input.value = input.value.slice(0, -1);
    else if (k === 'C') input.value = '';
    else input.value += k;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } }, k)), onEnter ? h('button', { type: 'button', class: 'key enter', onclick: onEnter }, 'ตกลง') : null);
}
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
export const fmtDateOnly = (ymd) => (ymd ? new Date(ymd + 'T12:00:00Z').toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export function debounce(fn, ms = 300) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
export const STATUS_TH = { held: 'พักบิล', open: 'เปิดบิล', pending_payment: 'รอชำระ', paid: 'ชำระแล้ว', void: 'ยกเลิก', expired: 'หมดอายุ' };
export const PREP_TH = { none: 'รอชำระ', received: 'รับออเดอร์แล้ว', cooking: 'กำลังทำ', ready: 'พร้อมรับ', done: 'เสร็จสิ้น' };
export const SOURCE_TH = { pos: 'POS', mobile_table: 'Mobile โต๊ะ', mobile_pickup: 'Mobile Pick Up' };
export const JOB_TH = { queued: 'รอพิมพ์', claimed: 'กำลังส่ง', sent: 'เครื่องรับงานแล้ว (ยืนยันการพิมพ์ไม่ได้)', printed: 'พิมพ์สำเร็จ (เครื่องยืนยัน)', failed: 'ผิดพลาด', unknown: 'ไม่ทราบผล', cancelled: 'ยกเลิก' };

// Split login screen with the brand artwork (POS / admin / kitchen)
export function loginHero(title, text, formCard) {
  return h('div', { class: 'login-hero' }, h('div', { class: 'art' }, h('img', { class: 'bowl', src: '/assets/bowl.svg', alt: '' }),
    h('h1', {}, '🍜 Oppa Ramyeon', h('br'), title), h('p', {}, text)), h('div', { class: 'form' }, formCard));
}
