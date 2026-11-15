# Estrategia de precios — DNI Directos 24/7

> Documento de análisis. **Los planes y precios aplicados están en `docs/PLANES.md`** (camino B híbrido: Gratis, Creador 19 €, Pro 49 €, Agencia 129 €). Las cuentas anteriores a los planes siguen como Fundador, sin límites.
> Las tarifas de la competencia se consultaron el 15/11/2026 en sus webs públicas (o en comparativas cuando la web no publica cifras).
> Pueden cambiar: hay que revisarlas antes de publicar precios propios.

## 1. Lo que cobra la competencia (emisión 24/7 de vídeos grabados)

| Servicio | Precio de entrada para 24/7 | Lo que incluye | Notas |
|---|---|---|---|
| **StreamingBots** | **20 $/mes** por emisión (tachado 30 $) | 1080p30, audio 320 kbps, 65 GB, hasta 3 destinos, RTMP propio | Prueba de 24 h, reembolso en 7 días, cada emisión extra cuesta otros 20 $ |
| **Upstream.so** | **30 $/mes** (24 $ al año) | 1 emisión 1080p30, horas ilimitadas, 30+ plataformas, hasta 10 a la vez | Plan gratuito de 24 h/mes. 2 emisiones = 50 $, 3 = 70 $, a partir de 4 = 20 $/emisión. 60 fps y 4K cuestan aparte |
| **Gyre** | **49 $/mes** (Start) · 99 $ (Start+, 4 HD) · 169 $ (Pro+, 8 HD) | 1080p60, de 35 a 150 GB, 7 plataformas, servidor e IP dedicados | Prueba de 7 días con tarjeta. Oferta de Black Friday anual: unos 28,6 $/mes |
| **LiveReacting** | **39,99 $/mes** por emisión (33 $ al año) | 1080p, 5 destinos, sin límite de duración | Descuento por volumen de hasta 20 emisiones |
| **Livepush** | **39 $/mes** (Creators, 32,5 $ al año) | 24/7 con playlists | Su propia letra pequeña dice que «ilimitado» no incluye 24/7 continuo completo (unas 720 h) |
| **OneStream Live** | El 24/7 es un complemento de unos **30 $/mes** por emisión | Solo el plan superior incluye 24/7 (3 emisiones) | No publica todas las cifras (las muestra dentro de la app) |
| **Restream** | Upload & Stream **79 $/mes** o 239 $/mes, que se suma al plan base | Solo esos niveles permiten bucle | **El bucle se corta a las 40 h**: no es 24/7 real |
| **Castr** | Unos **200 $/mes** (Premium) | Bucle de hasta 30 días, 3 emisiones de vídeo grabado | Los planes baratos no permiten bucle |

**Conclusión del mercado:** el precio de referencia de una emisión 24/7 a 1080p está entre **20 y 49 $/mes**. Ninguno de estos servicios ofrece:
- una **vista previa en directo con sonido y vúmetros** de la señal que se envía;
- **grabación automática** de la emisión;
- **estado verificado en YouTube** a través de la API oficial;
- **miniaturas sincronizadas con YouTube**.

Nosotros ya los tenemos: son nuestra palanca para cobrar más que el más barato.

## 2. Lo que nos cuesta a nosotros en Cloudflare (cifras oficiales, 15/11/2026)

**Workers Paid: 5 $/mes.** Incluye 25 GiB-h de memoria, 375 vCPU-min, 200 GB-h de disco y **1 TB de tráfico de salida al mes**, una sola vez para toda la cuenta.

| Recurso | Tarifa |
|---|---|
| Memoria del contenedor | 0,0000025 $/GiB-s (se cobra la memoria reservada, se use o no) |
| CPU | 0,000020 $/vCPU-s (solo uso real) |
| Disco | 0,00000007 $/GB-s (reservado) |
| **Tráfico de salida** | **0,025 $/GB** en Norteamérica y Europa, 0,04–0,05 $/GB en el resto |
| R2 | 0,015 $/GB-mes de almacenamiento, 4,50 $ por millón de operaciones A, 0,36 $ por millón de operaciones B, descargas gratis |

### Coste de una emisión 24/7 (730 h/mes)

| Concepto | 720p30 (3,1 Mb/s) | 1080p30 (6,2 Mb/s) | 1080p30 optimizado (4,7 Mb/s) |
|---|---|---|---|
| Tráfico por destino | 1,03 TB → **25,7 $** | 2,02 TB → **50,6 $** | 1,53 TB → **38,3 $** |
| Cuota de nodo de emisión (standard-3: 8 GiB y 2 vCPU para 4 emisiones; memoria 52,6 $ + disco 2,9 $ + CPU estimada ~20 $) | ≈ 19 $ | ≈ 19 $ | ≈ 19 $ |
| Grabación con 7 días de retención (opcional) | 237 GB → 3,6 $ + ~1,6 $ de operaciones | 465 GB → 7,0 $ + ~1,6 $ | 355 GB → 5,3 $ + ~1,6 $ |
| **Total, 1 destino, sin grabar** | **≈ 45 $** | **≈ 70 $** | **≈ 57 $** |
| Cada destino extra | +25,7 $ | +50,6 $ | +38,3 $ |

La CPU real de un nodo con 4 emisiones en modo copia **no está medida todavía**: la cifra de 20 $ es una estimación prudente. El contador de CPU del panel de Cloudflare durante un directo largo permite afinarla.

> **Lo más importante:** en Cloudflare Containers lo caro es el **tráfico de salida**, no la CPU. Una emisión 1080p 24/7 sale por ~2 TB al mes, unos 50 $ por cada destino.
> La competencia que cobra 20–30 $ usa servidores dedicados con tráfico ilimitado. Con la infraestructura actual, 100 % Cloudflare, **no se puede igualar ese precio sin perder dinero**.

## 3. Dos caminos

### Camino A — 100 % Cloudflare (lo que hay hoy)
Con un margen bruto del 55–60 %, los precios tendrían que ser altos. Encaja con planes por horas o con un posicionamiento premium/empresa:

| Plan | Precio | Incluye | Coste estimado | Margen |
|---|---|---|---|---|
| Gratis | 0 $ | 1 emisión 720p, 1 destino, 24 h/mes, 5 GB, sin grabación | ~1,5 $/usuario activo | — |
| Programados | 19 $/mes | 1 emisión 1080p, 2 destinos, **150 h/mes** (directos programados, no 24/7), 50 GB, vista previa | ~14 $ | 26 % |
| 24/7 HD | 99 $/mes | 1 emisión 24/7 a 720p, 1 destino, grabación 3 días, 100 GB | ~50 $ | 50 % |
| 24/7 Full HD | 149 $/mes | 1 emisión 24/7 a 1080p optimizado, 1 destino, grabación 7 días, 200 GB | ~65 $ | 56 % |
| Destino extra | +39 $/mes | Por destino a 1080p | 38 $ | ≈ 0 % |

Es viable, pero queda **2–5 veces por encima del mercado**. Solo se vende con un argumento muy fuerte de fiabilidad y funciones exclusivas.

### Camino B — híbrido (recomendado para competir)
Panel, API, base de datos, almacenamiento, grabaciones y web siguen en Cloudflare. Los **nodos de emisión** se ejecutan, además, en servidores dedicados con tráfico ilimitado. Por ejemplo, uno de 1 Gb/s a 40–60 €/mes aguanta unas 60 emisiones 1080p en modo copia, con holgura: menos de **1 $ por emisión**.

El motor ya está preparado para esto:
- es un agente Node que reclama emisiones a la API por HTTPS, con lease y fencing;
- funciona igual en Cloudflare Containers que en cualquier servidor (`scripts/engine-prod.mjs`);
- Cloudflare quedaría como capacidad de reserva automática si un servidor cae.

Con ese coste, los planes pueden competir de frente:

| Plan | Mensual | Anual (−20 %) | Incluye |
|---|---|---|---|
| **Gratis** | 0 $ | — | 1 emisión 720p · 1 destino · 24 h/mes · 5 GB · vista previa |
| **Creador** | **24 $** | 19 $/mes | 1 emisión **24/7 a 1080p** · 3 destinos · 75 GB · vista previa con sonido · miniaturas y sincronía con YouTube · grabación de 24 h (retención de 3 días) |
| **Pro** | **59 $** | 47 $/mes | 3 emisiones 24/7 · 5 destinos cada una · 250 GB · grabación ilimitada con 7 días de retención y exportación a MP4 · programación · alertas |
| **Agencia** | **149 $** | 119 $/mes | 10 emisiones · 10 destinos · 1 TB · 30 días de retención · equipo con roles · API · soporte prioritario |
| Extras | — | — | Emisión adicional 15 $/mes · +100 GB por 5 $/mes · grabación con 30 días de retención por 9 $/mes y emisión |

**Margen estimado del camino B:**
- Creador (24 $): unos 3 $ de coste (nodo dedicado, R2 y su parte de los 5 $ de Workers), un **85 %** de margen.
- Pro (59 $): unos 10 $ de coste, también en torno al 85 %.

Esto deja sitio para descuentos sin entrar en pérdidas.

## 4. Cómo justificar ir algo por encima de los más baratos
- **Vista previa real con sonido**: se ve y se oye la señal que sale, con vúmetros L/R y alertas de silencio y saturación. Nadie más la ofrece.
- **Grabación automática en la nube** con exportación a MP4 y enlaces firmados para compartir.
- **Estado verificado en YouTube** (API oficial: «YouTube recibe la señal») y **creación del directo con un clic**.
- **Estudio de miniaturas** integrado, con envío automático a YouTube.
- **Recuperación automática** probada: relevo de nodo con fencing, reconexión por destino y un directo de 10 h con 3 cortes de YouTube recuperados en 6–8 s.
- **Transparencia**: sin métricas inventadas y estado real por destino.

## 5. Reglas para cuando se active el cobro
- **No prometer «ilimitado»** en almacenamiento ni en grabación: tiene un coste real por GB. Hay que poner límites claros y vender ampliaciones.
- Medir de verdad **CPU por nodo** y **GB de salida por emisión** durante un mes antes de cerrar los precios. Las cifras de este documento salen de la tarifa oficial y del bitrate configurado, no de facturas reales.
- Si se elige el camino A, bajar el bitrate de 1080p a ~4,5 Mb/s, dentro del rango que recomienda YouTube. Ahorra un 25 % de tráfico sin pérdida visible en contenido grabado.
- Los planes de pago necesitan Stripe (P1, pendiente). El plan `restricted` de `packages/shared/src/schemas.ts` ya sirve de base para aplicar cuotas.
