import { Hono } from 'hono';
import { playlistCreateSchema, playlistUpdateSchema } from '@dni/shared';
import { type AppEnv, type Env, HttpError, all, audit, first, newId, notFound, parseBody, run } from '../lib/core';
import { requireAuth } from './auth';
import { mediaDto, type MediaRow } from './media';

interface PlaylistRow { id: string; organization_id: string; name: string; draft_items: string; published_version_id: string | null; created_at: number; updated_at: number }
type Item = { mediaId: string };

const getOwned = async (env: Env, orgId: string, id: string) => {
  const p = await first<PlaylistRow>(env.DB, 'SELECT * FROM playlists WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', id, orgId);
  if (!p) throw notFound('Playlist');
  return p;
};

async function mediaByIds(env: Env, orgId: string, ids: string[]) {
  const map = new Map<string, MediaRow>();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 50) {
    const chunk = unique.slice(i, i + 50);
    const rows = await all<MediaRow>(env.DB,
      `SELECT * FROM media_assets WHERE organization_id = ? AND deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`, orgId, ...chunk);
    for (const r of rows) map.set(r.id, r);
  }
  return map;
}

async function dto(env: Env, p: PlaylistRow) {
  const items = JSON.parse(p.draft_items) as Item[];
  const map = await mediaByIds(env, p.organization_id, items.map((i) => i.mediaId));
  const pv = p.published_version_id
    ? await first<{ id: string; version: number; items: string; created_at: number }>(env.DB, 'SELECT id, version, items, created_at FROM playlist_versions WHERE id = ?', p.published_version_id)
    : null;
  const expanded = items.filter((i) => map.has(i.mediaId)).map((i) => mediaDto(map.get(i.mediaId)!));
  return {
    id: p.id, name: p.name, items: expanded, totalDurationSec: expanded.reduce((s, m) => s + (m.durationSec ?? 0), 0),
    published: pv ? { versionId: pv.id, version: pv.version, publishedAt: pv.created_at, itemCount: (JSON.parse(pv.items) as Item[]).length } : null,
    hasUnpublishedChanges: !pv || pv.items !== JSON.stringify(items),
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

export const playlists = new Hono<AppEnv>();

playlists.get('/', requireAuth(), async (c) => {
  const rows = await all<PlaylistRow>(c.env.DB, 'SELECT * FROM playlists WHERE organization_id = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 200', c.get('auth').orgId);
  return c.json({ items: await Promise.all(rows.map((r) => dto(c.env, r))) });
});

playlists.post('/', requireAuth('editor'), async (c) => {
  const b = await parseBody(c, playlistCreateSchema);
  const id = newId('pl');
  const now = Date.now();
  await run(c.env.DB, 'INSERT INTO playlists (id, organization_id, name, created_at, updated_at) VALUES (?,?,?,?,?)', id, c.get('auth').orgId, b.name, now, now);
  return c.json(await dto(c.env, (await getOwned(c.env, c.get('auth').orgId, id))), 201);
});

playlists.get('/:id', requireAuth(), async (c) => c.json(await dto(c.env, await getOwned(c.env, c.get('auth').orgId, c.req.param('id')))));

playlists.put('/:id', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const p = await getOwned(c.env, orgId, c.req.param('id'));
  const b = await parseBody(c, playlistUpdateSchema);
  if (b.items) {
    const map = await mediaByIds(c.env, orgId, b.items.map((i) => i.mediaId));
    const missing = b.items.find((i) => !map.has(i.mediaId));
    // Un mediaId de otra organización es indistinguible de uno inexistente.
    if (missing) throw new HttpError(422, 'media_not_found', `El archivo ${missing.mediaId} no existe en tu biblioteca.`);
  }
  await run(c.env.DB, 'UPDATE playlists SET name = ?, draft_items = ?, updated_at = ? WHERE id = ?',
    b.name ?? p.name, b.items ? JSON.stringify(b.items.map((i) => ({ mediaId: i.mediaId }))) : p.draft_items, Date.now(), p.id);
  return c.json(await dto(c.env, await getOwned(c.env, orgId, p.id)));
});

/** Publica una versión inmutable. Los streams en directo la adoptan en el siguiente corte de ítem. */
playlists.post('/:id/publish', requireAuth('editor'), async (c) => {
  const { orgId, userId } = c.get('auth');
  const p = await getOwned(c.env, orgId, c.req.param('id'));
  const items = JSON.parse(p.draft_items) as Item[];
  if (!items.length) throw new HttpError(422, 'playlist_empty', 'Añade al menos un vídeo antes de publicar la playlist.');
  const map = await mediaByIds(c.env, orgId, items.map((i) => i.mediaId));
  const problems = items.map((i) => map.get(i.mediaId)).flatMap((m, idx) => {
    if (!m) return [`#${idx + 1}: archivo eliminado`];
    if (m.status !== 'ready') return [`«${m.filename}»: ${m.status === 'failed' ? 'falló el procesamiento' : 'aún se está procesando'}`];
    if (m.kind !== 'video') return [`«${m.filename}»: solo se admiten vídeos en esta versión`];
    return [];
  });
  if (problems.length) throw new HttpError(422, 'playlist_not_ready', `No se puede publicar: ${problems.join('; ')}.`, { problems });
  const last = await first<{ v: number }>(c.env.DB, 'SELECT COALESCE(MAX(version),0) AS v FROM playlist_versions WHERE playlist_id = ?', p.id);
  const versionId = newId('plv');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO playlist_versions (id, playlist_id, organization_id, version, items, created_by, created_at) VALUES (?,?,?,?,?,?,?)')
      .bind(versionId, p.id, orgId, (last?.v ?? 0) + 1, JSON.stringify(items), userId, Date.now()),
    c.env.DB.prepare('UPDATE playlists SET published_version_id = ?, updated_at = ? WHERE id = ?').bind(versionId, Date.now(), p.id),
  ]);
  await audit(c, 'playlist.published', p.id, { versionId });
  return c.json(await dto(c.env, await getOwned(c.env, orgId, p.id)));
});

playlists.delete('/:id', requireAuth('editor'), async (c) => {
  const { orgId } = c.get('auth');
  const p = await getOwned(c.env, orgId, c.req.param('id'));
  const used = await all<{ name: string }>(c.env.DB, 'SELECT name FROM streams WHERE playlist_id = ? AND organization_id = ? AND deleted_at IS NULL', p.id, orgId);
  if (used.length) throw new HttpError(409, 'playlist_in_use', `La playlist se usa en: ${used.map((u) => u.name).join(', ')}.`);
  await run(c.env.DB, 'UPDATE playlists SET deleted_at = ? WHERE id = ?', Date.now(), p.id);
  return c.json({ ok: true });
});
