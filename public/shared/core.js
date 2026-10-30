// Pure logic shared by the server (Node) and the browser.
// Money is always an integer number of satang (1 บาท = 100 satang).

export const VERSION = '1.22.0';

export const baht = (satang) => {
  const v = (Number(satang) || 0) / 100;
  return v.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
export const toSatang = (bahtValue) => Math.round((Number(bahtValue) || 0) * 100);

export const DINE = { dine_in: 'ทานที่ร้าน', takeaway: 'กลับบ้าน' };
export const dineLabel = (t) => DINE[t] || (t === 'mixed' ? 'ทานที่ร้าน + กลับบ้าน' : t || '');

// ---------- cart ----------
// A cart line: { key, product_id, name, qty, unit_price, options:[{group,name,price,cost}], note,
//                dine_type, bowl_group, bowl_count, station_id, cost_unit }
export function optionsKey(options = []) {
  return options.map((o) => `${o.group_id || o.group}:${o.id || o.name}`).sort().join('|');
}

// Adds a product to the cart. A repeated scan of the same product (same options, dine type,
// bowl group and no note) increases the quantity of the existing line.
export function addToCart(cart, product, { qty = 1, options = [], dine_type, bowl_group = null, note = '' } = {}) {
  const dt = dine_type || cart.dine_type || 'dine_in';
  const ok = optionsKey(options);
  const same = cart.lines.find((l) => !l.id_locked && l.product_id === product.id && optionsKey(l.options) === ok &&
    l.dine_type === dt && (l.bowl_group || null) === (bowl_group || null) && !l.note && !note);
  if (same) { same.qty += qty; return same; }
  const line = {
    key: Math.random().toString(36).slice(2, 10),
    product_id: product.id, name: product.name, qty,
    unit_price: product.price, cost_unit: product.cost || 0,
    options, note, dine_type: dt, bowl_group,
    bowl_count: Number(product.bowl_count) || 0, station_id: product.station_id || null,
  };
  cart.lines.push(line);
  return line;
}

export const lineUnitTotal = (l) => l.unit_price + (l.options || []).reduce((s, o) => s + (o.price || 0), 0);
export const lineTotal = (l) => lineUnitTotal(l) * l.qty;

// Bowl rules:
//  - Lines without a bowl group: bowls = bowl_count × qty (a "set คู่" with bowl_count 2 → 2 bowls each).
//  - Lines sharing a bowl group are one bowl: group bowls = max(bowl_count × qty) of its lines,
//    so 2 packets of noodles + egg + cheese in "ชามที่ 1" count as 1 bowl.
export function countBowls(lines) {
  let total = 0;
  const groups = new Map();
  for (const l of lines) {
    const q = l.qty - (l.void_qty || 0);
    if (q <= 0) continue;
    const b = (Number(l.bowl_count) || 0) * q;
    if (l.bowl_group) groups.set(l.bowl_group, Math.max(groups.get(l.bowl_group) || 0, b));
    else total += b;
  }
  for (const v of groups.values()) total += v;
  return total;
}

// totals: { items_total, discount, packaging, service, tax, total, bowls }
// settings: { tax_rate (percent), tax_inclusive, packaging_fee (satang per takeaway bowl), packaging_mode }
export function computeTotals(lines, settings = {}, discount = { type: 'amount', value: 0 }) {
  const active = lines.map((l) => ({ ...l, qty: l.qty - (l.void_qty || 0), void_qty: 0 })).filter((l) => l.qty > 0);
  const items_total = active.reduce((s, l) => s + lineTotal(l), 0);
  let disc = 0;
  if (discount && discount.value) {
    disc = discount.type === 'percent' ? Math.round(items_total * Math.min(100, discount.value) / 100) : Math.round(discount.value);
  }
  disc = Math.max(0, Math.min(disc, items_total));
  const takeawayBowls = countBowls(active.filter((l) => l.dine_type === 'takeaway'));
  const packaging = settings.packaging_fee ? (settings.packaging_mode === 'per_order'
    ? (active.some((l) => l.dine_type === 'takeaway') ? settings.packaging_fee : 0)
    : takeawayBowls * settings.packaging_fee) : 0;
  const base = items_total - disc + packaging;
  const rate = Number(settings.tax_rate) || 0;
  let tax = 0, total = base;
  if (rate > 0) {
    if (settings.tax_inclusive) tax = Math.round(base - base / (1 + rate / 100));
    else { tax = Math.round(base * rate / 100); total = base + tax; }
  }
  const cost = active.reduce((s, l) => s + (l.cost_unit + (l.options || []).reduce((a, o) => a + (o.cost || 0), 0)) * l.qty, 0);
  return { items_total, discount: disc, packaging, tax, total, bowls: countBowls(active), cost };
}

export function orderDineType(lines) {
  const set = new Set(lines.filter((l) => l.qty - (l.void_qty || 0) > 0).map((l) => l.dine_type));
  if (set.size > 1) return 'mixed';
  return [...set][0] || 'dine_in';
}

// ---------- kitchen ticket split ----------
// mode: 'order' | 'item' | 'bowl' | 'bowl_group'; perCut: bowls per ticket (bowl modes)
// Toppings that share a bowl group with a bowl always stay on the same ticket.
export function splitTickets(lines, mode = 'order', perCut = 1) {
  const items = lines.filter((l) => l.qty > 0);
  if (!items.length) return [];
  if (mode === 'order') return [{ label: '', lines: items }];
  if (mode === 'item') return items.map((l) => ({ label: '', lines: [l] }));
  // bowl based: build bowls
  const bowls = []; // { label, lines }
  const groups = new Map();
  const loose = [];
  for (const l of items) {
    if (l.bowl_group) {
      if (!groups.has(l.bowl_group)) groups.set(l.bowl_group, []);
      groups.get(l.bowl_group).push(l);
    } else if ((Number(l.bowl_count) || 0) > 0) {
      if (mode === 'bowl') for (let i = 0; i < l.qty; i++) bowls.push({ label: '', lines: [{ ...l, qty: 1 }], n: l.bowl_count });
      else bowls.push({ label: '', lines: [l], n: l.bowl_count * l.qty });
    } else loose.push(l);
  }
  for (const [g, ls] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    bowls.push({ label: `ชามที่ ${g}`, lines: ls, n: Math.max(1, ...ls.map((x) => (x.bowl_count || 0) * x.qty)) });
  }
  const per = Math.max(1, Number(perCut) || 1);
  const tickets = [];
  let cur = null;
  for (const b of bowls) {
    if (!cur || cur.n + b.n > per && cur.n > 0) { cur = { label: '', lines: [], n: 0, labels: [] }; tickets.push(cur); }
    cur.lines.push(...b.lines.map((x) => ({ ...x, bowl_label: b.label })));
    cur.n += b.n;
    if (b.label) cur.labels.push(b.label);
  }
  for (const t of tickets) t.label = t.labels.join(', ');
  if (loose.length) tickets.push({ label: 'รายการอื่น', lines: loose, n: 0 });
  return tickets.map((t, i) => ({ label: t.label, index: i + 1, count: tickets.length, lines: t.lines }));
}

// ---------- business day ----------
// rules: [{ effective_from:'YYYY-MM-DD', cutoff:'HH:MM', timezone }] — the rule whose effective_from
// is the latest one not after the candidate business date applies.
export function localParts(date, timeZone = 'Asia/Bangkok') {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const toMin = (hhmm) => { const [h, m] = String(hhmm || '00:00').split(':').map(Number); return h * 60 + (m || 0); };
export function ruleFor(rules, ymd) {
  const sorted = [...(rules || [])].sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  let r = sorted[0] || { cutoff: '00:00', timezone: 'Asia/Bangkok', effective_from: '1970-01-01' };
  for (const x of sorted) if (x.effective_from <= ymd) r = x;
  return r;
}
export function businessDate(when, rules) {
  const date = when instanceof Date ? when : new Date(when);
  const tz = (rules && rules[0] && rules[0].timezone) || 'Asia/Bangkok';
  const lp = localParts(date, tz);
  // try "today" first with the rule effective today, then fall back to yesterday
  const rToday = ruleFor(rules, lp.date);
  if (lp.minutes >= toMin(rToday.cutoff)) return lp.date;
  return addDays(lp.date, -1);
}
// Real start/end instants (ISO) for a business date range, for display ("ช่วงเวลาจริง").
export function businessRange(fromYmd, toYmd, rules) {
  const tz = (rules && rules[0] && rules[0].timezone) || 'Asia/Bangkok';
  const start = ruleFor(rules, fromYmd).cutoff;
  const end = ruleFor(rules, addDays(toYmd, 1)).cutoff;
  return { start: `${fromYmd} ${start}`, end: `${addDays(toYmd, 1)} ${end}`, timezone: tz };
}

// ---------- phone ----------
export function normalizePhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.startsWith('66') && d.length === 11) d = '0' + d.slice(2);
  if (!/^0\d{8,9}$/.test(d)) return null;
  return d;
}
export const maskPhone = (p) => (p ? p.slice(0, 3) + '-xxx-' + p.slice(-4) : '');
export const maskName = (n) => (n ? [...n].slice(0, 2).join('') + '***' : '');
export const defaultPassword = (phone) => String(phone).slice(-4); // keep as text: "0123" stays "0123"

// ---------- template variables ----------
export function fillVars(text, data) {
  return String(text || '').replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined && data[k] !== null ? String(data[k]) : ''));
}

// ---------- points ----------
// cfg: { rate_baht (baht per point), rounding: floor|round|ceil, base: after_discount|before_discount,
//        include_tax, include_packaging, min_spend (satang), excluded_products:[] }
export function pointsFor(order, items, cfg = {}, multiplier = 1) {
  // line_total is the value of the non-voided quantity; refunded units are removed proportionally
  const eligible = items.filter((i) => !(cfg.excluded_products || []).includes(i.product_id)).reduce((s, i) => {
    const eff = i.qty - (i.void_qty || 0);
    return s + (eff > 0 ? i.line_total * (eff - (i.refunded_qty || 0)) / eff : 0);
  }, 0);
  const itemsAll = order.items_total || 1;
  let base = eligible;
  if (cfg.base !== 'before_discount') base -= Math.round((order.discount || 0) * eligible / itemsAll);
  if (cfg.include_packaging) base += order.packaging || 0;
  if (cfg.include_tax && order.tax && !cfg.tax_inclusive) base += order.tax;
  if (base < (cfg.min_spend || 0)) return { base, points: 0 };
  const per = Math.max(1, toSatang(cfg.rate_baht || 25));
  const raw = (base / per) * (multiplier || 1);
  const fn = cfg.rounding === 'ceil' ? Math.ceil : cfg.rounding === 'round' ? Math.round : Math.floor;
  return { base, points: Math.max(0, fn(raw)) };
}

// ---------- PromptPay (EMVCo) ----------
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
    crc &= 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
const tlv = (id, v) => id + String(v.length).padStart(2, '0') + v;
// id: phone (0812345678), national id / tax id (13 digits) or e-wallet (15 digits)
export function promptPayPayload(id, amountSatang) {
  const digits = String(id || '').replace(/\D/g, '');
  let target;
  if (digits.length >= 15) target = tlv('03', digits);
  else if (digits.length >= 13) target = tlv('02', digits);
  else target = tlv('01', ('0000000000000' + digits.replace(/^0/, '66')).slice(-13));
  const merchant = tlv('00', 'A000000677010111') + target;
  let p = tlv('00', '01') + tlv('01', amountSatang ? '12' : '11') + tlv('29', merchant) + tlv('58', 'TH') + tlv('53', '764');
  if (amountSatang) p += tlv('54', (amountSatang / 100).toFixed(2));
  p += '6304';
  return p + crc16(p);
}

// ---------- Code128 (subset B) ----------
const C128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
// returns array of module widths (bar, space, bar, ...)
export function code128(text) {
  const codes = [104];
  for (const ch of String(text)) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) throw new Error('barcode: ASCII only'); codes.push(c - 32); }
  let sum = codes[0];
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, 106);
  return codes.map((c) => C128[c]).join('').split('').map(Number);
}

// option kind for tickets/receipts: add-on (extra the customer added) vs choice (required pick); older orders: priced = add-on
export const isAddon = (o) => (o && o.addon !== undefined ? !!o.addon : !!(o && o.price > 0));

// Yes/no choices (e.g. group "โรยสาหร่ายไหม": โรย / ไม่โรย) can show on the customer display as a topic with ✓ or ✗.
// The topic is the group's own setting, or its name without the trailing question word.
export const optionTopic = (g) => String((g && (g.topic || g.name)) || '').replace(/\s*(ไหม|มั้ย|มั๊ย|หรือไม่|ไม๊)\s*[?？]*$/, '').trim();
export const markOf = (g, o) => (o && (o.mark === 'yes' || o.mark === 'no') ? { mark: o.mark, topic: optionTopic(g) } : {});
// text for one chosen option on the customer display: "✓ โรยสาหร่าย" / "✗ โรยสาหร่าย" / "+ ชีส" / "เผ็ดกลาง"
export const displayOption = (o) => (o.mark && o.topic ? (o.mark === 'yes' ? '✓ ' : '✗ ') + o.topic : (isAddon(o) ? '+ ' : '') + o.name);

// Barcode scanners type like a keyboard: with the device set to Thai (Kedmanee) "885392" arrives as "คคถ-ต/".
// fromThaiKeys turns such text back into what the keys were (only when it actually contains Thai characters).
const TH_KEYS = { 'ๅ': '1', '/': '2', '-': '3', 'ภ': '4', 'ถ': '5', 'ุ': '6', 'ึ': '7', 'ค': '8', 'ต': '9', 'จ': '0', 'ข': '-', 'ช': '=',
  'ๆ': 'q', 'ไ': 'w', 'ำ': 'e', 'พ': 'r', 'ะ': 't', 'ั': 'y', 'ี': 'u', 'ร': 'i', 'น': 'o', 'ย': 'p', 'บ': '[', 'ล': ']', 'ฃ': '\\',
  'ฟ': 'a', 'ห': 's', 'ก': 'd', 'ด': 'f', 'เ': 'g', '้': 'h', '่': 'j', 'า': 'k', 'ส': 'l', 'ว': ';', 'ง': "'",
  'ผ': 'z', 'ป': 'x', 'แ': 'c', 'อ': 'v', 'ิ': 'b', 'ื': 'n', 'ท': 'm', 'ม': ',', 'ใ': '.', 'ฝ': '/',
  '%': '~', '+': '!', '๑': '@', '๒': '#', '๓': '$', '๔': '%', 'ู': '^', '฿': '&', '๕': '*', '๖': '(', '๗': ')', '๘': '_', '๙': '+',
  '๐': 'Q', '"': 'W', 'ฎ': 'E', 'ฑ': 'R', 'ธ': 'T', 'ํ': 'Y', '๊': 'U', 'ณ': 'I', 'ฯ': 'O', 'ญ': 'P', 'ฐ': '{', ',': '}', 'ฅ': '|',
  'ฤ': 'A', 'ฆ': 'S', 'ฏ': 'D', 'โ': 'F', 'ฌ': 'G', '็': 'H', '๋': 'J', 'ษ': 'K', 'ศ': 'L', 'ซ': ':', '.': '"',
  '(': 'Z', ')': 'X', 'ฉ': 'C', 'ฮ': 'V', 'ฺ': 'B', '์': 'N', '?': 'M', 'ฒ': '<', 'ฬ': '>', 'ฦ': '?',
  '_': '3' }; // some Thai keyboards (and people) write the "3" key's dash as "_"
export function fromThaiKeys(text) {
  const s = String(text || '');
  if (!/[฀-๿]/.test(s)) return s;
  return [...s].map((c) => TH_KEYS[c] ?? c).join('');
}
// a scanned signed bill link (QR on the merchant slip) → its token "<bill_no>.<sig>", or null
export function billTokenOf(text) {
  const m = /(?:\/b\/#|^)([A-Z]{1,6}\d{6}-\d{3,6}\.[0-9a-f]{12})\s*$/i.exec(String(text || '').trim());
  return m ? m[1] : null;
}

// An option can rename the item it is chosen on (e.g. ไข่ไก่ + ออนเซ็น → "ไข่ออนเซ็น").
// kitchen = kitchen ticket / kitchen screen; everywhere = also POS cart, receipt and customer display when the group says so.
export function renamedLine(name, options = [], where = 'kitchen') {
  const r = (options || []).find((o) => o && o.rename_to && (where === 'kitchen' || o.rename_all));
  return r ? { name: r.rename_to, options: options.filter((o) => o !== r) } : { name, options };
}

// ---------- EAN-13 (retail barcodes such as 885xxxxxxxxxx) ----------
export function ean13Check(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
export const isEan13 = (v) => /^\d{13}$/.test(String(v)) && ean13Check(String(v).slice(0, 12)) === String(v)[12];
const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
// same output shape as code128(): module widths starting with a bar
export function ean13(text) {
  const v = String(text);
  if (!isEan13(v)) throw new Error('barcode: invalid EAN-13');
  const par = EAN_PARITY[Number(v[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) bits += (par[i - 1] === 'L' ? EAN_L : EAN_G)[Number(v[i])];
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += EAN_R[Number(v[i])];
  bits += '101';
  const runs = [];
  for (const b of bits) { if (runs.length && runs.at(-1).b === b) runs.at(-1).n++; else runs.push({ b, n: 1 }); }
  return runs.map((r) => r.n);
}

// Monotonic request guard: protects dashboards from an old response overwriting a newer one.
export function latestOnly() {
  let seq = 0; let inflight = null;
  return async (fn, { coalesce = true } = {}) => {
    if (coalesce && inflight) return inflight;
    const my = ++seq;
    const p = (async () => {
      try { const r = await fn(); return my === seq ? { fresh: true, value: r } : { fresh: false }; }
      finally { if (inflight === p) inflight = null; }
    })();
    inflight = p;
    return p;
  };
}
