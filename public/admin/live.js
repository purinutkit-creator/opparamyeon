// Live View: every POS screen in real time — what the cashier is keying in, the member, and the payment in progress.
// Data arrives over the staff socket ('live:update'); nothing here writes to the server.
import { h, fmtTime, debounce, SOURCE_TH } from '/shared/ui.js';
import { baht, dineLabel, latestOnly } from '/shared/core.js';
import { api, ctx, page, kpi, money } from './common.js';

const U = () => (ctx.settings && ctx.settings.sale.count_unit) || 'ชาม';
const PHASE = { idle: ['ว่าง รอลูกค้า', 'idle'], cart: ['กำลังคีย์รายการ', 'cart'], pay: ['กำลังชำระเงิน', 'pay'], done: ['ชำระสำเร็จ', 'done'] };
const ago = (iso) => { const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000)); return s < 5 ? 'เมื่อสักครู่' : s < 60 ? `${s} วินาทีที่แล้ว` : s < 3600 ? `${Math.floor(s / 60)} นาทีที่แล้ว` : fmtTime(iso); };
const lineKey = (l) => `${l.name}|${(l.options || []).join(',')}|${l.dine_type}|${l.bowl_group || ''}`;

export async function livePage(sock) {
  const recs = new Map();     // terminal → latest record
  const prevQty = new Map();  // terminal → Map(lineKey → qty) to highlight what was just added
  const lastDone = new Map(); // terminal → last completed payment shown for a moment after the bill closes
  let focus = null;           // terminal opened in the big Live View
  const kpis = h('div', { class: 'cards' });
  const grid = h('div', { class: 'live-grid' });
  const feed = h('div', { class: 'live-feed' });
  const status = h('span', { class: 'badge ok' }, '● เรียลไทม์');
  const big = h('div', { class: 'live-big', hidden: true });

  const flashes = (rec) => {
    const before = prevQty.get(rec.terminal_id) || new Map();
    const now = new Map();
    const hot = new Set();
    for (const l of rec.state.lines || []) {
      const k = lineKey(l);
      now.set(k, (now.get(k) || 0) + l.qty);
      if ((before.get(k) || 0) < now.get(k)) hot.add(k);
    }
    prevQty.set(rec.terminal_id, now);
    return hot;
  };

  const linesView = (rec, hot, bigMode) => {
    const s = rec.state, d = rec.detail || {};
    const lines = s.lines || [];
    if (!lines.length) return h('div', { class: 'live-empty' }, h('img', { src: '/assets/bowl.svg', alt: '' }), 'ยังไม่มีรายการ');
    return h('div', { class: 'live-lines' }, lines.map((l, i) => h('div', { class: 'll' + (hot.has(lineKey(l)) ? ' hot' : '') },
      h('span', { class: 'q' }, l.qty), h('div', { class: 'n' }, h('b', {}, l.name, l.dine_type === 'takeaway' && s.dine_type !== 'takeaway' ? h('span', { class: 'tw' }, 'กลับบ้าน') : null),
        (l.options || []).length ? h('small', {}, l.options.join(', ')) : null,
        (d.line_notes || [])[i] ? h('small', { class: 'note' }, '📝 ' + d.line_notes[i]) : null,
        bigMode && (d.sent || [])[i] ? h('small', { class: 'sent' }, `ส่งครัวแล้ว ${d.sent[i]}`) : null),
      h('span', { class: 'p num' }, baht(l.price)))));
  };

  const payView = (rec) => {
    const s = rec.state, p = (rec.detail || {}).pay;
    if (s.phase !== 'pay' || !p) return null;
    return h('div', { class: 'live-pay' }, h('div', { class: 'row between' }, h('b', {}, '💳 ', p.method), h('span', { class: 'num' }, 'คงเหลือ ', baht(p.remaining))),
      (p.splits || []).length ? h('div', { class: 'small' }, 'แบ่งจ่ายแล้ว: ', p.splits.map((x) => `${x.method} ${baht(x.amount)}`).join(' · ')) : null,
      p.entered ? h('div', { class: 'row between small' }, h('span', {}, 'รับเงิน'), h('span', { class: 'num' }, baht(p.entered))) : null,
      p.change ? h('div', { class: 'row between' }, h('span', {}, 'เงินทอน'), h('b', { class: 'num' }, baht(p.change))) : null);
  };

  const cardOf = (rec, bigMode = false) => {
    const s = rec.state || {}, d = rec.detail || {};
    const done = lastDone.get(rec.terminal_id);
    const showDone = s.phase !== 'cart' && s.phase !== 'pay' && done && Date.now() - done.t < 20000;
    const phase = !rec.online ? ['ออฟไลน์', 'off'] : showDone ? PHASE.done : PHASE[s.phase] || PHASE.idle;
    const hot = bigMode ? new Set() : flashes(rec);
    const qty = (s.lines || []).reduce((a, l) => a + l.qty, 0);
    const m = d.member;
    return h('div', { class: `live-card ph-${phase[1]}` + (bigMode ? ' big' : '') },
      h('div', { class: 'lc-head' },
        h('div', {}, h('b', {}, '🖥️ ', rec.terminal_name), h('small', {}, `👤 ${rec.staff_name}`)),
        h('span', { class: 'phase' }, h('i'), phase[0])),
      h('div', { class: 'lc-tags' },
        s.lines && s.lines.length ? h('span', { class: 'tag ' + (s.dine_type === 'takeaway' ? 'tw' : '') }, dineLabel(s.dine_type)) : null,
        d.bill_no ? h('span', { class: 'tag' }, 'บิล ' + d.bill_no) : null, d.queue_no ? h('span', { class: 'tag' }, 'คิว ' + d.queue_no) : null,
        d.table ? h('span', { class: 'tag' }, 'โต๊ะ ' + d.table) : null, d.customer ? h('span', { class: 'tag' }, '👤 ' + d.customer) : null,
        d.note ? h('span', { class: 'tag note' }, '📝 ' + d.note) : null),
      m ? h('div', { class: 'lc-member' }, h('span', { class: 'av' }, (m.name || '⭐').slice(0, 1)), h('div', {}, h('b', {}, m.name || m.member_no, m.tier ? ` · ${m.tier}` : ''),
        h('small', {}, `${m.member_no} · มี ${Number(m.points || 0).toLocaleString()} แต้ม`)), h('span', { class: 'earn' }, `+${m.earn || 0} แต้ม`)) : null,
      showDone ? h('div', { class: 'live-done' }, h('b', {}, '✅ ', done.bill_no || 'ชำระแล้ว', ' · ', baht(done.total), ' ฿'),
        h('small', {}, [done.method, done.change ? `ทอน ${baht(done.change)}` : ''].filter(Boolean).join(' · '), ` · ${ago(new Date(done.t).toISOString())}`))
        : linesView(rec, hot, bigMode),
      !showDone ? payView(rec) : null,
      !showDone && (s.lines || []).length ? h('div', { class: 'lc-total' },
        h('div', { class: 'small muted' }, `${qty} รายการ · ${s.bowls || 0} ${U()}`, s.discount ? ` · ส่วนลด ${baht(s.discount)}${d.discount_label ? ` (${d.discount_label})` : ''}` : ''),
        h('b', { class: 'num' }, baht(s.total), ' ฿')) : null,
      h('div', { class: 'lc-foot' }, h('small', { class: 'muted', 'data-ago': rec.updated_at }, ago(rec.updated_at)),
        !bigMode ? h('button', { class: 'btn sm live-btn', onclick: () => openBig(rec.terminal_id) }, h('i'), 'Live View') : null));
  };

  const drawGrid = () => {
    const list = [...recs.values()].sort((a, b) => (b.online - a.online) || String(a.terminal_name).localeCompare(String(b.terminal_name), 'th'));
    grid.replaceChildren(...(list.length ? list.map((r) => cardOf(r)) : [h('div', { class: 'empty' }, 'ยังไม่มีเครื่องขายที่เปิดหน้า POS อยู่ — เมื่อแคชเชียร์เปิด POS และเริ่มคีย์รายการ จะแสดงที่นี่ทันที')]));
    if (focus) drawBig();
  };
  const drawBig = () => {
    const rec = recs.get(focus);
    if (!rec) return;
    big.replaceChildren(h('div', { class: 'live-big-in' }, h('div', { class: 'row between', style: { marginBottom: '.6em' } },
      h('h3', { style: { margin: 0 } }, h('span', { class: 'rec' }), ' Live View · ', rec.terminal_name), h('button', { class: 'btn', onclick: closeBig }, '✕ ปิด')), cardOf(rec, true)));
  };
  const openBig = (tid) => { focus = tid; big.hidden = false; drawBig(); };
  const closeBig = () => { focus = null; big.hidden = true; };
  big.addEventListener('click', (e) => { if (e.target === big) closeBig(); });

  const onUpdate = (rec) => {
    if (!rec || !rec.terminal_id) return;
    const s = rec.state || {}, p = (rec.detail || {}).pay;
    if (s.phase === 'done') lastDone.set(rec.terminal_id, { t: Date.now(), bill_no: p && p.bill_no, total: s.total, method: p && p.method, change: s.change });
    if (s.phase === 'cart' || s.phase === 'pay') lastDone.delete(rec.terminal_id);
    recs.set(rec.terminal_id, rec);
    drawGrid();
  };

  // today's numbers + latest paid bills
  const guard = latestOnly();
  const refreshSales = async () => {
    try {
      const r = await guard(() => api.get('/dashboard'), { coalesce: true });
      if (!r.fresh) return;
      const d = r.value;
      kpis.replaceChildren(kpi('ยอดขายสุทธิวันนี้', money(d.net_sales), `${d.bills_paid} บิล`, true), kpi('บิลที่ชำระสำเร็จ', d.bills_paid.toLocaleString(), `เฉลี่ย ${baht(d.bills_paid ? Math.round(d.net_sales / d.bills_paid) : 0)} ฿/บิล`, true),
        kpi('จำนวน' + U() + 'สุทธิ', d.bowls_net.toLocaleString(), `ขาย ${d.bowls_sold}`, true), kpi('รอชำระ', money(d.pending_payment.amount), `${d.pending_payment.count} ออเดอร์`));
      feed.replaceChildren(h('h3', {}, '🧾 บิลล่าสุด'), ...(d.recent.length ? d.recent.slice(0, 12).map((o) => h('div', { class: 'lf-row' + (o.status !== 'paid' ? ' void' : '') },
        h('span', { class: 't' }, fmtTime(o.paid_at || o.created_at).split(' ').pop()), h('div', {}, h('b', {}, o.bill_no), h('small', {}, [o.queue_no ? 'คิว ' + o.queue_no : '', SOURCE_TH[o.source], dineLabel(o.dine_type)].filter(Boolean).join(' · '))),
        h('b', { class: 'num' }, baht(o.total)))) : [h('div', { class: 'empty' }, 'ยังไม่มีบิลวันนี้')]));
    } catch { /* keep the last numbers; the status badge shows the connection */ }
  };

  const setStatus = () => { status.className = 'badge ' + (sock.connected ? 'ok' : 'bad'); status.textContent = sock.connected ? '● เรียลไทม์' : '⚠️ ขาดการเชื่อมต่อ'; };
  const snapshot = () => sock.emit('live:snapshot', (list) => { for (const r of list || []) recs.set(r.terminal_id, r); drawGrid(); });
  sock.on('live:update', onUpdate);
  sock.on('sales:changed', debounce(refreshSales, 500));
  sock.on('connect', () => { setStatus(); snapshot(); refreshSales(); });
  sock.on('disconnect', setStatus);
  // "x seconds ago" labels and the post-payment card fade; stops once the page is gone
  const tick = setInterval(() => {
    if (!document.body.contains(grid)) return clearInterval(tick);
    grid.querySelectorAll('[data-ago]').forEach((e) => { e.textContent = ago(e.dataset.ago); });
    for (const [tid, d] of lastDone) if (Date.now() - d.t > 20000) { lastDone.delete(tid); drawGrid(); }
  }, 1000);
  setStatus(); snapshot(); refreshSales();
  return page('Live View · หน้าร้านตอนนี้', h('div', { class: 'row', style: { marginBottom: '.8em' } }, status, h('span', { class: 'small muted' }, 'เห็นสิ่งที่แคชเชียร์กำลังคีย์ สมาชิก และการชำระเงินของทุกเครื่องแบบเรียลไทม์ · ข้อมูลส่วนนี้ไม่แสดงบนจอลูกค้า')),
    kpis, h('div', { class: 'live-wrap' }, grid, feed), big);
}
