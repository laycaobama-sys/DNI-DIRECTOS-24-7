import type { Plan } from '@dni/shared';

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

// ───────── Subidas ─────────
// Todos los archivos seleccionados suben A LA VEZ. Las partes de 8 MB de todos ellos comparten un grupo de
// conexiones simultáneas, de modo que la red siempre va llena y ningún archivo espera a que termine otro.
const MAX_PARALLEL_PARTS = 6;
let activeParts = 0;
const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeParts >= MAX_PARALLEL_PARTS) await new Promise<void>((r) => waiting.push(r));
  activeParts++;
  try { return await fn(); } finally { activeParts--; waiting.shift()?.(); }
}

/** PUT de una parte con progreso por byte (fetch no informa del progreso de subida). */
function putPart(url: string, blob: Blob, onBytes: (n: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('x-requested-with', 'dni-web');
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => onBytes(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let j: any = null;
      try { j = JSON.parse(xhr.responseText); } catch { /* sin cuerpo JSON */ }
      reject(new ApiError(xhr.status, j?.error?.code ?? 'http_error', j?.error?.message ?? `Error ${xhr.status}`));
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'Se perdió la conexión durante la subida.'));
    xhr.send(blob);
  });
}

export interface UploadProgress { pct: number; bytesPerSec: number; phase: 'uploading' | 'finishing' }

/** Subida multipart reanudable: consulta las partes ya subidas y solo envía las que faltan. */
export async function uploadFile(file: File, onProgress: (p: UploadProgress) => void, resumeId?: string): Promise<string> {
  const intent = resumeId
    ? { mediaId: resumeId, partSize: 8 * 1024 * 1024, partCount: Math.max(1, Math.ceil(file.size / (8 * 1024 * 1024))) }
    : await api<{ mediaId: string; partSize: number; partCount: number }>('POST', '/v1/media/upload-intents', { filename: file.name, size: file.size, contentType: file.type || undefined });
  const done = new Set<number>(resumeId ? (await get<{ uploaded: number[] }>(`/v1/media/${intent.mediaId}/parts`)).uploaded : []);
  const partBytes = new Map<number, number>();
  const sizeOf = (n: number) => Math.min(intent.partSize, file.size - (n - 1) * intent.partSize);
  for (const n of done) partBytes.set(n, sizeOf(n));
  const t0 = performance.now();
  let lastEmit = 0;
  const emit = (force = false) => {
    const now = performance.now();
    if (!force && now - lastEmit < 150) return;
    lastEmit = now;
    let sent = 0;
    for (const v of partBytes.values()) sent += v;
    onProgress({ pct: Math.min(100, (sent / Math.max(1, file.size)) * 100), bytesPerSec: sent / Math.max(0.001, (now - t0) / 1000), phase: 'uploading' });
  };
  emit(true);
  const parts = Array.from({ length: intent.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
  await Promise.all(parts.map((n) => slot(async () => {
    const blob = file.slice((n - 1) * intent.partSize, n * intent.partSize);
    for (let attempt = 1; ; attempt++) {
      try {
        await putPart(`/v1/media/${intent.mediaId}/parts/${n}`, blob, (b) => { partBytes.set(n, b); emit(); });
        partBytes.set(n, blob.size);
        emit();
        return;
      } catch (e) {
        partBytes.set(n, 0);
        if (attempt >= 5 || (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429)) throw e;
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt));
      }
    }
  })));
  onProgress({ pct: 100, bytesPerSec: 0, phase: 'finishing' });
  await api('POST', `/v1/media/${intent.mediaId}/complete`);
  return intent.mediaId;
}

export type { Plan };
export interface Me {
  user: { id: string; email: string; name: string; emailVerified: boolean; superadmin: boolean; hasPassword: boolean; google: boolean; createdAt: number };
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
export interface Destination {
  id: string; name: string; platform: string; url: string; secure: boolean; streamKeyMasked: string; keyRotatedAt: number;
  youtube: { connected: boolean; watchUrl: string; studioUrl: string } | null;
}
export interface YoutubeAccount { id: string; channelId: string; title: string; thumbnail: string | null; connectedAt: number }
export interface AuthConfig { signupsOpen: boolean; google: boolean; announcement: string | null }
export const fmtSpeed = (bps: number) => (bps > 1024 ** 2 ? `${(bps / 1024 ** 2).toFixed(1)} MB/s` : `${Math.max(1, Math.round(bps / 1024))} KB/s`);
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
