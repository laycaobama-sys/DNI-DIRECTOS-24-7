# Auditoría de referencias públicas

Consultadas el 13-nov-2026 solo las páginas públicas indicadas. No se ha accedido a paneles privados ni a zonas con
autenticación. Los precios y límites cambian: volver a comprobarlos antes de usarlos.

## VERIFICADO_PÚBLICAMENTE

| | Gyre (`gyre.pro/pricing`) | Upstream (`upstream.so/pricing`) | StreamingBots (`streamingbots.com/es`) |
|---|---|---|---|
| Entrada | Prueba 7 días, con marca de agua | Gratis: 1 stream, 24 h/mes, 1080p30 | Prueba de 24 h |
| Precio base | Start 49 USD/mes | 30 USD/mes por stream (20 desde 4) | SOLO 20 USD/mes |
| Escalado | Start+ 99, PRO+ 169 USD/mes | Por número de streams; descuento anual | Plan único |
| Simultáneos | 1 / 4 / 8 HD según plan | Según streams contratados | No indicado |
| Destinos | 8 plataformas listadas | Hasta 10 a la vez, 30+ plataformas, RTMP/SRT | Hasta 3; RTMP personalizado |
| Almacenamiento | 35 / 75 / 150 GB | Sin cuota publicada | 65 GB |
| Calidad | 1080p60, 4K en planes altos | 1080p30/60, 4K | 1080p30 |
| Extras | Programador, playlists, conversor, vertical, 360° | API, MCP, Stream Designer, Live Studio, equipo | Radio 24/7, overlays, programación, recuperación |

## INFERENCIA
- El modelo dominante es precio por stream simultáneo con horas ilimitadas; el egress se absorbe en el precio.
- Todos venden «sin tener el ordenador encendido» como propuesta principal y RTMP personalizado como red de seguridad.
- La recuperación automática se anuncia, pero ninguno publica cómo la mide.

## PROPUESTA_PROPIA
- Estado honesto por destino (solo «en directo» si la salida avanza) y registro de eventos visible para el cliente.
- Edición de playlist en directo aplicada en corte limpio.
- Planes con límite de horas medido por el motor en lugar de «ilimitado», hasta conocer el coste real de egress.
- Sin testimonios, logos ni contadores hasta tener clientes reales.

## NO_VERIFICABLE_SIN_ACCESO
- Paneles, asistentes de creación y editores de los tres productos.
- Arquitectura, fiabilidad real, tiempos de recuperación y cumplimiento del uptime anunciado.
- Páginas de funcionalidades y de API no consultadas en esta pasada (`gyre.pro/features`, `upstream.so/live-streaming-api`).
