#!/usr/bin/env node
/**
 * Genera el pack de marca a partir de SVG vectoriales:
 *   apps/web/public  → favicon.svg, iconos PNG (PWA, Apple), og-image.png (1200×630) para redes y buscadores
 *   docs/brand       → logotipos (símbolo, horizontal claro/oscuro, monocromo) en SVG y PNG
 * Uso: node scripts/brand-assets.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pub = path.join(root, 'apps/web/public');
const brand = path.join(root, 'docs/brand');
mkdirSync(path.join(pub, 'brand'), { recursive: true });
mkdirSync(brand, { recursive: true });

const GRAD = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff4f2e"/><stop offset=".55" stop-color="#ff8a3d"/><stop offset="1" stop-color="#ffb020"/></linearGradient>`;
/** Símbolo dibujado en una caja de 48 unidades; `bg` = fondo del cuadro, `fg` = color plano opcional (monocromo). */
const markPaths = (g, fg) => {
  const c = fg ?? `url(#${g})`;
  return `<circle cx="24" cy="24" r="5.5" fill="${c}"/>
  <path d="M15.5 15.5a12 12 0 0 0 0 17M32.5 15.5a12 12 0 0 1 0 17" fill="none" stroke="${c}" stroke-width="3" stroke-linecap="round"/>
  <path d="M10 10a19.8 19.8 0 0 0 0 28M38 10a19.8 19.8 0 0 1 0 28" fill="none" stroke="${c}" stroke-opacity=".45" stroke-width="2.4" stroke-linecap="round"/>`;
};
const mark = (size, { bg = '#0b0d13', radius = 13, fg, pad = 0 } = {}) => {
  const s = 48 + pad * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${-pad} ${-pad} ${s} ${s}"><defs>${GRAD('g')}</defs>
  ${bg ? `<rect x="${-pad}" y="${-pad}" width="${s}" height="${s}" rx="${pad ? 0 : radius}" fill="${bg}"/>` : ''}
  ${bg && !pad ? `<rect x=".75" y=".75" width="46.5" height="46.5" rx="12.25" fill="none" stroke="url(#g)" stroke-opacity=".35" stroke-width="1.5"/>` : ''}
  ${markPaths('g', fg)}</svg>`;
};
// Texto convertido con fuentes del sistema al rasterizar; en los SVG publicados se usa Inter/Segoe con alternativas.
const FONT = `font-family="Inter, 'Segoe UI', Arial, sans-serif"`;
const wordmark = (theme) => {
  const ink = theme === 'dark' ? '#ffffff' : '#0b0d13', soft = theme === 'dark' ? '#9aa1b2' : '#5b6274';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="128" viewBox="0 0 640 128"><defs>${GRAD('g')}${GRAD('t')}</defs>
  ${theme === 'dark' ? '<rect width="640" height="128" fill="#07080c"/>' : ''}
  <g transform="translate(16 16) scale(2)"><rect width="48" height="48" rx="13" fill="#0b0d13"/>${markPaths('g')}</g>
  <text xml:space="preserve" x="132" y="82" ${FONT} font-size="52" font-weight="800" letter-spacing="-1.5" fill="${ink}">DNI<tspan fill="${soft}" font-weight="500"> Directos</tspan> <tspan fill="url(#t)">24/7</tspan></text></svg>`;
};
const og = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>${GRAD('g')}${GRAD('t')}
    <radialGradient id="a" cx="15%" cy="0%" r="70%"><stop offset="0" stop-color="#ff4f2e" stop-opacity=".55"/><stop offset="1" stop-color="#ff4f2e" stop-opacity="0"/></radialGradient>
    <radialGradient id="b" cx="95%" cy="10%" r="60%"><stop offset="0" stop-color="#7c5cff" stop-opacity=".45"/><stop offset="1" stop-color="#7c5cff" stop-opacity="0"/></radialGradient>
    <pattern id="grid" width="56" height="56" patternUnits="userSpaceOnUse"><path d="M56 0H0V56" fill="none" stroke="#ffffff" stroke-opacity=".05"/></pattern>
  </defs>
  <rect width="1200" height="630" fill="#07080c"/><rect width="1200" height="630" fill="url(#grid)"/><rect width="1200" height="630" fill="url(#a)"/><rect width="1200" height="630" fill="url(#b)"/>
  <g transform="translate(80 72) scale(1.6)"><rect width="48" height="48" rx="13" fill="#0b0d13"/><rect x=".75" y=".75" width="46.5" height="46.5" rx="12.25" fill="none" stroke="url(#g)" stroke-opacity=".4" stroke-width="1.5"/>${markPaths('g')}</g>
  <text xml:space="preserve" x="172" y="125" ${FONT} font-size="34" font-weight="800" fill="#ffffff">DNI<tspan fill="#9aa1b2" font-weight="500"> Directos</tspan> <tspan fill="url(#t)">24/7</tspan></text>
  <rect x="80" y="196" width="196" height="42" rx="21" fill="#ff4f2e" fill-opacity=".16"/><circle cx="106" cy="217" r="7" fill="#ff4f2e"/>
  <text x="124" y="225" ${FONT} font-size="20" font-weight="800" letter-spacing="2" fill="#ffb4a3">EN DIRECTO</text>
  <text x="80" y="330" ${FONT} font-size="76" font-weight="800" letter-spacing="-2.5" fill="#ffffff">Directos 24/7 en YouTube</text>
  <text x="80" y="420" ${FONT} font-size="76" font-weight="800" letter-spacing="-2.5" fill="url(#t)">sin encender el ordenador.</text>
  <text x="80" y="500" ${FONT} font-size="30" fill="#b5bbc8">Sube vídeos, crea la playlist en bucle y emite desde la nube.</text>
  <text x="80" y="560" ${FONT} font-size="26" font-weight="700" fill="#ffffff">Gratis · Sin tarjeta · Sin límite de horas</text>
</svg>`;

const png = (svg, file, size) => sharp(Buffer.from(svg), { density: 300 }).resize(size?.[0], size?.[1]).png({ compressionLevel: 9 }).toFile(file);

writeFileSync(path.join(pub, 'favicon.svg'), mark(48));
await png(mark(512), path.join(pub, 'icon-512.png'), [512, 512]);
await png(mark(192), path.join(pub, 'icon-192.png'), [192, 192]);
// Iconos «maskable» y Apple: símbolo sobre fondo completo con margen de seguridad.
await png(mark(512, { pad: 10 }), path.join(pub, 'icon-maskable-512.png'), [512, 512]);
await png(mark(180, { pad: 6 }), path.join(pub, 'apple-touch-icon.png'), [180, 180]);
await png(og, path.join(pub, 'og-image.png'), [1200, 630]);

const files = {
  'logo-symbol.svg': mark(512),
  'logo-symbol-transparent.svg': mark(512, { bg: null }),
  'logo-symbol-mono-white.svg': mark(512, { bg: null, fg: '#ffffff' }),
  'logo-symbol-mono-black.svg': mark(512, { bg: null, fg: '#0b0d13' }),
  'logo-horizontal-light.svg': wordmark('light'),
  'logo-horizontal-dark.svg': wordmark('dark'),
  'social-card.svg': og,
};
for (const [name, svg] of Object.entries(files)) {
  writeFileSync(path.join(brand, name), svg);
  writeFileSync(path.join(pub, 'brand', name), svg);
  const w = name.startsWith('logo-horizontal') ? [1280, 256] : name === 'social-card.svg' ? [1200, 630] : [1024, 1024];
  await png(svg, path.join(brand, name.replace('.svg', '.png')), w);
}
console.log('✓ pack de marca generado en apps/web/public y docs/brand');
