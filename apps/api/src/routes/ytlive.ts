/**
 * YouTube en directo (API oficial):
 *  - Cada inicio usa un directo de YouTube vigente: si el anterior terminó, se crea uno NUEVO con los mismos datos
 *    (título, descripción, privacidad, «para niños») enlazado a la misma clave. Si sigue abierto, se puede continuar.
 *  - Al detener, el directo de YouTube se finaliza (queda guardado como vídeo) salvo que se pida mantenerlo abierto.
 *  - La miniatura de la emisión se envía sola al directo vigente: al cambiarla y cada vez que YouTube crea un directo nuevo.
 *  - Audiencia: espectadores simultáneos, visualizaciones y «me gusta» cada 5 min mientras se emite.
 *  - Los destinos con clave copiada a mano también se siguen si su canal está conectado: se identifican por la clave.
 * Cuota de la API (10 000 unidades/día por proyecto): list = 1, insert/bind/transition = 50, thumbnails.set = 50.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Env, HttpError, addEvent, all, decryptSecret, first, notFound, run } from '../lib/core';
import { planFor } from '@dni/shared';
import { requireAuth, planOf } from './auth';
import { type YtAccount, accessToken, yt } from './youtube';
import { getStream } from './streams';

const SAMPLE_MS = 5 * 60_000;
const RESOLVE_MS = 30 * 60_000;
const THUMB_RETRY_MS = 60 * 60_000;
const USABLE = new Set(['created', 'ready', 'testStarting', 'testing', 'liveStarting', 'live']);

interface DestRow {
  id: string; organization_id: string; name: string; platform: string; stream_key_enc: string;
  youtube_account_id: string | null; youtube_stream_id: string | null; youtube_broadcast_id: string | null;
  yt_live_video_id: string | null; yt_checked_at: number | null; yt_thumb_video_id: string | null; yt_thumb_attempt_at: number | null;
  youtube_thumbnail_synced_at: number | null; youtube_thumbnail_error: string | null; yt_broadcast_template: string | null;
}
interface Template { title: string; description: string; privacy: string; madeForKids: boolean; dvr: boolean; latency: string }
interface Broadcast {
  id: string;
  snippet?: { title?: string; description?: string };
  status?: { lifeCycleStatus?: string; privacyStatus?: string; selfDeclaredMadeForKids?: boolean; madeForKids?: boolean };
  contentDetails?: { boundStreamId?: string; enableDvr?: boolean; latencyPreference?: string };
}

/** Tokens por cuenta durante una pasada (una cuenta, un refresh). */
type Tokens = Map<string, Promise<string>>;
async function tokenFor(env: Env, accountId: string, orgId: string, cache: Tokens): Promise<string> {
  let t = cache.get(accountId);
  if (!t) {
    t = (async () => {
      const acc = await first<YtAccount>(env.DB, 'SELECT * FROM youtube_accounts WHERE id = ? AND organization_id = ?', accountId, orgId);
      if (!acc) throw new HttpError(409, 'youtube_disconnected', 'El canal de YouTube ya no está conectado.');
      return accessToken(env, acc);
    })();
    cache.set(accountId, t);
  }
  return t;
}

const destCols = `d.id, d.organization_id, d.name, d.platform, d.stream_key_enc, d.youtube_account_id, d.youtube_stream_id, d.youtube_broadcast_id,
  d.yt_live_video_id, d.yt_checked_at, d.yt_thumb_video_id, d.yt_thumb_attempt_at, d.youtube_thumbnail_synced_at, d.youtube_thumbnail_error, d.yt_broadcast_template`;
const streamYoutubeDests = (env: Env, streamId: string) => all<DestRow>(env.DB,
  `SELECT ${destCols} FROM stream_destinations sd JOIN destinations d ON d.id = sd.destination_id
   WHERE sd.stream_id = ? AND d.deleted_at IS NULL AND (d.platform = 'youtube' OR d.youtube_account_id IS NOT NULL)`, streamId);

async function getBroadcast(token: string, id: string): Promise<Broadcast | null> {
  const r = await yt<{ items?: Broadcast[] }>(token, 'GET', `liveBroadcasts?part=id,snippet,status,contentDetails&id=${encodeURIComponent(id)}`);
  return r.items?.[0] ?? null;
}

const templateOf = (b: Broadcast, fallbackTitle: string): Template => ({
  title: (b.snippet?.title || fallbackTitle).slice(0, 100),
  description: (b.snippet?.description ?? '').slice(0, 4900),
  privacy: b.status?.privacyStatus ?? 'public',
  madeForKids: !!(b.status?.selfDeclaredMadeForKids ?? b.status?.madeForKids),
  dvr: b.contentDetails?.enableDvr ?? true,
  latency: b.contentDetails?.latencyPreference ?? 'normal',
});

/**
 * Vincula un destino de YouTube con clave copiada a mano al canal conectado que tiene esa clave (liveStreams del canal).
 * Solo lee: no cambia nada en YouTube. Devuelve true si lo encontró.
 */
async function linkManualKey(env: Env, d: DestRow, cache: Tokens): Promise<boolean> {
  if (d.youtube_stream_id) return true;
  const accounts = await all<{ id: string }>(env.DB, 'SELECT id FROM youtube_accounts WHERE organization_id = ?', d.organization_id);
  if (!accounts.length) return false;
  let key: string;
  try { key = await decryptSecret(env, d.stream_key_enc, d.id); } catch { return false; }
  for (const acc of accounts) {
    const token = await tokenFor(env, acc.id, d.organization_id, cache).catch(() => null);
    if (!token) continue;
    let page = '';
    for (let i = 0; i < 4; i++) {
      const r = await yt<{ items?: { id: string; cdn?: { ingestionInfo?: { streamName?: string } } }[]; nextPageToken?: string }>(token, 'GET',
        `liveStreams?part=id,cdn&mine=true&maxResults=50${page ? `&pageToken=${page}` : ''}`);
      const hit = r.items?.find((s) => s.cdn?.ingestionInfo?.streamName === key);
      if (hit) {
        await run(env.DB, 'UPDATE destinations SET youtube_account_id = ?, youtube_stream_id = ? WHERE id = ?', acc.id, hit.id, d.id);
        d.youtube_account_id = acc.id; d.youtube_stream_id = hit.id;
        return true;
      }
      if (!r.nextPageToken) break;
      page = r.nextPageToken;
    }
  }
  return false;
}

/** Directo de YouTube enlazado ahora a la clave (también el persistente de «Emitir» de YouTube Studio). */
async function boundBroadcast(token: string, streamId: string): Promise<Broadcast | null> {
  for (const status of ['active', 'upcoming'] as const) {
    const r = await yt<{ items?: Broadcast[] }>(token, 'GET', `liveBroadcasts?part=id,snippet,status,contentDetails&broadcastStatus=${status}&broadcastType=all&maxResults=50`);
    const hit = r.items?.find((b) => b.contentDetails?.boundStreamId === streamId);
    if (hit) return hit;
  }
  return null;
}

async function createBroadcast(env: Env, d: DestRow, token: string, t: Template): Promise<string> {
  const b = await yt<{ id: string }>(token, 'POST', 'liveBroadcasts?part=snippet,status,contentDetails', {
    snippet: { title: t.title, description: t.description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() },
    status: { privacyStatus: t.privacy, selfDeclaredMadeForKids: t.madeForKids },
    contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: t.dvr, latencyPreference: t.latency, monitorStream: { enableMonitorStream: false } },
  });
  await yt(token, 'POST', `liveBroadcasts/bind?id=${b.id}&part=id,contentDetails&streamId=${d.youtube_stream_id}`);
  await run(env.DB, 'UPDATE destinations SET youtube_broadcast_id = ?, yt_live_video_id = ?, yt_thumb_video_id = NULL, yt_thumb_attempt_at = NULL, yt_broadcast_template = ?, updated_at = updated_at WHERE id = ?',
    b.id, b.id, JSON.stringify(t), d.id);
  return b.id;
}

export type YoutubeStartMode = 'auto' | 'new' | 'continue';

/**
 * Antes de emitir: cada destino creado con «YouTube con un clic» queda con un directo de YouTube vigente.
 * auto: continúa si el anterior sigue abierto y crea uno nuevo si terminó · new: siempre uno nuevo · continue: el mismo si se puede.
 * Nunca bloquea el inicio: los fallos quedan como avisos en el registro de la emisión.
 */
export async function prepareYoutubeBroadcasts(env: Env, s: { id: string; organization_id: string; name: string }, mode: YoutubeStartMode = 'auto') {
  const notes: { destinationId: string; action: 'continued' | 'created' | 'error'; broadcastId?: string; message: string }[] = [];
  const cache: Tokens = new Map();
  for (const d of await streamYoutubeDests(env, s.id)) {
    if (!d.youtube_broadcast_id || !d.youtube_account_id || !d.youtube_stream_id) continue; // sin directo gestionado por la plataforma
    try {
      const token = await tokenFor(env, d.youtube_account_id, d.organization_id, cache);
      const prev = await getBroadcast(token, d.youtube_broadcast_id).catch(() => null);
      const life = prev?.status?.lifeCycleStatus ?? 'missing';
      const template = prev ? templateOf(prev, s.name) : (d.yt_broadcast_template ? JSON.parse(d.yt_broadcast_template) as Template : templateOf({ id: '' }, s.name));
      if (prev) await run(env.DB, 'UPDATE destinations SET yt_broadcast_template = ? WHERE id = ?', JSON.stringify(template), d.id);
      if (mode !== 'new' && USABLE.has(life)) {
        notes.push({ destinationId: d.id, action: 'continued', broadcastId: d.youtube_broadcast_id, message: `«${d.name}»: continúa el mismo directo de YouTube.` });
        continue;
      }
      if (mode === 'new' && (life === 'live' || life === 'testing')) {
        await yt(token, 'POST', `liveBroadcasts/transition?broadcastStatus=complete&id=${d.youtube_broadcast_id}&part=status`).catch(() => null);
      }
      const id = await createBroadcast(env, d, token, template);
      const why = mode === 'new' ? 'a petición' : life === 'missing' ? 'el anterior ya no existe' : 'el anterior había terminado';
      notes.push({ destinationId: d.id, action: 'created', broadcastId: id, message: `«${d.name}»: nuevo directo creado en YouTube (${why}): https://www.youtube.com/watch?v=${id}` });
    } catch (e) {
      notes.push({ destinationId: d.id, action: 'error', message: `«${d.name}»: no se pudo preparar el directo de YouTube: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  for (const n of notes) {
    await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: n.action === 'error' ? 'youtube_broadcast_error' : n.action === 'created' ? 'youtube_broadcast_created' : 'youtube_broadcast_continued',
      level: n.action === 'error' ? 'warn' : 'info', message: n.message, data: n.broadcastId ? { destinationId: n.destinationId, broadcastId: n.broadcastId } : { destinationId: n.destinationId } });
  }
  return notes;
}

/** Al detener: finaliza en YouTube los directos gestionados por la plataforma (YouTube los guarda como vídeo). */
export async function endYoutubeBroadcasts(env: Env, s: { id: string; organization_id: string }) {
  const cache: Tokens = new Map();
  for (const d of await streamYoutubeDests(env, s.id)) {
    if (!d.youtube_broadcast_id || !d.youtube_account_id) continue;
    try {
      const token = await tokenFor(env, d.youtube_account_id, d.organization_id, cache);
      const b = await getBroadcast(token, d.youtube_broadcast_id);
      const life = b?.status?.lifeCycleStatus;
      if (life !== 'live' && life !== 'testing') continue;
      await yt(token, 'POST', `liveBroadcasts/transition?broadcastStatus=complete&id=${d.youtube_broadcast_id}&part=status`);
      await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: 'youtube_broadcast_ended', message: `«${d.name}»: directo finalizado en YouTube; queda guardado en tu canal.` });
    } catch (e) {
      await addEvent(env.DB, { streamId: s.id, orgId: s.organization_id, type: 'youtube_broadcast_error', level: 'warn', message: `«${d.name}»: no se pudo finalizar el directo en YouTube: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
}

/** Vídeo de YouTube que recibe ahora la señal del destino (y lo recuerda). null si YouTube aún no lo ha creado. */
async function liveVideo(env: Env, d: DestRow, cache: Tokens, force = false): Promise<{ token: string; videoId: string } | null> {
  if (!(await linkManualKey(env, d, cache)) || !d.youtube_account_id || !d.youtube_stream_id) return null;
  const token = await tokenFor(env, d.youtube_account_id, d.organization_id, cache);
  let vid = d.yt_live_video_id;
  if (!vid || force) {
    const b = await boundBroadcast(token, d.youtube_stream_id);
    vid = b?.id ?? d.youtube_broadcast_id ?? null;
    if (vid !== d.yt_live_video_id) { await run(env.DB, 'UPDATE destinations SET yt_live_video_id = ? WHERE id = ?', vid, d.id); d.yt_live_video_id = vid; }
  }
  return vid ? { token, videoId: vid } : null;
}

async function uploadThumbnail(env: Env, token: string, videoId: string, key: string) {
  const obj = await env.MEDIA.get(key);
  if (!obj) throw new Error('No se encontró la miniatura guardada.');
  const type = obj.httpMetadata?.contentType ?? 'image/jpeg';
  if (type === 'image/webp') throw new Error('YouTube solo acepta JPG o PNG como miniatura. Vuelve a guardarla desde el estudio de miniaturas.');
  const res = await fetch(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type }, body: await obj.arrayBuffer(),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { message?: string; errors?: { reason?: string }[] } } | null;
    const reason = j?.error?.errors?.[0]?.reason;
    throw new Error(reason === 'forbidden' || /verif|permission/i.test(j?.error?.message ?? '')
      ? 'YouTube no permite miniaturas personalizadas en este canal: verifica tu cuenta con el teléfono en youtube.com/verify.'
      : reason === 'quotaExceeded' ? 'Cuota diaria de la API de YouTube agotada. Se reintentará automáticamente.'
      : `YouTube respondió: ${j?.error?.message ?? res.status}`);
  }
}

export interface ThumbResult { destinationId: string; name: string; ok: boolean; pending?: boolean; videoId?: string; error?: string }

async function syncDestThumbnail(env: Env, d: DestRow, key: string, cache: Tokens, force: boolean): Promise<ThumbResult> {
  const lv = await liveVideo(env, d, cache, force);
  if (!lv) {
    return { destinationId: d.id, name: d.name, ok: false, pending: true,
      error: d.youtube_stream_id ? 'Se enviará sola en cuanto YouTube cree el directo.' : 'Conecta en «Destinos» el canal de YouTube dueño de esta clave para enviarle la miniatura sola.' };
  }
  const now = Date.now();
  try {
    await uploadThumbnail(env, lv.token, lv.videoId, key);
    await run(env.DB, 'UPDATE destinations SET youtube_thumbnail_synced_at = ?, youtube_thumbnail_error = NULL, yt_thumb_video_id = ?, yt_thumb_attempt_at = ? WHERE id = ?', now, lv.videoId, now, d.id);
    return { destinationId: d.id, name: d.name, ok: true, videoId: lv.videoId };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    await run(env.DB, 'UPDATE destinations SET youtube_thumbnail_error = ?, yt_thumb_attempt_at = ? WHERE id = ?', msg, now, d.id);
    return { destinationId: d.id, name: d.name, ok: false, videoId: lv.videoId, error: msg };
  }
}

/** Envío inmediato (al guardar o cambiar la miniatura de la emisión). */
export async function syncYoutubeThumbnail(env: Env, orgId: string, streamId: string): Promise<ThumbResult[]> {
  const s = await first<{ thumbnail_key: string | null }>(env.DB, 'SELECT thumbnail_key FROM streams WHERE id = ? AND organization_id = ?', streamId, orgId);
  if (!s) throw notFound('Stream');
  if (!s.thumbnail_key) throw new HttpError(422, 'no_thumbnail', 'Primero añade una miniatura a la emisión.');
  const dests = await streamYoutubeDests(env, streamId);
  if (!dests.length) throw new HttpError(422, 'no_youtube_destination', 'Esta emisión no tiene destinos de YouTube.');
  const cache: Tokens = new Map();
  const out: ThumbResult[] = [];
  for (const d of dests) out.push(await syncDestThumbnail(env, d, s.thumbnail_key, cache, true).catch((e) => ({ destinationId: d.id, name: d.name, ok: false, error: e instanceof Error ? e.message : String(e) })));
  return out;
}

/**
 * Cron (cada minuto): para cada emisión en el aire con destinos de YouTube y canal conectado,
 * mide la audiencia cada 5 min y mantiene la miniatura en el directo vigente.
 */
export async function youtubeMonitor(env: Env, now = Date.now()) {
  const rows = await all<DestRow & { stream_id: string; thumbnail_key: string | null; thumbnail_updated_at: number | null; started_at: number | null; status: string; plan: string }>(env.DB,
    `SELECT ${destCols}, s.id AS stream_id, s.thumbnail_key, s.thumbnail_updated_at, s.started_at, s.status, (SELECT plan FROM organizations o WHERE o.id = s.organization_id) AS plan
     FROM streams s JOIN stream_destinations sd ON sd.stream_id = s.id JOIN destinations d ON d.id = sd.destination_id
     WHERE s.desired_state = 'running' AND s.deleted_at IS NULL AND d.deleted_at IS NULL AND (d.platform = 'youtube' OR d.youtube_account_id IS NOT NULL)
       AND EXISTS (SELECT 1 FROM youtube_accounts y WHERE y.organization_id = s.organization_id)
     ORDER BY d.yt_checked_at IS NOT NULL, d.yt_checked_at LIMIT 40`);
  const cache: Tokens = new Map();
  let done = 0;
  for (const d of rows) {
    if (done >= 15) break; // reparto de la cuota y del tiempo de CPU entre pasadas
    const sinceStart = now - (d.started_at ?? now);
    // Miniatura pendiente (cambiada o directo nuevo). Tras un fallo se reintenta cada hora para no gastar cuota.
    const canTryThumb = now - (d.yt_thumb_attempt_at ?? 0) >= (d.youtube_thumbnail_error ? THUMB_RETRY_MS : 60_000);
    const thumbChanged = !!d.thumbnail_key && (d.thumbnail_updated_at ?? 0) > (d.youtube_thumbnail_synced_at ?? 0);
    // Recién iniciada: cada minuto hasta encontrar el directo; después, cada 5 min.
    const early = sinceStart < 20 * 60_000;
    const interval = !d.yt_live_video_id && early ? 60_000 : SAMPLE_MS;
    if (!(thumbChanged && canTryThumb) && d.yt_checked_at && now - d.yt_checked_at < interval) continue;
    // Reclamo condicional: dos ejecuciones del cron no consultan el mismo destino a la vez.
    const claimed = await run(env.DB, 'UPDATE destinations SET yt_checked_at = ? WHERE id = ? AND COALESCE(yt_checked_at, 0) = ?', now, d.id, d.yt_checked_at ?? 0);
    if (!claimed.meta.changes) continue;
    done++;
    try {
      // El directo vigente se vuelve a buscar al empezar, cada 30 min (YouTube puede crear otro) y cuando termina.
      const reResolve = !d.yt_live_video_id || early || Math.floor(now / RESOLVE_MS) !== Math.floor((d.yt_checked_at ?? 0) / RESOLVE_MS);
      const lv = await liveVideo(env, d, cache, reResolve);
      if (!lv) continue;
      const v = await yt<{ items?: { liveStreamingDetails?: { concurrentViewers?: string; actualEndTime?: string }; statistics?: { viewCount?: string; likeCount?: string } }[] }>(lv.token, 'GET',
        `videos?part=liveStreamingDetails,statistics&id=${lv.videoId}`);
      const it = v.items?.[0];
      if (it && !it.liveStreamingDetails?.actualEndTime && planFor(d.plan).audience) {
        const at = Math.floor(now / 60_000) * 60_000;
        await run(env.DB, 'INSERT OR REPLACE INTO stream_metrics (stream_id, destination_id, organization_id, at, video_id, viewers, views, likes) VALUES (?,?,?,?,?,?,?,?)',
          d.stream_id, d.id, d.organization_id, at, lv.videoId,
          it.liveStreamingDetails?.concurrentViewers !== undefined ? Number(it.liveStreamingDetails.concurrentViewers) : 0,
          it.statistics?.viewCount !== undefined ? Number(it.statistics.viewCount) : null, it.statistics?.likeCount !== undefined ? Number(it.statistics.likeCount) : null);
      } else if (it?.liveStreamingDetails?.actualEndTime) {
        await run(env.DB, 'UPDATE destinations SET yt_live_video_id = NULL WHERE id = ?', d.id); // terminó: se busca el siguiente
      }
      if (d.thumbnail_key && canTryThumb && (thumbChanged || lv.videoId !== d.yt_thumb_video_id)) {
        const r = await syncDestThumbnail(env, d, d.thumbnail_key, cache, false);
        if (r.ok) await addEvent(env.DB, { streamId: d.stream_id, orgId: d.organization_id, type: 'youtube_thumbnail_synced', message: `Miniatura enviada a YouTube («${d.name}»).` });
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: 'youtube monitor', destination: d.id, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  await env.DB.prepare('DELETE FROM stream_metrics WHERE at < ?').bind(now - 90 * 86_400_000).run();
  return done;
}

// ───────────────────────── API pública ─────────────────────────
export const ytlive = new Hono<AppEnv>();

/** Estado de los directos de YouTube de la emisión antes de iniciarla (para elegir continuar o crear uno nuevo). */
ytlive.get('/:id/youtube-session', requireAuth(), async (c) => {
  const s = await getStream(c.env, c.get('auth').orgId, c.req.param('id'));
  const cache: Tokens = new Map();
  const items = [];
  for (const d of await streamYoutubeDests(c.env, s.id)) {
    if (!d.youtube_broadcast_id || !d.youtube_account_id) { items.push({ destinationId: d.id, name: d.name, managed: false }); continue; }
    try {
      const token = await tokenFor(c.env, d.youtube_account_id, d.organization_id, cache);
      const b = await getBroadcast(token, d.youtube_broadcast_id);
      const life = b?.status?.lifeCycleStatus ?? 'missing';
      items.push({ destinationId: d.id, name: d.name, managed: true, broadcastId: d.youtube_broadcast_id, title: b?.snippet?.title ?? null, lifeCycle: life, reusable: USABLE.has(life),
        watchUrl: `https://www.youtube.com/watch?v=${d.youtube_broadcast_id}` });
    } catch (e) {
      items.push({ destinationId: d.id, name: d.name, managed: true, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return c.json({ items });
});

const RANGES = { '6h': 6 * 3600_000, '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 } as const;

/** Audiencia de una emisión: valor actual, pico, media, horas vistas estimadas y serie temporal. */
ytlive.get('/:id/audience', requireAuth(), async (c) => {
  const { orgId } = c.get('auth');
  const s = await getStream(c.env, orgId, c.req.param('id'));
  const range = (c.req.query('range') ?? '24h') as keyof typeof RANGES;
  const span = RANGES[range] ?? RANGES['24h'];
  const now = Date.now();
  const bucket = span <= RANGES['24h'] ? 5 * 60_000 : span <= RANGES['7d'] ? 3600_000 : 6 * 3600_000;
  const linked = await first<{ n: number }>(c.env.DB, 'SELECT COUNT(*) AS n FROM youtube_accounts WHERE organization_id = ?', orgId);
  const [series, stats, latest] = await Promise.all([
    all<{ t: number; viewers: number; views: number | null; likes: number | null }>(c.env.DB,
      `SELECT (at / ?1) * ?1 AS t, MAX(viewers) AS viewers, MAX(views) AS views, MAX(likes) AS likes FROM
         (SELECT at, SUM(viewers) AS viewers, SUM(views) AS views, SUM(likes) AS likes FROM stream_metrics WHERE stream_id = ?2 AND at >= ?3 GROUP BY at)
       GROUP BY t ORDER BY t`, bucket, s.id, now - span),
    first<{ peak: number | null; avg: number | null; samples: number; viewerMinutes: number | null }>(c.env.DB,
      `SELECT MAX(v) AS peak, AVG(v) AS avg, COUNT(*) AS samples, SUM(v) * 5 AS viewerMinutes FROM
         (SELECT at, SUM(viewers) AS v FROM stream_metrics WHERE stream_id = ? AND at >= ? GROUP BY at)`, s.id, now - span),
    all<{ destination_id: string; name: string; at: number; viewers: number; views: number | null; likes: number | null; video_id: string | null }>(c.env.DB,
      `SELECT m.destination_id, d.name, m.at, m.viewers, m.views, m.likes, m.video_id FROM stream_metrics m JOIN destinations d ON d.id = m.destination_id
       WHERE m.stream_id = ? AND m.at = (SELECT MAX(at) FROM stream_metrics x WHERE x.stream_id = m.stream_id AND x.destination_id = m.destination_id)`, s.id),
  ]);
  const fresh = latest.filter((l) => now - l.at < 15 * 60_000);
  return c.json({
    available: planOf(c).audience,
    connected: (linked?.n ?? 0) > 0,
    range, bucketMs: bucket,
    current: fresh.length ? { viewers: fresh.reduce((a, l) => a + l.viewers, 0), at: Math.max(...fresh.map((l) => l.at)) } : null,
    peak: stats?.peak ?? null, average: stats?.avg ?? null, watchHours: stats?.viewerMinutes ? stats.viewerMinutes / 60 : 0,
    destinations: latest.map((l) => ({ destinationId: l.destination_id, name: l.name, viewers: l.viewers, views: l.views, likes: l.likes, at: l.at, live: now - l.at < 15 * 60_000,
      watchUrl: l.video_id ? `https://www.youtube.com/watch?v=${l.video_id}` : null })),
    series: series.map((p) => ({ at: p.t, viewers: p.viewers, views: p.views, likes: p.likes })),
  });
});

/** Fuerza el envío de la miniatura a YouTube (también lo hace solo al guardarla y en cada directo nuevo). */
ytlive.post('/:id/youtube-thumbnail', requireAuth('editor'), async (c) => {
  const s = await getStream(c.env, c.get('auth').orgId, c.req.param('id'));
  return c.json({ results: await syncYoutubeThumbnail(c.env, c.get('auth').orgId, s.id) });
});

export const startBodySchema = z.object({ youtube: z.enum(['auto', 'new', 'continue']).default('auto') }).default({ youtube: 'auto' });
export const stopBodySchema = z.object({ endYoutube: z.boolean().default(true) }).default({ endYoutube: true });
