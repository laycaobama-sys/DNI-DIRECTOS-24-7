# TODO (por prioridad)

## P0 — antes de cualquier cliente real
- [ ] Desplegar en Cloudflare (Workers, D1, R2) y repetir el e2e en remoto
- [ ] Motor en Cloudflare Containers con Durable Object de control; validar RTMPS saliente y ejecución continua
- [ ] Ensayo de 24–48 h con destino real autorizado; medir egress y coste
- [ ] Construir y probar la imagen Docker y el compose
- [ ] Verificación de email, recuperación de contraseña, 2FA
- [ ] Comprobación de IP resuelta en el motor (DNS rebinding) y salida de red restringida
- [ ] Términos, privacidad, cookies, DPA y proceso de copyright
- [ ] Activar CI (mover `infra/ci/github-actions-ci.yml` a `.github/workflows/`)

## P1
- [ ] Stripe: checkout, portal, webhooks idempotentes, entitlements
- [ ] OAuth de YouTube: crear y enlazar directos
- [ ] UI de programación; ejercitar el cron; alertas por email/webhook
- [ ] Vista previa HLS real
- [ ] Credenciales por nodo en lugar de `ENGINE_TOKEN` compartido
- [ ] Playwright para los flujos de UI; auditoría de accesibilidad
- [ ] Panel de administración; gestión de equipo e invitaciones
- [ ] Suspensión automática al agotar las horas del plan (hoy solo se bloquea el inicio)

## P2
- [ ] Radio (audio + fondo), overlays y diseñador, 9:16
- [ ] API pública con tokens, webhooks, OpenAPI
- [ ] i18n EN, blog, páginas de soluciones, sitemap
- [ ] Deduplicación por SHA-256, carpetas y etiquetas
- [ ] Emisión redundante entre nodos
