import type { PLANS } from '@dni/shared';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}

export async function api<T = any>(method: string, path: string, body?: unknown, raw?: Blob): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: 'include',
      headers: { 'x-requested-with': 'dni-web', ...(raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'network', 'No hay conexión con el servidor. Comprueba tu red e inténtalo de nuevo.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json?.error?.code ?? 'http_error', json?.error?.message ?? `Error ${res.status}`, json?.error?.details);
  return json as T;
}
export const get = <T = any>(p: string) => api<T>('GET', p);

/** Subida multipart reanudable: consulta las partes ya subidas y solo envía las que faltan. */
export async function uploadFile(file: File, onProgress: (pct: number) => void, resumeId?: string): Promise<string> {
  const intent = resumeId
    ? { mediaId: resumeId, partSize: 8 * 1024 * 1024, partCount: Math.max(1, Math.ceil(file.size / (8 * 1024 * 1024))) }
    : await api<{ mediaId: string; partSize: number; partCount: number }>('POST', '/v1/media/upload-intents', { filename: file.name, size: file.size, contentType: file.type || undefined });
  const done = new Set<number>(resumeId ? (await get<{ uploaded: number[] }>(`/v1/media/${intent.mediaId}/parts`)).uploaded : []);
  const pending = Array.from({ length: intent.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  let finished = done.size;
  onProgress(Math.round((finished / intent.partCount) * 100));
  const worker = async () => {
    for (let n = pending.shift(); n !== undefined; n = pending.shift()) {
      const blob = file.slice((n - 1) * intent.partSize, n * intent.partSize);
      for (let attempt = 1; ; attempt++) {
        try { await api('PUT', `/v1/media/${intent.mediaId}/parts/${n}`, undefined, blob); break; } catch (e) {
          if (attempt >= 4 || (e instanceof ApiError && e.status >= 400 && e.status < 500)) throw e;
          await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
        }
      }
      onProgress(Math.round((++finished / intent.partCount) * 100));
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  await api('POST', `/v1/media/${intent.mediaId}/complete`);
  return intent.mediaId;
}

export type Plan = (typeof PLANS)[keyof typeof PLANS];
export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean };
  organizations: { id: string; name: string; plan: string; role: string }[];
  current: { id: string; role: string; plan: string; limits: Plan };
}
export interface Media {
  id: string; filename: string; kind: 'video' | 'audio' | 'image' | null; status: 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';
  sizeBytes: number; durationSec: number | null; width: number | null; height: number | null; fps: number | null; videoCodec: string | null; audioCodec: string | null;
  hasAudio: boolean | null; progress: number; error: { code: string; message: string } | null; createdAt: number; hasThumbnail: boolean;
}
export interface Playlist {
  id: string; name: string; items: Media[]; totalDurationSec: number; hasUnpublishedChanges: boolean;
  published: { versionId: string; version: number; publishedAt: number; itemCount: number } | null; updatedAt: number;
}
export interface Destination { id: string; name: string; platform: string; url: string; secure: boolean; streamKeyMasked: string; keyRotatedAt: number }
export interface StreamDest extends Destination { state: 'idle' | 'connecting' | 'live' | 'retrying' | 'failed'; bitrateKbps: number | null; outTimeSec: number | null; restarts: number; lastError: string | null }
export interface Stream {
  id: string; name: string; playlistId: string; playlistName: string | null; mode: 'loop' | 'once' | 'shuffle'; profile: string;
  status: string; statusReason: string | null; desiredState: 'running' | 'stopped'; engine: { online: boolean; lastHeartbeatAt: number | null };
  startedAt: number | null; nowPlaying: { title: string; cycle: number; position: number } | null; pendingPlaylistChange: boolean;
  metrics: { uptimeSec: number; feederBytes: number; itemsPlayed: number } | null; destinations: StreamDest[];
}
export interface StreamEvent { id: number; type: string; level: 'info' | 'warn' | 'error'; message: string; at: number }

export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
export function fmtDuration(sec: number | null | undefined) {
  if (sec == null) return '—';
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}
export const fmtTime = (ms: number) => new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' });
