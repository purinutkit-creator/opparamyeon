// Customer-facing names in English and Chinese (the customer display switches language from the POS).
// Translations live in their own table, keyed by what they translate; `src` is the Thai text they were made from,
// so a renamed product shows as "needs translating" again instead of keeping an old name.
import Anthropic from '@anthropic-ai/sdk';
import { db, J, S } from '../db.js';
import { getSettings, now } from './util.js';
import { AI_MODEL, aiKeys, AiError } from './productai.js';

export const LANGS = ['en', 'zh'];
const FIELDS = { product: ['name', 'description', 'highlights'], option: ['name', 'topic', 'rename_to'], country: ['name'], spice: ['name'] };
const srcKey = (o) => S(FIELDS[o.kind].map((f) => String(o[f] || '')));

// everything a customer can read on the display, in Thai
export async function sources() {
  const out = [];
  for (const p of await db.all('SELECT id, name, description, highlights FROM products WHERE COALESCE(deleted, 0) = 0'))
    out.push({ kind: 'product', ref: p.id, name: p.name, description: p.description || '', highlights: p.highlights || '' });
  for (const g of await db.all('SELECT options FROM option_groups'))
    for (const o of J(g.options, [])) if (o && o.id && o.name) out.push({ kind: 'option', ref: o.id, name: o.name, topic: o.topic || '', rename_to: o.rename_to || '' });
  const s = await getSettings();
  for (const c of s.countries || []) if (c && c.id && c.name) out.push({ kind: 'country', ref: c.id, name: c.name });
  (s.spice_words || []).forEach((w, i) => { if (w) out.push({ kind: 'spice', ref: String(i), name: w }); });
  return out;
}
// { product: { id: { en: {...}, zh: {...} } }, option: ..., country: ..., spice: ... } — only translations still matching their Thai text
export async function translationMap() {
  const rows = await db.all('SELECT kind, ref, lang, data, src FROM translations');
  const cur = new Map((await sources()).map((o) => [o.kind + ':' + o.ref, srcKey(o)]));
  const out = { product: {}, option: {}, country: {}, spice: {} };
  for (const r of rows) {
    if (!out[r.kind] || cur.get(r.kind + ':' + r.ref) !== r.src) continue;
    ((out[r.kind][r.ref] ||= {}))[r.lang] = J(r.data, {});
  }
  return out;
}
export async function translationStatus() {
  const all = await sources();
  const have = new Set((await db.all('SELECT kind, ref, lang, src FROM translations')).map((r) => `${r.kind}:${r.ref}:${r.lang}:${r.src}`));
  const missing = all.filter((o) => LANGS.some((l) => !have.has(`${o.kind}:${o.ref}:${l}:${srcKey(o)}`)));
  return { total: all.length, missing: missing.length, done: all.length - missing.length };
}
export async function saveTranslation(kind, ref, lang, data) {
  if (!FIELDS[kind] || !LANGS.includes(lang)) throw new Error('bad translation');
  const o = (await sources()).find((x) => x.kind === kind && x.ref === ref);
  if (!o) throw new Error('not found');
  const clean = Object.fromEntries(FIELDS[kind].map((f) => [f, String((data || {})[f] || '').slice(0, f === 'name' || f === 'topic' || f === 'rename_to' ? 120 : 1500)]));
  await db.run('DELETE FROM translations WHERE kind = ? AND ref = ? AND lang = ?', [kind, ref, lang]);
  await db.run('INSERT INTO translations(kind, ref, lang, data, src, updated_at) VALUES(?,?,?,?,?,?)', [kind, ref, lang, S(clean), srcKey(o), now()]);
}

const T_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: {
    k: { type: 'string' },
    en: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, highlights: { type: 'string' }, topic: { type: 'string' }, rename_to: { type: 'string' } }, required: ['name', 'description', 'highlights', 'topic', 'rename_to'], additionalProperties: false },
    zh: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, highlights: { type: 'string' }, topic: { type: 'string' }, rename_to: { type: 'string' } }, required: ['name', 'description', 'highlights', 'topic', 'rename_to'], additionalProperties: false },
  }, required: ['k', 'en', 'zh'], additionalProperties: false } } },
  required: ['items'], additionalProperties: false,
};
// one batch per call (the admin page keeps calling until nothing is left), so no request runs for minutes
export async function translateBatch({ size = 30 } = {}) {
  const { anthropic } = await aiKeys();
  if (!anthropic) throw new AiError('ยังไม่ได้ตั้ง Claude API Key — ใส่ได้ที่ ผู้ช่วยเพิ่มสินค้า → ตั้งค่า AI');
  const all = await sources();
  const have = new Set((await db.all('SELECT kind, ref, lang, src FROM translations')).map((r) => `${r.kind}:${r.ref}:${r.lang}:${r.src}`));
  const todo = all.filter((o) => LANGS.some((l) => !have.has(`${o.kind}:${o.ref}:${l}:${srcKey(o)}`)));
  const batch = todo.slice(0, size);
  if (!batch.length) return { translated: 0, remaining: 0 };
  const items = batch.map((o, i) => ({ k: String(i), kind: o.kind, ...Object.fromEntries(FIELDS[o.kind].map((f) => [f, o[f]])) }));
  const client = new Anthropic({ apiKey: anthropic, timeout: 90e3, maxRetries: 1 });
  let res;
  try {
    res = await client.beta.messages.create({
      model: AI_MODEL, max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
      output_config: { effort: 'low', format: { type: 'json_schema', schema: T_SCHEMA } },
      messages: [{ role: 'user', content: [
        'Translate the customer-facing text of a Korean-style ramyeon shop in Thailand from Thai into English (en) and Simplified Chinese (zh) for its customer display.',
        'kind "product": menu item (name, description, highlights = one selling point per line; keep the same line breaks). kind "option": a choice on an item (name; topic when given, e.g. "ใส่ผักชี" → "Coriander"; rename_to = the dish name the item becomes when this choice is picked). kind "country": country name. kind "spice": a spice-level word.',
        'Use the names customers know: brand and Korean dish names in their usual English / Chinese form (e.g. Shin Ramyun / 辛拉面, Tteokbokki / 炒年糕), not a word-for-word translation. Short, natural menu wording. Keep emoji. Leave a field empty when the Thai one is empty or the field does not apply.',
        'Return every item with its k.',
        JSON.stringify(items),
      ].join('\n') }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('API Key ของ Claude ไม่ถูกต้อง — ตรวจสอบที่ ตั้งค่า AI');
    if (e instanceof Anthropic.RateLimitError) throw new AiError('ใช้งาน AI ถี่เกินไป — รอสักครู่แล้วลองใหม่');
    if (e instanceof Anthropic.APIConnectionTimeoutError) throw new AiError('AI ตอบไม่ทันเวลา — ลองใหม่', 'timeout');
    if (e instanceof Anthropic.APIError) throw new AiError(`AI ขัดข้อง (${e.status}) — ลองใหม่อีกครั้ง`);
    throw e;
  }
  const block = res.content.find((b) => b.type === 'text');
  let out;
  try { out = JSON.parse(block && block.text); } catch { throw new AiError('อ่านคำตอบของ AI ไม่ได้ — ลองใหม่'); }
  let n = 0;
  for (const it of out.items || []) {
    const o = batch[Number(it.k)];
    if (!o) continue;
    for (const l of LANGS) if (it[l] && String(it[l].name || '').trim()) { await saveTranslation(o.kind, o.ref, l, it[l]); n++; }
  }
  // an item the AI skipped stays missing; the caller stops when a batch translates nothing
  return { translated: n, remaining: (await translationStatus()).missing };
}
