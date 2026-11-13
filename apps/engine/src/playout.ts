/**
 * Motor de playout 24/7.
 *
 *   feeder (1 FFmpeg por ítem, -c copy → MPEG-TS)  ──►  bus con reloj PCR  ──►  pusher por destino (FFmpeg -c copy → FLV/RTMP)
 *
 * - Una única señal normalizada por canal; cada destino tiene su propio proceso: si uno cae, el resto sigue.
 * - Sin recodificación en emisión (los ítems ya son canónicos): CPU mínima por stream.
 * - Los cambios de playlist se aplican en el límite entre ítems, nunca a mitad de uno.
 * - Auto-fencing: si no se confirma el lease a tiempo, el nodo deja de emitir para no duplicar la señal.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readdir, stat, rm, utimes } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import path from 'node:path';
import {
  type AssignedPlaylist, type CursorState, type DestinationState, type Heartbeat, type HeartbeatResponse, type StreamAssignment, type StreamConfigRefresh,
  advance, isPrivateHost, redactRtmp, resolve,
} from '@dni/shared';
import { ApiError, api, cfg, download, lastLine, log, sleep } from './core';

const MAX_PUSHER_BUFFER = 24 * 1024 * 1024;
const STALL_MS = 20_000;
const CIRCUIT_FAILURES = 8;
const CIRCUIT_COOLDOWN_MS = 60_000;
const TS_PACKET = 188;

type Ev = NonNullable<Heartbeat['events']>[number];

// ───────────────────────── Caché de medios ─────────────────────────
const inFlight = new Map<string, Promise<string>>();
const inUse = new Map<string, number>();
const cacheDir = () => path.join(cfg.dataDir, 'cache');
const cachePath = (variantId: string) => path.join(cacheDir(), `${variantId.replace(/[^A-Za-z0-9_]/g, '')}.mp4`);

export function ensureCached(variantId: string, sizeBytes: number): Promise<string> {
  const file = cachePath(variantId);
  let p = inFlight.get(variantId);
  if (!p) {
    p = (async () => {
      const st = await stat(file).catch(() => null);
      if (st && st.size === sizeBytes) { await utimes(file, new Date(), st.mtime).catch(() => {}); return file; }
      const { size } = await download(`/internal/variants/${variantId}/file`, file);
      if (size !== sizeBytes) { await rm(file, { force: true }); throw new Error(`tamaño inesperado (${size} ≠ ${sizeBytes})`); }
      return file;
    })().finally(() => inFlight.delete(variantId));
    inFlight.set(variantId, p);
  }
  return p;
}

async function evictCache() {
  const files = await readdir(cacheDir()).catch(() => [] as string[]);
  const stats = (await Promise.all(files.filter((f) => f.endsWith('.mp4')).map(async (f) => ({ f, st: await stat(path.join(cacheDir(), f)).catch(() => null) })))).filter((x) => x.st);
  let total = stats.reduce((s, x) => s + x.st!.size, 0);
  for (const x of stats.sort((a, b) => a.st!.atimeMs - b.st!.atimeMs)) {
    if (total <= cfg.cacheMaxBytes) break;
    if (inUse.get(x.f.replace(/\.mp4$/, ''))) continue;
    await rm(path.join(cacheDir(), x.f), { force: true });
    total -= x.st!.size;
  }
}

/** Devuelve un motivo de bloqueo si el host del destino resuelve a una red privada (salvo en desarrollo). */
async function privateTarget(url: string): Promise<string | null> {
  if (cfg.allowPrivateDestinations) return null;
  const host = /^rtmps?:\/\/(\[[^\]]+\]|[^/:]+)/i.exec(url)?.[1]?.replace(/^\[|\]$/g, '');
  if (!host) return 'URL de destino no válida.';
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateHost(a.address)) ? 'El destino resuelve a una red privada: conexión bloqueada.' : null;
  } catch {
    return 'No se pudo resolver el servidor del destino (DNS).';
  }
}

// ───────────────────────── Pusher: un proceso por destino ─────────────────────────
class Pusher {
  state: DestinationState = 'idle';
  restarts = 0;
  lastError: string | null = null;
  bitrateKbps: number | null = null;
  outTimeSec: number | null = null;
  private bytesBase = 0;
  private bytesRun = 0;
  private proc: ChildProcessWithoutNullStreams | null = null;
  private failures = 0;
  private lastProgressAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private closed = false;
  private resolving = false;

  constructor(readonly id: string, private url: string, private emit: (e: Omit<Ev, 'at'>) => void) {}

  get bytesSent() { return this.bytesBase + this.bytesRun; }
  sameUrl(url: string) { return this.url === url; }

  start() {
    if (this.closed || this.proc || this.resolving) return;
    this.state = 'connecting';
    this.lastProgressAt = Date.now();
    this.outTimeSec = null; this.bitrateKbps = null;
    // Anti DNS-rebinding: la API valida el nombre, aquí se valida la IP a la que realmente se va a conectar.
    this.resolving = true;
    void privateTarget(this.url).then((blocked) => {
      this.resolving = false;
      if (this.closed) { this.state = 'idle'; return; }
      if (blocked) this.retry(blocked);
      else this.launch();
    });
  }

  private launch() {
    if (this.closed || this.proc) return;
    this.lastProgressAt = Date.now();
    const p = spawn(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'warning', '-progress', 'pipe:1', '-stats_period', '1',
      '-fflags', '+genpts', '-analyzeduration', '5000000', '-probesize', '5000000',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc',
      '-f', 'flv', '-flvflags', 'no_duration_filesize', '-rw_timeout', '15000000', this.url,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.proc = p;
    let stderr = '', buf = '';
    p.stdin.on('error', () => {}); // EPIPE cuando el destino corta: se gestiona en 'close'.
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-4000); });
    p.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const [k, v] = buf.slice(0, i).trim().split('=');
        buf = buf.slice(i + 1);
        if (k === 'out_time_us' && Number(v) > 0) {
          const t = Number(v) / 1e6;
          // Sano solo si el tiempo de salida AVANZA: un proceso vivo sin salida útil no cuenta.
          if (this.outTimeSec === null || t > this.outTimeSec) {
            this.lastProgressAt = Date.now();
            if (this.state !== 'live') { this.state = 'live'; this.lastError = null; this.emit({ type: 'destination_live', level: 'info', message: `Destino ${this.id} conectado y recibiendo señal.`, data: { destinationId: this.id } }); }
            if (t > 10) this.failures = 0;
          }
          this.outTimeSec = t;
        } else if (k === 'total_size' && Number(v) >= 0) this.bytesRun = Number(v);
        else if (k === 'bitrate' && v && v !== 'N/A') this.bitrateKbps = parseFloat(v);
      }
    });
    p.on('error', (e) => { stderr += e.message; });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      this.bytesBase += this.bytesRun; this.bytesRun = 0;
      this.bitrateKbps = null;
      if (this.closed) { this.state = 'idle'; return; }
      this.retry(lastLine(stderr) || `FFmpeg terminó con código ${code}`);
    });
  }

  private retry(error: string) {
    {
      this.failures++; this.restarts++;
      this.lastError = error;
      const open = this.failures >= CIRCUIT_FAILURES;
      this.state = open ? 'failed' : 'retrying';
      // Backoff exponencial con jitter; circuito abierto tras fallos consecutivos.
      const delay = open ? CIRCUIT_COOLDOWN_MS : Math.min(30_000, 1000 * 2 ** (this.failures - 1)) * (0.5 + Math.random() * 0.5);
      if (open) this.failures = CIRCUIT_FAILURES - 2;
      this.emit({ type: open ? 'destination_failed' : 'destination_retrying', level: open ? 'error' : 'warn', message: `Destino ${this.id}: ${this.lastError}. Reintento en ${Math.round(delay / 1000)} s.`, data: { destinationId: this.id, failures: this.failures } });
      this.timer = setTimeout(() => { this.timer = null; this.start(); }, delay);
    }
  }

  write(chunk: Buffer) {
    const p = this.proc;
    if (!p || p.stdin.destroyed) return;
    if (p.stdin.writableLength > MAX_PUSHER_BUFFER) {
      this.lastError = 'El destino no acepta datos (buffer lleno).';
      p.kill('SIGKILL');
      return;
    }
    p.stdin.write(chunk);
  }

  /** Watchdog: sin avance de salida mientras el feeder produce ⇒ reinicio del proceso. */
  check(feederActive: boolean) {
    if (this.proc && feederActive && Date.now() - this.lastProgressAt > STALL_MS) {
      this.lastError = 'Sin avance de señal hacia el destino.';
      this.proc.kill('SIGKILL');
    }
  }

  async close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const p = this.proc;
    if (!p) { this.state = 'idle'; return; }
    p.stdin.end(); // permite a FFmpeg cerrar la conexión RTMP limpiamente
    await Promise.race([new Promise<void>((r) => p.once('close', () => r())), sleep(3000)]);
    if (this.proc) p.kill('SIGKILL');
    this.state = 'idle';
  }

  snapshot() {
    return { id: this.id, state: this.state, bitrateKbps: this.bitrateKbps, outTimeSec: this.outTimeSec, bytesSent: this.bytesSent, restarts: this.restarts, lastError: this.lastError };
  }
}

// ───────────────────────── Runner: un canal ─────────────────────────
export class StreamRunner {
  private pushers = new Map<string, Pusher>();
  private events: Ev[] = [];
  private playlist: AssignedPlaylist;
  private pending: AssignedPlaylist | null = null;
  private cursor: CursorState;
  private current: { mediaId: string | null } = { mediaId: null };
  private feeder: ChildProcessWithoutNullStreams | null = null;
  private stopReason: string | null = null;
  private failReason: string | null = null;
  private fenced = false;
  private startedAt = Date.now();
  private lastFeedAt = 0;
  private feederBytes = 0;
  private itemsPlayed = 0;
  private lastOkHeartbeat = Date.now();
  private configRevision: string;
  private refreshing = false;
  private hbTimer: NodeJS.Timeout | null = null;
  private held = new Set<string>();
  private clock: { wall: number; pcr: number } | null = null;
  private lastPcr = -1;
  private cc = new Map<number, number>();

  constructor(readonly a: StreamAssignment) {
    this.playlist = a.playlist;
    this.cursor = a.resume ?? { cycle: 0, position: 0 };
    this.configRevision = a.configRevision;
  }

  get streamId() { return this.a.streamId; }
  private emit = (e: Omit<Ev, 'at'>) => {
    this.events.push({ ...e, message: redactRtmp(e.message).slice(0, 480), at: Date.now() });
    if (this.events.length > 300) this.events.splice(0, this.events.length - 300);
    log[e.level]({ stream: this.a.streamId, type: e.type }, e.message);
  };

  /** Detención pedida desde fuera (apagado del nodo, orden de la API). */
  stop(reason: string) { if (!this.stopReason) { this.stopReason = reason; this.feeder?.kill('SIGKILL'); } }

  private hold(pl: AssignedPlaylist) {
    for (const i of pl.items) if (!this.held.has(i.variantId)) { this.held.add(i.variantId); inUse.set(i.variantId, (inUse.get(i.variantId) ?? 0) + 1); }
  }

  async run(): Promise<void> {
    this.emit({ type: 'engine_started', level: 'info', message: `Motor iniciado${this.a.resume ? ` (reanuda en vuelta ${this.cursor.cycle + 1}, posición ${this.cursor.position + 1})` : ''}.` });
    this.hold(this.playlist);
    for (const d of this.a.destinations) this.addPusher(d.id, d.url);
    this.scheduleHeartbeat(0);
    try {
      await this.feedLoop();
    } catch (e) {
      this.failReason = `Error interno del motor: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (this.hbTimer) clearTimeout(this.hbTimer);
    await Promise.all([...this.pushers.values()].map((p) => p.close()));
    for (const v of this.held) { const n = (inUse.get(v) ?? 1) - 1; if (n <= 0) inUse.delete(v); else inUse.set(v, n); }
    if (!this.fenced) await this.finalHeartbeat();
    await evictCache().catch(() => {});
  }

  private addPusher(id: string, url: string) {
    const p = new Pusher(id, url, this.emit);
    this.pushers.set(id, p);
    p.start();
  }

  private async feedLoop() {
    let tsOffset = 0;
    let consecutiveFailures = 0;
    while (!this.stopReason && !this.failReason) {
      if (this.pending) {
        this.playlist = this.pending; this.pending = null;
        this.cursor = { cycle: this.cursor.cycle, position: 0 };
        this.emit({ type: 'playlist_applied', level: 'info', message: `Nueva versión de playlist aplicada en corte limpio (${this.playlist.items.length} ítems).`, data: { versionId: this.playlist.versionId } });
      }
      const step = resolve(this.playlist.items.length, this.a.mode, this.a.seed, this.cursor);
      this.cursor = step.state;
      if (step.index === null) { this.stopReason = 'playlist_finished'; this.emit({ type: 'playlist_finished', level: 'info', message: 'Playlist reproducida una vez: emisión finalizada.' }); break; }
      const item = this.playlist.items[step.index]!;
      let file: string;
      try {
        file = await ensureCached(item.variantId, item.sizeBytes);
      } catch (e) {
        consecutiveFailures++;
        this.emit({ type: 'item_unavailable', level: 'error', message: `No se pudo obtener «${item.title}»: ${e instanceof Error ? e.message : e}. Se salta.` });
        if (consecutiveFailures >= Math.max(3, this.playlist.items.length * 2)) { this.failReason = 'Ningún vídeo de la playlist está disponible para emitir.'; break; }
        this.cursor = advance(this.cursor);
        await sleep(1000);
        continue;
      }
      if (tsOffset > cfg.tsResetSec) {
        tsOffset = 0; // discontinuidad deliberada; los pushers la absorben (corrección de timestamps de FFmpeg para MPEG-TS)
        this.emit({ type: 'timestamp_reset', level: 'info', message: 'Reinicio periódico de la base de tiempos.' });
      }
      this.current = { mediaId: item.mediaId };
      this.emit({ type: 'item_started', level: 'info', message: `Reproduciendo «${item.title}».`, data: { mediaId: item.mediaId, index: step.index, cycle: this.cursor.cycle, position: this.cursor.position } });
      const began = Date.now();
      const res = await this.playItem(file, tsOffset);
      if (this.stopReason) break;
      if (res.code === 0) {
        tsOffset += item.durationSec;
        consecutiveFailures = 0;
        this.itemsPlayed++;
      } else {
        consecutiveFailures++;
        tsOffset += (Date.now() - began) / 1000 + 0.5;
        this.emit({ type: 'item_failed', level: 'error', message: `Fallo al reproducir «${item.title}»: ${res.error || `código ${res.code}`}. Se pasa al siguiente.` });
        if (consecutiveFailures >= Math.max(3, this.playlist.items.length * 2)) { this.failReason = 'Fallos repetidos al reproducir la playlist.'; break; }
        if (!existsSync(file)) inFlight.delete(item.variantId);
        await sleep(500);
      }
      this.cursor = advance(this.cursor);
    }
  }

  /**
   * Reproduce un ítem. El feeder NO usa -re: produce tan rápido como se le lee y es este proceso quien
   * marca el ritmo con un reloj único (PCR del MPEG-TS contra el reloj de pared). Así la latencia de
   * arranque de cada FFmpeg no se acumula como retraso en una emisión 24/7.
   */
  private async playItem(file: string, tsOffset: number): Promise<{ code: number | null; error: string }> {
    const p = spawn(cfg.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'file', '-i', file,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb',
      '-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', tsOffset.toFixed(6),
      '-f', 'mpegts', '-mpegts_flags', '+resend_headers', '-flush_packets', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.feeder = p;
    let stderr = '';
    p.stderr.on('data', (d: Buffer) => { stderr = (stderr + d.toString()).slice(-2000); });
    p.on('error', (e) => { stderr += e.message; });
    const closed = new Promise<number | null>((r) => p.on('close', (code) => r(code)));
    const bus = (chunk: Buffer) => {
      this.lastFeedAt = Date.now();
      this.feederBytes += chunk.length;
      for (const pusher of this.pushers.values()) pusher.write(chunk);
    };
    let carry: Buffer = Buffer.alloc(0);
    try {
      for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
        if (this.stopReason) break;
        const buf = carry.length ? Buffer.concat([carry, chunk]) : chunk;
        const usable = buf.length - (buf.length % TS_PACKET);
        let from = 0;
        for (let off = 0; off < usable; off += TS_PACKET) {
          if (buf[off] !== 0x47) continue; // desalineado (no debería ocurrir): pasa sin temporizar
          // Contadores de continuidad únicos para todo el canal: cada feeder reinicia los suyos y, sin esto,
          // el demuxer del destino marcaría como corrupto (y perdería) un fotograma en cada corte entre ítems.
          if (buf[off + 3]! & 0x10) {
            const pid = ((buf[off + 1]! & 0x1f) << 8) | buf[off + 2]!;
            const cc = ((this.cc.get(pid) ?? 15) + 1) & 0x0f;
            this.cc.set(pid, cc);
            buf[off + 3] = (buf[off + 3]! & 0xf0) | cc;
          }
          if (!(buf[off + 3]! & 0x20) || buf[off + 4]! === 0 || !(buf[off + 5]! & 0x10)) continue;
          const pcr = (buf[off + 6]! * 33554432 + buf[off + 7]! * 131072 + buf[off + 8]! * 512 + buf[off + 9]! * 2 + (buf[off + 10]! >> 7)) / 90000;
          if (off > from) { bus(buf.subarray(from, off)); from = off; }
          const now = Date.now();
          // Discontinuidad (reinicio de base de tiempos, ítem fallido): se re-ancla el reloj.
          if (!this.clock || pcr < this.lastPcr - 0.5 || pcr > this.lastPcr + 10) this.clock = { wall: now, pcr };
          this.lastPcr = pcr;
          const due = this.clock.wall + (pcr - this.clock.pcr) * 1000;
          if (due - now > 4) await sleep(due - now);
          else if (now - due > 3000) this.clock = { wall: now, pcr }; // tras un bloqueo largo no se emite en ráfaga
          if (this.stopReason) break;
        }
        if (usable > from) bus(buf.subarray(from, usable));
        carry = Buffer.from(buf.subarray(usable));
      }
    } catch (e) {
      stderr += e instanceof Error ? e.message : String(e);
    }
    if (this.stopReason && p.exitCode === null) p.kill('SIGKILL');
    const code = await closed;
    if (this.feeder === p) this.feeder = null;
    return { code, error: lastLine(stderr) };
  }

  private status(): Heartbeat['status'] {
    const live = [...this.pushers.values()].filter((p) => p.state === 'live').length;
    const feeding = Date.now() - this.lastFeedAt < 10_000;
    if (feeding && live === this.pushers.size && live > 0) return 'live';
    if (feeding && live > 0) return 'degraded';
    return Date.now() - this.startedAt < 30_000 ? 'starting' : 'recovering';
  }

  private reason(status: Heartbeat['status']): string | undefined {
    if (status === 'degraded') return `${[...this.pushers.values()].filter((p) => p.state !== 'live').length} de ${this.pushers.size} destinos sin señal; el resto sigue en directo.`;
    if (status === 'recovering') return 'Ningún destino recibe señal; reintentando conexión.';
    return undefined;
  }

  private payload(status: Heartbeat['status'], reason?: string): Heartbeat {
    return {
      nodeId: cfg.nodeId, sessionId: this.a.sessionId, fencingToken: this.a.fencingToken, status, reason: reason ?? this.reason(status),
      position: { cycle: this.cursor.cycle, position: this.cursor.position, playlistVersionId: this.playlist.versionId, mediaId: this.current.mediaId },
      metrics: { uptimeSec: (Date.now() - this.startedAt) / 1000, feederBytes: this.feederBytes, itemsPlayed: this.itemsPlayed },
      destinations: [...this.pushers.values()].map((p) => p.snapshot()),
      events: this.events.splice(0, 100),
    };
  }

  private scheduleHeartbeat(ms = cfg.heartbeatMs) {
    this.hbTimer = setTimeout(() => void this.heartbeat(), ms);
  }

  private fence(why: string) {
    this.fenced = true;
    log.error({ stream: this.a.streamId }, `auto-fencing: ${why}`);
    this.stop('fenced');
  }

  private async heartbeat() {
    if (this.stopReason || this.failReason) return;
    for (const p of this.pushers.values()) p.check(Date.now() - this.lastFeedAt < 5000);
    const body = this.payload(this.status());
    try {
      const r = await api<HeartbeatResponse>('POST', `/internal/streams/${this.a.streamId}/heartbeat`, body, { timeoutMs: 5000 });
      this.lastOkHeartbeat = Date.now();
      if (r.command === 'stop') return this.stop('stopped');
      if (r.restartNonce !== this.a.restartNonce) return this.stop('restart');
      if (r.configRevision !== this.configRevision && !this.refreshing) void this.refreshConfig(r.configRevision);
    } catch (e) {
      this.events.unshift(...(body.events ?? [])); // no perder eventos si el heartbeat falla
      if (e instanceof ApiError && e.status === 409) return this.fence('la API indica que otro nodo tiene el lease');
      // Sin confirmación durante todo el TTL, el lease ha caducado y otro nodo puede emitir: hay que callar.
      if (Date.now() - this.lastOkHeartbeat > this.a.leaseTtlSec * 1000 - cfg.heartbeatMs) return this.fence('lease no renovado a tiempo');
      log.warn({ stream: this.a.streamId }, `heartbeat failed: ${e instanceof Error ? e.message : e}`);
    }
    this.scheduleHeartbeat();
  }

  /** Destinos: se aplican al momento. Playlist: se precarga y entra en el siguiente límite de ítem. */
  private async refreshConfig(revision: string) {
    this.refreshing = true;
    try {
      const c = await api<StreamConfigRefresh>('GET', `/internal/streams/${this.a.streamId}/config?fencingToken=${this.a.fencingToken}&nodeId=${encodeURIComponent(cfg.nodeId)}`);
      const wanted = new Map(c.destinations.map((d) => [d.id, d.url]));
      for (const [id, p] of this.pushers) {
        if (!wanted.has(id) || !p.sameUrl(wanted.get(id)!)) { this.pushers.delete(id); void p.close(); this.emit({ type: 'destination_removed', level: 'info', message: `Destino ${id} ${wanted.has(id) ? 'actualizado' : 'retirado'}.` }); }
      }
      for (const [id, url] of wanted) if (!this.pushers.has(id)) { this.addPusher(id, url); this.emit({ type: 'destination_added', level: 'info', message: `Destino ${id} añadido en directo.` }); }
      if (c.playlist.versionId !== this.playlist.versionId && c.playlist.versionId !== this.pending?.versionId) {
        this.hold(c.playlist);
        await Promise.all(c.playlist.items.map((i) => ensureCached(i.variantId, i.sizeBytes)));
        this.pending = c.playlist;
        this.emit({ type: 'playlist_pending', level: 'info', message: 'Nueva versión de playlist precargada; se aplicará al terminar el vídeo actual.', data: { versionId: c.playlist.versionId } });
      }
      this.configRevision = revision;
    } catch (e) {
      if (!(e instanceof ApiError && e.code === 'config_not_ready')) log.warn({ stream: this.a.streamId }, `config refresh failed: ${e instanceof Error ? e.message : e}`);
    } finally { this.refreshing = false; }
  }

  private async finalHeartbeat() {
    const failed = !!this.failReason;
    if (failed) this.emit({ type: 'failed', level: 'error', message: this.failReason! });
    const body = this.payload(failed ? 'failed' : 'stopped', failed ? this.failReason! : this.stopReason ?? 'stopped');
    for (let i = 0; i < 3; i++) {
      try { await api('POST', `/internal/streams/${this.a.streamId}/heartbeat`, body, { timeoutMs: 5000 }); return; } catch (e) {
        if (e instanceof ApiError && e.status === 409) return;
        await sleep(1000 * (i + 1));
      }
    }
  }
}
