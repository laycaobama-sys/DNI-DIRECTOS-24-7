import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Loader2, X } from 'lucide-react';
import { ApiError } from './api';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
const variants: Record<Variant, string> = {
  primary: 'bg-air-500 text-white hover:bg-air-600 shadow-sm',
  secondary: 'bg-white text-ink-800 ring-1 ring-ink-200 hover:bg-ink-50 dark:bg-ink-800 dark:text-ink-100 dark:ring-ink-700 dark:hover:bg-ink-700',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  ghost: 'text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-ink-800',
};
export function Button({ variant = 'secondary', loading, className, children, disabled, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button {...p} disabled={disabled || loading} aria-busy={loading || undefined}
      className={cx('inline-flex h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50', variants[variant], className)}>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-medium text-ink-800 dark:text-ink-200">{label}</label>
      {children(id)}
      {hint && !error && <p className="text-xs text-ink-500 dark:text-ink-400">{hint}</p>}
      {error && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{error}</p>}
    </div>
  );
}
export const inputCls = 'block h-10 w-full rounded-lg border-0 bg-white px-3 text-sm text-ink-900 ring-1 ring-ink-200 placeholder:text-ink-400 focus:ring-2 focus:ring-air-500 dark:bg-ink-900 dark:text-ink-100 dark:ring-ink-700';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cx('rounded-2xl bg-white p-5 ring-1 ring-ink-200/70 dark:bg-ink-900 dark:ring-ink-800', className)}>{children}</div>
);

const tones = {
  live: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900',
  ok: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300 dark:ring-emerald-900',
  warn: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/50 dark:text-amber-300 dark:ring-amber-900',
  error: 'bg-red-50 text-red-700 ring-red-200 dark:bg-red-950/50 dark:text-red-300 dark:ring-red-900',
  muted: 'bg-ink-100 text-ink-600 ring-ink-200 dark:bg-ink-800 dark:text-ink-300 dark:ring-ink-700',
  info: 'bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950/50 dark:text-sky-300 dark:ring-sky-900',
};
export function Badge({ tone = 'muted', dot, children }: { tone?: keyof typeof tones; dot?: boolean; children: ReactNode }) {
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset', tones[tone])}>
      {dot && <span className="live-dot size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  );
}

const STATUS: Record<string, { label: string; tone: keyof typeof tones; dot?: boolean }> = {
  draft: { label: 'Borrador', tone: 'muted' }, ready: { label: 'Listo', tone: 'ok' }, scheduled: { label: 'Programado', tone: 'info' },
  starting: { label: 'Conectando', tone: 'info', dot: true }, live: { label: 'En directo', tone: 'live', dot: true }, degraded: { label: 'Degradado', tone: 'warn', dot: true },
  recovering: { label: 'Recuperando', tone: 'warn', dot: true }, stopping: { label: 'Deteniendo', tone: 'muted', dot: true }, stopped: { label: 'Detenido', tone: 'muted' },
  failed: { label: 'Error', tone: 'error' }, suspended: { label: 'Suspendido por cuota', tone: 'error' },
  uploading: { label: 'Subiendo', tone: 'info' }, queued: { label: 'En cola', tone: 'info' }, processing: { label: 'Procesando', tone: 'info', dot: true },
  idle: { label: 'Inactivo', tone: 'muted' }, connecting: { label: 'Conectando', tone: 'info', dot: true }, retrying: { label: 'Reintentando', tone: 'warn', dot: true },
};
export function StatusBadge({ status }: { status: string }) {
  const s = STATUS[status] ?? { label: status, tone: 'muted' as const };
  return <Badge tone={s.tone} dot={s.dot}>{s.label}</Badge>;
}

export const Skeleton = ({ className }: { className?: string }) => <div className={cx('animate-pulse rounded-lg bg-ink-200/70 dark:bg-ink-800', className)} aria-hidden />;

export function EmptyState({ icon, title, children, action }: { icon: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-ink-300 px-6 py-14 text-center dark:border-ink-700">
      <div className="mb-4 flex size-12 items-center justify-center rounded-xl bg-ink-100 text-ink-500 dark:bg-ink-800 dark:text-ink-300">{icon}</div>
      <h3 className="text-base font-semibold">{title}</h3>
      {children && <p className="mt-1 max-w-md text-sm text-ink-500 dark:text-ink-400">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-2xl bg-red-50 p-5 text-sm text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-200 dark:ring-red-900">
      <p className="font-medium">No se pudo cargar la información</p>
      <p className="mt-1 opacity-90">{errMsg(error)}</p>
      {onRetry && <Button className="mt-3" onClick={onRetry}>Reintentar</Button>}
    </div>
  );
}
export const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Error inesperado.');

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-ink-500 dark:text-ink-400">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Progress({ value, tone = 'air' }: { value: number; tone?: 'air' | 'ok' | 'warn' }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-200 dark:bg-ink-800" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-[width] duration-500', tone === 'ok' ? 'bg-ok-500' : tone === 'warn' ? 'bg-warn-500' : 'bg-air-500')} style={{ width: `${v}%` }} />
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="m-auto w-[min(32rem,calc(100vw-2rem))] rounded-2xl bg-white p-0 text-ink-900 shadow-2xl backdrop:bg-ink-950/60 dark:bg-ink-900 dark:text-ink-100">
      {open && (
        <div className="p-6">
          <div className="mb-4 flex items-start justify-between gap-4">
            <h2 className="text-lg font-semibold">{title}</h2>
            <button onClick={onClose} aria-label="Cerrar" className="rounded-lg p-1 text-ink-500 hover:bg-ink-100 dark:hover:bg-ink-800"><X className="size-5" /></button>
          </div>
          {children}
          {footer && <div className="mt-6 flex flex-wrap justify-end gap-2">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export function ConfirmButton({ label, title, message, confirmLabel, variant = 'danger', onConfirm, buttonVariant = 'secondary', icon }: {
  label: ReactNode; title: string; message: ReactNode; confirmLabel: string; variant?: Variant; buttonVariant?: Variant; onConfirm: () => Promise<unknown>; icon?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button variant={buttonVariant} onClick={() => setOpen(true)}>{icon}{label}</Button>
      <Modal open={open} title={title} onClose={() => setOpen(false)} footer={<>
        <Button onClick={() => setOpen(false)}>Cancelar</Button>
        <Button variant={variant} loading={busy} onClick={async () => {
          setBusy(true);
          try { await onConfirm(); setOpen(false); } catch (e) { toast(errMsg(e), 'error'); } finally { setBusy(false); }
        }}>{confirmLabel}</Button>
      </>}>
        <div className="text-sm text-ink-600 dark:text-ink-300">{message}</div>
      </Modal>
    </>
  );
}

// ───────── Toasts ─────────
type Toast = { id: number; text: string; tone: 'ok' | 'error' };
let toasts: Toast[] = [];
const subs = new Set<() => void>();
export function toast(text: string, tone: Toast['tone'] = 'ok') {
  const t = { id: Date.now() + Math.random(), text, tone };
  toasts = [...toasts, t];
  subs.forEach((f) => f());
  setTimeout(() => { toasts = toasts.filter((x) => x !== t); subs.forEach((f) => f()); }, tone === 'error' ? 8000 : 3500);
}
export function ToastHost() {
  const list = useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => toasts);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
          className={cx('pointer-events-auto max-w-md rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg', t.tone === 'error' ? 'bg-red-600' : 'bg-ink-800 dark:bg-ink-700')}>{t.text}</div>
      ))}
    </div>
  );
}
