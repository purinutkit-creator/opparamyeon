import { createApp } from '../server/index.js';
import { clearSettingsCache, clearRulesCache } from '../server/lib/util.js';

process.env.RATE_LIMIT_FACTOR = '100';
export async function startServer() {
  clearSettingsCache(); clearRulesCache();
  const ctx = await createApp({ db: { url: process.env.TEST_DATABASE_URL || '', file: ':memory:' }, noTimers: true });
  await new Promise((r) => ctx.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${ctx.server.address().port}`;
  const call = async (method, path, body, { token, terminal, headers = {} } = {}) => {
    const h = { ...headers };
    if (body !== undefined && !(body instanceof FormData)) h['Content-Type'] = 'application/json';
    if (token) h.Authorization = 'Bearer ' + token;
    if (terminal) h['X-Terminal-Id'] = terminal;
    const res = await fetch(base + path, { method, headers: h, body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json };
  };
  const login = async (code = '0001', pin = '1234', terminal = 'pos1') => (await call('POST', '/api/auth/login', { code, pin, terminal_id: terminal })).body.token;
  return { ...ctx, base, call, login };
}

export const key = () => 'k-' + Math.random().toString(36).slice(2) + Date.now();
export const line = (product_id, qty = 1, extra = {}) => ({ product_id, qty, options: [], dine_type: 'dine_in', ...extra });
export const ramyeonOpts = [{ group_id: 'og_noodle', id: 'n_shin' }, { group_id: 'og_spicy', id: 's2' }];
