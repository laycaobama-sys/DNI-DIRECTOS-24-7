#!/usr/bin/env node
/**
 * Ejecuta el motor de emisión en ESTE equipo contra la plataforma desplegada en Cloudflare.
 * Solución puente mientras la cuenta no tenga Cloudflare Containers: la web, la API, la base de datos y los
 * archivos están en Cloudflare; solo FFmpeg corre aquí, así que este equipo debe seguir encendido para emitir.
 * Uso: pnpm engine:prod      (requiere haber desplegado antes con pnpm deploy:cloudflare)
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dep = path.join(root, '.data/prod/deployment.json'), sec = path.join(root, '.data/prod/secrets.json');
if (!existsSync(dep) || !existsSync(sec)) { console.error('Falta el despliegue: ejecuta primero pnpm deploy:cloudflare'); process.exit(1); }
const { url } = JSON.parse(readFileSync(dep, 'utf8'));
const { ENGINE_TOKEN } = JSON.parse(readFileSync(sec, 'utf8'));
console.log(`Motor local → ${url}\nDeja esta ventana abierta mientras quieras emitir. Ctrl+C para detener.\n`);
const p = spawn(process.execPath, ['--import', 'tsx', 'apps/engine/src/index.ts'], {
  cwd: root, stdio: 'inherit',
  env: {
    ...process.env, API_URL: url, ENGINE_TOKEN, NODE_ID: 'pc-local', CAPACITY: process.env.CAPACITY ?? '4', DATA_DIR: path.join(root, '.data/prod/engine'),
    FFMPEG_PATH: process.env.FFMPEG_PATH ?? require('ffmpeg-static'), FFPROBE_PATH: process.env.FFPROBE_PATH ?? require('ffprobe-static').path,
  },
});
process.on('SIGINT', () => p.kill('SIGINT'));
p.on('exit', (code) => process.exit(code ?? 0));
