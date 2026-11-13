/**
 * Nodo de emisión en Cloudflare Containers.
 *
 * Cada instancia de este Durable Object controla un contenedor con el motor FFmpeg. La imagen es la oficial de
 * Node (Docker Hub); al arrancar, un pequeño cargador descarga desde el R2 privado de la cuenta el motor y los
 * binarios de FFmpeg, verifica su SHA-256 y ejecuta el motor como usuario sin privilegios. Así se despliega sin
 * necesidad de construir imágenes Docker.
 *
 * El contenedor solo se mantiene encendido mientras hay trabajo (emisiones activas o medios por procesar):
 * el cron y las acciones del usuario llaman a `wakeEngines`, que arranca los nodos necesarios y renueva su
 * temporizador de inactividad. Sin trabajo, se apagan solos.
 */
import { DurableObject } from 'cloudflare:workers';
import { type Env, first } from './lib/core';

const PORT = 8080;
const INACTIVITY_MS = 10 * 60_000;

/** Cargador que se ejecuta dentro del contenedor (Node, sin dependencias). */
const BOOTSTRAP = `
import { mkdirSync, writeFileSync, chownSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
const { API_URL, ENGINE_TOKEN } = process.env;
const dir = '/opt/engine';
mkdirSync(dir, { recursive: true });
mkdirSync('/data', { recursive: true });
async function get(name) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(API_URL + '/internal/engine/assets/' + name, { headers: { authorization: 'Bearer ' + ENGINE_TOKEN } });
      if (!r.ok) throw new Error(name + ' HTTP ' + r.status);
      const buf = Buffer.from(await r.arrayBuffer());
      const want = r.headers.get('x-sha256');
      const got = createHash('sha256').update(buf).digest('hex');
      if (!want || want !== got) throw new Error('sha256 no coincide: ' + name);
      return buf;
    } catch (e) {
      if (i >= 5) throw e;
      console.error('bootstrap: reintento ' + name + ': ' + e.message);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
for (const [name, out, mode] of [['index.mjs', 'index.mjs', 0o644], ['ffmpeg.gz', 'ffmpeg', 0o755], ['ffprobe.gz', 'ffprobe', 0o755]]) {
  const buf = await get(name);
  writeFileSync(dir + '/' + out, name.endsWith('.gz') ? gunzipSync(buf) : buf, { mode });
}
chownSync('/data', 1000, 1000);
console.log('bootstrap: motor y FFmpeg verificados; arrancando');
const child = spawn(process.execPath, [dir + '/index.mjs'], {
  stdio: 'inherit', uid: 1000, gid: 1000,
  env: { ...process.env, FFMPEG_PATH: dir + '/ffmpeg', FFPROBE_PATH: dir + '/ffprobe', DATA_DIR: '/data', HOME: '/tmp' },
});
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s));
child.on('exit', (code) => process.exit(code ?? 1));
`;

export class EngineNode extends DurableObject<Env> {
  private monitoring: Promise<void> | undefined;

  private observeExit() {
    const container = this.ctx.container!;
    if (this.monitoring) return;
    this.monitoring = container.monitor()
      .then(() => console.log(JSON.stringify({ msg: 'engine container exited' })))
      .catch((e) => console.error(JSON.stringify({ msg: 'engine container failed', error: String(e) })))
      .finally(() => { this.monitoring = undefined; });
    this.ctx.waitUntil(this.monitoring);
  }

  /** Arranca el contenedor si hace falta, renueva su temporizador de inactividad y devuelve su estado. */
  override async fetch(request: Request): Promise<Response> {
    const container = this.ctx.container;
    if (!container) return Response.json({ ok: false, error: 'containers_not_configured' }, { status: 503 });
    const nodeId = new URL(request.url).searchParams.get('node') ?? 'cf-node-0';
    let started = false;
    if (!container.running) {
      container.start({
        enableInternet: true,
        entrypoint: ['node', '--input-type=module', '-e', BOOTSTRAP],
        env: {
          API_URL: this.env.PUBLIC_URL ?? '', ENGINE_TOKEN: this.env.ENGINE_TOKEN, NODE_ID: nodeId, PORT: String(PORT),
          CAPACITY: this.env.ENGINE_CAPACITY || '4', CACHE_MAX_BYTES: String(8 * 1024 ** 3), TRANSCODE_THREADS: '2',
        },
      });
      started = true;
    }
    this.observeExit();
    await container.setInactivityTimeout(INACTIVITY_MS);
    // Consultar el puerto de salud cuenta como actividad y devuelve la carga real del nodo.
    let health: unknown = null;
    try {
      const r = await container.getTcpPort(PORT).fetch('http://container/healthz', { signal: AbortSignal.timeout(3000) });
      health = await r.json();
    } catch { /* aún arrancando */ }
    return Response.json({ ok: true, started, running: container.running, health });
  }
}

/**
 * Mantiene encendidos tantos nodos como exija el trabajo pendiente. Idempotente; se llama desde el cron (cada
 * minuto) y al iniciar una emisión o completar una subida para no esperar al siguiente minuto.
 */
export async function wakeEngines(env: Env): Promise<{ nodes: number }> {
  if (!env.ENGINE || !env.PUBLIC_URL) return { nodes: 0 };
  const w = await first<{ streams: number; media: number }>(env.DB,
    `SELECT (SELECT COUNT(*) FROM streams WHERE desired_state = 'running' AND deleted_at IS NULL) AS streams,
            (SELECT COUNT(*) FROM media_assets WHERE status IN ('queued','processing') AND deleted_at IS NULL)
          + (SELECT COUNT(*) FROM media_variants WHERE status IN ('pending','processing')) AS media`);
  if (!w || (w.streams === 0 && w.media === 0)) return { nodes: 0 };
  const capacity = Math.max(1, Number(env.ENGINE_CAPACITY) || 4);
  const max = Math.max(1, Number(env.ENGINE_MAX_NODES) || 3);
  const nodes = Math.min(max, Math.max(1, Math.ceil(w.streams / capacity)));
  await Promise.all(Array.from({ length: nodes }, (_, i) =>
    env.ENGINE!.getByName(`node-${i}`).fetch(`http://engine/ensure?node=cf-node-${i}`).then((r) => r.body?.cancel()).catch((e) =>
      console.error(JSON.stringify({ msg: 'wake failed', node: i, error: String(e) })))));
  return { nodes };
}
