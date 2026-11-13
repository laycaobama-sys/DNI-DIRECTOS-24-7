import { type ReactNode, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity, ArrowRight, Check, ChevronDown, Church, CloudUpload, Dumbbell, Gamepad2, GraduationCap, Headphones, KeyRound, ListVideo, Lock,
  Menu, Mic, Music2, Radio, RefreshCw, Send, ShieldCheck, Sparkles, Store, Wand2, X, Zap,
} from 'lucide-react';
import { GoogleIcon, Logo, YoutubeIcon as Youtube } from '../brand';
import { useAuthConfig } from '../hooks';
import { buttonCls, cx, useReveal } from '../ui';

export const FAQ: { q: string; a: string }[] = [
  { q: '¿Cómo hago un directo 24/7 en YouTube sin tener el ordenador encendido?', a: 'Sube tus vídeos a DNI Directos, ordénalos en una playlist, conecta tu canal de YouTube con Google y pulsa «Iniciar emisión». El directo se emite desde nuestros servidores en la nube, así que puedes apagar el ordenador o cerrar el navegador y la emisión sigue.' },
  { q: '¿Es gratis?', a: 'Sí. Ahora mismo todo el servicio es gratuito: sin tarjeta, sin límite de horas de emisión y con todas las funciones disponibles.' },
  { q: '¿Puedo emitir vídeos pregrabados en bucle?', a: 'Sí. El modo bucle repite tu playlist sin fin (A → B → C → A…). También hay modo aleatorio, que no repite ningún vídeo hasta haber emitido todos, y modo de una sola pasada.' },
  { q: '¿A qué plataformas puedo emitir a la vez?', a: 'A YouTube, Twitch, Kick, Facebook Live, Rumble, LinkedIn Live y cualquier plataforma que acepte RTMP o RTMPS. Puedes enviar la misma señal hasta a 10 destinos simultáneos; si uno falla, los demás siguen en directo.' },
  { q: '¿Tengo que copiar la clave de emisión de YouTube?', a: 'No hace falta. Conecta tu canal con tu cuenta de Google y la plataforma crea la emisión en YouTube por ti mediante la API oficial. Si lo prefieres, también puedes pegar la URL y la clave manualmente.' },
  { q: '¿Qué pasa si se corta la emisión?', a: 'El motor vigila cada destino y reconecta automáticamente con reintentos progresivos. Si un servidor de emisión cae, otro retoma tu canal cerca del punto donde estaba y todo queda registrado en el historial de eventos.' },
  { q: '¿Puedo cambiar la playlist mientras estoy en directo?', a: 'Sí. Publica la nueva versión y entrará justo al terminar el vídeo que está sonando, sin cortar la emisión ni reiniciar los destinos.' },
  { q: '¿Qué formatos de vídeo admite?', a: 'MP4, MOV, MKV, WebM y M4V de hasta 4 GB por archivo. Cada vídeo se convierte automáticamente a un formato de emisión estable (H.264 + AAC, 720p o 1080p a 30 fps, fotograma clave cada 2 s).' },
  { q: '¿Garantizáis monetización o visualizaciones?', a: 'No. Ninguna herramienta puede prometerlo. YouTube puede no archivar directos de más de 12 horas y considera problemático el contenido repetitivo. Emite solo contenido del que tengas los derechos y cumple las normas de cada plataforma.' },
  { q: '¿Mis claves de emisión están seguras?', a: 'Sí. Se guardan cifradas con AES-256, nunca se muestran completas y no aparecen en ningún registro. Los archivos se almacenan en almacenamiento privado, no accesible públicamente.' },
];

const PLATFORMS = ['YouTube', 'Twitch', 'Kick', 'Facebook Live', 'Rumble', 'LinkedIn Live', 'Vimeo', 'Trovo', 'DLive', 'Cualquier RTMP / RTMPS'];

const STEPS = [
  { icon: CloudUpload, title: 'Sube tus vídeos', text: 'Arrastra varios archivos a la vez. Suben en paralelo y se preparan solos para emitir.' },
  { icon: ListVideo, title: 'Crea la playlist', text: 'Ordénalos arrastrando y elige bucle infinito, aleatorio o una sola pasada.' },
  { icon: Youtube, title: 'Conecta tu canal', text: 'Entra con Google y crea el directo de YouTube con un clic. O pega cualquier RTMP.' },
  { icon: Radio, title: 'En directo 24/7', text: 'Pulsa iniciar y apaga el ordenador. Tu canal sigue emitiendo desde la nube.' },
];

const USE_CASES = [
  { id: 'musica', icon: Music2, label: 'Música y radio', title: 'Tu radio 24/7 con imagen', text: 'Sesiones, playlists y mezclas emitiendo sin parar. Ideal para canales lofi, DJ sets y radios con derechos de emisión.', points: ['Bucle infinito o aleatorio sin repeticiones', 'Cambios de playlist sin cortar la música', 'Multidestino: YouTube + Twitch + Kick'] },
  { id: 'iglesias', icon: Church, label: 'Iglesias', title: 'Tus servicios, siempre disponibles', text: 'Retransmite cultos, predicaciones y alabanzas grabadas a cualquier hora, para que tu comunidad nunca pierda la conexión.', points: ['Programación por fecha y hora', 'Repetición automática de servicios', 'Emisión en varias plataformas a la vez'] },
  { id: 'educacion', icon: GraduationCap, label: 'Educación', title: 'Un canal educativo que no duerme', text: 'Clases, cursos y conferencias en emisión continua para estudiantes de todas las zonas horarias.', points: ['Playlists por temario', 'Calidad 1080p estable', 'Historial completo de emisión'] },
  { id: 'gaming', icon: Gamepad2, label: 'Gaming', title: 'Tus mejores partidas, en bucle', text: 'Mantén tu canal activo con highlights y repeticiones mientras no estás en directo.', points: ['Twitch, Kick y YouTube a la vez', 'Reconexión automática', 'Sin consumir tu conexión'] },
  { id: 'negocios', icon: Store, label: 'Negocios', title: 'Escaparate en directo permanente', text: 'Presentaciones de producto, tutoriales y contenido de marca emitiendo día y noche.', points: ['Varios canales simultáneos', 'Equipo con roles y permisos', 'Registro de actividad'] },
  { id: 'podcast', icon: Mic, label: 'Podcast', title: 'Tu podcast, también en vídeo', text: 'Convierte tus episodios grabados en un directo continuo que atrae nuevas audiencias.', points: ['Episodios en orden o aleatorio', 'Subida múltiple rápida', 'Ficha técnica de cada archivo'] },
  { id: 'fitness', icon: Dumbbell, label: 'Fitness', title: 'Entrenamientos a cualquier hora', text: 'Rutinas y clases grabadas en emisión continua para tu comunidad.', points: ['Programación semanal', 'Calidad estable 720p/1080p', 'Monitor del directo en el móvil'] },
];

/** Simulador visual del panel (marcado como demostración: no son datos reales). */
function DemoMonitor() {
  const [t, setT] = useState(3 * 86400 + 4 * 3600 + 12 * 60 + 41);
  const [kbps, setKbps] = useState([3012, 2998, 3007]);
  useEffect(() => {
    const id = setInterval(() => { setT((x) => x + 1); setKbps((k) => k.map((v) => Math.round(3000 + (Math.random() - 0.5) * 40 + (v - 3000) * 0.3))); }, 1000);
    return () => clearInterval(id);
  }, []);
  const d = Math.floor(t / 86400), hms = [Math.floor((t % 86400) / 3600), Math.floor((t % 3600) / 60), t % 60].map((x) => String(x).padStart(2, '0')).join(':');
  const dests: [string, number][] = [['YouTube', kbps[0] ?? 3000], ['Twitch', kbps[1] ?? 3000], ['Kick', kbps[2] ?? 3000]];
  return (
    <div className="float-y relative">
      <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-tr from-air-500/30 via-violet-500/20 to-amber-glow/20 blur-2xl" aria-hidden />
      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-ink-900/85 shadow-2xl backdrop-blur-xl">
        <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-3">
          <div className="flex items-center gap-2"><span className="size-2.5 rounded-full bg-white/15" /><span className="size-2.5 rounded-full bg-white/15" /><span className="size-2.5 rounded-full bg-white/15" /></div>
          <span className="rounded-md bg-white/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">Demostración</span>
        </div>
        <div className="space-y-4 p-5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 rounded-full bg-red-500/15 px-3 py-1 text-xs font-bold uppercase tracking-wider text-red-300">
              <span className="relative flex size-2"><span className="on-air-ring absolute inset-0 rounded-full bg-red-500" /><span className="relative size-2 rounded-full bg-red-500" /></span>En directo
            </span>
            <span className="font-mono text-sm tabular-nums text-ink-300">{d} d {hms}</span>
          </div>
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-ink-800 to-ink-950 p-4 ring-1 ring-white/[0.06]">
            <div className="absolute inset-0 opacity-40" style={{ background: 'radial-gradient(circle at 80% 20%, rgba(255,79,46,.35), transparent 50%)' }} aria-hidden />
            <p className="relative text-[11px] font-semibold uppercase tracking-wider text-ink-400">Ahora suena</p>
            <p className="relative mt-1 font-semibold">Sesión lofi nocturna · parte 3.mp4</p>
            <div className="relative mt-4 flex h-10 items-end gap-[3px]" aria-hidden>
              {Array.from({ length: 36 }, (_, i) => <span key={i} className="eq-bar w-full rounded-sm bg-gradient-to-t from-air-500 to-amber-glow" style={{ height: `${30 + ((i * 37) % 70)}%`, animationDelay: `${(i * 83) % 900}ms` }} />)}
            </div>
          </div>
          {dests.map(([n, b]) => (
            <div key={n} className="flex items-center justify-between rounded-xl bg-white/[0.04] px-4 py-3 text-sm ring-1 ring-white/[0.05]">
              <span className="font-medium">{n}</span>
              <span className="flex items-center gap-3"><span className="font-mono text-xs tabular-nums text-ink-400">{b.toLocaleString('es-ES')} kb/s</span><span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400"><span className="live-dot size-1.5 rounded-full bg-emerald-400" />En directo</span></span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Diagrama animado: una señal → varios destinos aislados. */
function FanOut() {
  const targets = ['YouTube', 'Twitch', 'Kick'];
  return (
    <svg viewBox="0 0 320 150" className="h-full w-full" aria-hidden>
      <defs><linearGradient id="fo" x1="0" x2="1"><stop offset="0" stopColor="#ff4f2e" /><stop offset="1" stopColor="#ffb020" /></linearGradient></defs>
      <rect x="10" y="55" width="86" height="40" rx="10" fill="#ff4f2e" fillOpacity=".12" stroke="url(#fo)" />
      <text x="53" y="80" textAnchor="middle" fill="#fff" fontSize="12" fontWeight="600">Tu señal</text>
      {targets.map((t, i) => {
        const y = 22 + i * 50;
        return (<g key={t}>
          <path d={`M96 75 C160 75 170 ${y + 13} 222 ${y + 13}`} fill="none" stroke="url(#fo)" strokeWidth="2" className="flow-line" />
          <rect x="222" y={y} width="88" height="26" rx="8" fill="#ffffff" fillOpacity=".05" stroke="#ffffff" strokeOpacity=".12" />
          <text x="266" y={y + 17} textAnchor="middle" fill="#cfd3dc" fontSize="11">{t}</text>
        </g>);
      })}
    </svg>
  );
}

function Bento({ className, icon: Icon, title, text, children }: { className?: string; icon: (p: { className?: string }) => ReactNode; title: string; text: string; children?: ReactNode }) {
  return (
    <div className={cx('reveal group relative overflow-hidden rounded-3xl border border-white/[0.07] bg-gradient-to-b from-white/[0.05] to-white/[0.015] p-6 transition-colors hover:border-white/15', className)}>
      <div className="mb-4 flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-air-500/20 to-violet-500/20 text-air-300 ring-1 ring-white/10"><Icon className="size-5" /></div>
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      <p className="mt-2 text-sm leading-relaxed text-ink-400">{text}</p>
      {children}
    </div>
  );
}

export function Landing() {
  useReveal();
  const cfg = useAuthConfig();
  const [menu, setMenu] = useState(false);
  const [useCase, setUseCase] = useState(USE_CASES[0]!.id);
  const [faqOpen, setFaqOpen] = useState<number | null>(0);
  const uc = USE_CASES.find((u) => u.id === useCase)!;

  return (
    <div className="dark min-h-dvh overflow-x-clip bg-ink-950 text-ink-100">
      <header className="glass sticky top-0 z-40 border-b border-white/[0.06]">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link to="/" aria-label="DNI Directos 24/7, inicio"><Logo /></Link>
          <nav aria-label="Principal" className="hidden items-center gap-8 text-sm text-ink-300 md:flex">
            <a href="#como-funciona" className="transition-colors hover:text-white">Cómo funciona</a>
            <a href="#funciones" className="transition-colors hover:text-white">Funciones</a>
            <a href="#casos" className="transition-colors hover:text-white">Casos de uso</a>
            <a href="#faq" className="transition-colors hover:text-white">Preguntas</a>
          </nav>
          <div className="flex items-center gap-2">
            <Link to="/login" className={buttonCls('ghost', 'max-sm:hidden')}>Iniciar sesión</Link>
            <Link to="/register" className={buttonCls('primary', 'max-sm:h-9 max-sm:px-3 max-sm:text-[13px]')}>Empezar gratis</Link>
            <button className="rounded-xl p-2 md:hidden" aria-label="Menú" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>{menu ? <X className="size-5" /> : <Menu className="size-5" />}</button>
          </div>
        </div>
        {menu && (
          <nav className="page-in border-t border-white/[0.06] px-4 pb-4 md:hidden" aria-label="Menú móvil">
            {[['#como-funciona', 'Cómo funciona'], ['#funciones', 'Funciones'], ['#casos', 'Casos de uso'], ['#faq', 'Preguntas']].map(([h, l]) => (
              <a key={h} href={h} onClick={() => setMenu(false)} className="block border-b border-white/[0.05] py-3.5 text-ink-200">{l}</a>
            ))}
            <Link to="/login" className="block py-3.5 text-ink-200">Iniciar sesión</Link>
          </nav>
        )}
      </header>

      <main>
        {/* ───── Hero ───── */}
        <section className="relative isolate overflow-hidden">
          <div className="aurora -z-10" aria-hidden><span /><span /><span /></div>
          <div className="bg-grid absolute inset-0 -z-10" aria-hidden />
          <div className="mx-auto grid max-w-7xl items-center gap-14 px-4 pb-20 pt-14 sm:px-6 sm:pt-20 lg:grid-cols-[1.1fr_1fr] lg:pb-28 lg:pt-24">
            <div>
              <p className="hero-in inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.05] px-3.5 py-1.5 text-xs font-semibold text-ink-200 backdrop-blur">
                <Sparkles className="size-3.5 text-amber-glow" />Gratis · Sin tarjeta · Sin límite de horas
              </p>
              <h1 className="hero-in mt-6 text-[2.6rem] font-extrabold leading-[1.04] tracking-tight sm:text-6xl lg:text-7xl" style={{ ['--d' as string]: '80ms' }}>
                Directos 24/7 en YouTube<br className="hidden sm:block" /> <span className="text-signal">sin encender el ordenador.</span>
              </h1>
              <p className="hero-in mt-6 max-w-xl text-lg leading-relaxed text-ink-300 sm:text-xl" style={{ ['--d' as string]: '160ms' }}>
                Sube tus vídeos pregrabados, crea una playlist en bucle y emite en continuo a YouTube, Twitch, Kick y cualquier RTMP. Desde la nube, con recuperación automática.
              </p>
              <div className="hero-in mt-9 flex flex-col gap-3 sm:flex-row" style={{ ['--d' as string]: '240ms' }}>
                <Link to="/register" className={buttonCls('primary', 'h-13 px-7 text-base')}>Crear mi canal 24/7 <ArrowRight className="size-4" /></Link>
                {cfg.data?.google
                  ? <a href="/v1/auth/google/start" className="inline-flex h-13 items-center justify-center gap-3 rounded-xl bg-white px-6 text-base font-semibold text-ink-900 transition hover:bg-ink-100 active:scale-[0.98]"><GoogleIcon />Continuar con Google</a>
                  : <a href="#como-funciona" className={buttonCls('secondary', 'h-13 px-7 text-base')}>Ver cómo funciona</a>}
              </div>
              <ul className="hero-in mt-9 grid max-w-lg grid-cols-2 gap-x-6 gap-y-2.5 text-sm text-ink-300" style={{ ['--d' as string]: '320ms' }}>
                {['Emite con el PC apagado', 'Hasta 10 destinos a la vez', 'Reconexión automática', 'Conexión directa con YouTube'].map((p) => (
                  <li key={p} className="flex items-center gap-2"><Check className="size-4 shrink-0 text-emerald-400" />{p}</li>
                ))}
              </ul>
            </div>
            <div className="hero-in" style={{ ['--d' as string]: '200ms' }}><DemoMonitor /></div>
          </div>
        </section>

        {/* ───── Plataformas ───── */}
        <section aria-label="Plataformas compatibles" className="border-y border-white/[0.06] bg-white/[0.015] py-7">
          <p className="mb-5 text-center text-xs font-semibold uppercase tracking-[0.2em] text-ink-500">Emite a cualquier plataforma compatible con RTMP o RTMPS</p>
          <div className="relative overflow-hidden [mask-image:linear-gradient(90deg,transparent,black_12%,black_88%,transparent)]">
            <div className="animate-marquee flex w-max gap-4">
              {[...PLATFORMS, ...PLATFORMS].map((p, i) => (
                <span key={i} className="whitespace-nowrap rounded-full border border-white/[0.08] bg-white/[0.03] px-5 py-2 text-sm font-semibold text-ink-300">{p}</span>
              ))}
            </div>
          </div>
        </section>

        {/* ───── Cifras del producto (hechos, no métricas inventadas) ───── */}
        <section className="mx-auto grid max-w-7xl grid-cols-2 gap-px overflow-hidden px-4 py-16 sm:px-6 lg:grid-cols-4">
          {[['24/7', 'Emisión continua desde la nube'], ['10', 'Destinos simultáneos por emisión'], ['1080p', 'A 30 fps, fotograma clave cada 2 s'], ['0 €', 'Gratis y sin límite de horas']].map(([n, l], i) => (
            <div key={l} className="reveal px-4 py-6 text-center" style={{ ['--d' as string]: `${i * 90}ms` }}>
              <p className="text-signal text-4xl font-extrabold tracking-tight sm:text-5xl">{n}</p>
              <p className="mt-2 text-sm text-ink-400">{l}</p>
            </div>
          ))}
        </section>

        {/* ───── Cómo funciona ───── */}
        <section id="como-funciona" className="scroll-mt-20 mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="reveal mx-auto max-w-2xl text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-air-400">Cómo funciona</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">De tus archivos al directo en 4 pasos</h2>
            <p className="mt-4 text-lg text-ink-400">Sin programas que instalar, sin OBS y sin dejar nada encendido.</p>
          </div>
          <ol className="relative mt-14 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <div className="absolute left-0 right-0 top-[2.15rem] hidden h-px bg-gradient-to-r from-transparent via-air-500/40 to-transparent lg:block" aria-hidden />
            {STEPS.map((s, i) => (
              <li key={s.title} className="reveal relative rounded-3xl border border-white/[0.07] bg-ink-900/60 p-6 backdrop-blur" style={{ ['--d' as string]: `${i * 110}ms` }}>
                <div className="bg-signal relative flex size-11 items-center justify-center rounded-2xl text-white shadow-lg shadow-air-500/30"><s.icon className="size-5" /></div>
                <p className="mt-5 text-xs font-bold text-ink-500">PASO {i + 1}</p>
                <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-400">{s.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ───── Funciones (bento) ───── */}
        <section id="funciones" className="scroll-mt-20 mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="reveal max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-air-400">Funciones</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Pensado para no caerse. <span className="text-ink-500">Y para decírtelo si pasa.</span></h2>
          </div>
          <div className="mt-12 grid gap-5 md:grid-cols-6">
            <Bento className="md:col-span-4" icon={Send} title="Multidestino con conexiones aisladas" text="La misma señal a YouTube, Twitch, Kick y más. Cada destino tiene su propia conexión: si uno se cae, el resto sigue en directo sin enterarse.">
              <div className="mt-4 h-40"><FanOut /></div>
            </Bento>
            <Bento className="md:col-span-2" icon={Youtube} title="Conexión directa con YouTube" text="Entra con tu cuenta de Google y creamos el directo en tu canal con la API oficial. Sin copiar claves." />
            <Bento className="md:col-span-2" icon={RefreshCw} title="Recuperación automática" text="Reconexión con reintentos progresivos y relevo entre servidores que reanuda tu playlist donde estaba." />
            <Bento className="md:col-span-2" icon={Wand2} title="Cambios sin cortes" text="Edita la playlist en directo: la nueva versión entra al acabar el vídeo actual, sin reiniciar la emisión." />
            <Bento className="md:col-span-2" icon={Zap} title="Subida rápida y en paralelo" text="Selecciona todos tus vídeos a la vez: suben en paralelo, se reanudan si falla la red y se convierten en segundos." />
            <Bento className="md:col-span-3" icon={Activity} title="Estado real, no decorativo" text="Bitrate, reconexiones y eventos medidos por el motor. Un destino solo aparece «en directo» si la señal avanza de verdad. Nunca cifras de audiencia inventadas." />
            <Bento className="md:col-span-3" icon={ShieldCheck} title="Seguridad de nivel empresa" text="Claves cifradas con AES-256, archivos privados, sesiones seguras, protección CSRF y aislamiento total entre cuentas." />
          </div>
        </section>

        {/* ───── Casos de uso ───── */}
        <section id="casos" className="scroll-mt-20 border-y border-white/[0.06] bg-white/[0.015] py-16 lg:py-24">
          <div className="mx-auto max-w-7xl px-4 sm:px-6">
            <div className="reveal mx-auto max-w-2xl text-center">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-air-400">Casos de uso</p>
              <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Un canal siempre vivo, para cualquier contenido</h2>
            </div>
            <div className="reveal mt-10 flex gap-2 overflow-x-auto pb-2 sm:flex-wrap sm:justify-center" role="tablist" aria-label="Casos de uso">
              {USE_CASES.map((u) => (
                <button key={u.id} role="tab" aria-selected={u.id === useCase} onClick={() => setUseCase(u.id)}
                  className={cx('flex shrink-0 items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-all', u.id === useCase ? 'bg-white text-ink-950' : 'bg-white/[0.04] text-ink-300 ring-1 ring-white/10 hover:bg-white/[0.08]')}>
                  <u.icon className="size-4" />{u.label}
                </button>
              ))}
            </div>
            <div key={uc.id} role="tabpanel" className="page-in mx-auto mt-8 grid max-w-4xl gap-8 rounded-3xl border border-white/[0.07] bg-ink-900/60 p-6 sm:p-10 md:grid-cols-2">
              <div>
                <uc.icon className="size-8 text-air-400" />
                <h3 className="mt-4 text-2xl font-bold tracking-tight">{uc.title}</h3>
                <p className="mt-3 leading-relaxed text-ink-400">{uc.text}</p>
              </div>
              <ul className="space-y-3 self-center">
                {uc.points.map((p) => <li key={p} className="flex items-center gap-3 rounded-2xl bg-white/[0.04] px-4 py-3.5 text-sm ring-1 ring-white/[0.06]"><Check className="size-4 shrink-0 text-emerald-400" />{p}</li>)}
              </ul>
            </div>
          </div>
        </section>

        {/* ───── Diferencias ───── */}
        <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="reveal text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-air-400">Por qué aquí</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Lo que marca la diferencia</h2>
          </div>
          <div className="reveal mt-12 overflow-hidden rounded-3xl border border-white/[0.08]">
            {[
              [KeyRound, 'Conectas YouTube con Google', 'y el directo se crea solo, sin copiar claves.'],
              [Headphones, 'Ves el estado real de cada destino', 'con bitrate y reconexiones, no una luz verde decorativa.'],
              [Wand2, 'Editas la playlist en directo', 'y el cambio entra en un corte limpio, sin reiniciar.'],
              [RefreshCw, 'Si un servidor cae, otro retoma', 'tu canal y reanuda cerca de donde estaba.'],
              [Lock, 'Tus claves nunca se muestran', 'ni aparecen en registros: cifradas de extremo a extremo en reposo.'],
              [Sparkles, 'Todo gratis, sin límite de horas', 'ni funciones bloqueadas detrás de un plan.'],
            ].map(([Icon, a, b], i) => {
              const I = Icon as typeof Zap;
              return (
                <div key={i} className="flex items-start gap-4 border-b border-white/[0.06] bg-white/[0.015] px-5 py-5 last:border-b-0 sm:px-8">
                  <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl bg-white/[0.06] text-air-300"><I className="size-[18px]" /></span>
                  <p className="text-[15px] leading-relaxed text-ink-300"><strong className="font-semibold text-white">{a as string}</strong> {b as string}</p>
                </div>
              );
            })}
          </div>
        </section>

        {/* ───── FAQ ───── */}
        <section id="faq" className="scroll-mt-20 mx-auto max-w-3xl px-4 py-16 sm:px-6 lg:py-24">
          <div className="reveal text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-air-400">Preguntas frecuentes</p>
            <h2 className="mt-3 text-3xl font-bold tracking-tight sm:text-5xl">Todo lo que necesitas saber</h2>
          </div>
          <div className="mt-12 space-y-3">
            {FAQ.map((f, i) => (
              <div key={f.q} className="reveal overflow-hidden rounded-2xl border border-white/[0.07] bg-white/[0.02]">
                <h3>
                  <button className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left font-semibold sm:px-6" aria-expanded={faqOpen === i} onClick={() => setFaqOpen(faqOpen === i ? null : i)}>
                    {f.q}<ChevronDown className={cx('size-5 shrink-0 text-ink-400 transition-transform duration-300', faqOpen === i && 'rotate-180')} />
                  </button>
                </h3>
                <div className={cx('grid transition-[grid-template-rows] duration-300 ease-out', faqOpen === i ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                  <p className="overflow-hidden px-5 text-[15px] leading-relaxed text-ink-400 sm:px-6"><span className="block pb-5">{f.a}</span></p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ───── CTA final ───── */}
        <section className="px-4 pb-20 sm:px-6">
          <div className="reveal relative mx-auto max-w-5xl overflow-hidden rounded-[2rem] border border-white/10 bg-ink-900 px-6 py-16 text-center sm:px-12">
            <div className="aurora opacity-70" aria-hidden><span /><span /><span /></div>
            <div className="relative">
              <h2 className="text-3xl font-bold tracking-tight sm:text-5xl">Enciende tu canal 24/7 hoy</h2>
              <p className="mx-auto mt-4 max-w-xl text-lg text-ink-300">Crea tu cuenta gratis y deja tu primer directo en marcha en menos de cinco minutos.</p>
              <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
                <Link to="/register" className={buttonCls('primary', 'h-13 px-8 text-base')}>Empezar gratis <ArrowRight className="size-4" /></Link>
                {cfg.data?.google && <a href="/v1/auth/google/start" className="inline-flex h-13 items-center justify-center gap-3 rounded-xl bg-white px-6 text-base font-semibold text-ink-900 transition hover:bg-ink-100"><GoogleIcon />Continuar con Google</a>}
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/[0.06] py-12 text-sm text-ink-500">
        <div className="mx-auto grid max-w-7xl gap-8 px-4 sm:px-6 md:grid-cols-[1.5fr_1fr_1fr]">
          <div>
            <Logo />
            <p className="mt-4 max-w-sm leading-relaxed">Plataforma de emisión en directo 24/7 desde la nube para YouTube, Twitch, Kick y cualquier destino RTMP. Emite solo contenido del que tengas los derechos.</p>
          </div>
          <div>
            <p className="font-semibold text-ink-200">Producto</p>
            <ul className="mt-3 space-y-2"><li><a href="#funciones" className="hover:text-white">Funciones</a></li><li><a href="#casos" className="hover:text-white">Casos de uso</a></li><li><a href="#faq" className="hover:text-white">Preguntas frecuentes</a></li><li><Link to="/register" className="hover:text-white">Crear cuenta</Link></li></ul>
          </div>
          <div>
            <p className="font-semibold text-ink-200">Legal</p>
            <ul className="mt-3 space-y-2"><li><Link to="/legal/privacidad" className="hover:text-white">Privacidad</Link></li><li><Link to="/legal/terminos" className="hover:text-white">Términos de uso</Link></li><li><Link to="/legal/cookies" className="hover:text-white">Cookies</Link></li></ul>
          </div>
        </div>
        <p className="mx-auto mt-10 max-w-7xl px-4 sm:px-6">© {new Date().getFullYear()} DNI Directos 24/7. Sin promesas de monetización ni de alcance.</p>
      </footer>
    </div>
  );
}
