import { type FormEvent, type ReactNode, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, ArrowLeft, Ban, BarChart3, Check, Cpu, Crown, Euro, Eye, Film, Gem, Globe2, HardDrive, LayoutDashboard, LogIn, LogOut, MapPin, Radio, RefreshCw, RotateCw, ScrollText, Search, Settings2,
  ShieldAlert, Smartphone, Square, Trash2, UserCheck, UserPlus, Users, X, Zap,
} from 'lucide-react';
import { PLANS, PUBLIC_PLANS } from '@dni/shared';
import { AreaChart, BarList, CountUp, StatTile, countryName, flag } from '../components/Charts';
import { api, fmtBytes, fmtTime, get } from '../api';
import { GoogleIcon, Logo, ThemeToggle } from '../brand';
import { useMe, useTitle } from '../hooks';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Skeleton, StatusBadge, cx, errMsg, inputCls, toast } from '../ui';

const TABS = [
  { to: '', label: 'Resumen', icon: LayoutDashboard },
  { to: 'analytics', label: 'Analítica', icon: BarChart3 },
  { to: 'users', label: 'Usuarios', icon: Users },
  { to: 'plans', label: 'Planes', icon: Gem },
  { to: 'streams', label: 'Emisiones', icon: Radio },
  { to: 'media', label: 'Vídeos', icon: Film },
  { to: 'nodes', label: 'Servidores', icon: Cpu },
  { to: 'events', label: 'Eventos', icon: Activity },
  { to: 'audit', label: 'Auditoría', icon: ScrollText },
  { to: 'settings', label: 'Ajustes', icon: Settings2 },
];

const ago = (ms: number | null | undefined) => {
  if (!ms) return 'nunca';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : s < 86400 ? `hace ${Math.round(s / 3600)} h` : `hace ${Math.round(s / 86400)} d`;
};

function Stat({ label, value, sub, icon: Icon, tone }: { label: string; value: ReactNode; sub?: ReactNode; icon: typeof Zap; tone?: 'live' | 'warn' }) {
  return (
    <Card className="relative overflow-hidden">
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm text-ink-500">{label}</p>
        <span className={cx('flex size-9 items-center justify-center rounded-xl', tone === 'live' ? 'bg-red-500/10 text-red-500' : tone === 'warn' ? 'bg-amber-500/10 text-amber-500' : 'bg-ink-100 text-ink-600 dark:bg-white/[0.06] dark:text-ink-300')}><Icon className="size-[18px]" /></span>
      </div>
      <p className="mt-2 text-3xl font-bold tracking-tight tabular-nums">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-500">{sub}</p>}
    </Card>
  );
}

function Bars({ data, label, unit = '' }: { data: { day: number; value: number }[]; label: string; unit?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const total = data.reduce((s, d) => s + d.value, 0);
  return (
    <Card>
      <div className="flex items-baseline justify-between"><h3 className="font-semibold">{label}</h3><span className="text-sm text-ink-500">{unit === 'h' ? total.toFixed(1) : total} {unit} en 14 días</span></div>
      <div className="mt-5 flex h-36 items-end gap-1.5" role="img" aria-label={`${label}: ${data.map((d) => d.value.toFixed(unit === 'h' ? 1 : 0)).join(', ')}`}>
        {data.map((d) => (
          <div key={d.day} className="group relative flex h-full flex-1 flex-col justify-end">
            <div className="bg-signal min-h-[3px] rounded-t-md opacity-85 transition-opacity group-hover:opacity-100" style={{ height: `${(d.value / max) * 100}%` }} />
            <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-ink-900 px-2 py-1 text-[11px] text-white group-hover:block dark:bg-white dark:text-ink-900">
              {new Date(d.day).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}: {d.value.toFixed(unit === 'h' ? 1 : 0)}{unit}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-2 flex justify-between text-[11px] text-ink-500"><span>{new Date(data[0]?.day ?? 0).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })}</span><span>Hoy</span></div>
    </Card>
  );
}

function OverviewTab() {
  const q = useQuery<any>({ queryKey: ['admin', 'stats'], queryFn: () => get('/v1/admin/stats'), refetchInterval: 15_000 });
  if (q.isLoading) return <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const { totals: t, streamsByStatus: s, series, recentUsers, nodes } = q.data;
  const live = (s.live ?? 0) + (s.degraded ?? 0);
  const issues = (s.degraded ?? 0) + (s.recovering ?? 0) + (s.failed ?? 0);
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="En directo ahora" value={live} icon={Radio} tone={live ? 'live' : undefined} sub={issues ? <span className="text-amber-500">{issues} con incidencias</span> : 'Sin incidencias'} />
        <Stat label="Usuarios" value={t.users} icon={Users} sub={`+${t.users7d} esta semana · ${t.active24h} activos hoy`} />
        <Stat label="Horas emitidas (mes)" value={(t.liveSecondsMonth / 3600).toFixed(1)} icon={Zap} sub={`${(t.liveSecondsTotal / 3600).toFixed(0)} h en total`} />
        <Stat label="Tráfico de salida (mes)" value={fmtBytes(t.egressBytesMonth)} icon={Activity} sub="Datos enviados a los destinos" />
        <Stat label="Almacenamiento" value={fmtBytes(t.storageBytes)} icon={HardDrive} sub={`${t.media} archivos`} />
        <Stat label="Vídeos en proceso" value={t.mediaPending} icon={Film} tone={t.mediaFailed ? 'warn' : undefined} sub={`${t.mediaFailed} con error`} />
        <Stat label="Servidores activos" value={nodes.length} icon={Cpu} sub={nodes.map((n: any) => `${n.id}: ${n.running}/${n.capacity}`).join(' · ') || 'Ninguno (se encienden solos)'} />
        <Stat label="Errores (24 h)" value={t.errors24h} icon={ShieldAlert} tone={t.errors24h ? 'warn' : undefined} sub={`${t.destinations} destinos · ${t.youtubeChannels} canales de YouTube`} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Bars data={series.signups} label="Nuevos usuarios" />
        <Bars data={series.liveHours} label="Horas emitidas" unit="h" />
      </div>
      <Card>
        <h3 className="font-semibold">Últimos registros</h3>
        <ul className="mt-3 divide-y divide-ink-100 dark:divide-white/[0.06]">
          {recentUsers.map((u: any) => (
            <li key={u.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
              <span className="min-w-0"><span className="block truncate font-medium">{u.name}</span><span className="block truncate text-xs text-ink-500">{u.email}</span></span>
              <span className="flex shrink-0 items-center gap-2 text-xs text-ink-500">{u.google ? <GoogleIcon className="size-3.5" /> : null}{ago(u.createdAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

const DEVICE: Record<string, string> = { 'móvil': 'Móvil', ordenador: 'Ordenador', tablet: 'Tableta', bot: 'Bot' };
const PLAN_OPTIONS: [string, string][] = [['founder', 'Fundador (sin límites)'], ...PUBLIC_PLANS.map((p) => [p.id, `${p.label} · ${p.priceMonthly} €`] as [string, string]), ['restricted', 'Restringido']];
const METHOD: Record<string, string> = { password: 'Contraseña', google: 'Google', registro: 'Registro' };

/** Analítica del propietario: visitas de la web, de dónde entra la gente, altas, planes e ingresos y audiencia. */
function AnalyticsTab() {
  const [days, setDays] = useState(30);
  const q = useQuery<any>({ queryKey: ['admin', 'analytics', days], queryFn: () => get(`/v1/admin/analytics?days=${days}`), refetchInterval: 60_000 });
  if (q.isLoading) return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)}</div><Skeleton className="h-64" /></div>;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const a = q.data;
  const signups = a.signups.reduce((x: number, s: any) => x + s.value, 0);
  const paying = a.plans.filter((p: any) => p.priceMonthly > 0).reduce((x: number, p: any) => x + p.organizations, 0);
  const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-500">Visitas sin cookies ni IP (solo país, dispositivo y procedencia). Ubicación de accesos según Cloudflare.</p>
        <div role="tablist" aria-label="Periodo" className="flex rounded-xl bg-ink-100 p-1 text-sm dark:bg-white/[0.05]">
          {[7, 30, 90, 365].map((d) => (
            <button key={d} role="tab" aria-selected={days === d} onClick={() => setDays(d)} className={cx('rounded-lg px-3 py-1 font-medium', days === d ? 'bg-white shadow-sm dark:bg-white/10' : 'text-ink-500')}>{d === 365 ? '1 año' : `${d} d`}</button>
          ))}
        </div>
      </div>
      <div className="stagger grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Visitas a la web" icon={<Eye className="size-4" />} value={<CountUp value={a.visits.total} />} hint={`últimos ${days} días`} />
        <StatTile label="Altas nuevas" icon={<UserPlus className="size-4" />} value={<CountUp value={signups} />} hint={a.visits.total ? `${((signups / a.visits.total) * 100).toFixed(1)} % de conversión` : '—'} />
        <StatTile label="Ingresos mensuales (estimados)" icon={<Euro className="size-4" />} value={<><CountUp value={a.mrrEstimate} /> €</>} hint={`${paying} cuenta(s) de pago · precio mensual de lista`} />
        <StatTile label="Espectadores ahora" tone={a.audience.viewersNow ? 'live' : undefined} icon={<Users className="size-4" />} value={<CountUp value={a.audience.viewersNow} />}
          hint={`${a.audience.liveStreams} emisión(es) en directo · ${a.audience.streamsMeasured} medidas en YouTube`} />
      </div>
      <Card>
        <h3 className="font-semibold">Visitas por día</h3>
        <div className="mt-4"><AreaChart label="Visitas por día" points={a.visits.byDay.map((v: any) => ({ at: dayMs(v.day), value: v.views }))} timeFmt={(ms) => new Date(ms).toLocaleDateString('es-ES', { day: '2-digit', month: 'short' })} /></div>
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <h3 className="flex items-center gap-2 font-semibold"><Globe2 className="size-4" />Visitas por país</h3>
          <div className="mt-3"><BarList rows={a.visits.countries.map((c: any) => ({ key: c.country, label: <>{flag(c.country)} {countryName(c.country)}</>, value: c.views }))} /></div>
        </Card>
        <Card>
          <h3 className="flex items-center gap-2 font-semibold"><LogIn className="size-4" />Usuarios que entran, por país</h3>
          <div className="mt-3"><BarList rows={a.logins.countries.map((c: any) => ({ key: c.country, label: <>{flag(c.country)} {countryName(c.country)}</>, value: c.users }))} /></div>
        </Card>
        <Card>
          <h3 className="font-semibold">Procedencia</h3>
          <div className="mt-3"><BarList rows={a.visits.referrers.map((r: any) => ({ key: r.referrer, label: r.referrer === 'directo' ? 'Directo / sin referente' : r.referrer, value: r.views }))} /></div>
        </Card>
        <Card>
          <h3 className="flex items-center gap-2 font-semibold"><Smartphone className="size-4" />Dispositivos</h3>
          <div className="mt-3"><BarList rows={a.visits.devices.map((d: any) => ({ key: d.device, label: DEVICE[d.device] ?? d.device, value: d.views }))} /></div>
        </Card>
        <Card>
          <h3 className="font-semibold">Páginas más vistas</h3>
          <div className="mt-3"><BarList rows={a.visits.paths.map((p: any) => ({ key: p.path, label: <span className="font-mono text-xs">{p.path}</span>, value: p.views }))} /></div>
        </Card>
        <Card>
          <h3 className="flex items-center gap-2 font-semibold"><Gem className="size-4" />Cuentas por plan</h3>
          <div className="mt-3"><BarList rows={a.plans.map((p: any) => ({ key: p.plan, label: p.label, value: p.organizations }))} /></div>
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h3 className="font-semibold">Últimos accesos</h3>
          {a.logins.recent.length === 0 ? <p className="mt-3 text-sm text-ink-500">Aún no hay accesos registrados.</p> : (
            <ul className="mt-3 divide-y divide-ink-100 text-sm dark:divide-white/[0.06]">
              {a.logins.recent.map((l: any, i: number) => (
                <li key={i} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0"><p className="truncate">{l.email}</p><p className="text-xs text-ink-500">{flag(l.country)} {[l.city, l.region, countryName(l.country)].filter(Boolean).join(', ')} · {DEVICE[l.device] ?? l.device ?? '—'} · {METHOD[l.method] ?? l.method}</p></div>
                  <span className="shrink-0 text-xs text-ink-500">{ago(l.at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card>
          <h3 className="font-semibold">Emisiones con más audiencia (pico)</h3>
          {a.audience.top.length === 0 ? <p className="mt-3 text-sm text-ink-500">Aparecerán cuando haya directos en YouTube con el canal conectado.</p>
            : <div className="mt-3"><BarList rows={a.audience.top.map((t: any) => ({ key: t.id, label: <>{t.name} <span className="text-ink-500">· {t.organization}</span></>, value: t.peak }))} /></div>}
        </Card>
      </div>
    </div>
  );
}

/** Solicitudes de cambio de plan: aprobar al confirmar el pago, o rechazar. */
function PlansTab() {
  const qc = useQueryClient();
  const q = useQuery<{ items: any[] }>({ queryKey: ['admin', 'plan-requests'], queryFn: () => get('/v1/admin/plan-requests'), refetchInterval: 30_000 });
  const act = async (id: string, action: 'approve' | 'reject') => {
    try { await api('POST', `/v1/admin/plan-requests/${id}/${action}`); toast(action === 'approve' ? 'Plan activado' : 'Solicitud rechazada'); await qc.invalidateQueries({ queryKey: ['admin'] }); }
    catch (e) { toast(errMsg(e), 'error'); }
  };
  const label = (id: string) => PUBLIC_PLANS.find((p) => p.id === id)?.label ?? id;
  return (
    <div className="space-y-6">
      <div className="stagger grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {PUBLIC_PLANS.map((p) => (
          <div key={p.id} className="glass-card rounded-2xl p-5">
            <p className="font-semibold">{p.label}</p>
            <p className="mt-1 text-2xl font-semibold">{p.priceMonthly} €<span className="text-sm font-normal text-ink-500"> /mes</span></p>
            <p className="mt-2 text-xs text-ink-500">{p.maxConcurrentStreams} emisión(es) · {p.maxDestinationsPerStream} destinos · {fmtBytes(p.storageBytes)} · {p.monthlyStreamHours} h/mes</p>
          </div>
        ))}
      </div>
      <Card>
        <h3 className="font-semibold">Solicitudes de plan</h3>
        <p className="mt-1 text-sm text-ink-500">Cuando el cliente paga con tu enlace, actívale el plan aquí. También puedes cambiar el plan de cualquier cuenta en «Usuarios».</p>
        {q.isLoading ? <Skeleton className="mt-4 h-32" /> : q.error ? <ErrorState error={q.error} /> : q.data!.items.length === 0 ? <p className="mt-4 text-sm text-ink-500">No hay solicitudes todavía.</p> : (
          <ul className="mt-4 divide-y divide-ink-100 dark:divide-white/[0.06]">
            {q.data!.items.map((r) => (
              <li key={r.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 text-sm">
                  <p className="font-medium">{r.organization} · {label(r.currentPlan)} → <strong>{label(r.plan)}</strong> ({r.billing === 'yearly' ? 'anual' : 'mensual'})</p>
                  <p className="truncate text-xs text-ink-500">{r.email} · {fmtTime(r.createdAt)} · ref. <span className="font-mono">{r.organizationId}</span></p>
                </div>
                {r.status === 'pending' ? (
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => void act(r.id, 'approve')}><Check className="size-4" />Activar plan</Button>
                    <Button variant="ghost" onClick={() => void act(r.id, 'reject')}><X className="size-4" />Rechazar</Button>
                  </div>
                ) : <Badge tone={r.status === 'approved' ? 'ok' : 'muted'}>{r.status === 'approved' ? 'Activado' : 'Rechazada'}</Badge>}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const me = useMe();
  const [q, setQ] = useState('');
  const list = useQuery<{ items: any[] }>({ queryKey: ['admin', 'users', q], queryFn: () => get(`/v1/admin/users?q=${encodeURIComponent(q)}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['admin'] });
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); await refresh(); } catch (e) { toast(errMsg(e), 'error'); } };
  return (
    <div className="space-y-4">
      <div className="relative max-w-md"><Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-400" /><Input placeholder="Buscar por nombre o email" value={q} onChange={(e) => setQ(e.target.value)} className="pl-10" /></div>
      {list.isLoading ? <Skeleton className="h-64" /> : list.error ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? <EmptyState icon={<Users />} title="Sin resultados" /> : (
        <div className="space-y-3">
          {list.data!.items.map((u) => (
            <Card key={u.id} className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">{u.name}
                  {u.superadmin ? <Badge tone="warn"><Crown className="size-3" />Propietario</Badge> : null}
                  {u.disabledAt ? <Badge tone="error">Desactivado</Badge> : null}
                  {u.live ? <Badge tone="live" dot>{u.live} en directo</Badge> : null}
                </p>
                <p className="mt-0.5 truncate text-sm text-ink-500">{u.email} · {u.organization}</p>
                {u.lastPlace && u.lastPlace !== '||' && (() => { const [cc, city, dev] = String(u.lastPlace).split('|'); return (
                  <p className="mt-1 flex items-center gap-1.5 text-xs text-ink-500"><MapPin className="size-3" />{flag(cc)} {[city, countryName(cc)].filter(Boolean).join(', ')}{dev ? ` · ${DEVICE[dev] ?? dev}` : ''}</p>
                ); })()}
                <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-500">
                  <span>{u.streams} emisiones</span><span>{fmtBytes(u.storageBytes)}</span><span>Acceso: {[u.google && 'Google', u.hasPassword && 'contraseña'].filter(Boolean).join(' + ')}</span><span>Último acceso {ago(u.lastLoginAt)}</span><span>Alta {fmtTime(u.createdAt)}</span>
                </p>
              </div>
              {u.id !== me.data?.user.id && (
                <div className="flex flex-wrap gap-2">
                  {u.organizationId && (
                    <select aria-label={`Plan de ${u.organization}`} className={cx(inputCls, 'h-10 w-auto pr-8')} value={u.plan ?? ''}
                      onChange={(e) => act(() => api('PATCH', `/v1/admin/orgs/${u.organizationId}/plan`, { plan: e.target.value }), 'Plan actualizado')}>
                      {PLAN_OPTIONS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                      {u.plan && !PLAN_OPTIONS.some(([id]) => id === u.plan) && <option value={u.plan}>{PLANS[u.plan]?.label ?? u.plan}</option>}
                    </select>
                  )}
                  {u.disabledAt
                    ? <Button onClick={() => act(() => api('PATCH', `/v1/admin/users/${u.id}`, { disabled: false }), 'Usuario reactivado')}><UserCheck className="size-4" />Reactivar</Button>
                    : <ConfirmButton label="Desactivar" icon={<Ban className="size-4" />} title={`Desactivar a ${u.email}`} confirmLabel="Desactivar" message="Se cerrarán sus sesiones y se detendrán sus emisiones en directo. Podrás reactivarlo después."
                        onConfirm={() => act(() => api('PATCH', `/v1/admin/users/${u.id}`, { disabled: true }), 'Usuario desactivado')} />}
                  <Button variant="ghost" onClick={() => act(() => api('POST', `/v1/admin/users/${u.id}/logout`), 'Sesiones cerradas')}><LogOut className="size-4" />Cerrar sesiones</Button>
                  <ConfirmButton buttonVariant="ghost" label={u.superadmin ? 'Quitar propietario' : 'Hacer propietario'} icon={<Crown className="size-4" />} variant="primary" title={u.superadmin ? 'Quitar acceso de propietario' : 'Dar acceso de propietario'}
                    confirmLabel="Confirmar" message={u.superadmin ? 'Dejará de ver este panel.' : 'Podrá ver y gestionar TODA la plataforma desde este panel, incluidos usuarios y ajustes.'}
                    onConfirm={() => act(() => api('PATCH', `/v1/admin/users/${u.id}`, { superadmin: !u.superadmin }), 'Permisos actualizados')} />
                  <ConfirmButton buttonVariant="ghost" label={<span className="sr-only">Borrar usuario</span>} icon={<Trash2 className="size-4 text-red-500" />} title={`Borrar ${u.email}`} confirmLabel="Borrar definitivamente"
                    message={<>Se borrarán <strong>definitivamente</strong> la cuenta, su canal, sus emisiones, destinos y <strong>todos sus archivos</strong>. No se puede deshacer.</>}
                    onConfirm={() => act(() => api('DELETE', `/v1/admin/users/${u.id}`), 'Usuario borrado')} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StreamsTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('active');
  const list = useQuery<{ items: any[] }>({ queryKey: ['admin', 'streams', filter], queryFn: () => get(`/v1/admin/streams${filter ? `?status=${filter}` : ''}`), refetchInterval: 5000 });
  const act = async (fn: () => Promise<unknown>, msg: string) => { try { await fn(); toast(msg); await qc.invalidateQueries({ queryKey: ['admin'] }); } catch (e) { toast(errMsg(e), 'error'); } };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[['active', 'En marcha'], ['', 'Todas'], ['failed', 'Con error'], ['recovering', 'Recuperando']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k!)} className={cx('rounded-full px-4 py-1.5 text-sm font-semibold ring-1', filter === k ? 'bg-ink-900 text-white ring-ink-900 dark:bg-white dark:text-ink-950' : 'ring-ink-200 dark:ring-white/10')}>{l}</button>
        ))}
      </div>
      {list.isLoading ? <Skeleton className="h-48" /> : list.error ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? <EmptyState icon={<Radio />} title="No hay emisiones en este filtro" /> : (
        <div className="space-y-3">
          {list.data!.items.map((s) => (
            <Card key={s.id} className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-semibold">{s.name}<StatusBadge status={s.status} /></p>
                <p className="mt-0.5 truncate text-sm text-ink-500">{s.organization} · {s.ownerEmail}</p>
                <p className="mt-1 flex flex-wrap gap-x-4 text-xs text-ink-500">
                  <span>{s.destinationsLive}/{s.destinations} destinos en directo</span><span>{s.profile} · {s.mode}</span>
                  {s.node && <span>Servidor {s.node}</span>}{s.startedAt && s.desiredState === 'running' && <span>En el aire desde {fmtTime(s.startedAt)}</span>}
                </p>
                {s.statusReason && <p className="mt-1 text-xs text-amber-600 dark:text-amber-300">{s.statusReason}</p>}
              </div>
              {s.desiredState === 'running' && (
                <div className="flex gap-2">
                  <Button onClick={() => act(() => api('POST', `/v1/admin/streams/${s.id}/restart`), 'Reinicio solicitado')}><RotateCw className="size-4" />Reiniciar</Button>
                  <ConfirmButton label="Detener" icon={<Square className="size-4" />} buttonVariant="danger" title="Detener emisión" confirmLabel="Detener" message={`Se detendrá «${s.name}» de ${s.ownerEmail}.`}
                    onConfirm={() => act(() => api('POST', `/v1/admin/streams/${s.id}/stop`), 'Emisión detenida')} />
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function MediaTab() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState('pending');
  const list = useQuery<{ items: any[] }>({ queryKey: ['admin', 'media', filter], queryFn: () => get(`/v1/admin/media${filter ? `?status=${filter}` : ''}`), refetchInterval: 4000 });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {[['pending', 'En cola / procesando'], ['failed', 'Con error'], ['', 'Todos']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k!)} className={cx('rounded-full px-4 py-1.5 text-sm font-semibold ring-1', filter === k ? 'bg-ink-900 text-white ring-ink-900 dark:bg-white dark:text-ink-950' : 'ring-ink-200 dark:ring-white/10')}>{l}</button>
        ))}
      </div>
      {list.isLoading ? <Skeleton className="h-48" /> : list.error ? <ErrorState error={list.error} /> : list.data!.items.length === 0 ? <EmptyState icon={<Film />} title="Nada pendiente" >Todos los vídeos están procesados.</EmptyState> : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wider text-ink-500"><tr className="border-b border-ink-100 dark:border-white/[0.06]"><th className="px-5 py-3">Archivo</th><th className="px-3 py-3">Estado</th><th className="px-3 py-3">Tamaño</th><th className="px-3 py-3">Canal</th><th className="px-3 py-3">Actualizado</th><th className="px-5 py-3" /></tr></thead>
            <tbody>
              {list.data!.items.map((m) => (
                <tr key={m.id} className="border-b border-ink-100 last:border-0 dark:border-white/[0.04]">
                  <td className="max-w-[16rem] px-5 py-3"><p className="truncate font-medium">{m.filename}</p>{m.error && <p className="truncate text-xs text-red-500" title={m.error}>{m.error}</p>}</td>
                  <td className="px-3 py-3"><StatusBadge status={m.status} />{m.status === 'processing' && <span className="ml-2 text-xs text-ink-500">{m.progress}%</span>}</td>
                  <td className="px-3 py-3 text-ink-500">{fmtBytes(m.sizeBytes)}</td>
                  <td className="px-3 py-3 text-ink-500">{m.organization}</td>
                  <td className="px-3 py-3 text-ink-500">{ago(m.updatedAt)}</td>
                  <td className="px-5 py-3 text-right">{m.status !== 'ready' && m.status !== 'uploading' && <Button className="h-8 px-3" onClick={async () => { try { await api('POST', `/v1/admin/media/${m.id}/retry`); toast('Reencolado'); await qc.invalidateQueries({ queryKey: ['admin'] }); } catch (e) { toast(errMsg(e), 'error'); } }}><RefreshCw className="size-3.5" />Reintentar</Button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

function NodesTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['admin', 'nodes'], queryFn: () => get('/v1/admin/nodes'), refetchInterval: 8000 });
  const action = useMutation({ mutationFn: (a: string) => api('POST', `/v1/admin/nodes/${a}`), onSuccess: () => { toast('Hecho'); return qc.invalidateQueries({ queryKey: ['admin', 'nodes'] }); }, onError: (e) => toast(errMsg(e), 'error') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const cloud = (q.data.cloud as any[]).filter((n, i) => n.running || i < q.data.maxNodes);
  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div><h3 className="font-semibold">Servidores de emisión en Cloudflare</h3><p className="mt-1 text-sm text-ink-500">Se encienden solos cuando hay emisiones o vídeos que procesar y se apagan tras 10 minutos sin trabajo. Máximo actual: {q.data.maxNodes} (cámbialo en Ajustes).</p></div>
          <div className="flex gap-2">
            <Button onClick={() => action.mutate('ensure')} loading={action.isPending && action.variables === 'ensure'}><Zap className="size-4" />Encender</Button>
            <ConfirmButton label="Reiniciar encendidos" icon={<RotateCw className="size-4" />} variant="primary" title="Reiniciar servidores" confirmLabel="Reiniciar" message="Apagado ordenado: las emisiones se reanudan solas en unos segundos, con un corte breve." onConfirm={() => action.mutateAsync('restart')} />
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {cloud.map((n) => (
            <div key={n.name} className="rounded-xl bg-ink-50 p-4 ring-1 ring-ink-100 dark:bg-white/[0.03] dark:ring-white/[0.06]">
              <p className="flex items-center justify-between font-mono text-sm font-semibold">{n.name}{n.running ? <Badge tone="ok" dot>Encendido</Badge> : <Badge>Apagado</Badge>}</p>
              {n.health ? <p className="mt-2 text-xs text-ink-500">{n.health.running}/{n.health.capacity} emisiones · activo {Math.round(n.health.uptimeSec / 60)} min</p> : <p className="mt-2 text-xs text-ink-500">{n.running ? 'Arrancando…' : 'Sin trabajo'}</p>}
              {n.running && n.assetsCurrent === false && <p className="mt-1 text-xs text-amber-600">Versión antigua del motor: reinícialo para actualizar.</p>}
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <h3 className="font-semibold">Informes recientes de los motores</h3>
        <ul className="mt-3 divide-y divide-ink-100 text-sm dark:divide-white/[0.06]">
          {(q.data.reported as any[]).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="font-mono">{r.id}</span>
              <span className="text-xs text-ink-500">{r.version} · {r.running}/{r.capacity} · {ago(r.lastSeenAt)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function EventsTab() {
  const [level, setLevel] = useState('warn');
  const q = useQuery<{ items: any[] }>({ queryKey: ['admin', 'events', level], queryFn: () => get(`/v1/admin/events${level ? `?level=${level}` : ''}`), refetchInterval: 6000 });
  return (
    <div className="space-y-4">
      <select aria-label="Nivel" className={cx(inputCls, 'max-w-xs')} value={level} onChange={(e) => setLevel(e.target.value)}><option value="warn">Avisos y errores</option><option value="error">Solo errores</option><option value="">Todo</option></select>
      {q.isLoading ? <Skeleton className="h-64" /> : q.error ? <ErrorState error={q.error} /> : q.data!.items.length === 0 ? <EmptyState icon={<Activity />} title="Sin eventos" /> : (
        <Card className="p-2">
          <ol className="max-h-[70vh] space-y-0.5 overflow-y-auto">
            {q.data!.items.map((e) => (
              <li key={e.id} className="flex flex-col gap-0.5 rounded-lg px-3 py-2 text-sm odd:bg-ink-50 sm:flex-row sm:gap-3 dark:odd:bg-white/[0.02]">
                <time className="shrink-0 font-mono text-xs text-ink-500">{fmtTime(e.at)}</time>
                <span className={cx('min-w-0 break-words', e.level === 'error' && 'text-red-600 dark:text-red-400', e.level === 'warn' && 'text-amber-600 dark:text-amber-300')}>{e.message} <span className="text-xs text-ink-500">— {e.streamName} · {e.organization}</span></span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function AuditTab() {
  const q = useQuery<{ items: any[] }>({ queryKey: ['admin', 'audit'], queryFn: () => get('/v1/admin/audit') });
  if (q.isLoading) return <Skeleton className="h-64" />;
  if (q.error) return <ErrorState error={q.error} />;
  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-ink-500"><tr className="border-b border-ink-100 dark:border-white/[0.06]"><th className="px-5 py-3">Fecha</th><th className="px-3 py-3">Usuario</th><th className="px-3 py-3">Acción</th><th className="px-3 py-3">Recurso</th><th className="px-5 py-3">IP</th></tr></thead>
        <tbody>
          {q.data!.items.map((l) => (
            <tr key={l.id} className="border-b border-ink-100 last:border-0 dark:border-white/[0.04]">
              <td className="px-5 py-2.5 font-mono text-xs text-ink-500">{fmtTime(l.at)}</td>
              <td className="px-3 py-2.5">{l.actor ?? '—'}</td>
              <td className="px-3 py-2.5"><code className="rounded bg-ink-100 px-1.5 py-0.5 text-xs dark:bg-white/[0.06]">{l.action}</code></td>
              <td className="max-w-[12rem] truncate px-3 py-2.5 font-mono text-xs text-ink-500">{l.target ?? ''}</td>
              <td className="px-5 py-2.5 font-mono text-xs text-ink-500">{l.ip}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function SettingsTab() {
  const qc = useQueryClient();
  const q = useQuery<any>({ queryKey: ['admin', 'settings'], queryFn: () => get('/v1/admin/settings') });
  const [saving, setSaving] = useState<string | null>(null);
  if (q.isLoading) return <Skeleton className="h-96" />;
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const save = async (key: string, body: unknown, msg: string) => {
    setSaving(key);
    try { await api('PUT', '/v1/admin/settings', body); toast(msg); await Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'settings'] }), qc.invalidateQueries({ queryKey: ['auth-config'] })]); }
    catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(null); }
  };
  const copy = (t: string) => { void navigator.clipboard?.writeText(t); toast('Copiado'); };
  return (
    <div className="grid gap-6 xl:grid-cols-2">
      <Card className="xl:col-span-2">
        <h3 className="flex items-center gap-2 font-semibold"><GoogleIcon />Inicio de sesión con Google y conexión de YouTube</h3>
        <p className="mt-1 text-sm text-ink-500">{s.google.configured ? <Badge tone="ok">Activo</Badge> : <Badge tone="warn">Sin configurar</Badge>} El secreto se guarda cifrado y nunca se vuelve a mostrar.</p>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-ink-600 dark:text-ink-300">
          <li>En Google Cloud Console → APIs y servicios → <strong>Credenciales</strong>, abre tu ID de cliente de OAuth (tipo «Aplicación web»).</li>
          <li>En «Orígenes de JavaScript autorizados» añade: <button type="button" onClick={() => copy(s.google.origin)} className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-xs hover:bg-ink-200 dark:bg-white/[0.08]">{s.google.origin}</button></li>
          <li>En «URI de redirección autorizados» añade: <button type="button" onClick={() => copy(s.google.redirectUri)} className="break-all rounded bg-ink-100 px-1.5 py-0.5 text-left font-mono text-xs hover:bg-ink-200 dark:bg-white/[0.08]">{s.google.redirectUri}</button></li>
          <li>Para conectar canales de YouTube: activa <strong>YouTube Data API v3</strong> y añade el ámbito <code className="text-xs">…/auth/youtube</code> en la pantalla de consentimiento.</li>
          <li>Pega aquí el ID y el secreto de cliente y guarda.</li>
        </ol>
        <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
          void save('google', { googleClientId: f.clientId, ...(f.clientSecret ? { googleClientSecret: f.clientSecret } : {}) }, 'Google configurado');
          (e.currentTarget.elements.namedItem('clientSecret') as HTMLInputElement).value = '';
        }}>
          <Field label="ID de cliente">{(id) => <Input id={id} name="clientId" defaultValue={s.google.clientId} placeholder="123…apps.googleusercontent.com" required autoComplete="off" />}</Field>
          <Field label="Secreto de cliente" hint={s.google.configured ? 'Déjalo vacío para mantener el actual.' : undefined}>{(id) => <Input id={id} name="clientSecret" type="password" placeholder={s.google.configured ? '••••••••' : 'GOCSPX-…'} required={!s.google.configured} autoComplete="off" />}</Field>
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button variant="primary" type="submit" loading={saving === 'google'}>Guardar credenciales</Button>
            {s.google.configured && <ConfirmButton label="Desactivar Google" title="Desactivar Google" confirmLabel="Desactivar" message="Los usuarios que solo entran con Google no podrán iniciar sesión hasta que lo reactives." onConfirm={() => save('google', { clearGoogle: true }, 'Google desactivado')} />}
          </div>
        </form>
      </Card>

      <Card>
        <h3 className="font-semibold">Registro de nuevas cuentas</h3>
        <p className="mt-1 text-sm text-ink-500">Con el registro abierto cualquiera puede crear una cuenta y emitir gratis, con coste para tu cuenta de Cloudflare.</p>
        <label className="mt-4 flex cursor-pointer items-center justify-between gap-4 rounded-xl bg-ink-50 px-4 py-3 dark:bg-white/[0.03]">
          <span className="text-sm font-medium">{s.signupsOpen ? 'Registro abierto' : 'Registro cerrado'}</span>
          <input type="checkbox" className="size-5 accent-[#ff4f2e]" checked={s.signupsOpen} disabled={saving === 'signups'} onChange={(e) => save('signups', { signupsOpen: e.target.checked }, e.target.checked ? 'Registro abierto' : 'Registro cerrado')} />
        </label>
      </Card>

      <Card>
        <h3 className="font-semibold">Capacidad de emisión</h3>
        <p className="mt-1 text-sm text-ink-500">Servidores máximos simultáneos (4 emisiones o 2 conversiones de vídeo cada uno). Más servidores = más capacidad y más coste.</p>
        <form className="mt-4 flex items-end gap-3" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void save('nodes', { engineMaxNodes: Number(new FormData(e.currentTarget).get('n')) }, 'Capacidad actualizada'); }}>
          <Field label="Servidores máximos">{(id) => <Input id={id} name="n" type="number" min={1} max={10} defaultValue={s.engineMaxNodes} className="w-28" />}</Field>
          <Button type="submit" loading={saving === 'nodes'}>Guardar</Button>
        </form>
      </Card>

      <Card className="xl:col-span-2">
        <h3 className="flex items-center gap-2 font-semibold"><Euro className="size-4" />Cobro de los planes</h3>
        <p className="mt-1 text-sm text-ink-500">Pega el enlace de pago de cada plan (Stripe Payment Links, Lemon Squeezy, Paddle…). Al contratar, el cliente va a ese enlace con su <code className="text-xs">client_reference_id</code> y la solicitud te aparece en «Planes» para activarla. Sin enlace, queda como solicitud y contactas tú.</p>
        <form className="mt-4 grid gap-4 sm:grid-cols-2" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const links: Record<string, { monthly: string; yearly: string }> = {};
          for (const p of PUBLIC_PLANS.filter((x) => x.priceMonthly > 0)) links[p.id] = { monthly: String(f.get(`${p.id}-m`) ?? '').trim(), yearly: String(f.get(`${p.id}-y`) ?? '').trim() };
          void save('checkout', { checkoutLinks: links }, 'Enlaces de pago guardados');
        }}>
          {PUBLIC_PLANS.filter((x) => x.priceMonthly > 0).map((p) => (
            <fieldset key={p.id} className="rounded-xl bg-ink-50 p-4 dark:bg-white/[0.03]">
              <legend className="sr-only">{p.label}</legend>
              <p className="text-sm font-semibold">{p.label} · {p.priceMonthly} €/mes · {p.priceYearly} €/mes anual</p>
              <div className="mt-3 grid gap-3">
                <Field label="Enlace mensual">{(id) => <Input id={id} name={`${p.id}-m`} type="url" defaultValue={s.checkoutLinks?.[p.id]?.monthly ?? ''} placeholder="https://buy.stripe.com/…" />}</Field>
                <Field label="Enlace anual">{(id) => <Input id={id} name={`${p.id}-y`} type="url" defaultValue={s.checkoutLinks?.[p.id]?.yearly ?? ''} placeholder="https://buy.stripe.com/…" />}</Field>
              </div>
            </fieldset>
          ))}
          <div className="sm:col-span-2"><Button variant="primary" type="submit" loading={saving === 'checkout'}>Guardar enlaces</Button></div>
        </form>
      </Card>

      <Card className="xl:col-span-2">
        <h3 className="font-semibold">Aviso para todos los usuarios</h3>
        <p className="mt-1 text-sm text-ink-500">Se muestra arriba en el panel de todos los usuarios (mantenimiento, novedades…). Déjalo vacío para quitarlo.</p>
        <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void save('ann', { announcement: String(new FormData(e.currentTarget).get('a') ?? '') }, 'Aviso actualizado'); }}>
          <Input name="a" aria-label="Texto del aviso" defaultValue={s.announcement} maxLength={280} placeholder="Ej.: Mantenimiento programado el domingo a las 04:00" />
          <Button type="submit" loading={saving === 'ann'}>Publicar aviso</Button>
        </form>
      </Card>
    </div>
  );
}

export default function Admin() {
  useTitle('Panel del propietario');
  const me = useMe();
  if (me.isLoading) return <div className="p-8"><Skeleton className="h-96" /></div>;
  if (me.error) return <Navigate to="/login" replace state={{ from: '/admin' }} />;
  if (!me.data?.user.superadmin) {
    return <div className="flex min-h-dvh items-center justify-center p-6"><EmptyState icon={<ShieldAlert />} title="Página no encontrada" action={<Link to="/app/overview"><Button>Ir a mi panel</Button></Link>} /></div>;
  }
  return (
    <div className="min-h-dvh">
      <header className="safe-top sticky top-0 z-30 border-b border-ink-200/80 bg-white/85 backdrop-blur-xl dark:border-white/[0.06] dark:bg-ink-950/80">
        <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <Link to="/app/overview" className="rounded-xl p-2 text-ink-500 hover:bg-ink-100 dark:hover:bg-white/[0.06]" aria-label="Volver a mi panel"><ArrowLeft className="size-5" /></Link>
          <Logo compact />
          <span className="flex items-center gap-1.5 text-sm font-bold"><Crown className="size-4 text-amber-glow" />Panel del propietario</span>
          <div className="ml-auto"><ThemeToggle /></div>
        </div>
        <nav aria-label="Secciones del panel" className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-3 pb-2 sm:px-5">
          {TABS.map((t) => (
            <NavLink key={t.to} end={t.to === ''} to={t.to === '' ? '/admin' : `/admin/${t.to}`}
              className={({ isActive }) => cx('flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors', isActive ? 'bg-ink-900 text-white dark:bg-white dark:text-ink-950' : 'text-ink-600 hover:bg-ink-100 dark:text-ink-400 dark:hover:bg-white/[0.06]')}>
              <t.icon className="size-4" />{t.label}
            </NavLink>
          ))}
        </nav>
      </header>
      <main className="page-in mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
        <Routes>
          <Route index element={<OverviewTab />} />
          <Route path="analytics" element={<AnalyticsTab />} />
          <Route path="users" element={<UsersTab />} />
          <Route path="plans" element={<PlansTab />} />
          <Route path="streams" element={<StreamsTab />} />
          <Route path="media" element={<MediaTab />} />
          <Route path="nodes" element={<NodesTab />} />
          <Route path="events" element={<EventsTab />} />
          <Route path="audit" element={<AuditTab />} />
          <Route path="settings" element={<SettingsTab />} />
        </Routes>
      </main>
    </div>
  );
}
