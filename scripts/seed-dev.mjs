#!/usr/bin/env node
/**
 * Datos de demostración para el entorno LOCAL (requiere `pnpm dev` en marcha):
 * cuenta de prueba, 3 vídeos sintéticos generados con FFmpeg, playlist publicada, destino RTMP local y una emisión lista.
 * Las credenciales generadas se guardan en .data/dev/seed-account.json (ignorado por git).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const dir = path.join(root, '.data', 'dev', 'seed');
mkdirSync(dir, { recursive: true });
const ffmpeg = process.env.FFMPEG_PATH ?? require('ffmpeg-static');

let cookie = '';
async function call(method, p, body, raw) {
  const res = await fetch(API + p, { method, headers: { 'x-requested-with': 'seed', ...(cookie ? { cookie } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : body ? { 'content-type': 'application/json' } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${json?.error?.message ?? ''}`);
  return json;
}

const account = { email: `demo-${randomBytes(3).toString('hex')}@example.test`, password: randomBytes(12).toString('base64url') };
await call('POST', '/v1/auth/register', { ...account, name: 'Demo', organizationName: 'Canal de demostración' });
writeFileSync(path.join(root, '.data', 'dev', 'seed-account.json'), JSON.stringify(account, null, 2));

const clips = [['Intro (carta de ajuste).mp4', 'testsrc2=s=1280x720:r=30', 440, 12], ['Barras de color.mp4', 'smptebars=s=1280x720:r=30', 660, 10], ['Patrón RGB.mp4', 'rgbtestsrc=s=1280x720:r=30', 880, 8]];
const ids = [];
for (const [name, src, hz, secs] of clips) {
  const file = path.join(dir, name);
  // Asíncrono: bloquear el event loop haría que la API cerrase la conexión keep-alive en reposo.
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', src, '-f', 'lavfi', '-i', `sine=f=${hz}`, '-t', String(secs), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file]);
  const buf = readFileSync(file);
  const it = await call('POST', '/v1/media/upload-intents', { filename: name, size: buf.length });
  for (let n = 1; n <= it.partCount; n++) await call('PUT', `/v1/media/${it.mediaId}/parts/${n}`, null, buf.subarray((n - 1) * it.partSize, n * it.partSize));
  await call('POST', `/v1/media/${it.mediaId}/complete`);
  ids.push(it.mediaId);
  console.log(`✓ subido ${name}`);
}
process.stdout.write('… procesando');
for (;;) {
  const { items } = await call('GET', '/v1/media');
  if (items.every((m) => m.status === 'ready' || m.status === 'failed')) break;
  process.stdout.write('.');
  await new Promise((r) => setTimeout(r, 1500));
}
const pl = await call('POST', '/v1/playlists', { name: 'Programación de demostración' });
await call('PUT', `/v1/playlists/${pl.id}`, { items: ids.map((mediaId) => ({ mediaId })) });
await call('POST', `/v1/playlists/${pl.id}/publish`);
const dst = await call('POST', '/v1/destinations', { name: 'Ingest local de pruebas', platform: 'custom', url: 'rtmp://127.0.0.1:1935/live', streamKey: `demo-${randomBytes(4).toString('hex')}`, allowInsecure: true });
const st = await call('POST', '/v1/streams', { name: 'Canal 24/7 de demostración', playlistId: pl.id, mode: 'loop', profile: '720p30', destinationIds: [dst.id] });
console.log(`\n✓ Emisión creada (${st.id}). Credenciales de la cuenta de prueba en .data/dev/seed-account.json`);
