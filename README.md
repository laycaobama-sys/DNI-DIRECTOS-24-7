# DNI Directos 24/7

SaaS de emisión continua: sube vídeos, ordénalos en una playlist y emítelos 24/7 a cualquier destino RTMP(S)
desde la nube. Especificación: [`docs/MASTER_SPEC.md`](docs/MASTER_SPEC.md).

> **Estado: MVP probado en local.** El motor de emisión funciona de extremo a extremo contra servidores RTMP locales.
> **Aún no está desplegado en Cloudflare** (la cuenta necesita R2 y Workers Paid; después basta `pnpm deploy:cloudflare`) **ni se ha emitido nunca a YouTube o Twitch.** Lista exacta de lo probado y lo
> pendiente en [`docs/ACCEPTANCE_TESTS.md`](docs/ACCEPTANCE_TESTS.md).

## Arranque local (sin Docker)

Requisitos: Node 22+ y pnpm 11. FFmpeg y el servidor RTMP de pruebas se instalan solos.

```bash
pnpm install
pnpm tools:setup   # secretos locales, MediaMTX, migraciones
pnpm dev           # http://localhost:5173
pnpm seed          # opcional: cuenta y emisión de demostración
```

## Comprobaciones

```bash
pnpm typecheck && pnpm lint && pnpm test   # 50 tests unitarios
pnpm build
pnpm test:e2e-stream                        # 42 comprobaciones con emisión RTMP real (~3 min)
```

## Estructura

```
apps/api         Cloudflare Worker (Hono) + D1 + R2: API pública /v1 y contrato interno del motor
apps/engine      Nodo de emisión: FFmpeg, conversión, playout, fan-out, recuperación
apps/web         Dashboard y landing (React + Vite + Tailwind)
packages/shared  Esquemas, máquina de estados, secuenciador, programación con DST, validación RTMP
infra/           Dockerfile del motor, docker-compose y workflow de CI (sin ejecutar todavía)
scripts/         setup, dev, seed y prueba e2e
docs/            Arquitectura, pruebas de aceptación, seguridad, operación, auditoría de referencias
```

## Documentación
[Arquitectura](docs/ARCHITECTURE.md) · [Pruebas de aceptación](docs/ACCEPTANCE_TESTS.md) ·
[Seguridad](docs/SECURITY.md) · [Operación y despliegue](docs/OPERATIONS.md) · [Pendientes](TODO.md)

## Aviso
Emite solo contenido del que tengas los derechos. Este software no garantiza monetización, alcance ni horas de
visualización, y debe usarse respetando las normas de cada plataforma.
