#!/usr/bin/env node
/**
 * Prepara el entorno local SIN Docker:
 *  - genera apps/api/.dev.vars con secretos aleatorios (si no existe)
 *  - descarga MediaMTX (servidor RTMP de pruebas) desde su release oficial de GitHub, verificando SHA-256
 *  - aplica las migraciones D1 locales
 */
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MEDIAMTX = 'v1.21.3';

const devVars = path.join(root, 'apps/api/.dev.vars');
if (!existsSync(devVars)) {
  writeFileSync(devVars, `ENGINE_TOKEN=${randomBytes(32).toString('base64url')}\nENCRYPTION_KEY=${randomBytes(32).toString('base64')}\n`);
  console.log('✓ apps/api/.dev.vars generado con secretos aleatorios');
} else console.log('• apps/api/.dev.vars ya existe');

const tools = path.join(root, '.tools');
const exe = path.join(tools, process.platform === 'win32' ? 'mediamtx.exe' : 'mediamtx');
if (!existsSync(exe)) {
  const plat = { win32: 'windows', linux: 'linux', darwin: 'darwin' }[process.platform];
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  if (!plat || !arch) throw new Error(`Plataforma no soportada: ${process.platform}/${process.arch}`);
  const ext = plat === 'windows' ? 'zip' : 'tar.gz';
  const name = `mediamtx_${MEDIAMTX}_${plat}_${arch}.${ext}`;
  const base = `https://github.com/bluenviron/mediamtx/releases/download/${MEDIAMTX}`;
  mkdirSync(tools, { recursive: true });
  console.log(`↓ ${name}`);
  const buf = Buffer.from(await (await fetch(`${base}/${name}`)).arrayBuffer());
  const sums = await (await fetch(`${base}/checksums.sha256`)).text();
  const expected = sums.split('\n').find((l) => l.trim().endsWith(name))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(buf).digest('hex');
  if (!expected || expected !== actual) throw new Error(`SHA-256 no coincide para ${name} (esperado ${expected}, obtenido ${actual})`);
  const archive = path.join(tools, name);
  writeFileSync(archive, buf);
  // bsdtar (incluido en Windows 10+, macOS y Linux) extrae zip y tar.gz.
  // En Windows se fuerza el bsdtar del sistema: el tar de Git Bash no abre zip ni rutas con unidad.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  execFileSync(tar, ['-xf', archive, '-C', tools], { stdio: 'inherit' });
  rmSync(archive);
  console.log(`✓ MediaMTX ${MEDIAMTX} verificado (sha256 ${actual.slice(0, 12)}…) en .tools/`);
} else console.log('• MediaMTX ya instalado');

execSync('pnpm --filter @dni/api exec wrangler d1 migrations apply DB --local', { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
console.log('✓ Migraciones D1 locales aplicadas');
