// LINE Official Account for stock: keys (write-only), linking chats with a one-time code, alerts, rich menu.
import { h, toast, errToast } from '/shared/ui.js';
import { api, page, card, saveBtn } from './common.js';

// rich menu picture (2500 × 843, three buttons) drawn here and sent to LINE through the server
function richMenuCanvas(store) {
  const c = document.createElement('canvas'); c.width = 2500; c.height = 843;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 2500, 843); grad.addColorStop(0, '#ff5a36'); grad.addColorStop(1, '#b3121c');
  g.fillStyle = grad; g.fillRect(0, 0, 2500, 843);
  const items = [['📦', 'ของใกล้หมด', 'ดูและเติมสต็อก'], ['🛒', 'รายการที่ต้องซื้อ', 'กดว่าซื้อแล้ว'], ['🏪', 'หน้าสต็อก', 'เปิดเว็บจัดการร้าน']];
  const w = 2500 / 3;
  items.forEach(([ico, t, s], i) => {
    const x = i * w;
    g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.roundRect(x + 40, 60, w - 80, 723, 60); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = '260px "Noto Color Emoji", "Apple Color Emoji", sans-serif'; g.fillText(ico, x + w / 2, 400);
    g.font = '700 110px Prompt, Sarabun, sans-serif'; g.fillText(t, x + w / 2, 585);
    g.font = '500 64px Sarabun, sans-serif'; g.globalAlpha = 0.85; g.fillText(s, x + w / 2, 690); g.globalAlpha = 1;
    if (i) { g.fillStyle = 'rgba(255,255,255,0.25)'; g.fillRect(x, 120, 4, 603); }
  });
  g.font = '600 44px Sarabun, sans-serif'; g.textAlign = 'right'; g.fillStyle = 'rgba(255,255,255,.7)'; g.fillText(store || '', 2460, 830);
  return c;
}

// owners' rich menu: 2500 × 1686, six buttons (3 × 2)
function ownerMenuCanvas(store) {
  const c = document.createElement('canvas'); c.width = 2500; c.height = 1686;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 2500, 1686); grad.addColorStop(0, '#2b1712'); grad.addColorStop(1, '#6b2a1c');
  g.fillStyle = grad; g.fillRect(0, 0, 2500, 1686);
  const items = [['🔴', 'ยอดขาย · Live View', 'ยอดวันนี้ บิลล่าสุด', '#e8321f'], ['📦', 'ของใกล้หมด', 'ดูและเติมสต็อก', '#f97316'], ['🛒', 'รายการที่ต้องซื้อ', 'กดว่าซื้อแล้ว', '#eab308'],
    ['🏪', 'หน้าสต็อก', 'เปิดเว็บสต็อก', '#0ea5e9'], ['⚙️', 'จัดการร้าน', 'ตั้งเมนู และอื่น ๆ', '#8b5cf6'], ['⭐', 'หลังบ้านสมาชิก', 'สมาชิก แต้ม รางวัล', '#ec4899']];
  const w = 2500 / 3, hh = 843;
  items.forEach(([ico, t, s2, col], i) => {
    const x = (i % 3) * w, y = Math.floor(i / 3) * hh;
    g.fillStyle = 'rgba(255,255,255,0.08)'; g.beginPath(); g.roundRect(x + 36, y + 36, w - 72, hh - 72, 64); g.fill();
    g.fillStyle = col; g.beginPath(); g.arc(x + w / 2, y + 300, 170, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.textAlign = 'center';
    g.font = '200px "Noto Color Emoji", "Apple Color Emoji", sans-serif'; g.fillText(ico, x + w / 2, y + 370);
    let fs = 96; do { g.font = `700 ${fs}px Prompt, Sarabun, sans-serif`; fs -= 4; } while (g.measureText(t).width > w - 120 && fs > 40); // long titles shrink to fit
    g.fillText(t, x + w / 2, y + 610);
    g.font = '500 60px Sarabun, sans-serif'; g.globalAlpha = 0.8; g.fillText(s2, x + w / 2, y + 710); g.globalAlpha = 1;
  });
  g.font = '600 44px Sarabun, sans-serif'; g.textAlign = 'right'; g.fillStyle = 'rgba(255,255,255,.6)'; g.fillText((store || '') + ' · เจ้าของร้าน', 2460, 1670);
  return c;
}

export async function linePage() {
  const s = await api.get('/line/settings');
  if (s.webhook_url.startsWith('/')) s.webhook_url = location.origin + s.webhook_url; // no PUBLIC_URL set on the server
  const shop = (await api.get('/settings')).store || {};
  const secret = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.has_secret ? '•••••• บันทึกแล้ว (ใส่ใหม่เพื่อเปลี่ยน)' : 'Channel secret' });
  const tokenIn = h('input', { class: 'input', type: 'password', autocomplete: 'off', placeholder: s.has_token ? '•••••• บันทึกแล้ว (ใส่ใหม่เพื่อเปลี่ยน)' : 'Channel access token (long-lived)' });
  const chk = (v, t) => { const i = h('input', { type: 'checkbox', checked: !!v }); return [i, h('label', { class: 'switch' }, i, t)]; };
  const [en, enL] = chk(s.enabled, 'เปิดใช้การแจ้งเตือนทาง LINE');
  const [low, lowL] = chk(s.notify_low, '⚠️ แจ้งทันทีเมื่อสินค้า/วัตถุดิบใกล้หมด (การ์ดพร้อมปุ่มเติมสต็อก / ใส่รายการซื้อ)');
  const [close, closeL] = chk(s.notify_close, '🛒 ตอนปิดรอบการขาย ส่งสรุปของใกล้หมดและรายการที่ต้องซื้อ');
  const [sale, saleL] = chk(s.notify_sale, '🧾 ส่งใบเสร็จทุกบิลให้เจ้าของ (ยอด รายการ เวลา เลขบิล และ QR ดูบิล)');
  const to = { low: new Set((s.to && s.to.low) || ['owner', 'staff']), close: new Set((s.to && s.to.close) || ['owner', 'staff']) };
  const toPick = (kind) => h('div', { class: 'row', style: { gap: '14px', margin: '.1em 0 .6em 2.2em' } }, [['owner', '👑 เจ้าของ'], ['staff', '👤 พนักงาน']].map(([r, t]) =>
    h('label', { class: 'switch small' }, h('input', { type: 'checkbox', checked: to[kind].has(r), onchange: (e) => { e.target.checked ? to[kind].add(r) : to[kind].delete(r); } }), 'ส่งให้ ' + t)));
  let recipients = s.recipients.slice();
  const recBox = h('div');
  // each chat: owner (everything: receipts, sales, stock) or staff (stock only)
  const drawRec = () => recBox.replaceChildren(recipients.length ? h('div', { class: 'line-rec', style: { display: 'grid', gap: '8px' } }, recipients.map((r) => h('div', { class: 'row', style: { gap: '10px', alignItems: 'center', padding: '8px 12px', borderRadius: '12px', background: 'var(--surface2)' } },
    h('b', { style: { flex: 1 } }, (r.type === 'group' ? '👥 ' : '💬 ') + r.name),
    h('select', { class: 'input', style: { maxWidth: '260px' }, onchange: (e) => { r.role = e.target.value; } }, [['owner', '👑 เจ้าของร้าน — ได้ทุกอย่าง'], ['staff', '👤 พนักงาน — ปรับสต็อกเท่านั้น']].map(([v, t]) => h('option', { value: v, selected: r.role === v }, t))),
    h('button', { class: 'icon-btn', title: 'เลิกส่งให้แชตนี้', onclick: () => { recipients = recipients.filter((x) => x.id !== r.id); drawRec(); } }, '✕'))))
    : h('p', { class: 'small muted' }, 'ยังไม่ได้เชื่อมแชต'));
  drawRec();
  // what is saved on the server: shown right under the key boxes (the keys themselves never come back)
  const keyStatus = h('div', { class: 'line-keys' });
  const drawKeys = (x) => {
    secret.placeholder = x.has_secret ? `✓ บันทึกแล้ว (${x.secret_hint}) — ใส่ใหม่เฉพาะถ้าจะเปลี่ยน` : 'Channel secret (32 ตัว)';
    tokenIn.placeholder = x.has_token ? `✓ บันทึกแล้ว (${x.token_hint}) — ใส่ใหม่เฉพาะถ้าจะเปลี่ยน` : 'Channel access token (long-lived)';
    keyStatus.replaceChildren(
      h('span', { class: 'badge ' + (x.has_secret ? 'ok' : 'bad') }, x.has_secret ? `✓ Channel secret บันทึกแล้ว ${x.secret_hint}` : '✗ ยังไม่มี Channel secret'),
      h('span', { class: 'badge ' + (x.has_token ? 'ok' : 'bad') }, x.has_token ? `✓ Access token บันทึกแล้ว ${x.token_hint}` : '✗ ยังไม่มี Access token'),
      x.bot && x.bot.name ? h('span', { class: 'badge info' }, `💬 เชื่อมกับ OA: ${x.bot.name} ${x.bot.basic_id || ''}`) : null);
  };
  drawKeys(s);
  const save = async () => {
    await api.put('/line/settings', { enabled: en.checked, notify_low: low.checked, notify_close: close.checked, notify_sale: sale.checked, to: { low: [...to.low], close: [...to.close] },
      channel_secret: secret.value, channel_token: tokenIn.value, recipients: recipients.map((r) => r.id), roles: Object.fromEntries(recipients.map((r) => [r.id, r.role])) });
    const typed = secret.value || tokenIn.value;
    secret.value = ''; tokenIn.value = '';
    const now = await api.get('/line/settings'); drawKeys(now);
    if (typed) toast('✓ บันทึกคีย์ LINE แล้ว' + (now.bot && now.bot.name ? ` — OA: ${now.bot.name}` : ''), 'ok', 5000);
  };
  // one-time code: send it to the LINE OA (1:1 chat, or a group the OA was invited to)
  const codeBox = h('div', { class: 'line-code' });
  const linkCode = async (role) => {
    try {
      await save();
      const { code } = await api.post('/line/link-code', { role });
      codeBox.replaceChildren(h('div', { class: 'big' }, code), h('small', {}, `${role === 'staff' ? '👤 สำหรับพนักงาน (ปรับสต็อกเท่านั้น)' : '👑 สำหรับเจ้าของร้าน (ได้ทุกอย่าง)'} — ส่งรหัสนี้เข้าไปในแชตกับ LINE OA ของร้าน (แชตส่วนตัว หรือกลุ่มที่เชิญบอทเข้าไปแล้ว) ภายใน 10 นาที`));
      const n0 = recipients.length, t0 = Date.now();
      const poll = setInterval(async () => {
        if (!document.body.contains(codeBox) || Date.now() - t0 > 10 * 60e3) return clearInterval(poll);
        const now = await api.get('/line/settings').catch(() => null);
        if (now && now.recipients.length > n0) { clearInterval(poll); recipients = now.recipients; drawRec(); en.checked = true; codeBox.replaceChildren(h('div', { class: 'ok' }, '✅ เชื่อมต่อแล้ว: ' + now.recipients[now.recipients.length - 1].name)); }
      }, 3000);
    } catch (e) { errToast(e); }
  };
  const menuCanvas = richMenuCanvas(shop.name);
  menuCanvas.className = 'line-menu-prev';
  const ownerCanvas = ownerMenuCanvas(shop.name);
  ownerCanvas.className = 'line-menu-prev';
  const installMenu = async (e) => {
    e.target.disabled = true;
    try { await save(); await api.post('/line/richmenu', { image: menuCanvas.toDataURL('image/jpeg', 0.85), owner_image: ownerCanvas.toDataURL('image/jpeg', 0.85) }); toast('ติดตั้งริชเมนูใน LINE แล้ว — เจ้าของร้านได้เมนู 6 ช่อง พนักงานได้เมนูสต็อก (ปิดแล้วเปิดแชต OA ใหม่เพื่อดู)', 'ok', 7000); } catch (er) { errToast(er); } finally { e.target.disabled = false; }
  };
  return page('LINE เจ้าของร้านและสต็อก',
    card(h('h3', {}, '1. เชื่อม LINE Official Account'),
      h('ol', { class: 'small line-steps' },
        h('li', {}, 'สร้าง LINE Official Account ของร้าน แล้วเปิด Messaging API (manager.line.biz → ตั้งค่า → Messaging API)'),
        h('li', {}, 'ที่ developers.line.biz → Channel ของร้าน: คัดลอก Channel secret และกด Issue "Channel access token (long-lived)" มาใส่ด้านล่าง'),
        h('li', {}, 'ใส่ Webhook URL ด้านล่าง กด Verify และเปิด "Use webhook" · ปิด "Auto-reply messages"')),
      h('div', { class: 'form-grid' }, h('label', { class: 'field' }, 'Channel secret', secret), h('label', { class: 'field' }, 'Channel access token', tokenIn)),
      h('label', { class: 'field' }, 'Webhook URL', h('div', { class: 'row' }, h('input', { class: 'input', readonly: true, value: s.webhook_url, style: { flex: 1 } }),
        h('button', { class: 'btn', onclick: () => navigator.clipboard.writeText(s.webhook_url).then(() => toast('คัดลอกแล้ว', 'ok')) }, 'คัดลอก'))),
      keyStatus,
      h('div', { style: { marginTop: '.6em' } }, saveBtn('💾 บันทึกคีย์', save)),
      h('p', { class: 'small muted' }, 'คีย์ทั้งสองเก็บไว้ที่เซิร์ฟเวอร์เท่านั้น ไม่แสดงกลับในเบราว์เซอร์ (แสดงแค่ 4 ตัวท้ายให้รู้ว่าบันทึกแล้ว) · ระบบตรวจ token กับ LINE ก่อนบันทึก')),
    card(h('h3', {}, '2. เชื่อมแชตและกำหนดสิทธิ์'),
      h('p', { class: 'small muted' }, '👑 เจ้าของร้าน: ใบเสร็จทุกบิล · ยอดขายวันนี้ · Live View · สต็อก · จัดการร้าน · สมาชิก  —  👤 พนักงาน: ดูของใกล้หมด เติมสต็อก รายการที่ต้องซื้อ เท่านั้น (ไม่เห็นยอดขาย) · เปลี่ยนสิทธิ์แล้วกดบันทึก'),
      recBox, h('div', { class: 'row', style: { gap: '8px', marginTop: '.6em' } }, h('button', { class: 'btn primary', onclick: () => linkCode('owner') }, '🔗 รหัสเชื่อมต่อ — เจ้าของร้าน'), h('button', { class: 'btn', onclick: () => linkCode('staff') }, '🔗 รหัสเชื่อมต่อ — พนักงาน')), codeBox,
      h('div', { style: { marginTop: '.6em' } }, saveBtn('บันทึกสิทธิ์', save))),
    card(h('h3', {}, '3. แจ้งเตือน'), h('div', { class: 'line-opts' }, enL, saleL,
      !s.public_https ? h('p', { class: 'small', style: { color: 'var(--warn)', margin: '0 0 .4em 2.2em' } }, 'ปุ่ม "ดูบิล" และ QR ในใบเสร็จต้องใช้เว็บ https (ตั้ง PUBLIC_URL) — ตอนนี้จะส่งเฉพาะรายละเอียดบิล') : null,
      h('p', { class: 'small muted', style: { margin: '0 0 .6em 2.2em' } }, 'ส่งเฉพาะแชตเจ้าของร้าน · ทุกบิลนับเป็น 1 ข้อความในโควตาข้อความรายเดือนของ LINE OA (ร้านขายเยอะควรใช้แพ็กเกจที่ส่งได้พอ)'),
      lowL, toPick('low'), closeL, toPick('close')),
      h('div', { class: 'row', style: { marginTop: '.8em' } }, saveBtn('บันทึก', save), h('button', { class: 'btn', onclick: () => save().then(() => api.post('/line/test', {})).then((r) => toast(`ส่งทดสอบแล้ว ${r.sent} แชต`, 'ok')).catch(errToast) }, '🔔 ส่งทดสอบ'))),
    card(h('h3', {}, '4. ริชเมนูใน LINE'),
      h('p', { class: 'small muted' }, '👑 เจ้าของร้าน (6 ช่อง): ยอดขาย·Live View · ของใกล้หมด · รายการที่ต้องซื้อ · หน้าสต็อก · จัดการร้าน · หลังบ้านสมาชิก — ปุ่ม "ยอดขาย" ตอบยอดวันนี้ในแชตพร้อมปุ่มเปิด Live View หน้าร้าน'), ownerCanvas,
      h('p', { class: 'small muted', style: { marginTop: '1em' } }, '👤 พนักงาน: ของใกล้หมด · รายการที่ต้องซื้อ · หน้าสต็อก'), menuCanvas,
      h('p', { class: 'small muted' }, 'ริชเมนูแสดงในแชตส่วนตัวกับ OA เท่านั้น (ในกลุ่ม LINE ไม่มีริชเมนู — พิมพ์ "ยอด" / "สต็อก" / "ซื้อ" แทน)'),
      h('button', { class: 'btn primary', style: { marginTop: '.6em' }, onclick: installMenu }, '📲 ติดตั้งริชเมนูใน LINE')));
}
