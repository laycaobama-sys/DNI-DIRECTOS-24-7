/**
 * Contrato interno motor de emisión ↔ API. Autenticado con ENGINE_TOKEN (nunca expuesto al navegador).
 * La exclusión mutua se basa en lease + fencing token: cada claim incrementa el token y cualquier
 * heartbeat con un token antiguo recibe 409, lo que obliga al nodo desplazado a detener FFmpeg.
 */
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { type HeartbeatResponse, type MediaJob, type StreamAssignment, type StreamConfigRefresh, UPLOAD_PART_SIZE, heartbeatSchema, joinRtmp, mediaResultSchema, redactRtmp } from '@dni/shared';
import { type AppEnv, type Env, HttpError, addEvent, all, decryptSecret, first, newId, notFound, parseBody, run, timingSafeEqual } from '../lib/core';
import { type StreamRow, configRevision, resolvePlaylist, streamDestinations } from './streams';

const MEDIA_LEASE_MS = 10 * 60_000;
const MAX_MEDIA_ATTEMPTS = 3;
const ttlMs = (env: Env) => Math.max(10, Number(env.LEASE_TTL_SEC) || 20) * 1000;

const engineAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const h = c.req.header('authorization') ?? '';
  if (!c.env.ENGINE_TOKEN || c.env.ENGINE_TOKEN.length < 24 || !h.startsWith('Bearer ') || !(await timingSafeEqual(h.slice(7), c.env.ENGINE_TOKEN))) {
    throw new HttpError(401, 'unauthenticated', 'Token de motor no válido.');
  }
  await next();
};

/** Reconciliación: detecta motores caídos y cierra estados huérfanos. Idempotente; se ejecuta en cada claim y por cron. */
export async function reconcile(env: Env) {
  const now = Date.now();
  const lost = await all<{ id: string; organization_id: string; current_session_id: string | null; lease_owner: string }>(env.DB,
    `UPDATE streams SET status = 'recovering', status_reason = 'Se perdió el contacto con el nodo de emisión; reasignando.', lease_owner = NULL, updated_at = ?1
     WHERE desired_state = 'running' AND lease_owner IS NOT NULL AND lease_expires_at < ?1 AND deleted_at IS NULL
     RETURNING id, organization_id, current_session_id, lease_owner`, now);
  for (const s of lost) {
    if (s.current_session_id) await run(env.DB, "UPDATE stream_sessions SET ended_at = ?, end_reason = 'engine_lost' WHERE id = ? AND ended_at IS NULL", now, s.current_session_id);
    await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, sessionId: s.current_session_id, type: 'engine_lost', level: 'error', message: `El nodo ${s.lease_owner} dejó de informar. Recuperación automática en curso.` });
  }
  const orphans = await all<{ id: string; organization_id: string; current_session_id: string | null }>(env.DB,
    `UPDATE streams SET status = 'stopped', lease_owner = NULL, lease_expires_at = NULL, updated_at = ?1
     WHERE desired_state = 'stopped' AND status IN ('starting','live','degraded','recovering','stopping') AND (lease_owner IS NULL OR lease_expires_at < ?1)
     RETURNING id, organization_id, current_session_id`, now);
  for (const s of orphans) {
    if (s.current_session_id) await run(env.DB, "UPDATE stream_sessions SET ended_at = ?, end_reason = COALESCE(end_reason, 'stopped') WHERE id = ? AND ended_at IS NULL", now, s.current_session_id);
    await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, sessionId: s.current_session_id, type: 'stopped', message: 'Emisión detenida.' });
  }
  return { lost: lost.length, orphans: orphans.length };
}

async function destinationUrls(env: Env, streamId: string) {
  const rows = await streamDestinations(env, streamId);
  return Promise.all(rows.map(async (d) => ({ id: d.id, url: joinRtmp(d.url, await decryptSecret(env, d.stream_key_enc, d.id)) })));
}

async function failStream(env: Env, s: StreamRow, reason: string) {
  await run(env.DB, "UPDATE streams SET status = 'failed', status_reason = ?, desired_state = 'stopped', lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?", reason, Date.now(), s.id);
  await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: 'failed', level: 'error', message: reason });
}

export const internal = new Hono<AppEnv>();
internal.use('*', engineAuth);

/** Artefactos del motor (bundle y binarios de FFmpeg) para el cargador del contenedor. Direccionados por SHA-256. */
internal.get('/engine/assets/:name', async (c) => {
  const assets = JSON.parse(c.env.ENGINE_ASSETS || '{}') as Record<string, string>;
  const sha = assets[c.req.param('name')];
  const obj = sha && /^[0-9a-f]{64}$/.test(sha) ? await c.env.MEDIA.get(`system/engine/${sha}`) : null;
  if (!obj) throw notFound('Artefacto');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size), 'x-sha256': sha! } });
});

// ───────────────────────── Medios ─────────────────────────

internal.post('/media-jobs/claim', async (c) => {
  const { nodeId } = await parseBody(c, z.object({ nodeId: z.string().min(1).max(64) }));
  const now = Date.now();
  for (let i = 0; i < 5; i++) {
    const m = await first<{ id: string; filename: string; size_bytes: number; attempts: number }>(c.env.DB,
      `UPDATE media_assets SET status = 'processing', attempts = attempts + 1, progress = 0, lease_owner = ?1, lease_expires_at = ?2, updated_at = ?3
       WHERE id = (SELECT id FROM media_assets WHERE deleted_at IS NULL AND (status = 'queued' OR (status = 'processing' AND lease_expires_at < ?3)) ORDER BY created_at LIMIT 1)
       RETURNING id, filename, size_bytes, attempts`, nodeId, now + MEDIA_LEASE_MS, now);
    if (!m) break;
    if (m.attempts > MAX_MEDIA_ATTEMPTS) {
      await run(c.env.DB, "UPDATE media_assets SET status = 'failed', error_code = 'processing_attempts_exceeded', error_message = 'El procesamiento falló repetidamente. Vuelve a subir el archivo o contacta con soporte.', lease_owner = NULL WHERE id = ?", m.id);
      continue;
    }
    return c.json({ job: { type: 'ingest', mediaId: m.id, filename: m.filename, sizeBytes: m.size_bytes, profile: '720p30' } satisfies MediaJob });
  }
  const v = await first<{ id: string; media_id: string; profile: string; attempts: number }>(c.env.DB,
    `UPDATE media_variants SET status = 'processing', attempts = attempts + 1, lease_expires_at = ?1
     WHERE id = (SELECT id FROM media_variants WHERE kind = 'canonical' AND (status = 'pending' OR (status = 'processing' AND lease_expires_at < ?2)) AND attempts < ?3 ORDER BY created_at LIMIT 1)
     RETURNING id, media_id, profile, attempts`, now + MEDIA_LEASE_MS, now, MAX_MEDIA_ATTEMPTS);
  if (v) {
    const a = await first<{ filename: string; size_bytes: number }>(c.env.DB, 'SELECT filename, size_bytes FROM media_assets WHERE id = ? AND deleted_at IS NULL', v.media_id);
    if (a) return c.json({ job: { type: 'variant', mediaId: v.media_id, variantId: v.id, filename: a.filename, sizeBytes: a.size_bytes, profile: v.profile as MediaJob['profile'] } satisfies MediaJob });
    await run(c.env.DB, 'DELETE FROM media_variants WHERE id = ?', v.id);
  }
  return c.json({ job: null });
});

internal.get('/media/:id/original', async (c) => {
  const m = await first<{ r2_key: string }>(c.env.DB, 'SELECT r2_key FROM media_assets WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  const obj = m && (await c.env.MEDIA.get(m.r2_key));
  if (!obj) throw notFound('Original');
  return new Response(obj.body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(obj.size) } });
});

internal.post('/media/:id/progress', async (c) => {
  const { progress } = await parseBody(c, z.object({ progress: z.number().int().min(0).max(100) }));
  await run(c.env.DB, "UPDATE media_assets SET progress = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'processing'", progress, Date.now() + MEDIA_LEASE_MS, Date.now(), c.req.param('id'));
  await run(c.env.DB, "UPDATE media_variants SET lease_expires_at = ? WHERE media_id = ? AND status = 'processing'", Date.now() + MEDIA_LEASE_MS, c.req.param('id'));
  return c.json({ ok: true });
});

internal.put('/media/:id/thumbnail', async (c) => {
  const m = await first<{ id: string; organization_id: string }>(c.env.DB, 'SELECT id, organization_id FROM media_assets WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  if (!m) throw notFound('Archivo');
  const body = await c.req.arrayBuffer();
  if (body.byteLength > 2 * 1024 * 1024) throw new HttpError(413, 'thumbnail_too_large', 'Miniatura demasiado grande.');
  const key = `org/${m.organization_id}/media/${m.id}/thumb.jpg`;
  await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: 'image/jpeg' } });
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM media_variants WHERE media_id = ? AND kind = 'thumbnail'").bind(m.id),
    c.env.DB.prepare("INSERT INTO media_variants (id, media_id, organization_id, kind, r2_key, size_bytes, status, created_at) VALUES (?,?,?,'thumbnail',?,?,'ready',?)")
      .bind(newId('var'), m.id, m.organization_id, key, body.byteLength, Date.now()),
  ]);
  return c.json({ ok: true });
});

/** Abre la subida multipart de una variante canónica (nueva o la de un trabajo `variant`). */
internal.post('/media/:id/variants', async (c) => {
  const b = await parseBody(c, z.object({ profile: z.string().max(20), variantId: z.string().max(64).optional() }));
  const m = await first<{ id: string; organization_id: string }>(c.env.DB, 'SELECT id, organization_id FROM media_assets WHERE id = ? AND deleted_at IS NULL', c.req.param('id'));
  if (!m) throw notFound('Archivo');
  const id = b.variantId ?? newId('var');
  const key = `org/${m.organization_id}/media/${m.id}/${id}.mp4`;
  const mp = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp4' } });
  if (b.variantId) await run(c.env.DB, 'UPDATE media_variants SET upload_id = ?, r2_key = ? WHERE id = ? AND media_id = ?', mp.uploadId, key, id, m.id);
  else {
    await run(c.env.DB, "INSERT INTO media_variants (id, media_id, organization_id, kind, profile, r2_key, upload_id, status, created_at) VALUES (?,?,?,'canonical',?,?,?,'processing',?)",
      id, m.id, m.organization_id, b.profile, key, mp.uploadId, Date.now());
  }
  return c.json({ variantId: id, partSize: UPLOAD_PART_SIZE });
});

internal.put('/variants/:vid/parts/:n', async (c) => {
  const v = await first<{ r2_key: string; upload_id: string | null }>(c.env.DB, 'SELECT r2_key, upload_id FROM media_variants WHERE id = ?', c.req.param('vid'));
  if (!v?.upload_id) throw notFound('Subida');
  const part = await c.env.MEDIA.resumeMultipartUpload(v.r2_key, v.upload_id).uploadPart(Number(c.req.param('n')), await c.req.arrayBuffer());
  return c.json({ partNumber: part.partNumber, etag: part.etag });
});

internal.post('/variants/:vid/complete', async (c) => {
  const b = await parseBody(c, z.object({ parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1), sizeBytes: z.number().int().positive(), durationSec: z.number().positive() }));
  const v = await first<{ id: string; media_id: string; profile: string; r2_key: string; upload_id: string | null }>(c.env.DB, 'SELECT * FROM media_variants WHERE id = ?', c.req.param('vid'));
  if (!v?.upload_id) throw notFound('Subida');
  await c.env.MEDIA.resumeMultipartUpload(v.r2_key, v.upload_id).complete(b.parts);
  // Una sola variante canónica lista por perfil: las anteriores se retiran.
  const old = await all<{ id: string; r2_key: string }>(c.env.DB, "SELECT id, r2_key FROM media_variants WHERE media_id = ? AND kind = 'canonical' AND profile = ? AND id != ?", v.media_id, v.profile, v.id);
  if (old.length) {
    await c.env.MEDIA.delete(old.map((o) => o.r2_key));
    await run(c.env.DB, `DELETE FROM media_variants WHERE id IN (${old.map(() => '?').join(',')})`, ...old.map((o) => o.id));
  }
  await run(c.env.DB, "UPDATE media_variants SET status = 'ready', upload_id = NULL, size_bytes = ?, duration_sec = ?, lease_expires_at = NULL WHERE id = ?", b.sizeBytes, b.durationSec, v.id);
  return c.json({ ok: true });
});

internal.post('/media/:id/result', async (c) => {
  const id = c.req.param('id');
  const variantId = c.req.query('variantId');
  const b = await parseBody(c, mediaResultSchema);
  const now = Date.now();
  if (variantId) {
    if (!b.ok) await run(c.env.DB, "UPDATE media_variants SET status = CASE WHEN ?1 AND attempts < ?2 THEN 'pending' ELSE 'failed' END, error_message = ?3, lease_expires_at = NULL WHERE id = ?4", b.retryable ? 1 : 0, MAX_MEDIA_ATTEMPTS, b.message, variantId);
    return c.json({ ok: true });
  }
  if (b.ok) {
    const p = b.probe;
    await run(c.env.DB,
      `UPDATE media_assets SET status = 'ready', kind = ?, sha256 = ?, duration_sec = ?, width = ?, height = ?, fps = ?, video_codec = ?, audio_codec = ?, has_audio = ?,
         progress = 100, error_code = NULL, error_message = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status = 'processing'`,
      b.kind, b.sha256 ?? null, p?.durationSec ?? null, p?.width ?? null, p?.height ?? null, p?.fps ?? null, p?.videoCodec ?? null, p?.audioCodec ?? null, p ? (p.hasAudio ? 1 : 0) : null, now, id);
  } else {
    await run(c.env.DB,
      `UPDATE media_assets SET status = CASE WHEN ?1 AND attempts < ?2 THEN 'queued' ELSE 'failed' END, error_code = ?3, error_message = ?4, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?5
       WHERE id = ?6 AND status = 'processing'`, b.retryable ? 1 : 0, MAX_MEDIA_ATTEMPTS, b.code, b.message, now, id);
  }
  return c.json({ ok: true });
});

internal.get('/variants/:vid/file', async (c) => {
  const v = await first<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM media_variants WHERE id = ? AND status = 'ready'", c.req.param('vid'));
  const obj = v && (await c.env.MEDIA.get(v.r2_key));
  if (!obj) throw notFound('Variante');
  return new Response(obj.body, { headers: { 'content-type': 'video/mp4', 'content-length': String(obj.size) } });
});

// ───────────────────────── Emisión ─────────────────────────

internal.post('/streams/claim', async (c) => {
  const b = await parseBody(c, z.object({ nodeId: z.string().min(1).max(64), hostname: z.string().max(120).optional(), version: z.string().max(40).optional(), capacity: z.number().int().min(0).max(1000), running: z.number().int().min(0) }));
  const now = Date.now();
  await run(c.env.DB, `INSERT INTO worker_nodes (id, hostname, version, capacity, running, last_seen_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET hostname = excluded.hostname, version = excluded.version, capacity = excluded.capacity, running = excluded.running, last_seen_at = excluded.last_seen_at`,
    b.nodeId, b.hostname ?? null, b.version ?? null, b.capacity, b.running, now);
  await reconcile(c.env);
  if (b.running >= b.capacity) return c.json({ assignment: null });

  const sessionId = newId('ses');
  const s = await first<StreamRow & { prev_status: string }>(c.env.DB,
    `UPDATE streams SET lease_owner = ?1, lease_expires_at = ?2, fencing_token = fencing_token + 1, current_session_id = ?3,
       status = CASE WHEN status = 'recovering' THEN 'recovering' ELSE 'starting' END, updated_at = ?4
     WHERE id = (SELECT id FROM streams WHERE desired_state = 'running' AND deleted_at IS NULL AND status != 'suspended'
                 AND (lease_owner IS NULL OR lease_expires_at < ?4) ORDER BY updated_at LIMIT 1)
       AND (lease_owner IS NULL OR lease_expires_at < ?4)
     RETURNING *`, b.nodeId, now + ttlMs(c.env), sessionId, now);
  if (!s) return c.json({ assignment: null });

  const { playlist, missing, reason } = await resolvePlaylist(c.env, s);
  if (!playlist) {
    await failStream(c.env, s, missing.length ? 'Faltan vídeos convertidos para la calidad seleccionada.' : (reason ?? 'Playlist no disponible.'));
    return c.json({ assignment: null });
  }
  const destinations = await destinationUrls(c.env, s.id);
  if (!destinations.length) {
    await failStream(c.env, s, 'El stream no tiene destinos configurados.');
    return c.json({ assignment: null });
  }
  await run(c.env.DB, 'INSERT INTO stream_sessions (id, stream_id, organization_id, node_id, fencing_token, started_at, last_heartbeat_at) VALUES (?,?,?,?,?,?,?)',
    sessionId, s.id, s.organization_id, b.nodeId, s.fencing_token, now, now);
  await run(c.env.DB, "UPDATE stream_destinations SET state = 'connecting', bitrate_kbps = NULL, out_time_sec = NULL, last_error = NULL, updated_at = ? WHERE stream_id = ?", now, s.id);
  const recovering = s.status === 'recovering';
  const pos = s.position ? (JSON.parse(s.position) as { cycle: number; position: number; playlistVersionId: string }) : null;
  await addEvent(c.env.DB, { streamId: s.id, orgId: s.organization_id, sessionId, type: recovering ? 'recovery_claimed' : 'claimed', level: recovering ? 'warn' : 'info',
    message: `Nodo ${b.nodeId} ${recovering ? 'retoma' : 'asume'} la emisión (fencing ${s.fencing_token}).` });
  const assignment: StreamAssignment = {
    streamId: s.id, organizationId: s.organization_id, sessionId, fencingToken: s.fencing_token, leaseTtlSec: ttlMs(c.env) / 1000,
    mode: s.mode, seed: s.seed, profile: s.profile, restartNonce: s.restart_nonce, playlist, destinations,
    configRevision: await configRevision(c.env, s),
    // Reanudación aproximada: se retoma el ítem que estaba sonando, desde su inicio.
    resume: recovering && pos && pos.playlistVersionId === playlist.versionId ? { cycle: pos.cycle, position: pos.position } : null,
  };
  return c.json({ assignment });
});

internal.post('/streams/:id/heartbeat', async (c) => {
  const hb = await parseBody(c, heartbeatSchema);
  const now = Date.now();
  const s = await first<StreamRow>(c.env.DB, 'SELECT * FROM streams WHERE id = ?', c.req.param('id'));
  if (!s || s.fencing_token !== hb.fencingToken || s.lease_owner !== hb.nodeId) {
    throw new HttpError(409, 'stale_lease', 'Otro nodo tiene la emisión o el lease caducó: detén FFmpeg de inmediato.');
  }
  const sess = await first<{ last_heartbeat_at: number }>(c.env.DB, 'SELECT last_heartbeat_at FROM stream_sessions WHERE id = ?', hb.sessionId);
  const onAir = hb.status === 'live' || hb.status === 'degraded';
  const deltaSec = sess && onAir ? Math.min(now - sess.last_heartbeat_at, ttlMs(c.env)) / 1000 : 0;
  const bytes = hb.destinations?.reduce((a, d) => a + d.bytesSent, 0);
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('UPDATE stream_sessions SET last_heartbeat_at = ?, live_seconds = live_seconds + ?, bytes_sent = COALESCE(?, bytes_sent) WHERE id = ?').bind(now, deltaSec, bytes ?? null, hb.sessionId),
  ];
  for (const d of hb.destinations ?? []) {
    stmts.push(c.env.DB.prepare('UPDATE stream_destinations SET state = ?, bitrate_kbps = ?, out_time_sec = ?, bytes_sent = ?, restarts = ?, last_error = ?, updated_at = ? WHERE stream_id = ? AND destination_id = ?')
      .bind(d.state, d.bitrateKbps, d.outTimeSec, d.bytesSent, d.restarts, d.lastError ? redactRtmp(d.lastError) : null, now, s.id, d.id));
  }
  for (const e of hb.events ?? []) {
    stmts.push(c.env.DB.prepare('INSERT INTO stream_events (stream_id, organization_id, session_id, type, level, message, data, created_at) VALUES (?,?,?,?,?,?,?,?)')
      .bind(s.id, s.organization_id, hb.sessionId, e.type, e.level, redactRtmp(e.message), e.data ? redactRtmp(JSON.stringify(e.data)) : null, e.at));
  }
  const terminal = hb.status === 'stopped' || hb.status === 'failed';
  if (terminal) {
    // 'restart' conserva desired_state=running para que el canal se reclame de nuevo de inmediato.
    // 'node_shutdown' (apagado ordenado del nodo) además conserva la posición para reanudar en otro nodo.
    const keepRunning = hb.status === 'stopped' && (hb.reason === 'restart' || hb.reason === 'node_shutdown') && s.desired_state === 'running';
    const status = keepRunning ? (hb.reason === 'node_shutdown' ? 'recovering' : 'starting') : hb.status;
    stmts.push(c.env.DB.prepare(`UPDATE streams SET status = ?, status_reason = ?, desired_state = ?, lease_owner = NULL, lease_expires_at = NULL, last_heartbeat_at = ?, updated_at = ?,
        position = CASE WHEN ? THEN position ELSE NULL END WHERE id = ? AND fencing_token = ?`)
      .bind(status, hb.status === 'failed' ? (hb.reason ?? 'Error del motor de emisión.') : null, keepRunning ? 'running' : 'stopped', now, now, keepRunning ? 1 : 0, s.id, hb.fencingToken));
    stmts.push(c.env.DB.prepare('UPDATE stream_sessions SET ended_at = ?, end_reason = ? WHERE id = ?').bind(now, hb.reason ?? hb.status, hb.sessionId));
    stmts.push(c.env.DB.prepare("UPDATE stream_destinations SET state = 'idle', bitrate_kbps = NULL, updated_at = ? WHERE stream_id = ?").bind(now, s.id));
  } else {
    const status = s.desired_state === 'stopped' ? 'stopping' : hb.status;
    stmts.push(c.env.DB.prepare(`UPDATE streams SET status = ?, status_reason = ?, lease_expires_at = ?, last_heartbeat_at = ?, updated_at = ?,
        position = COALESCE(?, position), metrics = COALESCE(?, metrics) WHERE id = ? AND fencing_token = ?`)
      .bind(status, hb.reason ?? null, now + ttlMs(c.env), now, now, hb.position ? JSON.stringify(hb.position) : null, hb.metrics ? JSON.stringify(hb.metrics) : null, s.id, hb.fencingToken));
  }
  await c.env.DB.batch(stmts);
  const res: HeartbeatResponse = {
    command: s.desired_state === 'stopped' || s.status === 'suspended' ? 'stop' : 'continue',
    restartNonce: s.restart_nonce,
    configRevision: await configRevision(c.env, s),
  };
  return c.json(res);
});

internal.get('/streams/:id/config', async (c) => {
  const s = await first<StreamRow>(c.env.DB, 'SELECT * FROM streams WHERE id = ?', c.req.param('id'));
  if (!s || s.fencing_token !== Number(c.req.query('fencingToken')) || s.lease_owner !== c.req.query('nodeId')) {
    throw new HttpError(409, 'stale_lease', 'Lease no vigente.');
  }
  const { playlist } = await resolvePlaylist(c.env, s);
  // Si la nueva versión aún no tiene variantes listas se mantiene la actual: nunca se corta la emisión por una edición.
  if (!playlist) throw new HttpError(409, 'config_not_ready', 'La nueva configuración aún no está lista para emitirse.');
  const body: StreamConfigRefresh = { configRevision: await configRevision(c.env, s), playlist, destinations: await destinationUrls(c.env, s.id) };
  return c.json(body);
});
