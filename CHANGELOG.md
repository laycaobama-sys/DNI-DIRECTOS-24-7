# Changelog

## 0.6.0 — 2026-11-16
- **Sonido sin pitidos ni chasquidos**: corregido el solape de audio AAC entre vídeos de la playlist (cada vídeo trae un
  frame de cebado con pts negativo y su último frame se decodifica entero: ambos pisaban al vídeo vecino → DTS no
  monótonos, audio duplicado y «fiu, fiu»). El alimentador descarta esos frames sin recodificar (`noise=drop`), con la
  imagen continua. Prueba de regresión `tests/playout-audio.test.ts` (sin «non-monotonic», sin solapes de audio y
  vídeo a 30 fps sin saltos en los cortes). Audio a 192 kbps. El contenedor pasa a Debian 13 (FFmpeg 7.1); el motor
  comprueba al arrancar que su FFmpeg admite el recorte e informa `audioTrim` en el diagnóstico.
- **Directo nuevo en YouTube en cada inicio**: si el directo anterior terminó, «Iniciar» crea uno nuevo en el canal
  (mismo título, descripción, privacidad y miniatura) y lo vincula a la misma clave; si sigue abierto, pregunta si
  continuar en el mismo o crear uno nuevo. «Detener» finaliza también el directo de YouTube (queda guardado) salvo que
  se desmarque. También funciona con claves pegadas a mano si el canal está conectado (se vinculan por la clave).
- **Miniatura automática en YouTube** al subirla o cambiarla y en cada directo nuevo, para cualquier destino de YouTube
  con el canal conectado; reintento cada hora si YouTube la rechaza (p. ej. canal sin verificar).
- **Audiencia real** (API oficial de YouTube, cada 5 min): espectadores simultáneos, pico, media, horas vistas,
  visualizaciones y «me gusta» por emisión, y resumen en el panel.
- **Planes**: Gratis, Creador (19 €), Pro (49 €, 4K) y Agencia (129 €) con límites aplicados en la API, página «Plan»
  con consumo, solicitud de cambio con enlace de pago configurable y aprobación del propietario. Las cuentas existentes
  quedan como Fundador (sin límites). Detalle en `docs/PLANES.md`.
- **4K** (2160p30, 20 Mbit/s, H.264 High 5.1) y **1080p60** (9 Mbit/s).
- **Camino B (híbrido)**: nodos de emisión en servidores dedicados (`deploy/dedicated-node`) con prioridad sobre
  Cloudflare Containers, que queda de respaldo.
- **Panel del propietario**: analítica (visitas sin cookies por país, procedencia y dispositivo; accesos por país y
  ciudad; altas; cuentas por plan; ingresos estimados; audiencia), plan por cuenta, solicitudes y enlaces de pago.
- **Móvil**: la cabecera respeta la muesca/barra de estado (`safe-area`), sin desplazamiento lateral, tarjetas de
  emisión con los botones en su propia fila y sin animaciones flotantes en pantallas pequeñas.
- Animaciones: contadores, gráficas que se dibujan, entrada escalonada de tarjetas y borde animado del plan destacado
  (respetan «reducir movimiento»).
- SEO/IA: precios en la portada, `AggregateOffer` con los 4 planes en JSON-LD, FAQ de 4K/precios/miniaturas, `llms.txt`
  con planes reales.

## 0.5.0 — 2026-11-15
- **Monitor del directo**: imagen y sonido reales de la señal de salida (HLS, sin recodificar), vúmetros L/R con RMS y
  pico, alerta de silencio (> 5 s por debajo de −50 dBFS) y de saturación, resolución, FPS, bitrate y retraso medidos en
  el reproductor, imagen en imagen y pantalla completa. El motor solo genera la vista previa mientras alguien la mira.
- **Grabación automática en la nube** por emisión (se activa en pleno directo): fragmentos MPEG-TS de 60 s subidos a R2
  por partes mientras se graba (un fallo pierde como mucho un fragmento), reproducible durante la grabación, exportación
  a MP4 (+faststart) en segundo plano, enlace de descarga firmado con caducidad, retención configurable y borrado por cron.
- **Miniaturas en todo** (vídeos, playlists, emisiones y grabaciones) con **estudio de miniaturas**: fondo propio, fotograma
  del vídeo o degradado, plantillas, título/subtítulo con contorno y sombra, logotipo, distintivo, zona segura de YouTube y
  JPG 1280×720 < 2 MB. La de la emisión se envía sola a YouTube (`thumbnails.set`) en los destinos de «YouTube con un clic».
- Mensajes de corte de destino más precisos: un corte del servidor de ingesta tras horas emitiendo ya no culpa a la clave.
- Un relevo de nodo continúa la MISMA grabación (con marca de discontinuidad) en vez de partirla en dos.
- Corregido (solo ocurría en R2 real): las partes de la subida multipart de la grabación ahora miden exactamente 8 MiB.
- Un motor desactualizado tras un despliegue ya no acepta emisiones nuevas hasta actualizarse (evita un corte al arrancar).
- Verificado en producción (Cloudflare): vista previa HLS, fragmento de 60,0 s grabado en R2 (26,5 MB), reproducción con
  Range, exportación a MP4 y miniatura (`smoke-prod --egress`: 29/29). e2e local: 63/63.
- Documentación: `docs/AUDIT_2026-11.md` (auditoría del directo de 10 h) y `docs/PRICING_STRATEGY.md` (precios).

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
