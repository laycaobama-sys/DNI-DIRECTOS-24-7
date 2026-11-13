/** Agente del nodo de emisión: reclama trabajos de medios y canales de la API y los ejecuta. */
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { MediaJob, StreamAssignment } from '@dni/shared';
import { api, cfg, log, runProcess, sleep } from './core';
import { processMediaJob } from './media';
import { StreamRunner } from './playout';

const runners = new Map<string, StreamRunner>();
let shuttingDown = false;
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
      const { assignment } = await api<{ assignment: StreamAssignment | null }>('POST', '/internal/streams/claim',
        { nodeId: cfg.nodeId, hostname: hostname(), version: `${cfg.version}${egress}`.slice(0, 40), capacity: cfg.capacity, running: runners.size });
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
    try {
      job = (await api<{ job: MediaJob | null }>('POST', '/internal/media-jobs/claim', { nodeId: cfg.nodeId })).job;
      if (job) await processMediaJob(job);
    } catch (e) {
      log.warn(`media loop: ${e instanceof Error ? e.message : e}`);
    }
    if (!job) await sleep(1000);
  }
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
  log.info({ api: cfg.apiUrl, capacity: cfg.capacity, role: cfg.role, ffmpeg: v.stdout.split('\n')[0] }, 'engine ready');
  if (cfg.port) {
    createServer((_req, res) => {
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
