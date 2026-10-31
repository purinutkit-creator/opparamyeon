// Live camera barcode scanner (stock page): back camera by default, a button switches cameras.
// Uses the browser's BarcodeDetector when it has one, otherwise ZXing (served from /vendor) on video frames.
import { h, modal } from './ui.js';

const FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'];
let zxLoad;
const loadZX = () => (zxLoad ||= new Promise((res, rej) => {
  if (window.ZXing) return res(window.ZXing);
  const s = document.createElement('script'); s.src = '/vendor/zxing.min.js'; s.onload = () => res(window.ZXing); s.onerror = rej; document.head.append(s);
}));

async function makeReader() {
  if ('BarcodeDetector' in window) {
    try {
      const sup = await window.BarcodeDetector.getSupportedFormats();
      const fm = FORMATS.filter((f) => sup.includes(f));
      if (fm.length) { const d = new window.BarcodeDetector({ formats: fm }); return async (video) => { const r = await d.detect(video); return r[0] ? r[0].rawValue : null; }; }
    } catch { /* fall back to ZXing */ }
  }
  const ZX = await loadZX();
  const reader = new ZX.MultiFormatReader();
  const hints = new Map();
  hints.set(ZX.DecodeHintType.POSSIBLE_FORMATS, [ZX.BarcodeFormat.EAN_13, ZX.BarcodeFormat.EAN_8, ZX.BarcodeFormat.UPC_A, ZX.BarcodeFormat.UPC_E, ZX.BarcodeFormat.CODE_128, ZX.BarcodeFormat.CODE_39, ZX.BarcodeFormat.ITF, ZX.BarcodeFormat.QR_CODE]);
  reader.setHints(hints);
  const c = document.createElement('canvas');
  return async (video) => {
    const w = Math.min(960, video.videoWidth), k = w / video.videoWidth;
    c.width = w; c.height = Math.round(video.videoHeight * k);
    c.getContext('2d', { willReadFrequently: true }).drawImage(video, 0, 0, c.width, c.height);
    try { return reader.decode(new ZX.BinaryBitmap(new ZX.HybridBinarizer(new ZX.HTMLCanvasElementLuminanceSource(c)))).getText(); } catch { return null; }
  };
}

// opens a dialog with the camera; onCode(code) is called once and the dialog closes
export function scanWithCamera(onCode, { title = '📷 สแกนบาร์โค้ดด้วยกล้อง' } = {}) {
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  const say = h('div', { class: 'bc-say' }, 'กำลังเปิดกล้อง…');
  const view = h('div', { class: 'bc-view' }, video, h('i', { class: 'bc-line' }), h('i', { class: 'bc-box' }));
  let facing = localStorage.getItem('opp.bc_facing') || 'environment', stream = null, timer = null, done = false;
  const stop = () => { clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  const start = async () => {
    stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      video.srcObject = stream; video.classList.toggle('mirror', facing === 'user'); await video.play();
    } catch { say.textContent = '⚠️ เปิดกล้องไม่ได้ — อนุญาตให้ใช้กล้อง หรือใช้เครื่องยิงบาร์โค้ดแทน'; return; }
    say.textContent = 'เล็งบาร์โค้ดให้อยู่ในกรอบ';
    const read = await makeReader().catch(() => null);
    if (!read) { say.textContent = '⚠️ อุปกรณ์นี้อ่านบาร์โค้ดจากกล้องไม่ได้'; return; }
    let busy = false;
    timer = setInterval(async () => {
      if (busy || done || !video.videoWidth) return;
      busy = true;
      try {
        const code = await read(video);
        if (code && !done) { done = true; if (navigator.vibrate) navigator.vibrate(60); view.classList.add('hit'); setTimeout(() => { dlg.close(); onCode(String(code).trim()); }, 250); }
      } finally { busy = false; }
    }, 220);
  };
  const flip = h('button', { type: 'button', class: 'btn', onclick: () => { facing = facing === 'environment' ? 'user' : 'environment'; try { localStorage.setItem('opp.bc_facing', facing); } catch { /* storage blocked */ } start(); } }, '🔄 กลับกล้อง');
  const dlg = modal(title, h('div', { class: 'bc-wrap' }, view, say, h('div', { class: 'row', style: { justifyContent: 'center' } }, flip)), { onClose: stop, autofocus: false });
  start();
  return dlg;
}

export const BARCODECAM_CSS = `
.bc-wrap { display: grid; gap: 10px; justify-items: center; }
.bc-view { position: relative; width: min(560px, 100%); aspect-ratio: 4 / 3; border-radius: 18px; overflow: hidden; background: #111; }
.bc-view video { width: 100%; height: 100%; object-fit: cover; } .bc-view video.mirror { transform: scaleX(-1); }
.bc-box { position: absolute; inset: 22% 12%; border: 3px solid rgb(255 255 255 / .85); border-radius: 14px; box-shadow: 0 0 0 999px rgb(0 0 0 / .28); transition: border-color .2s; }
.bc-line { position: absolute; left: 14%; right: 14%; height: 2px; background: #ef4444; box-shadow: 0 0 12px 2px #ef4444; animation: bc-scan 1.8s ease-in-out infinite alternate; z-index: 1; }
.bc-view.hit .bc-box { border-color: #22c55e; } .bc-view.hit .bc-line { background: #22c55e; box-shadow: 0 0 12px 2px #22c55e; }
@keyframes bc-scan { from { top: 24%; } to { top: 76%; } }
.bc-say { font-weight: 700; }
`;
