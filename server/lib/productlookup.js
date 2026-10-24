// Product assistant: barcode → product name, brand and good product photos from free public databases.
// Open Food Facts (no key, good Thai coverage for food/drinks) first, then UPCitemdb's free trial endpoint.
// Prices and categories are never guessed into the product: staff set them.
import dns from 'node:dns/promises';
import net from 'node:net';

const OFF = () => process.env.LOOKUP_OFF_URL || 'https://world.openfoodfacts.org';
const UPC = () => process.env.LOOKUP_UPC_URL || 'https://api.upcitemdb.com';
const UA = 'OppaRamyeonPOS/1.8 (product assistant)';

async function getJson(url, ms = 7000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const uniq = (a) => [...new Set(a.map(clean).filter(Boolean))];

async function fromOpenFoodFacts(code) {
  const j = await getJson(`${OFF()}/api/v2/product/${encodeURIComponent(code)}.json?fields=product_name,product_name_th,product_name_en,generic_name,brands,quantity,image_front_url,image_url,selected_images,categories_tags,categories`);
  if (!j || j.status === 0 || !j.product) return null;
  const p = j.product;
  const brand = clean((p.brands || '').split(',')[0]);
  const base = clean(p.product_name_th || p.product_name || p.product_name_en || p.generic_name);
  const names = uniq([base, p.product_name_th, p.product_name, p.product_name_en, brand && base && !base.includes(brand) ? `${brand} ${base}` : '', base && p.quantity ? `${base} ${p.quantity}` : '']);
  const sel = p.selected_images && p.selected_images.front && p.selected_images.front.display ? Object.values(p.selected_images.front.display) : [];
  const images = uniq([p.image_front_url, ...sel, p.image_url]);
  if (!names.length && !images.length) return null;
  return { source: 'Open Food Facts', names, images, brand, quantity: clean(p.quantity), categories: uniq([...(p.categories_tags || []).map((c) => c.replace(/^[a-z]{2}:/, '').replace(/-/g, ' ')), ...(p.categories || '').split(',')]) };
}

async function fromUpcItemDb(code) {
  const j = await getJson(`${UPC()}/prod/trial/lookup?upc=${encodeURIComponent(code)}`);
  const it = j && j.items && j.items[0];
  if (!it) return null;
  return { source: 'UPCitemdb', names: uniq([it.title, it.brand && it.title && !it.title.includes(it.brand) ? `${it.brand} ${it.title}` : '']), images: uniq((it.images || []).filter((u) => /^https?:/i.test(u))).slice(0, 6),
    brand: clean(it.brand), quantity: clean(it.size), categories: uniq(String(it.category || '').split('>')) };
}

// suggest one of the shop's categories from words in the product data (staff still choose)
const HINTS = [
  [/drink|beverage|soda|juice|water|tea|coffee|milk|น้ำ|เครื่องดื่ม|ชา|กาแฟ|นม|โซดา/i, /ดื่ม|drink|น้ำ/i],
  [/noodle|ramen|ramyeon|instant|บะหมี่|มาม่า|ราเมง|라면/i, /มาม่า|บะหมี่|ramen|noodle|ราเมง/i],
  [/snack|chip|cracker|cookie|biscuit|ขนม|สแน็ค|มันฝรั่ง/i, /ทานเล่น|ขนม|snack/i],
  [/sauce|seasoning|ซอส|เครื่องปรุง/i, /ซอส|เครื่องปรุง|sauce/i],
  [/cheese|sausage|egg|topping|ชีส|ไส้กรอก|ไข่/i, /ท็อปปิ้ง|topping/i],
];
export function suggestCategory(info, categories) {
  const text = [...(info.names || []), ...(info.categories || []), info.brand].join(' ');
  for (const c of categories) if (c.name && text.toLowerCase().includes(c.name.toLowerCase())) return c.id;
  for (const [want, catName] of HINTS) if (want.test(text)) { const c = categories.find((x) => catName.test(x.name)); if (c) return c.id; }
  return null;
}

export async function lookupBarcode(code) {
  const errors = [];
  for (const [name, fn] of [['Open Food Facts', fromOpenFoodFacts], ['UPCitemdb', fromUpcItemDb]]) {
    try { const r = await fn(code); if (r) return { found: true, ...r }; } catch (e) { errors.push(`${name}: ${e.name === 'AbortError' ? 'หมดเวลา' : e.message}`); }
  }
  return { found: false, names: [], images: [], errors };
}

// Download a product photo from the internet into our own file store (so it never breaks later).
// Only public http(s) hosts and real raster images; private network addresses are refused.
const privateIp = (ip) => (net.isIPv4(ip) ? /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/.test(ip)
  : /^(::1|::|fc|fd|fe80|::ffff:(10\.|127\.|192\.168\.|169\.254\.))/i.test(ip));
export async function fetchImage(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error('ลิงก์รูปไม่ถูกต้อง'); }
  const check = async (x) => {
    if (!/^https?:$/.test(x.protocol)) throw new Error('รองรับเฉพาะลิงก์ http/https');
    if (process.env.LOOKUP_ALLOW_PRIVATE) return;
    const addrs = await dns.lookup(x.hostname, { all: true }).catch(() => []);
    if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('ดาวน์โหลดรูปจากที่อยู่นี้ไม่ได้');
  };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 10000);
  try {
    let r;
    // follow redirects by hand so every hop is checked
    for (let hop = 0; ; hop++) {
      await check(u);
      r = await fetch(u, { headers: { 'User-Agent': UA }, signal: ctl.signal, redirect: 'manual' });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location') && hop < 3) { u = new URL(r.headers.get('location'), u); continue; }
      break;
    }
    if (!r.ok) throw new Error('ดาวน์โหลดรูปไม่สำเร็จ (HTTP ' + r.status + ')');
    const mime = (r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(mime)) throw new Error('ไฟล์นี้ไม่ใช่รูปภาพที่รองรับ');
    const len = Number(r.headers.get('content-length') || 0);
    if (len > 5 * 1024 * 1024) throw new Error('รูปใหญ่เกิน 5 MB');
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 5 * 1024 * 1024) throw new Error('รูปใหญ่เกิน 5 MB');
    return { buf, mime, name: decodeURIComponent(u.pathname.split('/').pop() || 'product') || 'product' };
  } finally { clearTimeout(t); }
}
