import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Plus, Radio } from 'lucide-react';
import { fmtBytes, fmtTime, get } from '../api';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Progress, Skeleton } from '../ui';

interface OverviewData {
  plan: { label: string };
  storage: { usedBytes: number; limitBytes: number; files: number };
  streams: { byStatus: Record<string, number>; running: number; limit: number };
  usage: { liveHoursThisMonth: number; limitHours: number; egressBytesThisMonth: number };
  counts: { playlists: number; destinations: number };
  audience: { available: boolean; reason: string };
  recentEvents: { id: number; streamId: string; streamName: string; level: string; message: string; at: number }[];
}

export function Overview() {
  const q = useQuery<OverviewData>({ queryKey: ['overview'], queryFn: () => get('/v1/overview'), refetchInterval: 5000 });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-9 w-48" /><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-64" /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const d = q.data;
  const live = (d.streams.byStatus.live ?? 0) + (d.streams.byStatus.degraded ?? 0);
  const problems = (d.streams.byStatus.degraded ?? 0) + (d.streams.byStatus.recovering ?? 0) + (d.streams.byStatus.failed ?? 0);
  const firstRun = d.storage.files === 0;
  return (
    <>
      <PageHeader title="Resumen" description={`Plan ${d.plan.label} · datos medidos por el motor de emisión`}
        actions={<Link to="/app/streams/new"><Button variant="primary"><Plus className="size-4" />Nueva emisión</Button></Link>} />
      {firstRun && (
        <div className="mb-6">
          <EmptyState icon={<FolderOpen />} title="Empieza subiendo tus vídeos" action={<Link to="/app/library"><Button variant="primary">Ir a la biblioteca</Button></Link>}>
            Para emitir necesitas tres cosas: vídeos procesados, una playlist publicada y al menos un destino. Te llevará pocos minutos.
          </EmptyState>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-sm text-ink-500">Emisiones en directo</p>
          <p className="mt-2 text-3xl font-semibold">{live}<span className="text-base font-normal text-ink-400"> / {d.streams.limit}</span></p>
          <p className="mt-2 text-xs">{problems ? <Badge tone="warn">{problems} con incidencias</Badge> : <span className="text-ink-500">Sin incidencias activas</span>}</p>
        </Card>
        <Card>
          <p className="text-sm text-ink-500">Horas emitidas este mes</p>
          <p className="mt-2 text-3xl font-semibold">{d.usage.liveHoursThisMonth.toFixed(1)}<span className="text-base font-normal text-ink-400"> / {d.usage.limitHours} h</span></p>
          <div className="mt-3"><Progress value={(d.usage.liveHoursThisMonth / d.usage.limitHours) * 100} tone={d.usage.liveHoursThisMonth / d.usage.limitHours > 0.85 ? 'warn' : 'air'} /></div>
        </Card>
        <Card>
          <p className="text-sm text-ink-500">Almacenamiento</p>
          <p className="mt-2 text-3xl font-semibold">{fmtBytes(d.storage.usedBytes)}<span className="text-base font-normal text-ink-400"> / {fmtBytes(d.storage.limitBytes)}</span></p>
          <div className="mt-3"><Progress value={(d.storage.usedBytes / d.storage.limitBytes) * 100} /></div>
        </Card>
        <Card>
          <p className="text-sm text-ink-500">Datos enviados este mes</p>
          <p className="mt-2 text-3xl font-semibold">{fmtBytes(d.usage.egressBytesThisMonth)}</p>
          <p className="mt-2 text-xs text-ink-500">{d.counts.destinations} destino(s) · {d.counts.playlists} playlist(s)</p>
        </Card>
      </div>
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
          <h2 className="font-semibold">Audiencia</h2>
          <div className="mt-3"><Badge>Sin conectar</Badge></div>
          <p className="mt-3 text-sm text-ink-500">{d.audience.reason}</p>
          <p className="mt-3 text-xs text-ink-400">No mostramos espectadores ni tiempo de visualización estimados.</p>
          <Link to="/app/streams" className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-air-600 hover:underline"><Radio className="size-4" />Ver emisiones</Link>
        </Card>
      </div>
    </>
  );
}
