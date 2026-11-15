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
  if (process.argv.includes('--egress')) {
    // Comprobación de salida RTMPS desde el motor: se emite unos segundos a YouTube con una clave INVENTADA.
    // YouTube no la asocia a ningún canal; solo interesa saber si la conexión TLS/RTMP llega a establecerse.
    console.log('\n▶ Salida RTMPS desde el motor (clave inventada)');
    const started = await call('POST', `/v1/streams/${st.json.id}/start`);
    const seen = new Set();
    let last = null, node = null;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      last = (await call('GET', `/v1/streams/${st.json.id}`)).json;
      const d = last?.destinations?.[0];
      if (d) seen.add(`${last.status}/${d.state}${d.lastError ? ` [${d.lastError}]` : ''}`);
      if (d?.state === 'live' && i > 8) break;
    }
    const ev = (await call('GET', `/v1/streams/${st.json.id}/events?limit=50`)).json?.items ?? [];
    node = ev.find((e) => e.type === 'claimed')?.message;
    console.log(`  estados observados: ${[...seen].join(' → ')}`);
    check('El motor reclama la emisión', started.status === 200 && !!node, node ?? 'ningún nodo la reclamó');
    // Con una clave inventada YouTube puede cortar tras el saludo TLS: el relé solo da «cerró la conexión al empezar» si el TLS llegó a establecerse.
    const tlsOk = [...seen].some((s) => s.includes('/live') || s.includes('cerró la conexión al empezar'));
    check('Conexión RTMPS (TLS) con YouTube desde el motor; la clave inventada se rechaza como debe', tlsOk, [...seen].some((s) => s.includes('/live')) ? `bitrate ${last?.destinations?.[0]?.bitrateKbps ?? '—'} kb/s` : 'TLS establecido, YouTube rechaza la clave inventada');

    console.log('\n▶ Vista previa, grabación en la nube y miniatura (en Cloudflare)');
    const bin = async (u, h = {}) => { const r = await fetch(API + u, { headers: { cookie, ...h } }); return { status: r.status, buf: Buffer.from(await r.arrayBuffer()), headers: r.headers }; };
    const isTs = (b) => b.length >= 188 * 4 && b[0] === 0x47 && b[188] === 0x47 && b[376] === 0x47;
    const rec = await call('PATCH', `/v1/streams/${st.json.id}`, { recordingMode: 'auto', recordingRetentionDays: 1 });
    check('Grabación activada en pleno directo', rec.status === 200 && rec.json?.recording?.mode === 'auto');
    let m3u = null;
    for (let i = 0; i < 20 && !m3u; i++) { const r = await fetch(`${API}/v1/streams/${st.json.id}/preview.m3u8`, { headers: { cookie } }); if (r.status === 200) m3u = await r.text(); else await sleep(2000); }
    const seg = m3u && /^(preview\/\d+\.ts)$/m.exec(m3u)?.[1];
    const pv = seg ? await bin(`/v1/streams/${st.json.id}/${seg}`) : null;
    check('Vista previa HLS generada por el motor en la nube', !!pv && pv.status === 200 && isTs(pv.buf), pv ? `${(pv.buf.length / 1024).toFixed(0)} KB por fragmento` : 'sin playlist');
    const jpg = Buffer.from(await (await fetch(`${API}/v1/media/${it.json.mediaId}/thumbnail`, { headers: { cookie } })).arrayBuffer());
    const th = await call('PUT', `/v1/thumbnails/stream/${st.json.id}`, undefined, jpg);
    check('Miniatura de la emisión guardada en R2', th.status === 200 && (await bin(`/v1/thumbnails/stream/${st.json.id}`)).status === 200);
    let r0 = null;
    for (let i = 0; i < 80; i++) { await sleep(3000); r0 = (await call('GET', '/v1/recordings')).json?.items?.[0]; if (r0?.segments >= 1) break; }
    check('Fragmento de 60 s grabado y subido a R2 por partes', r0?.segments >= 1 && r0.durationSec > 50, r0 ? `${r0.segments} fragmento(s) · ${r0.durationSec.toFixed(1)} s · ${(r0.sizeBytes / 1e6).toFixed(1)} MB` : 'ninguno');
    if (r0) {
      const s0 = await bin(`/v1/recordings/${r0.id}/segments/0.ts`, { range: 'bytes=0-4095' });
      check('El fragmento grabado se reproduce desde R2 (Range)', s0.status === 206 && isTs(s0.buf));
      await call('PATCH', `/v1/streams/${st.json.id}`, { recordingMode: 'off' });
      let done = null;
      for (let i = 0; i < 30; i++) { await sleep(2000); done = (await call('GET', `/v1/recordings/${r0.id}`)).json; if (done?.status === 'ready') break; }
      const ex = await call('POST', `/v1/recordings/${r0.id}/export`, {});
      let exd = null;
      for (let i = 0; i < 60 && ex.status === 202; i++) { await sleep(3000); exd = (await call('GET', `/v1/recordings/${r0.id}`)).json; if (exd?.export?.status === 'ready' || exd?.export?.status === 'failed') break; }
      const mp4 = exd?.export?.status === 'ready' ? await bin(`/v1/recordings/${r0.id}/download`, { range: 'bytes=0-63' }) : null;
      check('Exportación a MP4 en la nube y descarga', !!mp4 && mp4.status === 206 && mp4.buf.subarray(4, 8).toString() === 'ftyp', exd?.export?.error ?? `${done?.segments} fragmento(s)`);
      await call('DELETE', `/v1/recordings/${r0.id}`); // borra también sus objetos de R2
    }
    await call('POST', `/v1/streams/${st.json.id}/stop`);
    for (let i = 0; i < 20; i++) { await sleep(1500); if ((await call('GET', `/v1/streams/${st.json.id}`)).json?.status === 'stopped') break; }
    check('Detención confirmada', (await call('GET', `/v1/streams/${st.json.id}`)).json?.status === 'stopped');
  }
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
