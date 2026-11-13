import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BarChart3, CalendarClock, FolderOpen, LayoutDashboard, ListVideo, LogOut, Menu, Moon, Palette, Radio, Send, Settings, Sun, Users, Code2, X } from 'lucide-react';
import { ApiError, type Me, api, get } from './api';
import { Badge, Button, Card, EmptyState, Field, Input, Skeleton, cx, errMsg } from './ui';
import { Landing } from './pages/Landing';
import { Overview } from './pages/Overview';
import { Library } from './pages/Library';
import { PlaylistEditor, Playlists } from './pages/Playlists';
import { Destinations } from './pages/Destinations';
import { StreamDetail, StreamNew, Streams } from './pages/Streams';

export const useMe = () => useQuery<Me>({ queryKey: ['me'], queryFn: () => get('/v1/auth/me'), retry: false, staleTime: 60_000 });

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx('inline-flex items-center gap-2 font-semibold tracking-tight', className)}>
      <span className="relative flex size-7 items-center justify-center rounded-lg bg-ink-950 dark:bg-ink-800" aria-hidden>
        <span className="size-2.5 rounded-full bg-air-500" />
        <span className="absolute inset-1 rounded-full border-2 border-air-500/40" />
      </span>
      DNI Directos <span className="text-air-500">24/7</span>
    </span>
  );
}

export function ThemeToggle() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'} className="rounded-lg p-2 text-ink-500 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"
      onClick={() => { const d = !dark; document.documentElement.classList.toggle('dark', d); try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* sin almacenamiento */ } setDark(d); }}>
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}

const OAUTH_ERRORS: Record<string, string> = {
  google_cancelled: 'Has cancelado el acceso con Google.',
  google_state: 'La sesión de acceso con Google caducó. Inténtalo de nuevo.',
  google_email_unverified: 'Tu cuenta de Google no tiene el correo verificado.',
  signups_closed: 'El registro está cerrado: no existe una cuenta con ese correo.',
  google_not_configured: 'El acceso con Google no está configurado todavía.',
};

function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();
  const oauthError = new URLSearchParams(loc.search).get('error');
  const [error, setError] = useState<string | null>(oauthError ? (OAUTH_ERRORS[oauthError] ?? 'No se pudo iniciar sesión con Google. Inténtalo de nuevo.') : null);
  const [busy, setBusy] = useState(false);
  const me = useMe();
  const cfg = useQuery<{ signupsOpen: boolean; google: boolean }>({ queryKey: ['auth-config'], queryFn: () => get('/v1/auth/config'), staleTime: 60_000 });
  if (me.data) return <Navigate to="/app/overview" replace />
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setError(null);
    try {
      await api('POST', `/v1/auth/${mode}`, mode === 'register' ? f : { email: f.email, password: f.password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav('/app/overview');
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <Link to="/" className="mb-8 flex justify-center text-lg"><Logo /></Link>
        <Card>
          <h1 className="text-xl font-semibold">{mode === 'login' ? 'Inicia sesión' : 'Crea tu cuenta'}</h1>
          <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">{mode === 'login' ? 'Accede a tu panel de emisión.' : 'Gratis, sin tarjeta y sin límite de horas.'}</p>
          {mode === 'register' && cfg.data && !cfg.data.signupsOpen && (
            <p role="status" className="mt-4 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">El registro está cerrado en este momento.</p>
          )}
          {cfg.data?.google && (
            <>
              {/* Navegación completa (no fetch): el flujo OAuth redirige a Google y vuelve con la sesión creada. */}
              <a href="/v1/auth/google/start" className="mt-6 flex h-10 w-full items-center justify-center gap-3 rounded-lg bg-white text-sm font-medium text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 dark:bg-ink-800 dark:text-ink-100 dark:ring-ink-700 dark:hover:bg-ink-700">
                <svg viewBox="0 0 24 24" className="size-4.5" aria-hidden><path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" /><path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" /><path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" /><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" /></svg>
                {mode === 'login' ? 'Continuar con Google' : 'Registrarse con Google'}
              </a>
              <div className="mt-5 flex items-center gap-3 text-xs text-ink-400"><span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" />o con tu correo<span className="h-px flex-1 bg-ink-200 dark:bg-ink-800" /></div>
            </>
          )}
          <form onSubmit={submit} className={cfg.data?.google ? 'mt-5 space-y-4' : 'mt-6 space-y-4'} noValidate={false}>
            {mode === 'register' && <>
              <Field label="Tu nombre">{(id) => <Input id={id} name="name" required maxLength={80} autoComplete="name" />}</Field>
              <Field label="Nombre de la organización" hint="Tu canal, marca o empresa.">{(id) => <Input id={id} name="organizationName" required maxLength={80} autoComplete="organization" />}</Field>
            </>}
            <Field label="Email">{(id) => <Input id={id} name="email" type="email" required autoComplete="email" />}</Field>
            <Field label="Contraseña" hint={mode === 'register' ? 'Mínimo 10 caracteres.' : undefined}>
              {(id) => <Input id={id} name="password" type="password" required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}
            </Field>
            {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{error}</p>}
            <Button variant="primary" type="submit" loading={busy} className="w-full">{mode === 'login' ? 'Entrar' : 'Crear cuenta'}</Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-ink-500">
          {mode === 'login' ? <>¿No tienes cuenta? <Link className="font-medium text-air-600 hover:underline" to="/register">Empieza gratis</Link></> : <>¿Ya tienes cuenta? <Link className="font-medium text-air-600 hover:underline" to="/login">Inicia sesión</Link></>}
        </p>
      </div>
    </div>
  );
}

const NAV: { to: string; label: string; icon: ReactNode; soon?: boolean }[] = [
  { to: '/app/overview', label: 'Resumen', icon: <LayoutDashboard className="size-4.5" /> },
  { to: '/app/streams', label: 'Emisiones', icon: <Radio className="size-4.5" /> },
  { to: '/app/library', label: 'Biblioteca', icon: <FolderOpen className="size-4.5" /> },
  { to: '/app/playlists', label: 'Playlists', icon: <ListVideo className="size-4.5" /> },
  { to: '/app/destinations', label: 'Destinos', icon: <Send className="size-4.5" /> },
  { to: '/app/schedule', label: 'Programación', icon: <CalendarClock className="size-4.5" />, soon: true },
  { to: '/app/designer', label: 'Diseñador', icon: <Palette className="size-4.5" />, soon: true },
  { to: '/app/analytics', label: 'Analíticas', icon: <BarChart3 className="size-4.5" />, soon: true },
  { to: '/app/team', label: 'Equipo', icon: <Users className="size-4.5" />, soon: true },
  { to: '/app/developer', label: 'API', icon: <Code2 className="size-4.5" />, soon: true },
  { to: '/app/settings', label: 'Ajustes', icon: <Settings className="size-4.5" />, soon: true },
];

function AppLayout() {
  const me = useMe();
  const qc = useQueryClient();
  const nav = useNavigate();
  const loc = useLocation();
  const [open, setOpen] = useState(false);
  if (me.isLoading) return <div className="mx-auto max-w-5xl space-y-4 p-8"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /><Skeleton className="h-40" /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
    return <div className="mx-auto max-w-lg p-8"><EmptyState icon={<X />} title="No se pudo conectar" action={<Button onClick={() => me.refetch()}>Reintentar</Button>}>{errMsg(me.error)}</EmptyState></div>;
  }
  const org = me.data!.organizations.find((o) => o.id === me.data!.current.id);
  const sidebar = (
    <nav aria-label="Principal" className="flex h-full flex-col gap-1 p-3">
      <Link to="/app/overview" className="mb-4 px-2 py-2"><Logo /></Link>
      {NAV.map((n) => (
        <NavLink key={n.to} to={n.to} onClick={() => setOpen(false)}
          className={({ isActive }) => cx('flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium', isActive ? 'bg-ink-100 text-ink-900 dark:bg-ink-800 dark:text-white' : 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800/60')}>
          {n.icon}<span className="flex-1">{n.label}</span>
          {n.soon && <span className="rounded bg-ink-200 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-600 dark:bg-ink-700 dark:text-ink-300">Pronto</span>}
        </NavLink>
      ))}
      <div className="mt-auto space-y-2 border-t border-ink-200 pt-3 dark:border-ink-800">
        <div className="px-3 text-xs text-ink-500">
          <p className="truncate font-medium text-ink-800 dark:text-ink-200">{org?.name}</p>
          <p className="truncate">{me.data!.user.email}</p>
          <p className="mt-1"><Badge>{me.data!.current.limits.label}</Badge></p>
        </div>
        <button className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800"
          onClick={async () => { await api('POST', '/v1/auth/logout').catch(() => {}); qc.clear(); nav('/login'); }}>
          <LogOut className="size-4.5" />Cerrar sesión
        </button>
      </div>
    </nav>
  );
  return (
    <div className="min-h-dvh lg:pl-64">
      <a href="#contenido" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-white focus:px-3 focus:py-2">Saltar al contenido</a>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-ink-200 bg-white lg:block dark:border-ink-800 dark:bg-ink-900">{sidebar}</aside>
      <header className="sticky top-0 z-20 flex h-14 items-center justify-between border-b border-ink-200 bg-white/90 px-4 backdrop-blur lg:justify-end dark:border-ink-800 dark:bg-ink-900/90">
        <button className="rounded-lg p-2 lg:hidden" aria-label="Abrir menú" aria-expanded={open} onClick={() => setOpen(true)}><Menu className="size-5" /></button>
        <ThemeToggle />
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="Menú">
          <div className="absolute inset-0 bg-ink-950/60" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-white dark:bg-ink-900">{sidebar}</div>
        </div>
      )}
      <main id="contenido" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8"><Outlet /></main>
    </div>
  );
}

function ComingSoon({ title, children }: { title: string; children: ReactNode }) {
  return (
    <EmptyState icon={<CalendarClock />} title={`${title} — Próximamente`}>
      {children} Este módulo todavía no está operativo y por eso no mostramos controles que no funcionen.
    </EmptyState>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<AuthPage mode="login" />} />
      <Route path="/register" element={<AuthPage mode="register" />} />
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
        <Route path="schedule" element={<ComingSoon title="Programación">La API de programación con zonas horarias y cambio de hora ya existe; falta el calendario visual.</ComingSoon>} />
        <Route path="designer" element={<ComingSoon title="Diseñador de escenas">Overlays, logos, rótulos y «ahora suena».</ComingSoon>} />
        <Route path="analytics" element={<ComingSoon title="Analíticas">Las métricas técnicas reales están en cada emisión. Las de audiencia requieren la integración oficial de cada plataforma.</ComingSoon>} />
        <Route path="team" element={<ComingSoon title="Equipo">Los roles (owner, admin, editor, operator, viewer) ya se aplican en la API; falta la gestión de invitaciones.</ComingSoon>} />
        <Route path="developer" element={<ComingSoon title="API y webhooks">Tokens de API, webhooks firmados y documentación OpenAPI.</ComingSoon>} />
        <Route path="settings" element={<ComingSoon title="Ajustes">Perfil, idioma, seguridad y notificaciones.</ComingSoon>} />
      </Route>
      <Route path="*" element={<div className="p-10"><EmptyState icon={<X />} title="Página no encontrada" action={<Link to="/"><Button>Volver al inicio</Button></Link>} /></div>} />
    </Routes>
  );
}
