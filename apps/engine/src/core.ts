import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createHash, randomBytes } from 'node:crypto';
import pino from 'pino';
import { redactRtmp } from '@dni/shared';

const req = createRequire(import.meta.url);
function optionalBinary(pkg: string, pick: (m: unknown) => string | undefined, fallback: string): string {
  // En desarrollo se usan los binarios de npm; en Docker/producción, los del sistema (PATH).
  try { return pick(req(pkg)) || fallback; } catch { return fallback; }
}

const env = process.env;
export const cfg = {
  apiUrl: (env.API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, ''),
  engineToken: env.ENGINE_TOKEN ?? '',
  nodeId: env.NODE_ID ?? `node-${hostname().toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20)}-${randomBytes(3).toString('hex')}`,
  dataDir: path.resolve(env.DATA_DIR ?? '.data/engine'),
  capacity: Number(env.CAPACITY ?? 2),
  role: (env.ENGINE_ROLE ?? 'all') as 'all' | 'media' | 'stream',
  ffmpeg: env.FFMPEG_PATH ?? optionalBinary(['ffmpeg', 'static'].join('-'), (m) => m as string, 'ffmpeg'),
  ffprobe: env.FFPROBE_PATH ?? optionalBinary(['ffprobe', 'static'].join('-'), (m) => (m as { path?: string }).path, 'ffprobe'),
  transcodeThreads: Number(env.TRANSCODE_THREADS ?? 0),
  mediaConcurrency: Math.max(1, Number(env.MEDIA_CONCURRENCY ?? 2)),
  cacheMaxBytes: Number(env.CACHE_MAX_BYTES ?? 20 * 1024 ** 3),
  /** Reinicio periódico del desfase de timestamps (el PTS de MPEG-TS desborda a las ~26,5 h). */
  tsResetSec: Number(env.TS_RESET_SEC ?? 12 * 3600),
  heartbeatMs: Number(env.HEARTBEAT_MS ?? 3000),
  /** Solo desarrollo y pruebas: permite emitir a localhost y redes privadas. */
  allowPrivateDestinations: env.ALLOW_PRIVATE_DESTINATIONS === 'true',
  /** Puerto HTTP de salud (lo usa Cloudflare Containers). Sin definir, no se abre. */
  port: env.PORT ? Number(env.PORT) : 0,
  version: '0.1.0',
};

export const log = pino({
  level: env.LOG_LEVEL ?? 'info',
  base: { node: cfg.nodeId },
  // Ninguna clave de emisión debe llegar a los logs.
  hooks: { logMethod(args, method) { method.apply(this, args.map((a) => (typeof a === 'string' ? redactRtmp(a) : a)) as Parameters<typeof method>); } },
});

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

export async function api<T>(method: string, pathname: string, body?: unknown, opts: { raw?: Buffer | Uint8Array; timeoutMs?: number } = {}): Promise<T> {
  const res = await fetch(`${cfg.apiUrl}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${cfg.engineToken}`, ...(opts.raw ? { 'content-type': 'application/octet-stream' } : body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(res.status, j?.error?.code ?? 'http_error', j?.error?.message ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Descarga a disco de forma atómica (archivo .part + rename). Devuelve sha256 y tamaño. */
export async function download(pathname: string, dest: string): Promise<{ sha256: string; size: number }> {
  await mkdir(path.dirname(dest), { recursive: true });
  const res = await fetch(`${cfg.apiUrl}${pathname}`, { headers: { authorization: `Bearer ${cfg.engineToken}` }, signal: AbortSignal.timeout(30 * 60_000) });
  if (!res.ok || !res.body) throw new ApiError(res.status, 'download_failed', `Descarga fallida (HTTP ${res.status})`);
  const tmp = `${dest}.${randomBytes(4).toString('hex')}.part`;
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>), async function* (src) {
      for await (const chunk of src) { hash.update(chunk as Buffer); size += (chunk as Buffer).length; yield chunk; }
    }, createWriteStream(tmp));
    await rename(tmp, dest);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
  return { sha256: hash.digest('hex'), size };
}

export interface RunResult { code: number | null; stdout: string; stderr: string }
/** Ejecuta un binario con argumentos en array (sin shell): nada del usuario se interpreta como flags o comandos. */
export function runProcess(bin: string, args: string[], opts: { onStdoutLine?: (l: string) => void; timeoutMs?: number; captureStdout?: boolean } = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', buf = '';
    const timer = opts.timeoutMs ? setTimeout(() => p.kill('SIGKILL'), opts.timeoutMs) : null;
    p.stdout.on('data', (d: Buffer) => {
      if (opts.captureStdout !== false && stdout.length < 4_000_000) stdout += d.toString();
      if (opts.onStdoutLine) {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { opts.onStdoutLine(buf.slice(0, i).trim()); buf = buf.slice(i + 1); }
      }
    });
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-8000); });
    p.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    p.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export const lastLine = (s: string) => redactRtmp(s.trim().split(/\r?\n/).filter(Boolean).pop() ?? '').slice(0, 300);

/** Línea de error más significativa de la salida de FFmpeg (no el ruido de sondeo que suele quedar al final). */
export function errorLine(stderr: string): string {
  // El decodificador H.264 avisa al engancharse a mitad de GOP («decode_slice_header», «no frame!»…): es ruido
  // inofensivo con -c copy y no debe ocultar el error real (DNS, TLS, clave rechazada…).
  const NOISE = /decode_slice_header|no frame!|non-existing PPS|error while decoding MB|concealing|mmco|Invalid NAL|missing picture|co located POCs|reference picture missing|number of reference frames/i;
  const lines = stderr.trim().split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !NOISE.test(l));
  const hit = [...lines].reverse().find((l) => /error|failed|refused|timed? ?out|unable|invalid|denied|unreachable|broken pipe|reset|could not|cannot/i.test(l));
  return redactRtmp(hit ?? lines.pop() ?? '').replace(/^\[[^\]]+\]\s*/, '').slice(0, 300);
}

