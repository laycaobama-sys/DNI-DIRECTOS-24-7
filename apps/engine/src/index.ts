/** Agente del nodo de emisión: reclama trabajos de medios y canales de la API y los ejecuta. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { hostname } from 'node:os';
import { mkdir, readFile } from 'node:fs/promises';
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
  return out;
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
      if (req.url === '/diag') {
        void diagnose().then((d) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(d)); });
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
