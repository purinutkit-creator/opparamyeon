// จัดการร้าน → ตู้ถ่ายรูป: promotion (free photo for receipts of at least …), booth look, printer, photo storage,
// pairing booths, and what the booths did (sessions, prints, paper, reprint).
import { h, toast, errToast, fmtTime } from '/shared/ui.js';
import { baht } from '/shared/core.js';
import { api, ctx, can, page, card, form, kpi, saveBtn } from './common.js';

const LAYOUT_NAMES = { single: 'รูปเดี่ยว', strip2: 'แถบ 2 รูป', strip3: 'แถบ 3 รูป', strip4: 'แถบ 4 รูป', grid4: 'เกาหลี 2×2', grid6: 'ตาราง 6 รูป', grid8: 'ปุริคุระ 8 รูป', receipt: 'ใบเสร็จคลาสสิก' };

export async function photoboothPage() {
  const s = await api.get('/settings');
  const pb = { ...s.photobooth };
  const printers = (await api.get('/printers')).filter((p) => p.active);
  const v = { ...pb, min_spend: (pb.min_spend || 0) / 100 };
  const promo = form([
    { k: 'enabled', label: '📸 เปิดใช้ตู้ถ่ายรูป', type: 'bool' },
    { k: 'require_receipt', label: 'ต้องสแกนใบเสร็จก่อนถ่าย (ไม่ติ๊ก = ถ่ายฟรีทุกคน)', type: 'bool' },
    { k: 'min_spend', label: 'ยอดซื้อขั้นต่ำต่อใบเสร็จ (บาท)', type: 'number' },
    { k: 'sessions_per_receipt', label: 'ถ่ายได้กี่ครั้งต่อใบเสร็จ', type: 'number' },
    { k: 'receipt_hours', label: 'ใบเสร็จใช้แลกได้ภายใน (ชั่วโมงหลังชำระ)', type: 'number' },
  ], v);
  const shoot = form([
    { k: 'countdown', label: 'นับถอยหลังเริ่มต้น (วินาที)', type: 'select', options: [['3', '3'], ['5', '5'], ['10', '10']] },
    { k: 'gap', label: 'เวลาระหว่างรูป (วินาที)', type: 'number' },
    { k: 'mirror', label: 'กล้องกลับด้านเหมือนกระจก', type: 'bool' },
    { k: 'dither', label: 'วิธีแปลงขาวดำเริ่มต้น', type: 'select', options: [['floyd', 'Floyd–Steinberg (ละเอียด)'], ['atkinson', 'Atkinson (คม สว่าง)'], ['bayer', 'Bayer (ลายตาราง เรโทร)'], ['threshold', 'ขาว/ดำ ล้วน']] },
    { k: 'idle_seconds', label: 'ไม่มีคนใช้กี่วินาทีให้กลับหน้าแรก', type: 'number' },
  ], { ...v, countdown: String(v.countdown || 3) });
  const lay = new Set(pb.layouts || Object.keys(LAYOUT_NAMES));
  const layBox = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px' } }, Object.entries(LAYOUT_NAMES).map(([k, n]) => {
    const cb = h('input', { type: 'checkbox', checked: lay.has(k), onchange: () => (cb.checked ? lay.add(k) : lay.delete(k)) });
    return h('label', { class: 'switch' }, cb, n);
  }));
  const look = form([
    { k: 'title', label: 'หัวข้อบนรูป / หน้าแรก (เช่น YOUR LITTLE MOMENT)' }, { k: 'footer', label: 'ข้อความท้ายรูป (เช่น THANK YOU FOR SMILING)' },
    { k: 'show_date', label: 'พิมพ์วันที่และเวลา', type: 'bool' }, { k: 'show_qr', label: 'พิมพ์ QR ดาวน์โหลดรูป (เมื่อลูกค้ายินยอมให้เก็บรูป)', type: 'bool' },
    { k: 'accent', label: 'สีหลัก', type: 'color' }, { k: 'bg', label: 'สีพื้นหลัง', type: 'color' },
    { k: 'logo', label: 'โลโก้ (ว่าง = โลโก้ร้าน)', type: 'image' }, { k: 'background', label: 'ภาพพื้นหลังหน้าตู้', type: 'image' },
  ], v);
  const prn = form([
    { k: 'printer_id', label: 'เครื่องพิมพ์รูป', type: 'select', options: [['', 'อัตโนมัติ (เครื่องที่ติ๊ก "รูปจากตู้ถ่ายรูป" หรือเครื่องใบเสร็จ)'], ...printers.map((p) => [p.id, `${p.name} · ${p.paper}mm`])] },
    { k: 'copies', label: 'จำนวนสำเนาต่อครั้ง', type: 'number' },
  ], v);
  const store = form([
    { k: 'store_photos', label: 'เก็บรูปสีให้ลูกค้าดาวน์โหลดผ่าน QR (ลูกค้าต้องติ๊กยินยอมก่อนทุกครั้ง)', type: 'bool' },
    { k: 'link_hours', label: 'ลิงก์ดาวน์โหลดใช้ได้ (ชั่วโมง) — ครบแล้วลบรูปอัตโนมัติ', type: 'number' },
    { k: 'consent_text', label: 'ข้อความขอความยินยอม (ว่าง = ข้อความมาตรฐาน)', wide: true },
  ], v);
  const save = async () => {
    const all = { ...promo.value(), ...shoot.value(), ...look.value(), ...prn.value(), ...store.value() };
    const n = (x, lo, hi, d) => Math.max(lo, Math.min(hi, Math.round(Number(x)) || d));
    const value = { ...all, min_spend: Math.max(0, Math.round(Number(all.min_spend || 0) * 100)), sessions_per_receipt: n(all.sessions_per_receipt, 1, 20, 1), receipt_hours: n(all.receipt_hours, 0, 24 * 30, 24),
      countdown: Number(all.countdown) || 3, gap: Math.max(0, Math.min(10, Number(all.gap) || 0)), idle_seconds: n(all.idle_seconds, 15, 600, 60), copies: n(all.copies, 1, 5, 1), link_hours: n(all.link_hours, 1, 24 * 30, 24),
      layouts: Object.keys(LAYOUT_NAMES).filter((k) => lay.has(k)) };
    if (!value.layouts.length) throw new Error('เลือกแบบรูปอย่างน้อย 1 แบบ');
    await api.put('/settings/photobooth', { value });
  };
  // pairing
  const pairOut = h('div');
  const devices = h('div');
  const drawDevices = async () => {
    const list = await api.get('/photobooth/devices');
    devices.replaceChildren(...(list.length ? list.map((d) => h('div', { class: 'row between', style: { padding: '.4em 0', borderBottom: '1px dashed var(--line)' } },
      h('span', {}, `📸 ตู้ที่จับคู่ ${fmtTime(d.used_at)}`, h('span', { class: 'small muted' }, ` · ใช้งานล่าสุด ${d.last_seen ? fmtTime(d.last_seen) : '-'}`), d.revoked ? h('span', { class: 'badge bad' }, ' ยกเลิกแล้ว') : null),
      d.revoked ? null : h('button', { class: 'btn sm ghost', onclick: async () => { if (confirm('ยกเลิกการจับคู่ตู้นี้?')) { await api.post(`/photobooth/devices/${d.id}/revoke`); drawDevices(); } } }, 'ยกเลิก'))) : [h('div', { class: 'small muted' }, 'ยังไม่มีตู้ที่จับคู่')]));
  };
  // report
  const rep = await api.get('/photobooth/report');
  const st = (x) => [kpi('ครั้งที่ถ่าย', x.sessions), kpi('พิมพ์', `${x.prints} ใบ`), kpi('รูปที่ถ่าย', x.shots), kpi('กระดาษโดยประมาณ', `${(x.paper_mm / 1000).toFixed(2)} ม.`), kpi('ยอดใบเสร็จที่แลก', baht(x.sales) + ' ฿')];
  const rows = h('div', {}, rep.sessions.length ? rep.sessions.map((x) => h('div', { class: 'row between', style: { padding: '.5em 0', borderBottom: '1px dashed var(--line)', gap: '10px' } },
    x.print_url ? h('a', { href: x.color_url || x.print_url, target: '_blank' }, h('img', { src: x.print_url, style: { height: '64px', imageRendering: 'pixelated', border: '1px solid var(--line)' } })) : h('span', { class: 'small muted', style: { width: '40px' } }, x.status === 'done' ? 'ลบแล้ว' : '—'),
    h('div', { style: { flex: 1 } }, h('div', {}, `${fmtTime(x.created_at)} · ${LAYOUT_NAMES[x.layout] || x.layout || 'ยังไม่ถ่ายเสร็จ'}`, x.bill_no ? ` · บิล ${x.bill_no} (${baht(x.amount)} ฿)` : ''),
      h('div', { class: 'small muted' }, `${x.shots || 0} รูป · พิมพ์ ${x.prints || 0} ครั้ง${x.consent ? ' · ลูกค้ายินยอมให้เก็บรูป' : ''}${x.expires_at ? ' · ลบ ' + fmtTime(x.expires_at) : ''}`)),
    x.status === 'done' && x.print_url && can('reprint') ? h('button', { class: 'btn sm', onclick: async () => { try { await api.post(`/photobooth/sessions/${x.id}/reprint`); toast('ส่งพิมพ์ซ้ำแล้ว', 'ok'); } catch (e) { errToast(e); } } }, '🖨 พิมพ์ซ้ำ') : null))
    : [h('div', { class: 'small muted' }, 'ยังไม่มีการถ่ายรูป')]);
  const pg = page('📸 ตู้ถ่ายรูป (Photobooth)',
    card(h('h3', {}, 'วันนี้'), h('div', { class: 'cards' }, st(rep.today)), h('p', { class: 'small muted' }, `ทั้งหมด ${rep.total.sessions} ครั้ง · พิมพ์ ${rep.total.prints} ใบ · กระดาษ ${(rep.total.paper_mm / 1000).toFixed(2)} ม.`)),
    card(h('h3', {}, '🎁 โปรโมชั่น: ซื้อครบ แล้วถ่ายรูปฟรี'), promo,
      h('p', { class: 'small muted' }, 'ใบเสร็จที่ยอดถึงเกณฑ์จะพิมพ์ QR "📸 ถ่ายรูปฟรี" ให้อัตโนมัติ · ลูกค้าสแกนที่ตู้ ระบบตรวจว่าเป็นบิลจริง ชำระแล้ว ยอดถึง และยังไม่เคยใช้ แล้วให้ถ่ายได้ทันที · QR สะสมแต้มบนใบเสร็จก็ใช้ได้')),
    card(h('h3', {}, '🎞 การถ่าย'), shoot, h('div', { style: { marginTop: '.6em' } }, h('b', {}, 'แบบรูปที่ให้เลือก'), layBox)),
    card(h('h3', {}, '🎨 หน้าตาและข้อความบนรูป'), look),
    card(h('h3', {}, '🖨 เครื่องพิมพ์'), prn, h('p', { class: 'small muted' }, 'พิมพ์ผ่านคิวงานพิมพ์ของร้าน: เครื่องพิมพ์ต้องเชื่อมอยู่กับเครื่องใดเครื่องหนึ่งที่เปิดหน้าร้านไว้ (POS / จอลูกค้า / ตัวตู้เองที่ ⚙️ มุมขวาล่าง) · ใช้ความกว้างจริงของเครื่อง (58 มม. = 384 จุด, 80 มม. = 576 จุด) · ถ้ายังไม่มีเครื่องพิมพ์ ตู้จะขึ้น DEMO และไม่บอกว่าพิมพ์สำเร็จ')),
    card(h('h3', {}, '🔒 เก็บรูปและดาวน์โหลด'), store),
    h('div', { style: { margin: '0 0 1em' } }, saveBtn('บันทึกการตั้งค่าตู้ถ่ายรูป', save)),
    card(h('h3', {}, '🔗 เชื่อมตู้ถ่ายรูป'), h('p', { class: 'small muted' }, 'เปิดเว็บ ', h('code', {}, location.origin + '/photo/'), ' บนแท็บเล็ต/คอมที่ใช้เป็นตู้ (มีกล้อง) แล้วกรอกรหัสจับคู่ · เฉพาะตู้ที่จับคู่แล้วเท่านั้นที่แลกสิทธิ์และสั่งพิมพ์ได้'),
      h('button', { class: 'btn primary', onclick: async () => { try { const r = await api.post('/photobooth/pairing'); pairOut.replaceChildren(h('div', { style: { fontSize: '2.4em', fontWeight: 800, letterSpacing: '.2em' } }, r.code), h('div', { class: 'small muted' }, 'ใช้ได้ 15 นาที · หรือเปิดลิงก์ ', h('a', { href: r.url, target: '_blank' }, location.origin + r.url))); } catch (e) { errToast(e); } } }, 'สร้างรหัสจับคู่'),
      pairOut, h('div', { style: { marginTop: '.8em' } }, devices)),
    card(h('h3', {}, '🧾 ประวัติการถ่ายล่าสุด'), rows));
  drawDevices().catch(() => {});
  return pg;
}
