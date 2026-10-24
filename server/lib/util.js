import crypto from 'node:crypto';
import { db, J, S } from '../db.js';
import { businessDate as bd } from '../../public/shared/core.js';

export const id = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const addMinutes = (m, from = new Date()) => new Date(from.getTime() + m * 60000).toISOString();

export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(String(secret), salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
export function verifySecret(secret, stored) {
  if (!stored) return false;
  const [, salt, key] = stored.split('$');
  const k = crypto.scryptSync(String(secret), Buffer.from(salt, 'hex'), 32, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(k, Buffer.from(key, 'hex'));
}
// Short codes for coupons: unambiguous alphabet, random, not derived from member data.
export function randomCode(len = 10, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789') {
  const bytes = crypto.randomBytes(len);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}
export const randomDigits = (len = 6) => [...crypto.randomBytes(len)].map((b) => String(b % 10)).join('');

export class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
export const bad = (msg, code) => new HttpError(400, msg, code);
export const forbidden = (msg = 'ไม่มีสิทธิ์ทำรายการนี้') => new HttpError(403, msg, 'forbidden');
export const notFound = (msg = 'ไม่พบข้อมูล') => new HttpError(404, msg, 'not_found');
export const conflict = (msg, code = 'conflict') => new HttpError(409, msg, code);

export const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- settings ----------
export const DEFAULT_SETTINGS = {
  store: { name: 'Oppa Ramyeon', branch: 'สาขาหลัก', address: '', phone: '', tax_id: '', logo: '', footer: 'ขอบคุณที่อุดหนุน 감사합니다', contact_line: '' },
  sale: { tax_rate: 0, tax_inclusive: true, packaging_fee: 0, packaging_mode: 'per_bowl', service_charge: 0,
    payment_methods: [{ id: 'cash', name: 'เงินสด', enabled: true }, { id: 'promptpay', name: 'QR พร้อมเพย์/โอน', enabled: true },
      { id: 'card', name: 'บัตร', enabled: true }, { id: 'other', name: 'อื่น ๆ', enabled: false }],
    kitchen_send: 'after_payment', auto_lock_minutes: 5, count_unit: 'ชาม', max_discount_pct: { cashier: 10, manager: 50, owner: 100 } },
  queue: { enabled: true, digits: 3, start: 1, prefix: '', dine_in_prefix: 'D', takeaway_prefix: 'T', separate: true, mixed_series: 'dine_in',
    scope: 'shared', reset: 'business_day', epoch: 0 },
  bill: { prefix: 'B' },
  sound: { enabled: true, volume: 0.8, count: 4, file: '', error_file: '', new_order_file: '', output: ['kitchen', 'pos'], on: 'sent', docs: 'all' },
  display: { layout: 'split', bg: '#111827', color: '#ffffff', accent: '#ef4444', logo: '', welcome: 'ยินดีต้อนรับสู่ Oppa Ramyeon', thanks: 'ขอบคุณค่ะ 감사합니다',
    media: [], image_seconds: 8, video_muted: true, video_volume: 0.5, fit: 'cover', show_qr: true, pairing_minutes: 10, member_prompt_seconds: 90 },
  fonts: { global: 'Sarabun', pos: '', display: '', member: '', mobile: '', admin: '', reports: '', receipt: '', kitchen: '', fallback: 'Sarabun, Noto Sans Thai, sans-serif',
    size: 16, weight: 400, line_height: 1.4, letter_spacing: 0 },
  payment: { promptpay_id: '', promptpay_name: '', promptpay_type: 'phone', slip_upload: true,
    providers: { beam: { enabled: false, mode: 'playground', merchant_id: '' } }, mock_enabled: false },
  mobile: { enabled: true, pickup_enabled: true, table_enabled: true, pickup_phone_required: false, pay_online: false, pay_cashier: true,
    qr_hours: 3, single_order: false, allow_table_change: false, pickup_kitchen: 'after_payment', table_kitchen: 'immediately',
    cashier_expire_minutes: 30, auto_print_mobile_with_receipt: false },
  members: { enabled: true, web_signup: true, fields: { first_name: { on: true, req: true }, last_name: { on: true, req: false }, nickname: { on: true, req: false },
    birthday: { on: true, req: false }, email: { on: false, req: false }, avatar: { on: false, req: false } }, custom_fields: [],
    show_on_receipt: true, show_on_display: true, signup_from_display: true, sensitive_verify: 'staff', otp_webhook_url: '' },
  points: { enabled: true, rate_baht: 25, rounding: 'floor', base: 'after_discount', include_tax: false, include_packaging: false, min_spend: 0,
    excluded_products: [], expire_days: 365, claim_qr: true, claim_enabled: true, claim_hours: 72, refund_policy: 'negative_allowed',
    tier_mode: 'auto' },
  // what prints automatically after payment, and in which order (same printer = printed in this order)
  print: { order: ['receipt', 'kitchen', 'merchant', 'queue'], auto_receipt: true, auto_merchant: false, auto_queue: false, kitchen_every_order: true },
  week_start: 1,
};

// ---------- server-side secrets (payment gateway keys). Never returned to any browser. ----------
export async function getSecret(key) {
  const r = await db.get('SELECT value FROM secrets WHERE key = ?', [key]);
  return r ? r.value : null;
}
export async function setSecret(key, value) {
  if (value === null || value === '') return db.run('DELETE FROM secrets WHERE key = ?', [key]);
  await db.run('INSERT INTO secrets(key, value, updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [key, String(value), new Date().toISOString()]);
}

let cache = null;
export async function getSettings() {
  if (cache) return cache;
  const rows = await db.all('SELECT key, value FROM settings');
  const out = structuredClone(DEFAULT_SETTINGS);
  for (const r of rows) {
    const v = J(r.value);
    out[r.key] = v && typeof v === 'object' && !Array.isArray(v) && out[r.key] ? deepMerge(out[r.key], v) : v;
  }
  cache = out;
  return out;
}
function deepMerge(a, b) {
  const o = { ...a };
  for (const [k, v] of Object.entries(b)) o[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k]) ? deepMerge(a[k], v) : v;
  return o;
}
export async function setSetting(key, value) {
  const cur = await getSettings();
  const merged = value && typeof value === 'object' && !Array.isArray(value) && cur[key] ? deepMerge(cur[key], value) : value;
  await db.run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, S(merged)]);
  cache = null;
  return merged;
}
export const clearSettingsCache = () => { cache = null; };

// ---------- business day ----------
let rulesCache = null;
export async function dayRules() {
  if (!rulesCache) rulesCache = await db.all('SELECT effective_from, cutoff, timezone FROM business_day_rules ORDER BY effective_from');
  return rulesCache.length ? rulesCache : [{ effective_from: '1970-01-01', cutoff: '00:00', timezone: 'Asia/Bangkok' }];
}
export const clearRulesCache = () => { rulesCache = null; };
export async function businessDateOf(when = new Date()) { return bd(when, await dayRules()); }

// ---------- audit ----------
export async function audit(actor, action, entity, entityId, before, after, reason) {
  await db.run('INSERT INTO audit(id, actor, action, entity, entity_id, before_val, after_val, reason, created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    [id(), actor || null, action, entity, entityId || null, before === undefined ? null : S(before), after === undefined ? null : S(after), reason || null, now()]);
}

// ---------- counters ----------
export async function nextCounter(key) {
  const r = await db.get('INSERT INTO counters(key, value) VALUES(?, 1) ON CONFLICT(key) DO UPDATE SET value = counters.value + 1 RETURNING value', [key]);
  return Number(r.value);
}

// ---------- realtime ----------
let ioRef = null;
export const setIO = (io) => { ioRef = io; };
export function emit(room, event, data) { db.afterCommit(() => { if (ioRef) ioRef.to(room).emit(event, data); }); }

// ---------- rate limiting (in memory, per key) ----------
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key) || { n: 0, reset: t + windowMs };
  if (t > b.reset) { b.n = 0; b.reset = t + windowMs; }
  b.n++;
  buckets.set(key, b);
  if (b.n > max * (Number(process.env.RATE_LIMIT_FACTOR) || 1)) throw new HttpError(429, `ทำรายการถี่เกินไป กรุณารอ ${Math.ceil((b.reset - t) / 1000)} วินาที`, 'rate_limited');
}
