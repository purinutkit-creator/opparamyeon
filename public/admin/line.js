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
  let recipients = s.recipients.slice();
  const recBox = h('div');
  const drawRec = () => recBox.replaceChildren(recipients.length ? h('div', { class: 'line-rec' }, recipients.map((r) => h('div', { class: 'chip on' }, (r.type === 'group' ? '👥 ' : '👤 ') + r.name,
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
    await api.put('/line/settings', { enabled: en.checked, notify_low: low.checked, notify_close: close.checked, channel_secret: secret.value, channel_token: tokenIn.value, recipients: recipients.map((r) => r.id) });
    const typed = secret.value || tokenIn.value;
    secret.value = ''; tokenIn.value = '';
    const now = await api.get('/line/settings'); drawKeys(now);
    if (typed) toast('✓ บันทึกคีย์ LINE แล้ว' + (now.bot && now.bot.name ? ` — OA: ${now.bot.name}` : ''), 'ok', 5000);
  };
  // one-time code: send it to the LINE OA (1:1 chat, or a group the OA was invited to)
  const codeBox = h('div', { class: 'line-code' });
  const linkCode = async () => {
    try {
      await save();
      const { code } = await api.post('/line/link-code', {});
      codeBox.replaceChildren(h('div', { class: 'big' }, code), h('small', {}, 'ส่งรหัสนี้เข้าไปในแชตกับ LINE OA ของร้าน (แชตส่วนตัว หรือกลุ่มที่เชิญบอทเข้าไปแล้ว) ภายใน 10 นาที'));
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
  const installMenu = async (e) => {
    e.target.disabled = true;
    try { await save(); await api.post('/line/richmenu', { image: menuCanvas.toDataURL('image/jpeg', 0.85) }); toast('ติดตั้งริชเมนูใน LINE แล้ว — เปิดแชต OA เพื่อดู', 'ok', 6000); } catch (er) { errToast(er); } finally { e.target.disabled = false; }
  };
  return page('LINE แจ้งเตือนสต็อก',
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
    card(h('h3', {}, '2. เชื่อมแชตที่จะรับแจ้งเตือน'), recBox, h('button', { class: 'btn primary', onclick: linkCode }, '🔗 สร้างรหัสเชื่อมต่อ'), codeBox),
    card(h('h3', {}, '3. แจ้งเตือน'), h('div', { class: 'line-opts' }, enL, lowL, closeL),
      h('div', { class: 'row', style: { marginTop: '.8em' } }, saveBtn('บันทึก', save), h('button', { class: 'btn', onclick: () => save().then(() => api.post('/line/test', {})).then((r) => toast(`ส่งทดสอบแล้ว ${r.sent} แชต`, 'ok')).catch(errToast) }, '🔔 ส่งทดสอบ'))),
    card(h('h3', {}, '4. ริชเมนูใน LINE'), h('p', { class: 'small muted' }, 'เมนูด้านล่างแชต: ของใกล้หมด · รายการที่ต้องซื้อ · เปิดหน้าสต็อก'), menuCanvas,
      h('button', { class: 'btn primary', style: { marginTop: '.6em' }, onclick: installMenu }, '📲 ติดตั้งริชเมนูใน LINE')));
}
