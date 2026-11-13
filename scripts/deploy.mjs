#!/usr/bin/env node
/**
 * Despliegue completo en Cloudflare con un solo comando: pnpm deploy:cloudflare
 *
 *   D1 (crear + migrar) → R2 (crear) → secretos → build web + motor → artefactos del motor a R2 (por SHA-256)
 *   → wrangler deploy (Worker + assets + Containers) → comprobación de salud.
 *
 * Idempotente: se puede relanzar tras cada cambio. Requisitos de la cuenta (solo el titular puede activarlos):
 * R2 habilitado y plan Workers Paid (Cloudflare Containers lo exige). No necesita Docker.
 * Los secretos generados se guardan en .data/prod/secrets.json (ignorado por git): HAZ COPIA de ese archivo,
 * sin ENCRYPTION_KEY las claves de emisión guardadas no se pueden descifrar.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const api = path.join(root, 'apps/api');
const state = path.join(root, '.data', 'prod');
mkdirSync(state, { recursive: true });
const DB_NAME = 'dni-directos', BUCKET = 'dni-directos-media', FFMPEG_RELEASE = 'b6.1.1';
const wranglerBin = path.join(api, 'node_modules/wrangler/bin/wrangler.js');

function wrangler(args, { input, allowFail = false } = {}) {
  try {
    return execFileSync(process.execPath, [wranglerBin, ...args], { cwd: api, encoding: 'utf8', input, env: { ...process.env, CI: '1' }, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    if (allowFail) return `__FAILED__\n${out}`;
    throw new Error(`wrangler ${args.slice(0, 3).join(' ')} falló:\n${out.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n')}`, { cause: e });
  }
}
const step = (t) => console.log(`\n▶ ${t}`);
const fail = (msg) => { console.error(`\n✖ ${msg}\n`); process.exit(2); };
const loadJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);

step('Cuenta de Cloudflare');
if (wrangler(['whoami'], { allowFail: true }).includes('not authenticated')) fail('Wrangler no está autenticado. Ejecuta: pnpm --filter @dni/api exec wrangler login');
console.log('  ✓ autenticado');

step('Base de datos D1');
let dbs = JSON.parse(wrangler(['d1', 'list', '--json']));
let db = dbs.find((d) => d.name === DB_NAME);
if (!db) {
  wrangler(['d1', 'create', DB_NAME]);
  db = JSON.parse(wrangler(['d1', 'list', '--json'])).find((d) => d.name === DB_NAME);
  console.log('  ✓ creada');
} else console.log('  • ya existía');
const cfgPath = path.join(api, 'wrangler.jsonc');
let cfg = readFileSync(cfgPath, 'utf8');
const marker = /("database_name": "dni-directos", "database_id": ")(?!00000000-0000)[^"]+(")/;
if (!marker.test(cfg)) fail('No se encontró el database_id de producción en wrangler.jsonc.');
cfg = cfg.replace(marker, `$1${db.uuid}$2`);
writeFileSync(cfgPath, cfg);

step('Almacenamiento R2');
const buckets = wrangler(['r2', 'bucket', 'list'], { allowFail: true });
if (buckets.includes('10042')) {
  fail('R2 no está activado en la cuenta. Actívalo en https://dash.cloudflare.com/?to=/:account/r2 (pide un método de pago; incluye 10 GB gratis al mes) y vuelve a ejecutar pnpm deploy:cloudflare.');
}
if (buckets.startsWith('__FAILED__')) fail(buckets);
if (!buckets.includes(BUCKET)) { wrangler(['r2', 'bucket', 'create', BUCKET]); console.log('  ✓ bucket privado creado'); } else console.log('  • ya existía');

step('Migraciones');
wrangler(['d1', 'migrations', 'apply', 'DB', '--remote', '--env', 'production']);
console.log('  ✓ aplicadas');

step('Compilación (web + motor)');
execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

step('Artefactos del motor en R2 (direccionados por SHA-256)');
const linux = path.join(root, '.tools', 'linux');
mkdirSync(linux, { recursive: true });
const pinned = loadJson(path.join(root, 'infra', 'engine-binaries.json'), {});
const assets = {};
for (const [name, file] of [['index.mjs', path.join(root, 'apps/engine/dist/index.mjs')], ['ffmpeg.gz', path.join(linux, 'ffmpeg-linux-x64.gz')], ['ffprobe.gz', path.join(linux, 'ffprobe-linux-x64.gz')]]) {
  if (!existsSync(file)) {
    const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_RELEASE}/${path.basename(file)}`;
    console.log(`  ↓ ${url}`);
    writeFileSync(file, Buffer.from(await (await fetch(url)).arrayBuffer()));
  }
  const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
  // Los binarios de FFmpeg se fijan por hash en el repositorio: un binario distinto detiene el despliegue.
  if (name !== 'index.mjs') {
    if (pinned[name] && pinned[name] !== sha) fail(`El SHA-256 de ${name} no coincide con infra/engine-binaries.json (esperado ${pinned[name]}, obtenido ${sha}).`);
    pinned[name] = sha;
  }
  assets[name] = sha;
  const uploaded = loadJson(path.join(state, 'uploaded.json'), []);
  if (!uploaded.includes(sha)) {
    wrangler(['r2', 'object', 'put', `${BUCKET}/system/engine/${sha}`, '--file', file, '--remote']);
    writeFileSync(path.join(state, 'uploaded.json'), JSON.stringify([...uploaded, sha]));
    console.log(`  ✓ ${name} subido (${sha.slice(0, 12)}…)`);
  } else console.log(`  • ${name} ya estaba (${sha.slice(0, 12)}…)`);
}
writeFileSync(path.join(root, 'infra', 'engine-binaries.json'), `${JSON.stringify({ release: FFMPEG_RELEASE, 'ffmpeg.gz': pinned['ffmpeg.gz'], 'ffprobe.gz': pinned['ffprobe.gz'] }, null, 2)}\n`);

let containersOk = true;
function deploy(publicUrl) {
  const vars = ['--var', `ENGINE_ASSETS:${JSON.stringify(assets)}`];
  if (publicUrl) vars.push('--var', `PUBLIC_URL:${publicUrl}`, '--var', `APP_ORIGINS:${publicUrl}`);
  let out = containersOk ? wrangler(['deploy', '--env', 'production', ...vars], { allowFail: true }) : '__FAILED__ Unauthorized container';
  if (out.startsWith('__FAILED__') && /Unauthorized/.test(out) && /container/i.test(out)) {
    // La cuenta no puede crear aplicaciones de Containers: se publica todo lo demás y el motor queda pendiente.
    containersOk = false;
    out = wrangler(['deploy', '--env', 'production', '--containers-rollout', 'none', ...vars], { allowFail: true });
  }
  if (out.startsWith('__FAILED__')) {
    if (/containers?/i.test(out) && /(paid|plan|subscription|upgrade)/i.test(out)) {
      fail('Cloudflare Containers requiere el plan Workers Paid. Actívalo en https://dash.cloudflare.com/?to=/:account/workers/plans y vuelve a ejecutar pnpm deploy:cloudflare.');
    }
    fail(out.split('\n').filter((l) => l.trim()).slice(0, 25).join('\n'));
  }
  return out;
}

step('Publicación del Worker');
const prod = loadJson(path.join(state, 'deployment.json'), {});
let url = process.env.PUBLIC_URL ?? prod.url;
const out = deploy(url);
if (!url) {
  url = /https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/.exec(out)?.[0];
  if (!url) fail(`No se pudo determinar la URL pública.\n${out}`);
  // Segunda publicación: el Worker necesita conocer su propia URL para dársela a los nodos de emisión.
  deploy(url);
}
writeFileSync(path.join(state, 'deployment.json'), JSON.stringify({ url, databaseId: db.uuid, deployedAt: new Date().toISOString() }, null, 2));
console.log(`  ✓ ${url}`);

step('Secretos');
const secretsFile = path.join(state, 'secrets.json');
const existing = wrangler(['secret', 'list', '--env', 'production'], { allowFail: true });
if (!existing.includes('ENGINE_TOKEN') || !existing.includes('ENCRYPTION_KEY')) {
  const secrets = loadJson(secretsFile, { ENGINE_TOKEN: randomBytes(32).toString('base64url'), ENCRYPTION_KEY: randomBytes(32).toString('base64') });
  writeFileSync(secretsFile, JSON.stringify(secrets, null, 2));
  wrangler(['secret', 'bulk', secretsFile, '--env', 'production']);
  console.log('  ✓ ENGINE_TOKEN y ENCRYPTION_KEY configurados (copia local en .data/prod/secrets.json: guárdala en lugar seguro)');
} else console.log('  • ya configurados');

step('Comprobación');
let ok = false;
for (let i = 0; i < 10 && !ok; i++) {
  ok = await fetch(`${url}/healthz`).then((r) => r.ok).catch(() => false);
  if (!ok) await new Promise((r) => setTimeout(r, 3000));
}
if (!ok) fail(`${url}/healthz no responde todavía. Revisa: pnpm --filter @dni/api exec wrangler tail --env production`);
console.log(`  ✓ ${url}/healthz responde\n\n═══ Desplegado: ${url} ═══\n`);
if (containersOk) {
  // Renueva los nodos encendidos con la versión nueva del motor (apagado ordenado: las emisiones se reanudan solas).
  const { ENGINE_TOKEN } = loadJson(secretsFile, {});
  if (ENGINE_TOKEN) {
    const r = await fetch(`${url}/internal/engine/nodes?action=rollout`, { headers: { authorization: `Bearer ${ENGINE_TOKEN}` } }).then((x) => x.json()).catch(() => null);
    const n = r?.nodes?.filter((x) => x.restarted).length ?? 0;
    console.log(`  ✓ motor en Cloudflare Containers${n ? ` (${n} nodo(s) renovados con la versión nueva)` : ''}`);
  }
}
if (!containersOk) {
  console.log([
    '', '⚠ Cloudflare rechazó la aplicación de Containers (401 Unauthorized): la cuenta no tiene acceso a Containers',
    '  (requiere el plan Workers Paid). La web y la API están publicadas, pero el motor NO corre en Cloudflare.',
    '  Mientras tanto: pnpm engine:prod  (ejecuta el motor en este equipo contra producción).', '',
  ].join('\n'));
}
