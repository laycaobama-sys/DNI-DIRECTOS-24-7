#!/usr/bin/env node
/**
 * Cargador del nodo de emisión en un servidor dedicado (camino híbrido).
 * Descarga de la API el motor publicado (verificado por SHA-256), lo ejecuta con el FFmpeg del sistema y lo
 * recarga solo cuando se despliega una versión nueva (el motor sale con código 75). Sin dependencias.
 *
 * Variables (en /etc/dni-node.env): API_URL, ENGINE_TOKEN, NODE_ID, CAPACITY, MEDIA_CONCURRENCY, DATA_DIR.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const API_URL = (process.env.API_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.ENGINE_TOKEN ?? '';
const DATA = process.env.DATA_DIR ?? '/var/lib/dni-node';
if (!API_URL || TOKEN.length < 24) { console.error('Faltan API_URL o ENGINE_TOKEN en /etc/dni-node.env'); process.exit(1); }
const ffmpeg = process.env.FFMPEG_PATH ?? '/usr/bin/ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? '/usr/bin/ffprobe';
if (!existsSync(ffmpeg) || !existsSync(ffprobe)) { console.error(`FFmpeg no encontrado (${ffmpeg}). Instálalo: apt-get install -y ffmpeg`); process.exit(1); }
mkdirSync(DATA, { recursive: true });
const bundle = path.join(DATA, 'engine.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download() {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(`${API_URL}/internal/engine/assets/index.mjs`, { headers: { authorization: `Bearer ${TOKEN}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      const want = r.headers.get('x-sha256');
      const got = createHash('sha256').update(buf).digest('hex');
      if (!want || want !== got) throw new Error('el SHA-256 del motor no coincide');
      writeFileSync(bundle, buf);
      return got;
    } catch (e) {
      console.error(`dni-node: no se pudo descargar el motor (${e.message}); reintento`);
      await sleep(Math.min(60_000, 2000 * (i + 1)));
    }
  }
}

let child = null;
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { if (child) child.kill(s); else process.exit(0); });

for (let crashes = 0; ;) {
  const sha = await download();
  console.log(`dni-node: motor ${sha.slice(0, 12)} verificado; arrancando`);
  const started = Date.now();
  child = spawn(process.execPath, [bundle], {
    stdio: 'inherit',
    env: { ...process.env, FFMPEG_PATH: ffmpeg, FFPROBE_PATH: ffprobe, DATA_DIR: path.join(DATA, 'engine'), ENGINE_SELF_UPDATE: '1', PORT: '' },
  });
  const code = await new Promise((r) => child.on('exit', (c) => r(c)));
  child = null;
  if (code === 0) process.exit(0);           // parada ordenada (systemctl stop)
  if (code === 75) { crashes = 0; continue; } // versión nueva publicada: se descarga y se relanza
  crashes = Date.now() - started > 600_000 ? 1 : crashes + 1;
  console.error(`dni-node: el motor terminó con código ${code}; reinicio en ${Math.min(60, 2 ** crashes)} s`);
  await sleep(Math.min(60, 2 ** crashes) * 1000);
}
