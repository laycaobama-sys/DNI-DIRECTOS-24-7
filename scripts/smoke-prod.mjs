#!/usr/bin/env node
/**
 * Prueba de humo contra PRODUCCIÓN (requiere un motor en marcha: pnpm engine:prod o Containers).
 * Crea una cuenta temporal, sube un vídeo sintético, espera su conversión, publica una playlist, crea un destino
 * y una emisión, comprueba el aislamiento y las cabeceras, y LO BORRA TODO al terminar (pnpm smoke:prod).
 * No inicia ninguna emisión: no envía señal a ninguna plataforma.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { url: API } = JSON.parse(readFileSync(path.join(root, '.data/prod/deployment.json'), 'utf8'));
const dir = path.join(root, '.data/prod/smoke');
mkdirSync(dir, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cookie = '';
async function call(method, p, body, raw, headers = {}) {
  const res = await fetch(API + p, { method, redirect: 'manual', headers: { 'x-requested-with': 'smoke', ...(cookie ? { cookie } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const sc = res.headers.get('set-cookie');
  if (sc?.startsWith('dni_session=')) cookie = sc.split(';')[0];
  return { status: res.status, json: await res.clone().json().catch(() => null), headers: res.headers };
}
const d1 = (sql) => execFileSync(process.execPath, [path.join(root, 'apps/api/node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--command', sql], { cwd: path.join(root, 'apps/api'), stdio: 'pipe', env: { ...process.env, CI: '1' } });

const email = `smoke-${randomBytes(4).toString('hex')}@example.test`;
let orgId = null, userId = null;
try {
  console.log(`\n▶ ${API}`);
  const h = await call('GET', '/healthz');
  check('API y base de datos responden', h.status === 200);
  check('Cabeceras de seguridad (HSTS, nosniff, CSP)', !!h.headers.get('strict-transport-security') && h.headers.get('x-content-type-options') === 'nosniff' && !!h.headers.get('content-security-policy'));
  const page = await fetch(API + '/');
  check('La web se sirve desde Cloudflare', page.status === 200 && (await page.text()).includes('DNI Directos'));
  const spa = await fetch(API + '/app/streams');
  check('Rutas del panel resueltas (SPA)', spa.status === 200);
  check('API privada exige sesión', (await call('GET', '/v1/streams')).status === 401);
  check('API interna del motor exige token', (await call('POST', '/internal/streams/claim', { nodeId: 'x', capacity: 1, running: 0 })).status === 401);
  const cfg = await call('GET', '/v1/auth/config');
  check('Registro por correo abierto', cfg.json?.signupsOpen === true, `Google configurado: ${cfg.json?.google}`);
  const g = await call('GET', '/v1/auth/google/start');
  check('Acceso con Google', cfg.json?.google ? g.status === 302 && (g.headers.get('location') ?? '').startsWith('https://accounts.google.com/') : g.status === 404, cfg.json?.google ? 'redirige a accounts.google.com' : 'pendiente de credenciales (404 esperado)');

  console.log('\n▶ Cuenta temporal y flujo completo');
  const reg = await call('POST', '/v1/auth/register', { email, password: randomBytes(15).toString('base64url'), name: 'Prueba de humo', organizationName: 'Prueba de humo' });
  check('Registro por correo', reg.status === 201);
  orgId = reg.json?.organization?.id; userId = reg.json?.user?.id;
  const me = await call('GET', '/v1/auth/me');
  check('Sesión y plan gratuito sin límites', me.status === 200 && me.json?.current?.limits?.unlimited === true);

  const file = path.join(dir, 'prueba.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH ?? require('ffmpeg-static'), ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const buf = readFileSync(file);
  const it = await call('POST', '/v1/media/upload-intents', { filename: 'prueba.mp4', size: buf.length });
  for (let n = 1; n <= (it.json?.partCount ?? 0); n++) await call('PUT', `/v1/media/${it.json.mediaId}/parts/${n}`, null, buf.subarray((n - 1) * it.json.partSize, n * it.json.partSize));
  const done = await call('POST', `/v1/media/${it.json?.mediaId}/complete`);
  check('Subida multipart a R2', it.status === 201 && done.status === 200 && done.json?.status === 'queued');
  let m = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 180_000) {
    m = (await call('GET', `/v1/media/${it.json.mediaId}`)).json;
    if (m?.status === 'ready' || m?.status === 'failed') break;
    await sleep(2000);
  }
  check('Motor: análisis y conversión del vídeo', m?.status === 'ready' && m?.videoCodec === 'h264' && m?.width === 1280, `${m?.status} en ${Math.round((Date.now() - t0) / 1000)} s${m?.error ? ` · ${m.error.message}` : ''}`);
  const th = await fetch(`${API}/v1/media/${it.json.mediaId}/thumbnail`, { headers: { cookie } });
  check('Miniatura servida desde R2 (privado)', th.status === 200 && th.headers.get('content-type') === 'image/jpeg');
  check('Miniatura inaccesible sin sesión', (await fetch(`${API}/v1/media/${it.json.mediaId}/thumbnail`)).status === 401);

  const pl = await call('POST', '/v1/playlists', { name: 'Humo' });
  await call('PUT', `/v1/playlists/${pl.json.id}`, { items: [{ mediaId: it.json.mediaId }] });
  const pub = await call('POST', `/v1/playlists/${pl.json.id}/publish`);
  check('Playlist publicada', pub.status === 200 && pub.json?.published?.version === 1);
  const local = await call('POST', '/v1/destinations', { name: 'x', url: 'rtmp://127.0.0.1/live', streamKey: 'k', allowInsecure: true });
  check('Producción bloquea destinos en redes privadas', local.status === 422, local.json?.error?.code);
  const key = `smoke-${randomBytes(6).toString('hex')}`;
  const dst = await call('POST', '/v1/destinations', { name: 'YouTube (prueba)', platform: 'youtube', url: 'rtmps://a.rtmps.youtube.com/live2', streamKey: key });
  check('Destino con clave cifrada y enmascarada', dst.status === 201 && !JSON.stringify(dst.json).includes(key) && dst.json?.streamKeyMasked?.endsWith(key.slice(-4)));
  const st = await call('POST', '/v1/streams', { name: 'Humo', playlistId: pl.json.id, mode: 'loop', profile: '720p30', destinationIds: [dst.json.id] });
  check('Emisión creada y lista para iniciar', st.status === 201 && st.json?.status === 'ready');
  const ov = await call('GET', '/v1/overview');
  check('Resumen: datos reales y audiencia «no disponible»', ov.status === 200 && ov.json?.audience?.available === false && ov.json?.storage?.files === 1);
  const csrf = await fetch(`${API}/v1/streams/${st.json.id}/start`, { method: 'POST', headers: { cookie } });
  check('Mutación sin cabecera anti-CSRF rechazada', csrf.status === 403);
} catch (e) {
  check('ejecución completa', false, String(e));
} finally {
  console.log('\n▶ Limpieza de la cuenta temporal');
  try {
    if (cookie && orgId) {
      for (const s of (await call('GET', '/v1/streams')).json?.items ?? []) await call('DELETE', `/v1/streams/${s.id}`);
      for (const p of (await call('GET', '/v1/playlists')).json?.items ?? []) await call('DELETE', `/v1/playlists/${p.id}`);
      for (const d of (await call('GET', '/v1/destinations')).json?.items ?? []) await call('DELETE', `/v1/destinations/${d.id}`);
      for (const m of (await call('GET', '/v1/media')).json?.items ?? []) await call('DELETE', `/v1/media/${m.id}`); // borra también los objetos de R2
    }
    if (orgId && userId && /^org_[0-9a-f]+$/.test(orgId) && /^usr_[0-9a-f]+$/.test(userId)) {
      d1(`DELETE FROM organizations WHERE id = '${orgId}'; DELETE FROM users WHERE id = '${userId}' AND email LIKE 'smoke-%@example.test'; DELETE FROM audit_logs WHERE organization_id = '${orgId}';`);
    }
    console.log('  ✓ cuenta, archivos y registros de la prueba eliminados');
  } catch (e) { console.log(`  ✖ limpieza incompleta: ${e instanceof Error ? e.message.slice(0, 200) : e}`); }
}
const failed = results.filter((r) => !r).length;
console.log(`\n═══ ${results.length - failed} PASS · ${failed} FAIL ═══`);
process.exit(failed ? 1 : 0);
