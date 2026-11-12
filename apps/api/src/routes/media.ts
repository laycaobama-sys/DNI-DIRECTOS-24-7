import { Hono } from 'hono';
import { UPLOAD_PART_SIZE, uploadIntentSchema } from '@dni/shared';
import { type AppEnv, type Env, HttpError, all, audit, first, newId, notFound, parseBody, run } from '../lib/core';
import { planOf, requireAuth } from './auth';

const ALLOWED_EXT = ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'mp3', 'wav', 'aac', 'm4a', 'png', 'jpg', 'jpeg', 'webp'];

export interface MediaRow {
  id: string; organization_id: string; filename: string; kind: string | null; status: string; size_bytes: number;
  r2_key: string; upload_id: string | null; duration_sec: number | null; width: number | null; height: number | null; fps: number | null;
  video_codec: string | null; audio_codec: string | null; has_audio: number | null; progress: number; error_code: string | null;
  error_message: string | null; created_at: number; sha256: string | null;
}

export const mediaDto = (m: MediaRow & { has_thumb?: number }) => ({
  id: m.id, filename: m.filename, kind: m.kind, status: m.status, sizeBytes: m.size_bytes, durationSec: m.duration_sec,
  width: m.width, height: m.height, fps: m.fps, videoCodec: m.video_codec, audioCodec: m.audio_codec, hasAudio: m.has_audio === null ? null : !!m.has_audio,
  progress: m.progress, error: m.error_code ? { code: m.error_code, message: m.error_message } : null, createdAt: m.created_at,
  hasThumbnail: !!m.has_thumb,
});

/** Nombre solo para mostrar: nunca forma parte de rutas de almacenamiento. */
function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const base = name.replace(/\\/g, '/').split('/').pop()!.replace(/[\u0000-\u001f<>:"|?*]/g, '').trim();
  return base.slice(0, 200) || 'archivo';
}

const getOwned = async (env: Env, orgId: string, id: string) => {
  const m = await first<MediaRow>(env.DB, 'SELECT * FROM media_assets WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', id, orgId);
  if (!m) throw notFound('Archivo');
  return m;
};

export const media = new Hono<AppEnv>();

media.get('/', requireAuth(), async (c) => {
  const { orgId } = c.get('auth');
  const rows = await all<MediaRow & { has_thumb: number }>(c.env.DB,
    `SELECT a.*, EXISTS (SELECT 1 FROM media_variants v WHERE v.media_id = a.id AND v.kind = 'thumbnail' AND v.status = 'ready') AS has_thumb
     FROM media_assets a WHERE a.organization_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at DESC LIMIT 500`, orgId);
  const used = rows.reduce((s, r) => s + r.size_bytes, 0);
  return c.json({ items: rows.map(mediaDto), storage: { usedBytes: used, limitBytes: planOf(c).storageBytes } });
});

media.post('/upload-intents', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const b = await parseBody(c, uploadIntentSchema);
  const plan = planOf(c);
  const filename = sanitizeFilename(b.filename);
  const ext = filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';
  if (!ALLOWED_EXT.includes(ext)) {
    throw new HttpError(422, 'unsupported_format', `Formato .${ext || '?'} no admitido. Formatos válidos: ${ALLOWED_EXT.join(', ')}.`);
  }
  if (b.size > plan.maxUploadBytes) throw new HttpError(413, 'file_too_large', `El archivo supera el máximo de tu plan (${Math.round(plan.maxUploadBytes / 1024 ** 2)} MB).`);
  const used = await first<{ total: number }>(c.env.DB, 'SELECT COALESCE(SUM(size_bytes),0) AS total FROM media_assets WHERE organization_id = ? AND deleted_at IS NULL', orgId);
  if ((used?.total ?? 0) + b.size > plan.storageBytes) {
    throw new HttpError(403, 'quota_storage', 'No queda almacenamiento suficiente en tu plan. Borra archivos o amplía el plan.');
  }
  const id = newId('med');
  const key = `org/${orgId}/media/${id}/original`;
  const mp = await c.env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } });
  const now = Date.now();
  await run(c.env.DB, `INSERT INTO media_assets (id, organization_id, filename, status, size_bytes, content_type, r2_key, upload_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`, id, orgId, filename, 'uploading', b.size, b.contentType ?? null, key, mp.uploadId, now, now);
  return c.json({ mediaId: id, partSize: UPLOAD_PART_SIZE, partCount: Math.max(1, Math.ceil(b.size / UPLOAD_PART_SIZE)) }, 201);
});

/** Partes ya subidas: permite reanudar una carga interrumpida. */
media.get('/:id/parts', requireAuth('editor'), async (c) => {
  const m = await getOwned(c.env, c.get('auth').orgId, c.req.param('id'));
  const parts = await all<{ part_number: number }>(c.env.DB, 'SELECT part_number FROM media_upload_parts WHERE media_id = ? ORDER BY part_number', m.id);
  return c.json({ status: m.status, uploaded: parts.map((p) => p.part_number) });
});

media.put('/:id/parts/:n', requireAuth('editor'), async (c) => {
  const m = await getOwned(c.env, c.get('auth').orgId, c.req.param('id'));
  if (m.status !== 'uploading' || !m.upload_id) throw new HttpError(409, 'upload_not_open', 'Esta carga ya se completó o fue cancelada.');
  const n = Number(c.req.param('n'));
  const partCount = Math.max(1, Math.ceil(m.size_bytes / UPLOAD_PART_SIZE));
  if (!Number.isInteger(n) || n < 1 || n > partCount) throw new HttpError(422, 'invalid_part', 'Número de parte no válido.');
  const expected = n < partCount ? UPLOAD_PART_SIZE : m.size_bytes - UPLOAD_PART_SIZE * (partCount - 1);
  const body = await c.req.arrayBuffer();
  if (body.byteLength !== expected) throw new HttpError(422, 'invalid_part_size', `La parte ${n} debe medir ${expected} bytes (recibidos ${body.byteLength}).`);
  const part = await c.env.MEDIA.resumeMultipartUpload(m.r2_key, m.upload_id).uploadPart(n, body);
  await run(c.env.DB, 'INSERT OR REPLACE INTO media_upload_parts (media_id, part_number, etag, size_bytes) VALUES (?,?,?,?)', m.id, n, part.etag, body.byteLength);
  return c.json({ partNumber: n });
});

media.post('/:id/complete', requireAuth('editor'), async (c) => {
  const m = await getOwned(c.env, c.get('auth').orgId, c.req.param('id'));
  if (m.status !== 'uploading' || !m.upload_id) return c.json(mediaDto(m)); // idempotente
  const parts = await all<{ part_number: number; etag: string; size_bytes: number }>(c.env.DB, 'SELECT * FROM media_upload_parts WHERE media_id = ? ORDER BY part_number', m.id);
  const partCount = Math.max(1, Math.ceil(m.size_bytes / UPLOAD_PART_SIZE));
  if (parts.length !== partCount || parts.reduce((s, p) => s + p.size_bytes, 0) !== m.size_bytes) {
    throw new HttpError(409, 'upload_incomplete', `Faltan partes por subir (${parts.length}/${partCount}).`);
  }
  await c.env.MEDIA.resumeMultipartUpload(m.r2_key, m.upload_id).complete(parts.map((p) => ({ partNumber: p.part_number, etag: p.etag })));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE media_assets SET status = 'queued', upload_id = NULL, updated_at = ? WHERE id = ?").bind(Date.now(), m.id),
    c.env.DB.prepare('DELETE FROM media_upload_parts WHERE media_id = ?').bind(m.id),
  ]);
  await audit(c, 'media.uploaded', m.id, { size: m.size_bytes });
  return c.json(mediaDto({ ...m, status: 'queued' }));
});

media.get('/:id', requireAuth(), async (c) => c.json(mediaDto(await getOwned(c.env, c.get('auth').orgId, c.req.param('id')))));

media.get('/:id/thumbnail', requireAuth(), async (c) => {
  const m = await getOwned(c.env, c.get('auth').orgId, c.req.param('id'));
  const v = await first<{ r2_key: string }>(c.env.DB, "SELECT r2_key FROM media_variants WHERE media_id = ? AND kind = 'thumbnail' AND status = 'ready'", m.id);
  const obj = v && (await c.env.MEDIA.get(v.r2_key));
  if (!obj) throw notFound('Miniatura');
  return new Response(obj.body, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'private, max-age=3600' } });
});

media.post('/:id/retry', requireAuth('editor'), async (c) => {
  const m = await getOwned(c.env, c.get('auth').orgId, c.req.param('id'));
  if (m.status !== 'failed') throw new HttpError(409, 'not_failed', 'Solo se pueden reintentar archivos con error.');
  await run(c.env.DB, "UPDATE media_assets SET status = 'queued', attempts = 0, error_code = NULL, error_message = NULL, progress = 0, updated_at = ? WHERE id = ?", Date.now(), m.id);
  return c.json({ ok: true });
});

media.delete('/:id', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const m = await getOwned(c.env, orgId, c.req.param('id'));
  // Verificación de referencias: borrador o versión publicada vigente de cualquier playlist.
  const refs = await all<{ id: string; name: string }>(c.env.DB,
    `SELECT p.id, p.name FROM playlists p LEFT JOIN playlist_versions pv ON pv.id = p.published_version_id
     WHERE p.organization_id = ?1 AND p.deleted_at IS NULL AND (
       EXISTS (SELECT 1 FROM json_each(p.draft_items) j WHERE json_extract(j.value, '$.mediaId') = ?2)
       OR EXISTS (SELECT 1 FROM json_each(COALESCE(pv.items, '[]')) j WHERE json_extract(j.value, '$.mediaId') = ?2))`, orgId, m.id);
  if (refs.length) {
    throw new HttpError(409, 'media_in_use', `El archivo se usa en ${refs.length} playlist(s): ${refs.map((r) => r.name).join(', ')}. Quítalo de ellas antes de borrarlo.`, { playlists: refs });
  }
  if (m.status === 'uploading' && m.upload_id) await c.env.MEDIA.resumeMultipartUpload(m.r2_key, m.upload_id).abort().catch(() => {});
  const variants = await all<{ r2_key: string }>(c.env.DB, 'SELECT r2_key FROM media_variants WHERE media_id = ?', m.id);
  await c.env.MEDIA.delete([m.r2_key, ...variants.map((v) => v.r2_key)]);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM media_variants WHERE media_id = ?').bind(m.id),
    c.env.DB.prepare('UPDATE media_assets SET deleted_at = ?, updated_at = ? WHERE id = ?').bind(Date.now(), Date.now(), m.id),
  ]);
  await audit(c, 'media.deleted', m.id);
  return c.json({ ok: true });
});
