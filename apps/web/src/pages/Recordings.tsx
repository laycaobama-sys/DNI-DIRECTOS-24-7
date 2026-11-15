import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clapperboard, Download, Film, ImagePlus, Link2, Pencil, Play, Trash2 } from 'lucide-react';
import type HlsType from 'hls.js';
import { type Recording, api, fmtBytes, fmtDuration, fmtTime, get } from '../api';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Input, Modal, PageHeader, Skeleton, errMsg, toast } from '../ui';
import { useTitle } from '../hooks';
import { ThumbnailStudio } from '../components/ThumbnailStudio';

function Player({ rec }: { rec: Recording }) {
  const v = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let hls: HlsType | null = null;
    const url = `/v1/recordings/${rec.id}/playlist.m3u8`;
    void (async () => {
      const el = v.current!;
      const Hls = (await import('hls.js')).default;
      if (Hls.isSupported()) { hls = new Hls({ xhrSetup: (x) => { x.withCredentials = true; } }); hls.loadSource(url); hls.attachMedia(el); }
      else el.src = url;
    })();
    return () => hls?.destroy();
  }, [rec.id]);
  return <video ref={v} controls playsInline className="aspect-video w-full rounded-xl bg-black" aria-label={`Grabación ${rec.name}`} />;
}

export default function Recordings() {
  useTitle('Grabaciones');
  const qc = useQueryClient();
  const q = useQuery<{ items: Recording[]; usedBytes: number }>({ queryKey: ['recordings'], queryFn: () => get('/v1/recordings'),
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.status === 'recording' || r.export?.status === 'pending' || r.export?.status === 'processing') ? 5000 : 30_000) });
  const [playing, setPlaying] = useState<Recording | null>(null);
  const [renaming, setRenaming] = useState<Recording | null>(null);
  const [thumb, setThumb] = useState<Recording | null>(null);
  const [v, setV] = useState(0);
  const refresh = () => qc.invalidateQueries({ queryKey: ['recordings'] });
  const exp = useMutation({ mutationFn: (id: string) => api('POST', `/v1/recordings/${id}/export`, {}), onSuccess: () => { toast('Exportación a MP4 en marcha'); void refresh(); }, onError: (e) => toast(errMsg(e), 'error') });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/v1/recordings/${id}`), onSuccess: () => { toast('Grabación borrada'); void refresh(); } });
  const rename = useMutation({ mutationFn: (p: { id: string; name: string }) => api('PATCH', `/v1/recordings/${p.id}`, { name: p.name }), onSuccess: () => { setRenaming(null); void refresh(); }, onError: (e) => toast(errMsg(e), 'error') });
  const keep = useMutation({ mutationFn: (p: { id: string; keepDays: number | null }) => api('PATCH', `/v1/recordings/${p.id}`, { keepDays: p.keepDays }), onSuccess: () => { toast('Caducidad actualizada'); void refresh(); } });
  const share = async (id: string) => {
    try {
      const r = await api<{ url: string; expiresAt: number }>('POST', `/v1/recordings/${id}/share`, { days: 2 });
      await navigator.clipboard.writeText(r.url).catch(() => {});
      toast(`Enlace copiado · caduca el ${fmtTime(r.expiresAt)}`);
    } catch (e) { toast(errMsg(e), 'error'); }
  };

  return (
    <>
      <PageHeader title="Grabaciones" description={<>Copias en la nube de tus directos, guardadas en fragmentos mientras se emiten. {q.data ? `Ocupan ${fmtBytes(q.data.usedBytes)}.` : ''}</>} />
      {q.isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-64" />)}</div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data!.items.length === 0 ? (
          <EmptyState icon={<Clapperboard />} title="Aún no hay grabaciones" action={<Link to="/app/streams"><Button variant="primary">Ir a Emisiones</Button></Link>}>
            Activa «Grabar en la nube» en una emisión y cada sesión quedará guardada aquí para verla, descargarla en MP4 o compartirla.
          </EmptyState>
        ) : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {q.data!.items.map((r) => (
              <li key={r.id}>
                <Card className="flex h-full flex-col overflow-hidden p-0">
                  <button type="button" onClick={() => setPlaying(r)} disabled={!r.segments} className="group relative flex aspect-video items-center justify-center bg-ink-900 disabled:cursor-not-allowed" aria-label={`Reproducir ${r.name}`}>
                    {r.hasThumbnail ? <img src={`/v1/thumbnails/recording/${r.id}?v=${v}`} alt="" loading="lazy" className="absolute inset-0 size-full object-cover" /> : <Film className="size-8 text-ink-500" aria-hidden />}
                    {r.segments > 0 && <span className="relative flex size-12 items-center justify-center rounded-full bg-white/90 text-ink-900 shadow-lg transition-transform group-hover:scale-110"><Play className="ml-0.5 size-5" /></span>}
                    <span className="absolute bottom-2 right-2 rounded bg-ink-950/80 px-1.5 py-0.5 font-mono text-xs text-white">{fmtDuration(r.durationSec)}</span>
                    {r.status === 'recording' && <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase text-white"><span className="live-dot size-1.5 rounded-full bg-white" />Grabando</span>}
                  </button>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <p className="break-words text-sm font-medium">{r.name}</p>
                    <p className="text-xs text-ink-500">{[r.streamName, fmtTime(r.startedAt), fmtBytes(r.sizeBytes), `${r.segments} fragmento(s)`].filter(Boolean).join(' · ')}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {r.status === 'failed' && <Badge tone="error">Sin datos</Badge>}
                      {r.export?.status === 'ready' && <Badge tone="ok">MP4 listo</Badge>}
                      {(r.export?.status === 'pending' || r.export?.status === 'processing') && <Badge tone="info" dot>Exportando a MP4…</Badge>}
                      {r.export?.status === 'failed' && <Badge tone="error">Exportación fallida</Badge>}
                      {r.expiresAt ? <Badge tone="muted">Se borra el {new Date(r.expiresAt).toLocaleDateString('es-ES')}</Badge> : <Badge tone="info">Se conserva</Badge>}
                    </div>
                    {r.export?.error && r.export.status !== 'ready' && <p className="text-xs text-amber-700 dark:text-amber-300">{r.export.error}</p>}
                    <div className="mt-auto flex flex-wrap justify-end gap-1 pt-1">
                      {r.export?.status === 'ready'
                        ? <><a href={`/v1/recordings/${r.id}/download`} className="inline-flex h-8 items-center gap-1.5 rounded-xl px-2 text-sm font-semibold text-ink-600 hover:bg-ink-100 dark:text-ink-300 dark:hover:bg-white/[0.06]"><Download className="size-4" />MP4</a>
                          <Button variant="ghost" className="h-8 px-2" onClick={() => share(r.id)}><Link2 className="size-4" />Compartir</Button></>
                        : r.status === 'ready' && r.export?.status !== 'pending' && r.export?.status !== 'processing' && <Button variant="ghost" className="h-8 px-2" loading={exp.isPending && exp.variables === r.id} onClick={() => exp.mutate(r.id)}><Download className="size-4" />Exportar MP4</Button>}
                      <Button variant="ghost" className="h-8 px-2" aria-label="Miniatura" onClick={() => setThumb(r)}><ImagePlus className="size-4" /></Button>
                      <Button variant="ghost" className="h-8 px-2" aria-label="Renombrar" onClick={() => setRenaming(r)}><Pencil className="size-4" /></Button>
                      {r.status !== 'recording' && (
                        <ConfirmButton buttonVariant="ghost" label={<span className="sr-only">Borrar {r.name}</span>} icon={<Trash2 className="size-4" />} title="Borrar grabación"
                          message={<>Se borrará <strong>{r.name}</strong> y su MP4. No se puede deshacer.</>} confirmLabel="Borrar definitivamente" onConfirm={() => del.mutateAsync(r.id)} />
                      )}
                    </div>
                    {r.status !== 'recording' && (
                      <select aria-label="Conservar la grabación" className="mt-1 h-8 rounded-lg bg-transparent text-xs text-ink-500 ring-1 ring-ink-200 dark:ring-white/10" value=""
                        onChange={(e) => { const val = e.target.value; if (val) keep.mutate({ id: r.id, keepDays: val === 'forever' ? null : Number(val) }); }}>
                        <option value="">Cambiar cuándo se borra…</option><option value="7">Dentro de 7 días</option><option value="30">Dentro de 30 días</option><option value="90">Dentro de 90 días</option><option value="forever">Conservar siempre</option>
                      </select>
                    )}
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      <Modal open={!!playing} title={playing?.name ?? ''} onClose={() => setPlaying(null)} wide>
        {playing && <Player rec={playing} />}
        {playing?.status === 'recording' && <p className="mt-2 text-xs text-ink-500">La grabación sigue en curso: se añade un fragmento cada minuto.</p>}
      </Modal>
      <Modal open={!!renaming} title="Renombrar grabación" onClose={() => setRenaming(null)}>
        {renaming && (
          <form onSubmit={(e) => { e.preventDefault(); rename.mutate({ id: renaming.id, name: String(new FormData(e.currentTarget).get('name')) }); }} className="space-y-4">
            <Input name="name" defaultValue={renaming.name} maxLength={160} required aria-label="Nombre" autoFocus />
            <div className="flex justify-end"><Button variant="primary" type="submit" loading={rename.isPending}>Guardar</Button></div>
          </form>
        )}
      </Modal>
      {thumb && <ThumbnailStudio open onClose={() => setThumb(null)} entity="recording" id={thumb.id} name={thumb.name} onSaved={() => { setV((x) => x + 1); void refresh(); }} />}
    </>
  );
}
