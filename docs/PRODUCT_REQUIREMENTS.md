# Requisitos de producto (resumen operativo)

Fuente completa: `MASTER_SPEC.md`. Este documento fija el alcance del MVP y los supuestos tomados.

**Usuario objetivo:** creadores, iglesias, radios con derechos, formación y negocios que quieren un canal continuo sin
mantener un equipo encendido.

**Recorrido del MVP (implementado):** registro → subir vídeos → playlist publicada → destino RTMP(S) → crear emisión →
iniciar → monitor con estado real → editar en directo → detener.

## Alcance
| Módulo | Estado |
|---|---|
| Registro, login, organización, roles en API | Hecho |
| Biblioteca: subida reanudable, análisis, conversión, miniaturas, cuotas | Hecho |
| Playlists con versiones, arrastrar y soltar, publicación | Hecho |
| Destinos RTMP(S) con claves cifradas y rotación | Hecho |
| Emisiones: crear, iniciar, detener, reiniciar, monitor, eventos | Hecho |
| Resumen con consumo medido | Hecho |
| Programación | API y lógica DST hechas; sin UI ni ensayo del cron |
| Diseñador, radio, 9:16, vista previa | Pendiente (`Próximamente`) |
| Stripe, OAuth de YouTube, equipo, API pública, admin, analíticas externas | Pendiente |
| Verificación de email, recuperación de contraseña, 2FA, i18n EN, páginas legales, blog | Pendiente |

## Supuestos
1. «Todo en Cloudflare» prevalece sobre la pila propuesta en la especificación (ver `ARCHITECTURE.md`).
2. Marca de trabajo «DNI Directos 24/7», tomada del nombre del repositorio; diseño y textos propios.
3. Solo vídeo en playlists; audio e imagen se analizan pero aún no se emiten.
4. Sin precios publicados hasta medir costes reales; la landing lo dice expresamente.
5. No se replica la identidad de ningún competidor: se compite en funciones y patrones generales.

# Plan de implementación

| Fase | Contenido | Estado |
|---|---|---|
| 0 | Auditoría, arquitectura Cloudflare, documentación | Hecho |
| 1 | Auth, organizaciones, biblioteca, conversión, dashboard | Hecho (falta verificación de email y recuperación) |
| 2 | Playlists, motor FFmpeg, RTMP local, estados, controles, heartbeat | **Hecho y probado en local** |
| 3 | Loop, recuperación, fan-out, cuotas, edición en directo | Hecho y probado; scheduler parcial; alertas pendientes |
| 4 | Stripe, OAuth YouTube, admin, emails, legal | Pendiente (requiere cuentas externas) |
| 5 | Radio, diseñador, 9:16, equipo, API pública, MCP | Pendiente |
| 6 | Despliegue en Cloudflare, ensayos de 24 h+, copias, observabilidad | Pendiente (requiere acceso) |
