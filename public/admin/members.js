import { h, toast, errToast, modal, fmtTime, debounce, SOURCE_TH, STATUS_TH } from '/shared/ui.js';
import { baht } from '/shared/core.js';
import { api, can, page, card, form, table, kpi, money } from './common.js';

const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const RST = { pending: 'รอดำเนินการ', reviewing: 'กำลังตรวจสอบ', approved: 'อนุมัติ (ส่งลิงก์แล้ว)', done: 'สำเร็จ', rejected: 'ปฏิเสธ', expired: 'หมดอายุ' };

export async function membersPage() {
  const tiers = await api.get('/tiers');
  const f = { q: '', tier: '', status: '', from: '', to: '' };
  const res = h('div');
  const load = async () => {
    const r = await api.get('/members?' + new URLSearchParams(Object.entries(f).filter(([, v]) => v)));
    res.replaceChildren(r.pending_resets ? h('p', {}, h('a', { href: '#/resets', class: 'badge warn' }, `🔑 มีคำขอรีเซ็ตรหัสผ่านรอดำเนินการ ${r.pending_resets} รายการ`)) : null,
      table([{ t: 'หมายเลข', k: 'member_no' }, { t: 'ชื่อ', f: (m) => `${m.first_name || ''} ${m.last_name || ''}${m.nickname ? ` (${m.nickname})` : ''}` }, { t: 'เบอร์', k: 'phone' },
        { t: 'Tier', f: (m) => (m.tier_name ? h('span', { class: 'badge', style: { background: m.tier_color, color: '#fff' } }, m.tier_name) : '') }, { t: 'แต้ม', r: 1, k: 'points' },
        { t: 'ยอดสะสม', r: 1, f: (m) => baht(m.total_spent) }, { t: 'บิล', r: 1, k: 'bills' }, { t: 'สถานะ', f: (m) => (m.status === 'active' ? 'ใช้งาน' : 'ระงับ') }, { t: 'สมัคร', f: (m) => fmtTime(m.created_at) }],
      r.members, { onRow: (m) => { location.hash = '#/members/' + m.id; } }));
  };
  const q = h('input', { class: 'input', placeholder: 'ชื่อ / เบอร์ / หมายเลขสมาชิก', style: { maxWidth: '280px' } });
  q.addEventListener('input', debounce(() => { f.q = q.value; load(); }, 300));
  const sel = (k, opts) => { const s = h('select', { class: 'input', style: { width: 'auto' } }, opts.map(([v, t]) => h('option', { value: v }, t))); s.onchange = () => { f[k] = s.value; load(); }; return s; };
  const d1 = h('input', { type: 'date', class: 'input', style: { width: 'auto' } }); const d2 = h('input', { type: 'date', class: 'input', style: { width: 'auto' } });
  d1.onchange = () => { f.from = d1.value; load(); }; d2.onchange = () => { f.to = d2.value; load(); };
  load();
  return page('สมาชิก', h('div', { class: 'bar' }, q, sel('tier', [['', 'ทุก Tier'], ...tiers.map((t) => [t.id, t.name])]), sel('status', [['', 'ทุกสถานะ'], ['active', 'ใช้งาน'], ['suspended', 'ระงับ']]), h('span', {}, 'สมัคร'), d1, '–', d2), res);
}

export async function memberDetail(id) {
  const m = await api.get('/members/' + id);
  const tiers = await api.get('/tiers');
  const K = { earn: 'สะสม', redeem_hold: 'สำรองแลก', redeem: 'แลก', redeem_release: 'คืนแต้ม', adjust: 'ปรับด้วยมือ', refund: 'ปรับจากคืนเงิน', expire: 'หมดอายุ' };
  const edit = () => {
    const f = form([{ k: 'first_name', label: 'ชื่อ' }, { k: 'last_name', label: 'นามสกุล' }, { k: 'nickname', label: 'ชื่อเล่น' }, { k: 'phone', label: 'เบอร์โทร (บัญชีเข้าสู่ระบบ)' }, { k: 'birthday', label: 'วันเกิด', type: 'date' },
      { k: 'email', label: 'อีเมล' }, { k: 'status', label: 'สถานะ', type: 'select', options: [['active', 'ใช้งาน'], ['suspended', 'ระงับบัญชี']] }, { k: 'note', label: 'หมายเหตุภายใน', type: 'textarea', wide: true }, { k: 'reason', label: 'เหตุผล/วิธีตรวจสอบตัวตน', wide: true }], m);
    modal('แก้ไขสมาชิก', f, { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => { await api.put('/members/' + m.id, f.value()); reload(); } }] });
  };
  const points = () => {
    const f = form([{ k: 'delta', label: 'เพิ่ม (+) / ลด (−) แต้ม', type: 'number' }, { k: 'reason', label: 'เหตุผล (บังคับ)' }], {});
    modal('ปรับแต้ม', f, { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => { await api.post(`/members/${m.id}/points`, f.value()); reload(); } }] });
  };
  const tier = () => {
    const f = form([{ k: 'tier_id', label: 'Tier', type: 'select', options: tiers.map((t) => [t.id, t.name]) }, { k: 'auto', label: 'กลับไปคำนวณอัตโนมัติ', type: 'bool' }, { k: 'reason', label: 'เหตุผล (บังคับ)' }], { tier_id: m.tier && m.tier.id });
    modal('ปรับ Tier', f, { actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => { await api.post(`/members/${m.id}/tier`, f.value()); reload(); } }] });
  };
  const pr = m.progress && m.progress.next;
  return page(`สมาชิก ${m.member_no}`,
    h('div', { class: 'bar' }, h('a', { class: 'btn sm', href: '#/members' }, '← รายชื่อ'), h('button', { class: 'btn', onclick: edit }, 'แก้ไขข้อมูล/ระงับ'),
      can('adjust_points') ? h('button', { class: 'btn', onclick: points }, 'ปรับแต้ม') : null, can('adjust_points') ? h('button', { class: 'btn', onclick: tier }, 'ปรับ Tier') : null),
    card(h('h3', {}, `${m.first_name || ''} ${m.last_name || ''}`, m.nickname ? ` (${m.nickname})` : '', ' ', h('span', { class: 'badge ' + (m.status === 'active' ? 'ok' : 'bad') }, m.status === 'active' ? 'ใช้งาน' : 'ระงับ')),
      h('p', {}, `📞 ${m.phone} · 🎂 ${m.birthday || '-'} · ✉️ ${m.email || '-'} · สมัคร ${fmtTime(m.created_at)}`),
      m.note ? h('p', { class: 'small' }, '📝 ', m.note) : null,
      h('p', {}, 'Tier ', m.tier ? h('span', { class: 'badge', style: { background: m.tier.color, color: '#fff' } }, m.tier.name) : '-', m.tier_manual ? ' (ตั้งด้วยมือ)' : ' (อัตโนมัติ)',
        pr ? ` · ความคืบหน้าสู่ ${pr.name} ${m.progress.pct}%` : ' · ระดับสูงสุด'),
      h('p', { class: 'small muted' }, m.password_is_default ? 'ยังใช้รหัสผ่านเริ่มต้น' : 'เปลี่ยนรหัสผ่านแล้ว', ' · ระบบไม่เก็บ/ไม่แสดงรหัสผ่านจริง')),
    h('div', { class: 'cards' }, kpi('แต้มคงเหลือ', m.points.toLocaleString(), m.reserved_points ? `สำรอง ${m.reserved_points}` : null), kpi('แต้มใกล้หมดอายุ (30 วัน)', m.stats.expiring_points), kpi('ยอดซื้อสะสม', money(m.stats.spent)),
      kpi('จำนวนบิล', m.stats.bills), kpi('มาใช้บริการ', m.visits + ' ครั้ง'), kpi('เฉลี่ยต่อบิล', money(m.stats.avg_bill)), kpi('ซื้อล่าสุด', fmtTime(m.stats.last_purchase))),
    h('div', { class: 'grid2' }, card(h('h3', {}, 'เมนูที่สั่งบ่อย'), table([{ t: 'เมนู', k: 'name' }, { t: 'จำนวน', r: 1, k: 'qty' }, { t: 'ครั้ง', r: 1, k: 'times' }], m.stats.favorites)),
      card(h('h3', {}, 'ตัวเลือก/ท็อปปิ้งที่เลือกบ่อย'), table([{ t: 'ตัวเลือก', k: 'name' }, { t: 'จำนวน', r: 1, k: 'qty' }], m.stats.favorite_options))),
    card(h('h3', {}, 'ประวัติบิล'), table([{ t: 'เวลา', f: (b) => fmtTime(b.paid_at) }, { t: 'บิล', k: 'bill_no' }, { t: 'ช่องทาง', f: (b) => SOURCE_TH[b.source] }, { t: 'สถานะ', f: (b) => STATUS_TH[b.status] }, { t: 'ชาม', r: 1, k: 'bowls' },
      { t: 'ยอด', r: 1, f: (b) => baht(b.total) }, { t: 'คืน', r: 1, f: (b) => (b.refunded_amount ? baht(b.refunded_amount) : '') }, { t: 'แต้ม', r: 1, k: 'points_earned' }], m.bills)),
    card(h('h3', {}, 'ประวัติแต้ม'), table([{ t: 'เวลา', f: (l) => fmtTime(l.created_at) }, { t: 'ประเภท', f: (l) => K[l.kind] || l.kind }, { t: 'แต้ม', r: 1, k: 'delta' }, { t: 'คงเหลือ', r: 1, k: 'balance_after' }, { t: 'เหตุผล', k: 'reason' }, { t: 'หมดอายุ', f: (l) => (l.expires_at ? fmtTime(l.expires_at) : '') }], m.ledger)),
    card(h('h3', {}, 'คูปอง/การแลกรางวัล'), table([{ t: 'รางวัล', k: 'reward_name' }, { t: 'โค้ด', k: 'code' }, { t: 'สถานะ', k: 'status' }, { t: 'แลกเมื่อ', f: (c) => fmtTime(c.created_at) }, { t: 'ใช้เมื่อ', f: (c) => fmtTime(c.used_at) }], m.coupons)),
    card(h('h3', {}, 'คืนเงิน'), table([{ t: 'เวลา', f: (r) => fmtTime(r.created_at) }, { t: 'ยอด', r: 1, f: (r) => baht(r.amount) }, { t: 'เหตุผล', k: 'reason' }], m.refunds)),
    card(h('h3', {}, 'คำขอรีเซ็ตรหัสผ่าน'), table([{ t: 'เวลา', f: (r) => fmtTime(r.created_at) }, { t: 'สถานะ', f: (r) => RST[r.status] }, { t: 'ประวัติ', f: (r) => r.history.map((x) => `${fmtTime(x.at)} ${x.action}${x.by ? ' โดย ' + x.by : ''}`).join(' · ') }], m.resets)),
    card(h('h3', {}, 'ประวัติการแก้ไข'), table([{ t: 'เวลา', f: (a) => fmtTime(a.created_at) }, { t: 'ผู้ทำ', f: (a) => a.actor_name || a.actor }, { t: 'การกระทำ', k: 'action' }, { t: 'ก่อน', f: (a) => a.before_val || '' }, { t: 'หลัง', f: (a) => a.after_val || '' }, { t: 'เหตุผล', k: 'reason' }], m.audit)));
}

export async function resetsPage() {
  const rows = await api.get('/password-resets');
  const act = (r) => {
    const f = form([{ k: 'verified_by', label: 'ตรวจสอบตัวตนด้วย', type: 'select', options: [['id_card', 'บัตรประชาชน/บัตรแสดงตัวที่ร้าน'], ['purchase_history', 'ข้อมูลการซื้อที่เจ้าของบัญชีเท่านั้นรู้'], ['otp', 'OTP ผ่านเบอร์ที่ลงทะเบียน'], ['call_back', 'โทรกลับเบอร์ที่ลงทะเบียนและยืนยันข้อมูลเพิ่ม'], ['name', 'รู้ชื่อเท่านั้น (ไม่อนุญาต)']] },
      { k: 'reason', label: 'บันทึก/เหตุผล (บังคับ)', wide: true }], {});
    modal(`คำขอของ ${r.first_name || ''} ${r.member_no} · ${r.phone}`, h('div', {}, h('p', { class: 'small muted' }, 'ห้ามรีเซ็ตจากการทราบชื่อหรือเบอร์โทรเพียงอย่างเดียว — แอดมินไม่สามารถดูรหัสผ่านเดิมได้'), f), { actions: [
      { label: 'กำลังตรวจสอบ', onClick: async () => { await api.post('/password-resets/' + r.id, { action: 'review', ...f.value() }); reload(); } },
      { label: 'ปฏิเสธ', class: 'danger', onClick: async () => { await api.post('/password-resets/' + r.id, { action: 'reject', ...f.value() }); reload(); } },
      { label: 'อนุมัติ & ออกลิงก์ใช้ครั้งเดียว', class: 'primary', onClick: async () => {
        const out = await api.post('/password-resets/' + r.id, { action: 'approve', ...f.value() });
        const url = location.origin + out.reset_url.replace(/^https?:\/\/[^/]+/, '');
        modal('ลิงก์ตั้งรหัสผ่านใหม่ (แสดงครั้งเดียว)', h('div', {}, h('p', {}, 'ส่งลิงก์นี้ให้ลูกค้าที่ยืนยันตัวตนแล้ว ใช้ได้ครั้งเดียว ภายใน 60 นาที'), h('input', { class: 'input', value: url, readOnly: true, onclick: (e) => e.target.select() }),
          h('img', { src: '/api/qr.svg?d=' + encodeURIComponent(url), style: { width: '200px', display: 'block', margin: '1em auto' } })), { onClose: reload });
      } }] });
  };
  return page('คำขอรีเซ็ตรหัสผ่านสมาชิก', card(table([{ t: 'เวลา', f: (r) => fmtTime(r.created_at) }, { t: 'สมาชิก', f: (r) => `${r.first_name || ''} ${r.last_name || ''} (${r.member_no})` }, { t: 'เบอร์', k: 'phone' },
    { t: 'สถานะ', f: (r) => h('span', { class: 'badge ' + (['pending', 'reviewing'].includes(r.status) ? 'warn' : r.status === 'done' ? 'ok' : '') }, RST[r.status]) },
    { t: 'ประวัติ', f: (r) => r.history.map((x) => `${fmtTime(x.at)} ${x.action}${x.by ? ' · ' + x.by : ''}`).join(' | ') }], rows, { onRow: (r) => (['pending', 'reviewing'].includes(r.status) ? act(r) : null) })));
}

export async function tiersPage() {
  const rows = await api.get('/tiers');
  const open = (t) => {
    const f = form([{ k: 'name', label: 'ชื่อ Tier' }, { k: 'color', label: 'สี', type: 'color' }, { k: 'icon', label: 'ไอคอน (emoji)' }, { k: 'card_image', label: 'ภาพบัตรสมาชิก', type: 'image' }, { k: 'sort', label: 'ลำดับ (ต่ำ→สูง)', type: 'number' },
      { k: 'min_spent', label: 'ยอดซื้อขั้นต่ำ (บาท)', type: 'money' }, { k: 'min_visits', label: 'จำนวนครั้งที่มาใช้บริการ', type: 'number' }, { k: 'min_points', label: 'คะแนนสะสมสำหรับประเมิน', type: 'number' },
      { k: 'window_days', label: 'ช่วงเวลาคำนวณคุณสมบัติ (วัน)', type: 'number' }, { k: 'duration_days', label: 'อายุสถานะ (วัน)', type: 'number' }, { k: 'multiplier', label: 'ตัวคูณแต้ม', type: 'number', step: '0.1' },
      { k: 'discount_pct', label: 'ส่วนลดสมาชิก %', type: 'number' }, { k: 'benefits', label: 'สิทธิประโยชน์ (แสดงบนเว็บไซต์ลูกค้า)', type: 'textarea', wide: true }, { k: 'active', label: 'เปิดใช้', type: 'bool' }], t || { active: true, multiplier: 1, window_days: 365, duration_days: 365 });
    modal(t ? 'แก้ไข Tier' : 'เพิ่ม Tier', f, { wide: true, actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => { if (t) await api.put('/tiers/' + t.id, f.value()); else await api.post('/tiers', f.value()); reload(); } }] });
  };
  return page('Tier Member', h('p', { class: 'muted' }, '"แต้มที่ใช้แลกรางวัล" แยกจาก "ยอด/คะแนนสำหรับประเมิน Tier" — การแลกของจึงไม่ทำให้ลด Tier'),
    h('div', { class: 'bar' }, h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่ม Tier'), h('button', { class: 'btn', onclick: async () => { const r = await api.post('/tiers/recompute'); toast(`คำนวณใหม่ ${r.count} คน`, 'ok'); } }, 'คำนวณ Tier ใหม่ทั้งหมด')),
    card(table([{ t: 'ลำดับ', k: 'sort' }, { t: 'Tier', f: (t) => h('span', { class: 'badge', style: { background: t.color, color: '#fff' } }, (t.icon || '') + ' ' + t.name) }, { t: 'ยอดซื้อ', r: 1, f: (t) => baht(t.min_spent) },
      { t: 'ครั้ง', r: 1, k: 'min_visits' }, { t: 'ตัวคูณ', r: 1, k: 'multiplier' }, { t: 'ส่วนลด %', r: 1, k: 'discount_pct' }, { t: 'สถานะ', f: (t) => (t.active ? 'เปิด' : 'ปิด') }], rows, { onRow: open })));
}

export async function rewardsPage() {
  const [rows, tiers, cat] = await Promise.all([api.get('/rewards'), api.get('/tiers'), api.get('/catalog?all=1')]);
  const open = (r) => {
    const f = form([{ k: 'name', label: 'ชื่อรางวัล' }, { k: 'points', label: 'แต้มที่ใช้', type: 'number' }, { k: 'product_id', label: 'สินค้าที่ได้รับ (ตัดสต็อกเมื่อส่งมอบ)', type: 'select', options: [['', '- สิทธิ์อื่น -'], ...cat.products.map((p) => [p.id, p.name])] },
      { k: 'cost', label: 'ต้นทุนรางวัล (บาท)', type: 'money' }, { k: 'tier_ids', label: 'Tier ที่มีสิทธิ์ (ไม่เลือก = ทุก Tier)', type: 'multi', options: tiers.map((t) => [t.id, t.name]), wide: true },
      { k: 'total_limit', label: 'จำนวนสิทธิ์รวม (0=ไม่จำกัด)', type: 'number' }, { k: 'per_member_limit', label: 'ครั้งต่อสมาชิก (0=ไม่จำกัด)', type: 'number' }, { k: 'starts_at', label: 'เริ่ม', type: 'date' }, { k: 'ends_at', label: 'สิ้นสุด', type: 'date' },
      { k: 'coupon_days', label: 'อายุคูปองหลังแลก (วัน)', type: 'number' }, { k: 'return_policy', label: 'เมื่อหมดอายุ/ยกเลิก', type: 'select', options: [['refund_points', 'คืนแต้มและคืนสิทธิ์'], ['forfeit', 'ไม่คืนแต้ม']] },
      { k: 'description', label: 'รายละเอียด', type: 'textarea', wide: true }, { k: 'terms', label: 'เงื่อนไข (แสดงก่อนแลก)', type: 'textarea', wide: true }, { k: 'image', label: 'รูป', type: 'image' }, { k: 'active', label: 'เปิดให้แลก', type: 'bool' }],
    r ? { ...r, starts_at: (r.starts_at || '').slice(0, 10), ends_at: (r.ends_at || '').slice(0, 10) } : { active: true, coupon_days: 7, return_policy: 'refund_points' });
    modal(r ? 'แก้ไขรางวัล' : 'เพิ่มรางวัล', f, { wide: true, actions: [{ label: 'บันทึก', class: 'primary', onClick: async () => {
      const v = f.value(); v.starts_at = v.starts_at ? v.starts_at + 'T00:00:00.000Z' : null; v.ends_at = v.ends_at ? v.ends_at + 'T23:59:59.999Z' : null;
      if (r) await api.put('/rewards/' + r.id, v); else await api.post('/rewards', v); reload();
    } }] });
  };
  return page('ของรางวัล', h('p', { class: 'muted' }, 'ลูกค้าแลกบนเว็บไซต์สมาชิก → ได้คูปองโค้ด+บาร์โค้ด → พนักงานสแกนที่ POS (🎁 แลกรางวัล) แล้วกดยืนยันส่งมอบ'),
    h('button', { class: 'btn primary', onclick: () => open(null) }, '+ เพิ่มรางวัล'),
    card(table([{ t: 'รางวัล', k: 'name' }, { t: 'แต้ม', r: 1, k: 'points' }, { t: 'แลกแล้ว', r: 1, k: 'issued_count' }, { t: 'จำกัด', r: 1, f: (r) => r.total_limit || '∞' }, { t: 'สถานะ', f: (r) => (r.active ? 'เปิด' : 'ปิด') }], rows, { onRow: open })));
}
