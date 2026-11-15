# Planes, límites y camino B (híbrido)

Fuente única de verdad: `PUBLIC_PLANS` en `packages/shared/src/schemas.ts`. La API aplica estos límites; la landing,
la página «Plan» del panel, el JSON-LD y `llms.txt` se generan a partir de ellos (no hay precios copiados a mano).

## Planes que se muestran en la aplicación (EUR/mes, IVA no incluido)

| | **Gratis** | **Creador** ★ | **Pro** | **Agencia** |
|---|---|---|---|---|
| Precio mensual | 0 € | 19 € | 49 € | 129 € |
| Precio pagando anual (equivalente/mes) | — | 15 € (180 €/año) | 39 € (468 €/año) | 103 € (1.236 €/año) |
| Emisiones 24/7 simultáneas | 1 | 1 | 3 | 10 |
| Horas de emisión al mes | 24 h | ilimitadas (744 h = 24/7) | ilimitadas (3 × 744 h) | ilimitadas (10 × 744 h) |
| Calidad máxima | 720p 30 fps | 1080p 60 fps | **4K 30 fps** | **4K 30 fps** |
| Destinos por emisión (multistream) | 1 | 3 | 5 | 10 |
| Almacenamiento de vídeos | 5 GB | 75 GB | 250 GB | 1 TB |
| Tamaño máximo por archivo | 2 GB | 4 GB | 4 GB | 4 GB |
| Grabación del directo en la nube | — | 3 días | 7 días + MP4 | 30 días + MP4 |
| Audiencia en tiempo real (YouTube) | — | sí | sí | sí |
| Programación de emisiones | — | sí | sí | sí |
| Directo nuevo en YouTube en cada inicio | sí | sí | sí | sí |
| Miniatura automática en YouTube | sí | sí | sí | sí |
| Vista previa con sonido y vúmetros | sí | sí | sí | sí |
| Soporte | correo | correo | correo | prioritario |

Reglas que aplica el servidor (comprobadas en la API, no solo en la interfaz):
- **Emisiones simultáneas**: al iniciar se rechaza si ya hay tantas como permite el plan.
- **Horas al mes**: el cron detiene la emisión al agotar las horas (solo afecta al plan Gratis en la práctica).
- **Calidad**: el perfil de la emisión debe estar en el plan (4K solo Pro/Agencia).
- **Destinos**, **almacenamiento**, **tamaño de archivo**: se validan al crear/subir.
- **Grabación**: solo si el plan la incluye; la retención se recorta al máximo del plan.
- **Audiencia**: el cron solo guarda métricas de YouTube para planes con `audience`.
- **Programación**: crear programaciones requiere `scheduling`.
- Las cuentas que ya existían antes de los planes (`trial`, `free`, `founder`) siguen **sin límites** (Fundador).
  Las cuentas nuevas empiezan en **Gratis**. El propietario puede cambiar el plan de cualquiera en Admin → Usuarios.

### Cómo se cobra
1. Crea en Stripe (o Lemon Squeezy / Paddle) un **enlace de pago** por plan y periodo (Stripe → Payment Links).
2. Pégalos en **Admin → Ajustes → Cobro de los planes**.
3. El cliente pulsa «Contratar» en su panel → paga en la pasarela (va con `client_reference_id` = su organización)
   → la solicitud aparece en **Admin → Planes** → «Activar plan».
   Sin enlace configurado, la solicitud queda registrada y contactas tú al cliente.

## Por qué estos precios (competencia, noviembre de 2026)
- Gyre: 4K solo desde planes de ~99 $/mes; 1080p 24/7 en planes de 30–50 $. Creador a 19 € con 1080p60 es más barato.
- Upstream/LiveReacting/Restream: cobran por horas o limitan el 24/7; aquí las horas son ilimitadas en todos los de pago.
- Diferenciales propios: directo nuevo automático en YouTube en cada inicio, miniatura automática, audiencia real,
  grabación en la nube, vista previa con sonido, cambio de playlist en directo sin cortes.

## Camino B — híbrido (recomendado)

**Idea**: el panel, la API, la base de datos y el almacenamiento siguen en Cloudflare (Workers + D1 + R2). La emisión
(lo que consume ancho de banda 24/7) sale de **servidores dedicados con tráfico ilimitado**. Cloudflare Containers
queda solo como **respaldo automático**: si no hay servidor dedicado con hueco, la emisión arranca en Cloudflare.

Ya está implementado:
- `deploy/dedicated-node/install.sh` + `dni-node.mjs`: instalan el nodo (Node 22 + FFmpeg del sistema + systemd),
  descargan el motor publicado verificando su SHA-256 y se actualizan solos en cada despliegue.
- La API da prioridad a los nodos dedicados: Cloudflare cede durante 20 s las emisiones nuevas cuando hay un nodo
  dedicado con capacidad libre, y solo despierta contenedores para lo que no cabe.

### Dónde comprar y qué servidor
| Opción | Precio aprox. | Red | Para qué |
|---|---|---|---|
| **Hetzner AX41-NVMe** (dedicado, Alemania/Finlandia) — **recomendado** | ~59 €/mes, sin cuota de alta | 1 Gbit/s, tráfico ilimitado | Producción: ~60–80 emisiones 1080p o ~35 en 4K |
| OVH Kimsufi KS-4 (dedicado) — el más barato | ~19 $/mes | 500 Mbit/s, tráfico ilimitado | Empezar: ~30–40 emisiones 1080p |
| Hetzner Cloud CPX21/CX32 (VPS) | 8–10 €/mes | 20 TB/mes incluidos | Pruebas; ~6 emisiones 1080p 24/7 sin pasarse de tráfico |

Precios consultados en noviembre de 2026: compruébalos al contratar. Se compra en hetzner.com → Dedicated → Server
Auction/AX, o en kimsufi.com. Elige Ubuntu 24.04.

Cálculo de capacidad (el motor **no recodifica** al emitir: copia el vídeo ya preparado, así que el límite es la red):
- 1080p30 ≈ 6,2 Mbit/s por destino · 1080p60 ≈ 9,2 · 4K ≈ 20,2 · 720p ≈ 3,2.
- Con 1 Gbit/s y un 50–60 % de margen: ~80 salidas 1080p30 o ~25–35 salidas 4K por servidor.
- Coste por emisión 1080p 24/7 en un AX41 lleno al 60 %: **< 1 €/mes**. Margen del plan Creador (19 €): > 90 %
  descontando R2 (75 GB ≈ 1 €/mes) y Workers (5 $/mes en total).

### Instalación (10 minutos)
```bash
# En el servidor nuevo (como root), con el repositorio copiado:
bash deploy/dedicated-node/install.sh https://TU-DOMINIO dedicado-1 60
nano /etc/dni-node.env      # sustituye PEGA_AQUI_EL_ENGINE_TOKEN por tu ENGINE_TOKEN (no lo compartas)
systemctl start dni-node && journalctl -u dni-node -f
```
En Admin → Servidores aparece «dedicado-1» con su capacidad. Para más capacidad, repite en otro servidor con otro nombre.

## ¿4K como Gyre? Sí
- Perfil `2160p30`: 3840×2160, 30 fps, H.264 High 5.1, 20 Mbit/s, AAC 192 kbps, fotograma clave cada 2 s
  (lo que YouTube recomienda para directos 4K por RTMP).
- Incluido en Pro y Agencia. Los vídeos deben subirse en 4K; la conversión inicial es más lenta (CPU) pero la emisión
  no recodifica, así que un servidor dedicado aguanta decenas de 4K a la vez.
- En Cloudflare Containers (respaldo) 4K funciona pero el tráfico sale caro: por eso 4K tiene sentido con el camino B.
