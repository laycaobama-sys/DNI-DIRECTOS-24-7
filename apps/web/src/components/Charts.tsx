/**
 * Gráficas ligeras en SVG/HTML (sin librerías): una serie por gráfica, una sola escala, marcas finas,
 * rejilla discreta y capa de hover con tooltip. Color de la marca (naranja «señal») para la magnitud.
 */
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../ui';

const nf = new Intl.NumberFormat('es-ES');
export const fmtNum = (n: number) => nf.format(Math.round(n));

/** Cifra que cuenta hasta su valor al aparecer (respeta «reducir movimiento»). */
export function CountUp({ value, decimals = 0, suffix = '' }: { value: number; decimals?: number; suffix?: string }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    const start = performance.now(), a = from.current, dur = 900;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - k, 4);
      setShown(a + (value - a) * e);
      if (k < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return <span className="tabular-nums">{shown.toLocaleString('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</span>;
}

export function StatTile({ label, value, hint, icon, tone }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'live' }) {
  return (
    <div className="glass-card group relative overflow-hidden rounded-2xl p-5">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-ink-500 dark:text-ink-400">{label}</p>
        {icon && <span className={cx('flex size-8 items-center justify-center rounded-xl', tone === 'live' ? 'bg-red-500/10 text-red-500' : 'bg-air-500/10 text-air-500')}>{icon}</span>}
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
      {hint && <div className="mt-1.5 text-xs text-ink-500">{hint}</div>}
    </div>
  );
}

export interface Point { at: number; value: number }

/** Área de una serie temporal con cruz y tooltip al pasar el ratón o el dedo. */
export function AreaChart({ points, height = 180, label, format = fmtNum, timeFmt }: {
  points: Point[]; height?: number; label: string; format?: (n: number) => string; timeFmt?: (ms: number) => string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tf = timeFmt ?? ((ms: number) => new Date(ms).toLocaleString('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }));
  const pad = { l: 40, r: 12, t: 12, b: 24 };
  const geo = useMemo(() => {
    if (!points.length) return null;
    const x0 = points[0]!.at, x1 = points.at(-1)!.at || x0 + 1;
    const max = Math.max(1, ...points.map((p) => p.value));
    const nice = Math.pow(10, Math.floor(Math.log10(max)));
    const top = Math.ceil(max / nice) * nice;
    const X = (t: number) => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (w - pad.l - pad.r);
    const Y = (v: number) => pad.t + (1 - v / top) * (height - pad.t - pad.b);
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${X(p.at).toFixed(1)},${Y(p.value).toFixed(1)}`).join('');
    const area = `${line}L${X(x1).toFixed(1)},${Y(0)}L${X(x0).toFixed(1)},${Y(0)}Z`;
    return { X, Y, top, line, area, x0, x1 };
  }, [points, w, height]);
  if (!geo) return <div ref={ref} className="flex items-center justify-center rounded-xl bg-ink-50 text-sm text-ink-500 dark:bg-white/[0.03]" style={{ height }}>Aún no hay datos en este periodo.</div>;
  const ticks = [0, geo.top / 2, geo.top];
  const hp = hover !== null ? points[hover] : null;
  const onMove = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const t = geo.x0 + ((clientX - r.left - pad.l) / (w - pad.l - pad.r)) * (geo.x1 - geo.x0);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.at - t) < Math.abs(points[best]!.at - t)) best = i;
    setHover(best);
  };
  return (
    <div ref={ref} className="relative select-none" onMouseLeave={() => setHover(null)}>
      <svg width={w} height={height} role="img" aria-label={label} className="block overflow-visible"
        onMouseMove={(e) => onMove(e.clientX)} onTouchStart={(e) => onMove(e.touches[0]!.clientX)} onTouchMove={(e) => onMove(e.touches[0]!.clientX)}>
        <defs>
          <linearGradient id="area-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="var(--color-air-500)" stopOpacity="0.28" />
            <stop offset="100%" stopColor="var(--color-air-500)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={pad.l} x2={w - pad.r} y1={geo.Y(v)} y2={geo.Y(v)} className="stroke-ink-200 dark:stroke-white/[0.06]" strokeDasharray={v ? '3 4' : undefined} />
            <text x={pad.l - 8} y={geo.Y(v) + 4} textAnchor="end" className="fill-ink-400 text-[10px] tabular-nums">{format(v)}</text>
          </g>
        ))}
        <path d={geo.area} fill="url(#area-fill)" className="chart-draw-area" />
        <path d={geo.line} fill="none" stroke="var(--color-air-500)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" className="chart-draw-line" pathLength={1} />
        <text x={pad.l} y={height - 6} className="fill-ink-400 text-[10px]">{tf(geo.x0)}</text>
        <text x={w - pad.r} y={height - 6} textAnchor="end" className="fill-ink-400 text-[10px]">{tf(geo.x1)}</text>
        {hp && (
          <g>
            <line x1={geo.X(hp.at)} x2={geo.X(hp.at)} y1={pad.t} y2={height - pad.b} className="stroke-ink-300 dark:stroke-white/20" />
            <circle cx={geo.X(hp.at)} cy={geo.Y(hp.value)} r={5} fill="var(--color-air-500)" className="stroke-white dark:stroke-ink-900" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hp && (
        <div className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 rounded-lg bg-ink-900 px-2.5 py-1.5 text-xs text-white shadow-lg dark:bg-white dark:text-ink-900"
          style={{ left: Math.min(w - 60, Math.max(60, geo.X(hp.at))) }}>
          <p className="font-semibold tabular-nums">{format(hp.value)}</p>
          <p className="opacity-70">{tf(hp.at)}</p>
        </div>
      )}
    </div>
  );
}

/** Lista de barras horizontales (magnitud), con valor siempre visible: país, referente, dispositivo… */
export function BarList({ rows, empty = 'Sin datos todavía.', format = fmtNum }: { rows: { label: ReactNode; value: number; key: string }[]; empty?: string; format?: (n: number) => string }) {
  if (!rows.length) return <p className="text-sm text-ink-500">{empty}</p>;
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <ul className="space-y-1.5">
      {rows.map((r, i) => (
        <li key={r.key} className="group relative flex items-center justify-between gap-3 overflow-hidden rounded-lg px-2.5 py-1.5 text-sm" title={`${format(r.value)}`}>
          <span className="bar-grow absolute inset-y-0 left-0 rounded-lg bg-air-500/12 group-hover:bg-air-500/20 dark:bg-air-500/15" style={{ width: `${(r.value / max) * 100}%`, ['--d' as string]: `${i * 40}ms` }} aria-hidden />
          <span className="relative min-w-0 truncate">{r.label}</span>
          <span className="relative shrink-0 font-medium tabular-nums text-ink-700 dark:text-ink-200">{format(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Bandera emoji a partir del código ISO del país (Cloudflare). */
export const flag = (cc: string | null | undefined) => (cc && /^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1a5 + c.charCodeAt(0))) : '🌐');
const regionNames = typeof Intl !== 'undefined' && 'DisplayNames' in Intl ? new Intl.DisplayNames(['es'], { type: 'region' }) : null;
export const countryName = (cc: string | null | undefined) => {
  if (!cc || cc === '??' || cc === 'XX' || cc === 'T1') return 'Desconocido';
  try { return regionNames?.of(cc) ?? cc; } catch { return cc; }
};
