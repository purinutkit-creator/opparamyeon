// Real printer transports + the print host that drains the server's per-printer job queue.
//  - USB:       WebUSB (Chrome desktop / Chrome Android with USB-OTG)
//  - Serial:    Web Serial (Chrome desktop; USB-serial & paired Bluetooth SPP COM ports)
//  - Bluetooth: Web Bluetooth (BLE printers; classic-SPP-only printers need the agent or the Android bridge)
//  - LAN / USB on a PC: local print agent (agent/print-agent.js) on http://127.0.0.1:9123 — browsers cannot open raw TCP
//  - Android native bridge: window.OppaBridge (when the POS runs inside the Android wrapper app)
//  - Browser: system print dialog (A4/regular printers)
import { store } from './api.js';
import { buildJob, buildLabelJob, buildTsplJob, statusQuery, parseStatus, concat, init, feed, cut as cutCmd, beep as beepCmd, drawer as drawerCmd } from './escpos.js';
import { renderDoc, testTemplate } from './render.js';
import { docFontStack } from './fonts.js';
import { playSound } from './sound.js';

const BLE_SERVICES = ['000018f0-0000-1000-8000-00805f9b34fb', 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', '49535343-fe7d-4ae5-8fa9-9fafd205e455', '0000ff00-0000-1000-8000-00805f9b34fb', '0000ffe0-0000-1000-8000-00805f9b34fb'];
export const agentUrl = () => store.get('agent_url', 'http://127.0.0.1:9123');
export const support = () => ({
  usb: !!navigator.usb, serial: !!navigator.serial, bluetooth: !!navigator.bluetooth, bridge: !!window.OppaBridge,
  secure: window.isSecureContext,
});
const links = () => store.get('printer_links', {});
const saveLink = (pid, link) => { const l = links(); if (link) l[pid] = link; else delete l[pid]; store.set('printer_links', l); };
export const linkOf = (pid) => links()[pid] || null;

const open = new Map(); // printerId → transport instance
const toB64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); };

class UsbT {
  constructor(dev) { this.dev = dev; this.kind = 'usb'; }
  static async pick() { const d = await navigator.usb.requestDevice({ filters: [] }); return new UsbT(d); }
  static async restore(link) {
    const ds = await navigator.usb.getDevices();
    const d = ds.find((x) => x.vendorId === link.vendorId && x.productId === link.productId && (!link.serialNumber || x.serialNumber === link.serialNumber));
    return d ? new UsbT(d) : null;
  }
  link() { return { conn: 'usb', vendorId: this.dev.vendorId, productId: this.dev.productId, serialNumber: this.dev.serialNumber, name: this.dev.productName }; }
  async connect() {
    const d = this.dev;
    if (!d.opened) await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    for (const intf of d.configuration.interfaces) for (const alt of intf.alternates) {
      const outEp = alt.endpoints.find((e) => e.direction === 'out' && e.type === 'bulk');
      if (outEp) {
        if (!intf.claimed) await d.claimInterface(intf.interfaceNumber);
        this.out = outEp.endpointNumber;
        const inEp = alt.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
        this.in = inEp ? inEp.endpointNumber : null;
        return;
      }
    }
    throw new Error('ไม่พบช่องส่งข้อมูลของเครื่องพิมพ์ USB นี้');
  }
  async write(bytes) { for (let i = 0; i < bytes.length; i += 16384) { const r = await this.dev.transferOut(this.out, bytes.subarray(i, i + 16384)); if (r.status !== 'ok') throw new Error('USB ส่งข้อมูลไม่สำเร็จ: ' + r.status); } }
  async query(n) {
    if (this.in === null) return undefined;
    await this.write(statusQuery(n));
    const r = await Promise.race([this.dev.transferIn(this.in, 8), new Promise((res) => setTimeout(() => res(null), 1200))]);
    return r && r.data && r.data.byteLength ? r.data.getUint8(0) : undefined;
  }
  get name() { return this.dev.productName || 'USB Printer'; }
}
class SerialT {
  constructor(port) { this.port = port; this.kind = 'serial'; }
  static async pick() { return new SerialT(await navigator.serial.requestPort()); }
  static async restore(link) { const ps = await navigator.serial.getPorts(); const p = ps.find((x) => { const i = x.getInfo(); return i.usbVendorId === link.usbVendorId && i.usbProductId === link.usbProductId; }) || (ps.length === 1 ? ps[0] : null); return p ? new SerialT(p) : null; }
  link() { const i = this.port.getInfo(); return { conn: 'serial', usbVendorId: i.usbVendorId, usbProductId: i.usbProductId, baud: this.baud || 9600 }; }
  async connect(baud = 9600) { this.baud = baud; if (!this.port.writable) await this.port.open({ baudRate: baud }); }
  async write(bytes) { const w = this.port.writable.getWriter(); try { await w.write(bytes); } finally { w.releaseLock(); } }
  async query(n) {
    if (!this.port.readable) return undefined;
    await this.write(statusQuery(n));
    const reader = this.port.readable.getReader();
    try { const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res(null), 1200))]); return r && r.value && r.value.length ? r.value[0] : undefined; }
    finally { try { await reader.cancel(); } catch { /* */ } reader.releaseLock(); }
  }
  get name() { return 'Serial/COM'; }
}
class BleT {
  constructor(dev) { this.dev = dev; this.kind = 'bluetooth'; }
  static async pick() { return new BleT(await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES })); }
  static async restore(link) { if (!navigator.bluetooth.getDevices) return null; const ds = await navigator.bluetooth.getDevices(); const d = ds.find((x) => x.id === link.id); return d ? new BleT(d) : null; }
  link() { return { conn: 'bluetooth', id: this.dev.id, name: this.dev.name }; }
  async connect() {
    const server = this.dev.gatt.connected ? this.dev.gatt : await this.dev.gatt.connect();
    for (const sid of BLE_SERVICES) {
      try {
        const svc = await server.getPrimaryService(sid);
        for (const ch of await svc.getCharacteristics()) if (ch.properties.write || ch.properties.writeWithoutResponse) { this.ch = ch; return; }
      } catch { /* try next */ }
    }
    throw new Error('ไม่พบช่องพิมพ์ Bluetooth (BLE) ของอุปกรณ์นี้ — เครื่องอาจรองรับเฉพาะ Bluetooth แบบ Classic/SPP');
  }
  async write(bytes) {
    const chunk = 180;
    for (let i = 0; i < bytes.length; i += chunk) {
      const part = bytes.subarray(i, i + chunk);
      if (this.ch.properties.writeWithoutResponse) await this.ch.writeValueWithoutResponse(part); else await this.ch.writeValue(part);
    }
  }
  async query() { return undefined; } // most BLE thermal printers do not expose status reads
  get name() { return this.dev.name || 'Bluetooth Printer'; }
}
class AgentT {
  constructor(printer) { this.p = printer; this.kind = 'agent'; }
  link() { return { conn: 'agent' }; }
  async connect() { const r = await fetch(agentUrl() + '/status').catch(() => null); if (!r || !r.ok) throw new Error('เชื่อมต่อโปรแกรม Print Agent ไม่ได้ (' + agentUrl() + ')'); }
  target() { return this.p.conn === 'lan' ? { type: 'lan', host: this.p.address, port: this.p.port || 9100 } : { type: 'usb', path: this.p.address }; }
  async write(bytes, { status = false } = {}) {
    const b64 = toB64(bytes);
    const r = await fetch(agentUrl() + '/print', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: this.target(), data: b64, status }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || 'Print Agent ส่งงานไม่สำเร็จ');
    this.lastStatus = j.status;
    return j;
  }
  async query() { return undefined; }
  get name() { return this.p.conn === 'lan' ? `LAN ${this.p.address}:${this.p.port || 9100}` : 'USB ผ่าน Agent'; }
}
class BridgeT {
  constructor(printer) { this.p = printer; this.kind = 'bridge'; }
  link() { return { conn: 'bridge' }; }
  async connect() { if (!window.OppaBridge) throw new Error('ไม่พบ Android bridge'); }
  async write(bytes) {
    const b64 = toB64(bytes);
    const res = JSON.parse(await window.OppaBridge.print(JSON.stringify({ conn: this.p.conn, address: this.p.address, port: this.p.port, data: b64 })));
    if (!res.ok) throw new Error(res.error || 'พิมพ์ผ่านแอป Android ไม่สำเร็จ');
    this.lastStatus = res.status;
  }
  async query() { return undefined; }
  get name() { return 'Android ' + this.p.conn; }
}

// Pair a printer on this device (needs a user gesture)
export async function pairPrinter(printer) {
  let t;
  if (printer.conn === 'usb') t = await UsbT.pick();
  else if (printer.conn === 'serial') t = await SerialT.pick();
  else if (printer.conn === 'bluetooth') t = window.OppaBridge ? new BridgeT(printer) : await BleT.pick();
  else if (printer.conn === 'lan' || printer.conn === 'agent_usb') t = window.OppaBridge && printer.conn === 'lan' ? new BridgeT(printer) : new AgentT(printer);
  else if (printer.conn === 'browser') { saveLink(printer.id, { conn: 'browser' }); return { name: 'Browser print' }; }
  await t.connect(printer.baud);
  saveLink(printer.id, t.link());
  open.set(printer.id, t);
  return { name: t.name };
}
export function unpairPrinter(pid) { saveLink(pid, null); open.delete(pid); }
async function transportFor(printer) {
  if (open.has(printer.id)) return open.get(printer.id);
  const link = linkOf(printer.id);
  if (!link) return null;
  let t = null;
  if (link.conn === 'usb' && navigator.usb) t = await UsbT.restore(link);
  else if (link.conn === 'serial' && navigator.serial) t = await SerialT.restore(link);
  else if (link.conn === 'bluetooth' && navigator.bluetooth) t = await BleT.restore(link);
  else if (link.conn === 'agent') t = new AgentT(printer);
  else if (link.conn === 'bridge') t = new BridgeT(printer);
  else if (link.conn === 'browser') t = { kind: 'browser', name: 'Browser', connect: async () => {}, query: async () => undefined };
  if (!t) return null;
  await t.connect(link.baud);
  open.set(printer.id, t);
  return t;
}
export const isLinkedHere = (pid) => !!linkOf(pid);

function browserPrint(canvas) {
  return new Promise((res) => {
    const f = document.createElement('iframe');
    f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
    document.body.append(f);
    f.contentDocument.write(`<html><head><style>@page{margin:0}body{margin:0}img{width:100%}</style></head><body><img src="${canvas.toDataURL()}"></body></html>`);
    f.contentDocument.close();
    setTimeout(() => { f.contentWindow.focus(); f.contentWindow.print(); setTimeout(() => { f.remove(); res(); }, 1000); }, 300);
  });
}

// Render + send one document. Returns 'printed' only when the printer itself reported OK after the job.
export async function printDocument(printer, template, data, docType) {
  const t = await transportFor(printer);
  if (!t) throw new Error('เครื่องนี้ยังไม่ได้เชื่อมต่อเครื่องพิมพ์ ' + printer.name);
  let bytes;
  const o = printer.options || {};
  // printer beeper: every document ("มีเสียงทุกครั้งที่พิมพ์"), only kitchen tickets, only receipts, or off
  const mode = o.buzzer_mode || (printer.buzzer ? 'kitchen' : 'off');
  const buzz = mode === 'all' || (mode === 'kitchen' && docType === 'kitchen') || (mode === 'receipt' && docType === 'receipt');
  if (docType === 'cut') bytes = concat([init(), feed(printer.feed_before || 3), cutCmd(printer.cut_mode || 'full')]);
  // feed the roll out (shift close on the merchant roll), and cut when asked and the printer has a cutter
  else if (docType === 'feed') { if (t.kind === 'browser') return { status: 'sent', note: 'เครื่องพิมพ์ผ่านเบราว์เซอร์ป้อนกระดาษไม่ได้' }; bytes = concat([init(), feed(Number(data.lines) || 6), ...(data.cut && (printer.cut_mode || 'full') !== 'none' ? [cutCmd(printer.cut_mode || 'full')] : [])]); }
  else if (docType === 'drawer') { if (t.kind === 'browser') return { status: 'sent', note: 'เครื่องพิมพ์ผ่านเบราว์เซอร์เปิดลิ้นชักไม่ได้' }; bytes = concat([init(), drawerCmd(o.drawer_pin)]); }
  else {
    // force_paper: the document picks its width itself (e.g. the shift summary chosen as 58 or 80 mm)
    const tpl = docType === 'test' ? testTemplate(printer.paper, template && template.font) : { ...template, paper: template && template.force_paper ? template.paper : printer.paper || template.paper };
    if (printer.margin && !tpl.label_exact) tpl.margin = printer.margin;
    if (o.width_dots && !tpl.force_paper) tpl.width_dots = o.width_dots;
    const r = await renderDoc(tpl, data, { scale: o.scale, noLogo: o.print_logo === false, reprintMark: o.reprint_mark, font: docType === 'test' ? null : await docFontStack(docType) });
    if (t.kind === 'browser') { await browserPrint(r.canvas); return { status: 'sent', note: 'ส่งไปยังหน้าต่างพิมพ์ของเบราว์เซอร์' }; }
    // a template set to "ไม่ตัด" prints as a continuous roll (e.g. short merchant slips): no cut, just a little space between slips
    const noCut = tpl.cut === 'none';
    // barcode labels: exactly the label size (no feed before, only the gap set between rows, end as set)
    if (tpl.label_exact && tpl.label_tspl) { const L = tpl.label_tspl; bytes = buildTsplJob(r.canvas, { wMm: L.w_mm, hMm: L.h_mm, gapMm: L.gap_mm, rowW: L.row_w, rowH: L.row_h, rows: L.rows, flip: L.flip, threshold: o.density || 160 }); }
    else if (tpl.label_exact) bytes = buildLabelJob(r.canvas, { cuts: r.cuts, cutMode: printer.cut_mode || 'full', end: tpl.label_end || 'cut', endDots: Math.round((Number(tpl.label_end_mm) || 0) * 8), backDots: Math.round((Number(tpl.label_back_mm) || 0) * 8), threshold: o.density || 160 });
    else bytes = buildJob(r.canvas, { cuts: noCut ? [] : r.cuts, feedBefore: noCut ? 0 : printer.feed_before ?? 3, feedAfter: noCut ? Number(tpl.feed_after ?? 1) : printer.feed_after ?? 1, cutMode: noCut ? 'none' : printer.cut_mode || 'full',
      buzzer: buzz, beepCount: printer.beep_count || 4, beepDuration: o.beep_duration || 2, threshold: o.density || 160, topFeed: o.top_feed || 0 });
  }
  if (t.kind === 'browser') return { status: 'sent' };
  await t.write(bytes, { status: true });
  // confirmation: ask for real-time status (only possible on transports with a return channel)
  let confirmed = false, note = 'เครื่องรับข้อมูลแล้ว แต่เครื่องรุ่นนี้/ช่องทางนี้ไม่รายงานผลการพิมพ์';
  const ag = t.lastStatus;
  if (ag && ag.known) {
    if (ag.paperOut) throw new Error('กระดาษหมด');
    if (ag.coverOpen) throw new Error('ฝาเครื่องพิมพ์เปิดอยู่');
    confirmed = !ag.error; note = confirmed ? 'เครื่องพิมพ์รายงานสถานะปกติหลังรับงาน' : 'เครื่องพิมพ์รายงานข้อผิดพลาด';
    if (!confirmed) throw new Error(note);
  } else {
    const paper = parseStatus(4, await t.query(4).catch(() => undefined));
    if (paper.known) {
      if (paper.paperOut) throw new Error('กระดาษหมด');
      const err = parseStatus(2, await t.query(2).catch(() => undefined));
      if (err.known && (err.coverOpen || err.error)) throw new Error(err.coverOpen ? 'ฝาเครื่องพิมพ์เปิดอยู่' : 'เครื่องพิมพ์ผิดพลาด');
      confirmed = true; note = 'เครื่องพิมพ์รายงานสถานะปกติหลังรับงาน';
    }
  }
  return { status: confirmed ? 'printed' : 'sent', note };
}

// Print host: drains queued jobs for every printer linked to this device, strictly one job at a time per printer.
export class PrintHost {
  constructor({ api, sock, terminalId, settings, device = 'pos', onChange = () => {} }) {
    Object.assign(this, { api, sock, terminalId, settings, device, onChange });
    this.printers = []; this.busy = new Set(); this.log = [];
  }
  async start() {
    await this.reload();
    this.sock.on('print:queued', (e) => this.drain(e.printer_id));
    this.sock.on('printers:changed', () => this.reload());
    this.sock.on('connect', () => { this.watch(); this.drainAll(); });
    this.timer = setInterval(() => this.drainAll(), 5000);
  }
  async reload() {
    this.printers = (await this.api.get('/printers')).filter((p) => p.active);
    this.watch();
    this.drainAll();
    this.onChange();
  }
  mine() { return this.printers.filter((p) => isLinkedHere(p.id) && (!p.host_terminal_id || p.host_terminal_id === this.terminalId)); }
  watch() { this.sock.emit('print:watch', this.mine().map((p) => p.id)); }
  drainAll() { for (const p of this.mine()) this.drain(p.id); }
  async drain(pid) {
    const p = this.printers.find((x) => x.id === pid);
    if (!p || !isLinkedHere(pid) || this.busy.has(pid)) return;
    this.busy.add(pid);
    try {
      for (;;) {
        const job = await this.api.post('/print/claim', { printer_id: pid, host: this.terminalId });
        if (!job) break;
        try {
          const r = await printDocument(p, job.template, job.payload.data, job.doc_type);
          await this.api.post(`/print/jobs/${job.id}/report`, { status: r.status, error: r.status === 'sent' ? r.note : null });
          this.push(p, job, r.status, r.note);
          if ((job.doc_type === 'kitchen' || (this.settings.sound.docs === 'all' && !['drawer', 'cut', 'feed'].includes(job.doc_type))) && (r.status === 'printed' || this.settings.sound.on === 'sent')) playSound(this.settings.sound, 'printed', this.device);
          this.api.post(`/printers/${pid}/status`, { status: 'ok' }).catch(() => {});
        } catch (e) {
          await this.api.post(`/print/jobs/${job.id}/report`, { status: 'failed', error: e.message }).catch(() => {});
          this.push(p, job, 'failed', e.message);
          playSound(this.settings.sound, 'error', this.device);
          this.api.post(`/printers/${pid}/status`, { status: 'error: ' + e.message }).catch(() => {});
          open.delete(pid); // reconnect next time
          break;
        }
      }
    } catch (e) { /* network: retried by the timer */ } finally { this.busy.delete(pid); }
  }
  push(p, job, status, note) { this.log.unshift({ at: new Date(), printer: p.name, doc: job.doc_type, status, note }); this.log = this.log.slice(0, 50); this.onChange(); }
}

// Print directly on this device without the server queue (test pages from the settings screen)
export async function testPrint(printer, what = 'all') {
  const data = { store_name: 'Oppa Ramyeon', dine_type: 'takeaway', dine_label: 'กลับบ้าน', datetime: new Date().toLocaleString('th-TH'), logo: '' };
  if (what === 'cut') return printDocument(printer, null, {}, 'cut');
  if (what === 'beep') { const t = await transportFor(printer); await t.write(concat([init(), beepCmd(printer.beep_count || 4, (printer.options || {}).beep_duration || 2)])); return { status: 'sent' }; }
  if (what === 'drawer') return printDocument(printer, null, {}, 'drawer');
  return printDocument(printer, { font: what.font }, data, 'test');
}
