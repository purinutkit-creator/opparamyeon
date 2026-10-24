// Product assistant, AI part: identify a product from a photo (no barcode needed) with Claude,
// write many Thai/English menu names, and gather lots of good-looking photos from image sources.
// Price and category are never filled in for the shop: staff set them.
import Anthropic from '@anthropic-ai/sdk';
import { getSecret } from './util.js';

export const AI_MODEL = 'claude-opus-5-5';
const UA = 'OppaRamyeonPOS/1.9 (product assistant)';

export async function aiKeys() {
  return {
    anthropic: (await getSecret('anthropic_api_key')) || process.env.ANTHROPIC_API_KEY || '',
    pexels: (await getSecret('pexels_api_key')) || process.env.PEXELS_API_KEY || '',
    serper: (await getSecret('serper_api_key')) || process.env.SERPER_API_KEY || '',
  };
}

// ---------- Claude: photo / text → product identity + names + image search queries ----------
const SCHEMA = {
  type: 'object',
  properties: {
    identified: { type: 'boolean', description: 'true when the photo or text clearly shows a specific product or dish' },
    product_type: { type: 'string', description: 'what it is, in Thai, e.g. บะหมี่กึ่งสำเร็จรูปเกาหลี, น้ำอัดลม, ขนมขบเคี้ยว' },
    brand: { type: 'string', description: 'brand as printed on the pack, empty if unknown' },
    product_name_en: { type: 'string' },
    product_name_th: { type: 'string' },
    flavor: { type: 'string', description: 'flavor / variant in Thai, empty if none' },
    size: { type: 'string', description: 'net weight or volume if visible, e.g. 140 g, 325 ml' },
    barcode: { type: 'string', description: 'barcode digits only if clearly readable in the photo, else empty' },
    names_th: { type: 'array', items: { type: 'string' }, description: '10-14 Thai product names a shop menu could use: short POS names, full names with brand/flavor/size, appetizing menu-style names' },
    names_en: { type: 'array', items: { type: 'string' }, description: '6-8 English names in the same styles' },
    names_mixed: { type: 'array', items: { type: 'string' }, description: '3-5 names that mix Thai with the Korean/English brand name as shops often write them' },
    image_queries_product: { type: 'array', items: { type: 'string' }, description: '2-3 web image search queries (English) that find official pack shots / product photos of exactly this product' },
    image_queries_promo: { type: 'array', items: { type: 'string' }, description: '2-3 short English stock-photo queries for beautiful, appetizing promotional photos of this kind of product or the dish it makes' },
    category_hint: { type: 'string', description: 'the best matching name from the shop categories given, or empty' },
  },
  required: ['identified', 'product_type', 'brand', 'product_name_en', 'product_name_th', 'flavor', 'size', 'barcode', 'names_th', 'names_en', 'names_mixed', 'image_queries_product', 'image_queries_promo', 'category_hint'],
  additionalProperties: false,
};

export class AiError extends Error {}

export async function identifyWithClaude({ apiKey, imageBase64, mediaType, text, barcodeInfo, categories }) {
  const client = new Anthropic({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 60000, maxRetries: 1 });
  const content = [];
  if (imageBase64) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } });
  content.push({ type: 'text', text: [
    imageBase64 ? 'This is a photo a shop staff member took of a product they want to add to their POS menu (a Korean ramyeon shop in Thailand that also sells drinks and snacks).' : 'A shop staff member typed this product they want to add to their POS menu (a Korean ramyeon shop in Thailand that also sells drinks and snacks).',
    text ? `Staff note / typed name: ${text}` : '',
    barcodeInfo ? `Barcode database result: ${barcodeInfo}` : '',
    `Shop categories: ${categories.map((c) => c.name).join(', ') || '(none)'}`,
    'Identify the product as precisely as you can (brand, product line, flavor, size). If you are not sure, say what kind of product it is and set identified to false.',
    'Write many good names: natural Thai first (as Thai shops write menus), then English, then mixed. No prices. Keep each name under 60 characters. Do not invent a brand that is not visible or known.',
  ].filter(Boolean).join('\n') });
  let res;
  try {
    res = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default', // a policy decline is retried on Anthropic's recommended model instead of failing
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('API Key ของ Claude ไม่ถูกต้อง — ตรวจสอบที่ ตั้งค่า AI');
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('API Key นี้ไม่มีสิทธิ์ใช้งานโมเดล');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('ใช้งาน AI ถี่เกินไป — รอสักครู่แล้วลองใหม่');
    if (e instanceof Anthropic.BadRequestError) throw new AiError('AI รับรูปนี้ไม่ได้: ' + e.message);
    if (e instanceof Anthropic.APIConnectionError) throw new AiError('เชื่อมต่อ AI ไม่ได้ — ตรวจสอบอินเทอร์เน็ตของเซิร์ฟเวอร์');
    if (e instanceof Anthropic.APIError) throw new AiError(`AI ขัดข้อง (${e.status}) — ลองใหม่อีกครั้ง`);
    throw e;
  }
  if (res.stop_reason === 'refusal') throw new AiError('AI ไม่สามารถวิเคราะห์รูปนี้ได้ — ลองรูปอื่น หรือพิมพ์ชื่อสินค้าเอง');
  const block = res.content.find((b) => b.type === 'text');
  if (!block) throw new AiError('AI ไม่ได้ตอบกลับ — ลองใหม่');
  try { return JSON.parse(block.text); } catch { throw new AiError('อ่านคำตอบของ AI ไม่ได้ — ลองใหม่'); }
}

// ---------- image sources ----------
async function getJson(url, { headers = {}, method = 'GET', body, ms = 8000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { method, body, headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
const SRC = {
  off: () => process.env.LOOKUP_OFF_URL || 'https://world.openfoodfacts.org',
  openverse: () => process.env.LOOKUP_OPENVERSE_URL || 'https://api.openverse.org',
  wiki: () => process.env.LOOKUP_WIKI_URL || 'https://commons.wikimedia.org',
  pexels: () => process.env.LOOKUP_PEXELS_URL || 'https://api.pexels.com',
  serper: () => process.env.LOOKUP_SERPER_URL || 'https://google.serper.dev',
};
const enc = encodeURIComponent;

async function offImages(q) {
  const j = await getJson(`${SRC.off()}/cgi/search.pl?search_terms=${enc(q)}&search_simple=1&json=1&page_size=12&fields=product_name,brands,image_front_url,code`);
  return (j.products || []).filter((p) => p.image_front_url).map((p) => ({ url: p.image_front_url, thumb: p.image_front_url.replace(/\.(\d+)\.jpg$/, '.400.jpg'), title: [p.brands, p.product_name].filter(Boolean).join(' '), source: 'Open Food Facts', kind: 'product' }));
}
async function serperImages(q, key) {
  const j = await getJson(`${SRC.serper()}/images`, { method: 'POST', headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, num: 20 }) });
  return (j.images || []).filter((i) => i.imageUrl).map((i) => ({ url: i.imageUrl, thumb: i.thumbnailUrl || i.imageUrl, title: i.title || '', source: 'Google Images' + (i.source ? ' · ' + i.source : ''), kind: 'product', note: 'ตรวจสอบสิทธิ์การใช้รูปจากเว็บต้นทาง' }));
}
async function pexelsImages(q, key) {
  const j = await getJson(`${SRC.pexels()}/v1/search?query=${enc(q)}&per_page=12&orientation=square`, { headers: { Authorization: key } });
  return (j.photos || []).map((p) => ({ url: p.src.large2x || p.src.large || p.src.original, thumb: p.src.medium || p.src.small, title: p.alt || q, source: 'Pexels · ' + (p.photographer || ''), kind: 'promo' }));
}
async function openverseImages(q) {
  const j = await getJson(`${SRC.openverse()}/v1/images/?q=${enc(q)}&page_size=12&license_type=commercial&mature=false`);
  return (j.results || []).filter((r) => r.url).map((r) => ({ url: r.url, thumb: r.thumbnail || r.url, title: r.title || q, source: `Openverse · ${r.license ? 'CC ' + String(r.license).toUpperCase() : ''}${r.creator ? ' · ' + r.creator : ''}`, kind: 'promo' }));
}
async function wikiImages(q) {
  const j = await getJson(`${SRC.wiki()}/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=10&gsrsearch=${enc('filetype:bitmap ' + q)}&prop=imageinfo&iiprop=url&iiurlwidth=600`);
  return Object.values((j.query && j.query.pages) || {}).map((p) => p.imageinfo && p.imageinfo[0]).filter(Boolean).map((i) => ({ url: i.url, thumb: i.thumburl || i.url, title: '', source: 'Wikimedia Commons', kind: 'promo' }));
}

// Search every available source in parallel; product shots first, then promotional photos. Failures of one source are reported, never fatal.
export async function findImages({ productQueries = [], promoQueries = [], keys = {} }) {
  const pq = [...new Set(productQueries.filter(Boolean))].slice(0, 3);
  const sq = [...new Set(promoQueries.filter(Boolean))].slice(0, 3);
  const jobs = [];
  for (const q of pq) { jobs.push(['Open Food Facts', offImages(q)]); if (keys.serper) jobs.push(['Google Images', serperImages(q, keys.serper)]); jobs.push(['Wikimedia', wikiImages(q)]); }
  for (const q of sq) { if (keys.pexels) jobs.push(['Pexels', pexelsImages(q, keys.pexels)]); jobs.push(['Openverse', openverseImages(q)]); if (keys.serper) jobs.push(['Google Images', serperImages(q, keys.serper)]); }
  const settled = await Promise.allSettled(jobs.map(([, p]) => p));
  const errors = [], buckets = { product: [], promo: [] };
  settled.forEach((s, i) => { if (s.status === 'fulfilled') for (const im of s.value) buckets[im.kind === 'product' ? 'product' : 'promo'].push(im); else errors.push(`${jobs[i][0]}: ${s.reason && s.reason.name === 'AbortError' ? 'หมดเวลา' : s.reason && s.reason.message}`); });
  const seen = new Set(), out = [];
  // interleave sources inside each bucket so one source never fills the whole grid
  for (const list of [buckets.product, buckets.promo]) {
    const bySrc = new Map();
    for (const im of list) { const k = im.source.split(' · ')[0]; if (!bySrc.has(k)) bySrc.set(k, []); bySrc.get(k).push(im); }
    for (let i = 0, more = true; more; i++) { more = false; for (const arr of bySrc.values()) if (arr[i]) { more = true; if (!seen.has(arr[i].url) && /^https?:\/\//i.test(arr[i].url)) { seen.add(arr[i].url); out.push(arr[i]); } } }
  }
  return { images: out.slice(0, 48), errors: [...new Set(errors)] };
}

// names without AI: variants of what we know
export function basicNames(base = [], { brand = '', size = '' } = {}) {
  const out = [];
  for (const n of base.filter(Boolean)) { out.push(n); if (brand && !n.includes(brand)) out.push(`${brand} ${n}`); if (size && !n.includes(size)) out.push(`${n} ${size}`); }
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}
