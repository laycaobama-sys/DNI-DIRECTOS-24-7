# Seguridad

## Implementado
- **Multi-tenancy:** todo recurso lleva `organization_id` y toda consulta de `/v1` filtra por la organización de la
  sesión. Un recurso ajeno responde 404 (no se confirma su existencia). Cubierto por la prueba IDOR del e2e.
- **Roles:** owner > admin > editor > operator > viewer, comprobados en el servidor (`requireAuth(minRole)`).
  Destinos y claves: admin. Crear y editar: editor. Iniciar y detener: operator.
- **Autenticación:** PBKDF2-SHA256 (100.000 iteraciones, el máximo de WebCrypto en Workers) con sal por usuario;
  token de sesión aleatorio de 256 bits guardado solo como hash; cookie `httpOnly`, `SameSite=Lax`, `Secure` en
  producción. Nada en `localStorage`. Verificación en tiempo constante y hash señuelo contra la enumeración de emails.
- **CSRF:** toda mutación exige la cabecera `X-Requested-With` y, si viene `Origin`, que esté permitido. CORS limitado a `APP_ORIGINS`.
- **Cabeceras:** CSP restrictiva en la API, `nosniff`, `X-Frame-Options: DENY`, HSTS en producción.
- **Rate limiting:** ventana fija en D1 para registro (30/h por IP) y login (10/15 min por IP+email).
- **Claves de emisión:** AES-256-GCM con AAD ligado al id del destino; la API solo devuelve los últimos 4 caracteres;
  redactadas en logs y eventos (`redactRtmp`) en el motor y de nuevo en el servidor.
- **SSRF:** destinos solo `rtmp://` o `rtmps://`, sin credenciales en la URL, sin caracteres de shell, y bloqueo de
  loopback, redes privadas, link-local, CGNAT, IPv6 locales y literales numéricos. RTMP sin cifrar exige consentimiento.
- **FFmpeg:** siempre `spawn` con array de argumentos (sin shell); el usuario nunca aporta flags ni rutas;
  `-protocol_whitelist file` y lista blanca de contenedores para que un archivo malicioso no abra URLs ni otros ficheros.
- **API interna del motor:** `Bearer ENGINE_TOKEN` (mínimo 24 caracteres, comparación en tiempo constante) más fencing token.
- **Almacenamiento:** R2 sin acceso público; los objetos solo se sirven a través de rutas autenticadas.
- **Auditoría:** tabla `audit_logs` con actor, acción, recurso e IP.

## Riesgos y carencias conocidas
- **Sin verificación de email, recuperación de contraseña ni 2FA.** No apto para clientes reales todavía.
- `ENGINE_TOKEN` es un secreto compartido por todos los nodos: quien lo obtenga accede a los medios y claves de todas
  las organizaciones. Mejora prevista: credenciales por nodo y de corta duración.
- **DNS rebinding:** la validación de destinos es por nombre; un dominio público puede resolver a una IP privada.
  El motor debe comprobar la IP resuelta antes de conectar (pendiente) y ejecutarse con salida de red restringida.
- El rate limiting en D1 no cubre el resto de endpoints. Falta WAF o Turnstile en el registro.
- PBKDF2 a 100.000 iteraciones está por debajo de las recomendaciones actuales; migrar a un KDF con memoria cuando sea posible.
- Sin antivirus sobre las subidas, sin límites cgroup verificados y sin análisis de dependencias en CI.
- Sin documentos legales (privacidad, términos, DPA, proceso de copyright): obligatorios antes de producción.
- Ninguna revisión de seguridad externa.

## Reporte de vulnerabilidades
Abre un aviso privado en GitHub (Security → Report a vulnerability). No publiques detalles en issues.
