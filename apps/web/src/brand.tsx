import { useId, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { cx } from './ui';

/** Símbolo de marca: punto «en directo» con dos ondas de señal sobre un cuadro redondeado. */
export function LogoMark({ className, title }: { className?: string; title?: string }) {
  // Id único por instancia: si dos logos comparten id y el primero está oculto (display:none), el degradado no se pinta.
  const g = `dni-g-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg viewBox="0 0 48 48" className={cx('size-8 shrink-0', className)} role={title ? 'img' : undefined} aria-hidden={title ? undefined : true} aria-label={title}>
      <defs>
        <linearGradient id={g} x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ff4f2e" /><stop offset=".55" stopColor="#ff8a3d" /><stop offset="1" stopColor="#ffb020" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="13" fill="#0b0d13" />
      <rect x=".75" y=".75" width="46.5" height="46.5" rx="12.25" fill="none" stroke={`url(#${g})`} strokeOpacity=".35" strokeWidth="1.5" />
      <circle cx="24" cy="24" r="5.5" fill={`url(#${g})`} />
      <path d="M15.5 15.5a12 12 0 0 0 0 17M32.5 15.5a12 12 0 0 1 0 17" fill="none" stroke={`url(#${g})`} strokeWidth="3" strokeLinecap="round" />
      <path d="M10 10a19.8 19.8 0 0 0 0 28M38 10a19.8 19.8 0 0 1 0 28" fill="none" stroke={`url(#${g})`} strokeOpacity=".45" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

export function Logo({ className, compact }: { className?: string; compact?: boolean }) {
  return (
    <span className={cx('inline-flex items-center gap-2.5 font-bold tracking-tight', className)}>
      <LogoMark />
      {!compact && <span className="whitespace-nowrap text-[15px] sm:text-[17px]">DNI<span className="font-medium text-ink-500 dark:text-ink-400"> Directos</span> <span className="text-signal">24/7</span></span>}
    </span>
  );
}

export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-[18px]', className)} aria-hidden>
      <path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.5 5.5 0 0 1-2.4 3.6v3h3.9c2.3-2.1 3.5-5.2 3.5-8.7z" />
      <path fill="#34A853" d="M12 24c3.2 0 6-1.1 8-2.9l-3.9-3c-1.1.7-2.5 1.2-4.1 1.2-3.1 0-5.8-2.1-6.7-5H1.3v3.1A12 12 0 0 0 12 24z" />
      <path fill="#FBBC05" d="M5.3 14.3a7.2 7.2 0 0 1 0-4.6V6.6H1.3a12 12 0 0 0 0 10.8l4-3.1z" />
      <path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.3 6.6l4 3.1c.9-2.9 3.6-4.9 6.7-4.9z" />
    </svg>
  );
}

/** Icono genérico de «reproductor de vídeo» en rojo para señalar YouTube (sin usar su logotipo registrado). */
export function YoutubeIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cx('size-5', className)} aria-hidden>
      <rect x="2" y="5" width="20" height="14" rx="4.5" fill="#ff0033" />
      <path d="M10 9.2v5.6l4.8-2.8z" fill="#fff" />
    </svg>
  );
}

export function ThemeToggle({ className }: { className?: string }) {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  return (
    <button aria-label={dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro'} title={dark ? 'Tema claro' : 'Tema oscuro'}
      className={cx('rounded-xl p-2 text-ink-500 transition-colors hover:bg-ink-100 hover:text-ink-900 dark:text-ink-300 dark:hover:bg-white/[0.06] dark:hover:text-white', className)}
      onClick={() => {
        const d = !dark;
        document.documentElement.classList.toggle('dark', d);
        try { localStorage.setItem('theme', d ? 'dark' : 'light'); } catch { /* sin almacenamiento */ }
        setDark(d);
      }}>
      {dark ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </button>
  );
}
