#!/usr/bin/env node
// Oppa Ramyeon Print Agent — runs on the shop PC next to the printers (no dependencies, Node 18+).
// Browsers cannot open raw TCP sockets, so the POS page sends ESC/POS bytes here and the agent forwards them to:
//   - LAN printers (TCP 9100 / RAW)            target { type: 'lan', host, port }
//   - USB printers exposed as a device/share   target { type: 'usb', path }  e.g. /dev/usb/lp0, \\localhost\XP80 (shared printer, RAW)
// Usage: node agent/print-agent.js [--port 9123] [--origin https://opparamyeon.onrender.com]
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]] : null)).filter(Boolean));
const PORT = Number(args.port || process.env.AGENT_PORT || 9123);
const ALLOWED = (args.origin || process.env.AGENT_ORIGINS || '*').split(',');
const VERSION = '1.0.0';
const queues = new Map(); // one job at a time per printer → no interleaving between documents

function serial(key, fn) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next.finally(() => { if (queues.get(key) === next) queues.delete(key); }));
  return next;
}
function sendLan(host, port, data, wantStatus) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port: port || 9100 });
    const chunks = [];
    let done = false;
    const finish = (err, res) => { if (done) return; done = true; sock.destroy(); err ? reject(err) : resolve(res); };
    sock.setTimeout(8000, () => finish(new Error('หมดเวลาเชื่อมต่อเครื่องพิมพ์ ' + host)));
    sock.on('error', (e) => finish(new Error(`เชื่อมต่อ ${host}:${port} ไม่ได้: ${e.code || e.message}`)));
    sock.on('data', (d) => chunks.push(...d));
    sock.on('connect', () => {
      sock.write(data, () => {
        if (!wantStatus) return setTimeout(() => finish(null, { known: false }), 200);
        // DLE EOT 4 (paper) + DLE EOT 2 (offline cause): printers that support it answer one byte each
        sock.write(Buffer.from([0x10, 0x04, 0x04, 0x10, 0x04, 0x02]));
        setTimeout(() => {
          if (chunks.length < 2) return finish(null, { known: false });
          const paper = chunks[chunks.length - 2], off = chunks[chunks.length - 1];
          finish(null, { known: true, paperOut: (paper & 0x60) === 0x60, coverOpen: !!(off & 0x04), error: !!(off & 0x40) || !!(off & 0x20) });
        }, 1200);
      });
    });
  });
}
function sendPath(path, data) {
  return new Promise((resolve, reject) => fs.writeFile(path, data, (e) => (e ? reject(new Error('เขียนไปยัง ' + path + ' ไม่ได้: ' + e.message)) : resolve({ known: false }))));
}
function probe(host, port, ms = 350) {
  return new Promise((res) => { const s = net.createConnection({ host, port }); const t = setTimeout(() => { s.destroy(); res(false); }, ms); s.on('connect', () => { clearTimeout(t); s.destroy(); res(true); }); s.on('error', () => { clearTimeout(t); res(false); }); });
}
async function scan(subnet, port = 9100) {
  const bases = subnet ? [subnet] : Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address.split('.').slice(0, 3).join('.'));
  const found = [];
  for (const b of [...new Set(bases)]) {
    const hosts = Array.from({ length: 254 }, (_, i) => `${b}.${i + 1}`);
    for (let i = 0; i < hosts.length; i += 64) {
      const res = await Promise.all(hosts.slice(i, i + 64).map(async (h) => ((await probe(h, port)) ? h : null)));
      found.push(...res.filter(Boolean).map((host) => ({ host, port })));
    }
  }
  return found;
}
function usbList() {
  const out = [];
  for (const dir of ['/dev/usb', '/dev']) {
    try { for (const f of fs.readdirSync(dir)) if (/^lp\d+$/.test(f) || /^usb\/lp/.test(f)) out.push(`${dir}/${f}`); } catch { /* none */ }
  }
  if (process.platform === 'win32') out.push('\\\\localhost\\<ชื่อแชร์เครื่องพิมพ์> (แชร์เครื่องพิมพ์ใน Windows แล้วใช้ชื่อแชร์)');
  return [...new Set(out)];
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const okOrigin = ALLOWED.includes('*') || ALLOWED.includes(origin);
  res.setHeader('Access-Control-Allow-Origin', okOrigin ? origin || '*' : 'null');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Private-Network', 'true'); // Chrome Private Network Access (https page → localhost)
  if (req.method === 'OPTIONS') return res.end();
  if (!okOrigin) { res.statusCode = 403; return res.end('{"error":"origin not allowed"}'); }
  const send = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(obj)); };
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/status') return send(200, { ok: true, version: VERSION, host: os.hostname(), platform: process.platform });
    if (url.pathname === '/scan') return send(200, { ok: true, printers: await scan(url.searchParams.get('subnet'), Number(url.searchParams.get('port')) || 9100) });
    if (url.pathname === '/usb') return send(200, { ok: true, devices: usbList() });
    if (url.pathname === '/print' && req.method === 'POST') {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 20e6) throw new Error('ข้อมูลใหญ่เกินไป'); }
      const { target, data, status } = JSON.parse(body);
      const buf = Buffer.from(data, 'base64');
      const key = target.type === 'lan' ? `${target.host}:${target.port || 9100}` : target.path;
      const st = await serial(key, () => (target.type === 'lan' ? sendLan(target.host, Number(target.port) || 9100, buf, status) : sendPath(target.path, buf)));
      console.log(new Date().toISOString(), 'printed', key, buf.length, 'bytes', st.known ? JSON.stringify(st) : '(no status)');
      return send(200, { ok: true, status: st });
    }
    send(404, { error: 'not found' });
  } catch (e) { console.error(e.message); send(500, { ok: false, error: e.message }); }
});
server.listen(PORT, '127.0.0.1', () => console.log(`Oppa Print Agent v${VERSION} ฟังที่ http://127.0.0.1:${PORT}  (origins: ${ALLOWED.join(', ')})`));
