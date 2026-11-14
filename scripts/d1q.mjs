#!/usr/bin/env node
/** Consulta de solo lectura a la D1 de producción con salida legible: node scripts/d1q.mjs "SELECT ..." */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = process.argv[2];
if (!sql || !/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) { console.error('Solo consultas SELECT.'); process.exit(1); }
const out = execFileSync(process.execPath, [path.join(root, 'apps/api/node_modules/wrangler/bin/wrangler.js'), 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--json', '--command', sql],
  { cwd: path.join(root, 'apps/api'), encoding: 'utf8', env: { ...process.env, CI: '1' }, maxBuffer: 32 * 1024 * 1024 });
const rows = JSON.parse(out.slice(out.indexOf('[')))[0].results;
console.table(rows);
