/**
 * Integración oficial con YouTube (YouTube Data API v3, OAuth 2.0).
 * El usuario conecta su canal con Google y la plataforma crea por él la emisión en YouTube: un liveStream
 * reutilizable (da la URL de ingesta y la clave) y un liveBroadcast enlazado con inicio automático. Así no hay
 * que copiar claves desde YouTube Studio. Requiere YouTube Data API v3 habilitada en el proyecto de Google.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { type AppEnv, type Env, HttpError, all, audit, decryptSecret, encryptSecret, first, newId, notFound, parseBody, run } from '../lib/core';
import { googleCredentials } from '../lib/settings';
import { requireAuth, startGoogle } from './auth';
import { destinationDto, type DestinationRow } from './destinations';

interface YtAccount { id: string; organization_id: string; channel_id: string; channel_title: string; channel_thumbnail: string | null; refresh_token_enc: string; created_at: number }

async function accessToken(env: Env, acc: YtAccount): Promise<string> {
  const creds = await googleCredentials(env);
  if (!creds) throw new HttpError(503, 'google_not_configured', 'El acceso con Google no está configurado.');
  let refresh: string;
  try { refresh = await decryptSecret(env, acc.refresh_token_enc, acc.id); } catch {
    throw new HttpError(409, 'youtube_reconnect', 'El acceso a este canal ya no es válido. Desconéctalo y vuelve a conectarlo con Google.');
  }
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: creds.clientId, client_secret: creds.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' }),
  });
  const j = (await res.json().catch(() => null)) as { access_token?: string; error?: string } | null;
  if (!res.ok || !j?.access_token) {
    throw new HttpError(409, 'youtube_reconnect', j?.error === 'invalid_grant' ? 'YouTube revocó el acceso a este canal. Vuelve a conectarlo.' : 'No se pudo obtener acceso a YouTube. Vuelve a conectar el canal.');
  }
  return j.access_token;
}

async function yt<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}`, {
    method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined,
  });
  const j = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; errors?: { reason?: string }[] } };
  if (!res.ok) {
    const reason = j.error?.errors?.[0]?.reason ?? '';
    const msg = reason === 'liveStreamingNotEnabled' ? 'Tu canal no tiene activadas las emisiones en directo. Actívalas en YouTube Studio (puede tardar 24 h la primera vez).'
      : reason === 'quotaExceeded' ? 'Se agotó la cuota diaria de la API de YouTube. Inténtalo mañana o usa la clave de emisión manual.'
      : /has not been used|disabled/i.test(j.error?.message ?? '') ? 'La API de YouTube no está habilitada en el proyecto de Google. Actívala en Google Cloud Console.'
      : `YouTube respondió: ${j.error?.message ?? res.status}`;
    throw new HttpError(422, `youtube_${reason || 'error'}`, msg);
  }
  return j;
}

const accountDto = (a: YtAccount) => ({ id: a.id, channelId: a.channel_id, title: a.channel_title, thumbnail: a.channel_thumbnail, connectedAt: a.created_at });

export const youtube = new Hono<AppEnv>();

youtube.get('/start', requireAuth('admin'), (c) => startGoogle(c, 'youtube', c.get('auth').orgId));

youtube.get('/accounts', requireAuth(), async (c) => {
  const rows = await all<YtAccount>(c.env.DB, 'SELECT * FROM youtube_accounts WHERE organization_id = ? ORDER BY created_at', c.get('auth').orgId);
  return c.json({ items: rows.map(accountDto), available: !!(await googleCredentials(c.env)) });
});

youtube.delete('/accounts/:id', requireAuth('admin'), async (c) => {
  const acc = await first<YtAccount>(c.env.DB, 'SELECT * FROM youtube_accounts WHERE id = ? AND organization_id = ?', c.req.param('id'), c.get('auth').orgId);
  if (!acc) throw notFound('Canal');
  // Revoca el acceso en Google (si falla, el token se borra igualmente).
  try { await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(await decryptSecret(c.env, acc.refresh_token_enc, acc.id))}`, { method: 'POST' }); } catch { /* ignorado */ }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE destinations SET youtube_account_id = NULL WHERE youtube_account_id = ?').bind(acc.id),
    c.env.DB.prepare('DELETE FROM youtube_accounts WHERE id = ?').bind(acc.id),
  ]);
  await audit(c, 'youtube.disconnected', acc.id);
  return c.json({ ok: true });
});

const broadcastSchema = z.object({
  title: z.string().trim().min(1, 'El título es obligatorio.').max(100),
  description: z.string().max(4900).default(''),
  privacy: z.enum(['public', 'unlisted', 'private']).default('public'),
  madeForKids: z.boolean().default(false),
  name: z.string().trim().min(1).max(120).optional(),
});

/** Crea en YouTube la emisión (stream + broadcast enlazados) y la guarda como destino listo para usar. */
youtube.post('/accounts/:id/destination', requireAuth('admin'), async (c) => {
  const { orgId } = c.get('auth');
  const acc = await first<YtAccount>(c.env.DB, 'SELECT * FROM youtube_accounts WHERE id = ? AND organization_id = ?', c.req.param('id'), orgId);
  if (!acc) throw notFound('Canal');
  const b = await parseBody(c, broadcastSchema);
  const token = await accessToken(c.env, acc);
  const stream = await yt<{ id: string; cdn: { ingestionInfo: { ingestionAddress: string; rtmpsIngestionAddress?: string; streamName: string } } }>(token, 'POST', 'liveStreams?part=snippet,cdn,contentDetails', {
    snippet: { title: `${b.title.slice(0, 80)} · DNI Directos` },
    cdn: { ingestionType: 'rtmp', resolution: 'variable', frameRate: 'variable' },
    contentDetails: { isReusable: true },
  });
  const broadcast = await yt<{ id: string }>(token, 'POST', 'liveBroadcasts?part=snippet,status,contentDetails', {
    snippet: { title: b.title, description: b.description, scheduledStartTime: new Date(Date.now() + 60_000).toISOString() },
    status: { privacyStatus: b.privacy, selfDeclaredMadeForKids: b.madeForKids },
    // Inicio automático al llegar la señal; sin parada automática para que un corte breve no cierre el directo 24/7.
    contentDetails: { enableAutoStart: true, enableAutoStop: false, enableDvr: true, latencyPreference: 'normal', monitorStream: { enableMonitorStream: false } },
  });
  await yt(token, 'POST', `liveBroadcasts/bind?id=${broadcast.id}&part=id,contentDetails&streamId=${stream.id}`);
  const info = stream.cdn.ingestionInfo;
  const url = (info.rtmpsIngestionAddress ?? info.ingestionAddress).replace(/\/+$/, '');
  const id = newId('dst');
  const now = Date.now();
  await run(c.env.DB, `INSERT INTO destinations (id, organization_id, name, platform, url, secure, stream_key_enc, stream_key_last4, key_rotated_at, youtube_account_id, youtube_stream_id, youtube_broadcast_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, id, orgId, b.name ?? `YouTube · ${acc.channel_title}`.slice(0, 120), 'youtube', url, url.startsWith('rtmps') ? 1 : 0,
    await encryptSecret(c.env, info.streamName, id), info.streamName.slice(-4), now, acc.id, stream.id, broadcast.id, now, now);
  await audit(c, 'youtube.destination_created', id, { channel: acc.channel_id, broadcast: broadcast.id });
  const row = await first<DestinationRow>(c.env.DB, 'SELECT * FROM destinations WHERE id = ?', id);
  return c.json({ destination: destinationDto(row!), watchUrl: `https://www.youtube.com/watch?v=${broadcast.id}`, studioUrl: `https://studio.youtube.com/video/${broadcast.id}/livestreaming` }, 201);
});

interface DestYt { id: string; organization_id: string; youtube_account_id: string | null; youtube_stream_id: string | null; youtube_broadcast_id: string | null }

/** Estado real en YouTube (API oficial): si YouTube está recibiendo la señal y si el directo está emitiéndose. */
export async function youtubeStatus(env: Env, d: DestYt) {
  if (!d.youtube_account_id || !d.youtube_stream_id) return null;
  const acc = await first<YtAccount>(env.DB, 'SELECT * FROM youtube_accounts WHERE id = ? AND organization_id = ?', d.youtube_account_id, d.organization_id);
  if (!acc) return null;
  const token = await accessToken(env, acc);
  const s = await yt<{ items?: { status?: { streamStatus?: string; healthStatus?: { status?: string; configurationIssues?: { type?: string; severity?: string; description?: string }[] } } }[] }>(token, 'GET', `liveStreams?part=status&id=${d.youtube_stream_id}`);
  const b = d.youtube_broadcast_id
    ? await yt<{ items?: { status?: { lifeCycleStatus?: string; privacyStatus?: string } }[] }>(token, 'GET', `liveBroadcasts?part=status&id=${d.youtube_broadcast_id}`)
    : { items: [] };
  const st = s.items?.[0]?.status;
  return {
    streamStatus: st?.streamStatus ?? null,
    health: st?.healthStatus?.status ?? null,
    issues: (st?.healthStatus?.configurationIssues ?? []).slice(0, 5).map((i) => ({ type: i.type, severity: i.severity, description: i.description })),
    broadcast: b.items?.[0]?.status?.lifeCycleStatus ?? null,
    privacy: b.items?.[0]?.status?.privacyStatus ?? null,
    checkedAt: Date.now(),
  };
}

youtube.get('/destinations/:id/status', requireAuth(), async (c) => {
  const d = await first<DestYt>(c.env.DB, 'SELECT id, organization_id, youtube_account_id, youtube_stream_id, youtube_broadcast_id FROM destinations WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', c.req.param('id'), c.get('auth').orgId);
  if (!d) throw notFound('Destino');
  return c.json({ status: await youtubeStatus(c.env, d) });
});
