import type { Context } from 'hono';
import type { Role } from '@dni/shared';
import type { ZodTypeAny, z } from 'zod';

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS?: Fetcher;
  ENGINE_TOKEN: string;
  ENCRYPTION_KEY: string;
  APP_ORIGINS: string;
  COOKIE_SECURE: string;
  ALLOW_PRIVATE_DESTINATIONS: string;
  LEASE_TTL_SEC: string;
  ALLOW_SIGNUPS?: string;
  /** Acceso con Google (opcional). Sin estos secretos el botón no se muestra. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Solo en producción (Cloudflare Containers). */
  ENGINE?: DurableObjectNamespace;
  PUBLIC_URL?: string;
  ENGINE_CAPACITY?: string;
  ENGINE_MAX_NODES?: string;
  /** JSON {nombre: sha256} de los artefactos del motor publicados en R2 (lo rellena el script de despliegue). */
  ENGINE_ASSETS?: string;
}

export interface AuthCtx { userId: string; orgId: string; role: Role; plan: string; email: string; superadmin: boolean }
export type AppEnv = { Bindings: Env; Variables: { auth: AuthCtx } };
export type Ctx = Context<AppEnv>;

export class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 429 | 500 | 503, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const notFound = (what = 'Recurso') => new HttpError(404, 'not_found', `${what} no encontrado.`);

export async function parseBody<S extends ZodTypeAny>(c: Ctx, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try { json = await c.req.json(); } catch { throw new HttpError(400, 'invalid_json', 'El cuerpo debe ser JSON válido.'); }
  const r = schema.safeParse(json);
  if (!r.success) {
    throw new HttpError(422, 'validation_error', r.error.issues[0]?.message ?? 'Datos no válidos.', r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  return r.data;
}

export const newId = (prefix: string) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;

// ---------- D1 ----------
export const first = <T>(db: D1Database, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).first<T>();
export const all = async <T>(db: D1Database, sql: string, ...params: unknown[]) => (await db.prepare(sql).bind(...params).all<T>()).results;
export const run = (db: D1Database, sql: string, ...params: unknown[]) => db.prepare(sql).bind(...params).run();

// ---------- Criptografía (WebCrypto) ----------
const enc = new TextEncoder();
const b64u = (buf: ArrayBuffer | Uint8Array) => {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (ch) => ch.charCodeAt(0));

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const randomToken = (bytes = 32) => b64u(crypto.getRandomValues(new Uint8Array(bytes)));

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  // Comparar digests de longitud fija evita filtrar la longitud y el contenido por tiempo.
  const [da, db] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(a)), crypto.subtle.digest('SHA-256', enc.encode(b))]);
  const [x, y] = [new Uint8Array(da), new Uint8Array(db)];
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

const PBKDF2_ITER = 100_000; // máximo admitido por WebCrypto en Workers
async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PBKDF2_ITER}$${b64u(salt)}$${b64u(await pbkdf2(password, salt, PBKDF2_ITER))}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2-sha256' || !iter || !salt || !hash) return false;
  const got = b64u(await pbkdf2(password, unb64(salt), Number(iter)));
  return timingSafeEqual(got, hash);
}

async function aesKey(env: Env) {
  const raw = unb64(env.ENCRYPTION_KEY ?? '');
  if (raw.length !== 32) throw new HttpError(500, 'encryption_not_configured', 'ENCRYPTION_KEY no está configurada (32 bytes en base64).');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
/** AES-256-GCM con AAD ligado al recurso: un cifrado copiado a otra fila no descifra. */
export async function encryptSecret(env: Env, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, await aesKey(env), enc.encode(plaintext));
  return `v1.${b64u(iv)}.${b64u(ct)}`;
}
export async function decryptSecret(env: Env, blob: string, aad: string): Promise<string> {
  const [v, iv, ct] = blob.split('.');
  if (v !== 'v1' || !iv || !ct) throw new Error('secret_format');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(aad) }, await aesKey(env), unb64(ct));
  return new TextDecoder().decode(pt);
}

// ---------- Rate limiting (ventana fija en D1) ----------
export async function rateLimit(env: Env, key: string, limit: number, windowSec: number): Promise<void> {
  const now = Date.now();
  const cutoff = now - windowSec * 1000;
  const row = await first<{ count: number }>(
    env.DB,
    `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start < ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start < ?3 THEN ?2 ELSE window_start END
     RETURNING count`,
    key, now, cutoff,
  );
  if ((row?.count ?? 0) > limit) throw new HttpError(429, 'rate_limited', 'Demasiados intentos. Espera unos minutos e inténtalo de nuevo.');
}

export const clientIp = (c: Ctx) => c.req.header('cf-connecting-ip') ?? 'local';

export async function audit(c: Ctx, action: string, target?: string, data?: unknown) {
  const a = c.get('auth') as AuthCtx | undefined;
  await run(c.env.DB, 'INSERT INTO audit_logs (organization_id, user_id, action, target, ip, data, created_at) VALUES (?,?,?,?,?,?,?)',
    a?.orgId || null, a?.userId ?? null, action, target ?? null, clientIp(c), data ? JSON.stringify(data) : null, Date.now());
}

export async function addEvent(db: D1Database, e: { streamId: string; orgId: string; sessionId?: string | null; type: string; level?: 'info' | 'warn' | 'error'; message: string; data?: unknown; at?: number }) {
  await run(db, 'INSERT INTO stream_events (stream_id, organization_id, session_id, type, level, message, data, created_at) VALUES (?,?,?,?,?,?,?,?)',
    e.streamId, e.orgId, e.sessionId ?? null, e.type, e.level ?? 'info', e.message, e.data ? JSON.stringify(e.data) : null, e.at ?? Date.now());
}
