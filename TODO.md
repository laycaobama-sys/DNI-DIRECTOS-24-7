# TODO (por prioridad)

## P0 — antes de cualquier cliente real
- [ ] **Titular:** activar R2 y Workers Paid en Cloudflare; después `pnpm deploy:cloudflare`
- [ ] Validar en Cloudflare real el nodo `EngineNode`: arranque del cargador, RTMPS saliente, ejecución continua y coste
- [ ] Ensayo de 24–48 h con destino real autorizado; medir egress y coste
- [ ] Construir y probar la imagen Docker y el compose
- [ ] Verificación de email, recuperación de contraseña, 2FA
- [x] Comprobación de IP resuelta en el motor (DNS rebinding)
- [ ] Salida de red restringida en el contenedor
- [ ] Términos, privacidad, cookies, DPA y proceso de copyright
- [ ] Activar CI (mover `infra/ci/github-actions-ci.yml` a `.github/workflows/`)

## P1
- [ ] OAuth de YouTube: crear y enlazar directos
- [ ] UI de programación; ejercitar el cron; alertas por email/webhook
- [ ] Vista previa HLS real
- [ ] Credenciales por nodo en lugar de `ENGINE_TOKEN` compartido
- [ ] Playwright para los flujos de UI; auditoría de accesibilidad
- [ ] Panel de administración; gestión de equipo e invitaciones
- [ ] Invitar usuarios con el registro cerrado (hoy: abrir `ALLOW_SIGNUPS` temporalmente)

## P2
- [ ] Radio (audio + fondo), overlays y diseñador, 9:16
- [ ] API pública con tokens, webhooks, OpenAPI
- [ ] i18n EN, blog, páginas de soluciones, sitemap
- [ ] Deduplicación por SHA-256, carpetas y etiquetas
- [ ] Emisión redundante entre nodos
