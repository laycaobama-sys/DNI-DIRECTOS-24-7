import { type DragEvent, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CloudUpload, Film, Image as ImageIcon, Music, RotateCw, Trash2 } from 'lucide-react';
import { type Media, api, fmtBytes, fmtDuration, fmtSpeed, get, uploadFile } from '../api';
import { Button, Card, ConfirmButton, EmptyState, ErrorState, PageHeader, Progress, Skeleton, StatusBadge, cx, errMsg, toast } from '../ui';
import { useTitle } from '../hooks';

interface Uploading { key: string; name: string; size: number; pct: number; speed: number; phase: 'uploading' | 'finishing'; error?: string }

export function useMedia(poll = true) {
  return useQuery<{ items: Media[]; storage: { usedBytes: number; limitBytes: number } }>({
    queryKey: ['media'], queryFn: () => get('/v1/media'),
    refetchInterval: (q) => (poll && q.state.data?.items.some((m) => m.status === 'queued' || m.status === 'processing') ? 2000 : false),
  });
}

export function Library() {
  useTitle('Biblioteca');
  const qc = useQueryClient();
  const q = useMedia();
  const [uploads, setUploads] = useState<Uploading[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/v1/media/${id}`), onSuccess: () => { toast('Archivo borrado'); return qc.invalidateQueries({ queryKey: ['media'] }); } });
  const retry = useMutation({ mutationFn: (id: string) => api('POST', `/v1/media/${id}/retry`), onSuccess: () => qc.invalidateQueries({ queryKey: ['media'] }), onError: (e) => toast(errMsg(e), 'error') });

  /** Todas las subidas arrancan a la vez (no en fila); la red se comparte entre ellas en api.uploadFile. */
  function addFiles(files: FileList | File[]) {
    const list = [...files];
    const batch = list.map((file, i) => ({ key: `${file.name}-${file.size}-${Date.now()}-${i}`, name: file.name, size: file.size, pct: 0, speed: 0, phase: 'uploading' as const }));
    setUploads((u) => [...u, ...batch]);
    list.forEach((file, i) => {
      const key = batch[i]!.key;
      const set = (patch: Partial<Uploading>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      void uploadFile(file, (p) => set({ pct: p.pct, speed: p.bytesPerSec, phase: p.phase }))
        .then(async () => { setUploads((u) => u.filter((x) => x.key !== key)); await qc.invalidateQueries({ queryKey: ['media'] }); })
        .catch((e) => set({ error: errMsg(e) }));
    });
  }
  const onDrop = (e: DragEvent) => { e.preventDefault(); setOver(false); if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files); };

  const visible = q.data?.items.filter((m) => m.status !== 'uploading') ?? [];
  return (
    <>
      <PageHeader title="Biblioteca" description={q.data ? `${fmtBytes(q.data.storage.usedBytes)} usados · hasta 4 GB por archivo` : 'Tus vídeos, audios e imágenes'}
        actions={<Button variant="primary" onClick={() => input.current?.click()}><CloudUpload className="size-4" />Subir archivos</Button>} />
      <input ref={input} type="file" multiple hidden accept=".mp4,.mov,.mkv,.webm,.m4v,.mp3,.wav,.aac,.m4a,.png,.jpg,.jpeg,.webp"
        onChange={(e) => { if (e.target.files?.length) void addFiles(e.target.files); e.target.value = ''; }} />

      <div onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') input.current?.click(); }}
        className={cx('mb-6 cursor-pointer rounded-2xl border-2 border-dashed px-6 py-10 text-center text-sm transition-all', over ? 'scale-[1.01] border-air-500 bg-air-500/5' : 'border-ink-300 hover:border-ink-400 dark:border-white/10 dark:hover:border-white/20')}>
        <span className="bg-signal mx-auto mb-3 flex size-12 items-center justify-center rounded-2xl text-white shadow-lg shadow-air-500/25"><CloudUpload className="size-6" aria-hidden /></span>
        <p className="font-semibold">Arrastra aquí tus vídeos o pulsa para elegirlos</p>
        <p className="mt-1 text-ink-500">Selecciona varios a la vez: suben en paralelo, se reanudan si falla la red y se preparan para emitir automáticamente. MP4, MOV, MKV o WebM, hasta 4 GB.</p>
      </div>

      {uploads.length > 0 && (
        <Card className="mb-6 space-y-3">
          {uploads.map((u) => (
            <div key={u.key}>
              <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                <span className="truncate font-medium">{u.name}</span>
                {u.error ? <button className="text-xs text-ink-500 hover:underline" onClick={() => setUploads((x) => x.filter((y) => y.key !== u.key))}>Descartar</button>
                  : <span className="shrink-0 font-mono text-xs tabular-nums text-ink-500">{u.phase === 'finishing' ? 'Finalizando…' : `${Math.floor(u.pct)}%${u.speed ? ` · ${fmtSpeed(u.speed)}` : ''}`}</span>}
              </div>
              {u.error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{u.error}</p> : <Progress value={u.pct} />}
            </div>
          ))}
        </Card>
      )}

      {q.isLoading ? <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-56" />)}</div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : visible.length === 0 && uploads.length === 0 ? <EmptyState icon={<Film />} title="Tu biblioteca está vacía">Sube tu primer vídeo para empezar. Emite únicamente contenido del que tengas los derechos.</EmptyState>
        : (
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((m) => (
              <li key={m.id}>
                <Card className="flex h-full flex-col overflow-hidden p-0">
                  <div className="relative flex aspect-video items-center justify-center bg-ink-100 dark:bg-ink-800">
                    {m.hasThumbnail ? <img src={`/v1/media/${m.id}/thumbnail`} alt="" loading="lazy" className="size-full object-cover" />
                      : m.status === 'failed' ? <AlertTriangle className="size-8 text-red-500" aria-hidden />
                      : m.kind === 'audio' ? <Music className="size-8 text-ink-400" aria-hidden /> : m.kind === 'image' ? <ImageIcon className="size-8 text-ink-400" aria-hidden /> : <Film className="size-8 text-ink-400" aria-hidden />}
                    {m.durationSec != null && <span className="absolute bottom-2 right-2 rounded bg-ink-950/80 px-1.5 py-0.5 font-mono text-xs text-white">{fmtDuration(m.durationSec)}</span>}
                  </div>
                  <div className="flex flex-1 flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <p className="min-w-0 break-words text-sm font-medium" title={m.filename}>{m.filename}</p>
                      <StatusBadge status={m.status} />
                    </div>
                    {m.status === 'processing' && <div className="space-y-1"><Progress value={m.progress} /><p className="text-xs text-ink-500">Convirtiendo para emitir… {m.progress}%</p></div>}
                    {m.status === 'queued' && <p className="shimmer rounded-lg bg-sky-500/10 px-2.5 py-1.5 text-xs text-sky-700 dark:text-sky-300">Arrancando el servidor de conversión…</p>}
                    {m.status === 'failed' && <p role="alert" className="text-xs text-red-600 dark:text-red-400">{m.error?.message}</p>}
                    <p className="text-xs text-ink-500">{[fmtBytes(m.sizeBytes), m.width && `${m.width}×${m.height}`, m.videoCodec?.toUpperCase(), m.fps && `${Math.round(m.fps)} fps`, m.hasAudio === false && 'sin audio'].filter(Boolean).join(' · ')}</p>
                    <div className="mt-auto flex justify-end gap-1 pt-1">
                      {m.status === 'failed' && <Button variant="ghost" className="h-8 px-2" onClick={() => retry.mutate(m.id)}><RotateCw className="size-4" />Reintentar</Button>}
                      <ConfirmButton buttonVariant="ghost" label={<span className="sr-only">Borrar {m.filename}</span>} icon={<Trash2 className="size-4" />} title="Borrar archivo"
                        message={<>Se borrará <strong>{m.filename}</strong> y sus conversiones. Esta acción no se puede deshacer. Si el archivo está en alguna playlist, te avisaremos y no se borrará.</>}
                        confirmLabel="Borrar definitivamente" onConfirm={() => del.mutateAsync(m.id)} />
                    </div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
    </>
  );
}
