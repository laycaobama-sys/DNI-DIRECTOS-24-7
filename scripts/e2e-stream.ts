/**
 * Prueba end-to-end REAL del motor (sin mocks): API (wrangler dev) + motor FFmpeg + 2 ingests RTMP (MediaMTX).
 * Cubre los criterios H1–H7, H9, H13 (parcial) y H14 (parcial) de docs/MASTER_SPEC.md.
 * Uso: pnpm tools:setup && pnpm test:e2e-stream     (evidencias en .data/e2e/)
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH ?? (require('ffmpeg-static') as string);
const FFPROBE = process.env.FFPROBE_PATH ?? (require('ffprobe-static') as { path: string }).path;
const MEDIAMTX = path.join(root, '.tools', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
const dir = path.join(root, '.data', 'e2e');
const API_PORT = 8799, RTMP_A = 19351, RTMP_B = 19352;
const API = `http://127.0.0.1:${API_PORT}`;
const KEY_A = `sk_SECRETO_${randomBytes(6).toString('hex')}`, KEY_B = `sk_SECRETO_${randomBytes(6).toString('hex')}`;
const ENGINE_TOKEN = /ENGINE_TOKEN=(.+)/.exec(readFileSync(path.join(root, 'apps/api/.dev.vars'), 'utf8'))![1]!.trim();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const procs = new Set<ChildProcess>();
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
const step = (t: string) => console.log(`\n▶ ${t}`);

const start = (name: string, bin: string, args: string[], env: Record<string, string> = {}) => startIn(root, name, bin, args, env);
function startIn(cwd: string, name: string, bin: string, args: string[], env: Record<string, string> = {}): ChildProcess {
  const out = createWriteStream(path.join(dir, 'logs', `${name}.log`), { flags: 'a' });
  const p = spawn(bin, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  p.stdout!.pipe(out, { end: false }); p.stderr!.pipe(out, { end: false });
  procs.add(p);
  p.on('exit', () => procs.delete(p));
  return p;
}
function killTree(p: ChildProcess | undefined) {
  if (!p?.pid || p.exitCode !== null) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
    else p.kill('SIGKILL');
  } catch { /* ya terminado */ }
}
/** Procesos FFmpeg vivos lanzados desde este proyecto (para detectar huérfanos). */
function ffmpegCount(): number {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='ffmpeg.exe'" | Where-Object { $_.CommandLine -like '*pipe:*' }).Count`], { encoding: 'utf8' });
      return Number(out.trim() || 0);
    }
    return Number(execFileSync('sh', ['-c', "pgrep -fc 'ffmpeg.*pipe:' || true"], { encoding: 'utf8' }).trim() || 0);
  } catch { return -1; }
}
const mediamtx = (name: string, port: number) => {
  const yml = path.join(dir, `${name}.yml`);
  writeFileSync(yml, `logLevel: info\nrtmp: yes\nrtmpAddress: :${port}\nrtsp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\napi: no\nmetrics: no\npprof: no\nplayback: no\npaths:\n  all_others:\n`);
  return start(name, MEDIAMTX, [yml]);
};
const engine = (n: number) => start(`engine-${n}`, process.execPath, ['--import', 'tsx', 'apps/engine/src/index.ts'], {
  API_URL: API, ENGINE_TOKEN, NODE_ID: `e2e-node-${n}`, DATA_DIR: path.join(dir, `engine-${n}`), FFMPEG_PATH: FFMPEG, FFPROBE_PATH: FFPROBE, HEARTBEAT_MS: '2000',
});
const wrangler = (...args: string[]) => [path.join(root, 'apps/api/node_modules/wrangler/bin/wrangler.js'), ...args];
const d1 = (sql: string) => execFileSync(process.execPath, wrangler('d1', 'execute', 'DB', '--local', '--persist-to', path.join(dir, 'state'), '--command', sql), { cwd: path.join(root, 'apps/api'), stdio: 'pipe', env: { ...process.env, CI: '1' } });

class Client {
  cookie = '';
  constructor(public label: string) {}
  async req(method: string, p: string, body?: unknown, raw?: Buffer, extra: Record<string, string> = {}) {
    const res = await fetch(`${API}${p}`, {
      method,
      headers: { 'x-requested-with': 'e2e', ...(this.cookie ? { cookie: this.cookie } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}), ...extra },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0]!;
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* binario */ }
    return { status: res.status, json, text, headers: res.headers };
  }
  async ok(method: string, p: string, body?: unknown) {
    const r = await this.req(method, p, body);
    if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text.slice(0, 300)}`);
    return r.json;
  }
  async upload(file: string, filename: string): Promise<string> {
    const buf = readFileSync(file);
    const it = await this.ok('POST', '/v1/media/upload-intents', { filename, size: buf.length });
    for (let n = 1; n <= it.partCount; n++) {
      const r = await this.req('PUT', `/v1/media/${it.mediaId}/parts/${n}`, undefined, buf.subarray((n - 1) * it.partSize, n * it.partSize));
      if (r.status !== 200) throw new Error(`part ${n}: ${r.status} ${r.text}`);
    }
    await this.ok('POST', `/v1/media/${it.mediaId}/complete`);
    return it.mediaId;
  }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 1000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`Timeout esperando: ${what}`);
    await sleep(everyMs);
  }
}
function probeRtmp(url: string): { video?: any; audio?: any } {
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-rw_timeout', '8000000', '-show_streams', '-of', 'json', url], { encoding: 'utf8', timeout: 25_000 });
    const s = JSON.parse(out).streams as any[];
    return { video: s.find((x) => x.codec_type === 'video'), audio: s.find((x) => x.codec_type === 'audio') };
  } catch { return {}; }
}
const ff = (...args: string[]) => execFileSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], { stdio: 'pipe' });

async function main() {
  if (!existsSync(MEDIAMTX)) throw new Error('Falta MediaMTX: ejecuta `pnpm tools:setup`.');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'logs'), { recursive: true });
  const m = path.join(dir, 'media'); mkdirSync(m);

  step('Generando vídeos de prueba (fuentes sintéticas de FFmpeg, sin derechos de terceros)');
  ff('-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', path.join(m, 'a.mp4'));
  ff('-f', 'lavfi', '-i', 'smptebars=s=1280x720:r=30', '-t', '5', '-c:v', 'mpeg4', '-q:v', '5', path.join(m, 'b.mkv')); // sin audio
  ff('-f', 'lavfi', '-i', 'testsrc=s=854x480:r=24', '-f', 'lavfi', '-i', 'sine=f=880', '-t', '5', '-c:v', 'libvpx-vp9', '-b:v', '600k', '-deadline', 'realtime', '-cpu-used', '8', '-c:a', 'libvorbis', path.join(m, 'c.webm'));
  writeFileSync(path.join(m, 'corrupto.mp4'), randomBytes(200_000));

  step('Levantando API (Workers local), 2 ingests RTMP y aplicando migraciones');
  execFileSync(process.execPath, wrangler('d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', path.join(dir, 'state')), { cwd: path.join(root, 'apps/api'), stdio: 'pipe', env: { ...process.env, CI: '1' } });
  let mtxB = mediamtx('rtmp-b', RTMP_B);
  mediamtx('rtmp-a', RTMP_A);
  startIn(path.join(root, 'apps/api'), 'api', process.execPath, wrangler('dev', '--port', String(API_PORT), '--persist-to', path.join(dir, 'state'), '--var', 'LEASE_TTL_SEC:10', '--show-interactive-dev-session=false'), { CI: '1' }).on('exit', () => {});
  await waitFor('API healthz', async () => (await fetch(`${API}/healthz`)).ok, 90_000);
  check('API responde /healthz', true);

  const A = new Client('A'), B = new Client('B');
  step('H1 · Registro de dos organizaciones');
  const regA = await A.ok('POST', '/v1/auth/register', { email: `a-${Date.now()}@example.test`, password: 'Clave-segura-123', name: 'Ana', organizationName: 'Org A' });
  await B.ok('POST', '/v1/auth/register', { email: `b-${Date.now()}@example.test`, password: 'Clave-segura-456', name: 'Blas', organizationName: 'Org B' });
  const unauth = await new Client('anon').req('GET', '/v1/streams');
  check('API privada exige sesión (401)', unauth.status === 401);
  const noToken = await new Client('anon').req('POST', '/internal/streams/claim', { nodeId: 'x', capacity: 1, running: 0 });
  check('API interna del motor exige token (401)', noToken.status === 401);

  step('H2 · Subida multipart de 3 vídeos (H.264/MPEG-4/VP9) + 1 corrupto y procesamiento real');
  const ids = { a: await A.upload(path.join(m, 'a.mp4'), 'a.mp4'), b: await A.upload(path.join(m, 'b.mkv'), 'b.mkv'), c: await A.upload(path.join(m, 'c.webm'), 'c.webm'), bad: await A.upload(path.join(m, 'corrupto.mp4'), 'corrupto.mp4') };
  const exe = await A.req('POST', '/v1/media/upload-intents', { filename: 'virus.exe', size: 10 });
  check('Formato no admitido rechazado (422)', exe.status === 422, exe.json?.error?.code);
  let eng = engine(1);
  const media = await waitFor('procesamiento de medios', async () => {
    const items = (await A.ok('GET', '/v1/media')).items as any[];
    return items.every((i) => i.status === 'ready' || i.status === 'failed') ? items : null;
  }, 180_000, 1500);
  const by = (id: string) => media.find((x) => x.id === id);
  check('a.mp4 analizado: h264 640x360 con audio', by(ids.a).status === 'ready' && by(ids.a).videoCodec === 'h264' && by(ids.a).width === 640 && by(ids.a).hasAudio === true, JSON.stringify({ c: by(ids.a).videoCodec, w: by(ids.a).width, d: by(ids.a).durationSec }));
  check('b.mkv analizado: mpeg4 1280x720 sin audio', by(ids.b).status === 'ready' && by(ids.b).videoCodec === 'mpeg4' && by(ids.b).hasAudio === false);
  check('c.webm analizado: vp9 854x480', by(ids.c).status === 'ready' && by(ids.c).videoCodec === 'vp9' && by(ids.c).width === 854);
  check('Archivo corrupto → error accionable', by(ids.bad).status === 'failed' && by(ids.bad).error?.code === 'unreadable_media', by(ids.bad).error?.message);
  const th = await A.req('GET', `/v1/media/${ids.b}/thumbnail`);
  check('Miniatura real generada (JPEG)', th.status === 200 && th.headers.get('content-type') === 'image/jpeg');

  step('Playlist A→B→C, destinos cifrados y cuotas de plan');
  const pl = await A.ok('POST', '/v1/playlists', { name: 'Bucle e2e' });
  const badPub = await A.req('PUT', `/v1/playlists/${pl.id}`, { items: [{ mediaId: ids.a }, { mediaId: ids.bad }] }).then(() => A.req('POST', `/v1/playlists/${pl.id}/publish`));
  check('No se publica una playlist con medios fallidos (422)', badPub.status === 422, badPub.json?.error?.code);
  await A.ok('PUT', `/v1/playlists/${pl.id}`, { items: [{ mediaId: ids.a }, { mediaId: ids.b }, { mediaId: ids.c }] });
  await A.ok('POST', `/v1/playlists/${pl.id}/publish`);
  const insecure = await A.req('POST', '/v1/destinations', { name: 'x', url: `rtmp://127.0.0.1:${RTMP_A}/live`, streamKey: KEY_A });
  check('RTMP sin cifrar exige consentimiento explícito (422)', insecure.status === 422, insecure.json?.error?.code);
  const ssrf = await A.req('POST', '/v1/destinations', { name: 'x', url: 'http://169.254.169.254/latest', streamKey: 'k' });
  check('URL no RTMP rechazada (422)', ssrf.status === 422, ssrf.json?.error?.code);
  const d1r = await A.ok('POST', '/v1/destinations', { name: 'Ingest A', url: `rtmp://127.0.0.1:${RTMP_A}/live`, streamKey: KEY_A, allowInsecure: true });
  const d2r = await A.ok('POST', '/v1/destinations', { name: 'Ingest B', url: `rtmp://127.0.0.1:${RTMP_B}/live`, streamKey: KEY_B, allowInsecure: true });
  check('La API nunca devuelve la clave de emisión', !JSON.stringify([d1r, d2r, await A.ok('GET', '/v1/destinations')]).includes('SECRETO'));
  const over = await A.req('POST', '/v1/streams', { name: 'x', playlistId: pl.id, destinationIds: [d1r.id, d2r.id] });
  check('H5 · Plan de prueba: 2 destinos por stream rechazado (403)', over.status === 403, over.json?.error?.code);
  d1(`UPDATE organizations SET plan = 'pro' WHERE id = '${regA.organization.id}'`);
  const st = await A.ok('POST', '/v1/streams', { name: 'Canal e2e', playlistId: pl.id, mode: 'loop', profile: '720p30', destinationIds: [d1r.id, d2r.id] });

  step('H3/H4 · Inicio real desde la API y verificación de la señal con ffprobe');
  const t0 = Date.now();
  await A.ok('POST', `/v1/streams/${st.id}/start`);
  const get = () => A.ok('GET', `/v1/streams/${st.id}`);
  const events = async () => ((await A.ok('GET', `/v1/streams/${st.id}/events?limit=200`)).items as any[]).reverse();
  await waitFor('estado live', async () => (await get()).status === 'live', 60_000);
  check('Estado real «live» informado por el motor', true, `${((Date.now() - t0) / 1000).toFixed(1)} s desde start`);
  const urlA = `rtmp://127.0.0.1:${RTMP_A}/live/${KEY_A}`, urlB = `rtmp://127.0.0.1:${RTMP_B}/live/${KEY_B}`;
  const pa = probeRtmp(urlA), pb = probeRtmp(urlB);
  check('Ingest A recibe vídeo H.264 1280x720', pa.video?.codec_name === 'h264' && pa.video?.width === 1280 && pa.video?.height === 720, `${pa.video?.codec_name} ${pa.video?.width}x${pa.video?.height}`);
  check('Ingest A recibe audio AAC 48 kHz', pa.audio?.codec_name === 'aac' && pa.audio?.sample_rate === '48000', `${pa.audio?.codec_name} ${pa.audio?.sample_rate}`);
  check('Ingest B recibe vídeo y audio', pb.video?.codec_name === 'h264' && pb.audio?.codec_name === 'aac');

  step('H3 · Bucle A→B→C→A sin bloqueo (grabación de 24 s del ingest y análisis)');
  const rec = path.join(dir, 'grabacion.flv');
  ff('-rw_timeout', '10000000', '-i', urlA, '-t', '24', '-c', 'copy', rec);
  const pk = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets:format=duration', '-of', 'json', rec], { encoding: 'utf8' }));
  const frames = Number(pk.streams[0].nb_read_packets), dur = Number(pk.format.duration);
  const pts = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', rec], { encoding: 'utf8' }).trim().split(/\s+/).map(Number);
  const gaps = pts.slice(1).map((t, i) => t - pts[i]!).filter((d) => d > 0.045 || d < 0.02);
  check('Señal continua: ningún fotograma perdido ni salto de tiempo en los cortes entre ítems', dur > 22 && gaps.length === 0, `${frames} frames en ${dur.toFixed(1)} s, ${gaps.length} saltos (intervalo esperado 33 ms)`);
  const order = (await waitFor('una vuelta completa + reinicio', async () => { const e = (await events()).filter((x) => x.type === 'item_started'); return e.length >= 4 ? e : null; }, 60_000)).map((e: any) => e.data.mediaId);
  check('Orden de emisión A→B→C→A', order.slice(0, 4).join() === [ids.a, ids.b, ids.c, ids.a].join(), order.slice(0, 4).map((x: string) => Object.entries(ids).find(([, v]) => v === x)?.[0]).join('→'));
  const s1 = await get();
  check('Dashboard: «ahora suena» y motor online', !!s1.nowPlaying?.title && s1.engine.online === true, s1.nowPlaying?.title);

  step('H6 · Caída de un destino: el otro continúa');
  killTree(mtxB);
  await waitFor('estado degraded', async () => (await get()).status === 'degraded', 60_000);
  const s2 = await get();
  const dA = (s: any) => s.destinations.find((d: any) => d.id === d1r.id), dB = (s: any) => s.destinations.find((d: any) => d.id === d2r.id);
  check('Estado «degraded» con el destino B en reintento', ['retrying', 'connecting', 'failed'].includes(dB(s2).state) && dA(s2).state === 'live', `A=${dA(s2).state} B=${dB(s2).state} · ${s2.statusReason}`);
  const pa2 = probeRtmp(urlA);
  check('El destino A sigue recibiendo señal y no se reinició', pa2.video?.codec_name === 'h264' && dA(await get()).restarts === 0);
  mtxB = mediamtx('rtmp-b', RTMP_B);
  await waitFor('reconexión de B', async () => (await get()).status === 'live', 90_000);
  check('Reconexión automática del destino B (backoff) → «live»', probeRtmp(urlB).video?.codec_name === 'h264', `reinicios de B: ${dB(await get()).restarts}`);

  step('H9 · Edición de playlist en directo: entra en corte limpio, sin reiniciar la emisión');
  const sessBefore = (await A.ok('GET', `/v1/streams/${st.id}/sessions`)).items.length;
  await A.ok('PUT', `/v1/playlists/${pl.id}`, { items: [{ mediaId: ids.c }, { mediaId: ids.a }] });
  await A.ok('POST', `/v1/playlists/${pl.id}/publish`);
  const applied = await waitFor('playlist_applied', async () => { const e = await events(); const i = e.findIndex((x) => x.type === 'playlist_applied'); return i >= 0 ? e.slice(i) : null; }, 60_000);
  const after = await waitFor('ítems tras el cambio', async () => { const e = await events(); const i = e.findIndex((x) => x.type === 'playlist_applied'); const it = e.slice(i).filter((x) => x.type === 'item_started'); return it.length >= 2 ? it : null; }, 40_000);
  check('Nueva versión aplicada en límite de ítem (C→A)', applied.length > 0 && after[0].data.mediaId === ids.c && after[1].data.mediaId === ids.a);
  check('Sin reinicio de sesión ni de destinos por la edición', (await A.ok('GET', `/v1/streams/${st.id}/sessions`)).items.length === sessBefore && dA(await get()).restarts === 0);

  step('H7 · Matar el worker: reconciliación, recuperación y sin procesos duplicados');
  killTree(eng);
  await sleep(3000);
  check('Sin procesos FFmpeg huérfanos tras matar el nodo', ffmpegCount() === 0, `ffmpeg vivos: ${ffmpegCount()}`);
  eng = engine(2);
  await waitFor('evento engine_lost', async () => (await events()).some((e) => e.type === 'engine_lost'), 60_000);
  await waitFor('recuperación a live', async () => { const s = await get(); return s.status === 'live' && s.engine.online; }, 90_000);
  const ev = await events();
  const sessions = (await A.ok('GET', `/v1/streams/${st.id}/sessions`)).items as any[];
  check('Evento de error «engine_lost» registrado', ev.some((e) => e.type === 'engine_lost' && e.level === 'error'));
  check('Otro nodo retoma con nuevo fencing token y reanuda posición', ev.some((e) => e.type === 'recovery_claimed') && sessions.length === sessBefore + 1 && sessions[0].nodeId === 'e2e-node-2' && sessions[1].endReason === 'engine_lost', ev.find((e) => e.type === 'engine_started' && e.message.includes('reanuda'))?.message);
  check('Un único conjunto de procesos (1 feeder + 2 pushers)', ffmpegCount() === 3, `ffmpeg vivos: ${ffmpegCount()}`);
  check('Señal restablecida en ambos ingests', probeRtmp(urlA).video?.codec_name === 'h264' && probeRtmp(urlB).video?.codec_name === 'h264');
  const stale = await fetch(`${API}/internal/streams/${st.id}/heartbeat`, { method: 'POST', headers: { authorization: `Bearer ${ENGINE_TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ nodeId: 'e2e-node-1', sessionId: sessions[1].id, fencingToken: 1, status: 'live' }) });
  check('Heartbeat de un nodo desplazado → 409 (fencing)', stale.status === 409);

  step('H5 · Cuota de emisiones simultáneas');
  d1(`UPDATE organizations SET plan = 'trial' WHERE id = '${regA.organization.id}'`);
  const st2 = await A.ok('POST', '/v1/streams', { name: 'Segundo', playlistId: pl.id, destinationIds: [d1r.id] });
  const q = await A.req('POST', `/v1/streams/${st2.id}/start`);
  await sleep(4000);
  check('Exceder la cuota → 409 con mensaje útil y sin procesos ocultos', q.status === 409 && q.json?.error?.code === 'quota_concurrent_streams' && ffmpegCount() === 3 && (await A.ok('GET', `/v1/streams/${st2.id}`)).status === 'ready', q.json?.error?.message);

  step('H1 · Aislamiento entre organizaciones (IDOR)');
  const idor = await Promise.all([
    B.req('GET', `/v1/streams/${st.id}`), B.req('POST', `/v1/streams/${st.id}/stop`), B.req('PATCH', `/v1/streams/${st.id}`, { name: 'hack' }), B.req('GET', `/v1/streams/${st.id}/events`),
    B.req('GET', `/v1/media/${ids.a}`), B.req('DELETE', `/v1/media/${ids.a}`), B.req('GET', `/v1/media/${ids.a}/thumbnail`), B.req('GET', `/v1/playlists/${pl.id}`),
    B.req('PATCH', `/v1/destinations/${d1r.id}`, { name: 'hack' }), B.req('DELETE', `/v1/destinations/${d1r.id}`),
    B.req('GET', '/v1/streams', undefined, undefined, { 'x-org-id': regA.organization.id }),
  ]);
  check('B recibe 404 en todos los recursos de A (lectura y escritura)', idor.every((r) => r.status === 404), idor.map((r) => r.status).join(','));
  const plB = await B.ok('POST', '/v1/playlists', { name: 'B' });
  const cross = [await B.req('PUT', `/v1/playlists/${plB.id}`, { items: [{ mediaId: ids.a }] }), await B.req('POST', '/v1/streams', { name: 'x', playlistId: pl.id }), await B.req('POST', '/v1/streams', { name: 'x', playlistId: plB.id, destinationIds: [d1r.id] })];
  check('B no puede referenciar medios, playlists ni destinos de A (422)', cross.every((r) => r.status === 422), cross.map((r) => r.status).join(','));
  check('Los listados de B están vacíos', (await B.ok('GET', '/v1/media')).items.length === 0 && (await B.ok('GET', '/v1/streams')).items.length === 0 && (await B.ok('GET', '/v1/destinations')).items.length === 0);
  check('El stream de A sigue en directo tras los intentos de B', (await get()).status === 'live');
  const csrf = await fetch(`${API}/v1/streams/${st.id}/stop`, { method: 'POST', headers: { cookie: A.cookie } });
  check('Mutación sin cabecera anti-CSRF rechazada (403)', csrf.status === 403);

  step('Detención real y limpieza');
  await A.ok('POST', `/v1/streams/${st.id}/stop`);
  await waitFor('estado stopped', async () => (await get()).status === 'stopped', 30_000);
  await sleep(1500);
  check('Stop: estado «stopped», motor liberado y FFmpeg terminado', (await get()).engine.online === false && ffmpegCount() === 0, `ffmpeg vivos: ${ffmpegCount()}`);
  check('El ingest deja de recibir señal', !probeRtmp(urlA).video);
  const ov = await A.ok('GET', '/v1/overview');
  check('Uso medido por el motor (>0 s) y audiencia «no disponible»', ov.usage.liveHoursThisMonth > 0 && ov.audience.available === false, `${(ov.usage.liveHoursThisMonth * 3600).toFixed(0)} s emitidos, ${(ov.usage.egressBytesThisMonth / 1e6).toFixed(1)} MB enviados`);
  const logs = ['engine-1', 'engine-2', 'api'].map((n) => readFileSync(path.join(dir, 'logs', `${n}.log`), 'utf8')).join('\n');
  const evText = JSON.stringify(await events());
  check('H14 · Ninguna clave de emisión en logs del motor/API ni en eventos', !logs.includes('SECRETO') && !evText.includes('SECRETO'), `${(statSync(path.join(dir, 'logs', 'engine-2.log')).size / 1024).toFixed(0)} KB de logs revisados`);
}

main().then(() => 0, (e) => { console.error(`\nERROR: ${e instanceof Error ? e.stack : e}`); results.push({ name: 'ejecución completa', ok: false, detail: String(e) }); return 1; }).then(async () => {
  for (const p of [...procs]) killTree(p);
  await sleep(500);
  const failed = results.filter((r) => !r.ok);
  writeFileSync(path.join(dir, 'resultado.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  console.log(`\n═══ ${results.length - failed.length} PASS · ${failed.length} FAIL ═══  (evidencias: .data/e2e/)`);
  process.exit(failed.length ? 1 : 0);
});
