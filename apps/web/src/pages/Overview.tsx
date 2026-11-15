import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, Clock, HardDrive, Plus, Radio, Send, Sparkles, Users } from 'lucide-react';
import { fmtBytes, fmtTime, get } from '../api';
import { Badge, Button, Card, ErrorState, PageHeader, Progress, Skeleton, cx } from '../ui';
import { useTitle } from '../hooks';
import { AreaChart, CountUp, StatTile } from '../components/Charts';

interface OverviewData {
  plan: { id: string; label: string; unlimited: boolean };
  storage: { usedBytes: number; limitBytes: number; files: number };
  streams: { byStatus: Record<string, number>; running: number; limit: number };
  usage: { liveHoursThisMonth: number; limitHours: number; egressBytesThisMonth: number };
  counts: { playlists: number; destinations: number };
  audience: { available: boolean; connected: boolean; viewersNow?: number; streamsMeasured?: number; peak7d?: number | null; series?: { at: number; viewers: number }[]; top?: { id: string; name: string; viewers: number }[] };
  recentEvents: { id: number; streamId: string; streamName: string; level: string; message: string; at: number }[];
}

function AudiencePanel({ a }: { a: OverviewData['audience'] }) {
  if (!a.available) return (
    <Card className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Sparkles className="size-4 text-air-500" />Audiencia en directo</h2>
        <p className="mt-1 text-sm text-ink-500">Mira cuántas personas ven tus directos, el pico y las horas vistas. Incluido desde el plan Creador.</p></div>
      <Link to="/app/plan"><Button variant="primary">Ver planes</Button></Link>
    </Card>
  );
  if (!a.connected) return (
    <Card className="mt-6 flex flex-wrap items-center justify-between gap-3">
      <div><h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />Audiencia en directo</h2>
        <p className="mt-1 text-sm text-ink-500">Conecta tu canal de YouTube para ver los espectadores reales de tus directos (datos oficiales de YouTube).</p></div>
      <Link to="/app/destinations"><Button>Conectar YouTube</Button></Link>
    </Card>
  );
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />Audiencia en YouTube · últimas 24 h</h2>
          <p className="mt-1 text-xs text-ink-500">Espectadores simultáneos sumando todas tus emisiones (datos oficiales, cada 5 min).</p>
        </div>
        <div className="flex gap-6">
          <div><p className="flex items-center gap-1.5 text-xs text-ink-500">{(a.viewersNow ?? 0) > 0 && <span className="live-dot size-1.5 rounded-full bg-red-500" />}Viendo ahora</p><p className="text-2xl font-semibold"><CountUp value={a.viewersNow ?? 0} /></p></div>
          <div><p className="text-xs text-ink-500">Pico 7 días</p><p className="text-2xl font-semibold">{a.peak7d != null ? <CountUp value={a.peak7d} /> : '—'}</p></div>
        </div>
      </div>
      <div className="mt-4"><AreaChart label="Espectadores simultáneos en las últimas 24 horas" points={(a.series ?? []).map((p) => ({ at: p.at, value: p.viewers }))}
        timeFmt={(ms) => new Date(ms).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })} /></div>
    </Card>
  );
}

export function Overview() {
  useTitle('Resumen');
  const q = useQuery<OverviewData>({ queryKey: ['overview'], queryFn: () => get('/v1/overview'), refetchInterval: 5000 });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-9 w-48" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-64" /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const live = (d.streams.byStatus.live ?? 0) + (d.streams.byStatus.degraded ?? 0);
  const problems = (d.streams.byStatus.degraded ?? 0) + (d.streams.byStatus.recovering ?? 0) + (d.streams.byStatus.failed ?? 0);
  const totalStreams = Object.values(d.streams.byStatus).reduce((a, b) => a + b, 0);
  const steps = [
    { done: d.storage.files > 0, title: 'Sube tus vídeos', text: 'Varios a la vez; se preparan solos.', to: '/app/library', cta: 'Subir' },
    { done: d.counts.playlists > 0, title: 'Crea y publica una playlist', text: 'Ordénalos y pulsa «Publicar».', to: '/app/playlists', cta: 'Crear' },
    { done: d.counts.destinations > 0, title: 'Conecta YouTube u otro destino', text: 'Con Google en un clic o con RTMP.', to: '/app/destinations', cta: 'Conectar' },
    { done: totalStreams > 0, title: 'Crea tu emisión', text: 'Elige playlist, calidad y destinos.', to: '/app/streams/new', cta: 'Crear' },
    { done: d.streams.running > 0 || d.usage.liveHoursThisMonth > 0, title: 'Inicia el directo', text: 'Y apaga el ordenador si quieres.', to: '/app/streams', cta: 'Ir' },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  return (
    <>
      <PageHeader title="Resumen" description="Datos medidos en tiempo real por el motor de emisión"
        actions={<Link to="/app/streams/new"><Button variant="primary"><Plus className="size-4" />Nueva emisión</Button></Link>} />
      {doneCount < steps.length && (
        <Card className="relative mb-6 overflow-hidden">
          <div className="pointer-events-none absolute -right-20 -top-20 size-56 rounded-full bg-air-500/15 blur-3xl" aria-hidden />
          <div className="relative flex flex-wrap items-end justify-between gap-3">
            <div><h2 className="text-lg font-semibold">Tu canal 24/7 en {steps.length} pasos</h2><p className="text-sm text-ink-500">{doneCount} de {steps.length} completados</p></div>
            <div className="w-full max-w-xs"><Progress value={(doneCount / steps.length) * 100} /></div>
          </div>
          <ol className="relative mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {steps.map((s, i) => {
              const current = !s.done && steps.slice(0, i).every((x) => x.done);
              return (
                <li key={s.title} className={cx('flex-col rounded-2xl p-4 ring-1 transition', s.done ? 'hidden bg-emerald-500/[0.06] ring-emerald-500/20 sm:flex' : 'flex', s.done ? '' : current ? 'bg-air-500/[0.06] ring-air-500/40' : 'ring-ink-200 dark:ring-white/[0.07]')}>
                  <span className={cx('flex size-7 items-center justify-center rounded-full text-xs font-bold', s.done ? 'bg-emerald-500 text-white' : current ? 'bg-signal text-white' : 'bg-ink-100 text-ink-500 dark:bg-white/[0.06]')}>{s.done ? <Check className="size-4" /> : i + 1}</span>
                  <p className="mt-3 text-sm font-semibold">{s.title}</p>
                  <p className="mt-0.5 flex-1 text-xs text-ink-500">{s.text}</p>
                  {!s.done && <Link to={s.to} className={cx('mt-3 text-sm font-semibold', current ? 'text-air-500' : 'text-ink-500')}>{s.cta} →</Link>}
                </li>
              );
            })}
          </ol>
        </Card>
      )}
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Emisiones en directo" tone={live ? 'live' : undefined} icon={<Radio className="size-4" />}
          value={<><CountUp value={live} />{!d.plan.unlimited && <span className="text-base font-normal text-ink-400"> / {d.streams.limit}</span>}</>}
          hint={problems ? <Badge tone="warn">{problems} con incidencias</Badge> : 'Sin incidencias activas'} />
        <StatTile label="Horas emitidas este mes" icon={<Clock className="size-4" />}
          value={<><CountUp value={d.usage.liveHoursThisMonth} decimals={1} /><span className="text-base font-normal text-ink-400"> {d.plan.unlimited ? 'h' : `/ ${d.usage.limitHours} h`}</span></>}
          hint={d.plan.unlimited ? 'Sin límite de horas' : <Progress value={(d.usage.liveHoursThisMonth / d.usage.limitHours) * 100} tone={d.usage.liveHoursThisMonth / d.usage.limitHours > 0.85 ? 'warn' : 'air'} />} />
        <StatTile label="Almacenamiento" icon={<HardDrive className="size-4" />}
          value={<>{fmtBytes(d.storage.usedBytes)}{!d.plan.unlimited && <span className="text-base font-normal text-ink-400"> / {fmtBytes(d.storage.limitBytes)}</span>}</>}
          hint={d.plan.unlimited ? `${d.storage.files} archivo(s)` : <Progress value={(d.storage.usedBytes / d.storage.limitBytes) * 100} />} />
        <StatTile label="Datos enviados este mes" icon={<Send className="size-4" />} value={fmtBytes(d.usage.egressBytesThisMonth)}
          hint={<>{d.counts.destinations} destino(s) · {d.counts.playlists} playlist(s) · <Link to="/app/plan" className="font-medium text-air-500 hover:underline">Plan {d.plan.label}</Link></>} />
      </div>
      <AudiencePanel a={d.audience} />
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <h2 className="font-semibold">Actividad reciente</h2>
          {d.recentEvents.length === 0 ? <p className="mt-4 text-sm text-ink-500">Aún no hay eventos. Aparecerán aquí cuando inicies una emisión.</p> : (
            <ul className="mt-3 divide-y divide-ink-100 dark:divide-ink-800">
              {d.recentEvents.map((e) => (
                <li key={e.id} className="flex items-start gap-3 py-2.5 text-sm">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${e.level === 'error' ? 'bg-red-500' : e.level === 'warn' ? 'bg-amber-500' : 'bg-ink-300 dark:bg-ink-600'}`} aria-label={e.level} />
                  <div className="min-w-0 flex-1">
                    <p className="break-words">{e.message}</p>
                    <p className="text-xs text-ink-500"><Link className="hover:underline" to={`/app/streams/${e.streamId}`}>{e.streamName}</Link> · {fmtTime(e.at)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />Más vistas ahora</h2>
          {!d.audience.available || !d.audience.connected || !d.audience.top?.length
            ? <p className="mt-3 text-sm text-ink-500">Cuando emitas en YouTube con tu canal conectado verás aquí qué emisiones tienen más espectadores.</p>
            : <ul className="mt-3 space-y-2">{d.audience.top.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 text-sm">
                  <Link to={`/app/streams/${t.id}`} className="min-w-0 truncate hover:underline">{t.name}</Link>
                  <span className="shrink-0 font-semibold tabular-nums">{t.viewers.toLocaleString('es-ES')}</span>
                </li>))}</ul>}
          <Link to="/app/streams" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-air-600 hover:underline"><Radio className="size-4" />Ver emisiones</Link>
        </Card>
      </div>
    </>
  );
}
