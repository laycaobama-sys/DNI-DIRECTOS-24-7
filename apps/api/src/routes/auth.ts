import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { z } from 'zod';
import { hasRole, loginSchema, planFor, registerSchema, type Role } from '@dni/shared';
import { type AppEnv, type Ctx, HttpError, all, audit, clientIp, encryptSecret, first, hashPassword, newId, parseBody, randomToken, rateLimit, run, sha256Hex, verifyPassword } from '../lib/core';
import { SETTING_KEYS, getSetting, googleCredentials, signupsOpenSetting } from '../lib/settings';

const COOKIE = 'dni_session';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
// Hash señuelo para igualar tiempos cuando el email no existe (evita enumeración por tiempo).
let dummyHash: Promise<string> | null = null;

async function createSession(c: Ctx, userId: string) {
  const token = randomToken();
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?,?,?,?,?)')
      .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS, (c.req.header('user-agent') ?? '').slice(0, 200)),
    c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now, userId),
  ]);
  setCookie(c, COOKIE, token, {
    httpOnly: true, sameSite: 'Lax', secure: c.env.COOKIE_SECURE === 'true', path: '/', maxAge: SESSION_TTL_MS / 1000,
  });
}

interface SessionUser { user_id: string; email: string; expires_at: number; is_superadmin: number; disabled_at: number | null }
async function sessionUser(c: Ctx): Promise<SessionUser> {
  const token = getCookie(c, COOKIE);
  if (!token) throw new HttpError(401, 'unauthenticated', 'Inicia sesión para continuar.');
  const s = await first<SessionUser>(c.env.DB,
    'SELECT s.user_id, u.email, s.expires_at, u.is_superadmin, u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?', await sha256Hex(token));
  if (!s || s.expires_at < Date.now()) throw new HttpError(401, 'unauthenticated', 'La sesión ha caducado. Inicia sesión de nuevo.');
  if (s.disabled_at) throw new HttpError(403, 'account_disabled', 'Tu cuenta está desactivada. Contacta con el administrador.');
  return s;
}

/** Autenticación por cookie httpOnly + resolución de organización con verificación de pertenencia. */
export const requireAuth = (minRole: Role = 'viewer'): MiddlewareHandler<AppEnv> => async (c, next) => {
  const s = await sessionUser(c);
  const wanted = c.req.header('x-org-id');
  const m = await first<{ organization_id: string; role: Role; plan: string; suspended_at: number | null }>(c.env.DB,
    `SELECT m.organization_id, m.role, o.plan, o.suspended_at FROM organization_members m JOIN organizations o ON o.id = m.organization_id
     WHERE m.user_id = ?1 AND (?2 IS NULL OR m.organization_id = ?2) ORDER BY m.created_at LIMIT 1`, s.user_id, wanted ?? null);
  // 404 y no 403: no se confirma la existencia de organizaciones ajenas.
  if (!m) throw new HttpError(404, 'organization_not_found', 'Organización no encontrada.');
  if (!hasRole(m.role, minRole)) throw new HttpError(403, 'forbidden', 'Tu rol no permite esta acción.');
  c.set('auth', { userId: s.user_id, orgId: m.organization_id, role: m.role, plan: m.plan, email: s.email, superadmin: !!s.is_superadmin });
  await next();
};

/** Solo el propietario de la plataforma (superadministrador). Responde 404 al resto: no revela que exista. */
export const requireSuperadmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const s = await sessionUser(c).catch(() => null);
  if (!s?.is_superadmin) throw new HttpError(404, 'not_found', 'Ruta no encontrada.');
  c.set('auth', { userId: s.user_id, orgId: '', role: 'owner', plan: 'free', email: s.email, superadmin: true });
  await next();
};

export const planOf = (c: Ctx) => planFor(c.get('auth').plan);

export const auth = new Hono<AppEnv>();

const isFirstUser = async (c: Ctx) => !(await first(c.env.DB, 'SELECT 1 FROM users LIMIT 1'));
/** El primer registro siempre está permitido: es la cuenta del propietario. */
const signupsOpen = async (c: Ctx) => (await isFirstUser(c)) || signupsOpenSetting(c.env);

auth.get('/config', async (c) => c.json({
  signupsOpen: await signupsOpen(c),
  google: !!(await googleCredentials(c.env)),
  announcement: (await getSetting(c.env, SETTING_KEYS.announcement)) || null,
}));

async function createAccount(c: Ctx, a: { email: string; name: string; orgName: string; passwordHash: string; googleSub?: string; verified?: boolean }) {
  const now = Date.now();
  const userId = newId('usr'), orgId = newId('org');
  const superadmin = (await isFirstUser(c)) ? 1 : 0;
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO users (id, email, name, password_hash, email_verified_at, google_sub, is_superadmin, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(userId, a.email, a.name, a.passwordHash, a.verified ? now : null, a.googleSub ?? null, superadmin, now),
    c.env.DB.prepare('INSERT INTO organizations (id, name, plan, created_at) VALUES (?,?,?,?)').bind(orgId, a.orgName, 'free', now),
    c.env.DB.prepare('INSERT INTO organization_members (organization_id, user_id, role, created_at) VALUES (?,?,?,?)').bind(orgId, userId, 'owner', now),
  ]);
  return { userId, orgId };
}

// ───────────────────────── Google: inicio de sesión y conexión de canales de YouTube ─────────────────────────
// OAuth 2.0 + OpenID Connect con PKCE. Un único URI de redirección (/v1/auth/google/callback) sirve a los dos
// flujos; el modo viaja en una cookie httpOnly de un solo uso junto al `state` y el verificador PKCE.
const OAUTH_COOKIE = 'dni_oauth';
const YT_SCOPE = 'https://www.googleapis.com/auth/youtube';
const b64url = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const googleRedirectUri = (c: Ctx) => `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/v1/auth/google/callback`;

export async function startGoogle(c: Ctx, mode: 'login' | 'youtube', extra = '') {
  const creds = await googleCredentials(c.env);
  if (!creds) throw new HttpError(404, 'google_not_configured', 'El acceso con Google no está configurado.');
  await rateLimit(c.env, `google:${clientIp(c)}`, 40, 600);
  const state = randomToken(24), verifier = randomToken(48);
  setCookie(c, OAUTH_COOKIE, [state, verifier, mode, extra].join('.'), { httpOnly: true, sameSite: 'Lax', secure: c.env.COOKIE_SECURE === 'true', path: '/v1/auth/google', maxAge: 600 });
  const q = new URLSearchParams({
    client_id: creds.clientId, redirect_uri: googleRedirectUri(c), response_type: 'code', state,
    code_challenge: b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))), code_challenge_method: 'S256',
    ...(mode === 'login'
      ? { scope: 'openid email profile', prompt: 'select_account' }
      // access_type=offline + prompt=consent garantizan un refresh token para gestionar el canal sin el usuario delante.
      : { scope: `openid email ${YT_SCOPE}`, access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' }),
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
}

auth.get('/google/start', (c) => startGoogle(c, 'login'));

interface GoogleTokens { id_token?: string; access_token?: string; refresh_token?: string; scope?: string }
interface IdClaims { iss?: string; aud?: string; exp?: number; sub?: string; email?: string; email_verified?: boolean; name?: string }
function parseIdToken(idToken: string): IdClaims | null {
  try {
    const payload = idToken.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload), (ch) => ch.charCodeAt(0))));
  } catch { return null; }
}

auth.get('/google/callback', async (c) => {
  const [state, verifier, mode, extra] = (getCookie(c, OAUTH_COOKIE) ?? '').split('.');
  const fail = (error: string) => {
    deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/google' });
    return c.redirect(mode === 'youtube' ? `/app/destinations?youtube_error=${encodeURIComponent(error)}` : `/login?error=${encodeURIComponent(error)}`, 302);
  };
  const creds = await googleCredentials(c.env);
  if (!creds) return fail('google_not_configured');
  const code = c.req.query('code');
  if (c.req.query('error')) return fail('google_cancelled');
  if (!state || !verifier || !code || c.req.query('state') !== state) return fail('google_state');
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: creds.clientId, client_secret: creds.clientSecret, redirect_uri: googleRedirectUri(c), grant_type: 'authorization_code', code_verifier: verifier }),
  });
  const tok = (await tokenRes.json().catch(() => null)) as GoogleTokens | null;
  if (!tokenRes.ok || !tok?.id_token) return fail('google_exchange');
  // El id_token llega directamente de Google por TLS en el canal de servidor, por lo que basta validar sus claims.
  const claims = parseIdToken(tok.id_token);
  const okIss = claims?.iss === 'https://accounts.google.com' || claims?.iss === 'accounts.google.com';
  if (!claims || !okIss || claims.aud !== creds.clientId || !claims.sub || !claims.email || (claims.exp ?? 0) * 1000 < Date.now()) return fail('google_token');
  if (claims.email_verified !== true) return fail('google_email_unverified');

  if (mode === 'youtube') {
    // Conexión de canal: la sesión de la plataforma ya existe; se vincula a la organización indicada al iniciar.
    const s = await sessionUser(c).catch(() => null);
    const member = s && extra ? await first<{ role: Role }>(c.env.DB, 'SELECT role FROM organization_members WHERE user_id = ? AND organization_id = ?', s.user_id, extra) : null;
    if (!s || !member || !hasRole(member.role, 'admin')) return fail('youtube_session');
    if (!tok.access_token || !tok.refresh_token || !(tok.scope ?? '').includes(YT_SCOPE)) return fail('youtube_scope');
    const ch = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: { authorization: `Bearer ${tok.access_token}` } });
    const data = (await ch.json().catch(() => null)) as { items?: { id: string; snippet: { title: string; thumbnails?: { default?: { url: string } } } }[]; error?: { message?: string } } | null;
    if (!ch.ok) return fail(/has not been used|disabled/i.test(data?.error?.message ?? '') ? 'youtube_api_disabled' : 'youtube_channels');
    if (!data?.items?.length) return fail('youtube_no_channel');
    const now = Date.now();
    for (const item of data.items) {
      const existing = await first<{ id: string }>(c.env.DB, 'SELECT id FROM youtube_accounts WHERE organization_id = ? AND channel_id = ?', extra, item.id);
      const id = existing?.id ?? newId('yt');
      const enc = await encryptSecret(c.env, tok.refresh_token, id);
      await run(c.env.DB, `INSERT INTO youtube_accounts (id, organization_id, user_id, channel_id, channel_title, channel_thumbnail, refresh_token_enc, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(organization_id, channel_id) DO UPDATE SET refresh_token_enc = excluded.refresh_token_enc,
        channel_title = excluded.channel_title, channel_thumbnail = excluded.channel_thumbnail, user_id = excluded.user_id, updated_at = excluded.updated_at`,
        id, extra, s.user_id, item.id, item.snippet.title.slice(0, 200), item.snippet.thumbnails?.default?.url ?? null, enc, now, now);
    }
    deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/google' });
    return c.redirect('/app/destinations?youtube=connected', 302);
  }

  const email = claims.email.trim().toLowerCase();
  const now = Date.now();
  let user = await first<{ id: string; disabled_at: number | null }>(c.env.DB, 'SELECT id, disabled_at FROM users WHERE google_sub = ?', claims.sub);
  if (!user) {
    // Misma dirección ya registrada por correo: se vincula (Google garantiza que el email está verificado).
    user = await first<{ id: string; disabled_at: number | null }>(c.env.DB, 'SELECT id, disabled_at FROM users WHERE email = ?', email);
    if (user) await run(c.env.DB, 'UPDATE users SET google_sub = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', claims.sub, now, user.id);
  }
  if (user?.disabled_at) return fail('account_disabled');
  if (!user) {
    if (!(await signupsOpen(c))) return fail('signups_closed');
    const name = (claims.name ?? email.split('@')[0]!).slice(0, 80);
    // '!' no es un hash válido: una cuenta creada con Google no puede entrar por contraseña hasta que defina una.
    const { userId } = await createAccount(c, { email, name, orgName: `Canal de ${name}`.slice(0, 80), passwordHash: '!', googleSub: claims.sub, verified: true });
    user = { id: userId, disabled_at: null };
  }
  deleteCookie(c, OAUTH_COOKIE, { path: '/v1/auth/google' });
  await createSession(c, user.id);
  return c.redirect('/app/overview', 302);
});

auth.post('/register', async (c) => {
  await rateLimit(c.env, `register:${clientIp(c)}`, 30, 3600);
  const b = await parseBody(c, registerSchema);
  if (!(await signupsOpen(c))) throw new HttpError(403, 'signups_closed', 'El registro está cerrado. Pide acceso al administrador de la plataforma.');
  if (await first(c.env.DB, 'SELECT 1 FROM users WHERE email = ?', b.email)) {
    throw new HttpError(409, 'email_in_use', 'Ya existe una cuenta con ese email. Inicia sesión o entra con Google.');
  }
  const { userId, orgId } = await createAccount(c, { email: b.email, name: b.name, orgName: b.organizationName, passwordHash: await hashPassword(b.password) });
  await createSession(c, userId);
  return c.json({ user: { id: userId, email: b.email, name: b.name }, organization: { id: orgId, name: b.organizationName, plan: 'free', role: 'owner' } }, 201);
});

auth.post('/login', async (c) => {
  const b = await parseBody(c, loginSchema);
  await rateLimit(c.env, `login:${clientIp(c)}:${b.email}`, 10, 900);
  const u = await first<{ id: string; password_hash: string; disabled_at: number | null; google_sub: string | null }>(c.env.DB, 'SELECT id, password_hash, disabled_at, google_sub FROM users WHERE email = ?', b.email);
  dummyHash ??= hashPassword('señuelo-para-tiempo-constante');
  const ok = await verifyPassword(b.password, u?.password_hash && u.password_hash !== '!' ? u.password_hash : await dummyHash);
  if (!u || !ok) {
    if (u && u.password_hash === '!' && u.google_sub) throw new HttpError(401, 'use_google', 'Esta cuenta se creó con Google. Pulsa «Continuar con Google».');
    throw new HttpError(401, 'invalid_credentials', 'Email o contraseña incorrectos.');
  }
  if (u.disabled_at) throw new HttpError(403, 'account_disabled', 'Tu cuenta está desactivada. Contacta con el administrador.');
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
  const user = await first<{ id: string; email: string; name: string; email_verified_at: number | null; password_hash: string; google_sub: string | null; created_at: number }>(c.env.DB,
    'SELECT id, email, name, email_verified_at, password_hash, google_sub, created_at FROM users WHERE id = ?', a.userId);
  const orgs = await all<{ id: string; name: string; plan: string; role: Role }>(c.env.DB,
    'SELECT o.id, o.name, o.plan, m.role FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = ? ORDER BY m.created_at', a.userId);
  return c.json({
    user: {
      id: user!.id, email: user!.email, name: user!.name, emailVerified: !!user!.email_verified_at, superadmin: a.superadmin,
      hasPassword: user!.password_hash !== '!', google: !!user!.google_sub, createdAt: user!.created_at,
    },
    organizations: orgs,
    current: { id: a.orgId, role: a.role, plan: a.plan, limits: planOf(c) },
  });
});

auth.patch('/me', requireAuth(), async (c) => {
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80).optional(), organizationName: z.string().trim().min(1).max(80).optional() }));
  const a = c.get('auth');
  if (b.name) await run(c.env.DB, 'UPDATE users SET name = ? WHERE id = ?', b.name, a.userId);
  if (b.organizationName && hasRole(a.role, 'admin')) await run(c.env.DB, 'UPDATE organizations SET name = ? WHERE id = ?', b.organizationName, a.orgId);
  return c.json({ ok: true });
});

/** Cambiar contraseña, o crear una en cuentas que entraron con Google. Cierra las demás sesiones. */
auth.post('/password', requireAuth(), async (c) => {
  const b = await parseBody(c, z.object({ current: z.string().max(200).optional(), password: z.string().min(10, 'La contraseña debe tener al menos 10 caracteres.').max(200) }));
  const a = c.get('auth');
  await rateLimit(c.env, `password:${a.userId}`, 10, 900);
  const u = await first<{ password_hash: string }>(c.env.DB, 'SELECT password_hash FROM users WHERE id = ?', a.userId);
  if (u!.password_hash !== '!' && !(await verifyPassword(b.current ?? '', u!.password_hash))) {
    throw new HttpError(401, 'invalid_credentials', 'La contraseña actual no es correcta.');
  }
  const current = await sha256Hex(getCookie(c, COOKIE) ?? '');
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(b.password), a.userId),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').bind(a.userId, current),
  ]);
  await audit(c, 'user.password_changed', a.userId);
  return c.json({ ok: true });
});

/** Cierra la sesión en todos los dispositivos. */
auth.post('/sessions/revoke', requireAuth(), async (c) => {
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ?', c.get('auth').userId);
  deleteCookie(c, COOKIE, { path: '/' });
  return c.json({ ok: true });
});
