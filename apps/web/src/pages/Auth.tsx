import { type FormEvent, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { api } from '../api';
import { GoogleIcon, Logo } from '../brand';
import { useAuthConfig, useMe, useTitle } from '../hooks';
import { Button, Field, Input, cx, errMsg } from '../ui';

const OAUTH_ERRORS: Record<string, string> = {
  google_cancelled: 'Has cancelado el acceso con Google.',
  google_state: 'La sesión de acceso con Google caducó. Inténtalo de nuevo.',
  google_exchange: 'Google no confirmó el acceso. Inténtalo de nuevo.',
  google_token: 'No se pudo validar tu cuenta de Google. Inténtalo de nuevo.',
  google_email_unverified: 'Tu cuenta de Google no tiene el correo verificado.',
  signups_closed: 'El registro está cerrado: no existe una cuenta con ese correo.',
  google_not_configured: 'El acceso con Google aún no está activado.',
  account_disabled: 'Tu cuenta está desactivada. Contacta con el administrador.',
};

const PERKS = ['Emisión 24/7 desde la nube, con el ordenador apagado', 'YouTube, Twitch, Kick, Facebook y cualquier RTMP', 'Recuperación automática si algo falla', 'Gratis y sin límite de horas'];

export default function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  useTitle(mode === 'login' ? 'Iniciar sesión' : 'Crear cuenta');
  const nav = useNavigate();
  const qc = useQueryClient();
  const loc = useLocation();
  const oauthError = new URLSearchParams(loc.search).get('error');
  const [error, setError] = useState<string | null>(oauthError ? (OAUTH_ERRORS[oauthError] ?? 'No se pudo iniciar sesión con Google. Inténtalo de nuevo.') : null);
  const [busy, setBusy] = useState(false);
  const me = useMe();
  const cfg = useAuthConfig();
  if (me.data) return <Navigate to="/app/overview" replace />;
  const from = (loc.state as { from?: string } | null)?.from;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setBusy(true); setError(null);
    try {
      await api('POST', `/v1/auth/${mode}`, mode === 'register' ? f : { email: f.email, password: f.password });
      await qc.invalidateQueries({ queryKey: ['me'] });
      nav(from?.startsWith('/app') || from?.startsWith('/admin') ? from : '/app/overview');
    } catch (err) { setError(errMsg(err)); } finally { setBusy(false); }
  }

  const closed = mode === 'register' && cfg.data && !cfg.data.signupsOpen;
  return (
    <div className="dark relative grid min-h-dvh bg-ink-950 text-ink-100 lg:grid-cols-2">
      {/* Panel de marca (escritorio) */}
      <div className="relative hidden overflow-hidden border-r border-white/[0.06] lg:block">
        <div className="aurora" aria-hidden><span /><span /><span /></div>
        <div className="bg-grid absolute inset-0" aria-hidden />
        <div className="relative flex h-full flex-col justify-between p-12">
          <Link to="/"><Logo /></Link>
          <div>
            <h2 className="max-w-md text-4xl font-bold leading-tight tracking-tight">Tu canal no se apaga.<br /><span className="text-signal">Nunca.</span></h2>
            <ul className="mt-8 space-y-3">
              {PERKS.map((p) => <li key={p} className="flex items-center gap-3 text-ink-300"><span className="flex size-6 items-center justify-center rounded-full bg-white/10"><Check className="size-3.5 text-air-400" /></span>{p}</li>)}
            </ul>
          </div>
          <p className="text-xs text-ink-500">Emite solo contenido del que tengas los derechos.</p>
        </div>
      </div>

      <div className="flex items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-[400px]">
          <Link to="/" className="mb-10 flex justify-center lg:hidden"><Logo /></Link>
          <h1 className="text-3xl font-bold tracking-tight">{mode === 'login' ? 'Bienvenido de nuevo' : 'Crea tu cuenta gratis'}</h1>
          <p className="mt-2 text-ink-400">{mode === 'login' ? 'Entra en tu estudio de emisión.' : 'Sin tarjeta y sin límite de horas. Listo en un minuto.'}</p>

          {closed && <p role="status" className="mt-6 rounded-xl bg-amber-500/10 px-4 py-3 text-sm text-amber-200 ring-1 ring-amber-500/20">El registro está cerrado en este momento.</p>}

          {cfg.data?.google && (
            <>
              {/* Navegación completa (no fetch): el flujo OAuth sale a Google y vuelve con la sesión creada. */}
              <a href="/v1/auth/google/start" className="mt-8 flex h-12 w-full items-center justify-center gap-3 rounded-xl bg-white text-[15px] font-semibold text-ink-900 shadow-lg transition hover:bg-ink-100 active:scale-[0.99]">
                <GoogleIcon />{mode === 'login' ? 'Continuar con Google' : 'Registrarse con Google'}
              </a>
              <div className="my-6 flex items-center gap-3 text-xs uppercase tracking-wider text-ink-500"><span className="h-px flex-1 bg-white/10" />o con tu correo<span className="h-px flex-1 bg-white/10" /></div>
            </>
          )}

          <form onSubmit={submit} className={cx('space-y-4', !cfg.data?.google && 'mt-8')}>
            {mode === 'register' && <>
              <Field label="Tu nombre">{(id) => <Input id={id} name="name" required maxLength={80} autoComplete="name" />}</Field>
              <Field label="Nombre de tu canal o marca">{(id) => <Input id={id} name="organizationName" required maxLength={80} autoComplete="organization" />}</Field>
            </>}
            <Field label="Email">{(id) => <Input id={id} name="email" type="email" required autoComplete="email" inputMode="email" />}</Field>
            <Field label="Contraseña" hint={mode === 'register' ? 'Mínimo 10 caracteres.' : undefined}>
              {(id) => <Input id={id} name="password" type="password" required minLength={mode === 'register' ? 10 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />}
            </Field>
            {error && <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-300 ring-1 ring-red-500/20">{error}</p>}
            <Button variant="primary" type="submit" loading={busy} disabled={!!closed} className="h-12 w-full text-[15px]">{mode === 'login' ? 'Entrar' : 'Crear cuenta'}</Button>
          </form>
          <p className="mt-6 text-center text-sm text-ink-400">
            {mode === 'login' ? <>¿No tienes cuenta? <Link className="font-semibold text-air-400 hover:underline" to="/register">Empieza gratis</Link></> : <>¿Ya tienes cuenta? <Link className="font-semibold text-air-400 hover:underline" to="/login">Inicia sesión</Link></>}
          </p>
          {mode === 'register' && <p className="mt-6 text-center text-xs text-ink-500">Al crear la cuenta aceptas los <Link to="/legal/terminos" className="underline">términos</Link> y la <Link to="/legal/privacidad" className="underline">política de privacidad</Link>.</p>}
        </div>
      </div>
    </div>
  );
}
