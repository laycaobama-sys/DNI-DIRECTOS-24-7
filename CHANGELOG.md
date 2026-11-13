# Changelog

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
