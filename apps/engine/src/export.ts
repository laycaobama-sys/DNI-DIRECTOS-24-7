/**
 * Exportación de una grabación a MP4 (sin recodificar).
 *
 * Los fragmentos MPEG-TS se descargan uno tras otro y se van pasando a FFmpeg por la entrada estándar: en disco solo
 * está el MP4 resultante (y su copia temporal de +faststart), nunca los fragmentos. El MP4 se sube a R2 por partes.
 */
import { spawn } from 'node:child_process';
import { open, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { MediaJob } from '@dni/shared';
import { api, cfg, lastLine, log } from './core';

type ExportJob = Extract<MediaJob, { type: 'recording_export' }>;
const PART = 16 * 1024 * 1024;

export async function processRecordingExport(job: ExportJob): Promise<void> {
  const dir = path.join(cfg.dataDir, 'work', job.recordingId);
  const out = path.join(dir, 'export.mp4');
  try {
    await mkdir(dir, { recursive: true });
    const ff = spawn(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', out], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    ff.stdin.on('error', () => {}); // si FFmpeg falla, el error real se lee de stderr
    const exited = once(ff, 'close') as Promise<[number | null]>;
    let sent = 0;
    for (const seq of job.segments) {
      const res = await fetch(`${cfg.apiUrl}/internal/recordings/${job.recordingId}/segments/${seq}/file`, { headers: { authorization: `Bearer ${cfg.engineToken}` }, signal: AbortSignal.timeout(10 * 60_000) });
      if (!res.ok || !res.body) { log.warn(`export ${job.recordingId}: fragmento ${seq} no disponible (HTTP ${res.status}), se omite`); continue; }
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        if (ff.exitCode !== null) break;
        if (!ff.stdin.write(chunk)) await once(ff.stdin, 'drain');
        sent += chunk.length;
      }
    }
    ff.stdin.end();
    const [code] = await exited;
    if (code !== 0) throw new Error(`FFmpeg no pudo crear el MP4: ${lastLine(stderr) || `código ${code}`}`);
    const { size } = await stat(out);
    const { uploadId, key } = await api<{ uploadId: string; key: string }>('POST', `/internal/recordings/${job.recordingId}/export/start`, {});
    const fh = await open(out, 'r');
    const parts: { partNumber: number; etag: string }[] = [];
    try {
      for (let n = 1, off = 0; off < size; n++, off += PART) {
        const buf = Buffer.alloc(Math.min(PART, size - off));
        await fh.read(buf, 0, buf.length, off);
        parts.push(await api('PUT', `/internal/recordings/${job.recordingId}/export/parts/${n}?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}`, undefined, { raw: buf, timeoutMs: 180_000 }));
      }
    } finally { await fh.close(); }
    await api('POST', `/internal/recordings/${job.recordingId}/export/complete`, { key, uploadId, parts });
    log.info({ recordingId: job.recordingId, inBytes: sent, mp4Bytes: size }, 'recording export done');
  } catch (e) {
    const message = e instanceof Error ? e.message.slice(0, 400) : String(e);
    log.warn({ recordingId: job.recordingId }, `recording export failed: ${message}`);
    await api('POST', `/internal/recordings/${job.recordingId}/export/fail`, { message }).catch(() => {});
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
