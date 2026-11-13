# MASTER_SPEC — SaaS de streaming 24/7 en la nube

> Especificación principal del proyecto, entregada por el propietario el 12-nov-2026. Esta copia conserva todos los
> requisitos con la redacción resumida; si dispones del documento original íntegro, sustituye este archivo por él.
> Restricción añadida por el propietario: **toda la infraestructura debe estar en Cloudflare**.
> Nombre de trabajo provisional: `StreamPilot` / «DNI Directos 24/7» (sin presuponer disponibilidad de marca).
> Referencias funcionales públicas: gyre.pro · upstream.so · streamingbots.com (patrones, nunca código, marcas, diseños ni textos).

## A. Modo de ejecución obligatorio
1. Auditar primero; no borrar código ni recursos existentes.
2. Investigar las referencias y clasificar cada hallazgo como `VERIFICADO_PÚBLICAMENTE`, `INFERENCIA`, `PROPUESTA_PROPIA` o `NO_VERIFICABLE_SIN_ACCESO`. No eludir autenticación ni CAPTCHAs.
3. No clonar identidades: marca, diseño y textos originales.
4. Escribir `docs/PRODUCT_REQUIREMENTS.md`, `COMPETITOR_AUDIT.md`, `ARCHITECTURE.md`, `IMPLEMENTATION_PLAN.md`, `ACCEPTANCE_TESTS.md`, `SECURITY.md`, `OPERATIONS.md` y `TODO.md`.
5. Implementar en incrementos verticales terminados (DB + API + UI + worker + tests).
6. Sin claves: integración real preparada, `.env.example`, mocks solo en tests. Nunca marcar como operativo lo no probado.
7. Tras cada fase: instalación, typecheck, lint, tests y builds, con evidencias. Nunca «100 % funcionando» sin pruebas.
8. No hacer preguntas no bloqueantes; documentar supuestos; no pedir secretos por chat.

## B. Objetivo y experiencia
Estación de emisión continua: el cliente sube medios, crea playlists, diseña escenas, programa, elige destinos y emite a
YouTube/Twitch/RTMPS desde nuestra infraestructura, sin depender de su conexión. Configuración en menos de 5 minutos.
Estados REALES: preparando, listo, programado, conectando, en directo, degradado, recuperando, detenido, error,
suspendido por cuota. El botón de iniciar levanta el worker; el stream sigue con el portátil cerrado.

## C. Sitio público
Landing original (hero con demo marcada como demostración, pasos Subir → Playlist → Configurar → Transmitir,
funcionalidades, casos de uso, planes con límites claros, calculadora, FAQ, legal), blog, sitemap, robots, metadatos,
i18n ES/EN, WCAG 2.2 AA razonable. Ningún logo, testimonio, certificación o contador ficticio. Interfaz premium,
claro/oscuro, responsive 360 px+, skeletons, estados vacíos, confirmaciones y errores útiles.

## D. Rutas
`/`, `/features`, `/solutions/[slug]`, `/pricing`, `/blog`, `/help`, `/legal/*`; `/login`, `/register`,
`/forgot-password`, `/onboarding`, `/verify-email`; `/app/overview`, `/app/streams`, `/app/streams/new`,
`/app/streams/[id]`, `/app/library`, `/app/playlists`, `/app/designer`, `/app/schedule`, `/app/destinations`,
`/app/analytics`, `/app/team`, `/app/billing`, `/app/settings`, `/app/developer`, `/admin`.

## E. Catálogo funcional
- **E1 Biblioteca**: subida directa multipart/reanudable, SHA-256, deduplicación opcional, cuotas, MIME real, `ffprobe`,
  miniaturas, conversión asíncrona a perfil canónico H.264/AAC (fps y GOP coherentes, silencio si falta audio),
  originales y derivados con retención, buckets nunca públicos, rechazo claro de formatos no compatibles, sin SSRF.
- **E2 Reproducción**: consecutivo, loop, shuffle con semilla sin repetir, una pasada; radio; slate; cambios en directo
  mediante versiones aplicadas en límite de ítem, sin discontinuidades.
- **E3 Streaming**: workers FFmpeg persistentes fuera del runtime serverless; fuente única normalizada y fan-out aislado
  por destino (si falla uno, el resto sigue); RTMPS preferido, RTMP con aviso; claves cifradas y enmascaradas;
  720p30 y 1080p30 base; keyframe cada 2 s, AAC 48 kHz; vista previa segura real; YouTube + RTMP genérico en MVP;
  OAuth oficial de YouTube para crear directos.
- **E4 Scheduler y resiliencia**: UTC + zona IANA, recurrencias, DST, idempotencia; máquina de estados `draft`,
  `processing`, `ready`, `scheduled`, `starting`, `live`, `degraded`, `recovering`, `stopping`, `stopped`, `failed`,
  `suspended`; leases/heartbeat y fencing tokens; health checks reales (un proceso vivo sin salida útil no es `healthy`);
  backoff con jitter, circuit breakers, reanudación aproximada, alertas; `stream_sessions` y métricas históricas.
- **E5 Seguridad**: multi-tenancy con `organization_id`, roles owner/admin/editor/operator/viewer, pruebas IDOR;
  sesiones seguras, CSRF, CORS, CSP, HSTS, rate limits; secretos cifrados en reposo; webhooks firmados; FFmpeg aislado
  sin privilegios y sin flags del usuario; GDPR; proceso de copyright; nada de bots ni métricas falsas.
- **E6 Facturación**: Stripe Checkout + Portal + webhooks idempotentes; planes y límites configurables; trial acotado;
  `usage_metering` medido por el worker.
- **E7 Analíticas e IA**: técnicas reales; externas solo con API oficial (`source`, `last_synced_at`), si no «Sin
  conectar»; IA opt-in etiquetada como recomendación.

## F. Tecnología
Monorepo pnpm (`apps/web`, `apps/api`, workers, `packages/shared`, `infra/`, `docs/`). Propuesta original: Next.js,
Fastify/Nest, PostgreSQL + Supabase, Redis/BullMQ, S3/R2, FFmpeg en Docker, SRS/MediaMTX, Stripe, Playwright/Vitest,
GitHub Actions. **Adaptación a «todo en Cloudflare»** documentada en `ARCHITECTURE.md`.
Endpoints `/v1/media`, `/v1/playlists`, `/v1/streams` (`start`, `stop`, `restart`, `health`, `events`, `preview`),
`/v1/destinations`, `/v1/integrations/youtube/*`, `/v1/schedules`, `/v1/usage`, `/v1/billing/*`, `/webhooks/stripe`,
`/v1/admin/*`.

## G. Asistente de creación
Caso de uso → biblioteca → orden y modo → aspecto y perfil → overlays → destinos y diagnóstico → programación →
resumen de consumo → iniciar. Borrador autoguardado, validaciones, sin secretos en enlaces.

## H. Criterios de aceptación no negociables
1. Aislamiento entre organizaciones A y B por UI y API (IDOR).
2. Subir 3 vídeos de códecs/resoluciones distintos, analizar, convertir, miniaturas y progreso real; archivo corrupto → error accionable.
3. Playlist `A→B→C` emitida a RTMP local, verificada con `ffprobe` (audio y vídeo) y bucle `A→B→C→A` sin bloqueo.
4. Iniciar desde el dashboard, cerrar el navegador, verificar que sigue; reabrir y ver estado real.
5. Concurrencia hasta la cuota; excederla responde 403/409/422 útil y no crea procesos ocultos.
6. Dos destinos: cortar uno y verificar que el otro continúa; estado degradado y reconexión.
7. Matar el worker: watchdog/reconciliador, recuperación sin duplicar procesos, evento de error.
8. Programación en Europe/Madrid con tests de DST.
9. Editar playlist en directo: entra en corte seguro sin reiniciar.
10. Stripe con eventos duplicados, desordenados y fallidos.
11. Todas las pantallas con loading/error/empty/success; 360 px; teclado; builds sin errores.
12. Flujo en staging con destino externo autorizado (solo con credenciales).
13. Indicadores de audiencia no autorizados figuran «no disponible».
14. Seguridad: bucket no público, aislamiento, rate limiting, SSRF, redacción de secretos, webhooks firmados, worker sin privilegios.
15. Entrega con comandos, README, migraciones, `.env.example`, compose, CI y lista `PROBADO / NO PROBADO / BLOQUEADO`.

## I. Fases
0 investigación y diseño · 1 plataforma base · 2 primer stream real · 3 24/7 operable · 4 SaaS para pilotos (Stripe,
OAuth YouTube, admin) · 5 avanzado (radio, editor, 9:16, API, MCP, Live Studio) · 6 producción y escala.
Los módulos no terminados se muestran como `Próximamente`, nunca como paneles aparentemente operativos.

## J. Economía unitaria
Calcular por stream CPU, almacenamiento, egress por destino, monitorización, Stripe, soporte y margen. Referencia:
6 Mb/s ≈ 64,8 GB/día ≈ 1,94 TB/30 días por salida. No asumir egress gratis ni inventar precios de infraestructura.

## K. Políticas de plataformas
Derechos de autor y normas de YouTube/Twitch; directos de más de 12 h pueden no archivarse; no prometer 4.000 horas,
monetización ni alcance; advertir sobre contenido repetitivo o inauténtico; API oficial con OAuth2, sin scraping.

## L. Formato de checkpoint
Qué se implementó · qué se probó (comandos y evidencias) · qué falta o bloquea · cómo ejecutar · siguiente fase.

**Regla final:** un motor 24/7 real y fiable por encima de cualquier cantidad de pantallas. Nada de interfaces fake.
