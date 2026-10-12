import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
const COOKIE = '__Host-lead_session';
// Cookie retention is renewed on visits; the signed session has no app expiry.
const COOKIE_MAX_AGE = 400 * 24 * 60 * 60;
export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json', 'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff', ...extra}});
}
function configured() { return process.env.APP_PASSWORD?.length >= 16 && process.env.SESSION_SECRET?.length >= 32; }
function signature(payload) {
  // Password rotation also invalidates existing sessions.
  return createHmac('sha256', process.env.SESSION_SECRET).update(`${process.env.APP_PASSWORD}\0${payload}`).digest('base64url');
}
export function equal(a, b) { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
export function issueSession() {
  if (!configured()) throw new Error('Authentication is not configured');
  const payload = Buffer.from(JSON.stringify({version: 2, nonce:randomBytes(16).toString('hex')})).toString('base64url');
  return `${payload}.${signature(payload)}`;
}
export function authenticated(request, now = Date.now()) {
  if (!configured()) return false;
  try {
    const cookie = (request.headers.get('cookie') || '').split(';').map(x=>x.trim()).find(x=>x.startsWith(`${COOKIE}=`))?.slice(COOKIE.length+1);
    if (!cookie || cookie.length > 1024) return false;
    const parts = cookie.split('.');
    if (parts.length !== 2 || !equal(parts[1], signature(parts[0]))) return false;
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (typeof payload.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(payload.nonce)) return false;
    if (payload.version === 2) return true;
    // Upgrade still-valid legacy sessions on their next visit, never expired ones.
    return payload.version === undefined && Number.isFinite(payload.expires) && payload.expires > now;
  } catch { return false; }
}
export const sessionCookie = token => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? COOKIE_MAX_AGE : 0}`;
export function sameOrigin(request) { return request.headers.get('origin') === new URL(request.url).origin; }
export async function readJSON(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new Error('Expected JSON');
  if (Number(request.headers.get('content-length')) > 4096) throw new Error('Request is too large');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body');
  const chunks = []; let length = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.length;
    if (length > 4096) { await reader.cancel(); throw new Error('Request is too large'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export { configured };
