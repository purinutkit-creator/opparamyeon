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

// shift reports use the same idea: <shift id>.<signature> (QR on the shift slip)
const signShift = async (id) => crypto.createHmac('sha256', await secret()).update('shift:' + id).digest('hex').slice(0, 12);
export async function shiftToken(id) { return `${id}.${await signShift(id)}`; }
export async function shiftFromToken(tok) {
  const m = /^([0-9a-f-]{8,40})\.([0-9a-f]{12})$/i.exec(String(tok || '').trim());
  if (!m) return null;
  const want = Buffer.from(await signShift(m[1].toLowerCase())), got = Buffer.from(m[2].toLowerCase());
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1].toLowerCase() : null;
}

// staff cards: QR = <staff code>.<signature>; scanned at the POS login or opened on a phone
const signStaff = async (code) => crypto.createHmac('sha256', await secret()).update('staff:' + code).digest('hex').slice(0, 12);
export async function staffToken(code) { return `${code}.${await signStaff(code)}`; }
export async function staffFromToken(tok) {
  const m = /^([A-Za-z0-9_-]{1,20})\.([0-9a-f]{12})$/i.exec(String(tok || '').trim());
  if (!m) return null;
  const want = Buffer.from(await signStaff(m[1])), got = Buffer.from(m[2].toLowerCase());
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? m[1] : null;
}

// Attendance (staff clock-in) link on the clock-in slip: /at/#<YYYY-MM-DD>.<12 hex>
// It opens that day and lets the owner step through the days around it (31 days either side).
const signAtt = async (day) => crypto.createHmac('sha256', await secret()).update('att:' + day).digest('hex').slice(0, 12);
export async function attendanceToken(day) { return `${day}.${await signAtt(day)}`; }
export const ATT_WINDOW_DAYS = 31;
export async function attendanceFromToken(tok, wanted) {
  const m = /^(\d{4}-\d{2}-\d{2})\.([0-9a-f]{12})$/i.exec(String(tok || '').trim());
  if (!m) return null;
  const want = Buffer.from(await signAtt(m[1])), got = Buffer.from(m[2].toLowerCase());
  if (!(want.length === got.length && crypto.timingSafeEqual(want, got))) return null;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(wanted || '')) ? wanted : m[1];
  const gap = Math.abs(Date.parse(day + 'T00:00:00Z') - Date.parse(m[1] + 'T00:00:00Z')) / 864e5;
  return gap <= ATT_WINDOW_DAYS ? { base: m[1], day } : null;
}

// Clock-in ticket: handed out when a PIN is accepted on the POS, so the selfie (taken on the POS or on a phone via QR)
// can be tied to that person without a session. <staff id>.<expiry base36>.<12 hex>, valid 15 minutes.
const signTicket = async (body) => crypto.createHmac('sha256', await secret()).update('clockin:' + body).digest('hex').slice(0, 12);
export async function clockinTicket(staffId, minutes = 15) {
  const body = `${staffId}.${(Date.now() + minutes * 60e3).toString(36)}`;
  return `${body}.${await signTicket(body)}`;
}
export async function staffFromTicket(tok) {
  const m = /^([A-Za-z0-9_-]{1,64})\.([0-9a-z]{6,12})\.([0-9a-f]{12})$/.exec(String(tok || '').trim());
  if (!m) return null;
  const want = Buffer.from(await signTicket(`${m[1]}.${m[2]}`)), got = Buffer.from(m[3]);
  if (!(want.length === got.length && crypto.timingSafeEqual(want, got))) return null;
  return parseInt(m[2], 36) > Date.now() ? m[1] : null;
}
