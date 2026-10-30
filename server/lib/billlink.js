// Bill links that open without logging in (QR on the merchant slip): <bill_no>.<signature>.
// The signature is an HMAC with a per-shop secret kept in the secrets table, so links cannot be guessed from a bill number.
import crypto from 'node:crypto';
import { getSecret, setSecret } from './util.js';

let cached = null;
async function secret() {
  if (cached) return cached;
  let s = await getSecret('bill_link_secret');
  if (!s) { s = crypto.randomBytes(32).toString('hex'); await setSecret('bill_link_secret', s); }
  return (cached = s);
}
// lower-case hex only: it reads back correctly even when a scanner types it with a Thai keyboard layout
const sign = async (billNo) => crypto.createHmac('sha256', await secret()).update('bill:' + billNo).digest('hex').slice(0, 12);
export async function billToken(billNo) { return `${billNo}.${await sign(billNo)}`; }
export async function billFromToken(tok) {
  const m = /^([A-Z0-9-]{4,30})\.([0-9a-f]{12})$/i.exec(String(tok || '').trim());
  if (!m) return null;
  const billNo = m[1].toUpperCase();
  const want = Buffer.from(await sign(billNo)), got = Buffer.from(m[2].toLowerCase());
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? billNo : null;
}
export const resetBillSecretCache = () => { cached = null; };
