/** Agente del nodo de emisión: reclama trabajos de medios y canales de la API y los ejecuta. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { hostname } from 'node:os';
import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { MediaJob, StreamAssignment } from '@dni/shared';
import { api, cfg, log, runProcess, sleep } from './core';
import { processMediaJob } from './media';
import { type Relay, openRelay, parseTarget } from './relay';
import { StreamRunner } from './playout';

const runners = new Map<string, StreamRunner>();
let shuttingDown = false;
let updating = false;
let activeMediaJobs = 0;
/** SHA-256 del propio bundle (solo en Cloudflare, donde el cargador puede relanzarlo). */
let ownSha: string | null = null;
let egress = '';

/** Autodiagnóstico de salida de red hacia los ingests habituales (RTMPS 443 y RTMP 1935). Se informa a la API. */
function probe(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 6000 });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.once('connect', () => done(true)).once('timeout', () => done(false)).once('error', () => done(false));
  });
}

async function streamLoop() {
  while (!shuttingDown) {
    try {
      const { assignment, engineSha } = await api<{ assignment: StreamAssignment | null; engineSha?: string }>('POST', '/internal/streams/claim',
        { nodeId: cfg.nodeId, hostname: hostname(), version: `${cfg.version}${egress}`.slice(0, 40), capacity: cfg.capacity, running: updating ? cfg.capacity : runners.size });
      if (ownSha && engineSha && engineSha !== ownSha && !updating) void selfUpdate(engineSha);
      if (assignment && !shuttingDown) {
        // Nunca dos runners del mismo canal en un nodo: el anterior se detiene antes de arrancar el nuevo.
        const prev = runners.get(assignment.streamId);
        if (prev) prev.stop('fenced');
        const r = new StreamRunner(assignment);
        runners.set(assignment.streamId, r);
        log.info({ stream: assignment.streamId, fencing: assignment.fencingToken, destinations: assignment.destinations.length }, 'stream claimed');
        void r.run().catch((e) => log.error({ stream: assignment.streamId }, `runner crashed: ${e}`)).finally(() => {
          if (runners.get(assignment.streamId) === r) runners.delete(assignment.streamId);
          log.info({ stream: assignment.streamId }, 'stream released');
        });
        continue; // puede haber más canales esperando
      }
    } catch (e) {
      log.warn(`claim failed: ${e instanceof Error ? e.message : e}`);
    }
    await sleep(2000);
  }
}

async function mediaLoop() {
  while (!shuttingDown) {
    let job: MediaJob | null = null;
    if (updating) { await sleep(1000); continue; }
    try {
      job = (await api<{ job: MediaJob | null }>('POST', '/internal/media-jobs/claim', { nodeId: cfg.nodeId })).job;
      if (job) { activeMediaJobs++; try { await processMediaJob(job); } finally { activeMediaJobs--; } }
    } catch (e) {
      log.warn(`media loop: ${e instanceof Error ? e.message : e}`);
    }
    if (!job) await sleep(1000);
  }
}

/**
 * Diagnóstico de salida hacia YouTube desde ESTE nodo: DNS desde Node, DNS desde FFmpeg y una publicación real
 * de 3 s con una clave inventada (YouTube la rechaza, pero el error dice hasta dónde llegó la conexión).
 */
async function diagnose() {
  const out: Record<string, unknown> = { node: cfg.nodeId, ffmpeg: cfg.ffmpeg };
  try { out.dnsNode = (await lookup('a.rtmps.youtube.com', { all: true })).map((a) => a.address); } catch (e) { out.dnsNode = String(e); }
  for (const url of ['rtmp://a.rtmp.youtube.com/live2/diagnostico-dni', 'rtmps://a.rtmps.youtube.com/live2/diagnostico-dni']) {
    // Mismo camino que una emisión real: DNS en Node + relé local (+ TLS de Node en rtmps).
    const t = parseTarget(url)!;
    let relay: Relay | null = null;
    try {
      const ip = (await lookup(t.host, { family: 4 })).address;
      relay = await openRelay(t, ip);
      const r = await runProcess(cfg.ffmpeg, ['-hide_banner', '-loglevel', 'info', '-re', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-f', 'flv', '-rw_timeout', '10000000', '-rtmp_tcurl', relay.tcUrl, relay.localUrl], { timeoutMs: 30_000 });
      out[t.scheme] = { ip, code: r.code, relayError: relay.error(), bytesToYoutube: relay.bytesOut(), tail: r.stderr.split(/\r?\n/).filter((l) => /rtmp|tls|error|fail|connect|handshake|Output/i.test(l)).slice(-6) };
    } catch (e) {
      out[t.scheme] = { error: String(e) };
    } finally { relay?.close(); }
  }
  out.pipeline = await pipelineTests();
  return out;
}

/** Ejecuta un proceso y devuelve código, señal y la cola de stderr (sin bloquear el bucle de eventos). */
function runSig(bin: string, args: string[], stdin?: NodeJS.ReadableStream, timeoutMs = 60_000) {
  return new Promise<{ code: number | null; signal: string | null; tail: string[]; proc: ChildProcess }>((resolve) => {
    const p = spawn(bin, args, { stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    if (stdin) stdin.pipe(p.stdin!);
    p.stdin?.on('error', () => {});
    let err = '';
    p.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-3000); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code, signal) => { clearTimeout(t); resolve({ code, signal, tail: err.split(/\r?\n/).filter(Boolean).slice(-5), proc: p }); });
    p.on('error', (e) => { clearTimeout(t); resolve({ code: -1, signal: null, tail: [String(e)], proc: p }); });
  });
}

/**
 * Reproduce la cadena real de emisión sin red: alimentador (MP4 → MPEG-TS por tubería) → emisor (-c copy → FLV).
 * Con cada binario disponible y con un vídeo real de la caché si lo hay. Detecta cierres por señal (SIGSEGV…).
 */
async function pipelineTests() {
  const bins = [...new Set([cfg.ffmpeg, process.env.FFMPEG_STATIC].filter((b): b is string => !!b && existsSync(b)))];
  const cacheDir = path.join(cfg.dataDir, 'cache');
  const real = existsSync(cacheDir) ? (await readdir(cacheDir)).find((f) => f.endsWith('.mp4')) : undefined;
  const results: Record<string, unknown>[] = [];
  for (const bin of bins) {
    const src = path.join(cfg.dataDir, 'diag-src.mp4');
    const mk = await runSig(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
      '-t', '6', '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'high', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ar', '48000', '-ac', '2', src]);
    for (const [label, input] of [['sintetico', src], ...(real ? [['cache:' + real.slice(0, 14), path.join(cacheDir, real)]] : [])] as [string, string][]) {
      if (label === 'sintetico' && mk.code !== 0) { results.push({ bin, label, error: 'no se pudo generar el vídeo de prueba', mk: mk.tail }); continue; }
      const feeder = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', input, '-t', '8', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb',
        '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const outFile = path.join(cfg.dataDir, 'diag-out.flv');
      const pusher = await runSig(bin, ['-y', '-hide_banner', '-loglevel', 'repeat+warning', '-fflags', '+genpts', '-analyzeduration', '5000000', '-probesize', '5000000',
        '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'flv', '-flvflags', 'no_duration_filesize', outFile], feeder.stdout);
      feeder.kill('SIGKILL');
      let bytes = 0;
      try { bytes = (await stat(outFile)).size; } catch { /* sin salida */ }
      results.push({ bin, label, code: pusher.code, signal: pusher.signal, outBytes: bytes, tail: pusher.tail });
    }
  }
  return results;
}

/**
 * Prueba en tiempo real de la cadena completa dentro del nodo: alimentador (-re, en bucle) → emisor con los mismos
 * argumentos que en producción → relé → receptor RTMP local. A mitad se corta la conexión y el emisor se relanza.
 * Devuelve la duración, fotogramas y saltos recibidos (medidos con ffprobe sobre la grabación del receptor).
 */
async function realtimeTest(seconds = 120) {
  const bin = cfg.ffmpeg;
  const half = Math.round(seconds / 2);
  const src = path.join(cfg.dataDir, 'diag-long.mp4');
  const t0 = Date.now();
  // Fuente continua de la duración completa (sin bucles: los tiempos no se reinician), en formato canónico.
  const mk = await runSig(bin, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440:r=48000',
    '-t', String(seconds + 10), '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '2500k', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-ar', '48000', '-ac', '2', src], undefined, 300_000);
  if (mk.code !== 0) return { error: 'no se pudo generar la fuente', tail: mk.tail };
  const port = 19350;
  const target = parseTarget(`rtmp://127.0.0.1:${port}/live/prueba`)!;
  const receivers: { file: string; done: Promise<unknown> }[] = [];
  const startReceiver = (n: number) => {
    const file = path.join(cfg.dataDir, `diag-rx${n}.flv`);
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-listen', '1', '-timeout', '30', '-i', `rtmp://127.0.0.1:${port}/live/prueba`, '-c', 'copy', '-f', 'flv', file], { stdio: 'ignore' });
    receivers.push({ file, done: new Promise((r) => p.on('close', r)) });
    return p;
  };
  const rx1 = startReceiver(1);
  await sleep(1500);
  const feeder = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-re', '-i', src, '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:v', 'h264_mp4toannexb',
    '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', '-mpegts_flags', '+resend_headers', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exits: unknown[] = [];
  let current: ChildProcess | null = null;
  let relay: Relay | null = null;
  const startPusher = async () => {
    relay = await openRelay(target, '127.0.0.1');
    const r = relay;
    const p = spawn(bin, ['-hide_banner', '-loglevel', 'repeat+warning', '-progress', 'pipe:1', '-stats_period', '1', '-fflags', '+genpts', '-analyzeduration', '5000000', '-probesize', '5000000',
      '-f', 'mpegts', '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'flv', '-flvflags', 'no_duration_filesize', '-rw_timeout', '15000000',
      '-rtmp_tcurl', r.tcUrl, r.localUrl], { stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin!.on('error', () => {});
    let err = '';
    p.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-1500); });
    p.stdout!.on('data', () => {});
    p.on('close', (code, signal) => { exits.push({ code, signal, relayError: r.error(), relayBytes: r.bytesOut(), tail: err.split(/\r?\n/).filter(Boolean).slice(-2) }); r.close(); });
    current = p;
  };
  feeder.stdout!.on('data', (chunk: Buffer) => { const p = current; if (p && p.exitCode === null && !p.stdin!.destroyed) p.stdin!.write(chunk); });
  await startPusher();
  await sleep(half * 1000);
  // Corte de red simulado: se destruye la conexión; el receptor se cierra, se abre otro y el emisor se relanza a mitad del vídeo.
  (relay as Relay | null)?.close();
  await sleep(1000);
  (current as ChildProcess | null)?.kill('SIGKILL');
  await new Promise((r) => { rx1.once('close', r); setTimeout(() => { rx1.kill('SIGKILL'); r(null); }, 5000); });
  startReceiver(2);
  await sleep(1000);
  await startPusher();
  await sleep(half * 1000);
  (current as ChildProcess | null)?.stdin?.end();
  await sleep(3000);
  (current as ChildProcess | null)?.kill('SIGKILL');
  feeder.kill('SIGKILL');
  await Promise.race([Promise.all(receivers.map((r) => r.done)), sleep(10_000)]);
  const segments = [];
  for (const { file } of receivers) {
    const probe = await runProcess(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { timeoutMs: 60_000 }).catch(() => null);
    const pts = (probe?.stdout ?? '').trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0 || n === 0);
    const gaps = pts.slice(1).map((t, i) => t - pts[i]!).filter((d) => d > 0.1);
    let size = 0;
    try { size = (await stat(file)).size; } catch { /* sin grabación */ }
    segments.push({ bytes: size, frames: pts.length, durationSec: pts.length > 1 ? Number((pts[pts.length - 1]! - pts[0]!).toFixed(2)) : 0,
      fps: pts.length > 1 ? Number((pts.length / (pts[pts.length - 1]! - pts[0]!)).toFixed(2)) : 0, gapsOver100ms: gaps.length });
  }
  return { ffmpeg: bin, wallSec: Math.round((Date.now() - t0) / 1000), segments, pusherExits: exits };
}

/**
 * Versión nueva publicada: deja de aceptar trabajo, espera a que acaben las conversiones en curso (máx. 10 min),
 * libera las emisiones (se reanudan solas en segundos) y sale con 75 para que el cargador recargue el motor.
 */
async function selfUpdate(target: string) {
  updating = true;
  log.info({ from: ownSha?.slice(0, 12), to: target.slice(0, 12) }, 'engine update available');
  const deadline = Date.now() + 10 * 60_000;
  while (activeMediaJobs > 0 && Date.now() < deadline) await sleep(1000);
  shuttingDown = true;
  for (const r of runners.values()) r.stop('node_shutdown');
  const stopBy = Date.now() + 10_000;
  while (runners.size && Date.now() < stopBy) await sleep(100);
  process.exit(75);
}

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`${signal}: liberando ${runners.size} canal(es) para que otro nodo los retome`);
  const all = [...runners.values()];
  for (const r of all) r.stop('node_shutdown');
  const deadline = Date.now() + 10_000;
  while (runners.size && Date.now() < deadline) await sleep(100);
  process.exit(0);
}

async function main() {
  if (cfg.engineToken.length < 24) { log.error('ENGINE_TOKEN no configurado (mínimo 24 caracteres).'); process.exit(1); }
  const v = await runProcess(cfg.ffmpeg, ['-version']).catch(() => null);
  if (!v || v.code !== 0) { log.error(`FFmpeg no disponible en «${cfg.ffmpeg}». Define FFMPEG_PATH.`); process.exit(1); }
  await mkdir(path.join(cfg.dataDir, 'cache'), { recursive: true });
  if (process.env.ENGINE_SELF_UPDATE === '1') {
    try { ownSha = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'); } catch { ownSha = null; }
  }
  // Diagnóstico de red al arrancar, guardado en la API para consultarlo desde el panel.
  void diagnose().then((diag) => api('POST', '/internal/engine/report', { nodeId: cfg.nodeId, diag })).catch((e) => log.warn(`diag report failed: ${e}`));
  log.info({ api: cfg.apiUrl, capacity: cfg.capacity, role: cfg.role, ffmpeg: v.stdout.split('\n')[0] }, 'engine ready');
  if (cfg.port) {
    createServer((req, res) => {
      if (req.url?.startsWith('/diag')) {
        const full = req.url.includes('full=1');
        void (full ? realtimeTest(120) : diagnose()).then((d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); });
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, node: cfg.nodeId, running: runners.size, capacity: cfg.capacity, uptimeSec: Math.round(process.uptime()) }));
    }).listen(cfg.port, '0.0.0.0');
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  void Promise.all([probe('a.rtmps.youtube.com', 443), probe('a.rtmp.youtube.com', 1935)]).then(([tls, plain]) => {
    egress = ` 443:${tls ? 'ok' : 'NO'} 1935:${plain ? 'ok' : 'NO'}`;
    log.info({ rtmps443: tls, rtmp1935: plain }, 'egress self-test');
  });
  // Varios vídeos se convierten a la vez: una subida múltiple no espera en fila de uno en uno.
  const mediaWorkers = cfg.role !== 'stream' ? Array.from({ length: cfg.mediaConcurrency }, () => mediaLoop()) : [];
  await Promise.all([cfg.role !== 'media' ? streamLoop() : null, ...mediaWorkers]);
}

void main();
