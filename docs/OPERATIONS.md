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

**Estado a 14-nov-2026:** web, API, D1, R2 **y motor en Cloudflare Containers** desplegados y verificados en
`https://dni-directos.ibraguimova19.workers.dev` (`pnpm smoke:prod`: 20/20). **El motor no corre aún en Cloudflare:**
la API de Containers responde `401 Unauthorized` al crear la aplicación, lo que indica que la cuenta no tiene acceso a
Containers. Con Workers Paid activo (14-nov-2026) el motor corre en Containers; si algún día Cloudflare rechaza la
aplicación, el script publica todo lo demás y avisa.

Mientras tanto el motor se ejecuta en un equipo propio contra producción:

```bash
pnpm engine:prod
```

Ese equipo debe seguir encendido para emitir. Cuando la cuenta tenga Workers Paid, relanzar `pnpm deploy:cloudflare`
creará la aplicación de Containers y `pnpm engine:prod` dejará de ser necesario.

### Acceso con Google
Implementado (OAuth 2.0 + OpenID Connect con PKCE); se activa al definir dos secretos. Pasos del titular:

1. Google Cloud Console → APIs y servicios → Pantalla de consentimiento OAuth (tipo Externo; ámbitos `openid`, `email`, `profile`) y publicarla.
2. Credenciales → Crear ID de cliente de OAuth → Aplicación web. URI de redirección autorizado:
   `https://dni-directos.ibraguimova19.workers.dev/v1/auth/google/callback`
3. Guardar ID y secreto como secretos del Worker (no pegarlos en ningún chat ni en el repositorio):

```bash
pnpm --filter @dni/api exec wrangler secret put GOOGLE_CLIENT_ID --env production
```

```bash
pnpm --filter @dni/api exec wrangler secret put GOOGLE_CLIENT_SECRET --env production
```

El botón «Continuar con Google» aparece solo cuando ambos existen. Una cuenta de Google cuyo correo ya esté
registrado se vincula a la cuenta existente.

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
Abierto en producción por decisión del propietario (`ALLOW_SIGNUPS=true`): cualquiera puede crear cuenta por correo
o con Google. Como el servicio es gratuito y sin límites, cada cuenta puede emitir a costa de la cuenta de Cloudflare.
`ALLOW_SIGNUPS=false` lo cierra tras la primera cuenta. No hay verificación de correo ni recuperación de contraseña.

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

## Panel del propietario
`/admin` (solo cuentas con `is_superadmin`; la primera cuenta creada lo es). Desde ahí se gestiona sin terminal:
usuarios, emisiones de todos, cola de vídeos, servidores de Containers, eventos, auditoría, registro abierto/cerrado,
aviso global, número máximo de servidores y las **credenciales de Google** (se guardan cifradas en D1).

## Credenciales de Google (acceso y YouTube)
1. Google Cloud Console → Credenciales → ID de cliente OAuth (Aplicación web):
   - Origen autorizado: `https://dni-directos.ibraguimova19.workers.dev`
   - URI de redirección: `https://dni-directos.ibraguimova19.workers.dev/v1/auth/google/callback`
2. Para «YouTube con un clic»: habilitar **YouTube Data API v3** y añadir el ámbito `https://www.googleapis.com/auth/youtube`
   en la pantalla de consentimiento. Mientras la app no esté verificada por Google, solo los usuarios de prueba
   añadidos en la consola pueden conectar YouTube (límite de 100) y verán un aviso de «app no verificada».
3. `/admin/settings` → pegar ID y secreto → Guardar.

## Comprobaciones rápidas
- `pnpm smoke:prod`: 20 comprobaciones contra producción con cuenta temporal que se borra al terminar.
- `pnpm smoke:prod -- --egress`: además arranca una emisión hacia YouTube con clave inventada (YouTube la rechaza;
  sirve para ver errores, no prueba la salida).
- Diagnóstico de nodos: `GET /internal/engine/nodes` (Bearer ENGINE_TOKEN) o la pestaña «Servidores» del panel.

## Red de salida del motor (importante)
FFmpeg nunca abre conexiones a Internet: publica en un relé local (`apps/engine/src/relay.ts`) y Node hace el DNS,
el TLS (rtmps con verificación de certificado y SNI) y la conexión. Motivo: el binario estático de FFmpeg para Linux no
resuelve nombres de dominio. Diagnóstico desde un nodo encendido:
`curl -H "authorization: Bearer $ENGINE_TOKEN" https://dni-directos.ibraguimova19.workers.dev/internal/engine/diag`.

## Google (estado a 14-nov-2026)
App **en producción**: cualquier cuenta de Google puede registrarse e iniciar sesión (ámbitos openid/email/profile, sin aviso).
Conectar canales de YouTube usa un ámbito sensible: hasta que Google verifique la app, los usuarios ven el aviso «Google no ha
verificado esta app» (pueden continuar en «Configuración avanzada») y hay un tope de 100 usuarios. La verificación requiere
un dominio propio verificado en Search Console (no se puede verificar un subdominio de workers.dev), vídeo de demostración y
revisión de Google (semanas).
