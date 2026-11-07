// Photo booth (kiosk): scan the receipt → pick a layout → countdown photos → filters + thermal preview → print → QR to download.
// Also the customer's download page (#d=<token>). The booth is a paired device; printing goes through the shop's print queue,
// to a printer linked to this booth or to any other device of the shop.
import { makeApi, store, socket } from '/shared/api.js';
import { h, toast, errToast } from '/shared/ui.js';
import { baht, fromThaiKeys, keyFromCode, VERSION } from '/shared/core.js';
import { t as tx, initLang, langPicker } from '/shared/i18n.js';
import { applyFilter, toGray, dither, bitsToImageData, FILTERS, DITHERS } from '/photo/thermal.js';

const api = makeApi({ tokenKey: 'photo_token' });
const app = document.getElementById('app');
const qs = new URLSearchParams(location.search);
let cfg = null, sock = null, host = null, screen = '', lastTouch = Date.now(), stream = null;
let S = null; // the current customer: { session_id, amount, layout, photos[], filter, tone, method, strength, consent, download_url, number }

const LAYOUTS = {
  single: { n: 1, cols: 1, ar: 1.25, name: () => tx('รูปเดี่ยว') },
  strip2: { n: 2, cols: 1, ar: 0.75, name: () => tx('แถบ 2 รูป') },
  strip3: { n: 3, cols: 1, ar: 0.75, name: () => tx('แถบ 3 รูป') },
  strip4: { n: 4, cols: 1, ar: 0.75, name: () => tx('แถบ 4 รูป') },
  grid4: { n: 4, cols: 2, ar: 1.3, name: () => tx('เกาหลี 2×2') },
  grid6: { n: 6, cols: 2, ar: 1.2, name: () => tx('ตาราง 6 รูป') },
  grid8: { n: 8, cols: 2, ar: 1.2, name: () => tx('ปุริคุระ 8 รูป') },
  receipt: { n: 3, cols: 1, ar: 0.75, name: () => tx('ใบเสร็จคลาสสิก'), receipt: true },
};
const FILTER_NAME = () => ({ original: tx('ต้นฉบับ'), bw: tx('ขาวดำ'), contrast: tx('คมชัด'), korean: tx('เกาหลี'), vintage: tx('วินเทจ'), retro: tx('เรโทร'), film: tx('ฟิล์ม'), soft: tx('ซอฟต์'), pixel: tx('พิกเซล') });
const DITHER_NAME = () => ({ floyd: 'Floyd–Steinberg', atkinson: 'Atkinson', bayer: 'Bayer', threshold: tx('ขาว/ดำ') });

// ---------------- helpers ----------------
const go = (name, ...kids) => { screen = name; app.replaceChildren(h('div', { class: 'screen scr-' + name }, ...kids)); };
let taps = [];
// 5 quick taps on the shop name → booth settings (link the printer); nothing visible for customers
const secretTap = () => { const t = Date.now(); taps = [...taps.filter((x) => t - x < 2500), t]; if (taps.length >= 5) { taps = []; settingsSheet(); } };
const topBar = (...extra) => h('div', { class: 'top' },
  h('div', { class: 'brand', onclick: secretTap }, cfg.logo || cfg.store.logo ? h('img', { src: cfg.logo || cfg.store.logo, alt: '' }) : h('span', { style: { fontSize: '28px' } }, '📸'), h('b', {}, cfg.store.name || 'PHOTO BOOTH')),
  ...extra, langPicker(h, () => redraw(), { maxWidth: '120px' }));
let redraw = () => welcome();
const printerPill = () => (cfg.printer ? h('span', { class: 'pill ok' }, h('i'), '🖨 ', cfg.printer.name, ` · ${cfg.printer.paper}mm`) : h('span', { class: 'pill demo' }, tx('DEMO · ยังไม่ได้ตั้งเครื่องพิมพ์')));
function shutterSound() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const len = ac.sampleRate * 0.12, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
    const src = ac.createBufferSource(); src.buffer = buf; const g = ac.createGain(); g.gain.value = 0.6; src.connect(g).connect(ac.destination); src.start();
    setTimeout(() => ac.close(), 400);
  } catch { /* no sound */ }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UIF = () => cfg.font || 'Prompt';
const STRIPF = () => cfg.strip_font || UIF();
const qrCache = new Map();
const qrMatrix = (text) => { if (!qrCache.has(text)) qrCache.set(text, fetch('/api/qr-matrix?d=' + encodeURIComponent(text)).then((r) => r.json()).catch(() => null)); return qrCache.get(text); };

// ---------------- the strip ----------------
// one layout drawn at width W: header, photos (cover-cropped), footer (text, date, number, QR). colour = download copy, otherwise thermal
async function compose(W, { thermal = false } = {}) {
  const L = LAYOUTS[S.layout];
  const pad = Math.round(W * 0.055), gap = Math.round(W * 0.03);
  const cellW = Math.floor((W - pad * 2 - gap * (L.cols - 1)) / L.cols), cellH = Math.round(cellW * L.ar);
  const rows = Math.ceil(L.n / L.cols);
  const fs = (k) => Math.max(12, Math.round(W * k));
  const title = (cfg.title || '').trim(), foot = (cfg.footer || '').trim();
  const qr = cfg.show_qr && S.consent && S.download_url ? await qrMatrix(S.download_url) : null;
  const when = new Date().toLocaleString(({ en: 'en-GB', zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR' })[document.documentElement.lang] || 'th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'medium', timeStyle: 'short' });
  // measure
  let H = pad;
  const headH = L.receipt ? fs(0.06) * 4 + gap * 2 : (title ? fs(0.075) * 1.25 + gap : 0) + fs(0.04) * 1.3 + gap;
  H += headH + rows * cellH + (rows - 1) * gap + gap;
  const footLines = [L.receipt ? null : foot, cfg.show_date ? when : null, `#${S.number || ''}`].filter(Boolean);
  const qrPx = qr ? Math.round(W * 0.36) : 0;
  H += footLines.length * fs(0.045) * 1.4 + (L.receipt ? fs(0.05) * 3 : 0) + (qr ? qrPx + fs(0.035) * 1.6 : 0) + pad;
  const c = document.createElement('canvas'); c.width = W; c.height = Math.round(H);
  const x = c.getContext('2d');
  x.fillStyle = '#fff'; x.fillRect(0, 0, W, c.height); x.fillStyle = '#000'; x.textAlign = 'center'; x.textBaseline = 'top';
  let y = pad;
  const line = (txt, size, weight = 700, font = `"${STRIPF()}"`) => { x.font = `${weight} ${size}px ${font}, Sarabun, sans-serif`; x.fillText(txt, W / 2, y, W - pad * 2); y += size * 1.3; };
  const dash = () => { x.save(); x.setLineDash([Math.max(4, W * 0.015), Math.max(4, W * 0.012)]); x.lineWidth = Math.max(2, W / 200); x.beginPath(); x.moveTo(pad, y); x.lineTo(W - pad, y); x.stroke(); x.restore(); y += gap; };
  if (L.receipt) {
    line(cfg.store.name || 'PHOTO BOOTH', fs(0.06), 800, "'Space Mono'"); line('*** PHOTO RECEIPT ***', fs(0.045), 700, "'Space Mono'"); line(when, fs(0.04), 400, "'Space Mono'"); dash();
  } else {
    if (title) { line(title, fs(0.075), 800); y += gap * 0.2; }
    line(cfg.store.name || '', fs(0.04), 400);
    y += gap * 0.4;
  }
  for (let i = 0; i < L.n; i++) {
    const col = i % L.cols, row = Math.floor(i / L.cols);
    const cx = pad + col * (cellW + gap), cy = y + row * (cellH + gap);
    const ph = S.photos[i];
    if (ph) {
      // cover crop into the cell
      const sr = ph.width / ph.height, dr = cellW / cellH;
      let sw = ph.width, sh = ph.height, sx = 0, sy = 0;
      if (sr > dr) { sw = ph.height * dr; sx = (ph.width - sw) / 2; } else { sh = ph.width / dr; sy = (ph.height - sh) / 2; }
      const tmp = document.createElement('canvas'); tmp.width = cellW; tmp.height = cellH;
      const tx2 = tmp.getContext('2d'); tx2.drawImage(ph, sx, sy, sw, sh, 0, 0, cellW, cellH);
      const id = tx2.getImageData(0, 0, cellW, cellH); applyFilter(id, S.filter, 1); tx2.putImageData(id, 0, 0);
      x.drawImage(tmp, cx, cy);
    } else { x.fillStyle = '#ddd'; x.fillRect(cx, cy, cellW, cellH); x.fillStyle = '#000'; }
    x.lineWidth = Math.max(2, W / 220); x.strokeRect(cx, cy, cellW, cellH);
  }
  y += rows * cellH + (rows - 1) * gap + gap;
  if (L.receipt) {
    dash(); x.textAlign = 'left'; x.font = `700 ${fs(0.045)}px 'Space Mono', monospace`;
    x.fillText(`SMILE x${L.n}`, pad, y); x.textAlign = 'right'; x.fillText('PRICELESS', W - pad, y); y += fs(0.05) * 1.4; x.textAlign = 'center';
    line(foot || 'THANK YOU FOR SMILING', fs(0.05), 800, "'Space Mono'");
  }
  for (const t of footLines) line(t, fs(0.045), t === foot ? 800 : 400, L.receipt ? "'Space Mono'" : `"${STRIPF()}"`);
  if (qr) {
    const m = Math.floor(qrPx / (qr.size + 2)), size = m * (qr.size + 2), qx = Math.round((W - size) / 2);
    x.fillStyle = '#fff'; x.fillRect(qx, y, size, size); x.fillStyle = '#000';
    for (let r = 0; r < qr.size; r++) for (let k = 0; k < qr.size; k++) if (qr.data[r * qr.size + k]) x.fillRect(qx + (k + 1) * m, y + (r + 1) * m, m, m);
    y += size + 4; line(tx('สแกนเพื่อดาวน์โหลดรูป'), fs(0.035), 400);
  }
  if (thermal) {
    const id = x.getImageData(0, 0, W, c.height);
    const bits = dither(toGray(id, S.tone), S.method, { strength: S.strength });
    bitsToImageData(bits, W, c.height, id.data); x.putImageData(id, 0, 0);
  }
  return c;
}

// ---------------- screens ----------------
function welcome() {
  S = null; redraw = welcome; stopCamera();
  const sample = h('canvas', { class: 'sample' });
  drawSample(sample);
  go('welcome', topBar(printerPill(), h('button', { class: 'btn', onclick: fullscreen, title: 'Fullscreen' }, '⛶')),
    h('div', { class: 'welcome' },
      h('div', { class: 'center', style: { justifyItems: 'start', textAlign: 'left' } },
        h('span', { class: 'pill' }, '✨ ', cfg.require_receipt ? tx('ซื้อครบ {0} บาท ถ่ายรูปฟรี!', baht(cfg.min_spend)) : tx('ถ่ายรูปฟรี!')),
        h('h1', {}, (cfg.title || 'YOUR LITTLE MOMENT').split(' ').slice(0, -1).join(' ') + ' ', h('em', {}, (cfg.title || 'YOUR LITTLE MOMENT').split(' ').slice(-1)[0])),
        h('div', { class: 'sub' }, cfg.require_receipt ? tx('สแกน QR บนใบเสร็จเพื่อแลกสิทธิ์ แล้วถ่ายรูปพิมพ์ออกมาเป็นที่ระลึก') : tx('ถ่ายรูปแล้วพิมพ์ออกมาเป็นที่ระลึก')),
        h('button', { class: 'btn acc big', onclick: () => (cfg.require_receipt ? scanScreen() : redeem(null)) }, '▶ START PHOTOBOOTH')),
      h('div', { class: 'center' }, sample)),
    h('div', { class: 'row muted small' }, `v${VERSION}`));
}
// a little printed-strip look for the welcome screen
function drawSample(c) {
  const W = 180, H = 520; c.width = W; c.height = H;
  const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); x.fillStyle = '#111'; x.font = '800 15px Prompt'; x.textAlign = 'center'; x.fillText('LITTLE MOMENT', W / 2, 26);
  for (let i = 0; i < 3; i++) {
    const y0 = 40 + i * 140;
    for (let yy = 0; yy < 128; yy += 2) for (let xx = 0; xx < 156; xx += 2) {
      const v = 0.5 + 0.5 * Math.sin((xx + i * 30) / 18) * Math.cos((yy - i * 12) / 22) - Math.hypot(xx - 78, yy - 70) / 260;
      if (Math.random() > v) x.fillRect(12 + xx, y0 + yy, 2, 2);
    }
    x.strokeRect(12, y0, 156, 128);
  }
  x.font = '400 11px Prompt'; x.fillText('THANK YOU FOR SMILING', W / 2, 500);
}

// --- 1. receipt ---
function scanScreen() {
  redraw = scanScreen;
  const out = h('div');
  const inp = h('input', { class: 'scaninput', autocomplete: 'off', 'aria-label': 'scan' });
  let busy = false;
  const check = async (raw) => {
    const code = fromThaiKeys(String(raw || '').trim());
    inp.value = '';
    if (!code || busy) return;
    busy = true; out.replaceChildren(h('div', { class: 'bar' }, h('i')));
    try { await redeem(code, out); } finally { busy = false; }
  };
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); check(inp.value); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const ch = keyFromCode(e); if (ch) { e.preventDefault(); inp.value += ch; }
  });
  inp.addEventListener('paste', (e) => { e.preventDefault(); check((e.clipboardData || window.clipboardData).getData('text')); });
  // the booth's own camera reads the receipt QR / barcode by itself while this screen is open
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: 'scan-video' });
  const camMsg = h('div', { class: 'scan-msg' }, tx('กำลังเปิดกล้อง…'));
  const camBox = h('div', { class: 'scan-cam' }, video, h('i', { class: 'scan-frame' }), h('i', { class: 'scan-laser' }), camMsg);
  const camSel = h('select', { class: 'chip', style: { display: 'none' }, onchange: () => { store.set('photo_scan_cam', camSel.value); startScanCam(); } });
  const flipBtn = h('button', { class: 'btn', onclick: () => { store.set('photo_scan_cam', ''); store.set('photo_scan_facing', store.get('photo_scan_facing', 'user') === 'user' ? 'environment' : 'user'); startScanCam(); } }, tx('🔄 สลับกล้อง'));
  let timer = null, lastCode = '', lastAt = 0; // the same receipt held in view is read once every few seconds, not every frame
  const startScanCam = async () => {
    stopCamera(); clearInterval(timer);
    const dev = store.get('photo_scan_cam', ''), facing = store.get('photo_scan_facing', 'user');
    try { stream = await navigator.mediaDevices.getUserMedia({ video: { ...(dev ? { deviceId: { exact: dev } } : { facingMode: facing }), width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
    catch { try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch { camMsg.textContent = tx('เปิดกล้องไม่ได้ — อนุญาตการใช้กล้อง หรือใช้เครื่องยิงสแกน'); return; } }
    video.srcObject = stream; await video.play().catch(() => {});
    const tr = stream.getVideoTracks()[0], st2 = tr && tr.getSettings ? tr.getSettings() : {};
    video.classList.toggle('mirror', st2.facingMode !== 'environment');
    camMsg.textContent = tx('ถือใบเสร็จให้ QR หรือบาร์โค้ดอยู่ในกรอบ ห่างกล้องประมาณ 15–25 ซม.');
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    camSel.replaceChildren(...cams.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === st2.deviceId }, '📷 ' + (d.label || tx('กล้อง {0}', i + 1)))));
    camSel.style.display = cams.length > 1 ? '' : 'none';
    const { makeReader } = await import('/shared/barcodecam.js');
    const read = await makeReader().catch(() => null);
    if (!read) { camMsg.textContent = tx('อุปกรณ์นี้อ่านบาร์โค้ดจากกล้องไม่ได้ — ใช้เครื่องยิงสแกน'); return; }
    let reading = false;
    timer = setInterval(async () => {
      if (screen !== 'scan') { clearInterval(timer); return; }
      if (reading || busy || !video.videoWidth) return;
      reading = true;
      try { const code = await read(video); if (code && !(code === lastCode && Date.now() - lastAt < 5000)) { lastCode = code; lastAt = Date.now(); camBox.classList.add('hit'); setTimeout(() => camBox.classList.remove('hit'), 900); await check(code); } }
      catch { /* next frame */ } finally { reading = false; }
    }, 200);
  };
  go('scan', topBar(printerPill()),
    h('div', { class: 'center' }, h('div', { class: 'scanbox' },
      h('h2', {}, tx('กรุณาสแกนใบเสร็จเพื่อแลกสิทธิ์')),
      h('div', { class: 'sub' }, tx('ถือ QR หรือบาร์โค้ดท้ายใบเสร็จหน้ากล้อง หรือยิงเครื่องสแกน · ยอดซื้อครบ {0} บาท ถ่ายรูปฟรี', baht(cfg.min_spend))),
      camBox, h('div', { class: 'row' }, camSel, flipBtn, h('button', { class: 'btn', onclick: welcome }, tx('← กลับ'))),
      out, inp)),
    h('div'));
  startScanCam().catch(() => {});
  const keep = () => { if (screen === 'scan' && document.activeElement !== inp && !['SELECT', 'INPUT'].includes((document.activeElement || {}).tagName)) inp.focus(); };
  setTimeout(keep, 50); const t = setInterval(() => (screen === 'scan' ? keep() : clearInterval(t)), 800);
}
async function redeem(code, out) {
  try {
    const r = await api.post('/photobooth/redeem', { code });
    S = { ...r, layout: (cfg.layouts || [])[0] || 'strip4', photos: [], filter: cfg.filter || 'original', tone: { brightness: 0, contrast: 10, exposure: 0, gamma: 1, sharpness: 0.4 }, method: cfg.dither || 'floyd', strength: 1, consent: false };
    if (out) {
      out.replaceChildren(h('div', { class: 'result ok' }, h('div', {}, tx('✅ ใบเสร็จถูกต้อง · บิล {0}', r.bill_no || '')), h('div', { class: 'amt' }, baht(r.amount), ' ฿'),
        h('div', { class: 'muted' }, tx('ถึงเกณฑ์ {0} บาท — ถ่ายรูปได้เลย!', baht(r.min)))));
      await sleep(1600);
    }
    layoutScreen();
  } catch (e) {
    if (!out) return errToast(e);
    const body = await Promise.resolve(e.body || {});
    out.replaceChildren(h('div', { class: 'result bad' }, h('div', {}, e.code === 'below_min' ? tx('❌ ยอดยังไม่ถึงเกณฑ์') : '❌ ' + e.message),
      e.code === 'below_min' && body.amount !== undefined ? h('div', { class: 'amt' }, baht(body.amount), ' ฿') : null,
      e.code === 'below_min' ? h('div', { class: 'muted' }, tx('ต้องซื้อครบ {0} บาท', baht(body.min || cfg.min_spend))) : null));
  }
}

// --- 2. layout ---
function layoutScreen() {
  redraw = layoutScreen; stopCamera();
  const allowed = (cfg.layouts || Object.keys(LAYOUTS)).filter((k) => LAYOUTS[k]);
  const grid = h('div', { class: 'layouts' }, allowed.map((k) => {
    const L = LAYOUTS[k], cv = h('canvas');
    const W = 60, pad = 5, gap = 3, cw = (W - pad * 2 - gap * (L.cols - 1)) / L.cols, ch = cw * L.ar, rows = Math.ceil(L.n / L.cols);
    cv.width = W; cv.height = Math.round(pad * 2 + 10 + rows * ch + (rows - 1) * gap + 8);
    const x = cv.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, cv.width, cv.height); x.fillStyle = '#222';
    for (let i = 0; i < L.n; i++) x.fillRect(pad + (i % L.cols) * (cw + gap), pad + 8 + Math.floor(i / L.cols) * (ch + gap), cw, ch);
    return h('button', { class: 'lay' + (S.layout === k ? ' on' : ''), onclick: () => { S.layout = k; S.photos = []; cameraScreen(); } }, cv, h('b', {}, L.name()), h('small', {}, tx('{0} รูป', L.n)));
  }));
  go('layout', topBar(), h('div', { class: 'center' }, h('h2', {}, tx('เลือกแบบรูป')), grid), h('div', { class: 'row' }, h('button', { class: 'btn', onclick: welcome }, tx('ยกเลิก'))));
}

// --- 3. camera ---
function stopCamera() { if (stream) stream.getTracks().forEach((t) => t.stop()); stream = null; }
async function openCamera(video) {
  stopCamera();
  const dev = store.get('photo_cam', '');
  const want = { width: { ideal: 1920 }, height: { ideal: 1440 }, ...(dev ? { deviceId: { exact: dev } } : { facingMode: 'user' }) };
  try { stream = await navigator.mediaDevices.getUserMedia({ video: want, audio: false }); }
  catch { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); }
  video.srcObject = stream; await video.play().catch(() => {});
}
function cameraScreen() {
  redraw = cameraScreen;
  const L = LAYOUTS[S.layout];
  let mirror = store.get('photo_mirror', cfg.mirror !== false), cd = store.get('photo_countdown', cfg.countdown || 3), running = false;
  const video = h('video', { playsinline: true, muted: true, autoplay: true, class: mirror ? 'mirror' : '' });
  const count = h('div', { class: 'count' });
  const thumbs = h('div', { class: 'shots' });
  const camState = h('span', { class: 'pill' }, h('i'), tx('กำลังเปิดกล้อง…'));
  const drawThumbs = () => thumbs.replaceChildren(...Array.from({ length: L.n }, (_, i) => {
    const p = S.photos[i];
    return h('div', { class: 's' + (p ? ' done' : ''), style: p ? { backgroundImage: `url(${p.toDataURL('image/jpeg', 0.5)})` } : {}, title: tx('แตะเพื่อถ่ายรูปนี้ใหม่'),
      onclick: () => { if (!running && p) shoot([i]); } }, h('b', {}, String(i + 1)));
  }));
  const capture = () => {
    const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
    const x = c.getContext('2d'); if (mirror) { x.translate(c.width, 0); x.scale(-1, 1); }
    x.drawImage(video, 0, 0); return c;
  };
  const shoot = async (which) => {
    if (running || !video.videoWidth) return;
    running = true; startBtn.disabled = true;
    for (let k = 0; k < which.length; k++) {
      for (let n = cd; n > 0; n--) { count.replaceChildren(h('span', {}, String(n))); await sleep(1000); }
      count.replaceChildren();
      shutterSound(); document.body.append(h('div', { class: 'flash', onanimationend: (e) => e.target.remove() }));
      S.photos[which[k]] = capture(); drawThumbs();
      if (k < which.length - 1) await sleep(Math.max(0, (cfg.gap ?? 2) * 1000));
    }
    running = false; startBtn.disabled = false;
    // auto print: straight to the printer with the shop's look, nothing to choose; otherwise the filter screen
    if (S.photos.filter(Boolean).length >= L.n) { await sleep(500); if (cfg.auto_print !== false) printNow(); else editScreen(); }
  };
  const startBtn = h('button', { class: 'btn acc big', onclick: () => shoot(Array.from({ length: L.n }, (_, i) => i).filter((i) => !S.photos[i])) }, tx('📸 เริ่มถ่าย'));
  const cdChips = h('div', { class: 'chips' }, [3, 5, 10].map((n) => h('button', { class: 'chip' + (cd === n ? ' on' : ''), onclick: (e) => { cd = n; store.set('photo_countdown', n); [...e.target.parentNode.children].forEach((b) => b.classList.toggle('on', b === e.target)); } }, `⏱ ${n}s`)));
  const mirBtn = h('button', { class: 'chip' + (mirror ? ' on' : ''), onclick: () => { mirror = !mirror; store.set('photo_mirror', mirror); video.classList.toggle('mirror', mirror); mirBtn.classList.toggle('on', mirror); } }, tx('🪞 กลับด้าน'));
  const camSel = h('select', { class: 'chip', onchange: async () => { store.set('photo_cam', camSel.value); await openCamera(video).catch(errToast); } });
  const consent = cfg.store_photos && cfg.auto_print !== false ? h('label', { class: 'consent', style: { justifyContent: 'center' } }, h('input', { type: 'checkbox', checked: S.consent, onchange: (e) => { S.consent = e.target.checked; } }),
    h('span', {}, cfg.consent_text || tx('ยินยอมให้ร้านเก็บรูปนี้ไว้ {0} ชั่วโมง เพื่อให้ดาวน์โหลดผ่าน QR แล้วลบอัตโนมัติ (ไม่ติ๊ก = พิมพ์อย่างเดียว ไม่เก็บรูป)', cfg.link_hours || 24))) : null;
  go('camera', topBar(camState),
    h('div', { class: 'cam' }, video, count),
    h('div', { style: { display: 'grid', gap: '10px' } }, thumbs, consent, h('div', { class: 'row' }, cdChips, mirBtn, camSel), h('div', { class: 'row' }, startBtn, h('button', { class: 'btn', onclick: layoutScreen }, tx('← เปลี่ยนแบบ')))));
  drawThumbs();
  openCamera(video).then(async () => {
    camState.className = 'pill ok'; camState.replaceChildren(h('i'), tx('กล้องพร้อม'));
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    const cur = stream && stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings().deviceId;
    camSel.replaceChildren(...cams.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === cur }, '📷 ' + (d.label || tx('กล้อง {0}', i + 1)))));
    camSel.style.display = cams.length > 1 ? '' : 'none';
  }).catch((e) => { camState.className = 'pill bad'; camState.replaceChildren(h('i'), tx('เปิดกล้องไม่ได้')); toast(tx('เปิดกล้องไม่ได้ — อนุญาตการใช้กล้องในเบราว์เซอร์') + ' (' + e.name + ')', 'error', 6000); });
}

// --- 4. edit ---
function editScreen() {
  redraw = editScreen; stopCamera();
  const color = h('canvas'), therm = h('canvas', { class: 'thermal' });
  const W = (cfg.printer && cfg.printer.dots) || 384;
  let pending = 0;
  const render = async () => {
    const my = ++pending; await sleep(60); if (my !== pending) return;
    const [a, b] = [await compose(560), await compose(W, { thermal: true })];
    if (my !== pending) return;
    color.width = a.width; color.height = a.height; color.getContext('2d').drawImage(a, 0, 0);
    therm.width = b.width; therm.height = b.height; therm.getContext('2d').drawImage(b, 0, 0);
  };
  const chips = (list, names, get, set) => h('div', { class: 'chips' }, list.map((k) => h('button', { class: 'chip' + (get() === k ? ' on' : ''), onclick: (e) => { set(k); [...e.target.parentNode.children].forEach((x) => x.classList.toggle('on', x === e.target)); render(); } }, names[k] || k)));
  const slider = (label, key, min, max, step, obj = S.tone) => {
    const out = h('span', {}, String(obj[key]));
    const i = h('input', { type: 'range', min, max, step, value: obj[key], oninput: () => { obj[key] = Number(i.value); out.textContent = i.value; render(); } });
    return h('label', { class: 'sl' }, label, i, out);
  };
  const strengthObj = { s: S.strength };
  const consentBox = cfg.store_photos ? h('label', { class: 'consent' }, h('input', { type: 'checkbox', checked: S.consent, onchange: (e) => { S.consent = e.target.checked; render(); } }),
    h('span', {}, cfg.consent_text || tx('ยินยอมให้ร้านเก็บรูปนี้ไว้ {0} ชั่วโมง เพื่อให้ดาวน์โหลดผ่าน QR แล้วลบอัตโนมัติ (ไม่ติ๊ก = พิมพ์อย่างเดียว ไม่เก็บรูป)', cfg.link_hours || 24))) : null;
  go('edit', topBar(printerPill()),
    h('div', { class: 'edit' },
      h('div', { class: 'preview' }, h('figure', {}, color, h('figcaption', {}, tx('รูปสี (ดาวน์โหลด)'))), h('figure', {}, therm, h('figcaption', {}, tx('ตัวอย่างที่จะพิมพ์ ({0} จุด)', W)))),
      h('div', { class: 'panel' },
        h('b', {}, tx('ฟิลเตอร์')), chips(FILTERS, FILTER_NAME(), () => S.filter, (k) => { S.filter = k; }),
        h('b', {}, tx('ปรับภาพ')), slider(tx('ความสว่าง'), 'brightness', -50, 50, 1), slider(tx('คอนทราสต์'), 'contrast', -50, 60, 1), slider(tx('แสง'), 'exposure', -1, 1, 0.1),
        slider('Gamma', 'gamma', 0.5, 2, 0.05), slider(tx('ความคม'), 'sharpness', 0, 2, 0.1),
        h('b', {}, tx('แปลงเป็นขาวดำสำหรับเครื่องพิมพ์')), chips(DITHERS, DITHER_NAME(), () => S.method, (k) => { S.method = k; }),
        h('label', { class: 'sl' }, tx('ความเข้มลายจุด'), h('input', { type: 'range', min: 0, max: 1.2, step: 0.05, value: S.strength, oninput: (e) => { S.strength = Number(e.target.value); strengthObj.s = S.strength; render(); } }), h('span')),
        consentBox,
        h('div', { class: 'row', style: { justifyContent: 'stretch' } }, h('button', { class: 'btn', onclick: () => { S.photos = []; cameraScreen(); } }, tx('↺ ถ่ายใหม่')),
          h('button', { class: 'btn acc', style: { flex: 1 }, onclick: () => printNow() }, cfg.printer ? tx('🖨 พิมพ์รูป') : tx('ดูตัวอย่าง (DEMO)'))))),
    h('div'));
  render();
}

// --- 5. print ---
async function printNow() {
  redraw = () => {};
  const W = (cfg.printer && cfg.printer.dots) || 384;
  const status = h('div', { class: 'status' }, tx('รอสักครู่ กำลังพิมพ์รูปให้นะคะ…'));
  const bar = h('div', { class: 'bar' }, h('i'));
  const prev = h('canvas', { class: 'thermal', style: { width: 'min(230px, 40vw)', boxShadow: '0 16px 34px rgb(0 0 0 / .14)', imageRendering: 'pixelated' } });
  go('print', topBar(printerPill()), h('div', { class: 'center' }, h('h2', {}, tx('🖨 รอสักครู่ กำลังพิมพ์')), prev, status, bar, h('div', { class: 'muted' }, tx('รับรูปที่เครื่องพิมพ์ได้เลย'))), h('div'));
  try {
    const pc = await compose(W, { thermal: true });
    prev.width = pc.width; prev.height = pc.height; prev.getContext('2d').drawImage(pc, 0, 0);
    const colorImg = S.consent ? (await compose(900)).toDataURL('image/jpeg', 0.9) : null;
    const r = await api.post(`/photobooth/sessions/${S.session_id}/finish`, { print_image: pc.toDataURL('image/png'), color_image: colorImg, consent: S.consent, layout: S.layout, shots: S.photos.length, height_dots: pc.height, print: !!cfg.printer });
    S.download_url = r.download_url;
    if (!cfg.printer || !r.jobs.length) {
      status.textContent = tx('DEMO — ยังไม่ได้ตั้งเครื่องพิมพ์ จึงยังไม่ได้พิมพ์จริง'); bar.remove();
      return setTimeout(doneScreen, 2500);
    }
    // what the printer says: "sent" when the printer cannot confirm paper came out, "printed" only when it did
    const T = { queued: tx('รอคิวเครื่องพิมพ์…'), claimed: tx('กำลังพิมพ์…'), sent: tx('ส่งไปเครื่องพิมพ์แล้ว ✓'), printed: tx('พิมพ์เสร็จแล้ว ✓'), failed: tx('พิมพ์ไม่สำเร็จ'), unknown: tx('ไม่ทราบผลการพิมพ์ — แจ้งพนักงาน') };
    for (let i = 0; i < 60; i++) {
      const s = await api.get(`/photobooth/sessions/${S.session_id}`).catch(() => null);
      const j = s && s.jobs[s.jobs.length - 1];
      if (j) status.textContent = (T[j.status] || j.status) + (j.error ? ` (${j.error})` : '');
      if (j && ['sent', 'printed'].includes(j.status)) { bar.remove(); await sleep(1500); return doneScreen(); }
      if (j && ['failed', 'unknown'].includes(j.status)) { bar.remove(); status.style.color = 'var(--bad)'; await sleep(4000); return doneScreen(true); }
      if (i === 12 && j && j.status === 'queued') status.textContent = tx('เครื่องพิมพ์ยังไม่รับงาน — ตรวจว่าเครื่องพิมพ์เปิดอยู่และเชื่อมกับเครื่องที่เปิดหน้าร้านไว้');
      await sleep(1500);
    }
    doneScreen(true);
  } catch (e) { errToast(e); status.textContent = '❌ ' + e.message; bar.remove(); setTimeout(() => doneScreen(true), 4000); }
}

// --- 6. thank you ---
async function doneScreen(problem = false) {
  redraw = () => doneScreen(problem);
  const qr = S && S.consent && S.download_url ? h('canvas', { class: 'qrdl' }) : null;
  if (qr) { const m = await qrMatrix(S.download_url); if (m) { const k = 6, n = m.size + 2; qr.width = qr.height = n * k; const x = qr.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, n * k, n * k); x.fillStyle = '#000'; for (let r = 0; r < m.size; r++) for (let c = 0; c < m.size; c++) if (m.data[r * m.size + c]) x.fillRect((c + 1) * k, (r + 1) * k, k, k); } }
  const left = h('span');
  go('done', topBar(), h('div', { class: 'center' }, h('h1', {}, problem ? tx('ขอบคุณค่ะ') : tx('ขอบคุณที่ยิ้มให้เรา! 💕')),
    problem ? h('div', { class: 'sub', style: { color: 'var(--bad)' } }, tx('ถ้ารูปไม่ออก กรุณาแจ้งพนักงาน เลขรูป #{0}', (S && S.number) || '')) : h('div', { class: 'sub' }, tx('รับรูปที่เครื่องพิมพ์ได้เลย')),
    qr, qr ? h('div', { class: 'muted' }, tx('สแกนเพื่อดาวน์โหลดรูปสี · ลิงก์หมดอายุใน {0} ชั่วโมง', cfg.link_hours || 24)) : null,
    h('button', { class: 'btn pri', onclick: welcome }, tx('เสร็จแล้ว')), h('div', { class: 'muted small' }, left)), h('div'));
  let n = Math.max(15, Math.min(120, cfg.idle_seconds || 60));
  const t = setInterval(() => { if (screen !== 'done') return clearInterval(t); left.textContent = tx('กลับหน้าแรกใน {0} วินาที', n); if (--n < 0) { clearInterval(t); welcome(); } }, 1000);
}

// ---------------- kiosk ----------------
function fullscreen() { const d = document.documentElement; (d.requestFullscreen || d.webkitRequestFullscreen || (() => {})).call(d); }
['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { lastTouch = Date.now(); }, true));
setInterval(() => {
  if (!cfg) return;
  const idle = (Date.now() - lastTouch) / 1000, lim = cfg.idle_seconds || 60;
  // back to the start when nobody is using the booth (longer while choosing filters)
  if ((['scan', 'layout'].includes(screen) && idle > lim) || (['camera', 'edit'].includes(screen) && idle > lim * 3)) welcome();
}, 5000);

// booth settings: printers linked to this machine (it prints the shop's photo jobs), camera, unpair
async function settingsSheet() {
  const P = await import('/shared/printers.js');
  const box = h('div');
  const close = () => sheet.remove();
  const draw = async () => {
    const printers = (await api.get('/printers').catch(() => [])).filter((p) => p.active);
    box.replaceChildren(h('h3', { style: { margin: 0 } }, tx('⚙️ ตั้งค่าเครื่องตู้ถ่ายรูป')),
      h('div', { class: 'muted small' }, tx('เครื่องพิมพ์ที่ใช้พิมพ์รูป: {0} (เลือกได้ที่ จัดการร้าน → ตู้ถ่ายรูป)', cfg.printer ? cfg.printer.name : '—')),
      ...printers.map((p) => h('div', { class: 'p' }, h('div', {}, h('b', {}, p.name), h('div', { class: 'small muted' }, `${p.paper}mm · ${p.conn}${P.isLinkedHere(p.id) ? ' · ✓ ' + tx('เชื่อมกับเครื่องนี้') : ''}`)),
        P.isLinkedHere(p.id)
          ? h('div', { class: 'row' }, h('button', { class: 'btn', onclick: async () => { try { await P.testPrint(p); toast(tx('ส่งพิมพ์ทดสอบแล้ว'), 'ok'); } catch (e) { errToast(e); } } }, tx('ทดสอบ')), h('button', { class: 'btn', onclick: () => { P.unpairPrinter(p.id); draw(); } }, tx('เลิกเชื่อม')))
          : h('button', { class: 'btn pri', onclick: async () => { try { await P.pairPrinter(p); toast(tx('เชื่อมแล้ว'), 'ok'); host = null; startPrinting(); draw(); } catch (e) { errToast(e); } } }, tx('เชื่อมกับเครื่องนี้')))),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: fullscreen }, '⛶ Fullscreen'),
        h('button', { class: 'btn', onclick: () => { if (confirm(tx('ยกเลิกการจับคู่ตู้นี้?'))) { store.del('photo_token'); location.replace('/photo/'); } } }, tx('ออกจากการจับคู่')),
        h('button', { class: 'btn pri', onclick: close }, tx('ปิด'))));
  };
  const sheet = h('div', { class: 'sheet', onclick: (e) => { if (e.target === sheet) close(); } }, h('div', {}, box));
  document.body.append(sheet); draw();
}
async function startPrinting() {
  if (host) return;
  const P = await import('/shared/printers.js');
  const printers = await api.get('/printers').catch(() => []);
  if (!printers.some((p) => p.active && P.isLinkedHere(p.id))) return;
  host = new P.PrintHost({ api, sock, terminalId: 'photobooth', settings: { sound: { enabled: false, docs: 'none', on: 'printed' } }, device: 'display', onChange: () => {} });
  await host.start();
}

// ---------------- pairing / download ----------------
function pairing(msg = '') {
  let code = '';
  const show = h('div', { class: 'code' }, '');
  const pair = async () => {
    try { const r = await api.post('/display/pair', { code, touch: true }, { token: null }); store.set('photo_token', r.token); location.replace('/photo/'); }
    catch (e) { errToast(e); code = ''; show.textContent = ''; }
  };
  const key = (k) => { if (k === '⌫') code = code.slice(0, -1); else if (code.length < 6) code += k; show.textContent = code; if (code.length === 6) pair(); };
  app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('h2', {}, '📸 ' + tx('จับคู่ตู้ถ่ายรูป')),
    h('div', { class: 'sub' }, tx('ที่ จัดการร้าน → ตู้ถ่ายรูป กด "สร้างรหัสจับคู่" แล้วกรอกรหัส 6 หลัก')), msg ? h('div', { style: { color: 'var(--bad)' } }, msg) : null, show,
    h('div', { class: 'keypad' }, ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'].map((k) => (k ? h('button', { onclick: () => key(k) }, k) : h('span'))))), h('div')));
}
async function downloadPage(tok) {
  app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('div', { class: 'bar' }, h('i'))), h('div')));
  try {
    const r = await fetch('/api/public/photo/' + encodeURIComponent(tok)).then(async (x) => { const j = await x.json(); if (!x.ok) throw new Error(j.error || x.status); return j; });
    const img = h('img', { src: r.url, alt: 'photo' });
    const asFile = async (type) => {
      const im = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = r.url; });
      const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0);
      c.toBlob((b) => { const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `photo-${Date.now()}.${type === 'image/png' ? 'png' : 'jpg'}`; a.click(); }, type, 0.92);
    };
    app.replaceChildren(h('div', { class: 'screen' }, h('div', { class: 'top' }, h('div', { class: 'brand' }, h('b', {}, r.store || 'PHOTO BOOTH')), langPicker(h, () => downloadPage(tok), { maxWidth: '120px' })),
      h('div', { class: 'center dl' }, img, h('div', { class: 'row' }, h('button', { class: 'btn acc', onclick: () => asFile('image/png') }, tx('⬇ ดาวน์โหลด PNG')), h('button', { class: 'btn', onclick: () => asFile('image/jpeg') }, tx('⬇ ดาวน์โหลด JPG'))),
        h('div', { class: 'muted small' }, tx('ลิงก์นี้ใช้ได้ถึง {0} แล้วรูปจะถูกลบอัตโนมัติ', new Date(r.expires_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })))), h('div')));
  } catch (e) {
    app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('h2', {}, tx('ลิงก์รูปหมดอายุหรือไม่ถูกต้อง')), h('div', { class: 'sub' }, e.message)), h('div')));
  }
}

async function boot() {
  await initLang();
  const hash = new URLSearchParams(location.hash.slice(1));
  if (hash.get('d')) return downloadPage(hash.get('d'));
  // a customer scanning the receipt QR with their own phone lands here: tell them to use the booth
  if (hash.get('r') && !store.get('photo_token')) {
    return app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('h1', {}, '📸'), h('h2', {}, tx('สแกน QR นี้ที่ตู้ถ่ายรูปในร้าน')), h('div', { class: 'sub' }, tx('ใบเสร็จนี้แลกถ่ายรูปฟรีได้ที่ตู้ถ่ายรูปของร้าน'))), h('div')));
  }
  if (qs.get('code') && !store.get('photo_token')) {
    try { const r = await api.post('/display/pair', { code: qs.get('code'), touch: true }, { token: null }); store.set('photo_token', r.token); history.replaceState(null, '', '/photo/'); }
    catch (e) { return pairing(e.message); }
  }
  if (!store.get('photo_token')) return pairing();
  try { cfg = await api.get('/photobooth/config'); }
  catch (e) { if (e.status === 401 || e.status === 403) { store.del('photo_token'); return pairing(tx('ตู้นี้ถูกยกเลิกการจับคู่แล้ว')); } throw e; }
  const root = document.documentElement.style;
  // the shop's fonts: page and printed strip (Google or uploaded; Thai falls back to Sarabun)
  try { const { loadFont } = await import('/shared/fonts.js'); await Promise.all([loadFont(UIF(), [400, 700]), loadFont(STRIPF(), [400, 700])]);
    // a canvas never asks for a font itself: load every weight the strip draws with before the first photo
    await Promise.race([Promise.all(['400', '700', '800'].map((w) => document.fonts.load(`${w} 40px "${STRIPF()}"`, 'กขค Aa 123'))), sleep(4000)]); } catch { /* built-in look */ }
  document.body.style.fontFamily = `"${UIF()}", Prompt, Sarabun, sans-serif`;
  if (cfg.accent) root.setProperty('--accent', cfg.accent);
  if (cfg.bg) root.setProperty('--bg', cfg.bg);
  if (cfg.background) root.setProperty('--bgimg', `url(${cfg.background})`);
  if (!cfg.enabled) return app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('h2', {}, tx('ตู้ถ่ายรูปปิดอยู่')), h('div', { class: 'sub' }, tx('เปิดได้ที่ จัดการร้าน → ตู้ถ่ายรูป'))), h('div')));
  sock = await socket({ kind: 'display', token: store.get('photo_token') }).catch(() => null);
  if (sock) sock.on('settings:changed', async () => { const c = await api.get('/photobooth/config').catch(() => null); if (c) { cfg = c; if (screen === 'welcome') welcome(); } });
  startPrinting().catch((e) => console.warn('[booth print]', e.message));
  welcome();
}
boot().catch((e) => app.replaceChildren(h('div', { class: 'screen' }, h('div'), h('div', { class: 'center' }, h('h2', {}, '⚠️'), h('div', {}, e.message)), h('div'))));
