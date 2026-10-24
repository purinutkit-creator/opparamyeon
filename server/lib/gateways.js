// Payment gateway adapters. Keys are entered by the shop in the admin page and stored server-side (secrets table),
// or given as environment variables. They are never sent to any browser.
// Each adapter: createCharge(order, opts) -> { provider_ref, url }, verifyWebhook(rawBody, headers) -> boolean,
// parseWebhook(json, headers) -> { event_key, provider_ref, paid, amount }, fetchStatus(provider_ref) -> { paid, amount, reference }.
import crypto from 'node:crypto';
import { getSecret } from './util.js';

const safeEq = (a, b) => { const x = Buffer.from(String(a)); const y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// Beam Checkout (https://docs.beamcheckout.com): payment links API + HMAC-SHA256 (base64) webhook signature in X-Beam-Signature.
// The field names below follow the public Payment Links docs; verify them against the current docs in the playground before going live.
export async function beamCreds() {
  return {
    merchantId: (await getSecret('beam.merchant_id')) || process.env.BEAM_MERCHANT_ID || '',
    apiKey: (await getSecret('beam.api_key')) || process.env.BEAM_API_KEY || '',
    webhookSecret: (await getSecret('beam.webhook_secret')) || process.env.BEAM_WEBHOOK_SECRET || '',
  };
}
export const beam = {
  id: 'beam',
  name: 'Beam Checkout',
  async configured() { const c = await beamCreds(); return !!(c.merchantId && c.apiKey && c.webhookSecret); },
  base: (mode) => (mode === 'live' ? 'https://api.beamcheckout.com' : 'https://playground.api.beamcheckout.com'),
  async auth() { const c = await beamCreds(); return 'Basic ' + Buffer.from(`${c.merchantId}:${c.apiKey}`).toString('base64'); },
  async createCharge(order, { mode, redirectUrl, expiresAt }) {
    const body = {
      order: { currency: 'THB', netAmount: order.total, description: `Order ${order.bill_no}`, referenceId: order.id },
      redirectUrl, expiresAt,
      linkSettings: { qrPromptPay: { isEnabled: true }, card: { isEnabled: true } },
    };
    const r = await fetch(this.base(mode) + '/api/v1/payment-links', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: await this.auth() }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Beam: ' + (j.error && j.error.errorMessage || r.status));
    return { provider_ref: j.id, url: j.url, raw: j };
  },
  // connection test from the admin page: a status lookup of a non-existent link must answer 404, not 401
  async test(mode) {
    const r = await fetch(this.base(mode) + '/api/v1/payment-links/connection-test', { headers: { Authorization: await this.auth() } }).catch((e) => ({ status: 0, error: e.message }));
    if (r.status === 401 || r.status === 403) return { ok: false, message: 'Merchant ID หรือ API Key ไม่ถูกต้อง (' + r.status + ')' };
    if (!r.status) return { ok: false, message: 'เชื่อมต่อ Beam ไม่ได้: ' + r.error };
    return { ok: true, message: 'เชื่อมต่อ Beam ได้ (HTTP ' + r.status + ')' };
  },
  async verifyWebhook(raw, headers) {
    const sig = headers['x-beam-signature'];
    const { webhookSecret } = await beamCreds();
    if (!sig || !webhookSecret) return false;
    const key = Buffer.from(webhookSecret, 'base64');
    const mac = crypto.createHmac('sha256', key).update(raw).digest('base64');
    return safeEq(mac, sig);
  },
  parseWebhook(j, headers) {
    const ev = headers['x-beam-event'] || j.event || '';
    const link = j.paymentLink || j.data || j;
    return { event: ev, event_key: `${ev}:${link.id || j.id}:${link.status || ''}`, provider_ref: link.id || j.paymentLinkId, paid: /paid|succeeded/i.test(ev) };
  },
  async fetchStatus(ref, { mode }) {
    const r = await fetch(this.base(mode) + '/api/v1/payment-links/' + encodeURIComponent(ref), { headers: { Authorization: await this.auth() } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('Beam status ' + r.status);
    const status = String(j.status || '').toUpperCase();
    return { paid: status === 'PAID' || status === 'SUCCEEDED', amount: j.order ? j.order.netAmount : j.amount, reference: j.order ? j.order.referenceId : j.referenceId, raw: j };
  },
};

// Test gateway for end-to-end testing (enable "mock" in settings). Signs its webhook with MOCK_WEBHOOK_SECRET.
const mockStore = new Map();
export const mock = {
  id: 'mock', name: 'ทดสอบ (Mock Gateway)',
  secret: () => process.env.MOCK_WEBHOOK_SECRET || 'mock-secret-for-testing',
  configured: async () => true,
  async createCharge(order) {
    const ref = 'mock_' + crypto.randomBytes(8).toString('hex');
    mockStore.set(ref, { amount: order.total, reference: order.id, paid: false });
    return { provider_ref: ref, url: `/m/mock-pay.html#${ref}` };
  },
  sign(raw) { return crypto.createHmac('sha256', this.secret()).update(raw).digest('base64'); },
  verifyWebhook(raw, headers) { return !!headers['x-mock-signature'] && safeEq(this.sign(raw), headers['x-mock-signature']); },
  parseWebhook(j) { return { event: j.event, event_key: `${j.event}:${j.ref}`, provider_ref: j.ref, paid: j.event === 'paid' }; },
  async fetchStatus(ref) { const s = mockStore.get(ref); if (!s) throw new Error('unknown'); return { ...s }; },
  markPaid(ref) { const s = mockStore.get(ref); if (s) s.paid = true; return s; },
};

export const GATEWAYS = { beam, mock };
