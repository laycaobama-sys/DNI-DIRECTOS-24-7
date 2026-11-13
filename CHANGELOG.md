# Changelog

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
