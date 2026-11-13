import { Link } from 'react-router-dom';
import { Activity, CloudUpload, ListVideo, Radio, RefreshCw, Send, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { ENCODING_PROFILES, PLANS } from '@dni/shared';
import { Logo, ThemeToggle } from '../App';
import { Badge, Button, Card } from '../ui';
import { fmtBytes } from '../api';

const steps = [
  { icon: <CloudUpload />, title: 'Sube', text: 'Carga tus vídeos. Los analizamos y convertimos a un formato de emisión estable.' },
  { icon: <ListVideo />, title: 'Ordena', text: 'Arrastra para crear tu playlist: en bucle, aleatoria o de una sola pasada.' },
  { icon: <SlidersHorizontal />, title: 'Configura', text: 'Elige calidad y conecta uno o varios destinos RTMP(S).' },
  { icon: <Radio />, title: 'Emite', text: 'Pulsa iniciar y cierra el portátil: la señal sale de nuestra nube.' },
];
const features = [
  { icon: <Radio />, title: 'Emisión continua real', text: 'Un motor FFmpeg dedicado mantiene tu canal en el aire. No es una pestaña del navegador.' },
  { icon: <Send />, title: 'Varios destinos, aislados', text: 'Cada destino tiene su propia conexión: si uno falla, los demás siguen en directo.' },
  { icon: <RefreshCw />, title: 'Recuperación automática', text: 'Si un nodo cae, otro retoma la emisión cerca del punto donde estaba y queda registrado.' },
  { icon: <ListVideo />, title: 'Cambios sin cortes', text: 'Edita la playlist en directo: la nueva versión entra al terminar el vídeo actual.' },
  { icon: <Activity />, title: 'Estado verificado', text: 'Bitrate, reconexiones y eventos medidos por el motor. Nunca cifras de audiencia inventadas.' },
  { icon: <ShieldCheck />, title: 'Claves protegidas', text: 'Las claves de emisión se cifran y jamás se muestran completas ni aparecen en registros.' },
];
const faqs = [
  { q: '¿Necesito tener el ordenador encendido?', a: 'No. Una vez iniciada, la emisión se ejecuta en nuestra infraestructura. Puedes cerrar el navegador y volver cuando quieras para ver el estado real.' },
  { q: '¿A qué plataformas puedo emitir?', a: 'A cualquier destino que acepte RTMP o RTMPS con URL y clave de emisión, como YouTube o Twitch. La conexión con un clic mediante la API oficial de YouTube está en desarrollo.' },
  { q: '¿Garantizáis monetización u horas de visualización?', a: 'No. Ninguna herramienta puede prometerlo. YouTube puede no archivar directos de más de 12 horas y considera problemático el contenido repetitivo. Eres responsable de cumplir las normas de cada plataforma.' },
  { q: '¿Qué contenido puedo emitir?', a: 'Solo contenido del que tengas los derechos de emisión. Las cuentas que emitan contenido sin derechos o ilícito se suspenden.' },
];

export function Landing() {
  return (
    <div>
      <header className="sticky top-0 z-20 border-b border-ink-200/70 bg-ink-50/90 backdrop-blur dark:border-ink-800 dark:bg-ink-950/90">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/"><Logo /></Link>
          <nav aria-label="Principal" className="hidden items-center gap-6 text-sm text-ink-600 md:flex dark:text-ink-300">
            <a href="#como-funciona" className="hover:text-ink-900 dark:hover:text-white">Cómo funciona</a>
            <a href="#funcionalidades" className="hover:text-ink-900 dark:hover:text-white">Funcionalidades</a>
            <a href="#precios" className="hover:text-ink-900 dark:hover:text-white">Planes</a>
            <a href="#faq" className="hover:text-ink-900 dark:hover:text-white">Preguntas</a>
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <ThemeToggle />
            <Link to="/login" className="hidden sm:block"><Button variant="ghost">Iniciar sesión</Button></Link>
            <Link to="/register"><Button variant="primary">Empezar gratis</Button></Link>
          </div>
        </div>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 sm:px-6 lg:grid-cols-2 lg:py-24">
          <div>
            <Badge tone="live" dot>Emisión 24/7 desde la nube</Badge>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.1] tracking-tight sm:text-5xl">Tu canal, siempre en directo.<br /><span className="text-air-500">Aunque apagues el ordenador.</span></h1>
            <p className="mt-5 max-w-xl text-lg text-ink-600 dark:text-ink-300">Sube tus vídeos, ordénalos en una playlist y emítelos en continuo a YouTube, Twitch o cualquier destino RTMP. Nosotros mantenemos la señal y te contamos, sin maquillaje, cómo va.</p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link to="/register"><Button variant="primary" className="h-12 px-6 text-base">Crear mi primera emisión</Button></Link>
              <a href="#como-funciona"><Button className="h-12 px-6 text-base">Ver cómo funciona</Button></a>
            </div>
            <p className="mt-4 text-sm text-ink-500">Gratis, sin tarjeta y sin límite de horas.</p>
          </div>
          <Card className="relative overflow-hidden p-0" >
            <div className="flex items-center justify-between border-b border-ink-200 px-5 py-3 dark:border-ink-800">
              <span className="text-sm font-medium">Canal principal</span>
              <span className="rounded bg-ink-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-ink-500 dark:bg-ink-800">Datos de demostración</span>
            </div>
            <div className="space-y-4 p-5">
              <div className="flex items-center justify-between"><Badge tone="live" dot>En directo</Badge><span className="font-mono text-sm text-ink-500">3 d 04:12:55</span></div>
              <div className="rounded-xl bg-ink-950 p-4 text-ink-100">
                <p className="text-xs uppercase tracking-wide text-ink-400">Ahora suena</p>
                <p className="mt-1 font-medium">Sesión de estudio · parte 2.mp4</p>
                <div className="mt-3 h-1 rounded-full bg-ink-700"><div className="h-full w-2/5 rounded-full bg-air-500" /></div>
              </div>
              {[['YouTube', 'En directo', '3.012 kb/s'], ['Twitch', 'Reintentando', '—']].map(([n, s, b]) => (
                <div key={n} className="flex items-center justify-between rounded-xl bg-ink-50 px-4 py-3 text-sm dark:bg-ink-800/60">
                  <span className="font-medium">{n}</span>
                  <span className="flex items-center gap-3"><span className="font-mono text-xs text-ink-500">{b}</span><Badge tone={s === 'En directo' ? 'live' : 'warn'} dot>{s}</Badge></span>
                </div>
              ))}
              <p className="text-xs text-ink-500">Un destino falla y el otro sigue emitiendo: así se comporta el motor.</p>
            </div>
          </Card>
        </section>

        <section id="como-funciona" className="border-y border-ink-200/70 bg-white py-16 dark:border-ink-800 dark:bg-ink-900">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">De tus archivos al directo en cuatro pasos</h2>
            <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((s, i) => (
                <li key={s.title}>
                  <div className="mb-3 flex size-11 items-center justify-center rounded-xl bg-air-500/10 text-air-600 dark:text-air-400">{s.icon}</div>
                  <h3 className="font-semibold"><span className="mr-2 text-ink-400">{i + 1}.</span>{s.title}</h3>
                  <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section id="funcionalidades" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Pensado para no caerse, y para decírtelo si pasa</h2>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f) => (
              <Card key={f.title}>
                <div className="mb-3 text-air-600 dark:text-air-400">{f.icon}</div>
                <h3 className="font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm text-ink-600 dark:text-ink-300">{f.text}</p>
              </Card>
            ))}
          </div>
        </section>

        <section id="precios" className="border-y border-ink-200/70 bg-white py-16 dark:border-ink-800 dark:bg-ink-900">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Gratis y sin límites</h2>
            <p className="mt-2 max-w-2xl text-sm text-ink-600 dark:text-ink-300">Ahora mismo todo el servicio es gratuito: sin planes, sin tarjeta y sin funciones bloqueadas.</p>
            <Card className="mt-8 max-w-xl bg-ink-50 dark:bg-ink-950">
              <h3 className="text-lg font-semibold">Todo incluido</h3>
              <ul className="mt-4 space-y-2 text-sm text-ink-700 dark:text-ink-300">
                <li>Emisión 24/7 sin límite de horas</li>
                <li>Varias emisiones a la vez</li>
                <li>Hasta {PLANS.free!.maxDestinationsPerStream} destinos por emisión</li>
                <li>Calidad {Object.values(ENCODING_PROFILES).map((x) => x.label).join(' y ')}</li>
                <li>Archivos de hasta {fmtBytes(PLANS.free!.maxUploadBytes)}</li>
              </ul>
              <Link to="/register" className="mt-6 inline-block"><Button variant="primary">Crear mi cuenta</Button></Link>
            </Card>
          </div>
        </section>

        <section id="faq" className="mx-auto max-w-3xl px-4 py-16 sm:px-6">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Preguntas frecuentes</h2>
          <div className="mt-8 divide-y divide-ink-200 dark:divide-ink-800">
            {faqs.map((f) => (
              <details key={f.q} className="group py-4">
                <summary className="cursor-pointer list-none font-medium marker:hidden">{f.q}</summary>
                <p className="mt-2 text-sm text-ink-600 dark:text-ink-300">{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="border-t border-ink-200/70 py-10 text-sm text-ink-500 dark:border-ink-800">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <Logo />
          <p>Emite solo contenido del que tengas derechos. Sin promesas de monetización ni de alcance.</p>
        </div>
      </footer>
    </div>
  );
}
