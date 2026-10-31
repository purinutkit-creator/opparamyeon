import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { openDb, db } from './db.js';
import { setIO, HttpError, getSettings, now } from './lib/util.js';
import { loadStaff, readSession, can } from './lib/auth.js';
import { seed } from './seed.js';
import { expireUnpaid } from './lib/orders.js';
import { expirePoints } from './lib/members.js';
import staff from './routes/staff.js';
import catalogR from './routes/catalog.js';
import orders from './routes/orders.js';
import system, { serveFile, qrSvg } from './routes/system.js';
import display, { displayFromToken, closePrompts } from './routes/display.js';
import mobile from './routes/mobile.js';
import payments, { webhookRouter } from './routes/payments.js';
import lineR, { lineWebhook } from './routes/line.js';
import members from './routes/members.js';
import customer, { expireCoupons } from './routes/customer.js';
import reports from './routes/reports.js';
import importer from './routes/importer.js';
import { VERSION } from '../public/shared/core.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, '..', 'public');

export async function createApp(opts = {}) {
  await openDb(opts.db || {});
  await seed(opts.seed || {});
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  // webhooks need the raw body for signature checks
  app.use('/api', webhookRouter);
  app.use('/api', lineWebhook);
  app.use(express.json({ limit: '8mb' }));
  app.get('/healthz', async (req, res) => { await db.get('SELECT 1 AS ok'); res.json({ ok: true, version: VERSION, db: db.kind, time: now() }); });
  // persistent = data survives restarts/updates. On Render without DATABASE_URL the SQLite file lives on a temporary disk.
  const persistent = db.kind === 'pg' || !process.env.RENDER || !!process.env.SQLITE_ON_DISK;
  app.get('/api/version', (req, res) => res.json({ version: VERSION, db: db.kind, persistent }));
  // Android app (Play Store / TWA): proves this site and the app belong together so the app opens without a browser bar.
  // Set ANDROID_PACKAGE (e.g. com.oppa.pos) and ANDROID_SHA256 (fingerprint from PWABuilder / Play Console; several separated by commas).
  app.get('/.well-known/assetlinks.json', (req, res) => {
    const pkg = process.env.ANDROID_PACKAGE, fps = String(process.env.ANDROID_SHA256 || '').split(',').map((x) => x.trim()).filter(Boolean);
    res.json(pkg && fps.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: pkg, sha256_cert_fingerprints: fps } }] : []);
  });
  app.get('/files/:id', (req, res, next) => serveFile(req, res).catch(next));
  app.get('/api/qr.svg', (req, res, next) => qrSvg(req, res).catch(next));
  for (const r of [staff, catalogR, orders, system, display, mobile, payments, members, customer, reports, importer, lineR]) app.use('/api', r);
  app.use('/api', (req, res) => res.status(404).json({ error: 'ไม่พบ API นี้' }));
  // face check for the clock-in selfie (MediaPipe, served from this app so it needs no outside CDN)
  app.use('/vendor/mediapipe', express.static(path.join(__dirname, '..', 'node_modules', '@mediapipe', 'tasks-vision'), { maxAge: '30d' }));
  app.use(express.static(PUBLIC, { extensions: ['html'], setHeaders: (res, p) => { if (/\.(html|js|css|webmanifest)$/.test(p)) res.setHeader('Cache-Control', 'no-cache'); } }));
  app.get('/', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
  // errors → JSON with Thai message
  app.use((err, req, res, next) => {
    const status = err instanceof HttpError ? err.status : err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE' ? 413 : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' : status === 413 ? 'ไฟล์หรือข้อมูลใหญ่เกินกำหนด' : err.message, code: err.code });
  });

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: false }, pingInterval: 20000, pingTimeout: 20000 });
  setIO(io);
  const lastCart = new Map(); // terminal → latest customer-display state (sent again when a display reconnects)
  // Live View: what each POS is keying in right now, for staff who can see sales (never sent to customer displays)
  const live = new Map();
  const names = new Map();
  const termName = async (tid) => {
    if (!names.has(tid)) { const t = await db.get('SELECT name FROM terminals WHERE id = ?', [tid]).catch(() => null); names.set(tid, t ? t.name : tid); }
    return names.get(tid);
  };
  const pushLive = (rec) => {
    const old = live.get(rec.terminal_id);
    if (old && rec.online && old.state && rec.state && Number(old.state.at) > Number(rec.state.at)) return; // an older update arriving late
    live.set(rec.terminal_id, rec); io.to('live').emit('live:update', rec);
  };
  // authenticate staff during the handshake so their event handlers exist before the client sees 'connect'
  // (otherwise the first POS updates can arrive before the handlers are attached and be lost)
  io.use((sock, next) => {
    const a = sock.handshake.auth || {};
    if (a.kind !== 'staff') return next();
    loadStaff(a.token).then((st) => { sock.data.staff = st || null; next(); }, () => { sock.data.staff = null; next(); });
  });
  io.on('connection', async (sock) => {
    try {
      const a = sock.handshake.auth || {};
      if (a.kind === 'staff') {
        const st = sock.data.staff;
        if (!st) return sock.disconnect(true);
        sock.data.staff = st;
        const term = a.terminal_id || st.terminal_id;
        sock.join('shop');
        if (can(st, 'kitchen')) sock.join('kitchen');
        if (can(st, 'view_sales') || can(st, 'manage_members') || can(st, 'settings')) sock.join('admin');
        if (can(st, 'view_sales')) {
          sock.join('live');
          sock.on('live:snapshot', (ack) => { if (typeof ack === 'function') ack([...live.values()]); });
        }
        if (term) { sock.join('terminal:' + term); sock.data.terminal = term; }
        sock.on('print:watch', (ids) => { for (const pid of [].concat(ids || []).slice(0, 20)) sock.join('print:' + pid); });
        // POS → its paired customer displays (also used by the Dual Screen window)
        sock.on('display:state', async (state) => {
          if (!sock.data.terminal || !state || typeof state !== 'object') return;
          sock.data.livePos = true;
          const { live: detail, ...pub } = state; // staff-only details stay off the customer display
          lastCart.set(sock.data.terminal, pub);
          io.to('display:' + sock.data.terminal).emit('display:state', pub);
          pushLive({ terminal_id: sock.data.terminal, terminal_name: await termName(sock.data.terminal), staff_name: st.name, online: true, state: pub, detail: detail || {}, updated_at: now() });
          if (state && state.cart_id && state.phase === 'idle') closePrompts(sock.data.terminal, 'cancelled').catch(() => {});
        });
        sock.on('display:cart_changed', ({ cart_id } = {}) => {
          // new bill → any member entry screen of the previous bill closes and clears
          if (sock.data.terminal) db.get("SELECT id, cart_id FROM member_prompts WHERE terminal_id = ? AND status = 'open'", [sock.data.terminal])
            .then((p) => { if (p && p.cart_id !== cart_id) return closePrompts(sock.data.terminal, 'cancelled'); }).catch(() => {});
        });
        sock.on('disconnect', () => {
          const tid = sock.data.terminal, rec = tid && live.get(tid);
          if (!rec || rec.staff_name !== st.name) return;
          // another tab of the same terminal may still be open
          const still = [...(io.sockets.adapter.rooms.get('terminal:' + tid) || [])].some((sid) => { const o = io.sockets.sockets.get(sid); return o && o !== sock && o.data.livePos; });
          if (!still) pushLive({ ...rec, online: false, updated_at: now() });
        });
      } else if (a.kind === 'display') {
        const p = await displayFromToken(a.token);
        if (!p) { sock.emit('display:revoked', {}); return sock.disconnect(true); }
        sock.join('display:' + p.terminal_id); sock.join('display'); sock.join('displaytoken:' + p.id);
        const st = lastCart.get(p.terminal_id);
        if (st) sock.emit('display:state', st);
        const open = await db.get("SELECT * FROM member_prompts WHERE terminal_id = ? AND status = 'open' AND expires_at > ?", [p.terminal_id, now()]);
        if (open) sock.emit('member:prompt', { id: open.id, cart_id: open.cart_id, expires_at: open.expires_at, mode: 'touch' });
      } else if (a.kind === 'mobile') {
        const ms = a.token ? await db.get('SELECT id FROM mobile_sessions WHERE token = ?', [a.token]) : null;
        if (!ms) return sock.disconnect(true);
        sock.join('mobile:' + ms.id); sock.join('mobile');
      } else if (a.kind === 'member') {
        const s = await readSession(a.token, 'member');
        if (!s) return sock.disconnect(true);
        sock.join('member:' + s.subject_id);
      } else sock.disconnect(true);
    } catch (e) { console.error(e); sock.disconnect(true); }
  });

  const timers = [];
  if (!opts.noTimers) {
    timers.push(setInterval(() => expireUnpaid().catch(console.error), 30000));
    timers.push(setInterval(() => expireCoupons().catch(console.error), 60000));
    timers.push(setInterval(() => expirePoints().catch(console.error), 3600000));
    timers.push(setInterval(() => db.run("UPDATE member_prompts SET status = 'expired' WHERE status = 'open' AND expires_at < ?", [now()]).catch(() => {}), 15000));
  }
  return { app, server, io, close: async () => { timers.forEach(clearInterval); io.close(); await new Promise((r) => server.close(r)); await db.close(); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await createApp();
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`Oppa Ramyeon POS v${VERSION} — http://localhost:${port}  (db: ${db.kind})`);
    if (!process.env.DATABASE_URL) console.log('ใช้ SQLite ที่ ' + (process.env.SQLITE_FILE || './data/pos.db') + ' — ตั้ง DATABASE_URL เพื่อใช้ PostgreSQL');
  });
}
