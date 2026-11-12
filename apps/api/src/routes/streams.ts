import { Hono } from 'hono';
import { type AssignedPlaylist, PLANS, type PlanId, type ProfileId, type StreamStatus, isActive, streamCreateSchema, streamUpdateSchema } from '@dni/shared';
import { type AppEnv, type Env, HttpError, addEvent, all, audit, first, newId, notFound, parseBody, run } from '../lib/core';
import { planOf, requireAuth } from './auth';
import { type DestinationRow, destinationDto } from './destinations';

export interface StreamRow {
  id: string; organization_id: string; name: string; playlist_id: string; mode: 'loop' | 'once' | 'shuffle'; profile: ProfileId; seed: number;
  status: StreamStatus; status_reason: string | null; desired_state: 'running' | 'stopped'; restart_nonce: number;
  lease_owner: string | null; lease_expires_at: number | null; fencing_token: number; current_session_id: string | null;
  position: string | null; metrics: string | null; last_heartbeat_at: number | null; started_at: number | null; created_at: number; updated_at: number;
}

export const getStream = async (env: Env, orgId: string, id: string) => {
  const s = await first<StreamRow>(env.DB, 'SELECT * FROM streams WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', id, orgId);
  if (!s) throw notFound('Stream');
  return s;
};

type LinkRow = DestinationRow & { state: string; bitrate_kbps: number | null; out_time_sec: number | null; bytes_sent: number; restarts: number; last_error: string | null; link_updated_at: number | null };
export const streamDestinations = (env: Env, streamId: string) => all<LinkRow>(env.DB,
  `SELECT d.*, sd.state, sd.bitrate_kbps, sd.out_time_sec, sd.bytes_sent, sd.restarts, sd.last_error, sd.updated_at AS link_updated_at
   FROM stream_destinations sd JOIN destinations d ON d.id = sd.destination_id WHERE sd.stream_id = ? AND d.deleted_at IS NULL ORDER BY d.created_at`, streamId);

export async function configRevision(env: Env, s: Pick<StreamRow, 'id' | 'playlist_id'>): Promise<string> {
  const p = await first<{ published_version_id: string | null }>(env.DB, 'SELECT published_version_id FROM playlists WHERE id = ?', s.playlist_id);
  const d = await all<{ id: string; updated_at: number }>(env.DB,
    'SELECT d.id, d.updated_at FROM stream_destinations sd JOIN destinations d ON d.id = sd.destination_id WHERE sd.stream_id = ? AND d.deleted_at IS NULL ORDER BY d.id', s.id);
  return `${p?.published_version_id ?? '-'}|${d.map((x) => `${x.id}:${x.updated_at}`).join(',')}`;
}

/** Resuelve la versión publicada a variantes canónicas del perfil. Devuelve los medios sin variante lista en `missing`. */
export async function resolvePlaylist(env: Env, s: Pick<StreamRow, 'organization_id' | 'playlist_id' | 'profile'>): Promise<{ playlist: AssignedPlaylist | null; missing: string[]; reason?: string }> {
  const pv = await first<{ id: string; items: string }>(env.DB,
    'SELECT pv.id, pv.items FROM playlists p JOIN playlist_versions pv ON pv.id = p.published_version_id WHERE p.id = ? AND p.organization_id = ? AND p.deleted_at IS NULL', s.playlist_id, s.organization_id);
  if (!pv) return { playlist: null, missing: [], reason: 'La playlist no tiene ninguna versión publicada.' };
  const ids = (JSON.parse(pv.items) as { mediaId: string }[]).map((i) => i.mediaId);
  if (!ids.length) return { playlist: null, missing: [], reason: 'La playlist publicada está vacía.' };
  const unique = [...new Set(ids)];
  const rows = await all<{ media_id: string; id: string; duration_sec: number; size_bytes: number; filename: string }>(env.DB,
    `SELECT v.media_id, v.id, v.duration_sec, v.size_bytes, a.filename FROM media_variants v JOIN media_assets a ON a.id = v.media_id
     WHERE v.organization_id = ? AND v.kind = 'canonical' AND v.profile = ? AND v.status = 'ready' AND a.deleted_at IS NULL
       AND v.media_id IN (${unique.map(() => '?').join(',')})`, s.organization_id, s.profile, ...unique);
  const byMedia = new Map(rows.map((r) => [r.media_id, r]));
  const missing = unique.filter((id) => !byMedia.has(id));
  if (missing.length) return { playlist: null, missing };
  return {
    missing: [],
    playlist: { versionId: pv.id, items: ids.map((id) => { const v = byMedia.get(id)!; return { mediaId: id, variantId: v.id, durationSec: v.duration_sec, sizeBytes: v.size_bytes, title: v.filename }; }) },
  };
}

async function setDestinations(env: Env, s: { id: string; organization_id: string }, ids: string[], maxPerStream: number) {
  const unique = [...new Set(ids)];
  if (unique.length > maxPerStream) {
    throw new HttpError(403, 'quota_destinations', `Tu plan permite ${maxPerStream} destino(s) por stream.`);
  }
  if (unique.length) {
    const found = await all<{ id: string }>(env.DB,
      `SELECT id FROM destinations WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${unique.map(() => '?').join(',')})`, s.organization_id, ...unique);
    if (found.length !== unique.length) throw new HttpError(422, 'destination_not_found', 'Alguno de los destinos no existe en tu organización.');
  }
  const stmts = [env.DB.prepare(`DELETE FROM stream_destinations WHERE stream_id = ?1 ${unique.length ? `AND destination_id NOT IN (${unique.map((_, i) => `?${i + 2}`).join(',')})` : ''}`).bind(s.id, ...unique)];
  for (const d of unique) stmts.push(env.DB.prepare('INSERT OR IGNORE INTO stream_destinations (stream_id, destination_id, organization_id) VALUES (?,?,?)').bind(s.id, d, s.organization_id));
  await env.DB.batch(stmts);
}

async function dto(env: Env, s: StreamRow) {
  const dests = await streamDestinations(env, s.id);
  const pl = await first<{ name: string; published_version_id: string | null }>(env.DB, 'SELECT name, published_version_id FROM playlists WHERE id = ?', s.playlist_id);
  const pos = s.position ? (JSON.parse(s.position) as { cycle: number; position: number; mediaId: string | null; playlistVersionId: string }) : null;
  const now = Date.now();
  const engineOnline = !!s.lease_owner && (s.lease_expires_at ?? 0) > now;
  const np = pos?.mediaId && isActive(s.status) ? await first<{ filename: string }>(env.DB, 'SELECT filename FROM media_assets WHERE id = ?', pos.mediaId) : null;
  return {
    id: s.id, name: s.name, playlistId: s.playlist_id, playlistName: pl?.name ?? null, mode: s.mode, profile: s.profile,
    status: s.status, statusReason: s.status_reason, desiredState: s.desired_state,
    engine: { online: engineOnline, lastHeartbeatAt: s.last_heartbeat_at },
    startedAt: isActive(s.status) ? s.started_at : null,
    nowPlaying: np ? { mediaId: pos!.mediaId, title: np.filename, cycle: pos!.cycle, position: pos!.position } : null,
    pendingPlaylistChange: isActive(s.status) && !!pos && !!pl?.published_version_id && pos.playlistVersionId !== pl.published_version_id,
    metrics: engineOnline && s.metrics ? JSON.parse(s.metrics) : null,
    destinations: dests.map((d) => ({
      ...destinationDto(d),
      // El estado por destino solo es real mientras hay un motor informando.
      state: engineOnline ? d.state : 'idle', bitrateKbps: engineOnline ? d.bitrate_kbps : null, outTimeSec: engineOnline ? d.out_time_sec : null,
      restarts: d.restarts, lastError: d.last_error,
    })),
    createdAt: s.created_at, updatedAt: s.updated_at,
  };
}

/** Inicio real: valida contenido, destinos y cuotas y deja el canal reclamable por un nodo de emisión. */
export async function startStream(env: Env, s: StreamRow, plan: (typeof PLANS)[PlanId], actor: string) {
  if (s.desired_state === 'running' && isActive(s.status)) return; // idempotente
  if (s.status === 'suspended') throw new HttpError(403, 'stream_suspended', 'El stream está suspendido por cuota. Revisa tu plan.');
  if (!plan.profiles.includes(s.profile)) throw new HttpError(403, 'plan_profile_not_allowed', `Tu plan no incluye la calidad ${s.profile}.`);
  const dests = await streamDestinations(env, s.id);
  if (!dests.length) throw new HttpError(422, 'no_destinations', 'Añade al menos un destino antes de iniciar la emisión.');
  if (dests.length > plan.maxDestinationsPerStream) throw new HttpError(403, 'quota_destinations', `Tu plan permite ${plan.maxDestinationsPerStream} destino(s) por stream.`);
  const { playlist, missing, reason } = await resolvePlaylist(env, s);
  if (!playlist && !missing.length) throw new HttpError(422, 'playlist_not_published', reason ?? 'Playlist no disponible.');
  if (missing.length) {
    // Encola la conversión al perfil pedido; el usuario reintenta cuando termine.
    const now = Date.now();
    for (const mediaId of missing) {
      const exists = await first(env.DB, "SELECT 1 FROM media_variants WHERE media_id = ? AND kind = 'canonical' AND profile = ? AND status IN ('pending','processing')", mediaId, s.profile);
      if (!exists) {
        const vid = newId('var');
        await run(env.DB, "INSERT INTO media_variants (id, media_id, organization_id, kind, profile, r2_key, status, created_at) VALUES (?,?,?,'canonical',?,?,'pending',?)",
          vid, mediaId, s.organization_id, s.profile, `org/${s.organization_id}/media/${mediaId}/${vid}.mp4`, now);
      }
    }
    throw new HttpError(409, 'media_preparing', `Se están convirtiendo ${missing.length} vídeo(s) a ${s.profile}. Inicia la emisión cuando terminen.`, { mediaIds: missing });
  }
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const usage = await first<{ secs: number }>(env.DB, 'SELECT COALESCE(SUM(live_seconds),0) AS secs FROM stream_sessions WHERE organization_id = ? AND started_at >= ?', s.organization_id, monthStart.getTime());
  if ((usage?.secs ?? 0) >= plan.monthlyStreamHours * 3600) {
    throw new HttpError(403, 'quota_hours', `Has consumido las ${plan.monthlyStreamHours} horas de emisión de tu plan este mes.`);
  }
  // Cuota de concurrencia comprobada y reservada en una sola sentencia (sin carrera entre peticiones).
  const now = Date.now();
  const res = await run(env.DB,
    `UPDATE streams SET desired_state = 'running', status = 'starting', status_reason = NULL, position = NULL, started_at = ?1, updated_at = ?1, restart_nonce = restart_nonce
     WHERE id = ?2 AND (SELECT COUNT(*) FROM streams o WHERE o.organization_id = ?3 AND o.deleted_at IS NULL AND o.desired_state = 'running' AND o.id != ?2) < ?4`,
    now, s.id, s.organization_id, plan.maxConcurrentStreams);
  if (!res.meta.changes) {
    throw new HttpError(409, 'quota_concurrent_streams', `Tu plan permite ${plan.maxConcurrentStreams} emisión(es) simultánea(s). Detén otra emisión o amplía el plan.`);
  }
  await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: 'start_requested', message: `Inicio solicitado por ${actor}.` });
}

export async function stopStream(env: Env, s: StreamRow, actor: string) {
  const now = Date.now();
  const engineOnline = !!s.lease_owner && (s.lease_expires_at ?? 0) > now;
  if (s.desired_state === 'stopped' && !isActive(s.status)) return;
  await run(env.DB, 'UPDATE streams SET desired_state = \'stopped\', status = ?, updated_at = ? WHERE id = ?', engineOnline ? 'stopping' : 'stopped', now, s.id);
  await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, sessionId: s.current_session_id, type: 'stop_requested', message: `Detención solicitada por ${actor}.` });
}

export const streams = new Hono<AppEnv>();

streams.get('/', requireAuth(), async (c) => {
  const rows = await all<StreamRow>(c.env.DB, 'SELECT * FROM streams WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200', c.get('auth').orgId);
  return c.json({ items: await Promise.all(rows.map((r) => dto(c.env, r))) });
});

streams.post('/', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const b = await parseBody(c, streamCreateSchema);
  const plan = planOf(c);
  if (!plan.profiles.includes(b.profile)) throw new HttpError(403, 'plan_profile_not_allowed', `Tu plan no incluye la calidad ${b.profile}.`);
  if (!(await first(c.env.DB, 'SELECT 1 FROM playlists WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', b.playlistId, orgId))) {
    throw new HttpError(422, 'playlist_not_found', 'La playlist no existe en tu organización.');
  }
  const id = newId('str');
  const now = Date.now();
  await run(c.env.DB, 'INSERT INTO streams (id, organization_id, name, playlist_id, mode, profile, seed, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, orgId, b.name, b.playlistId, b.mode, b.profile, crypto.getRandomValues(new Uint32Array(1))[0]! & 0x7fffffff, 'ready', now, now);
  try {
    await setDestinations(c.env, { id, organization_id: orgId }, b.destinationIds, plan.maxDestinationsPerStream);
  } catch (e) {
    await run(c.env.DB, 'DELETE FROM streams WHERE id = ?', id);
    throw e;
  }
  await audit(c, 'stream.created', id);
  return c.json(await dto(c.env, await getStream(c.env, orgId, id)), 201);
});

streams.get('/:id', requireAuth(), async (c) => c.json(await dto(c.env, await getStream(c.env, c.get('auth').orgId, c.req.param('id')))));

streams.patch('/:id', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const s = await getStream(c.env, orgId, c.req.param('id'));
  const b = await parseBody(c, streamUpdateSchema);
  const plan = planOf(c);
  const live = s.desired_state === 'running';
  if (live && (b.playlistId !== undefined && b.playlistId !== s.playlist_id || b.profile !== undefined && b.profile !== s.profile || b.mode !== undefined && b.mode !== s.mode)) {
    throw new HttpError(409, 'stream_running', 'Detén la emisión para cambiar playlist, modo o calidad. Los destinos y el contenido de la playlist sí pueden cambiarse en directo.');
  }
  if (b.profile && !plan.profiles.includes(b.profile)) throw new HttpError(403, 'plan_profile_not_allowed', `Tu plan no incluye la calidad ${b.profile}.`);
  if (b.playlistId && !(await first(c.env.DB, 'SELECT 1 FROM playlists WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', b.playlistId, orgId))) {
    throw new HttpError(422, 'playlist_not_found', 'La playlist no existe en tu organización.');
  }
  if (b.destinationIds) {
    if (live && !b.destinationIds.length) throw new HttpError(422, 'no_destinations', 'Un stream en emisión necesita al menos un destino.');
    await setDestinations(c.env, s, b.destinationIds, plan.maxDestinationsPerStream);
  }
  await run(c.env.DB, 'UPDATE streams SET name = ?, playlist_id = ?, mode = ?, profile = ?, updated_at = ? WHERE id = ?',
    b.name ?? s.name, b.playlistId ?? s.playlist_id, b.mode ?? s.mode, b.profile ?? s.profile, Date.now(), s.id);
  return c.json(await dto(c.env, await getStream(c.env, orgId, s.id)));
});

streams.post('/:id/start', requireAuth('operator'), async (c) => {
  const a = c.get('auth');
  const s = await getStream(c.env, a.orgId, c.req.param('id'));
  await startStream(c.env, s, planOf(c), a.email);
  await audit(c, 'stream.start', s.id);
  return c.json(await dto(c.env, await getStream(c.env, a.orgId, s.id)));
});

streams.post('/:id/stop', requireAuth('operator'), async (c) => {
  const a = c.get('auth');
  const s = await getStream(c.env, a.orgId, c.req.param('id'));
  await stopStream(c.env, s, a.email);
  await audit(c, 'stream.stop', s.id);
  return c.json(await dto(c.env, await getStream(c.env, a.orgId, s.id)));
});

streams.post('/:id/restart', requireAuth('operator'), async (c) => {
  const a = c.get('auth');
  const s = await getStream(c.env, a.orgId, c.req.param('id'));
  if (s.desired_state !== 'running') throw new HttpError(409, 'stream_not_running', 'El stream no está en emisión.');
  await run(c.env.DB, 'UPDATE streams SET restart_nonce = restart_nonce + 1, updated_at = ? WHERE id = ?', Date.now(), s.id);
  await addEvent(c.env.DB, { streamId: s.id, orgId: a.orgId, sessionId: s.current_session_id, type: 'restart_requested', level: 'warn', message: `Reinicio solicitado por ${a.email}.` });
  await audit(c, 'stream.restart', s.id);
  return c.json(await dto(c.env, await getStream(c.env, a.orgId, s.id)));
});

streams.get('/:id/events', requireAuth(), async (c) => {
  const s = await getStream(c.env, c.get('auth').orgId, c.req.param('id'));
  const limit = Math.min(200, Math.max(1, Number(c.req.query('limit') ?? 50)));
  const rows = await all<{ id: number; type: string; level: string; message: string; data: string | null; created_at: number; session_id: string | null }>(c.env.DB,
    'SELECT id, type, level, message, data, created_at, session_id FROM stream_events WHERE stream_id = ? ORDER BY id DESC LIMIT ?', s.id, limit);
  return c.json({ items: rows.map((r) => ({ id: r.id, type: r.type, level: r.level, message: r.message, data: r.data ? JSON.parse(r.data) : null, at: r.created_at, sessionId: r.session_id })) });
});

streams.get('/:id/sessions', requireAuth(), async (c) => {
  const s = await getStream(c.env, c.get('auth').orgId, c.req.param('id'));
  const rows = await all(c.env.DB, 'SELECT id, node_id AS nodeId, started_at AS startedAt, ended_at AS endedAt, end_reason AS endReason, live_seconds AS liveSeconds, bytes_sent AS bytesSent FROM stream_sessions WHERE stream_id = ? ORDER BY started_at DESC LIMIT 50', s.id);
  return c.json({ items: rows });
});

streams.delete('/:id', requireAuth('editor'), async (c) => {
  const a = c.get('auth');
  const s = await getStream(c.env, a.orgId, c.req.param('id'));
  if (s.desired_state === 'running' || isActive(s.status)) throw new HttpError(409, 'stream_running', 'Detén la emisión antes de borrar el stream.');
  await run(c.env.DB, 'UPDATE streams SET deleted_at = ? WHERE id = ?', Date.now(), s.id);
  await audit(c, 'stream.deleted', s.id);
  return c.json({ ok: true });
});
