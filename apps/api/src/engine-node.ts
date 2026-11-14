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
import { engineMaxNodes } from './lib/settings';

const PORT = 8080;
const INACTIVITY_MS = 10 * 60_000;

/**
 * Cargador que se ejecuta dentro del contenedor (Node, sin dependencias, como root):
 *  1. Instala y arranca nscd: los binarios estáticos de FFmpeg (glibc estática) NO pueden resolver nombres de
 *     dominio por sí mismos; nscd les da resolución DNS (sin él no se llega a a.rtmps.youtube.com).
 *  2. Descarga motor y FFmpeg verificados por SHA-256 desde la API y ejecuta el motor como uid 1000.
 *  3. Si el motor sale con código 75 (hay versión nueva publicada), vuelve a descargar y lo relanza sin apagar
 *     el contenedor: así cada despliegue actualiza los nodos aunque el contenedor siga encendido.
 */
const BOOTSTRAP = `
import { mkdirSync, writeFileSync, chownSync, existsSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { spawn, execSync } from 'node:child_process';
const { API_URL, ENGINE_TOKEN } = process.env;
const dir = '/opt/engine';
mkdirSync(dir, { recursive: true });
mkdirSync('/data', { recursive: true });
try {
  if (!existsSync('/usr/sbin/nscd')) execSync('apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends nscd >/dev/null', { stdio: 'inherit', timeout: 180000 });
  execSync('nscd', { stdio: 'inherit' });
  console.log('bootstrap: nscd activo (DNS para FFmpeg)');
} catch (e) { console.error('bootstrap: nscd no disponible: ' + e.message); }
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
      if (i >= 8) throw e;
      console.error('bootstrap: reintento ' + name + ': ' + e.message);
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
}
let child = null;
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { if (child) child.kill(s); else process.exit(0); });
for (;;) {
  for (const [name, out, mode] of [['index.mjs', 'index.mjs', 0o644], ['ffmpeg.gz', 'ffmpeg', 0o755], ['ffprobe.gz', 'ffprobe', 0o755]]) {
    if (name !== 'index.mjs' && existsSync(dir + '/' + out)) continue;
    const buf = await get(name);
    writeFileSync(dir + '/' + out, name.endsWith('.gz') ? gunzipSync(buf) : buf, { mode });
  }
  chownSync('/data', 1000, 1000);
  console.log('bootstrap: motor y FFmpeg verificados; arrancando');
  child = spawn(process.execPath, [dir + '/index.mjs'], {
    stdio: 'inherit', uid: 1000, gid: 1000,
    env: { ...process.env, FFMPEG_PATH: dir + '/ffmpeg', FFPROBE_PATH: dir + '/ffprobe', DATA_DIR: '/data', HOME: '/tmp', ENGINE_SELF_UPDATE: '1' },
  });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  child = null;
  if (code !== 75) process.exit(code ?? 1);
  console.log('bootstrap: versión nueva del motor; recargando');
}
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
    if (new URL(request.url).pathname === '/diag') {
      if (!container.running) return Response.json({ error: 'not_running' });
      try {
        const r = await container.getTcpPort(PORT).fetch('http://container/diag', { signal: AbortSignal.timeout(80_000) });
        return new Response(r.body, { headers: { 'content-type': 'application/json' } });
      } catch (e) { return Response.json({ error: String(e) }); }
    }
    if (new URL(request.url).pathname === '/status') {
      // Solo consulta: no arranca nada ni renueva el temporizador.
      let health: unknown = null;
      if (container.running) {
        try { health = await (await container.getTcpPort(PORT).fetch('http://container/healthz', { signal: AbortSignal.timeout(3000) })).json(); } catch { /* sin respuesta */ }
      }
      return Response.json({ running: container.running, assetsCurrent: (await this.ctx.storage.get<string>('assets')) === (this.env.ENGINE_ASSETS ?? ''), health });
    }
    let started = false, restarted = false;
    const url = new URL(request.url);
    const wanted = this.env.ENGINE_ASSETS ?? '';
    const stored = await this.ctx.storage.get<string>('assets');
    const forceRestart = url.pathname === '/restart';
    // rollout y restart solo actúan sobre nodos ya encendidos: nunca arrancan contenedores sin trabajo.
    if ((url.pathname === '/rollout' || forceRestart) && !container.running) {
      return Response.json({ ok: true, started: false, restarted: false, running: false, assetsCurrent: stored === wanted, health: null });
    }
    if (container.running && (stored !== wanted || forceRestart)) {
      // Versión nueva del motor publicada (o reinicio pedido): apagado ordenado, que libera los canales para que
      // se reanuden, y arranque con el código nuevo.
      console.log(JSON.stringify({ msg: 'engine restart', node: nodeId, reason: forceRestart ? 'manual' : 'new_assets' }));
      container.signal(15);
      await Promise.race([container.monitor().catch(() => {}), scheduler.wait(12_000)]);
      if (container.running) await container.destroy().catch((e) => console.error(JSON.stringify({ msg: 'destroy failed', error: String(e) })));
      restarted = true;
    }
    if (!container.running) {
      await this.ctx.storage.put('assets', wanted);
      container.start({
        enableInternet: true,
        entrypoint: ['node', '--input-type=module', '-e', BOOTSTRAP],
        env: {
          API_URL: this.env.PUBLIC_URL ?? '', ENGINE_TOKEN: this.env.ENGINE_TOKEN, NODE_ID: nodeId, PORT: String(PORT),
          CAPACITY: this.env.ENGINE_CAPACITY || '4', CACHE_MAX_BYTES: String(8 * 1024 ** 3), MEDIA_CONCURRENCY: '2',
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
    return Response.json({ ok: true, started, restarted, running: container.running, assetsCurrent: (await this.ctx.storage.get<string>('assets')) === wanted, health });
  }
}

/** Estado o acción sobre los nodos de Cloudflare (panel de administración y diagnóstico). */
export async function engineNodes(env: Env, action: 'status' | 'ensure' | 'restart' | 'rollout' = 'status') {
  if (!env.ENGINE) return [];
  // Status/rollout/restart recorren todos los nodos posibles; ensure solo los configurados.
  const max = action === 'ensure' ? await engineMaxNodes(env) : 10;
  return Promise.all(Array.from({ length: max }, async (_, i) => {
    try {
      const r = await env.ENGINE!.getByName(`node-${i}`).fetch(`http://engine/${action}?node=cf-node-${i}`);
      return { name: `cf-node-${i}`, ...((await r.json()) as object) };
    } catch (e) {
      return { name: `cf-node-${i}`, error: String(e).slice(0, 300) };
    }
  }));
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
  const max = await engineMaxNodes(env);
  // Escala por emisiones y también por vídeos pendientes: cada nodo convierte MEDIA_CONCURRENCY a la vez.
  const perNodeMedia = 2;
  const nodes = Math.min(max, Math.max(1, Math.ceil(w.streams / capacity), Math.ceil(w.media / perNodeMedia)));
  await Promise.all(Array.from({ length: nodes }, (_, i) =>
    env.ENGINE!.getByName(`node-${i}`).fetch(`http://engine/ensure?node=cf-node-${i}`).then((r) => r.body?.cancel()).catch((e) =>
      console.error(JSON.stringify({ msg: 'wake failed', node: i, error: String(e) })))));
  return { nodes };
}
