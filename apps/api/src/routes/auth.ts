import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { hasRole, loginSchema, planFor, registerSchema, type Role } from '@dni/shared';
import { type AppEnv, type Ctx, HttpError, all, audit, clientIp, first, hashPassword, newId, parseBody, randomToken, rateLimit, run, sha256Hex, verifyPassword } from '../lib/core';

const COOKIE = 'dni_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Hash señuelo para igualar tiempos cuando el email no existe (evita enumeración por tiempo).
let dummyHash: Promise<string> | null = null;

async function createSession(c: Ctx, userId: string) {
  const token = randomToken();
  const now = Date.now();
  await run(c.env.DB, 'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)',
    await sha256Hex(token), userId, now, now + SESSION_TTL_MS, (c.req.header('user-agent') ?? '').slice(0, 200));
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: c.env.COOKIE_SECURE === 'true', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
}

/** Autenticación por cookie httpOnly + resolución de organización con verificación de pertenencia. */
export const requireAuth = (minRole: Role = 'viewer'): MiddlewareHandler<AppEnv> => async (c, next) => {
  const token = getCookie(c, COOKIE);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para continuar.');
  const s = await first<{ user_id: string; email: string; expires_at: number }>(c.env.DB,
    'SELECT s.user_id, u.email, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', await sha256Hex(token));
  if (!s || s.expires_at < Date.now()) throw new HttpError(401, 'unauthenticated', 'La sesión ha caducado. Inicia sesión de nuevo.');
  const wanted = c.req.header('x-org-id');
  const m = await first<{ organization_id: string; role: Role; plan: string; suspended_at: number | null }>(c.env.DB,
    `SELECT m.organization_id, m.role, o.plan, o.suspended_at FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ?1 AND (?2 IS NULL OR m.organization_id = ?2) ORDER BY m.created_at LIMIT 1`, s.user_id, wanted ?? null);
  // 404 y no 403: no se confirma la existencia de organizaciones ajenas.
  if (!m) throw new HttpError(404, 'organization_not_found', 'Organización no encontrada.');
  if (!hasRole(m.role, minRole)) throw new HttpError(403, 'forbidden', 'Tu rol no permite esta acción.');
  c.set('auth', { userId: s.user_id, orgId: m.organization_id, role: m.role, plan: m.plan, email: s.email });
  await next();
};

export const planOf = (c: Ctx) => planFor(c.get('auth').plan);

export const auth = new Hono<AppEnv>();

/**
 * El servicio es gratuito y sin límites, así que el registro abierto dejaría a cualquiera emitir a costa del
 * propietario. Por defecto solo se admite la primera cuenta (el propietario); ALLOW_SIGNUPS=true lo abre.
 */
async function signupsOpen(env: AppEnv['Bindings']): Promise<boolean> {
  if (env.ALLOW_SIGNUPS === 'true') return true;
  return !(await first(env.DB, 'SELECT 1 FROM users LIMIT 1'));
}

auth.get('/config', async (c) => c.json({ signupsOpen: await signupsOpen(c.env) }));

auth.post('/register', async (c) => {
  await rateLimit(c.env, `register:${clientIp(c)}`, 30, 3600);
  const b = await parseBody(c, registerSchema);
  if (!(await signupsOpen(c.env))) throw new HttpError(403, 'signups_closed', 'El registro está cerrado. Pide acceso al administrador de la plataforma.');
  if (await first(c.env.DB, 'SELECT 1 FROM users WHERE email = ?', b.email)) {
    throw new HttpError(409, 'email_in_use', 'Ya existe una cuenta con ese email.');
  }
  const now = Date.now();
  const userId = newId('usr');
  const orgId = newId('org');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?,?,?,?,?)').bind(userId, b.email, b.name, await hashPassword(b.password), now),
    c.env.DB.prepare('INSERT INTO organizations (id, name, plan, created_at) VALUES (?,?,?,?)').bind(orgId, b.organizationName, 'trial', now),
    c.env.DB.prepare('INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?,?,?,?)').bind(orgId, userId, 'owner', now),
  ]);
  await createSession(c, userId);
  return c.json({ user: { id: userId, email: b.email, name: b.name }, organization: { id: orgId, name: b.organizationName, plan: 'trial', role: 'owner' } }, 201);
});

auth.post('/login', async (c) => {
  const b = await parseBody(c, loginSchema);
  await rateLimit(c.env, `login:${clientIp(c)}:${b.email}`, 10, 900);
  const u = await first<{ id: string; password_hash: string }>(c.env.DB, 'SELECT id, password_hash FROM users WHERE email = ?', b.email);
  dummyHash ??= hashPassword('señuelo-para-tiempo-constante');
  const ok = await verifyPassword(b.password, u?.password_hash ?? (await dummyHash));
  if (!u || !ok) throw new HttpError(401, 'invalid_credentials', 'Email o contraseña incorrectos.');
  await createSession(c, u.id);
  return c.json({ ok: true });
});

auth.post('/logout', async (c) => {
  const token = getCookie(c, COOKIE);
  if (token) await run(c.env.DB, 'DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});

auth.get('/me', requireAuth(), async (c) => {
  const a = c.get('auth');
  const user = await first<{ id: string; email: string; name: string; email_verified_at: number | null }>(c.env.DB, 'SELECT id, email, name, email_verified_at FROM users WHERE id = ?', a.userId);
  const orgs = await all<{ id: string; name: string; plan: string; role: Role }>(c.env.DB,
    'SELECT o.id, o.name, o.plan, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY m.created_at', a.userId);
  const p = planOf(c);
  return c.json({
    user: { id: user!.id, email: user!.email, name: user!.name, emailVerified: !!user!.email_verified_at },
    organizations: orgs,
    current: { id: a.orgId, role: a.role, plan: a.plan, limits: p },
  });
});

/** Solo owner/admin: cambia el rol de un miembro existente (base para /app/team). */
auth.get('/members', requireAuth('admin'), async (c) => {
  const rows = await all(c.env.DB, 'SELECT u.id, u.email, u.name, m.role FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ?', c.get('auth').orgId);
  await audit(c, 'members.list');
  return c.json({ members: rows });
});
