# Operación y despliegue

## Local (probado, sin Docker)

```bash
pnpm install
pnpm tools:setup      # secretos locales, MediaMTX verificado por SHA-256, migraciones D1
pnpm dev              # API :8787 · motor · ingest RTMP :1935 · web :5173
pnpm seed             # opcional: cuenta y emisión de demostración
```

Destino de prueba: `rtmp://127.0.0.1:1935/live` con cualquier clave. Ver la señal: `ffplay rtmp://127.0.0.1:1935/live/<clave>`.

## Producción en Cloudflare

Un solo comando, idempotente y sin Docker:

```bash
pnpm deploy:cloudflare
```

Crea D1 y R2, aplica migraciones, compila web y motor, sube a R2 el motor y los binarios de FFmpeg (direccionados y
verificados por SHA-256, fijados en `infra/engine-binaries.json`), publica el Worker con sus assets y Containers,
genera los secretos y comprueba `/healthz`.

**Estado a 13-nov-2026:** D1 `dni-directos` creada. El despliegue se detiene en R2 porque **R2 no está activado en la
cuenta**. Requisitos que solo el titular puede activar en el panel de Cloudflare:

1. **R2** (pide método de pago; incluye 10 GB/mes gratis).
2. **Workers Paid** (Cloudflare Containers lo exige).

Tras activarlos, relanzar `pnpm deploy:cloudflare`.

### Cómo corre el motor en Cloudflare
- Clase `EngineNode` (`apps/api/src/engine-node.ts`): un Durable Object por nodo que controla un contenedor
  `standard-3` con la imagen oficial `node:22-bookworm`. Un cargador descarga motor y FFmpeg desde R2, verifica el hash
  y ejecuta el motor como usuario sin privilegios (uid 1000).
- `wakeEngines` (cron cada minuto, y al iniciar una emisión o completar una subida) enciende los nodos necesarios:
  `ceil(emisiones / ENGINE_CAPACITY)`, máximo `ENGINE_MAX_NODES`. Sin trabajo, el contenedor se apaga a los 10 minutos.
- Si un contenedor se reinicia, el lease caduca (30 s) y el cron lo vuelve a arrancar: el canal se reanuda solo.
- **Sin validar todavía en Cloudflare real:** salida RTMP/RTMPS desde Containers, arranque del cargador y coste.
  Es lo primero que hay que comprobar tras el despliegue.

### Secretos
`ENGINE_TOKEN` y `ENCRYPTION_KEY` se generan en el primer despliegue y quedan en `.data/prod/secrets.json`
(ignorado por git). **Guarda una copia**: sin `ENCRYPTION_KEY` las claves de emisión guardadas son irrecuperables.

### Registro
El servicio es gratuito y sin límites, así que el registro abierto permitiría a cualquiera emitir a tu costa. Por
defecto solo se admite **la primera cuenta** (la del propietario). `ALLOW_SIGNUPS=true` en `wrangler.jsonc` lo abre.

### Mientras Cloudflare no esté activo
El motor funciona en cualquier máquina con Node: `pnpm dev` levanta todo en local y permite emitir ya a YouTube o
Twitch con la clave real, con la condición de mantener ese equipo encendido.

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
