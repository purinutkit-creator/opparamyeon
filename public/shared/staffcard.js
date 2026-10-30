// Staff ID card drawn on a canvas (credit-card shape, 1012×638 ≈ 300 dpi) so it can be downloaded or printed.
import { fontStack, familyCss } from './fonts.js';

const W = 1012, H = 638;
const img = (src, cors) => new Promise((res) => { if (!src) return res(null); const i = new Image(); if (cors) i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
const brand = () => (getComputedStyle(document.documentElement).getPropertyValue('--brand') || '').trim() || '#d4202f';

// staff: { name, last_name, nickname, title, role_name, code, photo } · shop: { store, logo } · qrUrl: link in the QR
export async function drawStaffCard(staff, shop, qrUrl, fonts) {
  const [body, head] = await Promise.all([fontStack(fonts, 'staff_card'), fontStack(fonts, 'staff_card', '_head')]);
  const BF = familyCss(body || '"Sarabun"'), HF = familyCss(head || body || '"Prompt"');
  await document.fonts.ready;
  const [photo, logo, qr] = await Promise.all([img(staff.photo, /^https?:/.test(staff.photo || '')), img(shop.logo || '/assets/bowl.svg'), img(qrUrl ? '/api/qr.svg?d=' + encodeURIComponent(qrUrl) : null)]);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  const B = brand();
  const rr = (X, Y, w, h, r) => { x.beginPath(); x.roundRect(X, Y, w, h, r); };
  // card
  rr(0, 0, W, H, 44); x.save(); x.clip();
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
  // header band
  const g = x.createLinearGradient(0, 0, W, 170); g.addColorStop(0, B); g.addColorStop(1, '#7a0f14');
  x.fillStyle = g; x.fillRect(0, 0, W, 170);
  x.globalAlpha = 0.12; x.fillStyle = '#fff'; x.beginPath(); x.arc(W - 90, 20, 170, 0, Math.PI * 2); x.fill(); x.beginPath(); x.arc(120, 190, 90, 0, Math.PI * 2); x.fill(); x.globalAlpha = 1;
  if (logo) { x.fillStyle = 'rgba(255,255,255,.95)'; x.beginPath(); x.arc(96, 85, 52, 0, Math.PI * 2); x.fill(); const s = 76; x.drawImage(logo, 96 - s / 2, 85 - s / 2, s, s); }
  x.fillStyle = '#fff'; x.textBaseline = 'middle';
  x.font = `700 46px ${HF}`; x.fillText(shop.store || '', 170, 70, W - 400);
  x.font = `700 24px ${BF}`; x.globalAlpha = 0.85; x.fillText('STAFF ID CARD · บัตรพนักงาน', 172, 118); x.globalAlpha = 1;
  // photo (circle with a ring)
  const px = 175, py = 360, pr = 125;
  x.fillStyle = '#fff'; x.beginPath(); x.arc(px, py, pr + 12, 0, Math.PI * 2); x.fill();
  x.strokeStyle = B; x.lineWidth = 6; x.beginPath(); x.arc(px, py, pr + 12, 0, Math.PI * 2); x.stroke();
  x.save(); x.beginPath(); x.arc(px, py, pr, 0, Math.PI * 2); x.clip();
  if (photo) { const s = Math.max((pr * 2) / photo.width, (pr * 2) / photo.height); const w = photo.width * s, h = photo.height * s; x.drawImage(photo, px - w / 2, py - h / 2, w, h); }
  else { x.fillStyle = '#f3e3dd'; x.fillRect(px - pr, py - pr, pr * 2, pr * 2); x.fillStyle = B; x.font = `700 110px ${HF}`; x.textAlign = 'center'; x.fillText((staff.name || '?').trim()[0] || '?', px, py + 6); x.textAlign = 'left'; }
  x.restore();
  // name block
  const tx = 345, maxW = W - tx - 270;
  x.fillStyle = '#1d1210'; x.textBaseline = 'alphabetic';
  x.font = `800 58px ${HF}`; x.fillText(staff.name || '', tx, 275, maxW);
  x.font = `700 40px ${HF}`; x.fillStyle = '#3b2a26'; if (staff.last_name) x.fillText(staff.last_name, tx, 328, maxW);
  x.font = `600 28px ${BF}`; x.fillStyle = '#8a7570'; if (staff.nickname) x.fillText(`ชื่อเล่น: ${staff.nickname}`, tx, 374, maxW);
  // role pill
  const role = staff.title || staff.role_name || '';
  if (role) { x.font = `800 26px ${BF}`; const w = Math.min(maxW, x.measureText(role).width + 44); x.fillStyle = B; rr(tx, 398, w, 48, 24); x.fill(); x.fillStyle = '#fff'; x.textBaseline = 'middle'; x.fillText(role, tx + 22, 423, w - 44); x.textBaseline = 'alphabetic'; }
  // code
  x.fillStyle = '#8a7570'; x.font = `700 24px ${BF}`; x.fillText('รหัสพนักงาน', tx, 498);
  x.fillStyle = '#1d1210'; x.font = `800 50px ${HF}`; x.fillText(staff.code || '', tx, 552, maxW);
  // QR
  if (qr) { const qs = 210, qx = W - qs - 50, qy = 230; x.fillStyle = '#fff'; rr(qx - 12, qy - 12, qs + 24, qs + 24, 22); x.fill(); x.strokeStyle = '#eadcd7'; x.lineWidth = 3; x.stroke(); x.drawImage(qr, qx, qy, qs, qs);
    x.fillStyle = '#8a7570'; x.font = `700 21px ${BF}`; x.textAlign = 'center'; x.fillText('สแกนเข้าระบบ / ดูข้อมูล', qx + qs / 2, qy + qs + 42); x.textAlign = 'left'; }
  // bottom stripe
  x.fillStyle = B; x.fillRect(0, H - 22, W, 22);
  x.restore();
  return c;
}
// print several cards on A4 (2 columns, real card size 85.6 × 54 mm)
export function printCards(canvases) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.append(f);
  f.contentDocument.write(`<html><head><style>@page{size:A4;margin:10mm}body{margin:0;display:grid;grid-template-columns:repeat(2,85.6mm);gap:6mm}img{width:85.6mm;height:54mm;border:1px dashed #ccc;border-radius:3mm}</style></head><body>${canvases.map((cv) => `<img src="${cv.toDataURL('image/png')}">`).join('')}</body></html>`);
  f.contentDocument.close();
  setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => f.remove(), 1500); }, 400);
}
