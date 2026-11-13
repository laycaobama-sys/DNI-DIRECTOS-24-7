# Plan de implementación — siguiente incremento

La tabla de fases y su estado está en `PRODUCT_REQUIREMENTS.md`; la lista priorizada, en `../TODO.md`.

1. Desplegar API + D1 + R2 en Cloudflare y ejecutar el e2e contra ese entorno.
2. Durable Object que mantiene el contenedor del motor; validar salida RTMPS y ejecución continua.
3. Ensayo de 24–48 h contra un canal de YouTube no listado, midiendo egress, reconexiones y coste.
4. Verificación de email, recuperación de contraseña y páginas legales.
5. UI de programación y vista previa HLS de baja resolución.
6. Stripe y OAuth de YouTube cuando existan las cuentas.

Criterio para dar por cerrado cada punto: prueba reproducible añadida a `ACCEPTANCE_TESTS.md` con su evidencia.
