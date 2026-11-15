import { Hono } from 'hono';
import { planFor, type ScheduleRule, isValidTimeZone, nextOccurrence, scheduleCreateSchema } from '@dni/shared';
import { type AppEnv, type Env, HttpError, addEvent, all, first, newId, notFound, parseBody, run } from '../lib/core';
import { planOf, requireAuth } from './auth';
import { type StreamRow, getStream, startStream, stopStream } from './streams';

const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d.getTime(); };

export const overview = new Hono<AppEnv>();
// Un valor por destino y tramo de 5 min (el máximo), para no contar dos veces las muestras del primer minuto.
const BUCKETS = 'SELECT (at / 300000) * 300000 AS b, MAX(viewers) AS v FROM stream_metrics WHERE organization_id = ?1 AND at >= ?2 GROUP BY b, stream_id, destination_id';

/** Panel general: cifras medidas por el backend y audiencia oficial de YouTube (si el plan la incluye y el canal está conectado). */
overview.get('/', requireAuth(), async (c) => {
  const { orgId } = c.get('auth');
  const plan = planOf(c);
  const [storage, streamsByStatus, usage, events, counts] = await Promise.all([
    first<{ used: number; files: number }>(c.env.DB, 'SELECT COALESCE(SUM(size_bytes),0) AS used, COUNT(*) AS files FROM media_assets WHERE organization_id = ? AND deleted_at IS NULL', orgId),
    all<{ status: string; n: number }>(c.env.DB, 'SELECT status, COUNT(*) AS n FROM streams WHERE organization_id = ? AND deleted_at IS NULL GROUP BY status', orgId),
    first<{ secs: number; bytes: number }>(c.env.DB, 'SELECT COALESCE(SUM(live_seconds),0) AS secs, COALESCE(SUM(bytes_sent),0) AS bytes FROM stream_sessions WHERE organization_id = ? AND started_at >= ?', orgId, monthStart()),
    all<{ id: number; stream_id: string; name: string; type: string; level: string; message: string; created_at: number }>(c.env.DB,
      'SELECT e.id, e.stream_id, s.name, e.type, e.level, e.message, e.created_at FROM stream_events e JOIN streams s ON s.id = e.stream_id WHERE e.organization_id = ? ORDER BY e.id DESC LIMIT 12', orgId),
    first<{ playlists: number; destinations: number; running: number }>(c.env.DB,
      `SELECT (SELECT COUNT(*) FROM playlists WHERE organization_id = ?1 AND deleted_at IS NULL) AS playlists,
              (SELECT COUNT(*) FROM destinations WHERE organization_id = ?1 AND deleted_at IS NULL) AS destinations,
              (SELECT COUNT(*) FROM streams WHERE organization_id = ?1 AND deleted_at IS NULL AND desired_state = 'running') AS running`, orgId),
  ]);
  const now = Date.now();
  let audience: Record<string, unknown> = { available: plan.audience, connected: false };
  if (plan.audience) {
    const [linked, nowRow, peak, series, top] = await Promise.all([
      first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM youtube_accounts WHERE organization_id = ?', orgId),
      first<{ viewers: number; streams: number }>(c.env.DB, `SELECT COALESCE(SUM(m.viewers),0) AS viewers, COUNT(DISTINCT m.stream_id) AS streams FROM stream_metrics m
        WHERE m.organization_id = ?1 AND m.at >= ?2 AND m.at = (SELECT MAX(at) FROM stream_metrics x WHERE x.stream_id = m.stream_id AND x.destination_id = m.destination_id)`, orgId, now - 15 * 60_000),
      first<{ v: number }>(c.env.DB, `SELECT MAX(v) AS v FROM (SELECT SUM(v) AS v FROM (${BUCKETS}) GROUP BY b)`, orgId, now - 7 * 86_400_000),
      all<{ at: number; viewers: number }>(c.env.DB, `SELECT b AS at, SUM(v) AS viewers FROM (${BUCKETS}) GROUP BY b ORDER BY b`, orgId, now - 86_400_000),
      all<{ id: string; name: string; viewers: number }>(c.env.DB, `SELECT s.id, s.name, SUM(m.viewers) AS viewers FROM stream_metrics m JOIN streams s ON s.id = m.stream_id
        WHERE m.organization_id = ?1 AND m.at >= ?2 AND m.at = (SELECT MAX(at) FROM stream_metrics x WHERE x.stream_id = m.stream_id AND x.destination_id = m.destination_id)
        GROUP BY s.id ORDER BY viewers DESC LIMIT 5`, orgId, now - 15 * 60_000),
    ]);
    audience = { available: true, connected: (linked?.n ?? 0) > 0, viewersNow: nowRow?.viewers ?? 0, streamsMeasured: nowRow?.streams ?? 0, peak7d: peak?.v ?? null, series, top };
  }
  return c.json({
    plan: { id: c.get('auth').plan, ...plan },
    storage: { usedBytes: storage?.used ?? 0, limitBytes: plan.storageBytes, files: storage?.files ?? 0 },
    streams: { byStatus: Object.fromEntries(streamsByStatus.map((r) => [r.status, r.n])), running: counts?.running ?? 0, limit: plan.maxConcurrentStreams },
    usage: { liveHoursThisMonth: (usage?.secs ?? 0) / 3600, limitHours: plan.monthlyStreamHours, egressBytesThisMonth: usage?.bytes ?? 0 },
    counts: { playlists: counts?.playlists ?? 0, destinations: counts?.destinations ?? 0 },
    audience,
    recentEvents: events.map((e) => ({ id: e.id, streamId: e.stream_id, streamName: e.name, type: e.type, level: e.level, message: e.message, at: e.created_at })),
  });
});

interface ScheduleRow { id: string; organization_id: string; stream_id: string; time_zone: string; time: string; recurrence: string; duration_minutes: number | null; next_start_at: number | null; next_stop_at: number | null; enabled: number }
const ruleOf = (r: ScheduleRow): ScheduleRule => ({ timeZone: r.time_zone, time: r.time, recurrence: JSON.parse(r.recurrence) });
const scheduleDto = (r: ScheduleRow) => ({ id: r.id, streamId: r.stream_id, timeZone: r.time_zone, time: r.time, recurrence: JSON.parse(r.recurrence), durationMinutes: r.duration_minutes, nextStartAt: r.next_start_at, nextStopAt: r.next_stop_at, enabled: !!r.enabled });

export const schedules = new Hono<AppEnv>();

schedules.get('/', requireAuth(), async (c) => {
  const rows = await all<ScheduleRow>(c.env.DB, 'SELECT * FROM schedules WHERE organization_id = ? ORDER BY next_start_at IS NULL, next_start_at', c.get('auth').orgId);
  return c.json({ items: rows.map(scheduleDto) });
});

schedules.post('/', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const b = await parseBody(c, scheduleCreateSchema);
  if (!planOf(c).scheduling) throw new HttpError(403, 'plan_scheduling', 'La programación de emisiones está incluida a partir del plan Creador.');
  if (!isValidTimeZone(b.timeZone)) throw new HttpError(422, 'invalid_time_zone', 'Zona horaria IANA no válida (ejemplo: Europe/Madrid).');
  await getStream(c.env, orgId, b.streamId);
  const next = nextOccurrence({ timeZone: b.timeZone, time: b.time, recurrence: b.recurrence }, Date.now());
  if (next === null) throw new HttpError(422, 'schedule_in_past', 'La fecha programada ya ha pasado.');
  const id = newId('sch');
  await run(c.env.DB, 'INSERT INTO schedules (id, organization_id, stream_id, time_zone, time, recurrence, duration_minutes, next_start_at, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    id, orgId, b.streamId, b.timeZone, b.time, JSON.stringify(b.recurrence), b.durationMinutes, next, Date.now());
  return c.json(scheduleDto((await first<ScheduleRow>(c.env.DB, 'SELECT * FROM schedules WHERE id = ?', id))!), 201);
});

schedules.delete('/:id', requireAuth('editor'), async (c) => {
  const res = await run(c.env.DB, 'DELETE FROM schedules WHERE id = ? AND organization_id = ?', c.req.param('id'), c.get('auth').orgId);
  if (!res.meta.changes) throw notFound('Programación');
  return c.json({ ok: true });
});

/** Ejecutado por cron cada minuto. Cada ocurrencia se reclama con un UPDATE condicional: varias instancias no duplican inicios. */
/** Detiene las emisiones de las cuentas que agotan las horas mensuales de su plan (en la práctica, el plan Gratis). */
export async function enforceHourQuotas(env: Env) {
  const rows = await all<StreamRow & { plan: string }>(env.DB, `SELECT s.*, o.plan FROM streams s JOIN organizations o ON o.id = s.organization_id
    WHERE s.desired_state = 'running' AND s.deleted_at IS NULL`);
  const checked = new Map<string, boolean>();
  for (const s of rows) {
    const plan = planFor(s.plan);
    if (plan.unlimited) continue;
    let over = checked.get(s.organization_id);
    if (over === undefined) {
      const u = await first<{ secs: number }>(env.DB, 'SELECT COALESCE(SUM(live_seconds),0) AS secs FROM stream_sessions WHERE organization_id = ? AND started_at >= ?', s.organization_id, monthStart());
      over = (u?.secs ?? 0) >= plan.monthlyStreamHours * 3600;
      checked.set(s.organization_id, over);
    }
    if (over) await stopStream(env, s, `límite de ${plan.monthlyStreamHours} h al mes del plan ${plan.label}`);
  }
}

export async function runSchedules(env: Env, now = Date.now()) {
  const due = await all<ScheduleRow>(env.DB, 'SELECT * FROM schedules WHERE enabled = 1 AND ((next_start_at IS NOT NULL AND next_start_at <= ?1) OR (next_stop_at IS NOT NULL AND next_stop_at <= ?1)) LIMIT 100', now);
  for (const r of due) {
    const s = await first<StreamRow & { plan: string }>(env.DB, 'SELECT s.*, o.plan FROM streams s JOIN organizations o ON o.id = s.organization_id WHERE s.id = ? AND s.deleted_at IS NULL', r.stream_id);
    if (r.next_stop_at !== null && r.next_stop_at <= now) {
      const claimed = await run(env.DB, 'UPDATE schedules SET next_stop_at = NULL WHERE id = ? AND next_stop_at = ?', r.id, r.next_stop_at);
      if (claimed.meta.changes && s) await stopStream(env, s, 'programación');
    }
    if (r.next_start_at !== null && r.next_start_at <= now) {
      const next = nextOccurrence(ruleOf(r), now);
      const stopAt = r.duration_minutes ? r.next_start_at + r.duration_minutes * 60_000 : null;
      const claimed = await run(env.DB, 'UPDATE schedules SET next_start_at = ?, next_stop_at = ? WHERE id = ? AND next_start_at = ?', next, stopAt, r.id, r.next_start_at);
      if (!claimed.meta.changes || !s) continue;
      try {
        await startStream(env, s, planFor(s.plan), 'programación');
      } catch (e) {
        await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: 'schedule_failed', level: 'error', message: `No se pudo iniciar la emisión programada: ${e instanceof Error ? e.message : 'error'}` });
      }
    }
  }
  return due.length;
}
