// Live sales for the owner (opened from the LINE rich menu): the signed link is remembered on this phone, so it never asks to log in.
import { h } from '/shared/ui.js';
import { countTo } from '/pos/fx.js';

const app = document.getElementById('app');
const KEY = 'opp.live_token';
const B = (s) => (Number(s || 0) / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const time = (iso) => new Date(iso).toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' });
const nowHour = () => Number(new Date().toLocaleString('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', hourCycle: 'h23' }));
const store = { get: () => { try { return localStorage.getItem(KEY); } catch { return null; } }, set: (v) => { try { localStorage.setItem(KEY, v); } catch { /* private mode */ } }, del: () => { try { localStorage.removeItem(KEY); } catch { /* */ } } };

// the link from LINE carries the key after #; keep it and tidy the address bar
let tok = location.hash.slice(1) || store.get();
if (location.hash.length > 1) { store.set(tok); history.replaceState(null, '', location.pathname); }
let seen = null, built = false, failures = 0;
const el = {};

function build(d) {
  el.live = h('span', { class: 'live' }, h('i'), 'LIVE');
  el.net = h('span'); el.sub = h('div', { class: 'sub' });
  el.bills = h('b'); el.avg = h('b'); el.bowls = h('b');
  el.profit = h('div'); el.bars = h('div', { class: 'bars' }); el.pay = h('div'); el.top = h('div'); el.recent = h('div'); el.extra = h('div'); el.foot = h('div', { class: 'foot' });
  app.replaceChildren(
    h('div', { class: 'top' }, h('h1', {}, '📊 ' + d.store), el.live),
    h('div', { class: 'card hero' }, h('small', {}, 'ยอดขายสุทธิวันนี้'), h('div', { class: 'big' }, el.net, h('span', { class: 'cur' }, '฿')), el.sub),
    h('div', { class: 'tiles' }, h('div', { class: 'tile' }, h('small', {}, 'บิล'), el.bills), h('div', { class: 'tile' }, h('small', {}, 'เฉลี่ย/บิล'), el.avg), h('div', { class: 'tile' }, h('small', {}, 'ชาม'), el.bowls)),
    el.extra,
    h('div', { class: 'card' }, h('h2', {}, 'ยอดขายรายชั่วโมง'), el.bars),
    h('div', { class: 'two' }, h('div', { class: 'card' }, h('h2', {}, 'แยกตามช่องทางชำระ'), el.pay), h('div', { class: 'card' }, h('h2', {}, '🔥 ขายดีวันนี้'), el.top)),
    h('div', { class: 'card' }, h('h2', {}, '🧾 บิลล่าสุด'), el.recent),
    el.foot);
  built = true;
}

function draw(d) {
  if (!built) build(d);
  countTo(el.net, d.net_sales, B, 700);
  el.sub.textContent = d.gross_profit !== undefined ? `กำไรขั้นต้น ${B(d.gross_profit)} ฿ (${d.margin_pct}%)` : '';
  countTo(el.bills, d.bills_paid, (v) => String(Math.round(v)));
  el.avg.textContent = B(d.bills_paid ? Math.round(d.net_sales / d.bills_paid) : 0);
  countTo(el.bowls, d.bowls_net, (v) => String(Math.round(v)));
  const extras = [];
  if (d.open_bills.count) extras.push(h('div', { class: 'row' }, h('span', {}, '🕒 บิลเปิดอยู่ / รอชำระ'), h('b', { class: 'warn' }, `${d.open_bills.count} บิล · ${B(d.open_bills.amount)}`)));
  if (d.discount) extras.push(h('div', { class: 'row' }, h('span', {}, 'ส่วนลด'), h('b', {}, B(d.discount))));
  if (d.voids.count || d.refunds.count) extras.push(h('div', { class: 'row' }, h('span', {}, 'ยกเลิก / คืนเงิน'), h('b', {}, `${d.voids.count} / ${d.refunds.count} · ${B(d.voids.amount + d.refunds.amount)}`)));
  el.extra.replaceChildren(...(extras.length ? [h('div', { class: 'card' }, extras)] : []));
  // hours from the first sale (or 10:00) to now
  const hrs = Object.keys(d.by_hour).map(Number);
  const from = Math.min(10, ...hrs), to = Math.max(nowHour(), ...hrs, from + 5);
  const max = Math.max(1, ...Object.values(d.by_hour));
  const cols = []; for (let x = from; x <= to; x++) cols.push(x);
  el.bars.replaceChildren(...cols.map((x) => { const v = d.by_hour[String(x).padStart(2, '0')] || 0;
    return h('div', { class: 'b' + (x === nowHour() ? ' now' : ''), title: `${x}:00 · ${B(v)}` }, h('div', { class: 'col' }, h('i', { style: { height: Math.max(2, Math.round((v / max) * 100)) + '%' } })), h('small', {}, String(x))); }));
  const pmax = Math.max(1, ...d.payments.map((p) => p.net));
  el.pay.replaceChildren(...(d.payments.length ? d.payments.map((p) => h('div', { class: 'row', style: { display: 'block' } }, h('div', { style: { display: 'flex', justifyContent: 'space-between' } }, h('span', {}, `${p.name} (${p.count})`), h('b', {}, B(p.net))),
    h('div', { class: 'meter' }, h('i', { style: { width: Math.round((p.net / pmax) * 100) + '%' } })))) : [h('div', { class: 'foot' }, 'ยังไม่มีการชำระ')]));
  el.top.replaceChildren(...(d.top.length ? d.top.map((t, i) => h('div', { class: 'row' }, h('span', {}, `${i + 1}. ${t.name}`), h('b', {}, `×${t.qty}`))) : [h('div', { class: 'foot' }, 'ยังไม่มีการขาย')]));
  const fresh = seen ? d.recent.filter((x) => !seen.has(x.bill_no)) : [];
  seen = new Set(d.recent.map((x) => x.bill_no));
  el.recent.replaceChildren(...(d.recent.length ? d.recent.map((x) => h('div', { class: 'bill' + (fresh.some((f) => f.bill_no === x.bill_no) ? ' new' : '') },
    h('span', { class: 't' }, time(x.paid_at)),
    h('span', {}, h('b', {}, x.bill_no + (x.queue_no ? ` · คิว ${x.queue_no}` : '')), h('small', {}, [x.dine_type === 'takeaway' ? 'กลับบ้าน' : 'ทานที่ร้าน', x.source && x.source !== 'pos' ? 'สั่งผ่านมือถือ' : '', x.staff || '', x.status === 'voided' ? 'ยกเลิก' : ''].filter(Boolean).join(' · '))),
    h('b', {}, B(x.total)))) : [h('div', { class: 'foot' }, 'ยังไม่มีบิลวันนี้')]));
  el.foot.textContent = `วันขาย ${d.business_date} · อัปเดต ${new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' })} · อัปเดตเองทุก 10 วินาที`;
}

async function load() {
  if (!tok) return app.replaceChildren(h('div', { class: 'msg' }, h('div', {}, h('b', {}, 'เปิดจากเมนูใน LINE'), 'หน้านี้เปิดได้จากปุ่ม "ยอดขาย · Live View" ในริชเมนู LINE ของเจ้าของร้าน')));
  try {
    const r = await fetch('/api/public/live/' + encodeURIComponent(tok), { cache: 'no-store' });
    if (r.status === 403 || r.status === 404) { store.del(); tok = null; built = false; return app.replaceChildren(h('div', { class: 'msg' }, h('div', {}, h('b', {}, '🔒 ลิงก์นี้ใช้ไม่ได้แล้ว'), (await r.json().catch(() => ({}))).error || 'เปิดใหม่จากเมนูใน LINE'))); }
    if (!r.ok) throw new Error('HTTP ' + r.status);
    draw(await r.json());
    failures = 0; if (el.live) el.live.classList.remove('off');
  } catch {
    failures++;
    if (el.live) el.live.classList.add('off');
    if (!built) app.replaceChildren(h('div', { class: 'msg' }, h('div', {}, h('b', {}, 'เชื่อมต่อไม่ได้'), 'กำลังลองใหม่…')));
  }
}
load();
setInterval(() => { if (!document.hidden) load(); }, 10e3);
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
