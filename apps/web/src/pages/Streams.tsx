import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Play, Plus, Radio, RotateCw, Square, Trash2 } from 'lucide-react';
import { ENCODING_PROFILES, type ProfileId, isActive, type StreamStatus } from '@dni/shared';
import { type Stream, type StreamEvent, api, fmtBytes, fmtTime, get } from '../api';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, PageHeader, Skeleton, StatusBadge, cx, errMsg, inputCls, toast } from '../ui';
import { useMe } from '../App';
import { usePlaylists } from './Playlists';
import { useDestinations } from './Destinations';

const MODES = { loop: 'Bucle continuo (24/7)', shuffle: 'Aleatorio sin repetir hasta completar', once: 'Una sola pasada y terminar' };
const active = (s: Stream) => s.desiredState === 'running' || isActive(s.status as StreamStatus);

function Uptime({ since }: { since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  if (!since) return <>—</>;
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000)), d = Math.floor(s / 86400);
  const hms = [Math.floor((s % 86400) / 3600), Math.floor((s % 3600) / 60), s % 60].map((x) => String(x).padStart(2, '0')).join(':');
  return <span className="font-mono tabular-nums">{d ? `${d} d ` : ''}{hms}</span>;
}

function useStreamActions(id: string) {
  const qc = useQueryClient();
  const done = (s: Stream) => { qc.setQueryData(['stream', id], s); void qc.invalidateQueries({ queryKey: ['streams'] }); };
  const mk = (action: string) => useMutation({ mutationFn: () => api<Stream>('POST', `/v1/streams/${id}/${action}`), onSuccess: done, onError: (e) => toast(errMsg(e), 'error') });
  return { start: mk('start'), stop: mk('stop'), restart: mk('restart') };
}

function Controls({ s }: { s: Stream }) {
  const a = useStreamActions(s.id);
  if (!active(s)) return <Button variant="primary" loading={a.start.isPending} onClick={() => a.start.mutate()}><Play className="size-4" />Iniciar emisión</Button>;
  return (
    <>
      <ConfirmButton label="Reiniciar" icon={<RotateCw className="size-4" />} title="Reiniciar emisión" variant="primary" confirmLabel="Reiniciar"
        message="La señal se cortará unos segundos en todos los destinos mientras el motor vuelve a arrancar." onConfirm={() => a.restart.mutateAsync()} />
      <ConfirmButton label="Detener" buttonVariant="danger" icon={<Square className="size-4" />} title="Detener emisión" confirmLabel="Detener emisión"
        message="Se dejará de enviar señal a todos los destinos. Algunas plataformas dan el directo por finalizado al cortar la señal." onConfirm={() => a.stop.mutateAsync()} />
    </>
  );
}

export function Streams() {
  const q = useQuery<{ items: Stream[] }>({ queryKey: ['streams'], queryFn: () => get('/v1/streams'), refetchInterval: 3000 });
  return (
    <>
      <PageHeader title="Emisiones" description="El estado mostrado lo informa el motor de emisión cada pocos segundos."
        actions={<Link to="/app/streams/new"><Button variant="primary"><Plus className="size-4" />Nueva emisión</Button></Link>} />
      {q.isLoading ? <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-28" />)}</div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data!.items.length === 0 ? <EmptyState icon={<Radio />} title="Todavía no hay emisiones" action={<Link to="/app/streams/new"><Button variant="primary">Crear emisión</Button></Link>}>Una emisión une una playlist publicada con uno o varios destinos.</EmptyState>
        : (
          <ul className="space-y-3">
            {q.data!.items.map((s) => (
              <li key={s.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4">
                  <Link to={`/app/streams/${s.id}`} className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{s.name} <StatusBadge status={s.status} /></p>
                    <p className="mt-1 truncate text-sm text-ink-500">
                      {s.nowPlaying ? <>Ahora: {s.nowPlaying.title} · </> : null}{s.playlistName ?? 'Sin playlist'} · {ENCODING_PROFILES[s.profile as ProfileId]?.label ?? s.profile} · {s.destinations.length} destino(s)
                    </p>
                    {s.statusReason && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{s.statusReason}</p>}
                  </Link>
                  <div className="flex gap-2"><Controls s={s} /></div>
                </Card>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}

export function StreamNew() {
  const nav = useNavigate();
  const me = useMe();
  const pls = usePlaylists();
  const dests = useDestinations();
  const [sel, setSel] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const limits = me.data?.current.limits;
  const create = useMutation({ mutationFn: (b: unknown) => api<Stream>('POST', '/v1/streams', b), onSuccess: (s) => nav(`/app/streams/${s.id}`), onError: (e) => setError(errMsg(e)) });
  if (pls.isLoading || dests.isLoading || !limits) return <Skeleton className="h-96" />;
  if (pls.error || dests.error) return <ErrorState error={pls.error ?? dests.error} />;
  const published = pls.data!.items.filter((p) => p.published);
  const missing = [!published.length && { text: 'Publica una playlist con al menos un vídeo procesado.', to: '/app/playlists', cta: 'Ir a playlists' }, !dests.data!.items.length && { text: 'Añade al menos un destino RTMP(S).', to: '/app/destinations', cta: 'Añadir destino' }].filter(Boolean) as { text: string; to: string; cta: string }[];
  return (
    <>
      <Link to="/app/streams" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800 dark:hover:text-ink-200"><ArrowLeft className="size-4" />Emisiones</Link>
      <PageHeader title="Nueva emisión" description="Contenido, calidad y destinos. Podrás revisarlo todo antes de iniciar." />
      {missing.length > 0 && (
        <Card className="mb-6 border-amber-200 bg-amber-50 dark:bg-amber-950/30">
          <p className="flex items-center gap-2 font-medium text-amber-900 dark:text-amber-200"><AlertTriangle className="size-4" />Antes de crear una emisión</p>
          <ul className="mt-3 space-y-2">{missing.map((m) => <li key={m.to} className="flex flex-wrap items-center justify-between gap-2 text-sm"><span>{m.text}</span><Link to={m.to}><Button className="h-8">{m.cta}</Button></Link></li>)}</ul>
        </Card>
      )}
      <form className="grid gap-6 lg:grid-cols-3" onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault(); setError(null);
        const f = new FormData(e.currentTarget);
        create.mutate({ name: f.get('name'), playlistId: f.get('playlistId'), mode: f.get('mode'), profile: f.get('profile'), destinationIds: sel });
      }}>
        <Card className="space-y-5 lg:col-span-2">
          <fieldset className="space-y-4"><legend className="mb-2 font-semibold">1 · Contenido</legend>
            <Field label="Nombre de la emisión">{(id) => <Input id={id} name="name" required maxLength={120} placeholder="Canal 24/7" />}</Field>
            <Field label="Playlist" hint="Solo aparecen las playlists con una versión publicada.">{(id) => (
              <select id={id} name="playlistId" required className={inputCls} disabled={!published.length}>
                {published.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.published!.itemCount} vídeos)</option>)}
              </select>
            )}</Field>
            <Field label="Modo de reproducción">{(id) => <select id={id} name="mode" className={inputCls}>{Object.entries(MODES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
          </fieldset>
          <fieldset className="space-y-4"><legend className="mb-2 font-semibold">2 · Calidad</legend>
            <Field label="Perfil de emisión" hint="16:9 · H.264 + AAC 48 kHz · fotograma clave cada 2 s. El formato vertical 9:16 llegará más adelante.">{(id) => (
              <select id={id} name="profile" className={inputCls}>
                {Object.entries(ENCODING_PROFILES).map(([k, v]) => <option key={k} value={k} disabled={!limits.profiles.includes(k as ProfileId)}>{v.label} · {v.videoKbps / 1000} Mb/s{limits.profiles.includes(k as ProfileId) ? '' : ' (no incluido en tu plan)'}</option>)}
              </select>
            )}</Field>
          </fieldset>
          <fieldset><legend className="mb-2 font-semibold">3 · Destinos <span className="font-normal text-ink-500">(hasta {limits.maxDestinationsPerStream} a la vez)</span></legend>
            <ul className="space-y-2">
              {dests.data!.items.map((d) => {
                const checked = sel.includes(d.id), full = !checked && sel.length >= limits.maxDestinationsPerStream;
                return (
                  <li key={d.id}>
                    <label className={cx('flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1 ring-ink-200 dark:ring-ink-800', full ? 'opacity-50' : 'cursor-pointer hover:bg-ink-50 dark:hover:bg-ink-800/50')}>
                      <input type="checkbox" checked={checked} disabled={full} onChange={() => setSel((x) => (checked ? x.filter((i) => i !== d.id) : [...x, d.id]))} />
                      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{d.name}</span><span className="block truncate font-mono text-xs text-ink-500">{d.url}</span></span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>
        </Card>
        <Card className="h-fit space-y-4">
          <h2 className="font-semibold">Antes de emitir</h2>
          <ul className="list-disc space-y-2 pl-5 text-sm text-ink-600 dark:text-ink-300">
            <li>Emite solo contenido del que tengas los derechos.</li>
            <li>YouTube puede no archivar directos de más de 12 horas y considera problemático el contenido repetitivo.</li>
            <li>{limits.unlimited ? 'Sin límite de horas ni de emisiones: el canal sigue en el aire hasta que lo detengas.' : `El consumo se mide en horas reales de emisión: tu plan incluye ${limits.monthlyStreamHours} h al mes.`}</li>
          </ul>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{error}</p>}
          <Button variant="primary" type="submit" className="w-full" loading={create.isPending} disabled={missing.length > 0 || sel.length === 0}>Crear emisión</Button>
          <p className="text-xs text-ink-500">Crear no inicia la señal: podrás revisarla y pulsar «Iniciar emisión».</p>
        </Card>
      </form>
    </>
  );
}

export function StreamDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [level, setLevel] = useState<'all' | 'warn'>('all');
  const q = useQuery<Stream>({ queryKey: ['stream', id], queryFn: () => get(`/v1/streams/${id}`), refetchInterval: 2000 });
  const ev = useQuery<{ items: StreamEvent[] }>({ queryKey: ['stream-events', id], queryFn: () => get(`/v1/streams/${id}/events?limit=100`), refetchInterval: 3000 });
  const del = useMutation({ mutationFn: () => api('DELETE', `/v1/streams/${id}`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['streams'] }); nav('/app/streams'); } });
  if (q.isLoading) return <div className="space-y-4"><Skeleton className="h-10 w-72" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const s = q.data;
  const on = active(s);
  const events = (ev.data?.items ?? []).filter((e) => level === 'all' || e.level !== 'info');
  return (
    <>
      <Link to="/app/streams" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800 dark:hover:text-ink-200"><ArrowLeft className="size-4" />Emisiones</Link>
      <PageHeader title={s.name} description={<span className="flex flex-wrap items-center gap-2"><StatusBadge status={s.status} />{s.playlistName} · {MODES[s.mode]} · {ENCODING_PROFILES[s.profile as ProfileId]?.label}</span>}
        actions={<>
          <Controls s={s} />
          {!on && <ConfirmButton label={<span className="sr-only">Borrar emisión</span>} icon={<Trash2 className="size-4" />} title="Borrar emisión" confirmLabel="Borrar" message="Se borrará la configuración de esta emisión. La playlist y los destinos no se borran." onConfirm={() => del.mutateAsync()} />}
        </>} />

      {s.statusReason && (
        <div role="status" className={cx('mb-5 flex items-start gap-2 rounded-xl px-4 py-3 text-sm', s.status === 'failed' ? 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-200' : 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200')}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />{s.statusReason}
        </div>
      )}
      {s.status === 'starting' && !s.engine.online && <div role="status" className="mb-5 rounded-xl bg-sky-50 px-4 py-3 text-sm text-sky-900 dark:bg-sky-950/40 dark:text-sky-200">Esperando a que un nodo de emisión quede libre y asuma el canal…</div>}

      <div className="grid gap-4 sm:grid-cols-3">
        <Card><p className="text-sm text-ink-500">Tiempo en el aire</p><p className="mt-2 text-2xl font-semibold">{on ? <Uptime since={s.startedAt} /> : '—'}</p><p className="mt-1 text-xs text-ink-500">{s.engine.online ? 'Motor conectado' : on ? 'Motor sin contacto' : 'Emisión detenida'}</p></Card>
        <Card className="sm:col-span-2">
          <p className="text-sm text-ink-500">Ahora suena</p>
          <p className="mt-2 truncate text-lg font-semibold">{s.nowPlaying?.title ?? '—'}</p>
          <p className="mt-1 text-xs text-ink-500">
            {s.nowPlaying ? `Vuelta ${s.nowPlaying.cycle + 1} · posición ${s.nowPlaying.position + 1}` : 'Sin reproducción en curso'}
            {s.metrics ? ` · ${s.metrics.itemsPlayed} vídeos emitidos · ${fmtBytes(s.metrics.feederBytes)} generados` : ''}
          </p>
          {s.pendingPlaylistChange && <p className="mt-2"><Badge tone="info" dot>Nueva versión de playlist en espera: entrará al terminar este vídeo</Badge></p>}
        </Card>
      </div>

      <Card className="mt-6">
        <h2 className="font-semibold">Destinos</h2>
        <p className="mt-1 text-xs text-ink-500">Cada destino tiene su propia conexión. Un destino solo aparece «En directo» cuando su salida avanza de verdad.</p>
        <ul className="mt-4 divide-y divide-ink-100 dark:divide-ink-800">
          {s.destinations.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{d.name}</p>
                <p className="truncate font-mono text-xs text-ink-500">{d.url} · clave {d.streamKeyMasked}</p>
                {d.lastError && d.state !== 'live' && on && <p className="mt-1 break-words text-xs text-amber-700 dark:text-amber-300">{d.lastError}</p>}
              </div>
              <div className="flex items-center gap-4 text-xs text-ink-500">
                <span className="font-mono">{d.bitrateKbps ? `${Math.round(d.bitrateKbps).toLocaleString('es-ES')} kb/s` : '— kb/s'}</span>
                <span>{d.restarts} reconexión(es)</span>
                <StatusBadge status={d.state} />
              </div>
            </li>
          ))}
          {s.destinations.length === 0 && <li className="py-3 text-sm text-ink-500">Esta emisión no tiene destinos.</li>}
        </ul>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold">Registro de eventos</h2>
            <select aria-label="Filtrar eventos" className={cx(inputCls, '!h-8 !w-52 shrink-0 py-0 text-xs')} value={level} onChange={(e) => setLevel(e.target.value as 'all' | 'warn')}>
              <option value="all">Todos</option><option value="warn">Solo avisos y errores</option>
            </select>
          </div>
          {ev.isLoading ? <Skeleton className="mt-4 h-32" /> : events.length === 0 ? <p className="mt-4 text-sm text-ink-500">Sin eventos todavía.</p> : (
            <ol className="mt-3 max-h-96 space-y-1 overflow-y-auto pr-1 text-sm">
              {events.map((e) => (
                <li key={e.id} className="flex gap-3 rounded-lg px-2 py-1.5 odd:bg-ink-50 dark:odd:bg-ink-800/40">
                  <time className="shrink-0 font-mono text-xs text-ink-500" dateTime={new Date(e.at).toISOString()}>{fmtTime(e.at)}</time>
                  <span className={cx('min-w-0 break-words', e.level === 'error' && 'text-red-700 dark:text-red-300', e.level === 'warn' && 'text-amber-700 dark:text-amber-300')}>{e.message}</span>
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card>
          <h2 className="font-semibold">Vista previa</h2>
          <div className="mt-3 flex aspect-video items-center justify-center rounded-xl bg-ink-100 text-center text-sm text-ink-500 dark:bg-ink-800">Próximamente</div>
          <p className="mt-3 text-xs text-ink-500">La vista previa en vídeo aún no está disponible. No mostramos una imagen fija como si fuera el directo: comprueba la señal en la plataforma de destino.</p>
        </Card>
      </div>
    </>
  );
}
