# Operación y despliegue

## Local (probado, sin Docker)

```bash
pnpm install
pnpm tools:setup      # secretos locales, MediaMTX verificado por SHA-256, migraciones D1
pnpm dev              # API :8787 · motor · ingest RTMP :1935 · web :5173
pnpm seed             # opcional: cuenta y emisión de demostración
```

Destino de prueba: `rtmp://127.0.0.1:1935/live` con cualquier clave. Ver la señal: `ffplay rtmp://127.0.0.1:1935/live/<clave>`.

## Producción en Cloudflare (pasos preparados, NO ejecutados)

Requisitos que debe aportar el propietario: plan **Workers Paid** (Containers lo exige), `wrangler login`, Docker en la
máquina que despliega y un dominio en Cloudflare.

1. `wrangler d1 create dni-directos` y copiar el `database_id` en `env.production` de `apps/api/wrangler.jsonc`.
2. `wrangler r2 bucket create dni-directos-media` (privado; no activar acceso público ni `r2.dev`).
3. `wrangler d1 migrations apply DB --remote --env production`.
4. Secretos: `wrangler secret put ENGINE_TOKEN --env production` y `ENCRYPTION_KEY` (32 bytes en base64). Guardar copia
   de `ENCRYPTION_KEY` en un gestor de secretos: sin ella las claves de emisión guardadas son irrecuperables.
5. Ajustar `APP_ORIGINS` al dominio real y dejar `ALLOW_PRIVATE_DESTINATIONS=false`.
6. `pnpm build && pnpm --filter @dni/api exec wrangler deploy --env production`.
7. **Motor en Cloudflare Containers — pendiente de implementar.** Falta la clase Durable Object que arranca y mantiene
   viva una instancia del contenedor (`infra/docker/engine.Dockerfile`) con `API_URL` y `ENGINE_TOKEN`. Hay que verificar
   en la práctica: salida TCP/RTMPS desde Containers, vida continua de la instancia (`sleepAfter`) y el comportamiento
   en los despliegues. Hasta entonces el motor puede ejecutarse en cualquier máquina con Node y FFmpeg apuntando a la API.

## Economía unitaria (MASTER_SPEC §J)

Ancho de banda de salida por destino, según el bitrate total del perfil (vídeo + audio, sin overhead):

| Perfil | Bitrate | GB/día | TB/30 días |
|---|---|---|---|
| 720p30 | 3,13 Mb/s | 33,8 | 1,01 |
| 1080p30 | 6,16 Mb/s | 66,5 | 2,00 |

| Escenario (1080p30, 2 destinos) | Egress mensual | vCPU de emisión estimada |
|---|---|---|
| 1 stream | 4 TB | < 0,25 |
| 10 streams | 40 TB | ~1–2 |
| 100 streams | 400 TB | ~10–20 |

La CPU de emisión es baja porque no se recodifica; el coste dominante es el **egress** y, en menor medida, la
transcodificación inicial y el almacenamiento. **Tarifas no verificadas:** antes de fijar precios hay que consultar la
tarifa vigente de Cloudflare Containers (vCPU, memoria, disco y egress por región), R2 y D1, anotar fecha y región, y
medir el consumo real. Las cifras de vCPU son estimaciones sin medir. Los planes de `packages/shared/src/schemas.ts`
son límites de ejemplo, no precios.

## Operación diaria

- **Salud:** `GET /healthz`. Nodos en la tabla `worker_nodes` (`last_seen_at`).
- **Canal atascado en `starting`:** no hay nodos con capacidad libre; revisar el motor.
- **Canal en `recovering`:** el nodo dejó de informar; otro lo retoma al caducar el lease (20 s).
- **Apagado ordenado de un nodo:** SIGTERM libera los canales con `node_shutdown` y otro nodo reanuda la posición.
- **Rotación de `ENGINE_TOKEN`:** cambiar el secreto en el Worker y en los nodos; los nodos con el token antiguo dejan de poder renovar y se silencian.
- **Retención:** eventos 30 días, sesiones caducadas y contadores de rate limit se purgan por cron.
- **Copias:** exportación de D1 (`wrangler d1 export`) y versionado de R2. Restauración **no ensayada**.
- **Alertas (email/webhook):** no implementadas.
