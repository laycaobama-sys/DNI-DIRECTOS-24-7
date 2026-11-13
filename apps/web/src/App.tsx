import { type ReactNode, Suspense, lazy, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Crown, FolderOpen, LayoutDashboard, ListVideo, LogOut, Menu, Radio, Send, Settings, X } from 'lucide-react';
import { ApiError, api, get, type Stream } from './api';
import { Logo, ThemeToggle } from './brand';
import { useAuthConfig, useMe } from './hooks';
import { Button, EmptyState, Skeleton, cx, errMsg } from './ui';
import { Landing } from './pages/Landing';

// La portada va en el bundle principal (carga instantánea); el resto de páginas se descarga al navegar.
const AuthPage = lazy(() => import('./pages/Auth'));
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Library = lazy(() => import('./pages/Library').then((m) => ({ default: m.Library })));
const Playlists = lazy(() => import('./pages/Playlists').then((m) => ({ default: m.Playlists })));
const PlaylistEditor = lazy(() => import('./pages/Playlists').then((m) => ({ default: m.PlaylistEditor })));
const Destinations = lazy(() => import('./pages/Destinations').then((m) => ({ default: m.Destinations })));
const Streams = lazy(() => import('./pages/Streams').then((m) => ({ default: m.Streams })));
const StreamNew = lazy(() => import('./pages/Streams').then((m) => ({ default: m.StreamNew })));
const StreamDetail = lazy(() => import('./pages/Streams').then((m) => ({ default: m.StreamDetail })));
const Schedule = lazy(() => import('./pages/Schedule'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const Admin = lazy(() => import('./pages/Admin'));
const Legal = lazy(() => import('./pages/Legal'));

const NAV = [
  { to: '/app/overview', label: 'Resumen', icon: LayoutDashboard },
  { to: '/app/streams', label: 'Emisiones', icon: Radio },
  { to: '/app/library', label: 'Biblioteca', icon: FolderOpen },
  { to: '/app/playlists', label: 'Playlists', icon: ListVideo },
  { to: '/app/destinations', label: 'Destinos', icon: Send },
  { to: '/app/schedule', label: 'Programación', icon: CalendarClock },
  { to: '/app/settings', label: 'Ajustes', icon: Settings },
];
const MOBILE_TABS = NAV.slice(0, 4);

const PageFallback = () => (
  <div className="space-y-4 p-1" aria-busy="true" aria-label="Cargando">
    <Skeleton className="h-9 w-56" /><div className="grid gap-4 sm:grid-cols-3"><Skeleton className="h-28" /><Skeleton className="h-28" /><Skeleton className="h-28" /></div><Skeleton className="h-64" />
  </div>
);

function LiveCounter() {
  const q = useQuery<{ items: Stream[] }>({ queryKey: ['streams'], queryFn: () => get('/v1/streams'), refetchInterval: 10_000 });
  const live = q.data?.items.filter((s) => s.status === 'live' || s.status === 'degraded').length ?? 0;
  if (!live) return null;
  return (
    <Link to="/app/streams" className="flex items-center gap-2 rounded-full bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-600 ring-1 ring-red-500/25 dark:text-red-300">
      <span className="relative flex size-2"><span className="on-air-ring absolute inset-0 rounded-full bg-red-500" /><span className="relative size-2 rounded-full bg-red-500" /></span>
      {live} en directo
    </Link>
  );
}

function AppLayout() {
  const me = useMe();
  const cfg = useAuthConfig();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (me.isLoading) return <div className="mx-auto max-w-6xl p-6"><PageFallback /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
    return <div className="mx-auto max-w-lg p-8"><EmptyState icon={<X />} title="No se pudo conectar" action={<Button onClick={() => me.refetch()}>Reintentar</Button>}>{errMsg(me.error)}</EmptyState></div>;
  }
  const m = me.data!;
  const org = m.organizations.find((o) => o.id === m.current.id);
  const logout = async () => { await api('POST', '/v1/auth/logout').catch(() => {}); qc.clear(); nav('/login'); };
  const links = m.user.superadmin ? [...NAV, { to: '/admin', label: 'Panel del propietario', icon: Crown }] : NAV;
  const sidebar = (
    <nav aria-label="Principal" className="flex h-full flex-col gap-1 p-3">
      <Link to="/app/overview" className="mb-5 px-2 pt-1"><Logo /></Link>
      {links.map((n) => (
        <NavLink key={n.to} to={n.to}
          className={({ isActive }) => cx('group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
            isActive ? 'bg-ink-900 text-white dark:bg-white/[0.08]' : 'text-ink-600 hover:bg-ink-100 hover:text-ink-900 dark:text-ink-400 dark:hover:bg-white/[0.04] dark:hover:text-ink-100')}>
          {({ isActive }) => (<>
            {isActive && <span className="bg-signal absolute inset-y-2 left-0 w-1 rounded-full" aria-hidden />}
            <n.icon className={cx('size-[18px]', n.to === '/admin' && 'text-amber-glow')} />{n.label}
          </>)}
        </NavLink>
      ))}
      <div className="mt-auto space-y-3 border-t border-ink-200 pt-4 dark:border-white/[0.07]">
        <div className="flex items-center gap-3 px-2">
          <div className="bg-signal flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-bold text-white">{(m.user.name || m.user.email).slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 text-xs">
            <p className="truncate font-semibold text-ink-800 dark:text-ink-100">{m.user.name}</p>
            <p className="truncate text-ink-500">{org?.name}</p>
          </div>
        </div>
        <button className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-sm text-ink-600 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-white/[0.05]" onClick={logout}>
          <LogOut className="size-[18px]" />Cerrar sesión
        </button>
      </div>
    </nav>
  );
  return (
    <div className="min-h-dvh pb-[calc(4.5rem+env(safe-area-inset-bottom))] lg:pb-0 lg:pl-[17rem]">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-ink-900">Saltar al contenido</a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[17rem] border-r border-ink-200 bg-white lg:block dark:border-white/[0.06] dark:bg-ink-900">{sidebar}</aside>
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-ink-200/80 bg-white/80 px-4 backdrop-blur-xl sm:px-6 dark:border-white/[0.06] dark:bg-ink-950/70">
        <button className="-ml-1 rounded-xl p-2 lg:hidden" aria-label="Abrir menú" aria-expanded={open} onClick={() => setOpen(true)}><Menu className="size-5" /></button>
        <Link to="/app/overview" className="lg:hidden"><Logo compact /></Link>
        <div className="ml-auto flex items-center gap-2"><LiveCounter /><ThemeToggle /></div>
      </header>
      {cfg.data?.announcement && (
        <div role="status" className="border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-sm text-amber-900 dark:text-amber-200">{cfg.data.announcement}</div>
      )}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <div className="absolute inset-0 bg-ink-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="page-in absolute inset-y-0 left-0 w-[17rem] max-w-[85vw] overflow-y-auto bg-white pb-[env(safe-area-inset-bottom)] dark:bg-ink-900">{sidebar}</div>
        </div>
      )}
      <main id="contenido" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
        <Suspense fallback={<PageFallback />}><div key={loc.pathname} className="page-in"><Outlet /></div></Suspense>
      </main>
      {/* Barra inferior en móvil: las cuatro secciones más usadas a un toque. */}
      <nav aria-label="Accesos rápidos" className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-5 border-t border-ink-200 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden dark:border-white/[0.07] dark:bg-ink-950/85">
        {MOBILE_TABS.map((t) => (
          <NavLink key={t.to} to={t.to} className={({ isActive }) => cx('flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium', isActive ? 'text-air-500' : 'text-ink-500 dark:text-ink-400')}>
            <t.icon className="size-5" />{t.label}
          </NavLink>
        ))}
        <button onClick={() => setOpen(true)} className="flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium text-ink-500 dark:text-ink-400"><Menu className="size-5" />Más</button>
      </nav>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <EmptyState icon={<X />} title="Página no encontrada" action={<Link to="/"><Button>Volver al inicio</Button></Link>}>La dirección no existe o se ha movido.</EmptyState>
    </div>
  );
}

const Lazy = ({ children }: { children: ReactNode }) => <Suspense fallback={<div className="mx-auto max-w-5xl p-6"><PageFallback /></div>}>{children}</Suspense>;

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<Lazy><AuthPage mode="login" /></Lazy>} />
      <Route path="/register" element={<Lazy><AuthPage mode="register" /></Lazy>} />
      <Route path="/legal/:doc" element={<Lazy><Legal /></Lazy>} />
      <Route path="/admin/*" element={<Lazy><Admin /></Lazy>} />
      <Route path="/app" element={<AppLayout />}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<Overview />} />
        <Route path="library" element={<Library />} />
        <Route path="playlists" element={<Playlists />} />
        <Route path="playlists/:id" element={<PlaylistEditor />} />
        <Route path="destinations" element={<Destinations />} />
        <Route path="streams" element={<Streams />} />
        <Route path="streams/new" element={<StreamNew />} />
        <Route path="streams/:id" element={<StreamDetail />} />
        <Route path="schedule" element={<Schedule />} />
        <Route path="settings" element={<SettingsPage />} />
      </Route>
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
