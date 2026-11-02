export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export const fail = (status: number, code: string, message: string): never => { throw new ApiError(status, code, message); };
const enc = new TextEncoder();
export const hex = (data: ArrayBuffer | Uint8Array) => [...new Uint8Array(data)].map(x => x.toString(16).padStart(2, '0')).join('');
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));
// Keys are private to this isolate, bounded, and reused across requests with the same configured secret.
const signingKeys = new Map<string, Promise<CryptoKey>>();
export async function hmac(secret: string, data: string) {
  let pending = signingKeys.get(secret);
  if (!pending) {
    if (signingKeys.size >= 4) signingKeys.delete(signingKeys.keys().next().value!);
    pending = crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    signingKeys.set(secret, pending);
  }
  let key: CryptoKey;
  try { key = await pending; } catch (e) { signingKeys.delete(secret); throw e; }
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
}
export function equal(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function passwordOK(password: string, config: string) {
  const [iterations, salt, expected] = config.split(':');
  if (!/^100000$/.test(iterations) || !/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{64}$/.test(expected || '')) throw new Error('INVALID_PASSWORD_CONFIG');
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: Number(iterations), hash: 'SHA-256' }, key, 256);
  return equal(hex(derived), expected);
}
export const cookieValue = (req: Request, name: string) => req.headers.get('Cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(name + '='))?.slice(name.length + 1);
export const cookie = (name: string, value: string, maxAge: number) => `${name}=${value}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
export async function visitor(req: Request, secret: string) {
  const stored = cookieValue(req, '__Host-festival-voter');
  let token = stored;
  if (stored) {
    const [id, expiry, sig] = stored.split('.');
    if (stored.split('.').length !== 3 || !/^[a-f0-9]{64}$/.test(id || '') || !/^\d{10}$/.test(expiry || '') || !equal(sig || '', await hmac(secret, `cookie:${id}.${expiry}`)) || Number(expiry) < Date.now() / 1000)
      fail(401, 'INVALID_VISITOR', '방문자 쿠키가 만료되었거나 유효하지 않습니다. 새로고침해 주세요.');
  } else {
    const body = `${randomToken()}.${Math.floor(Date.now() / 1000) + 86400 * 7}`;
    token = `${body}.${await hmac(secret, 'cookie:' + body)}`;
  }
  return { voterHash: await hmac(secret, 'voter:' + token!.split('.')[0]), setCookie: stored ? undefined : cookie('__Host-festival-voter', token!, 86400 * 7) };
}
export function originCheck(req: Request) {
  if (req.headers.get('Origin') !== new URL(req.url).origin || req.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403, 'CSRF', '같은 사이트에서 다시 요청해 주세요.');
  if (!(req.headers.get('Content-Type') || '').startsWith('application/json')) fail(415, 'JSON_REQUIRED', 'JSON 요청만 지원합니다.');
}
export async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get('Content-Length') || 0) > 8192) fail(413, 'BODY_TOO_LARGE', '입력 내용이 너무 깁니다.');
  const reader = req.body?.getReader();
  let data = new Uint8Array();
  if (reader) for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    if (data.length + value.length > 8192) { await reader.cancel(); fail(413, 'BODY_TOO_LARGE', '입력 내용이 너무 깁니다.'); }
    const next = new Uint8Array(data.length + value.length); next.set(data); next.set(value, data.length); data = next;
  }
  try { const parsed = JSON.parse(new TextDecoder().decode(data)); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw 0; return parsed; }
  catch { return fail(400, 'INVALID_JSON', '요청 내용을 확인해 주세요.'); }
}
export function textField(data: Record<string, unknown>, key: string, max = 80, optional = false) {
  const v = data[key];
  if ((v === undefined || v === '') && optional) return '';
  if (typeof v !== 'string' || !v.trim() || v.length > max) return fail(400, 'INVALID_INPUT', `${key}: 입력 길이와 형식을 확인해 주세요.`);
  return v.trim();
}
export function uuid(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)) return fail(400, 'INVALID_ID', '유효한 ID가 필요합니다.');
  return v;
}
export function version(v: unknown) {
  if (!Number.isSafeInteger(v) || Number(v) < 1) return fail(400, 'VERSION_REQUIRED', '최신 상태 버전이 필요합니다.'); return Number(v);
}
export function csvCell(v: unknown) {
  let s = String(v ?? '');
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(s) || /^[\t\r\n]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
// Classify infrastructure failures without exposing SQL, credentials, or raw exception text.
export function safeFailureCode(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    messages.push(current.message.slice(0, 8192));
    current = current.cause;
  }
  const text = messages.join('\n');
  if (/D1|SQLITE|database/i.test(text)) {
    if (/quota|daily (?:limit|usage)|exceeded.*(?:limit|allowance)|maximum.*(?:read|writ)|rows (?:read|written).*limit/i.test(text)) return 'DB_QUOTA_EXCEEDED';
    if (/overloaded|too many requests|SQLITE_BUSY|SQLITE_LOCKED|database is locked|temporarily unavailable/i.test(text)) return 'DB_BUSY';
    if (/no such (?:table|column)|has no column|schema|syntax error/i.test(text)) return 'DB_SCHEMA_ERROR';
    if (/constraint|foreign key|unique/i.test(text)) return 'DB_CONSTRAINT_ERROR';
    return 'DB_ERROR';
  }
  return 'INTERNAL_ERROR';
}
