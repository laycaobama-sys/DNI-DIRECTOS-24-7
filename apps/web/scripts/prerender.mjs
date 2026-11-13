#!/usr/bin/env node
/**
 * Tras `vite build`: renderiza la portada a HTML estático y genera los archivos de descubrimiento
 * (sitemap.xml, robots.txt, llms.txt, site.webmanifest) con la URL pública real.
 * Así Google, Bing y los asistentes de IA (ChatGPT, Claude, Perplexity, Gemini) leen el contenido sin JavaScript.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(web, 'dist');
const SITE = (process.env.SITE_URL || 'https://dni-directos.ibraguimova19.workers.dev').replace(/\/+$/, '');

await build({ root: web, logLevel: 'warn', build: { ssr: 'src/ssr.tsx', outDir: 'dist-ssr', emptyOutDir: true, rollupOptions: { output: { format: 'esm', entryFileNames: 'ssr.mjs' } } } });
const { render, jsonLd } = await import(pathToFileURL(path.join(web, 'dist-ssr', 'ssr.mjs')).href);

const indexPath = path.join(dist, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replaceAll('%SITE_URL%', SITE).replace('%JSON_LD%', jsonLd(SITE)).replace('<!--SSR-->', `<div id="ssr">${render()}</div>`);
writeFileSync(indexPath, html);

const today = new Date().toISOString().slice(0, 10);
const urls = [['/', '1.0', 'weekly'], ['/register', '0.8', 'monthly'], ['/login', '0.5', 'monthly'], ['/legal/privacidad', '0.3', 'yearly'], ['/legal/terminos', '0.3', 'yearly'], ['/legal/cookies', '0.2', 'yearly']];
writeFileSync(path.join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(([u, p, f]) => `  <url><loc>${SITE}${u}</loc><lastmod>${today}</lastmod><changefreq>${f}</changefreq><priority>${p}</priority></url>`).join('\n')}
</urlset>
`);

// Rastreadores de buscadores y de IA bienvenidos en las páginas públicas; el panel y la API quedan fuera.
const bots = ['*', 'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot', 'Applebot-Extended', 'DuckAssistBot', 'meta-externalagent'];
writeFileSync(path.join(dist, 'robots.txt'), `${bots.map((b) => `User-agent: ${b}\nAllow: /\nDisallow: /app/\nDisallow: /admin\nDisallow: /v1/\nDisallow: /internal/\n`).join('\n')}
Sitemap: ${SITE}/sitemap.xml
`);

const llms = `# DNI Directos 24/7

> Plataforma en la nube para emitir vídeos pregrabados en directo 24/7 a YouTube, Twitch, Kick, Facebook Live y cualquier servidor RTMP/RTMPS, sin tener el ordenador encendido. Gratis y sin límite de horas.

## Qué es
DNI Directos 24/7 es un servicio web (${SITE}) en español para hacer directos continuos con contenido grabado. El usuario sube sus vídeos, crea una playlist (en bucle infinito, aleatoria o de una sola pasada), elige uno o varios destinos y pulsa «Iniciar emisión». La señal sale de servidores en la nube (Cloudflare), así que el directo sigue aunque el usuario apague el ordenador o cierre el navegador.

## Funciones principales
- Emisión 24/7 desde la nube, sin OBS ni programas instalados.
- Playlist en bucle, aleatoria sin repeticiones o de una pasada; se puede editar en directo y el cambio entra al acabar el vídeo actual, sin cortes.
- Multistream: hasta 10 destinos simultáneos con conexiones aisladas (si uno falla, los demás siguen).
- Conexión directa con YouTube mediante la cuenta de Google (API oficial): crea el directo en el canal sin copiar claves.
- Recuperación automática: reconexión con reintentos progresivos y relevo entre servidores que reanuda la playlist.
- Subida de varios vídeos a la vez en paralelo (MP4, MOV, MKV, WebM; hasta 4 GB por archivo) con conversión automática a H.264/AAC 720p o 1080p a 30 fps.
- Programación de inicio y fin con zona horaria y cambios de hora.
- Estado real por destino (bitrate, reconexiones, eventos). No muestra cifras de audiencia inventadas.
- Inicio de sesión con correo o con Google.

## Precio
Gratis. Sin tarjeta, sin límite de horas de emisión y con todas las funciones disponibles.

## Para quién
Canales de música y radio 24/7 (lofi, DJ sets), iglesias, contenido educativo, gaming, podcasts, fitness y negocios que quieren un canal siempre en directo.

## Limitaciones honestas
- No garantiza monetización ni visualizaciones. YouTube puede no archivar directos de más de 12 horas y considera problemático el contenido repetitivo.
- Solo se debe emitir contenido del que se tengan los derechos.

## Enlaces
- Inicio: ${SITE}/
- Crear cuenta: ${SITE}/register
- Privacidad: ${SITE}/legal/privacidad
- Términos: ${SITE}/legal/terminos
`;
writeFileSync(path.join(dist, 'llms.txt'), llms);

writeFileSync(path.join(dist, 'site.webmanifest'), JSON.stringify({
  name: 'DNI Directos 24/7', short_name: 'DNI Directos', description: 'Directos 24/7 en YouTube y cualquier RTMP desde la nube.',
  lang: 'es', start_url: '/app/overview', scope: '/', display: 'standalone', background_color: '#07080c', theme_color: '#07080c',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
    { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
}, null, 2));
console.log(`✓ portada prerenderizada (${(html.length / 1024).toFixed(0)} KB) + sitemap, robots, llms.txt y manifest para ${SITE}`);
