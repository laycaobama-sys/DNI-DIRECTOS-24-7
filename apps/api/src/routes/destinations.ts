import { Hono } from 'hono';
import { destinationCreateSchema, destinationUpdateSchema, maskSecret, validateRtmpUrl, validateStreamKey } from '@dni/shared';
import { type AppEnv, type Ctx, type Env, HttpError, all, audit, encryptSecret, first, newId, notFound, parseBody, run } from '../lib/core';
import { requireAuth } from './auth';

export interface DestinationRow {
  id: string; organization_id: string; name: string; platform: string; url: string; secure: number;
  stream_key_enc: string; stream_key_last4: string; key_rotated_at: number; created_at: number; updated_at: number;
  youtube_account_id?: string | null; youtube_broadcast_id?: string | null;
}

/** La clave nunca sale de la API: solo se muestran los últimos 4 caracteres. */
export const destinationDto = (d: DestinationRow) => ({
  id: d.id, name: d.name, platform: d.platform, url: d.url, secure: !!d.secure,
  streamKeyMasked: maskSecret(`xxxx${d.stream_key_last4}`), keyRotatedAt: d.key_rotated_at, createdAt: d.created_at,
  youtube: d.youtube_broadcast_id ? { connected: !!d.youtube_account_id, watchUrl: `https://www.youtube.com/watch?v=${d.youtube_broadcast_id}`, studioUrl: `https://studio.youtube.com/video/${d.youtube_broadcast_id}/livestreaming` } : null,
});

const getOwned = async (env: Env, orgId: string, id: string) => {
  const d = await first<DestinationRow>(env.DB, 'SELECT * FROM destinations WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', id, orgId);
  if (!d) throw notFound('Destino');
  return d;
};

function checkUrl(c: Ctx, url: string, allowInsecure: boolean) {
  const v = validateRtmpUrl(url, { allowPrivate: c.env.ALLOW_PRIVATE_DESTINATIONS === 'true' });
  if (!v.ok) throw new HttpError(422, v.code, v.message);
  if (!v.secure && !allowInsecure) {
    throw new HttpError(422, 'insecure_requires_consent', 'Este destino usa RTMP sin cifrar. Usa rtmps:// o confirma explícitamente que aceptas enviar la clave sin cifrado.');
  }
  return v;
}
function checkKey(key: string) {
  const k = validateStreamKey(key);
  if (!k.ok) throw new HttpError(422, 'invalid_stream_key', k.message);
}

export const destinations = new Hono<AppEnv>();

destinations.get('/', requireAuth(), async (c) => {
  const rows = await all<DestinationRow>(c.env.DB, 'SELECT * FROM destinations WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', c.get('auth').orgId);
  return c.json({ items: rows.map(destinationDto) });
});

destinations.post('/', requireAuth('admin'), async (c) => {
  const { orgId } = c.get('auth');
  const b = await parseBody(c, destinationCreateSchema);
  const v = checkUrl(c, b.url, b.allowInsecure);
  checkKey(b.streamKey);
  const id = newId('dst');
  const now = Date.now();
  await run(c.env.DB, `INSERT INTO destinations (id, organization_id, name, platform, url, secure, stream_key_enc, stream_key_last4, key_rotated_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, id, orgId, b.name, b.platform, v.url, v.secure ? 1 : 0, await encryptSecret(c.env, b.streamKey, id), b.streamKey.slice(-4), now, now, now);
  await audit(c, 'destination.created', id, { platform: b.platform, host: v.host });
  return c.json(destinationDto(await getOwned(c.env, orgId, id)), 201);
});

destinations.patch('/:id', requireAuth('admin'), async (c) => {
  const { orgId } = c.get('auth');
  const d = await getOwned(c.env, orgId, c.req.param('id'));
  const b = await parseBody(c, destinationUpdateSchema);
  const now = Date.now();
  let { url, secure } = d;
  if (b.url !== undefined) {
    const v = checkUrl(c, b.url, b.allowInsecure ?? false);
    url = v.url; secure = v.secure ? 1 : 0;
  }
  let enc = d.stream_key_enc, last4 = d.stream_key_last4, rotated = d.key_rotated_at;
  if (b.streamKey !== undefined) {
    checkKey(b.streamKey);
    enc = await encryptSecret(c.env, b.streamKey, d.id); last4 = b.streamKey.slice(-4); rotated = now;
  }
  await run(c.env.DB, 'UPDATE destinations SET name = ?, url = ?, secure = ?, stream_key_enc = ?, stream_key_last4 = ?, key_rotated_at = ?, updated_at = ? WHERE id = ?',
    b.name ?? d.name, url, secure, enc, last4, rotated, now, d.id);
  await audit(c, b.streamKey !== undefined ? 'destination.key_rotated' : 'destination.updated', d.id);
  return c.json(destinationDto(await getOwned(c.env, orgId, d.id)));
});

destinations.delete('/:id', requireAuth('admin'), async (c) => {
  const { orgId } = c.get('auth');
  const d = await getOwned(c.env, orgId, c.req.param('id'));
  const used = await all<{ name: string }>(c.env.DB,
    "SELECT s.name FROM stream_destinations sd JOIN streams s ON s.id = sd.stream_id WHERE sd.destination_id = ? AND s.deleted_at IS NULL AND s.desired_state = 'running'", d.id);
  if (used.length) throw new HttpError(409, 'destination_in_use', `El destino está emitiendo en: ${used.map((u) => u.name).join(', ')}. Detén esos streams primero.`);
  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM stream_destinations WHERE destination_id = ?').bind(d.id),
    c.env.DB.prepare("UPDATE destinations SET deleted_at = ?, stream_key_enc = '', updated_at = ? WHERE id = ?").bind(Date.now(), Date.now(), d.id),
  ]);
  await audit(c, 'destination.deleted', d.id);
  return c.json({ ok: true });
});
