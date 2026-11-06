// Every piece of text on the customer display, grouped for the admin editor.
// The shop can override any of them (settings.display.texts); empty = the default shown here.
// {n}, {amount}, {points}, {lines}, {pcs} are filled in by the display.
export const DISPLAY_TEXTS = [
  ['หน้าต้อนรับ (ไม่มีการขาย)', [
    ['idle_pill', 'ป้ายใต้ชื่อร้าน', '🍜 สั่งได้เลยที่เคาน์เตอร์ · 감사합니다'],
  ]],
  ['รายการสินค้า', [
    ['order_kicker', 'หัวข้อเล็ก', 'Your order'],
    ['order_title', 'หัวข้อ', 'รายการของคุณ'],
    ['dine_in', 'ทานที่ร้าน', '🍽️ ทานที่ร้าน'],
    ['takeaway', 'กลับบ้าน', '🥡 กลับบ้าน'],
    ['mixed', 'ทานที่ร้าน + กลับบ้าน', '🍽️ ทานที่ร้าน + 🥡'],
    ['takeaway_tag', 'ป้ายรายการกลับบ้าน (บิลผสม)', 'กลับบ้าน'],
    ['dine_question', 'คำถามเริ่มบิล (ทานที่ร้าน/กลับบ้าน)', 'ทานที่ร้าน หรือ กลับบ้าน?'],
    ['table', 'โต๊ะ', '🪑 โต๊ะ'],
    ['member_hello', 'ทักทายสมาชิก', 'สวัสดีคุณ'],
    ['member_tier', 'ระดับสมาชิก', 'สมาชิก'],
    ['member_points', 'แต้มสะสม', 'แต้มสะสม'],
    ['latest', 'ป้ายรายการล่าสุด', 'ล่าสุด'],
    ['last_added', 'แถบสินค้าที่เพิ่มล่าสุด', '🆕 เพิ่มล่าสุด'],
    ['more_up', 'มีรายการด้านบน', '▲ อีก {n} รายการด้านบน'],
    ['more_down', 'มีรายการด้านล่าง', '▼ อีก {n} รายการด้านล่าง'],
    ['subtotal', 'รวมค่าอาหาร', 'รวมค่าอาหาร'],
    ['discount', 'ส่วนลด', 'ส่วนลด'],
    ['packaging', 'ค่าบรรจุภัณฑ์', 'ค่าบรรจุภัณฑ์'],
    ['vat', 'ภาษี', 'VAT'],
    ['total', 'ยอดรวม', 'ยอดรวม'],
    ['count', 'จำนวนรายการ/ชิ้น', '{lines} รายการ · {pcs} ชิ้น'],
  ]],
  ['ชำระเงิน', [
    ['pay_due', 'ยอดที่ต้องชำระ', 'ยอดที่ต้องชำระ'],
    ['queue', 'ป้ายเลขคิว', 'คิว'],
    ['saved', 'ป้ายประหยัด', '🎉 ประหยัดไป {amount} บาท'],
    ['earn', 'ป้ายแต้มที่จะได้', '⭐ บิลนี้ได้ +{points} แต้ม'],
    ['cash_title', 'เงินสด: หัวข้อ', 'ชำระด้วยเงินสด'],
    ['cash_sub', 'เงินสด: หัวข้อเล็ก', 'Cash payment'],
    ['received', 'เงินสด: รับเงิน', '💵 รับเงิน'],
    ['short', 'เงินสด: ยังขาด', 'ยังขาดอีก {amount} บาท'],
    ['paid_exact', 'เงินสด: รับพอดี', '✓ รับเงินครบแล้ว · พอดี ไม่มีเงินทอน'],
    ['change', 'เงินสด: เงินทอน', '💰 เงินทอน'],
    ['status_wait', 'สถานะ: รอชำระ', 'รอชำระเงิน'],
    ['status_wait_qr', 'สถานะ: รอสแกน QR', 'รอชำระเงิน · สแกนด้วยแอปธนาคารใดก็ได้'],
    ['status_paid', 'สถานะ: รับครบ', 'รับเงินครบ'],
    ['status_paid_change', 'สถานะ: รับครบ มีเงินทอน', 'รับเงินครบ · รอรับเงินทอน'],
    ['qr_title', 'QR: หัวการ์ด', 'THAI QR PAYMENT'],
    ['qr_sub', 'QR: หัวการ์ดบรรทัดสอง', 'พร้อมเพย์ · PromptPay'],
    ['qr_loading', 'QR: กำลังโหลด', 'กำลังสร้าง QR'],
    ['qr_error', 'QR: โหลดไม่สำเร็จ', 'โหลด QR ไม่สำเร็จ · แจ้งพนักงาน'],
    ['qr_account', 'QR: ชื่อบัญชี', 'ชื่อบัญชี'],
    ['qr_scan', 'QR: สแกนจ่าย', 'สแกนจ่าย'],
    ['qr_banks', 'QR: บรรทัดล่าง', 'สแกนได้ทุกแอปธนาคาร'],
  ]],
  ['หน้าขอบคุณ (หลังชำระ)', [
    ['done_title', 'หัวข้อ', 'ชำระเงินเรียบร้อย'],
    ['done_sub', 'หัวข้อเล็ก', 'Payment complete'],
    ['done_queue', 'เลขคิว', 'เลขคิวของคุณ · Your queue'],
    ['done_total', 'การ์ด: ยอดชำระ', 'ยอดชำระ'],
    ['done_method', 'การ์ด: ชำระด้วย', 'ชำระด้วย'],
    ['done_change', 'การ์ด: เงินทอน', 'เงินทอน'],
    ['done_saved', 'การ์ด: ประหยัด', 'ประหยัดไป'],
    ['done_points', 'การ์ด: แต้ม', 'แต้มที่ได้รับ'],
    ['thanks_more', 'คำขอบคุณที่สลับแสดง (คั่นด้วย |)', '감사합니다|Thank you!'],
    ['hint_queue', 'ข้อความล่าง (มีคิว)', 'กรุณารอเรียกคิวสักครู่นะคะ 🙏'],
    ['hint_noqueue', 'ข้อความล่าง (ไม่มีคิว)', 'ขอให้อร่อยนะคะ 🍜'],
    ['bye', 'คำลาตอนกดเสร็จ', 'แล้วพบกันใหม่นะคะ'],
    ['bye_sub', 'คำลาบรรทัดสอง', 'See you again · 또 만나요'],
  ]],
];
export const TEXT_DEFAULTS = Object.fromEntries(DISPLAY_TEXTS.flatMap(([, rows]) => rows.map(([k, , v]) => [k, v])));

// Colours and effects of the customer display (settings.display.style); empty = default.
export const DISPLAY_STYLE_DEFAULTS = {
  bg2: '', card: '#ffffff', card_opacity: 8, ok: '#22c55e', warn: '#facc15', gold: '#f6c453', highlight: '', qty: '', total_from: '#ffffff', total_to: '',
  qr_head: '#0f2a5f', pay_head: '', member_text: '#3b2304',
  items_scale: 100, total_scale: 100, queue_scale: 100, corners: 'round',
  motion: 'normal', bg_effect: 'blobs', confetti: true, fireworks: true, floaters: true, money_fx: true, shine: true, ring: true, latest_fx: true, sparks: true,
};

// The customer display in English / Chinese (the cashier switches it per bill on the POS).
// Shop edits (settings.display.texts) are Thai; these are the built-in other languages.
export const LANG_NAMES = { th: 'ไทย', en: 'English', zh: '中文' };
export const TEXT_I18N = {
  en: {
    idle_pill: '🍜 Order at the counter · 감사합니다', order_kicker: 'Your order', order_title: 'Your order', dine_in: '🍽️ Dine in', takeaway: '🥡 Take away',
    mixed: '🍽️ Dine in + 🥡', takeaway_tag: 'Take away', dine_question: 'Dine in or take away?', table: '🪑 Table', member_hello: 'Hello', member_tier: 'Member',
    member_points: 'Points', latest: 'Latest', last_added: '🆕 Just added', more_up: '▲ {n} more above', more_down: '▼ {n} more below', subtotal: 'Subtotal',
    discount: 'Discount', packaging: 'Packaging', vat: 'VAT', total: 'Total', count: '{lines} items · {pcs} pcs', pay_due: 'Amount due', queue: 'Queue',
    saved: '🎉 You saved {amount} baht', earn: '⭐ +{points} points for this bill', cash_title: 'Cash payment', cash_sub: 'ชำระด้วยเงินสด', received: '💵 Received',
    short: '{amount} baht short', paid_exact: '✓ Paid in full · exact amount', change: '💰 Change', status_wait: 'Waiting for payment',
    status_wait_qr: 'Waiting for payment · scan with any banking app', status_paid: 'Paid in full', status_paid_change: 'Paid · please take your change',
    qr_title: 'THAI QR PAYMENT', qr_sub: 'PromptPay', qr_loading: 'Making the QR', qr_error: 'Could not load the QR · please tell our staff', qr_account: 'Account name',
    qr_scan: 'Scan to pay', qr_banks: 'Works with every banking app', done_title: 'Payment complete', done_sub: 'Thank you', done_queue: 'Your queue number',
    done_total: 'Paid', done_method: 'Paid by', done_change: 'Change', done_saved: 'You saved', done_points: 'Points earned', thanks_more: 'Thank you!|감사합니다|谢谢',
    hint_queue: 'Please wait for your number to be called 🙏', hint_noqueue: 'Enjoy your meal 🍜', bye: 'See you again', bye_sub: '또 만나요 · 再见',
    from_country: 'Product of', pop_kicker: '✨ About this dish', welcome: 'Welcome', thanks: 'Thank you!', unit: 'bowls',
    spice: ['Not spicy', 'Mild', 'Medium', 'Hot', 'Very hot', 'Extreme'],
  },
  zh: {
    idle_pill: '🍜 请到柜台点餐 · 감사합니다', order_kicker: 'Your order', order_title: '您的订单', dine_in: '🍽️ 堂食', takeaway: '🥡 外带',
    mixed: '🍽️ 堂食 + 🥡', takeaway_tag: '外带', dine_question: '堂食还是外带？', table: '🪑 桌号', member_hello: '您好', member_tier: '会员',
    member_points: '积分', latest: '最新', last_added: '🆕 刚加入', more_up: '▲ 上方还有 {n} 项', more_down: '▼ 下方还有 {n} 项', subtotal: '餐费小计',
    discount: '折扣', packaging: '打包费', vat: '增值税', total: '合计', count: '{lines} 项 · {pcs} 件', pay_due: '应付金额', queue: '取餐号',
    saved: '🎉 已为您节省 {amount} 泰铢', earn: '⭐ 本单可得 +{points} 积分', cash_title: '现金支付', cash_sub: 'Cash payment', received: '💵 已收',
    short: '还差 {amount} 泰铢', paid_exact: '✓ 已付清 · 无需找零', change: '💰 找零', status_wait: '等待付款',
    status_wait_qr: '等待付款 · 任意银行App扫码', status_paid: '已付清', status_paid_change: '已付清 · 请收好找零',
    qr_title: 'THAI QR PAYMENT', qr_sub: 'PromptPay 即时转账', qr_loading: '正在生成二维码', qr_error: '二维码加载失败 · 请告知店员', qr_account: '收款人',
    qr_scan: '扫码支付', qr_banks: '支持所有银行App', done_title: '支付成功', done_sub: 'Payment complete', done_queue: '您的取餐号',
    done_total: '实付', done_method: '支付方式', done_change: '找零', done_saved: '节省', done_points: '获得积分', thanks_more: '谢谢！|감사합니다|Thank you!',
    hint_queue: '请稍候叫号 🙏', hint_noqueue: '祝您用餐愉快 🍜', bye: '欢迎再次光临', bye_sub: 'See you again · 또 만나요',
    from_country: '产地', pop_kicker: '✨ 了解这道菜', welcome: '欢迎光临', thanks: '谢谢！', unit: '碗',
    spice: ['不辣', '微辣', '中辣', '辣', '很辣', '特辣'],
  },
};
