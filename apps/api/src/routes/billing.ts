/**
 * Planes y analítica pública.
 *  - /v1/billing: plan actual con su consumo, catálogo y solicitud de cambio. El cobro se hace con el enlace de pago
 *    que el propietario configure por plan (Stripe Payment Links, Lemon Squeezy, Paddle…) y él aprueba el cambio.
 *  - /v1/t: contador de visitas de la web pública, agregado por día (sin cookies, sin IP, sin identificadores).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { PUBLIC_PLANS } from '@dni/shared';
import { type AppEnv, type Env, HttpError, audit, first, newId, parseBody, run } from '../lib/core';
import { getSetting } from '../lib/settings';
import { deviceOf, geoOf, planOf, requireAuth } from './auth';

const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
export const checkoutKey = (plan: string, billing: 'monthly' | 'yearly') => `checkout_url:${plan}:${billing}`;

export async function checkoutLinks(env: Env) {
  const out: Record<string, { monthly: string | null; yearly: string | null }> = {};
  for (const p of PUBLIC_PLANS.filter((x) => x.priceMonthly > 0)) {
    out[p.id] = { monthly: (await getSetting(env, checkoutKey(p.id, 'monthly'))) ?? null, yearly: (await getSetting(env, checkoutKey(p.id, 'yearly'))) ?? null };
  }
  return out;
}

export const billing = new Hono<AppEnv>();

billing.get('/', requireAuth(), async (c) => {
  const { orgId, plan: planId } = c.get('auth');
  const plan = planOf(c);
  const [usage, storage, running, pending, links] = await Promise.all([
    first<{ secs: number; bytes: number }>(c.env.DB, 'SELECT COALESCE(SUM(live_seconds),0) AS secs, COALESCE(SUM(bytes_sent),0) AS bytes FROM stream_sessions WHERE organization_id = ? AND started_at >= ?', orgId, monthStart()),
    first<{ used: number }>(c.env.DB, 'SELECT COALESCE(SUM(size_bytes),0) AS used FROM media_assets WHERE organization_id = ? AND deleted_at IS NULL', orgId),
    first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM streams WHERE organization_id = ? AND deleted_at IS NULL AND desired_state = 'running'", orgId),
    first<{ id: string; plan: string; billing: string; created_at: number }>(c.env.DB, "SELECT id, plan, billing, created_at FROM plan_requests WHERE organization_id = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1", orgId),
    checkoutLinks(c.env),
  ]);
  return c.json({
    current: { id: planId, ...plan },
    usage: { liveHoursThisMonth: (usage?.secs ?? 0) / 3600, egressBytesThisMonth: usage?.bytes ?? 0, storageBytes: storage?.used ?? 0, runningStreams: running?.n ?? 0 },
    catalog: PUBLIC_PLANS.map((p) => ({ ...p, checkout: { monthly: !!links[p.id]?.monthly, yearly: !!links[p.id]?.yearly } })),
    pendingRequest: pending ? { id: pending.id, plan: pending.plan, billing: pending.billing, createdAt: pending.created_at } : null,
  });
});

/** Solicita un cambio de plan. Si hay enlace de pago configurado, devuelve la URL para pagar. */
billing.post('/request', requireAuth('owner'), async (c) => {
  const { orgId, userId } = c.get('auth');
  const b = await parseBody(c, z.object({ plan: z.string().max(20), billing: z.enum(['monthly', 'yearly']).default('monthly') }));
  const p = PUBLIC_PLANS.find((x) => x.id === b.plan);
  if (!p) throw new HttpError(422, 'unknown_plan', 'Ese plan no existe.');
  if (p.id === c.get('auth').plan) throw new HttpError(409, 'same_plan', 'Ya tienes ese plan.');
  const now = Date.now();
  await run(c.env.DB, "UPDATE plan_requests SET status = 'rejected', note = 'Sustituida por otra solicitud', resolved_at = ? WHERE organization_id = ? AND status = 'pending'", now, orgId);
  // Bajar al plan gratuito no necesita pago ni aprobación.
  if (p.priceMonthly === 0) {
    await run(c.env.DB, 'UPDATE organizations SET plan = ?, plan_updated_at = ? WHERE id = ?', p.id, now, orgId);
    await audit(c, 'billing.plan_changed', orgId, { plan: p.id });
    return c.json({ ok: true, applied: true, checkoutUrl: null });
  }
  const id = newId('prq');
  await run(c.env.DB, 'INSERT INTO plan_requests (id, organization_id, user_id, plan, billing, created_at) VALUES (?,?,?,?,?,?)', id, orgId, userId, p.id, b.billing, now);
  await audit(c, 'billing.plan_requested', orgId, { plan: p.id, billing: b.billing });
  const url = await getSetting(c.env, checkoutKey(p.id, b.billing));
  return c.json({ ok: true, applied: false, requestId: id, checkoutUrl: url ? `${url}${url.includes('?') ? '&' : '?'}client_reference_id=${orgId}` : null });
});

// ───────── Visitas de la web pública (agregadas) ─────────
export const tracking = new Hono<AppEnv>();

const PATH_RE = /^\/[a-z0-9\-/]{0,60}$/;
tracking.get('/', async (c) => {
  const ua = c.req.header('user-agent');
  const device = deviceOf(ua);
  const p = (c.req.query('p') ?? '/').toLowerCase().replace(/\/+$/, '') || '/';
  if (device !== 'bot' && PATH_RE.test(p) && !p.startsWith('/app')) {
    let ref = 'directo';
    try { const r = c.req.query('r'); if (r) ref = new URL(r).hostname.replace(/^www\./, '').slice(0, 60) || 'directo'; } catch { /* referente no válido */ }
    if (ref === new URL(c.req.url).hostname) ref = 'interno';
    const day = new Date().toISOString().slice(0, 10);
    await run(c.env.DB, `INSERT INTO page_views_daily (day, path, country, referrer, device, views) VALUES (?,?,?,?,?,1)
      ON CONFLICT(day, path, country, referrer, device) DO UPDATE SET views = views + 1`, day, p, geoOf(c).country ?? '??', ref, device);
  }
  return c.body(null, 204);
});
