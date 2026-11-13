import { Link, useParams } from 'react-router-dom';
import { Logo } from '../brand';
import { useTitle } from '../hooks';

/**
 * Textos legales base. Son una plantilla razonable para empezar, NO asesoramiento jurídico:
 * deben revisarse con un profesional antes de abrir el servicio al público de forma comercial.
 */
const DOCS: Record<string, { title: string; updated: string; body: { h: string; p: string[] }[] }> = {
  privacidad: {
    title: 'Política de privacidad',
    updated: '13 de noviembre de 2026',
    body: [
      { h: 'Qué datos tratamos', p: ['Datos de cuenta: nombre, correo electrónico y, si entras con Google, el identificador de tu cuenta de Google, tu nombre y tu foto de perfil pública.', 'Contenido que subes: vídeos, audios, imágenes, playlists y configuración de emisiones.', 'Destinos de emisión: URL del servidor y clave de emisión, que se guardan cifradas.', 'Si conectas un canal de YouTube: el identificador y nombre del canal y un token de acceso que permite crear y gestionar emisiones en tu nombre. Se guarda cifrado.', 'Datos técnicos: registros de emisión, eventos, dirección IP en registros de seguridad y uso del servicio.'] },
      { h: 'Para qué los usamos', p: ['Prestar el servicio: almacenar tus archivos, convertirlos y emitirlos a los destinos que elijas.', 'Seguridad: prevenir abusos, accesos no autorizados y fraude.', 'No vendemos tus datos ni los usamos para publicidad.'] },
      { h: 'Datos de Google y YouTube', p: ['El uso de la información recibida de las API de Google se ajusta a la Política de datos de usuario de los servicios de API de Google, incluidos los requisitos de uso limitado.', 'Solo usamos el acceso a YouTube para crear y gestionar las emisiones en directo que tú solicitas. Puedes revocarlo en cualquier momento desde Destinos o desde la configuración de seguridad de tu cuenta de Google.'] },
      { h: 'Dónde se guardan', p: ['En la infraestructura de Cloudflare (base de datos y almacenamiento de objetos privados). Los archivos no son accesibles públicamente.'] },
      { h: 'Cuánto tiempo', p: ['Mientras mantengas tu cuenta. Los registros de eventos se conservan 30 días. Al borrar un archivo se elimina también del almacenamiento.'] },
      { h: 'Tus derechos', p: ['Puedes acceder, rectificar, exportar o eliminar tus datos y oponerte a su tratamiento escribiendo al responsable del servicio. También puedes reclamar ante la autoridad de protección de datos competente.'] },
    ],
  },
  terminos: {
    title: 'Términos de uso',
    updated: '13 de noviembre de 2026',
    body: [
      { h: 'El servicio', p: ['DNI Directos 24/7 permite emitir en directo contenido pregrabado desde la nube a plataformas de terceros. Actualmente se ofrece de forma gratuita y puede cambiar o interrumpirse.'] },
      { h: 'Tu contenido y tus derechos', p: ['Solo puedes subir y emitir contenido del que tengas los derechos necesarios. Eres responsable del contenido que emites y de cumplir las normas de cada plataforma de destino.', 'Retiraremos el contenido y suspenderemos las cuentas que infrinjan derechos de terceros, la ley o estos términos.'] },
      { h: 'Uso prohibido', p: ['Contenido ilegal, que infrinja derechos de autor o que vulnere las normas de las plataformas; automatizar visitas, comentarios o métricas falsas; intentar acceder a cuentas o datos ajenos; o usar el servicio para dañar a terceros.'] },
      { h: 'Sin garantías de resultados', p: ['No garantizamos monetización, visualizaciones, horas de reproducción ni crecimiento. Las plataformas pueden no archivar directos largos o limitar contenido repetitivo.', 'El servicio se presta «tal cual»; hacemos lo razonable para mantenerlo disponible, pero no garantizamos que no haya interrupciones.'] },
      { h: 'Reclamaciones de derechos de autor', p: ['Si crees que un contenido emitido infringe tus derechos, escríbenos con la identificación de la obra, el enlace a la emisión y tus datos de contacto. Actuaremos con rapidez.'] },
    ],
  },
  cookies: {
    title: 'Política de cookies',
    updated: '13 de noviembre de 2026',
    body: [
      { h: 'Qué cookies usamos', p: ['Solo cookies técnicas imprescindibles: «dni_session» mantiene tu sesión iniciada y «dni_oauth» protege el inicio de sesión con Google durante unos minutos.', 'Guardamos tu preferencia de tema claro u oscuro en el almacenamiento local del navegador.'] },
      { h: 'Sin publicidad ni seguimiento', p: ['No usamos cookies de publicidad, analítica de terceros ni seguimiento entre sitios, por lo que no es necesario un banner de consentimiento.'] },
    ],
  },
};

export default function Legal() {
  const { doc } = useParams();
  const d = DOCS[doc ?? ''] ?? DOCS.privacidad!;
  useTitle(d.title);
  return (
    <div className="dark min-h-dvh bg-ink-950 text-ink-100">
      <header className="border-b border-white/[0.06]"><div className="mx-auto flex h-16 max-w-3xl items-center px-4 sm:px-6"><Link to="/"><Logo /></Link></div></header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{d.title}</h1>
        <p className="mt-2 text-sm text-ink-500">Última actualización: {d.updated}</p>
        <nav className="mt-6 flex flex-wrap gap-2 text-sm" aria-label="Documentos legales">
          {Object.entries(DOCS).map(([k, v]) => <Link key={k} to={`/legal/${k}`} className={k === doc ? 'rounded-full bg-white px-3 py-1 font-semibold text-ink-950' : 'rounded-full px-3 py-1 text-ink-300 ring-1 ring-white/10 hover:bg-white/5'}>{v.title}</Link>)}
        </nav>
        {d.body.map((s) => (
          <section key={s.h} className="mt-10">
            <h2 className="text-xl font-semibold">{s.h}</h2>
            {s.p.map((p) => <p key={p} className="mt-3 leading-relaxed text-ink-300">{p}</p>)}
          </section>
        ))}
      </main>
    </div>
  );
}
