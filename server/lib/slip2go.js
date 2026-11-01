// Slip2Go (slip verification service): looks a transfer up with the bank by the slip's QR (or its photo).
// Built from Slip2Go's public guide (POST /api/verify-slip/qr-code/info · qr-image/info, Authorization = secret key).
// The answer is read defensively — amount / receiver / reference / time wherever they appear — and the POS compares them itself.
import { getSecret, getSettings } from './util.js';

export const slip2goKey = async () => (await getSecret('slip2go_api_key')) || process.env.SLIP2GO_API_KEY || '';
const base = async () => String(process.env.SLIP2GO_BASE_URL || ((await getSettings()).payment || {}).slip2go_base || 'https://connect.slip2go.com').replace(/\/+$/, '');
export class Slip2GoError extends Error { constructor(msg, code) { super(msg); this.code = code; } }

const pick = (o, paths) => { for (const p of paths) { const v = p.split('.').reduce((x, k) => (x == null ? x : x[k]), o); if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
export function normalize(j) {
  const d = (j && (j.data || j.result)) || {};
  const amt = pick(d, ['amount.amount', 'amount', 'amountInBaht', 'transAmount']);
  return {
    code: String((j && (j.code ?? j.status)) ?? ''), message: String((j && (j.message || j.msg)) || ''),
    found: amt !== undefined && amt !== null && !Number.isNaN(Number(amt)),
    amount: Number(amt) || 0,
    receiver_name: String(pick(d, ['receiver.account.name.th', 'receiver.account.name.en', 'receiver.account.name', 'receiver.name.th', 'receiver.name.en', 'receiver.name', 'receiver.displayName']) || ''),
    receiver_account: String(pick(d, ['receiver.account.proxy.account', 'receiver.proxy.account', 'receiver.account.bank.account', 'receiver.account.account', 'receiver.account.value', 'receiver.accountNumber']) || ''),
    sender_name: String(pick(d, ['sender.account.name.th', 'sender.account.name.en', 'sender.name.th', 'sender.name']) || ''),
    ref: String(pick(d, ['transRef', 'referenceId', 'ref', 'transactionId']) || ''),
    date_time: String(pick(d, ['dateTime', 'transDate', 'date']) || ''),
  };
}
async function send(path, init, key) {
  const url = (await base()) + path;
  const go = (auth) => fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: auth }, signal: AbortSignal.timeout(Number(process.env.SLIP2GO_TIMEOUT_MS || 6000)) });
  let r = await go('Bearer ' + key);
  let j = await r.json().catch(() => ({}));
  // the guide shows the bare key; some accounts want "Bearer" — the other form is tried once on an auth error
  if (r.status === 401 || String(j.code) === '401001') { r = await go(key); j = await r.json().catch(() => ({})); }
  if (r.status === 401 || String(j.code).startsWith('401')) throw new Slip2GoError('Slip2Go ไม่รับ API Key นี้ — ตรวจคีย์ หรือ IP Whitelist ใน Slip2Go Dashboard', 'auth');
  return normalize(j);
}
export async function slip2goByQr(qrCode, key) {
  return send('/api/verify-slip/qr-code/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ payload: { qrCode } }) }, key);
}
export async function slip2goByImage(buf, mime, key) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime || 'image/jpeg' }), 'slip.jpg');
  return send('/api/verify-slip/qr-image/info', { method: 'POST', body: fd }, key);
}
