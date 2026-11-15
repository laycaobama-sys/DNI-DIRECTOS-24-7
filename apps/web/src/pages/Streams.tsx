import { type FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ArrowLeft, Clapperboard, Eye, ExternalLink, Heart, ImagePlus, Play, Plus, Radio, RotateCw, Square, Trash2, Users } from 'lucide-react';
import { ENCODING_PROFILES, type ProfileId, isActive, type StreamStatus } from '@dni/shared';
import { type Stream, type StreamEvent, api, fmtBytes, fmtDuration, fmtTime, get } from '../api';
import { LivePreview } from '../components/LivePreview';
import { ThumbnailStudio } from '../components/ThumbnailStudio';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, StatusBadge, cx, errMsg, inputCls, toast } from '../ui';
import { AreaChart, CountUp, fmtNum } from '../components/Charts';
import { useMe, useTitle } from '../hooks';
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
  const done = (s: Stream) => { qc.setQueryData(['stream', id], s); void qc.invalidateQueries({ queryKey: ['streams'] }); void qc.invalidateQueries({ queryKey: ['stream-events', id] }); };
  const start = useMutation({ mutationFn: (youtube: 'auto' | 'new' | 'continue') => api<Stream>('POST', `/v1/streams/${id}/start`, { youtube }), onSuccess: done, onError: (e) => toast(errMsg(e), 'error') });
  const stop = useMutation({ mutationFn: (endYoutube: boolean) => api<Stream>('POST', `/v1/streams/${id}/stop`, { endYoutube }), onSuccess: done, onError: (e) => toast(errMsg(e), 'error') });
  const restart = useMutation({ mutationFn: () => api<Stream>('POST', `/v1/streams/${id}/restart`), onSuccess: done, onError: (e) => toast(errMsg(e), 'error') });
  return { start, stop, restart };
}

interface YtSessionItem { destinationId: string; name: string; managed: boolean; broadcastId?: string; title?: string | null; lifeCycle?: string; reusable?: boolean; watchUrl?: string; error?: string }
const OPEN_LIFE = new Set(['live', 'liveStarting', 'testing', 'testStarting']);

/**
 * Iniciar: si un directo de YouTube anterior terminó, se crea uno nuevo solo. Si sigue abierto (se detuvo sin
 * finalizarlo), se pregunta: continuar en el mismo o crear uno nuevo (recomendado).
 */
function StartButton({ s, a }: { s: Stream; a: ReturnType<typeof useStreamActions> }) {
  const [open, setOpen] = useState<YtSessionItem[] | null>(null);
  const [choice, setChoice] = useState<'new' | 'continue'>('new');
  const [checking, setChecking] = useState(false);
  const managed = s.destinations.some((d) => d.youtube);
  const go = (mode: 'auto' | 'new' | 'continue') => a.start.mutate(mode, {
    onSuccess: () => { setOpen(null); toast(mode === 'continue' ? 'Emisión iniciada en el mismo directo de YouTube' : managed ? 'Emisión iniciada · directo de YouTube preparado' : 'Emisión iniciada'); },
  });
  const click = async () => {
    if (!managed) return go('auto');
    setChecking(true);
    const r = await get<{ items: YtSessionItem[] }>(`/v1/streams/${s.id}/youtube-session`).catch(() => null);
    setChecking(false);
    const items = (r?.items ?? []).filter((i) => i.managed);
    if (!items.some((i) => OPEN_LIFE.has(i.lifeCycle ?? ''))) return go('auto');
    setChoice('new');
    setOpen(items);
  };
  return (
    <>
      <Button variant="primary" className="flex-1 sm:flex-none" loading={a.start.isPending || checking} onClick={() => void click()}><Play className="size-4" />Iniciar emisión</Button>
      <Modal open={!!open} title="¿Nuevo directo o el mismo?" onClose={() => setOpen(null)} footer={<>
        <Button onClick={() => setOpen(null)}>Cancelar</Button>
        <Button variant="primary" loading={a.start.isPending} onClick={() => go(choice)}><Play className="size-4" />Iniciar</Button>
      </>}>
        <p className="text-sm text-ink-600 dark:text-ink-300">El directo anterior de YouTube sigue abierto:</p>
        <ul className="mt-2 space-y-1 text-sm">
          {open?.filter((i) => OPEN_LIFE.has(i.lifeCycle ?? '')).map((i) => (
            <li key={i.destinationId} className="flex items-center gap-2"><span className="live-dot size-2 rounded-full bg-red-500" />
              <span className="min-w-0 truncate">{i.title ?? i.name}</span>
              {i.watchUrl && <a href={i.watchUrl} target="_blank" rel="noreferrer" className="shrink-0 text-air-500 hover:underline"><ExternalLink className="size-3.5" /></a>}
            </li>
          ))}
        </ul>
        <fieldset className="mt-4 space-y-2">
          {([['new', 'Crear un directo nuevo', 'El anterior se finaliza y queda guardado en tu canal. El nuevo usa el mismo título y la misma miniatura.'],
            ['continue', 'Continuar en el mismo directo', 'La señal vuelve al directo que ya estaba abierto (mismo enlace).']] as const).map(([v, t, d]) => (
            <label key={v} className={cx('flex cursor-pointer gap-3 rounded-xl p-3 ring-1', choice === v ? 'bg-air-500/5 ring-air-500' : 'ring-ink-200 dark:ring-white/10')}>
              <input type="radio" name="yt-mode" className="mt-1" checked={choice === v} onChange={() => setChoice(v)} />
              <span><span className="block text-sm font-medium">{t}{v === 'new' && <Badge tone="info">Recomendado</Badge>}</span><span className="block text-xs text-ink-500">{d}</span></span>
            </label>
          ))}
        </fieldset>
      </Modal>
    </>
  );
}

function StopButton({ s, a }: { s: Stream; a: ReturnType<typeof useStreamActions> }) {
  const [open, setOpen] = useState(false);
  const [end, setEnd] = useState(true);
  const managed = s.destinations.some((d) => d.youtube);
  return (
    <>
      <Button variant="danger" className="flex-1 sm:flex-none" onClick={() => { setEnd(true); setOpen(true); }}><Square className="size-4" />Detener</Button>
      <Modal open={open} title="Detener emisión" onClose={() => setOpen(false)} footer={<>
        <Button onClick={() => setOpen(false)}>Cancelar</Button>
        <Button variant="danger" loading={a.stop.isPending} onClick={() => a.stop.mutate(end, { onSuccess: () => { setOpen(false); toast(managed && end ? 'Emisión detenida · directo de YouTube finalizado y guardado' : 'Emisión detenida'); } })}>Detener emisión</Button>
      </>}>
        <p className="text-sm text-ink-600 dark:text-ink-300">Se dejará de enviar señal a todos los destinos.</p>
        {managed && (
          <label className="mt-4 flex cursor-pointer gap-3 rounded-xl p-3 ring-1 ring-ink-200 dark:ring-white/10">
            <input type="checkbox" className="mt-1" checked={end} onChange={(e) => setEnd(e.target.checked)} />
            <span><span className="block text-sm font-medium">Finalizar también el directo en YouTube</span>
              <span className="block text-xs text-ink-500">Queda guardado como vídeo en tu canal y la próxima vez se crea un directo nuevo. Desmárcalo solo si vas a volver a emitir enseguida en el mismo.</span></span>
          </label>
        )}
      </Modal>
    </>
  );
}

function Controls({ s }: { s: Stream }) {
  const a = useStreamActions(s.id);
  if (!active(s)) return <StartButton s={s} a={a} />;
  return (
    <>
      <ConfirmButton label="Reiniciar" icon={<RotateCw className="size-4" />} title="Reiniciar emisión" variant="primary" confirmLabel="Reiniciar"
        message="La señal se cortará unos segundos en todos los destinos mientras el motor vuelve a arrancar. El directo de YouTube no cambia." onConfirm={() => a.restart.mutateAsync()} />
      <StopButton s={s} a={a} />
    </>
  );
}

export function Streams() {
  useTitle('Emisiones');
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
                <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
                  <Link to={`/app/streams/${s.id}`} className="min-w-0 basis-full sm:basis-0 sm:flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">{s.name} <StatusBadge status={s.status} /></p>
                    <p className="mt-1 truncate text-sm text-ink-500">
                      {s.nowPlaying ? <>Ahora: {s.nowPlaying.title} · </> : null}{s.playlistName ?? 'Sin playlist'} · {ENCODING_PROFILES[s.profile as ProfileId]?.label ?? s.profile} · {s.destinations.length} destino(s)
                    </p>
                    {s.statusReason && <p className="mt-1 text-sm text-amber-700 dark:text-amber-300">{s.statusReason}</p>}
                  </Link>
                  <div className="flex w-full gap-2 sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none"><Controls s={s} /></div>
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

const YT_STREAM: Record<string, string> = { active: 'YouTube recibe la señal', inactive: 'YouTube no recibe señal', ready: 'YouTube esperando señal', error: 'YouTube indica error en la señal', created: 'Directo creado, sin señal' };
const YT_BROADCAST: Record<string, string> = { live: 'en directo', liveStarting: 'empezando', testing: 'en prueba', testStarting: 'iniciando prueba', ready: 'preparado', created: 'creado', complete: 'finalizado', revoked: 'revocado' };

/** Estado real comprobado en YouTube (API oficial) para destinos creados con «YouTube con un clic». */
function YoutubeLiveStatus({ destinationId, active }: { destinationId: string; active: boolean }) {
  const q = useQuery<{ status: { streamStatus: string | null; health: string | null; broadcast: string | null; issues: { description?: string }[] } | null }>({
    queryKey: ['yt-status', destinationId], queryFn: () => get(`/v1/integrations/youtube/destinations/${destinationId}/status`), refetchInterval: active ? 15_000 : false, retry: false,
  });
  const st = q.data?.status;
  if (q.error) return <p className="mt-1 text-xs text-ink-500">YouTube: {errMsg(q.error)}</p>;
  if (!st) return null;
  const good = st.streamStatus === 'active';
  return (
    <div className="mt-1.5 text-xs">
      <p className={good ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-500'}>
        {YT_STREAM[st.streamStatus ?? ''] ?? `YouTube: ${st.streamStatus}`}{st.health ? ` · calidad: ${st.health}` : ''}{st.broadcast ? ` · directo ${YT_BROADCAST[st.broadcast] ?? st.broadcast}` : ''}
      </p>
      {st.issues.slice(0, 2).map((i, n) => <p key={n} className="text-amber-700 dark:text-amber-300">{i.description}</p>)}
    </div>
  );
}

const GB_PER_HOUR: Record<string, number> = { '720p30': 1.44, '1080p30': 2.79, '1080p60': 4.14, '2160p30': 9.09 };

/** Grabación en la nube: se puede activar o desactivar en pleno directo (el motor lo aplica en ~3 s). */
function RecordingCard({ s }: { s: Stream }) {
  const qc = useQueryClient();
  const rec = s.recording ?? { mode: 'off', retentionDays: 7, active: null };
  const save = useMutation({
    mutationFn: (b: { recordingMode?: 'off' | 'auto'; recordingRetentionDays?: number }) => api<Stream>('PATCH', `/v1/streams/${s.id}`, b),
    onSuccess: (x) => { qc.setQueryData(['stream', s.id], x); toast(x.recording?.mode === 'auto' ? 'Grabación en la nube activada' : 'Ajuste guardado'); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  const on = rec.mode === 'auto';
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><Clapperboard className="size-4" />Grabar en la nube</h2>
          <p className="mt-1 text-xs text-ink-500">Guarda cada sesión tal cual se emite, sin recodificar.</p>
        </div>
        <button type="button" role="switch" aria-checked={on} aria-label="Grabar en la nube" disabled={save.isPending} onClick={() => save.mutate({ recordingMode: on ? 'off' : 'auto' })}
          className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors', on ? 'bg-signal' : 'bg-ink-300 dark:bg-ink-700')}>
          <span className={cx('absolute top-0.5 size-5 rounded-full bg-white shadow transition-all', on ? 'left-[1.375rem]' : 'left-0.5')} />
        </button>
      </div>
      {rec.active && <p className="mt-3 flex items-center gap-2 text-sm font-medium text-red-600 dark:text-red-400"><span className="live-dot size-2 rounded-full bg-red-500" />{rec.active.sizeBytes ? `Grabando · ${fmtDuration(rec.active.durationSec)} guardados · ${fmtBytes(rec.active.sizeBytes)}` : 'Grabando · el primer fragmento se guarda al minuto'}</p>}
      {on && !rec.active && active(s) && <p className="mt-3 text-xs text-ink-500">Empezará a grabar en unos segundos.</p>}
      <label className="mt-3 flex items-center justify-between gap-2 text-xs text-ink-600 dark:text-ink-300">Borrar grabaciones tras
        <select className={cx(inputCls, '!h-8 !w-32 py-0 text-xs')} value={rec.retentionDays} onChange={(e) => save.mutate({ recordingRetentionDays: Number(e.target.value) })}>
          {[1, 3, 7, 14, 30, 90].map((d) => <option key={d} value={d}>{d} día{d > 1 ? 's' : ''}</option>)}
        </select>
      </label>
      <p className="mt-2 text-[11px] text-ink-500">Ocupa unos {GB_PER_HOUR[s.profile] ?? 2} GB por hora de emisión. Puedes conservar las que quieras desde Grabaciones.</p>
      <Link to="/app/recordings" className="mt-3 inline-block text-xs font-semibold text-air-500 hover:underline">Ver grabaciones →</Link>
    </Card>
  );
}

function ThumbnailCard({ s }: { s: Stream }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const hasYt = s.destinations.some((d) => d.youtube || d.youtubeLinked || d.platform === 'youtube');
  const v = s.thumbnail?.updatedAt ?? 0;
  const sync = useMutation({
    mutationFn: () => api<{ results: { ok: boolean; pending?: boolean; name: string; error?: string }[] }>('POST', `/v1/streams/${s.id}/youtube-thumbnail`),
    onSuccess: (r) => r.results.forEach((x) => toast(x.ok ? `Miniatura enviada a YouTube (${x.name})` : `${x.name}: ${x.error}`, x.ok || x.pending ? 'ok' : 'error')),
    onError: (e) => toast(errMsg(e), 'error'),
  });
  return (
    <Card>
      <h2 className="flex items-center gap-2 font-semibold"><ImagePlus className="size-4" />Miniatura del directo</h2>
      <div className="mt-3 flex aspect-video items-center justify-center overflow-hidden rounded-xl bg-ink-100 dark:bg-ink-800">
        {s.thumbnail ? <img src={`/v1/thumbnails/stream/${s.id}?v=${v}`} alt="Miniatura actual" className="size-full object-cover" /> : <span className="text-xs text-ink-500">Sin miniatura</span>}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button className="h-8" onClick={() => setOpen(true)}><ImagePlus className="size-4" />{s.thumbnail ? 'Editar' : 'Crear miniatura'}</Button>
        {hasYt && s.thumbnail && <Button className="h-8" variant="ghost" loading={sync.isPending} onClick={() => sync.mutate()}>Enviar a YouTube</Button>}
      </div>
      <p className="mt-2 text-[11px] text-ink-500">{hasYt ? 'Se envía sola a YouTube al guardarla o cambiarla y en cada directo nuevo (también con clave manual si el canal está conectado). YouTube exige un canal verificado por teléfono para miniaturas personalizadas.' : 'Para que llegue a YouTube automáticamente, conecta tu canal en «Destinos».'}</p>
      {open && <ThumbnailStudio open onClose={() => setOpen(false)} entity="stream" id={s.id} name={s.name} initialSrc={s.thumbnail ? `/v1/thumbnails/stream/${s.id}?v=${v}` : undefined}
        onSaved={() => void qc.invalidateQueries({ queryKey: ['stream', s.id] })} />}
    </Card>
  );
}

interface Audience {
  available: boolean; connected: boolean; range: string; current: { viewers: number; at: number } | null; peak: number | null; average: number | null; watchHours: number;
  destinations: { destinationId: string; name: string; viewers: number; views: number | null; likes: number | null; live: boolean; watchUrl: string | null }[];
  series: { at: number; viewers: number; views: number | null; likes: number | null }[];
}

/** Audiencia real de YouTube (API oficial): espectadores simultáneos cada 5 min, pico, media y horas vistas. */
function AudienceCard({ s }: { s: Stream }) {
  const [range, setRange] = useState<'6h' | '24h' | '7d' | '30d'>('24h');
  const q = useQuery<Audience>({ queryKey: ['audience', s.id, range], queryFn: () => get(`/v1/streams/${s.id}/audience?range=${range}`), refetchInterval: 60_000 });
  const hasYt = s.destinations.some((d) => d.platform === 'youtube' || d.youtube || d.youtubeLinked);
  if (!hasYt) return null;
  const a = q.data;
  const views = a?.destinations.reduce((x, d) => x + (d.views ?? 0), 0) ?? 0;
  const likes = a?.destinations.reduce((x, d) => x + (d.likes ?? 0), 0) ?? 0;
  return (
    <Card className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-semibold"><Users className="size-4" />Audiencia en YouTube</h2>
          <p className="mt-1 text-xs text-ink-500">Datos oficiales de YouTube, medidos cada 5 minutos mientras emites.</p>
        </div>
        <div role="tablist" aria-label="Periodo" className="flex rounded-xl bg-ink-100 p-1 text-xs dark:bg-white/[0.05]">
          {(['6h', '24h', '7d', '30d'] as const).map((r) => (
            <button key={r} role="tab" aria-selected={range === r} onClick={() => setRange(r)}
              className={cx('rounded-lg px-2.5 py-1 font-medium transition-colors', range === r ? 'bg-white shadow-sm dark:bg-white/10' : 'text-ink-500')}>{r}</button>
          ))}
        </div>
      </div>
      {q.isLoading ? <Skeleton className="mt-4 h-48" /> : !a ? null : !a.available ? (
        <p className="mt-4 rounded-xl bg-ink-50 p-4 text-sm text-ink-600 dark:bg-white/[0.03] dark:text-ink-300">Las métricas de audiencia están incluidas a partir del plan Creador. <Link to="/app/plan" className="font-semibold text-air-500 hover:underline">Ver planes</Link></p>
      ) : !a.connected ? (
        <p className="mt-4 rounded-xl bg-ink-50 p-4 text-sm text-ink-600 dark:bg-white/[0.03] dark:text-ink-300">Conecta tu canal de YouTube en <Link to="/app/destinations" className="font-semibold text-air-500 hover:underline">Destinos</Link> para ver cuántas personas están viendo tu directo.</p>
      ) : (
        <>
          <div className="stagger mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]"><p className="flex items-center gap-1.5 text-xs text-ink-500">{a.current && <span className="live-dot size-1.5 rounded-full bg-red-500" />}Viendo ahora</p><p className="mt-1 text-2xl font-semibold">{a.current ? <CountUp value={a.current.viewers} /> : '—'}</p></div>
            <div className="rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]"><p className="text-xs text-ink-500">Pico ({range})</p><p className="mt-1 text-2xl font-semibold">{a.peak != null ? <CountUp value={a.peak} /> : '—'}</p></div>
            <div className="rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]"><p className="flex items-center gap-1.5 text-xs text-ink-500"><Eye className="size-3" />Visualizaciones</p><p className="mt-1 text-2xl font-semibold">{views ? <CountUp value={views} /> : '—'}</p></div>
            <div className="rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]"><p className="flex items-center gap-1.5 text-xs text-ink-500"><Heart className="size-3" />Me gusta · horas vistas</p><p className="mt-1 text-2xl font-semibold">{likes ? fmtNum(likes) : '—'}<span className="text-sm font-normal text-ink-500"> · {a.watchHours.toFixed(1)} h</span></p></div>
          </div>
          <div className="mt-5"><AreaChart label="Espectadores simultáneos" points={a.series.map((p) => ({ at: p.at, value: p.viewers }))} /></div>
          {a.series.length === 0 && on(s) && <p className="mt-2 text-xs text-ink-500">La primera medición llega unos minutos después de que YouTube empiece a emitir.</p>}
        </>
      )}
    </Card>
  );
}
const on = (s: Stream) => active(s);

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

      <AudienceCard s={s} />

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
                {(d.youtube || d.youtubeLinked) && <YoutubeLiveStatus destinationId={d.id} active={on} />}
                {d.liveUrl && <a href={d.liveUrl} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-air-500 hover:underline">Ver el directo en YouTube<ExternalLink className="size-3" /></a>}
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
          <h2 className="font-semibold">Monitor del directo</h2>
          <p className="mb-3 mt-1 text-xs text-ink-500">Imagen y sonido reales de la señal que sale hacia tus destinos.</p>
          <LivePreview streamId={s.id} live={on && s.engine.online} />
        </Card>
        <div className="space-y-6">
          <RecordingCard s={s} />
          <ThumbnailCard s={s} />
        </div>
      </div>

      <Card className="mt-6">
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
    </>
  );
}
