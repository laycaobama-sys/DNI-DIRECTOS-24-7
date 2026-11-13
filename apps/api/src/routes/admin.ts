/**
 * Panel del propietario de la plataforma (superadministrador). Acceso solo con `users.is_superadmin = 1`;
 * para el resto de usuarios estas rutas no existen (404). Todas las acciones quedan en `audit_logs`.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Ctx, HttpError, addEvent, all, audit, first, notFound, parseBody, run } from '../lib/core';
import { SETTING_KEYS, engineMaxNodes, getSetting, googleCredentials, setGoogleCredentials, setSetting, signupsOpenSetting } from '../lib/settings';
import { engineNodes, wakeEngines } from '../engine-node';
import { googleRedirectUri, requireSuperadmin } from './auth';
import { type StreamRow, stopStream } from './streams';

export const admin = new Hono<AppEnv>();
admin.use('*', requireSuperadmin);

const DAY = 86_400_000;
const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };
const limitOf = (c: Ctx, def = 100) => Math.min(500, Math.max(1, Number(c.req.query('limit') ?? def) || def));

admin.get('/stats', async (c) => {
  const now = Date.now();
  const since = now - 13 * DAY;
  const day0 = new Date(since); day0.setUTCHours(0, 0, 0, 0);
  const [totals, streams, signups, hours, recentUsers, nodes] = await Promise.all([
    first<Record<string, number>>(c.env.DB, `SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM users WHERE created_at >= ?1) AS users7d,
      (SELECT COUNT(*) FROM users WHERE last_login_at >= ?2) AS active24h,
      (SELECT COUNT(*) FROM users WHERE disabled_at IS NOT NULL) AS disabled,
      (SELECT COUNT(*) FROM organizations) AS orgs,
      (SELECT COUNT(*) FROM media_assets WHERE deleted_at IS NULL) AS media,
      (SELECT COALESCE(SUM(size_bytes),0) FROM media_assets WHERE deleted_at IS NULL) AS storageBytes,
      (SELECT COUNT(*) FROM media_assets WHERE deleted_at IS NULL AND status IN ('queued','processing')) AS mediaPending,
      (SELECT COUNT(*) FROM media_assets WHERE deleted_at IS NULL AND status = 'failed') AS mediaFailed,
      (SELECT COUNT(*) FROM playlists WHERE deleted_at IS NULL) AS playlists,
      (SELECT COUNT(*) FROM destinations WHERE deleted_at IS NULL) AS destinations,
      (SELECT COUNT(*) FROM youtube_accounts) AS youtubeChannels,
      (SELECT COALESCE(SUM(live_seconds),0) FROM stream_sessions WHERE started_at >= ?3) AS liveSecondsMonth,
      (SELECT COALESCE(SUM(bytes_sent),0) FROM stream_sessions WHERE started_at >= ?3) AS egressBytesMonth,
      (SELECT COALESCE(SUM(live_seconds),0) FROM stream_sessions) AS liveSecondsTotal,
      (SELECT COUNT(*) FROM stream_events WHERE level = 'error' AND created_at >= ?2) AS errors24h`,
      now - 7 * DAY, now - DAY, monthStart()),
    all<{ status: string; n: number }>(c.env.DB, 'SELECT status, COUNT(*) AS n FROM streams WHERE deleted_at IS NULL GROUP BY status'),
    all<{ d: number; n: number }>(c.env.DB, 'SELECT (created_at / 86400000) AS d, COUNT(*) AS n FROM users WHERE created_at >= ? GROUP BY d', day0.getTime()),
    all<{ d: number; s: number }>(c.env.DB, 'SELECT (started_at / 86400000) AS d, SUM(live_seconds) AS s FROM stream_sessions WHERE started_at >= ? GROUP BY d', day0.getTime()),
    all(c.env.DB, 'SELECT id, email, name, created_at AS createdAt, google_sub IS NOT NULL AS google FROM users ORDER BY created_at DESC LIMIT 6'),
    all(c.env.DB, 'SELECT id, version, capacity, running, last_seen_at AS lastSeenAt FROM worker_nodes WHERE last_seen_at >= ? ORDER BY id', now - 5 * 60_000),
  ]);
  const days = Array.from({ length: 14 }, (_, i) => Math.floor(day0.getTime() / DAY) + i);
  const byDay = <T extends { d: number }>(rows: T[], k: keyof T) => days.map((d) => ({ day: d * DAY, value: Number(rows.find((r) => r.d === d)?.[k] ?? 0) }));
  return c.json({
    totals, streamsByStatus: Object.fromEntries(streams.map((s) => [s.status, s.n])),
    series: { signups: byDay(signups, 'n'), liveHours: byDay(hours, 's').map((x) => ({ ...x, value: x.value / 3600 })) },
    recentUsers, nodes,
  });
});

// ───────── Usuarios ─────────
admin.get('/users', async (c) => {
  const q = `%${(c.req.query('q') ?? '').trim().toLowerCase()}%`;
  const rows = await all(c.env.DB, `SELECT u.id, u.email, u.name, u.is_superadmin AS superadmin, u.disabled_at AS disabledAt, u.last_login_at AS lastLoginAt,
      u.created_at AS createdAt, u.google_sub IS NOT NULL AS google, u.password_hash != '!' AS hasPassword,
      (SELECT o.name FROM organization_members m JOIN organizations o ON o.id = m.organization_id WHERE m.user_id = u.id ORDER BY m.created_at LIMIT 1) AS organization,
      (SELECT COUNT(*) FROM streams s JOIN organization_members m ON m.organization_id = s.organization_id WHERE m.user_id = u.id AND s.deleted_at IS NULL) AS streams,
      (SELECT COUNT(*) FROM streams s JOIN organization_members m ON m.organization_id = s.organization_id WHERE m.user_id = u.id AND s.desired_state = 'running' AND s.deleted_at IS NULL) AS live,
      (SELECT COALESCE(SUM(a.size_bytes),0) FROM media_assets a JOIN organization_members m ON m.organization_id = a.organization_id WHERE m.user_id = u.id AND a.deleted_at IS NULL) AS storageBytes
    FROM users u WHERE lower(u.email) LIKE ?1 OR lower(u.name) LIKE ?1 ORDER BY u.created_at DESC LIMIT ?2`, q, limitOf(c, 200));
  return c.json({ items: rows });
});

admin.patch('/users/:id', async (c) => {
  const b = await parseBody(c, z.object({ disabled: z.boolean().optional(), superadmin: z.boolean().optional() }));
  const id = c.req.param('id');
  const me = c.get('auth');
  if (id === me.userId && (b.disabled === true || b.superadmin === false)) throw new HttpError(409, 'self_lockout', 'No puedes desactivarte ni quitarte el acceso de propietario a ti mismo.');
  const u = await first<{ id: string }>(c.env.DB, 'SELECT id FROM users WHERE id = ?', id);
  if (!u) throw notFound('Usuario');
  if (b.disabled !== undefined) {
    await run(c.env.DB, 'UPDATE users SET disabled_at = ? WHERE id = ?', b.disabled ? Date.now() : null, id);
    if (b.disabled) {
      // Desactivar = cerrar sesiones y detener sus emisiones.
      await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ?', id);
      const live = await all<StreamRow>(c.env.DB, `SELECT s.* FROM streams s JOIN organization_members m ON m.organization_id = s.organization_id
        WHERE m.user_id = ? AND m.role = 'owner' AND s.desired_state = 'running' AND s.deleted_at IS NULL`, id);
      for (const s of live) await stopStream(c.env, s, 'administración');
    }
  }
  if (b.superadmin !== undefined) await run(c.env.DB, 'UPDATE users SET is_superadmin = ? WHERE id = ?', b.superadmin ? 1 : 0, id);
  await audit(c, 'admin.user_updated', id, b);
  return c.json({ ok: true });
});

admin.post('/users/:id/logout', async (c) => {
  await run(c.env.DB, 'DELETE FROM sessions WHERE user_id = ?', c.req.param('id'));
  await audit(c, 'admin.user_sessions_revoked', c.req.param('id'));
  return c.json({ ok: true });
});

/** Borrado definitivo: usuario, sus organizaciones (si es el único miembro) y todos sus archivos en R2. */
admin.delete('/users/:id', async (c) => {
  const id = c.req.param('id');
  if (id === c.get('auth').userId) throw new HttpError(409, 'self_delete', 'No puedes borrar tu propia cuenta desde el panel.');
  const u = await first<{ email: string }>(c.env.DB, 'SELECT email FROM users WHERE id = ?', id);
  if (!u) throw notFound('Usuario');
  const orgs = await all<{ organization_id: string }>(c.env.DB,
    'SELECT organization_id FROM organization_members m WHERE user_id = ? AND (SELECT COUNT(*) FROM organization_members x WHERE x.organization_id = m.organization_id) = 1', id);
  for (const { organization_id: org } of orgs) {
    for (const s of await all<StreamRow>(c.env.DB, "SELECT * FROM streams WHERE organization_id = ? AND desired_state = 'running'", org)) await stopStream(c.env, s, 'administración');
    let cursor: string | undefined;
    do {
      const list = await c.env.MEDIA.list({ prefix: `org/${org}/`, cursor });
      if (list.objects.length) await c.env.MEDIA.delete(list.objects.map((o) => o.key));
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);
    await run(c.env.DB, 'DELETE FROM organizations WHERE id = ?', org);
  }
  await run(c.env.DB, 'DELETE FROM users WHERE id = ?', id);
  await audit(c, 'admin.user_deleted', id, { email: u.email, organizations: orgs.length });
  return c.json({ ok: true });
});

// ───────── Emisiones de toda la plataforma ─────────
admin.get('/streams', async (c) => {
  const status = c.req.query('status');
  const rows = await all(c.env.DB, `SELECT s.id, s.name, s.status, s.status_reason AS statusReason, s.desired_state AS desiredState, s.profile, s.mode,
      s.started_at AS startedAt, s.last_heartbeat_at AS lastHeartbeatAt, s.lease_owner AS node, o.name AS organization,
      (SELECT u.email FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.organization_id = s.organization_id AND m.role = 'owner' LIMIT 1) AS ownerEmail,
      (SELECT COUNT(*) FROM stream_destinations d WHERE d.stream_id = s.id) AS destinations,
      (SELECT COUNT(*) FROM stream_destinations d WHERE d.stream_id = s.id AND d.state = 'live') AS destinationsLive
    FROM streams s JOIN organizations o ON o.id = s.organization_id
    WHERE s.deleted_at IS NULL AND (?1 IS NULL OR (?1 = 'active' AND s.desired_state = 'running') OR s.status = ?1)
    ORDER BY s.desired_state = 'running' DESC, s.updated_at DESC LIMIT ?2`, status ?? null, limitOf(c, 200));
  return c.json({ items: rows });
});

admin.post('/streams/:id/stop', async (c) => {
  const s = await first<StreamRow>(c.env.DB, 'SELECT * FROM streams WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  if (!s) throw notFound('Stream');
  await stopStream(c.env, s, 'administración de la plataforma');
  await audit(c, 'admin.stream_stopped', s.id);
  return c.json({ ok: true });
});

admin.post('/streams/:id/restart', async (c) => {
  const s = await first<StreamRow>(c.env.DB, 'SELECT * FROM streams WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  if (!s) throw notFound('Stream');
  if (s.desired_state !== 'running') throw new HttpError(409, 'stream_not_running', 'El stream no está en emisión.');
  await run(c.env.DB, 'UPDATE streams SET restart_nonce = restart_nonce + 1, updated_at = ? WHERE id = ?', Date.now(), s.id);
  await addEvent(c.env.DB, { streamId: s.id, orgId: s.organization_id, sessionId: s.current_session_id, type: 'restart_requested', level: 'warn', message: 'Reinicio solicitado por la administración de la plataforma.' });
  await audit(c, 'admin.stream_restarted', s.id);
  return c.json({ ok: true });
});

// ───────── Cola de vídeos ─────────
admin.get('/media', async (c) => {
  const status = c.req.query('status');
  const rows = await all(c.env.DB, `SELECT a.id, a.filename, a.status, a.kind, a.size_bytes AS sizeBytes, a.progress, a.attempts, a.error_message AS error,
      a.duration_sec AS durationSec, a.created_at AS createdAt, a.updated_at AS updatedAt, o.name AS organization
    FROM media_assets a JOIN organizations o ON o.id = a.organization_id
    WHERE a.deleted_at IS NULL AND (?1 IS NULL OR a.status = ?1 OR (?1 = 'pending' AND a.status IN ('queued','processing','uploading')))
    ORDER BY a.updated_at DESC LIMIT ?2`, status ?? null, limitOf(c, 200));
  return c.json({ items: rows });
});

admin.post('/media/:id/retry', async (c) => {
  const r = await run(c.env.DB, "UPDATE media_assets SET status = 'queued', attempts = 0, error_code = NULL, error_message = NULL, progress = 0, lease_owner = NULL, updated_at = ? WHERE id = ? AND status IN ('failed','processing','queued')", Date.now(), c.req.param('id'));
  if (!r.meta.changes) throw notFound('Archivo');
  c.executionCtx.waitUntil(wakeEngines(c.env));
  await audit(c, 'admin.media_retried', c.req.param('id'));
  return c.json({ ok: true });
});

// ───────── Observabilidad ─────────
admin.get('/events', async (c) => {
  const level = c.req.query('level');
  const rows = await all(c.env.DB, `SELECT e.id, e.type, e.level, e.message, e.created_at AS at, e.stream_id AS streamId, s.name AS streamName, o.name AS organization
    FROM stream_events e JOIN streams s ON s.id = e.stream_id JOIN organizations o ON o.id = e.organization_id
    WHERE (?1 IS NULL OR e.level = ?1 OR (?1 = 'warn' AND e.level = 'error')) ORDER BY e.id DESC LIMIT ?2`, level ?? null, limitOf(c, 150));
  return c.json({ items: rows });
});

admin.get('/audit', async (c) => {
  const rows = await all(c.env.DB, `SELECT l.id, l.action, l.target, l.ip, l.data, l.created_at AS at, u.email AS actor
    FROM audit_logs l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT ?`, limitOf(c, 150));
  return c.json({ items: rows });
});

admin.get('/nodes', async (c) => {
  const [cloud, reported] = await Promise.all([
    engineNodes(c.env, 'status'),
    all(c.env.DB, 'SELECT id, hostname, version, capacity, running, last_seen_at AS lastSeenAt FROM worker_nodes ORDER BY last_seen_at DESC LIMIT 30'),
  ]);
  return c.json({ cloud, reported, maxNodes: await engineMaxNodes(c.env) });
});

admin.post('/nodes/:action', async (c) => {
  const action = c.req.param('action');
  if (action !== 'restart' && action !== 'ensure') throw notFound('Acción');
  const nodes = await engineNodes(c.env, action);
  await audit(c, `admin.nodes_${action}`);
  return c.json({ nodes });
});

// ───────── Ajustes ─────────
admin.get('/settings', async (c) => {
  const g = await googleCredentials(c.env);
  return c.json({
    signupsOpen: await signupsOpenSetting(c.env),
    announcement: (await getSetting(c.env, SETTING_KEYS.announcement)) ?? '',
    engineMaxNodes: await engineMaxNodes(c.env),
    google: { configured: !!g, clientId: g?.clientId ?? '', redirectUri: googleRedirectUri(c), origin: c.env.PUBLIC_URL || new URL(c.req.url).origin },
    publicUrl: c.env.PUBLIC_URL ?? new URL(c.req.url).origin,
  });
});

admin.put('/settings', async (c) => {
  const b = await parseBody(c, z.object({
    signupsOpen: z.boolean().optional(),
    announcement: z.string().max(280).optional(),
    engineMaxNodes: z.number().int().min(1).max(10).optional(),
    googleClientId: z.string().trim().max(200).regex(/^$|^[0-9a-z-]+\.apps\.googleusercontent\.com$/i, 'El ID de cliente debe terminar en .apps.googleusercontent.com').optional(),
    googleClientSecret: z.string().trim().max(200).optional(),
    clearGoogle: z.boolean().optional(),
  }));
  if (b.signupsOpen !== undefined) await setSetting(c.env, SETTING_KEYS.signupsOpen, String(b.signupsOpen));
  if (b.announcement !== undefined) await setSetting(c.env, SETTING_KEYS.announcement, b.announcement.trim() || null);
  if (b.engineMaxNodes !== undefined) await setSetting(c.env, SETTING_KEYS.engineMaxNodes, String(b.engineMaxNodes));
  if (b.clearGoogle) await setGoogleCredentials(c.env, null, null);
  else if (b.googleClientId !== undefined || b.googleClientSecret) {
    const current = await googleCredentials(c.env);
    const id = b.googleClientId ?? current?.clientId ?? '';
    const secret = b.googleClientSecret || current?.clientSecret || '';
    if (!id || !secret) throw new HttpError(422, 'google_incomplete', 'Indica el ID de cliente y el secreto de cliente de Google.');
    await setGoogleCredentials(c.env, id, secret);
  }
  // Nunca se registra el secreto en la auditoría.
  await audit(c, 'admin.settings_updated', undefined, { ...b, googleClientSecret: b.googleClientSecret ? '***' : undefined });
  return c.json({ ok: true });
});
