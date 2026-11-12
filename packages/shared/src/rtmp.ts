/** Validación de destinos RTMP(S) con protección SSRF y enmascarado de secretos. */

export interface RtmpValidationOptions {
  /** Solo para desarrollo/pruebas: permite localhost y redes privadas. */
  allowPrivate?: boolean;
}

export type RtmpValidation =
  | { ok: true; url: string; secure: boolean; host: string }
  | { ok: false; code: string; message: string };

export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  // Literales numéricos alternativos (decimal/hex/octal) que algunos resolvers aceptan como IP.
  if (/^(0x[0-9a-f]+|\d+)$/i.test(h)) return true;
  if (h.includes(':')) {
    // IPv6: loopback, link-local, ULA, mapeadas a IPv4.
    return h === '::1' || h === '::' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('::ffff:');
  }
  return false;
}

/** Valida la URL base del servidor de ingest (sin stream key). */
export function validateRtmpUrl(raw: string, opts: RtmpValidationOptions = {}): RtmpValidation {
  const input = raw.trim();
  if (input.length > 512) return { ok: false, code: 'url_too_long', message: 'La URL es demasiado larga.' };
  if (/[\s"'`\\<>|;&$]/.test(input)) return { ok: false, code: 'url_invalid_chars', message: 'La URL contiene caracteres no permitidos.' };
  let u: URL;
  try {
    // URL no entiende rtmp como esquema "especial"; se analiza sustituyéndolo por http(s).
    const m = input.match(/^(rtmps?):\/\/(.+)$/i);
    if (!m) return { ok: false, code: 'url_scheme', message: 'La URL debe empezar por rtmp:// o rtmps://.' };
    u = new URL(`${m[1]!.toLowerCase() === 'rtmps' ? 'https' : 'http'}://${m[2]}`);
  } catch {
    return { ok: false, code: 'url_malformed', message: 'La URL no es válida.' };
  }
  if (u.username || u.password) return { ok: false, code: 'url_credentials', message: 'No incluyas usuario o contraseña en la URL; usa el campo de clave.' };
  if (!u.hostname) return { ok: false, code: 'url_host', message: 'Falta el servidor en la URL.' };
  if (!opts.allowPrivate && isPrivateHost(u.hostname)) {
    return { ok: false, code: 'url_private_host', message: 'No se permiten destinos en redes privadas o locales.' };
  }
  const secure = u.protocol === 'https:';
  const port = u.port ? `:${u.port}` : '';
  const path = u.pathname.replace(/\/+$/, '');
  return { ok: true, secure, host: u.hostname, url: `${secure ? 'rtmps' : 'rtmp'}://${u.hostname}${port}${path}` };
}

export function validateStreamKey(key: string): { ok: true } | { ok: false; message: string } {
  if (key.length < 1 || key.length > 512) return { ok: false, message: 'La clave de emisión debe tener entre 1 y 512 caracteres.' };
  if (!/^[A-Za-z0-9._~\-?=&%+/:@]+$/.test(key)) return { ok: false, message: 'La clave de emisión contiene caracteres no permitidos.' };
  return { ok: true };
}

export const joinRtmp = (url: string, key: string) => `${url.replace(/\/+$/, '')}/${key.replace(/^\/+/, '')}`;

export function maskSecret(secret: string): string {
  if (secret.length <= 4) return '••••';
  return `••••••••${secret.slice(-4)}`;
}

/** Elimina claves de emisión de cualquier texto de log (rtmp://host/app/CLAVE → rtmp://host/app/***). */
export function redactRtmp(text: string): string {
  return text.replace(/(rtmps?:\/\/[^\s/'"]+(?:\/[^\s/'"]+)?)\/[^\s'"]+/gi, '$1/***');
}
