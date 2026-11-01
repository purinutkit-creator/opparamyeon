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

// ---------- product info search: Claude searches the web, then writes options the admin picks from ----------
// Two calls: web search adds citations, which can't be combined with a JSON output format in the same request.
const INFO_SCHEMA = {
  type: 'object',
  properties: {
    found: { type: 'boolean', description: 'true when the research identified this specific product' },
    summary_th: { type: 'string', description: 'one Thai sentence: what this product is (brand, line, flavor, size)' },
    descriptions: { type: 'array', description: '4 Thai product descriptions in different styles for the shop to choose from', items: { type: 'object', properties: {
      style: { type: 'string', description: 'style name in Thai, e.g. สั้นกระชับ, ชวนกิน, ให้ข้อมูล, สำหรับจอลูกค้า' }, text: { type: 'string', description: 'the description, 1-3 sentences, Thai' } }, required: ['style', 'text'], additionalProperties: false } },
    highlights: { type: 'array', items: { type: 'string' }, description: '6-10 short Thai selling points / features (one line each, under 40 characters), only things supported by the research' },
    spice_level: { type: 'integer', description: 'spiciness 0 (not spicy) to 5 (extremely spicy) for this product as sold' },
    spice_reason: { type: 'string', description: 'short Thai reason for the spice level, e.g. Scoville rating or how the brand labels it; empty if not spicy' },
    facts: { type: 'array', description: 'useful facts found: brand, country, net weight, main ingredients, allergens, calories, halal, how to cook', items: { type: 'object', properties: {
      label: { type: 'string', description: 'Thai label' }, value: { type: 'string', description: 'Thai value' } }, required: ['label', 'value'], additionalProperties: false } },
  },
  required: ['found', 'summary_th', 'descriptions', 'highlights', 'spice_level', 'spice_reason', 'facts'],
  additionalProperties: false,
};
const aiError = (e) => {
  if (e instanceof Anthropic.AuthenticationError) return new AiError('API Key ของ Claude ไม่ถูกต้อง — ตรวจสอบที่ ตั้งค่า AI');
  if (e instanceof Anthropic.PermissionDeniedError) return new AiError('API Key นี้ไม่มีสิทธิ์ใช้งานโมเดลหรือการค้นหาเว็บ');
  if (e instanceof Anthropic.RateLimitError) return new AiError('ใช้งาน AI ถี่เกินไป — รอสักครู่แล้วลองใหม่');
  if (e instanceof Anthropic.BadRequestError) return new AiError('AI รับคำขอนี้ไม่ได้ — ลองเลือก "Google + AI เขียนให้" แทน หรือแจ้งผู้ดูแลระบบ (' + String(e.message).slice(0, 160) + ')');
  if (e instanceof Anthropic.APIConnectionError) return new AiError('เชื่อมต่อ AI ไม่ได้ — ตรวจสอบอินเทอร์เน็ตของเซิร์ฟเวอร์');
  if (e instanceof Anthropic.APIError) return new AiError(`AI ขัดข้อง (${e.status}) — ลองใหม่อีกครั้ง`);
  return e;
};
// ---------- Google (through Serper): what people write about this product ----------
export async function googleProduct(name, key) {
  const qs = [`${name} สรรพคุณ`, `${name} รีวิว`, name];
  const res = await Promise.allSettled(qs.map((q) => getJson(`${SRC.serper()}/search`, { method: 'POST', ms: 10000, headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' }, body: JSON.stringify({ q, gl: 'th', hl: 'th', num: 10 }) })));
  const ok = res.filter((x) => x.status === 'fulfilled').map((x) => x.value);
  if (!ok.length) { const why = res.find((x) => x.status === 'rejected'); throw new AiError(/HTTP 40[13]/.test(String(why && why.reason && why.reason.message)) ? 'Serper API Key ไม่ถูกต้อง — ตรวจสอบที่ ตั้งค่า AI' : 'ค้นหา Google ไม่สำเร็จ — ลองใหม่'); }
  const results = [], seen = new Set();
  let kg = null, answer = '';
  for (const j of ok) {
    if (!kg && j.knowledgeGraph && (j.knowledgeGraph.description || j.knowledgeGraph.attributes)) kg = { title: j.knowledgeGraph.title || '', description: j.knowledgeGraph.description || '', attributes: j.knowledgeGraph.attributes || {} };
    if (!answer && j.answerBox) answer = j.answerBox.snippet || j.answerBox.answer || '';
    for (const o of j.organic || []) if (o.link && o.snippet && !seen.has(o.link)) { seen.add(o.link); results.push({ title: o.title || o.link, url: o.link, snippet: o.snippet }); }
    for (const pa of j.peopleAlsoAsk || []) if (pa.snippet && pa.link && !seen.has(pa.link)) { seen.add(pa.link); results.push({ title: pa.question || pa.title || pa.link, url: pa.link, snippet: pa.snippet }); }
  }
  return { results: results.slice(0, 18), kg, answer };
}
const googleNotes = (g) => [
  g.kg ? `Google info box: ${g.kg.title} — ${g.kg.description} ${Object.entries(g.kg.attributes).map(([k, v]) => `${k}: ${v}`).join('; ')}` : '',
  g.answer ? `Google answer box: ${g.answer}` : '',
  ...g.results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\n${r.url}`),
].filter(Boolean).join('\n\n');
// no Claude key: options straight from Google's text (sentences cut from the snippets; spice left for the shop to set)
function optionsFromGoogle(name, g) {
  const clean = (t) => String(t || '').replace(/\s*\.\.\.\s*$/, '').replace(/^\w{3} \d{1,2}, \d{4} — /, '').replace(/\s+/g, ' ').trim();
  const texts = [g.kg && g.kg.description, g.answer, ...g.results.map((r) => r.snippet)].map(clean).filter((t) => t.length > 25);
  const descriptions = [...new Set(texts)].slice(0, 4).map((text, i) => ({ style: i === 0 && g.kg && g.kg.description ? 'จาก Google (กล่องข้อมูล)' : 'จาก Google', text }));
  // Thai writes phrases separated by spaces, not full stops: long Thai pieces are split at spaces into short selling points
  const pieces = texts.flatMap((t) => t.split(/[.!?•·|\n,;:()]| - |、|。/)).map((x) => x.trim()).flatMap((x) => (/[\u0E00-\u0E7F]/.test(x) && x.length > 40 ? x.split(/\s+/) : [x]));
  const bits = [...new Set(pieces.map((x) => x.trim()).filter((x) => x.length >= 6 && x.length <= 60 && !/^\d+$/.test(x)))].slice(0, 10);
  const facts = g.kg ? Object.entries(g.kg.attributes).slice(0, 8).map(([label, value]) => ({ label, value: String(value) })) : [];
  return { found: g.results.length > 0, summary_th: g.kg ? `${g.kg.title} — ${g.kg.description}`.slice(0, 200) : `ผลการค้นหา Google สำหรับ "${name}"`, descriptions, highlights: bits, spice_level: 0, spice_reason: 'ยังไม่ได้ประเมิน (ไม่มี AI) — ตั้งเองได้ในฟอร์ม', facts, spice_unknown: true };
}
// engine: 'google' (Google only) · 'google_ai' (Google, then Claude writes the options) · 'claude' (Claude searches the web) · 'auto'
export async function researchProduct({ apiKey, serperKey = '', engine = 'auto', name, barcode = '', note = '', category = '', barcodeInfo = '' }) {
  if (engine === 'auto') engine = serperKey ? (apiKey ? 'google_ai' : 'google') : 'claude';
  if (engine === 'google') apiKey = '';
  if (engine !== 'claude') {
    if (!serperKey) throw new AiError('ค้นจาก Google ต้องมี Serper API Key — ดู "วิธีเอา API Key" ในหน้าต่างค้นหา');
    if (engine === 'google_ai' && !apiKey) throw new AiError('ให้ AI เขียนต้องมี Claude API Key — ดู "วิธีเอา API Key" หรือเลือก "Google อย่างเดียว"');
    const g = await googleProduct(name, serperKey);
    const google = g.results.map((r) => ({ title: r.title, url: r.url, snippet: r.snippet }));
    if (!apiKey) return { ...optionsFromGoogle(name, g), engine: 'google', google, sources: google.slice(0, 8).map(({ title, url }) => ({ title, url })) };
    const out = await formatOptions(new Anthropic({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 120000, maxRetries: 1 }), { name, barcode, notes: googleNotes(g) || 'Google found nothing for this product.', from: 'Google search results (title, snippet, link)' });
    return { ...out, engine: 'google', google, sources: google.slice(0, 8).map(({ title, url }) => ({ title, url })) };
  }
  if (!apiKey) throw new AiError('ให้ Claude ค้นเว็บต้องมี Claude API Key — ดู "วิธีเอา API Key" ในหน้าต่างค้นหา');
  return { ...(await claudeResearch({ apiKey, name, barcode, note, category, barcodeInfo })), engine: 'claude' };
}
async function claudeResearch({ apiKey, name, barcode = '', note = '', category = '', barcodeInfo = '' }) {
  const client = new Anthropic({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL || undefined, timeout: 180000, maxRetries: 1 });
  const ask = [
    'A Korean ramyeon shop in Thailand wants accurate information about a product on its menu, to write the product description, selling points and spice level shown to customers.',
    `Product name in the shop: ${name}`, barcode ? `Barcode: ${barcode}` : '', category ? `Shop category: ${category}` : '', note ? `Staff note: ${note}` : '', barcodeInfo ? `Barcode database result: ${barcodeInfo}` : '',
    'Search the web (official brand pages, retailers, reviews) for this exact product. Collect: what it is, flavor, how spicy (Scoville if known), net weight, main ingredients, allergens, country of origin, notable features, and how people describe it.',
    'Write your findings as notes in Thai. Say plainly what you could not confirm. Do not invent facts.',
  ].filter(Boolean).join('\n');
  // 1) research with web search (resume when the server-side loop pauses)
  const messages = [{ role: 'user', content: ask }];
  const sources = new Map();
  let notes = '';
  try {
    for (let turn = 0; turn < 4; turn++) {
      const res = await client.beta.messages.create({
        model: AI_MODEL, max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
        output_config: { effort: 'medium' },
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 6 }], // no user_location: web search rejects country TH (the prompt says the shop is in Thailand)
        messages,
      });
      if (res.stop_reason === 'refusal') throw new AiError('AI ค้นหาข้อมูลสินค้านี้ไม่ได้ — ลองแก้ชื่อสินค้าแล้วค้นใหม่');
      for (const b of res.content) {
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) for (const x of b.content) if (x.type === 'web_search_result' && x.url && !sources.has(x.url)) sources.set(x.url, { title: x.title || x.url, url: x.url });
        if (b.type === 'text') notes += b.text;
      }
      if (res.stop_reason !== 'pause_turn') break;
      messages.push({ role: 'assistant', content: res.content }); // the server resumes the search where it stopped
    }
  } catch (e) { throw aiError(e); }
  if (!notes.trim()) throw new AiError('AI ไม่ได้ส่งผลการค้นหากลับมา — ลองใหม่');
  return { ...(await formatOptions(client, { name, barcode, notes, from: 'Research notes from a web search' })), sources: [...sources.values()].slice(0, 8) };
}
// options in a fixed shape, written only from the notes given (Google results or Claude's research)
async function formatOptions(client, { name, barcode = '', notes, from }) {
  let res;
  try {
    res = await client.beta.messages.create({
      model: AI_MODEL, max_tokens: 8000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: INFO_SCHEMA } },
      messages: [{ role: 'user', content: [
        `Product in the shop: ${name}${barcode ? ` (barcode ${barcode})` : ''}`,
        `${from}:`, notes.slice(0, 20000),
        'From these notes only, write options for the shop: 4 Thai descriptions in different styles (natural Thai a Thai shop would print on a menu, no prices, no made-up claims), 6-10 short Thai selling points, the spice level 0-5 with a reason, and the facts found. If the notes say the product could not be found, set found to false and keep the options generic to the kind of product.',
      ].join('\n') }],
    });
  } catch (e) { throw aiError(e); }
  if (res.stop_reason === 'refusal') throw new AiError('AI เขียนข้อมูลสินค้านี้ไม่ได้ — ลองใหม่');
  const block = res.content.find((b) => b.type === 'text');
  let out;
  try { out = JSON.parse(block && block.text); } catch { throw new AiError('อ่านคำตอบของ AI ไม่ได้ — ลองใหม่'); }
  out.spice_level = Math.max(0, Math.min(5, Math.round(Number(out.spice_level) || 0)));
  return out;
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
  ddg: () => process.env.LOOKUP_DDG_URL || 'https://duckduckgo.com',
  bing: () => process.env.LOOKUP_BING_URL || 'https://www.bing.com',
};
const enc = encodeURIComponent;

async function offImages(q) {
  const j = await getJson(`${SRC.off()}/cgi/search.pl?search_terms=${enc(q)}&search_simple=1&json=1&page_size=12&fields=product_name,product_name_th,brands,quantity,image_front_url,code`);
  return (j.products || []).filter((p) => p.image_front_url).map((p) => ({ url: p.image_front_url, thumb: p.image_front_url.replace(/\.(\d+)\.jpg$/, '.400.jpg'),
    title: [p.brands && p.brands.split(',')[0], p.product_name_th || p.product_name, p.quantity].filter(Boolean).join(' '), names: [p.product_name_th, p.product_name].filter(Boolean), source: 'Open Food Facts', kind: 'product' }));
}
// DuckDuckGo image search (no key): real product photos and shop/promo pictures from across the web.
// It needs a short-lived "vqd" token from the search page first.
async function ddgImages(q, region = 'wt-wt') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const hdr = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': region === 'th-th' ? 'th,en;q=0.8' : 'en,th;q=0.8' };
    const page = await fetch(`${SRC.ddg()}/?q=${enc(q)}&iax=images&ia=images`, { headers: hdr, signal: ctl.signal }).then((r) => r.text());
    const vqd = (/vqd=["']?([\d-]+)["'&]/.exec(page) || [])[1];
    if (!vqd) throw new Error('ไม่ได้รับโทเคนค้นหา');
    const r = await fetch(`${SRC.ddg()}/i.js?l=${region}&o=json&q=${enc(q)}&vqd=${vqd}&f=,,,,,&p=1`, { headers: { ...hdr, Referer: SRC.ddg() + '/', Accept: 'application/json' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    return (j.results || []).filter((x) => x.image && /^https?:/i.test(x.image)).slice(0, 24)
      .map((x) => ({ url: x.image, thumb: x.thumbnail || x.image, title: x.title || '', source: 'เว็บ · ' + (x.source || (x.url ? new URL(x.url).hostname.replace(/^www\./, '') : '')), kind: 'product', note: 'ตรวจสอบสิทธิ์การใช้รูปจากเว็บต้นทาง' }));
  } finally { clearTimeout(t); }
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

// Bing Images (no key): the result page carries each image as an HTML-escaped JSON attribute m="{murl, turl, t, purl}".
async function bingImages(q, market = 'th-TH') {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(`${SRC.bing()}/images/async?q=${enc(q)}&first=0&count=35&mmasync=1&setmkt=${market}&setlang=${market.slice(0, 2)}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'Accept-Language': market === 'th-TH' ? 'th,en;q=0.8' : 'en' }, signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const unesc = (v) => v.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    const out = [];
    for (const m of html.matchAll(/\sm="(\{[^"]*\})"/g)) {
      try {
        const j = JSON.parse(unesc(m[1]));
        if (j.murl && /^https?:/i.test(j.murl)) out.push({ url: j.murl, thumb: j.turl || j.murl, title: j.t || '', source: 'เว็บ · ' + (j.purl ? new URL(j.purl).hostname.replace(/^www\./, '') : 'Bing'), kind: 'product', note: 'ตรวจสอบสิทธิ์การใช้รูปจากเว็บต้นทาง' });
      } catch { /* skip a malformed entry */ }
      if (out.length >= 24) break;
    }
    return out;
  } finally { clearTimeout(t); }
}

// Search every available source in parallel; product shots first, then promotional photos. Failures of one source are reported, never fatal.
export async function findImages({ productQueries = [], promoQueries = [], keys = {} }) {
  const pq = [...new Set(productQueries.filter(Boolean))].slice(0, 3);
  const sq = [...new Set(promoQueries.filter(Boolean))].slice(0, 3);
  const jobs = [];
  pq.forEach((q, i) => {
    jobs.push(['Open Food Facts', offImages(q)]);
    if (i < 2) { jobs.push(['เว็บ (DuckDuckGo)', ddgImages(q, 'th-th')]); jobs.push(['เว็บ (Bing)', bingImages(q, 'th-TH')]); }
    if (i === 0) { jobs.push(['เว็บ (DuckDuckGo)', ddgImages(q, 'wt-wt')]); jobs.push(['เว็บ (Bing)', bingImages(q, 'en-US')]); }
    if (keys.serper) jobs.push(['Google Images', serperImages(q, keys.serper)]);
    jobs.push(['Wikimedia', wikiImages(q)]);
  });
  sq.forEach((q, i) => {
    if (keys.pexels) jobs.push(['Pexels', pexelsImages(q, keys.pexels)]);
    jobs.push(['Openverse', openverseImages(q)]);
    if (i === 0) { jobs.push(['เว็บ (DuckDuckGo)', ddgImages(q, 'wt-wt').then((l) => l.map((im) => ({ ...im, kind: 'promo' })))]); jobs.push(['เว็บ (Bing)', bingImages(q + ' food photography', 'en-US').then((l) => l.map((im) => ({ ...im, kind: 'promo' })))]); }
    if (keys.serper) jobs.push(['Google Images', serperImages(q, keys.serper)]);
  });
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
  const titles = [...buckets.product, ...buckets.promo].flatMap((im) => [im.title, ...(im.names || [])]).filter(Boolean);
  return { images: out.slice(0, 60), titles, errors: [...new Set(errors)] };
}

// Product names without AI: mine the titles of shop listings / product pages that the searches found.
// Shop titles are often full Thai names ("มาม่าเกาหลี ซัมยัง บูลดัก คาโบนาร่า 130 กรัม"), so this gives many real names.
const JUNK = /(shopee|lazada|amazon|aliexpress|ebay|alibaba|walmart|tiktok|facebook|instagram|youtube|wikipedia|pinterest|stock photo|ภาพสต็อก|รูปภาพ|ดาวน์โหลด|download|vector|png|jpe?g|ส่งฟรี|ลดราคา|ราคาถูก|โปรโมชั่น|review|รีวิว|วิธีทำ|recipe)/i;
export function mineNames(titles, queryWords = []) {
  const qw = queryWords.map((w) => w.toLowerCase()).filter((w) => w.length >= 2);
  const count = new Map();
  for (const raw of titles) {
    for (let part of String(raw).split(/\s+[|｜\-–—:]\s+|\s*[|｜]\s*/)) {
      part = part.replace(/\[[^\]]*\]|【[^】]*】|\([^)]*(ราคา|ฟรี|แท้|ของแท้|ส่ง)[^)]*\)/g, ' ')
        .replace(/[฿$]\s?\d[\d,.]*|\d[\d,.]*\s?(บาท|baht|thb)/gi, ' ')
        // \b does not work for Thai, so match marketing words between spaces / ends
        .replace(/(^|\s)(ราคา\S*|ของแท้|แท้\S*|พร้อมส่ง\S*|ขายดี\S*|สินค้าใหม่|ล็อตใหม่|best seller|official store|official|ร้าน\S*|จำนวน\s?\d+\s?ชิ้น)(?=\s|$)/gi, ' ')
        .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]/gu, ' ')
        .replace(/[!?*#~^_=+<>{}"“”]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[,.\-\s]+|[,.\-\s]+$/g, '');
      if (part.length < 4 || part.length > 64 || JUNK.test(part) || /^\d+$/.test(part)) continue;
      const k = part.toLowerCase();
      count.set(k, { name: part, n: ((count.get(k) || {}).n || 0) + 1 });
    }
  }
  const score = (x) => x.n * 2 + qw.filter((w) => x.name.toLowerCase().includes(w)).length * 3 + (/[\u0E00-\u0E7F]/.test(x.name) ? 1 : 0);
  // every title already came back for this search, so query overlap only ranks (Thai shop titles rarely repeat the English words)
  return [...count.values()].sort((a, b) => score(b) - score(a)).map((x) => x.name).slice(0, 24);
}

// names without AI: variants of what we know
export function basicNames(base = [], { brand = '', size = '' } = {}) {
  const out = [];
  for (const n of base.filter(Boolean)) { out.push(n); if (brand && !n.includes(brand)) out.push(`${brand} ${n}`); if (size && !n.includes(size)) out.push(`${n} ${size}`); }
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean))];
}

// shorter / cleaner versions of found names (no pack size, without a generic prefix) — shops like short menu names
export function nameVariants(list) {
  const out = [];
  const SIZE = /\s*\(?\d+([.,]\d+)?\s?(กรัม|ก\.|g|gm|กก\.|kg|มล\.|ml|ลิตร|l|ซอง|ชิ้น|pcs|แพ็ค|pack)\)?\.?$/i;
  for (const n of list.filter(Boolean)) {
    out.push(n);
    const noSize = n.replace(SIZE, '').trim();
    if (noSize && noSize !== n) out.push(noSize);
    for (const pre of ['มาม่าเกาหลี', 'บะหมี่กึ่งสำเร็จรูป', 'บะหมี่เกาหลี', 'ราเมงเกาหลี']) if (noSize.startsWith(pre + ' ')) out.push(noSize.slice(pre.length + 1));
  }
  return [...new Set(out.map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 3))];
}
