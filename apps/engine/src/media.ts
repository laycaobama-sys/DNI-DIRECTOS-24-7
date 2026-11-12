/** Pipeline de medios: descarga → ffprobe → validación → transcodificación canónica → miniatura → subida. */
import { open, mkdir, rm, stat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ENCODING_PROFILES, type MediaJob, type MediaResult, type ProfileId } from '@dni/shared';
import { ApiError, api, cfg, download, lastLine, log, runProcess } from './core';

const ALLOWED_FORMATS = ['mov', 'mp4', 'matroska', 'webm', 'mp3', 'wav', 'aac', 'png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2'];
const IMAGE_FORMATS = ['png_pipe', 'jpeg_pipe', 'webp_pipe', 'image2'];
const MAX_DURATION_SEC = 12 * 3600;

export interface Probe {
  kind: 'video' | 'audio' | 'image';
  durationSec: number | null; width: number | null; height: number | null; fps: number | null;
  videoCodec: string | null; audioCodec: string | null; hasAudio: boolean;
  videoDurationSec: number | null; audioDurationSec: number | null;
}

class MediaError extends Error {
  constructor(public code: string, message: string, public retryable = false) { super(message); }
}

const ratio = (s?: string) => { const [a, b] = (s ?? '').split('/').map(Number); return a && b ? a / b : null; };
const num = (v: unknown) => (v === undefined || v === null || Number.isNaN(Number(v)) ? null : Number(v));

export async function probeFile(file: string): Promise<Probe> {
  // protocol_whitelist=file: un archivo malicioso (p. ej. una playlist HLS disfrazada) no puede hacer que FFmpeg abra URLs.
  const r = await runProcess(cfg.ffprobe, ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 60_000 });
  let j: { format?: { format_name?: string; duration?: string }; streams?: Record<string, unknown>[] };
  try { j = JSON.parse(r.stdout || '{}'); } catch { j = {}; }
  if (r.code !== 0 || !j.format || !j.streams?.length) {
    throw new MediaError('unreadable_media', 'No se pudo leer el archivo: está dañado o no es un vídeo, audio o imagen válido. Vuelve a exportarlo y súbelo de nuevo.');
  }
  const formats = (j.format.format_name ?? '').split(',');
  if (!formats.some((f) => ALLOWED_FORMATS.includes(f))) {
    throw new MediaError('unsupported_container', `Contenedor «${j.format.format_name}» no admitido. Usa MP4, MOV, MKV, WebM, MP3, WAV, AAC, PNG, JPEG o WebP.`);
  }
  const v = j.streams.find((s) => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  const a = j.streams.find((s) => s.codec_type === 'audio');
  const isImage = formats.some((f) => IMAGE_FORMATS.includes(f));
  const duration = num(j.format.duration);
  const kind = v && !isImage ? 'video' : a ? 'audio' : v ? 'image' : null;
  if (!kind) throw new MediaError('no_media_streams', 'El archivo no contiene pistas de vídeo, audio ni imagen utilizables.');
  // La rotación (móviles) intercambia ancho y alto efectivos; FFmpeg la aplica automáticamente al transcodificar.
  const rot = Math.abs(Number((v?.side_data_list as { rotation?: number }[] | undefined)?.find((s) => s.rotation !== undefined)?.rotation ?? (v?.tags as { rotate?: string } | undefined)?.rotate ?? 0));
  const swap = rot === 90 || rot === 270;
  return {
    kind, durationSec: kind === 'image' ? null : duration,
    width: v ? num(swap ? v.height : v.width) : null, height: v ? num(swap ? v.width : v.height) : null,
    fps: v && kind === 'video' ? ratio(v.avg_frame_rate as string) ?? ratio(v.r_frame_rate as string) : null,
    videoCodec: (v?.codec_name as string) ?? null, audioCodec: (a?.codec_name as string) ?? null, hasAudio: !!a,
    videoDurationSec: v ? num(v.duration) : null, audioDurationSec: a ? num(a.duration) : null,
  };
}

/** Argumentos de la transcodificación canónica: todos los ítems comparten códec, resolución, fps, GOP y audio. */
export function transcodeArgs(input: string, output: string, probe: Probe, profileId: ProfileId, durationSec: number): string[] {
  const p = ENCODING_PROFILES[profileId];
  const gop = p.fps * 2; // keyframe cada 2 s
  const args = ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-progress', 'pipe:1', '-protocol_whitelist', 'file', '-i', input];
  if (!probe.hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  args.push(
    '-map', '0:v:0', '-map', probe.hasAudio ? '0:a:0' : '1:a:0',
    '-vf', `scale=${p.width}:${p.height}:force_original_aspect_ratio=decrease,pad=${p.width}:${p.height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${p.fps},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-level:v', profileId === '1080p30' ? '4.2' : '4.1',
    '-b:v', `${p.videoKbps}k`, '-maxrate', `${p.videoKbps}k`, '-bufsize', `${p.videoKbps * 2}k`,
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-bf', '0',
    '-c:a', 'aac', '-b:a', `${p.audioKbps}k`, '-ar', '48000', '-ac', '2',
    // apad + -t: audio y vídeo terminan en el mismo instante (cortes limpios entre ítems).
    '-af', 'aresample=async=1:first_pts=0,apad',
    '-t', durationSec.toFixed(3), '-max_muxing_queue_size', '2048', '-movflags', '+faststart',
  );
  if (cfg.transcodeThreads > 0) args.push('-threads', String(cfg.transcodeThreads));
  args.push(output);
  return args;
}

async function uploadVariant(mediaId: string, file: string, profile: ProfileId, durationSec: number, variantId?: string): Promise<string> {
  const { variantId: vid, partSize } = await api<{ variantId: string; partSize: number }>('POST', `/internal/media/${mediaId}/variants`, { profile, variantId });
  const { size } = await stat(file);
  const fh = await open(file, 'r');
  const parts: { partNumber: number; etag: string }[] = [];
  try {
    for (let n = 1, off = 0; off < size; n++, off += partSize) {
      const buf = Buffer.alloc(Math.min(partSize, size - off));
      await fh.read(buf, 0, buf.length, off);
      parts.push(await api('PUT', `/internal/variants/${vid}/parts/${n}`, undefined, { raw: buf, timeoutMs: 120_000 }));
    }
  } finally { await fh.close(); }
  await api('POST', `/internal/variants/${vid}/complete`, { parts, sizeBytes: size, durationSec });
  return vid;
}

async function transcode(job: MediaJob, original: string, probe: Probe, dir: string, onProgress: (pct: number) => void) {
  const frame = 1 / ENCODING_PROFILES[job.profile].fps;
  const srcDur = probe.videoDurationSec ?? probe.durationSec;
  if (!srcDur || srcDur < frame * 2) throw new MediaError('too_short', 'El vídeo es demasiado corto o no informa de su duración.');
  if (srcDur > MAX_DURATION_SEC) throw new MediaError('too_long', 'El vídeo supera la duración máxima de 12 horas.');
  if ((probe.width ?? 0) > 4096 || (probe.height ?? 0) > 4096) throw new MediaError('unsupported_resolution', 'La resolución supera el máximo admitido (4096 px por lado).');
  const target = Math.floor(srcDur / frame) * frame;
  const out = path.join(dir, `${job.profile}.mp4`);
  const r = await runProcess(cfg.ffmpeg, transcodeArgs(original, out, probe, job.profile, target), {
    captureStdout: false,
    timeoutMs: Math.max(10 * 60_000, srcDur * 4 * 1000),
    onStdoutLine: (l) => { if (l.startsWith('out_time_us=')) onProgress(Math.min(99, Math.round((Number(l.slice(12)) / 1e6 / target) * 100))); },
  });
  if (r.code !== 0) throw new MediaError('transcode_failed', `No se pudo convertir el vídeo: ${lastLine(r.stderr) || 'error de FFmpeg'}.`);
  const outProbe = await probeFile(out);
  const durationSec = Math.max(outProbe.videoDurationSec ?? 0, outProbe.audioDurationSec ?? 0, 0) || outProbe.durationSec || target;
  return { out, durationSec };
}

export async function processMediaJob(job: MediaJob): Promise<void> {
  const dir = path.join(cfg.dataDir, 'work', job.mediaId);
  const resultPath = `/internal/media/${job.mediaId}/result${job.type === 'variant' ? `?variantId=${job.variantId}` : ''}`;
  let lastReport = 0;
  const onProgress = (pct: number) => {
    if (Date.now() - lastReport < 2000) return;
    lastReport = Date.now();
    api('POST', `/internal/media/${job.mediaId}/progress`, { progress: pct }).catch(() => {});
  };
  let result: MediaResult;
  try {
    await mkdir(dir, { recursive: true });
    const original = path.join(dir, 'original');
    const { sha256 } = await download(`/internal/media/${job.mediaId}/original`, original);
    const probe = await probeFile(original);
    const base = { ok: true as const, kind: probe.kind, sha256, probe: { durationSec: probe.durationSec, width: probe.width, height: probe.height, fps: probe.fps, videoCodec: probe.videoCodec, audioCodec: probe.audioCodec, hasAudio: probe.hasAudio } };
    if (probe.kind === 'video') {
      const { out, durationSec } = await transcode(job, original, probe, dir, onProgress);
      if (job.type === 'ingest') {
        const thumb = path.join(dir, 'thumb.jpg');
        const t = await runProcess(cfg.ffmpeg, ['-y', '-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', Math.min(1, durationSec / 2).toFixed(2), '-i', out, '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', thumb], { timeoutMs: 60_000 });
        if (t.code === 0) await api('PUT', `/internal/media/${job.mediaId}/thumbnail`, undefined, { raw: await readFile(thumb), timeoutMs: 60_000 });
      }
      const variantId = await uploadVariant(job.mediaId, out, job.profile, durationSec, job.type === 'variant' ? job.variantId : undefined);
      result = { ...base, variantId, variantDurationSec: durationSec };
    } else {
      if (job.type === 'variant') throw new MediaError('not_a_video', 'Solo los vídeos se convierten a perfiles de emisión.');
      result = base;
    }
  } catch (e) {
    if (e instanceof MediaError) result = { ok: false, code: e.code, message: e.message, retryable: e.retryable };
    // Fallos de red/API o del propio nodo: el trabajo se reintenta (hasta el máximo de intentos).
    else result = { ok: false, code: e instanceof ApiError ? e.code : 'engine_error', message: `Error temporal al procesar el archivo: ${e instanceof Error ? e.message.slice(0, 200) : 'desconocido'}`, retryable: true };
    log.warn({ mediaId: job.mediaId, code: result.code }, `media job failed: ${result.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  await api('POST', resultPath, result);
  if (result.ok) log.info({ mediaId: job.mediaId, type: job.type, profile: job.profile }, 'media job done');
}
