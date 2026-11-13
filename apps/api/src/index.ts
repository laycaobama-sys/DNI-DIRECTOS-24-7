import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { type AppEnv, type Env, HttpError } from './lib/core';
import { EngineNode, wakeEngines } from './engine-node';
import { auth } from './routes/auth';

export { EngineNode };
import { destinations } from './routes/destinations';
import { internal, reconcile } from './routes/internal';
import { media } from './routes/media';
import { overview, runSchedules, schedules } from './routes/misc';
import { playlists } from './routes/playlists';
import { streams } from './routes/streams';

const app = new Hono<AppEnv>();
const origins = (env: Env) => env.APP_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  if (c.env.COOKIE_SECURE === 'true') c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (!c.res.headers.has('cache-control')) c.header('Cache-Control', 'no-store');
});

app.use('/v1/*', cors({
  origin: (origin, c) => (origins(c.env).includes(origin) ? origin : null),
  credentials: true,
  allowHeaders: ['content-type', 'x-requested-with', 'x-org-id'],
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  maxAge: 600,
}));

/** CSRF: toda mutación exige una cabecera personalizada (imposible cross-site sin preflight CORS) y un Origin permitido si viene informado. */
app.use('/v1/*', async (c, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    if (!c.req.header('x-requested-with')) throw new HttpError(403, 'csrf', 'Falta la cabecera X-Requested-With.');
    const origin = c.req.header('origin');
    if (origin && origin !== new URL(c.req.url).origin && !origins(c.env).includes(origin)) throw new HttpError(403, 'csrf', 'Origen no permitido.');
  }
  await next();
});

app.get('/healthz', async (c) => {
  await c.env.DB.prepare('SELECT 1').first();
  return c.json({ ok: true, at: Date.now() });
});

app.route('/v1/auth', auth);
app.route('/v1/media', media);
app.route('/v1/playlists', playlists);
app.route('/v1/destinations', destinations);
app.route('/v1/streams', streams);
app.route('/v1/schedules', schedules);
app.route('/v1/overview', overview);
app.route('/internal', internal);

app.notFound((c) => {
  const p = new URL(c.req.url).pathname;
  if (c.env.ASSETS && !p.startsWith('/v1/') && !p.startsWith('/internal/')) return c.env.ASSETS.fetch(c.req.raw);
  return c.json({ error: { code: 'not_found', message: 'Ruta no encontrada.' } }, 404);
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.status);
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled', path: new URL(c.req.url).pathname, error: err instanceof Error ? err.message : String(err) }));
  return c.json({ error: { code: 'internal_error', message: 'Error interno. Inténtalo de nuevo.' } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil((async () => {
      await reconcile(env);
      await runSchedules(env);
      await wakeEngines(env);
      await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()).run();
      await env.DB.prepare('DELETE FROM stream_events WHERE created_at < ?').bind(Date.now() - 30 * 86_400_000).run();
      await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Date.now() - 86_400_000).run();
    })());
  },
} satisfies ExportedHandler<Env>;
