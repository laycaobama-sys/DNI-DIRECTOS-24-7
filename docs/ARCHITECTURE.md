# Arquitectura

Restricción del propietario: **todo en Cloudflare**. La propuesta original (Next.js + Postgres/Supabase + Redis/BullMQ)
se sustituye por equivalentes nativos, manteniendo los requisitos de fondo (fuente de verdad transaccional, exclusión
mutua con fencing, workers persistentes separados del runtime serverless).

| Necesidad | Propuesta original | Implementado | Estado |
|---|---|---|---|
| API | Fastify/Nest | Cloudflare Workers + Hono (`apps/api`) | Probado en local (Miniflare) |
| Base de datos | PostgreSQL + RLS | Cloudflare D1 (SQLite); aislamiento en la capa API | Probado en local |
| Colas y locks | Redis + BullMQ | Colas en D1: `UPDATE … RETURNING` atómico + lease + fencing token | Probado en local |
| Almacenamiento | S3/R2 | Cloudflare R2 privado, multipart por binding | Probado en local |
| Auth | Supabase Auth | Propia: PBKDF2-SHA256, sesión en cookie httpOnly | Probado en local |
| Web | Next.js | React + Vite, servida como assets del mismo Worker | Probado en local |
| Motor FFmpeg | Docker en VPS | Proceso Node + FFmpeg (`apps/engine`); imagen Docker para Cloudflare Containers | Motor probado como proceso; **imagen y Containers no probados** |
| Scheduler | BullMQ | Cron Trigger cada minuto + reclamación condicional en D1 | Lógica con tests; cron no ejercitado en local |

## Diagrama

```
Navegador ──HTTPS──► Worker (Hono)  ──► D1 (fuente de verdad)
   (React)            │  /v1/*            R2 (originales, variantes, miniaturas)
                      │  /internal/*  ◄── Bearer ENGINE_TOKEN
                      ▼
            Nodo de emisión (apps/engine)  — Cloudflare Container en producción, proceso Node en local
              ├─ bucle de medios:  claim → descarga → ffprobe → transcodifica → miniatura → sube variante
              └─ bucle de canales: claim → StreamRunner
                     feeder FFmpeg (1 por ítem, -c copy → MPEG-TS)
                        └─► bus con reloj PCR ─┬─► pusher FFmpeg destino 1 (-c copy → FLV/RTMPS)
                                               └─► pusher FFmpeg destino 2 …
```

## Decisiones clave del motor

- **Sin recodificar en emisión.** Cada vídeo se convierte una vez a un perfil canónico (H.264 High, yuv420p, 30 fps,
  GOP 60 = keyframe cada 2 s, sin B-frames, AAC 48 kHz estéreo, audio y vídeo cortados al mismo instante). En directo
  solo se copia: un canal consume una fracción de vCPU.
- **Reloj único.** Los feeders no usan `-re`; el bus libera los paquetes MPEG-TS según su PCR contra el reloj de pared.
  La latencia de arranque de cada FFmpeg no se acumula (medido: cortes exactos a 12,00 / 10,01 / 7,99 s).
- **Continuidad.** `-output_ts_offset` acumulado da timestamps continuos y el bus reescribe los contadores de
  continuidad por PID. Sin esto se perdía un fotograma en cada corte (detectado y corregido con la prueba e2e).
  La base de tiempos se reinicia cada 12 h porque el PTS de MPEG-TS desborda a las ~26,5 h.
- **Fan-out aislado.** Un proceso por destino con backoff exponencial y jitter, circuito abierto tras 8 fallos,
  watchdog por avance real de `out_time` y corte por buffer lleno. Un destino caído no afecta al resto.
- **Exclusión mutua.** `streams.fencing_token` se incrementa en cada claim; un heartbeat con token antiguo recibe 409 y
  el nodo mata FFmpeg. Si un nodo no logra renovar el lease dentro del TTL, se auto-silencia antes de que otro lo tome.
- **Reconciliación.** En cada claim y por cron: leases caducados → `recovering` + evento `engine_lost`; canales con
  `desired_state=stopped` sin nodo → `stopped`.
- **Cambios en directo.** Publicar una playlist crea una versión inmutable; el motor la precarga y la aplica en el
  siguiente límite de ítem. Los destinos se añaden, quitan o rotan su clave sin tocar a los demás.

## Limitaciones conocidas

- D1 no tiene RLS: el aislamiento depende de que toda consulta filtre por `organization_id` (cubierto por la prueba IDOR).
- La reanudación tras una caída reinicia el ítem que estaba sonando desde su comienzo.
- Sin vista previa HLS, sin overlays, sin radio, sin 9:16 (ver `TODO.md`).
- Los medios pasan por el Worker (partes de 8 MB). En producción conviene montar R2 por FUSE en el contenedor.
- Un solo nodo por canal: no hay emisión redundante activa-activa.
