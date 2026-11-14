# Changelog

## 0.4.2 — 2026-11-14
- **Causa raíz de «no conecta con YouTube» confirmada en Cloudflare**: el FFmpeg estático 6.1.1 (johnvansickle) se
  estrella con SIGSEGV en la cadena MPEG-TS por tubería → copia a FLV (también con vídeo sintético, sin red). El
  contenedor instala ahora FFmpeg de Debian (dinámico); el estático queda solo de respaldo.
- Prueba en Cloudflare de 120 s en tiempo real con corte y reconexión: 59,83 s + 58,90 s recibidos a 30,02 fps,
  0 saltos > 100 ms, sin cierres por señal (`GET /internal/engine/diag?full=1`).
- Emisor: entrada limpia en fotograma clave con PAT/PMT (nunca a mitad de GOP), registro de señal de salida, estado
  del relé y salida real de FFmpeg en cada fallo; `-loglevel repeat+warning` (sin «Last message repeated»).
- Arranque: el alimentador espera a que los relés de los destinos estén listos; el vigilante da 45 s hasta la
  primera señal y 20 s después.
- Monitor de emisión: estado real comprobado en YouTube (liveStreams.status y liveBroadcasts.lifeCycleStatus).

## 0.4.1 — 2026-11-14
- **Corregido: las emisiones a YouTube no conectaban desde la nube.** El FFmpeg estático del contenedor no podía resolver
  DNS (glibc estática) y se quedaba colgado sin llegar a YouTube. Ahora FFmpeg publica en un relé local y el motor (Node)
  hace DNS (IPv4), TLS con verificación de certificado y la conexión real. Verificado desde Cloudflare: RTMP y RTMPS llegan
  a YouTube y completan el saludo RTMP.
- Errores de destino legibles («cerró la conexión: revisa la clave», «conexión rechazada»…); se filtra el ruido del decodificador.
- Los nodos se actualizan solos tras cada despliegue (antes un contenedor encendido seguía con el motor viejo).
- Diagnóstico de red automático de cada nodo al arrancar (`GET /internal/engine/diag`).
- **Asistente «Directo 24/7 en YouTube»**: tras conectar el canal, elegir/subir vídeos o una playlist, configurar el directo y emitir.
- App de Google publicada en producción (cualquier cuenta de Google puede entrar).

## 0.4.0 — 2026-11-14
- Motor de emisión en **Cloudflare Containers** verificado: salida a YouTube por RTMPS 443 y RTMP 1935, conversión de vídeos en ~8 s sin ningún PC encendido. Escala por emisiones y por cola de vídeos; renovación automática tras cada despliegue.
- Subida de varios archivos **a la vez** (6 conexiones compartidas, progreso por byte y velocidad); 2 conversiones simultáneas por servidor.
- **Panel del propietario** (/admin): métricas y gráficas, usuarios (desactivar, propietario, cerrar sesiones, borrar), todas las emisiones (detener/reiniciar), cola de vídeos, servidores, eventos, auditoría y ajustes (registro, aviso global, capacidad, credenciales de Google cifradas).
- **YouTube con un clic**: conexión del canal con Google (OAuth, API oficial) que crea el directo y el destino sin copiar claves.
- Ajustes de cuenta (perfil, contraseña, cerrar sesiones), programación con interfaz, páginas legales.
- Rediseño completo: identidad visual, portada con animaciones, panel con navegación inferior en móvil, carga diferida por páginas.
- SEO/AEO/GEO: portada prerenderizada, datos estructurados (SoftwareApplication, FAQPage, HowTo), sitemap, robots abierto a buscadores de IA, llms.txt, Open Graph.
- Pack de marca en docs/brand.

## 0.3.0 — 2026-11-13
- Desplegado en Cloudflare: Worker + assets, D1 y R2. Prueba de humo en producción (`pnpm smoke:prod`, 20 comprobaciones).
- Acceso con Google (OAuth 2.0 + OIDC con PKCE), pendiente de credenciales; registro por correo abierto.
- `pnpm engine:prod`: motor en un equipo propio contra producción mientras la cuenta no tenga Containers.
- El despliegue publica la plataforma aunque Cloudflare rechace la aplicación de Containers y lo avisa.

## 0.2.0 — 2026-11-13
- Servicio gratuito y sin límites comerciales; registro cerrado tras la primera cuenta.
- Nodo de emisión para Cloudflare Containers (`EngineNode`) sin necesidad de Docker y despliegue con `pnpm deploy:cloudflare`.
- Motor: puerto de salud, comprobación de IP resuelta de los destinos y corrección del bundle (no arrancaba de forma autónoma).
- D1 de producción creada; despliegue detenido a la espera de R2 y Workers Paid en la cuenta.

## 0.1.0 — 2026-11-13
- API en Cloudflare Workers (Hono, D1, R2): auth, organizaciones, medios, playlists versionadas, destinos cifrados, emisiones, programación, resumen.
- Motor de emisión FFmpeg: conversión canónica, playout con reloj PCR, fan-out aislado por destino, lease + fencing, recuperación.
- Dashboard React: landing, acceso, resumen, biblioteca, playlists, destinos, emisiones y monitor.
- Prueba e2e real contra dos ingests RTMP (42 comprobaciones) y 50 tests unitarios.
- Corregido durante las pruebas: pérdida de un fotograma en cada corte entre ítems (contadores de continuidad MPEG-TS) y hora inexistente del cambio horario de primavera.
