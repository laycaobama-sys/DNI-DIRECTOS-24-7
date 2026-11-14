/**
 * Relé local de RTMP/RTMPS.
 *
 * FFmpeg publica en `rtmp://127.0.0.1:<puerto>/...` y este relé abre la conexión real con el destino desde Node:
 *  - DNS hecho por Node (el FFmpeg estático de Linux no puede resolver nombres con glibc estática),
 *  - IPv4 preferente (algunos contenedores anuncian IPv6 sin salida y FFmpeg se quedaba colgado),
 *  - TLS de Node para rtmps:// con verificación de certificado y SNI correctos,
 *  - errores de conexión precisos para mostrarlos al usuario.
 * El `tcUrl` que FFmpeg envía en el comando RTMP «connect» se fija al del destino real (-rtmp_tcurl), así el
 * servidor de ingesta ve exactamente lo mismo que con una conexión directa.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface ParsedTarget { scheme: 'rtmp' | 'rtmps'; host: string; port: number; explicitPort: boolean; path: string; app: string }

export function parseTarget(url: string): ParsedTarget | null {
  const m = /^(rtmps?):\/\/(\[[^\]]+\]|[^/:?#]+)(?::(\d{1,5}))?\/([^?#]*)$/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase() as 'rtmp' | 'rtmps';
  const path = m[4]!.replace(/^\/+/, '');
  return {
    scheme, host: m[2]!.replace(/^\[|\]$/g, ''), port: m[3] ? Number(m[3]) : scheme === 'rtmps' ? 443 : 1935, explicitPort: !!m[3],
    path, app: path.split('/')[0] ?? '',
  };
}

export interface Relay {
  /** URL a la que debe publicar FFmpeg. */
  localUrl: string;
  /** tcUrl del destino real (para -rtmp_tcurl). */
  tcUrl: string;
  /** Último error del tramo relé → destino, legible para el usuario. */
  error(): string | null;
  /** Bytes enviados al destino por este relé. */
  bytesOut(): number;
  close(): void;
}

function describe(e: NodeJS.ErrnoException, t: ParsedTarget): string {
  const where = `${t.host}:${t.port}`;
  switch (e.code) {
    case 'ECONNREFUSED': return `El servidor ${where} rechazó la conexión.`;
    case 'ETIMEDOUT': case 'ESOCKETTIMEDOUT': return `Tiempo de espera agotado al conectar con ${where}.`;
    case 'ENETUNREACH': case 'EHOSTUNREACH': return `No hay ruta de red hasta ${where}.`;
    case 'ECONNRESET': return `${t.host} cortó la conexión. Si persiste, revisa la clave de emisión y que el directo esté habilitado.`;
    default:
      if (/certificate|SSL|TLS/i.test(e.message)) return `Error TLS con ${t.host}: ${e.message}`;
      return `Error de conexión con ${where}: ${e.message}`;
  }
}

/** `address` es la IP ya resuelta y validada (anti-SSRF): el relé conecta exactamente a esa IP. */
export function openRelay(t: ParsedTarget, address: string): Promise<Relay> {
  let lastError: string | null = null;
  let out = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    client.setNoDelay(true);
    sockets.add(client);
    const isIp = net.isIP(t.host) !== 0;
    const upstream: net.Socket = t.scheme === 'rtmps'
      ? tls.connect({ host: address, port: t.port, servername: isIp ? undefined : t.host, ALPNProtocols: undefined, timeout: 15_000 })
      : net.connect({ host: address, port: t.port, timeout: 15_000 });
    sockets.add(upstream);
    upstream.setNoDelay(true);
    let upstreamOpen = false;
    upstream.once(t.scheme === 'rtmps' ? 'secureConnect' : 'connect', () => { upstreamOpen = true; upstream.setTimeout(0); });
    upstream.on('timeout', () => { lastError = `Tiempo de espera agotado al conectar con ${t.host}:${t.port}.`; upstream.destroy(); });
    upstream.on('error', (e) => { lastError = describe(e as NodeJS.ErrnoException, t); client.destroy(); });
    upstream.on('close', () => {
      // Cierre del servidor tras conectar sin error de red: típico de clave rechazada o directo no preparado.
      if (upstreamOpen && !lastError && !client.destroyed) lastError = `${t.host} cerró la conexión. Comprueba la clave de emisión y que tu canal tenga los directos activados.`;
      client.destroy();
      sockets.delete(upstream);
    });
    client.on('error', () => upstream.destroy());
    client.on('close', () => { upstream.destroy(); sockets.delete(client); });
    client.on('data', (d: Buffer) => { out += d.length; });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({
        localUrl: `rtmp://127.0.0.1:${port}/${t.path}`,
        tcUrl: `${t.scheme}://${t.host.includes(':') ? `[${t.host}]` : t.host}${t.explicitPort ? `:${t.port}` : ''}/${t.app}`,
        error: () => lastError,
        bytesOut: () => out,
        close: () => { for (const s of sockets) s.destroy(); server.close(); },
      });
    });
  });
}
