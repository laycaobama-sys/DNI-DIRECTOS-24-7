import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Crown, Sparkles } from 'lucide-react';
import type { PublicPlan } from '@dni/shared';
import { api, fmtBytes, fmtTime, get } from '../api';
import { useTitle } from '../hooks';
import { Badge, Button, Card, ErrorState, PageHeader, Progress, Skeleton, cx, errMsg, toast } from '../ui';

interface Billing {
  current: PublicPlan & { id: string; unlimited: boolean };
  usage: { liveHoursThisMonth: number; egressBytesThisMonth: number; storageBytes: number; runningStreams: number };
  catalog: (PublicPlan & { checkout: { monthly: boolean; yearly: boolean } })[];
  pendingRequest: { id: string; plan: string; billing: string; createdAt: number } | null;
}

const PROFILE_LABEL: Record<string, string> = { '720p30': '720p', '1080p30': '1080p', '1080p60': '1080p 60 fps', '2160p30': '4K' };

export default function PlanPage() {
  useTitle('Plan');
  const qc = useQueryClient();
  const [yearly, setYearly] = useState(false);
  const q = useQuery<Billing>({ queryKey: ['billing'], queryFn: () => get('/v1/billing') });
  const req = useMutation({
    mutationFn: (plan: string) => api<{ applied: boolean; checkoutUrl: string | null }>('POST', '/v1/billing/request', { plan, billing: yearly ? 'yearly' : 'monthly' }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['billing'] });
      void qc.invalidateQueries({ queryKey: ['me'] });
      if (r.applied) toast('Plan cambiado');
      else if (r.checkoutUrl) window.location.href = r.checkoutUrl;
      else toast('Solicitud enviada. Te escribiremos para completar el pago y activarlo.');
    },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-9 w-48" /><div className="grid gap-4 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96" />)}</div></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { current: cur, usage: u, catalog, pendingRequest } = q.data;
  const pendingLabel = pendingRequest && catalog.find((p) => p.id === pendingRequest.plan)?.label;
  return (
    <>
      <PageHeader title="Plan y consumo" description="Cambia de plan cuando quieras. Los límites se aplican al instante." />
      <Card className="relative overflow-hidden">
        <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-air-500/15 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-sm text-ink-500">Tu plan</p>
            <p className="mt-1 flex items-center gap-2 text-2xl font-semibold">{cur.unlimited && <Crown className="size-5 text-amber-500" />}{cur.label}</p>
            {cur.unlimited && <p className="mt-1 text-sm text-ink-500">Cuenta fundadora: sin límites comerciales.</p>}
          </div>
          {pendingRequest && <Badge tone="info">Cambio a {pendingLabel ?? pendingRequest.plan} pendiente · {fmtTime(pendingRequest.createdAt)}</Badge>}
        </div>
        {!cur.unlimited && (
          <div className="relative mt-5 grid gap-5 sm:grid-cols-3">
            <Meter label="Horas en directo este mes" value={u.liveHoursThisMonth} max={cur.monthlyStreamHours} fmt={(n) => `${n.toFixed(1)} h`} />
            <Meter label="Almacenamiento" value={u.storageBytes} max={cur.storageBytes} fmt={fmtBytes} />
            <Meter label="Emisiones activas" value={u.runningStreams} max={cur.maxConcurrentStreams} fmt={(n) => String(n)} />
          </div>
        )}
      </Card>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Planes</h2>
        <div role="tablist" aria-label="Facturación" className="flex rounded-xl bg-ink-100 p-1 text-sm dark:bg-white/[0.05]">
          {([false, true] as const).map((y) => (
            <button key={String(y)} role="tab" aria-selected={yearly === y} onClick={() => setYearly(y)}
              className={cx('rounded-lg px-3 py-1.5 font-medium transition-colors', yearly === y ? 'bg-white shadow-sm dark:bg-white/10' : 'text-ink-500')}>
              {y ? <>Anual <span className="text-emerald-600 dark:text-emerald-400">−20 %</span></> : 'Mensual'}
            </button>
          ))}
        </div>
      </div>
      <div className="stagger mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {catalog.map((p) => {
          const isCur = p.id === cur.id;
          const price = yearly ? p.priceYearly : p.priceMonthly;
          return (
            <div key={p.id} className={cx('glass-card relative flex flex-col rounded-2xl p-5', p.highlight && 'border-spin')}>
              {p.highlight && <span className="absolute -top-2.5 left-5 inline-flex items-center gap-1 rounded-full bg-signal px-2.5 py-0.5 text-[11px] font-semibold text-white"><Sparkles className="size-3" />Más elegido</span>}
              <p className="font-semibold">{p.label}</p>
              <p className="mt-1 min-h-10 text-sm text-ink-500">{p.tagline}</p>
              <p className="mt-3 text-3xl font-semibold tracking-tight">{price} €<span className="text-sm font-normal text-ink-500">{price ? ' /mes' : ''}</span></p>
              <p className="h-5 text-xs text-ink-500">{price && yearly ? `${price * 12} € al año` : ''}</p>
              <ul className="mt-4 flex-1 space-y-2 text-sm">
                {p.features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />{f}</li>)}
                <li className="flex gap-2 text-ink-500"><Check className="mt-0.5 size-4 shrink-0 opacity-40" />Calidad: {p.profiles.map((x) => PROFILE_LABEL[x] ?? x).join(' · ')}</li>
              </ul>
              <Button className="mt-5 w-full" variant={p.highlight ? 'primary' : 'secondary'} disabled={isCur || cur.unlimited} loading={req.isPending && req.variables === p.id}
                onClick={() => req.mutate(p.id)}>
                {isCur ? 'Tu plan actual' : cur.unlimited ? 'Incluido en tu cuenta' : p.priceMonthly === 0 ? 'Cambiar a Gratis' : (p.checkout[yearly ? 'yearly' : 'monthly'] ? 'Contratar' : 'Solicitar')}
              </Button>
            </div>
          );
        })}
      </div>
      <p className="mt-4 text-xs text-ink-500">Precios con IVA no incluido. Al contratar se abre la pasarela de pago segura; el plan se activa al confirmarse el pago. Puedes cancelar cuando quieras.</p>
    </>
  );
}

function Meter({ label, value, max, fmt }: { label: string; value: number; max: number; fmt: (n: number) => string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2 text-sm"><span className="text-ink-500">{label}</span><span className="font-medium tabular-nums">{fmt(value)} / {fmt(max)}</span></div>
      <div className="mt-2"><Progress value={pct} tone={pct > 85 ? 'warn' : 'air'} /></div>
    </div>
  );
}
