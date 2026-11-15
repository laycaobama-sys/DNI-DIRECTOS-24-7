/**
 * Grabaciones en la nube, vista previa en directo y miniaturas personalizadas.
 *
 * - Grabación: el motor sube fragmentos MPEG-TS de ~60 s a R2 (multipart). Cada fragmento es reproducible por sí
 *   solo; la grabación se reproduce como HLS VOD y se exporta a MP4 en segundo plano.
 * - Vista previa: fragmentos de ~2 s (imagen y sonido reales de la señal de salida) que solo se generan mientras
 *   alguien la mira (`preview_until`), para no gastar recursos.
 * - Miniaturas: imagen personalizada para vídeos, playlists, emisiones y grabaciones; sincronizable con YouTube
 *   (thumbnails.set) cuando el destino se creó con la conexión oficial de YouTube.
 * Todo responde 404 a recursos de otra organización.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Env, HttpError, all, audit, first, newId, notFound, parseBody, run, sha256Hex, timingSafeEqual } from '../lib/core';
import { wakeEngines } from '../engine-node';
import { requireAuth } from './auth';
import { syncYoutubeThumbnail } from './youtube';

const PREVIEW_WINDOW = 6;
const PREVIEW_HOLD_MS = 45_000;
const MAX_THUMB_BYTES = 2 * 1024 * 1024;
const MAX_EXPORT_BYTES = 6 * 1024 ** 3;

// ───────────────────────── utilidades ─────────────────────────
const hlsHeaders = { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' };
const tsHeaders = (size: number, cache = 'private, max-age=60') => ({ 'content-type': 'video/mp2t', 'content-length': String(size), 'cache-control': cache });

function imageType(b: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

/** Sirve un objeto de R2 con soporte de Range (necesario para <video> en Safari/iPhone y para buscar). */
export async function serveRange(env: Env, key: string, req: Request, type: string): Promise<Response> {
  const head = await env.MEDIA.head(key);
  if (!head) throw notFound('Archivo');
  const size = head.size;
  const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get('range') ?? '');
  if (m) {
    let start = m[1] ? Number(m[1]) : NaN, end = m[2] ? Number(m[2]) : NaN;
    if (Number.isNaN(start)) { start = Math.max(0, size - end); end = size - 1; }
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
    const obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(obj!.body, { status: 206, headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1), 'cache-control': 'private, max-age=300' } });
  }
  const obj = await env.MEDIA.get(key);
  return new Response(obj!.body, { headers: { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': String(size), 'cache-control': 'private, max-age=300' } });
}

/** Enlace firmado (HMAC con ENCRYPTION_KEY) para compartir una descarga sin sesión, con caducidad. */
async function sign(env: Env, payload: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(`share:${env.ENCRYPTION_KEY}`), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 43);
}

// ───────────────────────── API pública ─────────────────────────
export const recordings = new Hono<AppEnv>();

interface RecordingRow {
  id: string; organization_id: string; stream_id: string | null; session_id: string | null; name: string; status: string; started_at: number; ended_at: number | null;
  duration_sec: number; size_bytes: number; segment_count: number; thumbnail_key: string | null; export_key: string | null; export_status: string | null; export_error: string | null; expires_at: number | null;
}
const recDto = (r: RecordingRow & { stream_name?: string | null }) => ({
  id: r.id, name: r.name, status: r.status, streamId: r.stream_id, streamName: r.stream_name ?? null, startedAt: r.started_at, endedAt: r.ended_at,
  durationSec: r.duration_sec, sizeBytes: r.size_bytes, segments: r.segment_count, hasThumbnail: !!r.thumbnail_key,
  export: r.export_status ? { status: r.export_status, error: r.export_error } : null, expiresAt: r.expires_at,
});
const getRec = async (env: Env, orgId: string, id: string) => {
  const r = await first<RecordingRow>(env.DB, "SELECT * FROM recordings WHERE id = ? AND organization_id = ? AND status != 'deleted'", id, orgId);
  if (!r) throw notFound('Grabación');
  return r;
};

recordings.get('/', requireAuth(), async (c) => {
  const rows = await all<RecordingRow & { stream_name: string | null }>(c.env.DB,
    `SELECT r.*, s.name AS stream_name FROM recordings r LEFT JOIN streams s ON s.id = r.stream_id WHERE r.organization_id = ? AND r.status != 'deleted' ORDER BY r.started_at DESC LIMIT 200`, c.get('auth').orgId);
  const used = rows.reduce((s, r) => s + r.size_bytes, 0);
  return c.json({ items: rows.map(recDto), usedBytes: used });
});

recordings.get('/:id', requireAuth(), async (c) => c.json(recDto(await getRec(c.env, c.get('auth').orgId, c.req.param('id')))));

recordings.patch('/:id', requireAuth('editor'), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  const b = await parseBody(c, z.object({ name: z.string().trim().min(1).max(160).optional(), keepDays: z.number().int().min(1).max(365).nullable().optional() }));
  if (b.name) await run(c.env.DB, 'UPDATE recordings SET name = ? WHERE id = ?', b.name, r.id);
  if (b.keepDays !== undefined) await run(c.env.DB, 'UPDATE recordings SET expires_at = ? WHERE id = ?', b.keepDays === null ? null : Date.now() + b.keepDays * 86_400_000, r.id);
  return c.json(recDto(await getRec(c.env, c.get('auth').orgId, r.id)));
});

/** HLS VOD (o en curso) de la grabación: cada fragmento de ~60 s es un segmento. */
recordings.get('/:id/playlist.m3u8', requireAuth(), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  const segs = await all<{ seq: number; duration_sec: number; discontinuity: number }>(c.env.DB, "SELECT seq, duration_sec, discontinuity FROM recording_segments WHERE recording_id = ? AND status = 'ready' ORDER BY seq", r.id);
  const target = Math.ceil(Math.max(1, ...segs.map((s) => s.duration_sec)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, '#EXT-X-MEDIA-SEQUENCE:0', `#EXT-X-PLAYLIST-TYPE:${r.status === 'recording' ? 'EVENT' : 'VOD'}`];
  let prev = -1;
  for (const s of segs) {
    if (prev >= 0 && (s.seq !== prev + 1 || s.discontinuity)) lines.push('#EXT-X-DISCONTINUITY'); // hueco por un fragmento perdido o relevo de nodo
    lines.push(`#EXTINF:${s.duration_sec.toFixed(3)},`, `segments/${s.seq}.ts`);
    prev = s.seq;
  }
  if (r.status !== 'recording') lines.push('#EXT-X-ENDLIST');
  return new Response(lines.join('\n') + '\n', { headers: hlsHeaders });
});

recordings.get('/:id/segments/:seq{[0-9]+\\.ts}', requireAuth(), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  const seq = Number.parseInt(c.req.param('seq'), 10);
  const s = await first<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM recording_segments WHERE recording_id = ? AND seq = ? AND status = 'ready'", r.id, seq);
  if (!s) throw notFound('Fragmento');
  return serveRange(c.env, s.r2_key, c.req.raw, 'video/mp2t');
});

/** Exportación a MP4 (en segundo plano, en el motor). Rango opcional de fragmentos para grabaciones largas. */
recordings.post('/:id/export', requireAuth('editor'), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  const b = await parseBody(c, z.object({ fromSeq: z.number().int().min(0).optional(), toSeq: z.number().int().min(0).optional() }));
  if (r.status === 'recording') throw new HttpError(409, 'recording_in_progress', 'Detén la grabación (o la emisión) antes de exportarla a MP4. Mientras tanto puedes verla aquí.');
  const segs = await all<{ seq: number; size_bytes: number }>(c.env.DB, "SELECT seq, size_bytes FROM recording_segments WHERE recording_id = ? AND status = 'ready' AND seq BETWEEN ? AND ? ORDER BY seq",
    r.id, b.fromSeq ?? 0, b.toSeq ?? 1e9);
  if (!segs.length) throw new HttpError(422, 'empty_range', 'No hay fragmentos en ese rango.');
  const total = segs.reduce((s, x) => s + x.size_bytes, 0);
  if (total > MAX_EXPORT_BYTES) throw new HttpError(413, 'export_too_large', `La exportación ocuparía ${(total / 1024 ** 3).toFixed(1)} GB (máximo 6 GB por archivo). Exporta por tramos más cortos.`);
  await run(c.env.DB, "UPDATE recordings SET export_status = 'pending', export_error = NULL, export_attempts = 0, export_lease_expires_at = NULL, export_key = ? WHERE id = ?",
    `range:${segs[0]!.seq}-${segs[segs.length - 1]!.seq}`, r.id);
  await audit(c, 'recording.export_requested', r.id, { segments: segs.length });
  c.executionCtx.waitUntil(wakeEngines(c.env));
  return c.json(recDto(await getRec(c.env, c.get('auth').orgId, r.id)), 202);
});

recordings.get('/:id/download', requireAuth(), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  if (r.export_status !== 'ready' || !r.export_key) throw new HttpError(409, 'export_not_ready', 'Exporta primero la grabación a MP4.');
  const res = await serveRange(c.env, r.export_key, c.req.raw, 'video/mp4');
  res.headers.set('content-disposition', `attachment; filename="${r.name.replace(/[^\w\- .]/g, '_').slice(0, 80)}.mp4"`);
  return res;
});

/** Enlace de descarga compartible y firmado (caduca en 1–7 días). */
recordings.post('/:id/share', requireAuth('editor'), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  if (r.export_status !== 'ready') throw new HttpError(409, 'export_not_ready', 'Exporta primero la grabación a MP4.');
  const b = await parseBody(c, z.object({ days: z.number().int().min(1).max(7).default(2) }));
  const exp = Date.now() + b.days * 86_400_000;
  const url = `${c.env.PUBLIC_URL || new URL(c.req.url).origin}/v1/public/recordings/${r.id}?e=${exp}&s=${await sign(c.env, `${r.id}.${exp}`)}`;
  await audit(c, 'recording.shared', r.id, { days: b.days });
  return c.json({ url, expiresAt: exp });
});

recordings.delete('/:id', requireAuth('editor'), async (c) => {
  const r = await getRec(c.env, c.get('auth').orgId, c.req.param('id'));
  if (r.status === 'recording') throw new HttpError(409, 'recording_in_progress', 'Desactiva la grabación de la emisión antes de borrarla.');
  await deleteRecordingObjects(c.env, r);
  await audit(c, 'recording.deleted', r.id);
  return c.json({ ok: true });
});

export async function deleteRecordingObjects(env: Env, r: { id: string; organization_id: string; export_key: string | null; thumbnail_key: string | null }) {
  let cursor: string | undefined;
  do {
    const list = await env.MEDIA.list({ prefix: `org/${r.organization_id}/recordings/${r.id}/`, cursor });
    if (list.objects.length) await env.MEDIA.delete(list.objects.map((o) => o.key));
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM recording_segment_parts WHERE recording_id = ?').bind(r.id),
    env.DB.prepare('DELETE FROM recording_segments WHERE recording_id = ?').bind(r.id),
    env.DB.prepare("UPDATE recordings SET status = 'deleted', size_bytes = 0, export_key = NULL WHERE id = ?").bind(r.id),
  ]);
}

/** Retención: borra grabaciones caducadas (cron). */
export async function expireRecordings(env: Env) {
  const rows = await all<RecordingRow>(env.DB, "SELECT * FROM recordings WHERE expires_at IS NOT NULL AND expires_at < ? AND status IN ('ready','failed') LIMIT 20", Date.now());
  for (const r of rows) await deleteRecordingObjects(env, r);
  return rows.length;
}

// ───────────────────────── Descarga pública firmada ─────────────────────────
export const publicRoutes = new Hono<AppEnv>();
publicRoutes.get('/recordings/:id', async (c) => {
  const id = c.req.param('id'), e = Number(c.req.query('e')), s = c.req.query('s') ?? '';
  if (!e || e < Date.now() || !(await timingSafeEqual(s, await sign(c.env, `${id}.${e}`)))) throw new HttpError(403, 'link_expired', 'El enlace no es válido o ha caducado.');
  const r = await first<RecordingRow>(c.env.DB, "SELECT * FROM recordings WHERE id = ? AND status != 'deleted' AND export_status = 'ready'", id);
  if (!r?.export_key) throw notFound('Grabación');
  const res = await serveRange(c.env, r.export_key, c.req.raw, 'video/mp4');
  res.headers.set('content-disposition', `attachment; filename="${r.name.replace(/[^\w\- .]/g, '_').slice(0, 80)}.mp4"`);
  return res;
});

// ───────────────────────── Vista previa en directo ─────────────────────────
export const preview = new Hono<AppEnv>();

interface PreviewSeg { seq: number; d: number; at: number }
/** Playlist HLS en directo con los últimos fragmentos. Pedirla mantiene viva la generación de la vista previa. */
preview.get('/:id/preview.m3u8', requireAuth(), async (c) => {
  const s = await first<{ id: string; preview_until: number | null; preview_index: string | null; desired_state: string; current_session_id: string | null }>(c.env.DB,
    'SELECT id, preview_until, preview_index, desired_state, current_session_id FROM streams WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', c.req.param('id'), c.get('auth').orgId);
  if (!s) throw notFound('Stream');
  const now = Date.now();
  if ((s.preview_until ?? 0) < now + PREVIEW_HOLD_MS - 15_000) await run(c.env.DB, 'UPDATE streams SET preview_until = ? WHERE id = ?', now + PREVIEW_HOLD_MS, s.id);
  const idx = (s.preview_index ? JSON.parse(s.preview_index) : []) as PreviewSeg[];
  // Solo fragmentos recientes: si la emisión se detuvo, la playlist queda vacía en lugar de mostrar algo viejo.
  const fresh = idx.filter((x) => now - x.at < 30_000);
  if (s.desired_state !== 'running') return c.json({ error: { code: 'not_live', message: 'La emisión no está en marcha.' } }, 409);
  if (!fresh.length) return c.json({ error: { code: 'preview_starting', message: 'Preparando la vista previa (unos segundos)…' } }, 503);
  const target = Math.ceil(Math.max(2, ...fresh.map((x) => x.d)));
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${target}`, `#EXT-X-MEDIA-SEQUENCE:${fresh[0]!.seq}`];
  let prev = -1;
  for (const x of fresh) {
    if (prev >= 0 && x.seq !== prev + 1) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${x.d.toFixed(3)},`, `preview/${x.seq}.ts`);
    prev = x.seq;
  }
  return new Response(lines.join('\n') + '\n', { headers: hlsHeaders });
});

preview.get('/:id/preview/:seq{[0-9]+\\.ts}', requireAuth(), async (c) => {
  const s = await first<{ id: string; organization_id: string }>(c.env.DB, 'SELECT id, organization_id FROM streams WHERE id = ? AND organization_id = ?', c.req.param('id'), c.get('auth').orgId);
  if (!s) throw notFound('Stream');
  const obj = await c.env.MEDIA.get(`org/${s.organization_id}/preview/${s.id}/${Number.parseInt(c.req.param('seq'), 10)}.ts`);
  if (!obj) throw notFound('Fragmento');
  return new Response(obj.body, { headers: tsHeaders(obj.size, 'private, max-age=30') });
});

// ───────────────────────── Miniaturas ─────────────────────────
export const thumbnails = new Hono<AppEnv>();
type Entity = 'media' | 'playlist' | 'stream' | 'recording';
const TABLE: Record<Entity, { table: string; col: string }> = {
  media: { table: 'media_assets', col: 'custom_thumbnail_key' },
  playlist: { table: 'playlists', col: 'thumbnail_key' },
  stream: { table: 'streams', col: 'thumbnail_key' },
  recording: { table: 'recordings', col: 'thumbnail_key' },
};
const entityOf = (e: string): Entity => { if (!(e in TABLE)) throw notFound('Tipo'); return e as Entity; };

async function owned(env: Env, e: Entity, id: string, orgId: string) {
  const t = TABLE[e];
  const row = await first<{ id: string; key: string | null }>(env.DB, `SELECT id, ${t.col} AS key FROM ${t.table} WHERE id = ? AND organization_id = ?`, id, orgId);
  if (!row) throw notFound('Recurso');
  return row;
}

thumbnails.put('/:entity/:id', requireAuth('editor'), async (c) => {
  const e = entityOf(c.req.param('entity'));
  const { orgId } = c.get('auth');
  const row = await owned(c.env, e, c.req.param('id'), orgId);
  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength > MAX_THUMB_BYTES) throw new HttpError(413, 'thumbnail_too_large', 'La miniatura debe ocupar 2 MB como máximo (límite de YouTube).');
  const type = imageType(body);
  if (!type) throw new HttpError(422, 'thumbnail_format', 'Formato no admitido: usa JPG, PNG o WebP.');
  const ext = type.split('/')[1];
  const key = `org/${orgId}/thumbs/${e}/${row.id}-${(await sha256Hex(String(Date.now()) + row.id)).slice(0, 10)}.${ext}`;
  await c.env.MEDIA.put(key, body, { httpMetadata: { contentType: type } });
  const t = TABLE[e];
  await run(c.env.DB, `UPDATE ${t.table} SET ${t.col} = ?${e === 'stream' || e === 'playlist' ? ', thumbnail_updated_at = ' + Date.now() : ''} WHERE id = ?`, key, row.id);
  // La anterior se borra solo después de guardar la nueva: si algo falla, se conserva la que había.
  if (row.key) await c.env.MEDIA.delete(row.key).catch(() => {});
  await audit(c, 'thumbnail.updated', `${e}:${row.id}`);
  // Si la emisión tiene directos creados con «YouTube con un clic», la miniatura se envía también a YouTube.
  let youtube: Awaited<ReturnType<typeof syncYoutubeThumbnail>> | null = null;
  if (e === 'stream' && type !== 'image/webp') youtube = await syncYoutubeThumbnail(c.env, orgId, row.id).catch(() => null);
  return c.json({ ok: true, updatedAt: Date.now(), youtube });
});

thumbnails.get('/:entity/:id', requireAuth(), async (c) => {
  const e = entityOf(c.req.param('entity'));
  const { orgId } = c.get('auth');
  const row = await owned(c.env, e, c.req.param('id'), orgId);
  let key = row.key;
  if (!key && e === 'media') key = (await first<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM media_variants WHERE media_id = ? AND kind = 'thumbnail' AND status = 'ready'", row.id))?.r2_key ?? null;
  if (!key && e === 'playlist') {
    // Portada por defecto: la del primer vídeo de la playlist.
    const first0 = await first<{ m: string }>(c.env.DB, "SELECT json_extract(draft_items, '$[0].mediaId') AS m FROM playlists WHERE id = ?", row.id);
    if (first0?.m) key = (await first<{ k: string }>(c.env.DB, "SELECT COALESCE(a.custom_thumbnail_key, v.r2_key) AS k FROM media_assets a LEFT JOIN media_variants v ON v.media_id = a.id AND v.kind = 'thumbnail' AND v.status = 'ready' WHERE a.id = ? AND a.organization_id = ?", first0.m, orgId))?.k ?? null;
  }
  const obj = key ? await c.env.MEDIA.get(key) : null;
  if (!obj) throw notFound('Miniatura');
  return new Response(obj.body, { headers: { 'content-type': obj.httpMetadata?.contentType ?? 'image/jpeg', 'cache-control': 'private, no-cache' } });
});

thumbnails.delete('/:entity/:id', requireAuth('editor'), async (c) => {
  const e = entityOf(c.req.param('entity'));
  const row = await owned(c.env, e, c.req.param('id'), c.get('auth').orgId);
  const t = TABLE[e];
  await run(c.env.DB, `UPDATE ${t.table} SET ${t.col} = NULL WHERE id = ?`, row.id);
  if (row.key) await c.env.MEDIA.delete(row.key).catch(() => {});
  return c.json({ ok: true });
});

// ───────────────────────── Interno (motor) ─────────────────────────
interface StreamLease { id: string; organization_id: string; fencing_token: number; lease_owner: string | null; recording_retention_days: number; name: string; profile: string }

/** Registra las rutas internas de grabación y vista previa (ya autenticadas con ENGINE_TOKEN). */
export function registerInternalRecordingRoutes(internal: Hono<AppEnv>) {
  const lease = async (env: Env, streamId: string, fencing: number) => {
    const s = await first<StreamLease>(env.DB, 'SELECT id, organization_id, fencing_token, lease_owner, recording_retention_days, name, profile FROM streams WHERE id = ?', streamId);
    if (!s || s.fencing_token !== fencing) throw new HttpError(409, 'stale_lease', 'Lease no vigente.');
    return s;
  };
  const recOf = async (env: Env, id: string) => {
    const r = await first<RecordingRow>(env.DB, 'SELECT * FROM recordings WHERE id = ?', id);
    if (!r) throw notFound('Grabación');
    return r;
  };

  internal.post('/recordings/start', async (c) => {
    const b = await parseBody(c, z.object({ streamId: z.string(), sessionId: z.string(), fencingToken: z.number().int(), nodeId: z.string() }));
    const s = await lease(c.env, b.streamId, b.fencingToken);
    // Idempotente por sesión: un reintento o un relevo de nodo continúa la misma grabación.
    const existing = await first<{ id: string }>(c.env.DB, "SELECT id FROM recordings WHERE session_id = ? AND status = 'recording'", b.sessionId);
    if (existing) return c.json({ recordingId: existing.id });
    const now = Date.now();
    // Relevo de nodo o reinicio (sesión distinta): se continúa la grabación de la sesión anterior en vez de partirla en dos.
    const prev = await first<{ id: string }>(c.env.DB,
      `SELECT id FROM recordings WHERE stream_id = ? AND session_id != ? AND export_status IS NULL
         AND (status = 'recording' OR (status = 'ready' AND ended_at > ?)) ORDER BY started_at DESC LIMIT 1`, s.id, b.sessionId, now - 3 * 60_000);
    if (prev) {
      await run(c.env.DB, "UPDATE recordings SET status = 'recording', session_id = ?, ended_at = NULL WHERE id = ?", b.sessionId, prev.id);
      return c.json({ recordingId: prev.id, continued: true });
    }
    const id = newId('rec');
    const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
    await run(c.env.DB, `INSERT INTO recordings (id, organization_id, stream_id, session_id, name, status, started_at, expires_at, width, height, created_at) VALUES (?,?,?,?,?,'recording',?,?,?,?,?)`,
      id, s.organization_id, s.id, b.sessionId, `${s.name.slice(0, 120)} · ${stamp} UTC`, now, now + s.recording_retention_days * 86_400_000,
      s.profile === '1080p30' ? 1920 : 1280, s.profile === '1080p30' ? 1080 : 720, now);
    return c.json({ recordingId: id });
  });

  internal.post('/recordings/:rid/segments', async (c) => {
    const b = await parseBody(c, z.object({ seq: z.number().int().min(0), fencingToken: z.number().int(), streamId: z.string() }));
    await lease(c.env, b.streamId, b.fencingToken);
    const r = await recOf(c.env, c.req.param('rid'));
    // Si un relevo de nodo reinicia la numeración, se continúa tras el último fragmento existente.
    const max = await first<{ m: number | null }>(c.env.DB, 'SELECT MAX(seq) AS m FROM recording_segments WHERE recording_id = ?', r.id);
    const seq = (max?.m ?? -1) + 1;
    // El primer fragmento de un grabador que continúa una grabación existente lleva marca de discontinuidad.
    const discontinuity = b.seq === 0 && max?.m != null ? 1 : 0;
    const key = `org/${r.organization_id}/recordings/${r.id}/${String(seq).padStart(6, '0')}.ts`;
    const mp = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp2t' } });
    await run(c.env.DB, "INSERT INTO recording_segments (recording_id, seq, r2_key, upload_id, status, discontinuity, created_at) VALUES (?,?,?,?, 'uploading', ?, ?)", r.id, seq, key, mp.uploadId, discontinuity, Date.now());
    return c.json({ ok: true, seq });
  });

  internal.put('/recordings/:rid/segments/:seq/parts/:n', async (c) => {
    const s = await first<{ r2_key: string; upload_id: string | null }>(c.env.DB, "SELECT r2_key, upload_id FROM recording_segments WHERE recording_id = ? AND seq = ? AND status = 'uploading'", c.req.param('rid'), Number(c.req.param('seq')));
    if (!s?.upload_id) throw notFound('Fragmento');
    const part = await c.env.MEDIA.resumeMultipartUpload(s.r2_key, s.upload_id).uploadPart(Number(c.req.param('n')), await c.req.arrayBuffer());
    return c.json({ etag: part.etag });
  });

  internal.post('/recordings/:rid/segments/:seq/complete', async (c) => {
    const b = await parseBody(c, z.object({ parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1), durationSec: z.number().min(0), sizeBytes: z.number().int().min(0), sha256: z.string().length(64) }));
    const rid = c.req.param('rid'), seq = Number(c.req.param('seq'));
    const s = await first<{ r2_key: string; upload_id: string | null }>(c.env.DB, "SELECT r2_key, upload_id FROM recording_segments WHERE recording_id = ? AND seq = ? AND status = 'uploading'", rid, seq);
    if (!s?.upload_id) return c.json({ ok: true }); // idempotente
    await c.env.MEDIA.resumeMultipartUpload(s.r2_key, s.upload_id).complete(b.parts);
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE recording_segments SET status = 'ready', upload_id = NULL, duration_sec = ?, size_bytes = ?, sha256 = ? WHERE recording_id = ? AND seq = ?").bind(b.durationSec, b.sizeBytes, b.sha256, rid, seq),
      c.env.DB.prepare('UPDATE recordings SET duration_sec = duration_sec + ?, size_bytes = size_bytes + ?, segment_count = segment_count + 1 WHERE id = ?').bind(b.durationSec, b.sizeBytes, rid),
    ]);
    return c.json({ ok: true });
  });

  internal.post('/recordings/:rid/finish', async (c) => {
    const b = await parseBody(c, z.object({ lostSegments: z.number().int().min(0).default(0), sessionId: z.string().optional() }));
    const r = await recOf(c.env, c.req.param('rid'));
    // Un nodo relevado no puede cerrar la grabación que ya continúa otra sesión.
    if (b.sessionId && r.session_id !== b.sessionId) return c.json({ ok: true, ignored: true });
    if (r.status !== 'recording') return c.json({ ok: true });
    // Los fragmentos que no llegaron a completarse se abortan (no ocupan espacio ni quedan a medias).
    const stuck = await all<{ seq: number; r2_key: string; upload_id: string | null }>(c.env.DB, "SELECT seq, r2_key, upload_id FROM recording_segments WHERE recording_id = ? AND status = 'uploading'", r.id);
    for (const s of stuck) {
      if (s.upload_id) await c.env.MEDIA.resumeMultipartUpload(s.r2_key, s.upload_id).abort().catch(() => {});
      await run(c.env.DB, "UPDATE recording_segments SET status = 'failed', upload_id = NULL WHERE recording_id = ? AND seq = ?", r.id, s.seq);
    }
    const ready = await first<{ n: number }>(c.env.DB, "SELECT COUNT(*) AS n FROM recording_segments WHERE recording_id = ? AND status = 'ready'", r.id);
    await run(c.env.DB, 'UPDATE recordings SET status = ?, ended_at = ?, export_error = ? WHERE id = ?',
      (ready?.n ?? 0) > 0 ? 'ready' : 'failed', Date.now(), b.lostSegments + stuck.length ? `${b.lostSegments + stuck.length} fragmento(s) no se pudieron guardar` : null, r.id);
    return c.json({ ok: true });
  });

  internal.get('/recordings/:rid/segments/:seq/file', async (c) => {
    const s = await first<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM recording_segments WHERE recording_id = ? AND seq = ? AND status = 'ready'", c.req.param('rid'), Number(c.req.param('seq')));
    const obj = s && (await c.env.MEDIA.get(s.r2_key));
    if (!obj) throw notFound('Fragmento');
    return new Response(obj.body, { headers: tsHeaders(obj.size, 'no-store') });
  });

  // Exportación MP4: subida multipart del resultado.
  internal.post('/recordings/:rid/export/start', async (c) => {
    const r = await recOf(c.env, c.req.param('rid'));
    const key = `org/${r.organization_id}/recordings/${r.id}/export.mp4`;
    const mp = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp4' } });
    return c.json({ uploadId: mp.uploadId, key });
  });
  internal.put('/recordings/:rid/export/parts/:n', async (c) => {
    const key = c.req.query('key'), uploadId = c.req.query('uploadId');
    const r = await recOf(c.env, c.req.param('rid'));
    if (!key || !uploadId || !key.startsWith(`org/${r.organization_id}/recordings/${r.id}/`)) throw new HttpError(422, 'bad_key', 'Clave no válida.');
    const part = await c.env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(Number(c.req.param('n')), await c.req.arrayBuffer());
    return c.json({ partNumber: part.partNumber, etag: part.etag });
  });
  internal.post('/recordings/:rid/export/complete', async (c) => {
    const b = await parseBody(c, z.object({ key: z.string(), uploadId: z.string(), parts: z.array(z.object({ partNumber: z.number().int(), etag: z.string() })).min(1) }));
    const r = await recOf(c.env, c.req.param('rid'));
    if (!b.key.startsWith(`org/${r.organization_id}/recordings/${r.id}/`)) throw new HttpError(422, 'bad_key', 'Clave no válida.');
    await c.env.MEDIA.resumeMultipartUpload(b.key, b.uploadId).complete(b.parts);
    await run(c.env.DB, "UPDATE recordings SET export_status = 'ready', export_key = ?, export_error = NULL, export_lease_expires_at = NULL WHERE id = ?", b.key, r.id);
    return c.json({ ok: true });
  });
  internal.post('/recordings/:rid/export/fail', async (c) => {
    const b = await parseBody(c, z.object({ message: z.string().max(500) }));
    await run(c.env.DB, "UPDATE recordings SET export_status = CASE WHEN export_attempts < 3 THEN 'pending' ELSE 'failed' END, export_error = ?, export_lease_expires_at = NULL WHERE id = ?", b.message, c.req.param('rid'));
    return c.json({ ok: true });
  });

  // Vista previa: el motor publica fragmentos de ~2 s; se guardan los últimos y se borran los viejos.
  internal.put('/streams/:id/preview/:seq', async (c) => {
    const f = Number(c.req.query('f')), d = Math.max(0.5, Math.min(10, Number(c.req.query('d')) || 2));
    const s = await first<{ id: string; organization_id: string; fencing_token: number; preview_index: string | null }>(c.env.DB,
      'SELECT id, organization_id, fencing_token, preview_index FROM streams WHERE id = ?', c.req.param('id'));
    if (!s || s.fencing_token !== f) throw new HttpError(409, 'stale_lease', 'Lease no vigente.');
    const seq = Number(c.req.param('seq'));
    const body = await c.req.arrayBuffer();
    if (body.byteLength > 16 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Fragmento demasiado grande.');
    await c.env.MEDIA.put(`org/${s.organization_id}/preview/${s.id}/${seq}.ts`, body, { httpMetadata: { contentType: 'video/mp2t' } });
    let idx = (s.preview_index ? JSON.parse(s.preview_index) : []) as PreviewSeg[];
    // Una sesión nueva reinicia la numeración: se descarta el índice anterior.
    if (idx.length && seq <= idx[idx.length - 1]!.seq) idx = [];
    idx.push({ seq, d, at: Date.now() });
    const drop = idx.slice(0, Math.max(0, idx.length - PREVIEW_WINDOW));
    idx = idx.slice(-PREVIEW_WINDOW);
    await run(c.env.DB, 'UPDATE streams SET preview_index = ? WHERE id = ?', JSON.stringify(idx), s.id);
    // Se borran con un margen (otra ventana) para no quitar un fragmento que un reproductor esté descargando.
    const old = drop.map((x) => x.seq - PREVIEW_WINDOW).filter((n) => n >= 0);
    if (old.length) await c.env.MEDIA.delete(old.map((n) => `org/${s.organization_id}/preview/${s.id}/${n}.ts`)).catch(() => {});
    return c.json({ ok: true });
  });
}

/** Trabajo de exportación pendiente para el motor (lo reclama el bucle de medios). */
export async function claimRecordingExport(env: Env) {
  const now = Date.now();
  const r = await first<{ id: string; export_key: string | null; name: string }>(env.DB,
    `UPDATE recordings SET export_status = 'processing', export_attempts = export_attempts + 1, export_lease_expires_at = ?1
     WHERE id = (SELECT id FROM recordings WHERE (export_status = 'pending' OR (export_status = 'processing' AND export_lease_expires_at < ?2)) AND export_attempts < 3 ORDER BY created_at LIMIT 1)
     RETURNING id, export_key, name`, now + 60 * 60_000, now);
  if (!r) return null;
  const m = /^range:(\d+)-(\d+)$/.exec(r.export_key ?? '');
  const segs = await all<{ seq: number; size_bytes: number }>(env.DB, "SELECT seq, size_bytes FROM recording_segments WHERE recording_id = ? AND status = 'ready' AND seq BETWEEN ? AND ? ORDER BY seq",
    r.id, m ? Number(m[1]) : 0, m ? Number(m[2]) : 1e9);
  return { type: 'recording_export' as const, recordingId: r.id, segments: segs.map((s) => s.seq), totalBytes: segs.reduce((a, s) => a + s.size_bytes, 0) };
}

