# Pruebas de aceptación — estado real

Última ejecución: 13-nov-2026, Windows 10, Node 26, FFmpeg 6.1.1, Wrangler 4.160 (Miniflare), MediaMTX 1.21.3.
Reproducir: `pnpm install && pnpm tools:setup && pnpm test && pnpm test:e2e-stream`. Evidencias en `.data/e2e/`
(`resultado.json`, `grabacion.flv`, `logs/`).

- `pnpm test` → **50/50** tests unitarios.
- `pnpm test:e2e-stream` → **42/42** comprobaciones con API, motor y dos ingests RTMP reales (sin mocks).
- `pnpm typecheck`, `pnpm lint`, `pnpm build` → sin errores.

| # | Criterio (MASTER_SPEC §H) | Estado | Evidencia |
|---|---|---|---|
| 1 | Aislamiento entre organizaciones | **PROBADO (API)** | e2e: 11 accesos cruzados → 404; 3 referencias cruzadas → 422; listados de B vacíos. Solo por API, no por UI. |
| 2 | 3 vídeos de códecs distintos + corrupto | **PROBADO** | e2e: H.264 640×360, MPEG-4 1280×720 sin audio, VP9 854×480 → convertidos; miniatura JPEG; corrupto → `unreadable_media`. |
| 3 | Playlist A→B→C a RTMP, ffprobe, bucle | **PROBADO** | e2e: ffprobe H.264 1280×720 + AAC 48 kHz; orden a→b→c→a; grabación de 24 s con 0 saltos de fotograma. |
| 4 | Iniciar desde dashboard, cerrar navegador | **PROBADO (manual)** | Inicio desde la UI, pestaña cerrada, ffprobe 20 s después seguía recibiendo señal; estado `live` leído por API. No automatizado. |
| 5 | Cuotas de concurrencia (plan `restricted`; el plan por defecto es gratuito y sin límites) | **PROBADO** | e2e: 409 `quota_concurrent_streams`, sin procesos FFmpeg nuevos; 403 `quota_destinations`. |
| 6 | Dos destinos, cortar uno | **PROBADO** | e2e: `degraded`, destino A con 0 reinicios, B reconecta solo y vuelve a `live`. |
| 7 | Matar el worker | **PROBADO** | e2e: 0 FFmpeg huérfanos, evento `engine_lost`, otro nodo retoma con fencing nuevo y reanuda posición, heartbeat antiguo → 409. |
| 8 | Programación Europe/Madrid + DST | **PARCIAL** | Tests unitarios de DST (primavera, otoño, hora inexistente y ambigua). El cron que dispara inicios **no se ha ejercitado**; sin UI. |
| 9 | Editar playlist en directo | **PROBADO** | e2e: `playlist_applied` en límite de ítem, misma sesión, 0 reinicios de destino. |
| 10 | Stripe | **NO IMPLEMENTADO** | Bloqueado: requiere cuenta Stripe. |
| 11 | Estados de pantalla, 360 px, accesibilidad | **PARCIAL** | Revisadas a mano landing, login, resumen, biblioteca, destinos, emisiones y monitor; 360 px sin desbordamiento. Sin Playwright ni auditoría de accesibilidad; playlists y «nueva emisión» no revisadas en navegador. |
| 12 | Staging con destino externo | **BLOQUEADO** | Requiere cuenta Cloudflare de pago, Docker y un canal/clave autorizados. Nunca se ha emitido a YouTube ni Twitch. |
| 13 | Audiencia «no disponible» | **PROBADO** | e2e: `audience.available = false`; la UI muestra «Sin conectar». |
| 14 | Seguridad | **PARCIAL** | Probado: API interna 401 sin token, CSRF 403, SSRF (16 hosts privados), claves ausentes de respuestas, eventos y logs, consentimiento RTMP sin cifrar. No probado: rate limiting bajo carga, bucket en producción, contenedor sin privilegios. Sin webhooks. |
| 15 | Entregables | **PARCIAL** | README, migraciones, `.env.example`, compose y CI incluidos; compose, Dockerfile y CI **sin ejecutar**. |

## Grabación, vista previa y miniaturas (0.5.0)

| # | Criterio | Estado | Evidencia |
|---|---|---|---|
| 16 | Vista previa con imagen y sonido reales | **PROBADO** (local y producción) | e2e H15: fragmento HLS H.264 1280×720 + AAC que empieza en fotograma clave; otra organización recibe 404 |
| 17 | Grabación automática en la nube | **PROBADO** (local y producción: fragmento de 60,0 s en R2 y MP4) | e2e H15: se activa en directo sin reiniciar, se reproduce mientras graba, se cierra al desactivarla, MP4 con la duración grabada (±3 s), enlace firmado (206) y firma falsa rechazada (403) |
| 18 | La grabación sobrevive al relevo de nodo | **PROBADO** (local) | e2e H7: se mata el nodo y la misma grabación continúa en el nuevo, con #EXT-X-DISCONTINUITY |
| 19 | Miniaturas personalizadas | **PROBADO** (local) | e2e H16: vídeo, playlist, emisión y grabación; JPG/PNG/WebP por firma de bytes, 422 con otro formato, 413 por encima de 2 MB, aislamiento entre organizaciones |
| 20 | Miniatura enviada a YouTube | **SIN PROBAR** | Necesita un canal de YouTube verificado y un destino creado con «YouTube con un clic» |

## No probado o pendiente (resumen honesto, 15-nov-2026)

- **Ya probado en producción** (antes no lo estaba): motor en Cloudflare Containers, RTMPS real a YouTube y directo de 9,99 h a 1080p30 con 3 cortes de YouTube recuperados solos (ver `docs/AUDIT_2026-11.md`).
- Producción 0.5.0 (`node scripts/smoke-prod.mjs --egress`, 29/29): vista previa HLS desde Containers, grabación de 60 s en R2, MP4 exportado en la nube y miniatura. Falta probar el envío de la miniatura a un canal real de YouTube.
- Imagen Docker y `docker-compose.yml`: escritos, nunca construidos (no hay Docker en el equipo de desarrollo).
- Sin ensayo de 24 h continuas ni del reinicio de base de tiempos a las 12 h; el más largo es el de 10 h.
- Vídeos grandes (>100 MB), rotados (móvil) o con audio 5.1.
- Rate limiting bajo carga y facturación (no existe todavía).
