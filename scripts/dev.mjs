#!/usr/bin/env node
/**
 * Stack local completo sin Docker: API (wrangler dev :8787) + motor FFmpeg + ingest RTMP de pruebas (:1935) + web (:5173).
 * Uso: pnpm dev            (añade --no-web para omitir Vite)
 * Destino de prueba para tus emisiones: rtmp://127.0.0.1:1935/live  con cualquier clave.
 * Ver la señal: ffplay rtmp://127.0.0.1:1935/live/<clave>
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const devVars = path.join(root, 'apps/api/.dev.vars');
const mtx = path.join(root, '.tools', process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
if (!existsSync(devVars) || !existsSync(mtx)) { console.error('Falta la preparación inicial. Ejecuta primero: pnpm tools:setup'); process.exit(1); }
const token = /ENGINE_TOKEN=(.+)/.exec(readFileSync(devVars, 'utf8'))[1].trim();
const data = path.join(root, '.data', 'dev');
mkdirSync(data, { recursive: true });
writeFileSync(path.join(data, 'mediamtx.yml'), 'logLevel: warn\nrtmp: yes\nrtmpAddress: :1935\nrtsp: no\nhls: no\nwebrtc: no\nsrt: no\nmoq: no\napi: no\nmetrics: no\npprof: no\nplayback: no\npaths:\n  all_others:\n');

const children = [];
function run(name, color, bin, args, opts = {}) {
  const p = spawn(bin, args, { cwd: opts.cwd ?? root, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  const pipe = (s) => s.on('data', (d) => d.toString().split(/\r?\n/).filter((l) => l.trim()).forEach((l) => console.log(tag + l)));
  pipe(p.stdout); pipe(p.stderr);
  p.on('exit', (code) => { console.log(`${tag}terminó (código ${code})`); shutdown(); });
  children.push(p);
}
let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  for (const p of children) {
    if (p.exitCode !== null || !p.pid) continue;
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore' });
      else p.kill('SIGTERM');
    } catch { /* ya terminado */ }
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const node = process.execPath;
run('rtmp', 35, mtx, [path.join(data, 'mediamtx.yml')], { cwd: data });
run('api', 36, node, [path.join(root, 'apps/api/node_modules/wrangler/bin/wrangler.js'), 'dev', '--port', '8787', '--show-interactive-dev-session=false'], { cwd: path.join(root, 'apps/api'), env: { CI: '1' } });
run('engine', 33, node, ['--import', 'tsx', 'apps/engine/src/index.ts'], {
  env: { API_URL: 'http://127.0.0.1:8787', ENGINE_TOKEN: token, ALLOW_PRIVATE_DESTINATIONS: 'true', DATA_DIR: path.join(data, 'engine'), FFMPEG_PATH: process.env.FFMPEG_PATH ?? require('ffmpeg-static'), FFPROBE_PATH: process.env.FFPROBE_PATH ?? require('ffprobe-static').path },
});
if (!process.argv.includes('--no-web')) run('web', 32, node, [path.join(root, 'apps/web/node_modules/vite/bin/vite.js'), '--host', '127.0.0.1'], { cwd: path.join(root, 'apps/web') });
console.log('\n  Web:   http://localhost:5173\n  API:   http://127.0.0.1:8787\n  RTMP:  rtmp://127.0.0.1:1935/live/<clave>\n');
