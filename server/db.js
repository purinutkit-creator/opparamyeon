// Database adapter: PostgreSQL when DATABASE_URL is set (Render), otherwise SQLite (node:sqlite).
// All SQL is written with `?` placeholders and portable types; both engines share one code path.
import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS roles (id TEXT PRIMARY KEY, name TEXT NOT NULL, perms TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS staff (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, photo TEXT, role_id TEXT NOT NULL,
  pin_hash TEXT NOT NULL, active INTEGER DEFAULT 1, failed_attempts INTEGER DEFAULT 0, locked_until TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, kind TEXT NOT NULL, subject_id TEXT NOT NULL, terminal_id TEXT,
  created_at TEXT, expires_at TEXT, revoked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS terminals (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT, last_seen TEXT, info TEXT);
CREATE TABLE IF NOT EXISTS display_pairings (id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT,
  used_at TEXT, display_token TEXT, revoked INTEGER DEFAULT 0, created_at TEXT, last_seen TEXT, mode TEXT, touch INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1, color TEXT);
CREATE TABLE IF NOT EXISTS stations (id TEXT PRIMARY KEY, name TEXT NOT NULL, split_mode TEXT DEFAULT 'order', bowls_per_ticket INTEGER DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL, category_id TEXT, description TEXT,
  image TEXT, price INTEGER NOT NULL DEFAULT 0, cost INTEGER NOT NULL DEFAULT 0, unit TEXT DEFAULT 'ชิ้น', bowl_count {REAL} DEFAULT 0,
  per_bowl_limit INTEGER DEFAULT 0, station_id TEXT, track_stock INTEGER DEFAULT 0, stock {REAL} DEFAULT 0, low_stock {REAL} DEFAULT 0,
  active INTEGER DEFAULT 1, sold_out INTEGER DEFAULT 0, kind TEXT DEFAULT 'simple', recipe TEXT DEFAULT '[]', option_groups TEXT DEFAULT '[]',
  sort INTEGER DEFAULT 0, mobile INTEGER DEFAULT 1, updated_at TEXT);
CREATE TABLE IF NOT EXISTS barcodes (code TEXT PRIMARY KEY, product_id TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS option_groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, min_select INTEGER DEFAULT 0, max_select INTEGER DEFAULT 1,
  options TEXT DEFAULT '[]', sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS ingredients (id TEXT PRIMARY KEY, name TEXT NOT NULL, unit TEXT, stock {REAL} DEFAULT 0, low_stock {REAL} DEFAULT 0, cost INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS stock_moves (id TEXT PRIMARY KEY, item_type TEXT, item_id TEXT, qty {REAL}, reason TEXT, ref TEXT, staff_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS dining_tables (id TEXT PRIMARY KEY, name TEXT NOT NULL, zone TEXT, seats INTEGER DEFAULT 2, sort INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1, status TEXT DEFAULT 'free');
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, bill_no TEXT UNIQUE NOT NULL, queue_no TEXT, source TEXT DEFAULT 'pos', terminal_id TEXT,
  shift_id TEXT, staff_id TEXT, status TEXT NOT NULL, dine_type TEXT, table_id TEXT, table_name TEXT, customer_name TEXT, customer_phone TEXT,
  note TEXT, member_id TEXT, items_total INTEGER DEFAULT 0, discount INTEGER DEFAULT 0, discount_info TEXT, packaging INTEGER DEFAULT 0,
  tax INTEGER DEFAULT 0, total INTEGER DEFAULT 0, paid_amount INTEGER DEFAULT 0, change_amount INTEGER DEFAULT 0, bowls {REAL} DEFAULT 0,
  cost_total INTEGER DEFAULT 0, refunded_amount INTEGER DEFAULT 0, refunded_bowls {REAL} DEFAULT 0, refunded_cost INTEGER DEFAULT 0,
  created_at TEXT, updated_at TEXT, paid_at TEXT, business_date TEXT, paid_business_date TEXT, idempotency_key TEXT UNIQUE,
  mobile_session_id TEXT, prep_status TEXT DEFAULT 'none', pay_mode TEXT, expires_at TEXT, points_earned INTEGER DEFAULT 0,
  claim_token TEXT UNIQUE, claim_status TEXT, void_reason TEXT, voided_by TEXT, voided_at TEXT, version INTEGER DEFAULT 1, reprints INTEGER DEFAULT 0,
  verify_status TEXT);
CREATE INDEX IF NOT EXISTS idx_orders_bd ON orders (paid_business_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE TABLE IF NOT EXISTS order_items (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, product_id TEXT, name TEXT, qty INTEGER NOT NULL,
  unit_price INTEGER, options TEXT, options_price INTEGER DEFAULT 0, line_total INTEGER, cost_unit INTEGER DEFAULT 0, dine_type TEXT,
  note TEXT, bowl_group INTEGER, bowl_count {REAL} DEFAULT 0, station_id TEXT, void_qty INTEGER DEFAULT 0, refunded_qty INTEGER DEFAULT 0,
  sent_qty INTEGER DEFAULT 0, seq INTEGER DEFAULT 0, category_id TEXT, created_at TEXT, reward_coupon_id TEXT);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items (order_id);
CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, method TEXT NOT NULL, amount INTEGER NOT NULL,
  received INTEGER DEFAULT 0, change_amount INTEGER DEFAULT 0, ref TEXT, status TEXT DEFAULT 'paid', provider TEXT, provider_ref TEXT UNIQUE,
  staff_id TEXT, shift_id TEXT, created_at TEXT, business_date TEXT, slip_file TEXT, meta TEXT);
CREATE INDEX IF NOT EXISTS idx_pay_order ON payments (order_id);
CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, kind TEXT, items TEXT, amount INTEGER, bowls {REAL}, cost INTEGER DEFAULT 0,
  reason TEXT, staff_id TEXT, shift_id TEXT, method TEXT, created_at TEXT, business_date TEXT, idempotency_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS kitchen_tickets (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, station_id TEXT, kind TEXT, content TEXT,
  status TEXT DEFAULT 'new', created_at TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS printers (id TEXT PRIMARY KEY, name TEXT NOT NULL, conn TEXT NOT NULL, address TEXT, port INTEGER, paper INTEGER DEFAULT 80,
  margin INTEGER DEFAULT 0, copies INTEGER DEFAULT 1, roles TEXT DEFAULT '[]', station_ids TEXT DEFAULT '[]', cut_mode TEXT DEFAULT 'full',
  feed_before INTEGER DEFAULT 3, feed_after INTEGER DEFAULT 1, buzzer INTEGER DEFAULT 0, beep_count INTEGER DEFAULT 4, render TEXT DEFAULT 'raster',
  host_terminal_id TEXT, status TEXT, status_at TEXT, templates TEXT DEFAULT '{}', can_confirm INTEGER DEFAULT 0, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS print_jobs (id TEXT PRIMARY KEY, printer_id TEXT, doc_type TEXT, ref_id TEXT, payload TEXT, status TEXT DEFAULT 'queued',
  attempts INTEGER DEFAULT 0, error TEXT, dedupe_key TEXT UNIQUE, claimed_by TEXT, created_at TEXT, updated_at TEXT, history TEXT DEFAULT '[]', seq INTEGER);
CREATE INDEX IF NOT EXISTS idx_jobs_printer ON print_jobs (printer_id, status);
CREATE TABLE IF NOT EXISTS templates (id TEXT PRIMARY KEY, doc_type TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, is_default INTEGER DEFAULT 0, updated_at TEXT);
CREATE TABLE IF NOT EXISTS fonts (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT, family TEXT, weights TEXT, file_id TEXT, format TEXT, has_thai INTEGER, created_at TEXT);
CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, name TEXT, mime TEXT, size INTEGER, data TEXT, path TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS shifts (id TEXT PRIMARY KEY, terminal_id TEXT, staff_id TEXT, opened_at TEXT, opening_cash INTEGER DEFAULT 0, note TEXT,
  closed_at TEXT, closed_by TEXT, counted_cash INTEGER, expected_cash INTEGER, diff INTEGER, summary TEXT, status TEXT DEFAULT 'open', business_date TEXT);
CREATE TABLE IF NOT EXISTS cash_moves (id TEXT PRIMARY KEY, shift_id TEXT, type TEXT, amount INTEGER, reason TEXT, staff_id TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS counters (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, actor TEXT, action TEXT, entity TEXT, entity_id TEXT, before_val TEXT, after_val TEXT,
  reason TEXT, created_at TEXT);
CREATE TABLE IF NOT EXISTS business_day_rules (id TEXT PRIMARY KEY, effective_from TEXT NOT NULL, cutoff TEXT NOT NULL, timezone TEXT NOT NULL, created_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS mobile_sessions (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, ref TEXT, mode TEXT, table_id TEXT, origin_order_id TEXT,
  status TEXT DEFAULT 'active', single_use INTEGER DEFAULT 0, used_count INTEGER DEFAULT 0, expires_at TEXT, created_by TEXT, created_at TEXT,
  closed_at TEXT, closed_reason TEXT, allow_table_change INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, member_no TEXT UNIQUE NOT NULL, phone TEXT UNIQUE NOT NULL, first_name TEXT, last_name TEXT,
  nickname TEXT, birthday TEXT, email TEXT, avatar TEXT, extra TEXT DEFAULT '{}', status TEXT DEFAULT 'active', note TEXT, password_hash TEXT,
  password_is_default INTEGER DEFAULT 1, tier_id TEXT, tier_manual INTEGER DEFAULT 0, tier_since TEXT, tier_expires TEXT, points INTEGER DEFAULT 0,
  reserved_points INTEGER DEFAULT 0, tier_score INTEGER DEFAULT 0, total_spent INTEGER DEFAULT 0, bills INTEGER DEFAULT 0, visits INTEGER DEFAULT 0,
  last_visit TEXT, created_at TEXT, failed_logins INTEGER DEFAULT 0, locked_until TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS point_ledger (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, delta INTEGER NOT NULL, kind TEXT, order_id TEXT, ref TEXT,
  balance_after INTEGER, expires_at TEXT, remaining INTEGER DEFAULT 0, reason TEXT, actor TEXT, created_at TEXT, unique_key TEXT UNIQUE);
CREATE INDEX IF NOT EXISTS idx_ledger_member ON point_ledger (member_id);
CREATE TABLE IF NOT EXISTS tiers (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, icon TEXT, card_image TEXT, sort INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
  min_spent INTEGER DEFAULT 0, min_visits INTEGER DEFAULT 0, min_points INTEGER DEFAULT 0, window_days INTEGER DEFAULT 365, duration_days INTEGER DEFAULT 365,
  multiplier {REAL} DEFAULT 1, discount_pct {REAL} DEFAULT 0, benefits TEXT);
CREATE TABLE IF NOT EXISTS rewards (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, image TEXT, points INTEGER NOT NULL, product_id TEXT,
  tier_ids TEXT DEFAULT '[]', total_limit INTEGER DEFAULT 0, per_member_limit INTEGER DEFAULT 0, starts_at TEXT, ends_at TEXT, coupon_days INTEGER DEFAULT 7,
  active INTEGER DEFAULT 1, issued_count INTEGER DEFAULT 0, return_policy TEXT DEFAULT 'refund_points', terms TEXT, cost INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS coupons (id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, member_id TEXT NOT NULL, reward_id TEXT NOT NULL, points INTEGER,
  status TEXT DEFAULT 'reserved', created_at TEXT, expires_at TEXT, used_at TEXT, used_by TEXT, used_terminal TEXT, cost INTEGER DEFAULT 0, business_date TEXT);
CREATE TABLE IF NOT EXISTS password_resets (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, status TEXT DEFAULT 'pending', created_at TEXT, updated_at TEXT,
  history TEXT DEFAULT '[]', token_hash TEXT, token_expires TEXT, handled_by TEXT);
CREATE TABLE IF NOT EXISTS verifications (id TEXT PRIMARY KEY, member_id TEXT NOT NULL, purpose TEXT, ref TEXT, method TEXT, code_hash TEXT,
  status TEXT DEFAULT 'pending', expires_at TEXT, attempts INTEGER DEFAULT 0, created_at TEXT, approved_by TEXT);
CREATE TABLE IF NOT EXISTS member_prompts (id TEXT PRIMARY KEY, terminal_id TEXT NOT NULL, cart_id TEXT NOT NULL, status TEXT DEFAULT 'open',
  expires_at TEXT, member_id TEXT, created_at TEXT, created_by TEXT);
CREATE TABLE IF NOT EXISTS payment_intents (id TEXT PRIMARY KEY, order_id TEXT NOT NULL, provider TEXT, provider_ref TEXT UNIQUE, amount INTEGER, status TEXT DEFAULT 'pending',
  url TEXT, created_at TEXT, updated_at TEXT, raw TEXT);
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, provider TEXT, event_key TEXT UNIQUE, payload TEXT, status TEXT, created_at TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS device_reports (id TEXT PRIMARY KEY, terminal_id TEXT, kind TEXT, data TEXT, created_at TEXT);
`;

// Columns added after v1.0.0 (existing databases get them on boot)
const MIGRATIONS = [
  ['printers', 'options', "TEXT DEFAULT '{}'"],
  ['products', 'big_options', 'INTEGER DEFAULT 0'],
  ['option_groups', 'display', "TEXT DEFAULT 'normal'"],
  ['option_groups', 'rename_all', 'INTEGER DEFAULT 0'],
];

class SqliteDB {
  constructor(file) {
    this.kind = 'sqlite';
    this.file = file;
  }
  async init() {
    const { DatabaseSync } = await import('node:sqlite');
    if (this.file !== ':memory:') fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=OFF;');
    this.db.exec(SCHEMA.replaceAll('{REAL}', 'REAL'));
    for (const [t, c, d] of MIGRATIONS) {
      const cols = this.db.prepare(`PRAGMA table_info(${t})`).all().map((x) => x.name);
      if (!cols.includes(c)) this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${d}`);
    }
    this.lock = Promise.resolve();
  }
  _norm(params) { return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)); }
  async all(sql, params = []) { return this.db.prepare(sql).all(...this._norm(params)).map((r) => ({ ...r })); }
  async get(sql, params = []) { const r = this.db.prepare(sql).get(...this._norm(params)); return r ? { ...r } : undefined; }
  async run(sql, params = []) { const r = this.db.prepare(sql).run(...this._norm(params)); return { changes: Number(r.changes) }; }
  // SQLite has one connection; serialize transactions with a promise chain so awaits inside do not interleave.
  async tx(fn) {
    const prev = this.lock; let release;
    this.lock = new Promise((r) => (release = r));
    await prev;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const t = { kind: 'sqlite', all: (q, p) => this.all(q, p), get: (q, p) => this.get(q, p), run: (q, p) => this.run(q, p) };
      try { const out = await fn(t); this.db.exec('COMMIT'); return out; }
      catch (e) { this.db.exec('ROLLBACK'); throw e; }
    } finally { release(); }
  }
  async close() { this.db.close(); }
}

class PgDB {
  constructor(url) { this.kind = 'pg'; this.url = url; }
  async init() {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(20, (v) => parseInt(v, 10));
    pg.types.setTypeParser(1700, (v) => parseFloat(v));
    pg.types.setTypeParser(701, (v) => parseFloat(v));
    // Render internal hosts (no dot, e.g. dpg-xxxx-a) and localhost connect without SSL; external hosts use SSL
    let host = '';
    try { host = new URL(this.url).hostname; } catch { /* keep default */ }
    const ssl = process.env.PGSSL === 'off' || /^(localhost|127\.0\.0\.1)$/.test(host) || (host && !host.includes('.')) ? false : { rejectUnauthorized: false };
    this.pool = new pg.Pool({ connectionString: this.url, ssl, max: 10 });
    await this.pool.query(SCHEMA.replaceAll('{REAL}', 'DOUBLE PRECISION'));
    for (const [t, c, d] of MIGRATIONS) await this.pool.query(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS ${c} ${d}`);
  }
  _sql(sql) { let i = 0; return sql.replace(/\?/g, () => '$' + ++i); }
  _norm(params) { return params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p)); }
  async all(sql, params = [], client) { return (await (client || this.pool).query(this._sql(sql), this._norm(params))).rows; }
  async get(sql, params = [], client) { return (await this.all(sql, params, client))[0]; }
  async run(sql, params = [], client) { const r = await (client || this.pool).query(this._sql(sql), this._norm(params)); return { changes: r.rowCount }; }
  async tx(fn) {
    const client = await this.pool.connect();
    const t = { kind: 'pg', all: (s, p) => this.all(s, p, client), get: (s, p) => this.get(s, p, client), run: (s, p) => this.run(s, p, client), tx: (f) => f(t) };
    try {
      await client.query('BEGIN');
      const out = await fn(t);
      await client.query('COMMIT');
      return out;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
}

// Every query issued inside db.tx(...) automatically goes to the transaction connection,
// so library helpers can just use `db.get/run/all` and still be part of the caller's transaction.
const als = new AsyncLocalStorage();
let impl;
export const db = {
  get kind() { return impl.kind; },
  all: (s, p) => (als.getStore() || impl).all(s, p),
  get: (s, p) => (als.getStore() || impl).get(s, p),
  // SQLite: a write outside a transaction must not slip into another request's open transaction.
  run: (s, p) => { const cur = als.getStore(); if (cur) return cur.run(s, p); return impl.kind === 'sqlite' ? db.tx((t) => t.run(s, p)) : impl.run(s, p); },
  tx: async (fn) => {
    const cur = als.getStore(); if (cur) return fn(cur);
    const hooks = [];
    const out = await impl.tx((t) => { t.hooks = hooks; return als.run(t, () => fn(t)); });
    for (const h of hooks) { try { h(); } catch (e) { console.error(e); } }
    return out;
  },
  // run after the surrounding transaction commits (immediately when not in a transaction)
  afterCommit: (fn) => { const cur = als.getStore(); if (cur && cur.hooks) cur.hooks.push(fn); else fn(); },
  close: () => impl.close(),
};

export async function openDb({ url = process.env.DATABASE_URL, file = process.env.SQLITE_FILE || './data/pos.db' } = {}) {
  impl = url ? new PgDB(url) : new SqliteDB(file);
  await impl.init();
  return db;
}

export const J = (v, d = null) => { if (v === null || v === undefined || v === '') return d; try { return JSON.parse(v); } catch { return d; } };
export const S = (v) => JSON.stringify(v ?? null);
