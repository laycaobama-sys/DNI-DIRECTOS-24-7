/** Entrada de prerenderizado: genera el HTML estático de la portada para buscadores y asistentes de IA. */
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FAQ, Landing } from './pages/Landing';

export function render(): string {
  const qc = new QueryClient();
  return renderToString(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/']}><Landing /></MemoryRouter>
    </QueryClientProvider>,
  );
}

export function jsonLd(site: string): string {
  const graph = [
    {
      '@type': 'Organization', '@id': `${site}/#org`, name: 'DNI Directos 24/7', url: `${site}/`,
      logo: { '@type': 'ImageObject', url: `${site}/icon-512.png`, width: 512, height: 512 },
    },
    { '@type': 'WebSite', '@id': `${site}/#web`, url: `${site}/`, name: 'DNI Directos 24/7', inLanguage: 'es', publisher: { '@id': `${site}/#org` } },
    {
      '@type': 'SoftwareApplication', '@id': `${site}/#app`, name: 'DNI Directos 24/7', applicationCategory: 'MultimediaApplication',
      applicationSubCategory: 'Live streaming', operatingSystem: 'Web', url: `${site}/`, image: `${site}/og-image.png`, inLanguage: 'es',
      description: 'Plataforma en la nube para emitir vídeos pregrabados en directo 24/7 a YouTube, Twitch, Kick y cualquier RTMP, con playlist en bucle, multidestino y recuperación automática.',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'EUR', availability: 'https://schema.org/InStock' },
      featureList: ['Emisión 24/7 desde la nube sin ordenador encendido', 'Playlist en bucle, aleatoria o de una pasada', 'Hasta 10 destinos simultáneos (multistream)', 'Conexión directa con YouTube mediante Google', 'Recuperación automática y reconexión', 'Edición de la playlist en directo sin cortes', 'Programación con zona horaria', 'Subida múltiple en paralelo'],
      publisher: { '@id': `${site}/#org` },
    },
    {
      '@type': 'HowTo', name: 'Cómo hacer un directo 24/7 en YouTube con vídeos pregrabados', inLanguage: 'es', totalTime: 'PT5M',
      step: [
        { '@type': 'HowToStep', position: 1, name: 'Sube tus vídeos', text: 'Crea una cuenta gratuita y sube tus vídeos; se convierten automáticamente a un formato de emisión estable.' },
        { '@type': 'HowToStep', position: 2, name: 'Crea la playlist', text: 'Ordena los vídeos y elige modo bucle infinito, aleatorio o una sola pasada.' },
        { '@type': 'HowToStep', position: 3, name: 'Conecta tu canal', text: 'Conecta tu canal de YouTube con Google o añade cualquier destino RTMP/RTMPS.' },
        { '@type': 'HowToStep', position: 4, name: 'Inicia la emisión', text: 'Pulsa «Iniciar emisión» y apaga el ordenador: el directo continúa desde la nube.' },
      ],
    },
    {
      '@type': 'FAQPage', inLanguage: 'es',
      mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ];
  // Escapa «<» para que el JSON nunca pueda cerrar la etiqueta <script>.
  return JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
}
