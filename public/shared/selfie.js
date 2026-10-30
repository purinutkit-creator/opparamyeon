// Clock-in selfie, used on the POS sign-in and on the phone page (/selfie/) behind the QR.
// Live camera → "turn your head a little" liveness check → snap → preview → "use this photo" → face check → done.
// No camera on this device: a QR lets the person take it on their phone; the photo then shows here to confirm.
import { h, toast } from './ui.js';
import { videoDetector, checkFace, yawOf } from './face.js';

const SIZE = 480;
const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.crossOrigin = 'anonymous'; i.onload = () => res(i); i.onerror = rej; i.src = src; });
export async function uploadSelfie(ticket, dataUrl, { live = false, source = 'pos' } = {}) {
  const r = await fetch('/api/clockin/photo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ticket, image: dataUrl, live, source }) });
  const b = await r.json(); if (!r.ok) throw new Error(b.error || 'ส่งรูปไม่สำเร็จ'); return b;
}

// opts: ticket, phoneUrl (QR for "take it on your phone"; omit on the phone itself), useLabel, onUse({ url, face_ok, score, live })
export function selfieBox({ ticket, phoneUrl = null, useLabel = '✓ ใช้รูปนี้', onUse, allowSkip = false, onSkip = null, source = 'pos' } = {}) {
  const video = h('video', { playsinline: true, muted: true, autoplay: true });
  const shot = h('img', { alt: '' });
  const frame = h('div', { class: 'sf-frame' }, video, shot, h('i', { class: 'sf-ring' }));
  const say = h('div', { class: 'sf-say' }, 'กำลังเปิดกล้อง…');
  const dots = h('div', { class: 'sf-steps' }, h('i'), h('i'), h('i'));
  const actions = h('div', { class: 'sf-actions' });
  const box = h('div', { class: 'selfie' }, frame, dots, say, actions);
  let stream = null, timer = null, live = false, dataUrl = null, remoteUrl = null, poll = null, stopped = false;
  const step = (n) => [...dots.children].forEach((d, i) => d.classList.toggle('on', i < n));
  const btn = (label, cls, fn) => h('button', { type: 'button', class: 'btn ' + cls, onclick: fn }, label);
  const stopCam = () => { clearInterval(timer); timer = null; if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; };
  box.stop = () => { stopped = true; stopCam(); clearInterval(poll); };

  const snap = () => {
    const c = document.createElement('canvas'); c.width = c.height = SIZE;
    const vw = video.videoWidth, vh = video.videoHeight, side = Math.min(vw, vh);
    const g = c.getContext('2d'); g.translate(SIZE, 0); g.scale(-1, 1); // mirrored, like the preview
    g.drawImage(video, (vw - side) / 2, (vh - side) / 2, side, side, 0, 0, SIZE, SIZE);
    dataUrl = c.toDataURL('image/jpeg', 0.85);
    stopCam(); preview(dataUrl);
  };
  const preview = (src) => {
    box.className = 'selfie shot'; shot.src = src; step(3);
    say.textContent = 'ดูรูปแล้วกด "ใช้รูปนี้" ระบบจะตรวจว่าเป็นใบหน้าคนจริง';
    actions.replaceChildren(btn('↺ ถ่ายใหม่', '', () => { remoteUrl ? phoneMode() : startCam(); }), btn(useLabel, 'primary big', use));
  };
  const use = async () => {
    box.className = 'selfie shot checking'; say.textContent = '🔍 กำลังตรวจใบหน้า…'; actions.replaceChildren();
    let res;
    try { res = await checkFace(remoteUrl ? await loadImg(remoteUrl) : await loadImg(dataUrl)); }
    catch { res = { ok: true, score: null, unchecked: true }; } // no face model on this device: keep the photo, marked unchecked
    if (!res.ok) { box.className = 'selfie shot bad'; say.textContent = '⚠️ ' + res.reason; actions.replaceChildren(btn('↺ ถ่ายใหม่', 'primary big', () => (remoteUrl ? phoneMode() : startCam()))); return; }
    try {
      const up = remoteUrl ? { url: remoteUrl, live } : await uploadSelfie(ticket, dataUrl, { live, source });
      box.className = 'selfie shot good'; say.textContent = res.unchecked ? '✓ บันทึกรูปแล้ว (เครื่องนี้ตรวจใบหน้าไม่ได้)' : '✓ ยืนยันใบหน้าแล้ว';
      setTimeout(() => onUse && onUse({ url: up.url, face_ok: res.unchecked ? null : true, score: res.score, live: !!up.live }), 650);
    } catch (e) { toast(e.message, 'error'); preview(dataUrl || remoteUrl); }
  };

  // live camera with the turn-your-head check
  const startCam = async () => {
    remoteUrl = null; dataUrl = null; live = false; box.className = 'selfie cam'; step(0);
    actions.replaceChildren(phoneUrl ? btn('📱 ใช้มือถือถ่ายแทน', 'ghost', phoneMode) : null, allowSkip ? btn('ข้าม', 'ghost', () => { box.stop(); onSkip && onSkip(); }) : null);
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 960 } }, audio: false });
      if (stopped) return stopCam();
      video.srcObject = stream; await video.play();
    } catch { return phoneUrl ? phoneMode(true) : (say.textContent = '⚠️ เปิดกล้องไม่ได้ — อนุญาตให้ใช้กล้องในเบราว์เซอร์ แล้วลองใหม่'); }
    const manual = btn('📸 ถ่าย', 'primary big', snap);
    let det = null;
    try { det = await videoDetector(); } catch { /* no face model: plain shutter */ }
    if (!det) { say.textContent = 'มองกล้องแล้วกดถ่าย'; actions.prepend(manual); return; }
    say.textContent = 'มองกล้องตรงๆ';
    let lo = 0, hi = 0, seen = 0, ready = 0;
    timer = setInterval(() => {
      if (!video.videoWidth) return;
      const r = det.detectForVideo(video, performance.now());
      const f = (r.detections || []).find((x) => (x.categories[0] || {}).score > 0.6);
      if (!f) { box.classList.remove('face'); if (!live) say.textContent = 'มองกล้องตรงๆ ให้เห็นทั้งหน้า'; return; }
      box.classList.add('face');
      const y = yawOf(f);
      if (!seen++) { lo = hi = y; step(1); }
      lo = Math.min(lo, y); hi = Math.max(hi, y);
      if (!live) {
        say.textContent = '↔️ หันหน้าไปทางซ้ายหรือขวาเล็กน้อย แล้วกลับมามองกล้อง';
        if (hi - lo > 0.32) { live = true; step(2); box.classList.add('live'); actions.prepend(manual); }
      } else if (Math.abs(y) < 0.12) { // facing the camera again: count down and snap
        say.textContent = '😊 ดีมาก! ค้างไว้…'; if (++ready >= 5) snap();
      } else { ready = 0; say.textContent = 'กลับมามองกล้องตรงๆ'; }
    }, 110);
  };

  // take it on a phone: QR here, the photo appears once it's sent
  const phoneMode = (noCam = false) => {
    stopCam(); remoteUrl = null; box.className = 'selfie phone'; step(0);
    shot.src = '/api/qr.svg?d=' + encodeURIComponent(phoneUrl);
    say.replaceChildren(h('b', {}, noCam ? 'เครื่องนี้ไม่มีกล้อง · ' : '', '📱 สแกน QR ด้วยมือถือตัวเองเพื่อถ่ายรูป'), h('small', {}, 'ถ่ายเสร็จกดส่งบนมือถือ รูปจะขึ้นที่นี่ให้กดยืนยัน'));
    actions.replaceChildren(noCam ? null : btn('📷 ใช้กล้องเครื่องนี้', 'ghost', startCam), allowSkip ? btn('ข้าม', 'ghost', () => { box.stop(); onSkip && onSkip(); }) : null);
    const since = Date.now();
    clearInterval(poll);
    poll = setInterval(async () => {
      if (!document.body.contains(box)) return box.stop();
      try {
        const r = await fetch('/api/clockin/photo/' + encodeURIComponent(ticket)).then((x) => x.json());
        if (r.url && Date.parse(r.at) >= since - 2000) { clearInterval(poll); remoteUrl = r.url; live = !!r.live; preview(r.url); }
      } catch { /* keep waiting */ }
    }, 1500);
  };

  setTimeout(() => (navigator.mediaDevices && navigator.mediaDevices.getUserMedia ? startCam() : phoneUrl ? phoneMode(true) : (say.textContent = 'อุปกรณ์นี้ไม่มีกล้อง')), 50);
  return box;
}

export const SELFIE_CSS = `
.selfie { display: grid; justify-items: center; gap: 10px; text-align: center; }
.sf-frame { position: relative; width: min(300px, 70vw); aspect-ratio: 1; border-radius: 50%; overflow: hidden; background: #111; box-shadow: 0 14px 40px rgb(0 0 0 / .25); transition: transform .5s var(--ease-spring, ease), border-radius .5s; }
.sf-frame video, .sf-frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.sf-frame video { transform: scaleX(-1); }
.sf-frame img { display: none; background: #fff; }
.selfie.shot .sf-frame img, .selfie.phone .sf-frame img { display: block; }
.selfie.phone .sf-frame { border-radius: 24px; background: #fff; } .selfie.phone .sf-frame img { object-fit: contain; padding: 14px; }
.sf-ring { position: absolute; inset: 0; border-radius: inherit; border: 5px solid rgb(255 255 255 / .5); transition: border-color .3s, box-shadow .3s; pointer-events: none; }
.selfie.face .sf-ring { border-color: #facc15; }
.selfie.live .sf-ring, .selfie.good .sf-ring { border-color: #22c55e; box-shadow: inset 0 0 0 3px rgb(34 197 94 / .4); }
.selfie.bad .sf-ring { border-color: #ef4444; }
.selfie.checking .sf-frame { animation: sf-pulse 1s ease-in-out infinite; }
.selfie.good .sf-frame { animation: sf-ok .6s var(--ease-spring, ease); }
@keyframes sf-pulse { 50% { transform: scale(.97); } }
@keyframes sf-ok { 50% { transform: scale(1.06); } }
.sf-say { min-height: 2.6em; font-weight: 700; display: grid; gap: 2px; } .sf-say small { font-weight: 600; opacity: .75; }
.sf-steps { display: flex; gap: 6px; } .sf-steps i { width: 26px; height: 6px; border-radius: 6px; background: var(--line, #ddd); transition: background .3s; } .sf-steps i.on { background: #22c55e; }
.sf-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
`;
