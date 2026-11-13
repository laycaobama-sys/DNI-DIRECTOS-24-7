import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { DndContext, type DragEndEvent, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowLeft, GripVertical, ListVideo, Plus, Trash2, X } from 'lucide-react';
import { type Media, type Playlist, api, fmtDuration, fmtTime, get } from '../api';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, StatusBadge, errMsg, toast } from '../ui';
import { useMedia } from './Library';

export const usePlaylists = () => useQuery<{ items: Playlist[] }>({ queryKey: ['playlists'], queryFn: () => get('/v1/playlists') });

export function Playlists() {
  const q = usePlaylists();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const create = useMutation({ mutationFn: (name: string) => api<Playlist>('POST', '/v1/playlists', { name }), onSuccess: (p) => nav(`/app/playlists/${p.id}`), onError: (e) => toast(errMsg(e), 'error') });
  return (
    <>
      <PageHeader title="Playlists" description="El orden de reproducción de tus emisiones" actions={<Button variant="primary" onClick={() => setOpen(true)}><Plus className="size-4" />Nueva playlist</Button>} />
      {q.isLoading ? <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-20" />)}</div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data!.items.length === 0 ? <EmptyState icon={<ListVideo />} title="Aún no tienes playlists" action={<Button variant="primary" onClick={() => setOpen(true)}>Crear playlist</Button>}>Una playlist define qué vídeos se emiten y en qué orden.</EmptyState>
        : (
          <ul className="space-y-3">
            {q.data!.items.map((p) => (
              <li key={p.id}>
                <Link to={`/app/playlists/${p.id}`} className="block">
                  <Card className="flex flex-wrap items-center justify-between gap-3 transition-shadow hover:shadow-md">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{p.name}</p>
                      <p className="text-sm text-ink-500">{p.items.length} vídeo(s) · {fmtDuration(p.totalDurationSec)}</p>
                    </div>
                    {!p.published ? <Badge tone="warn">Sin publicar</Badge> : p.hasUnpublishedChanges ? <Badge tone="warn">Cambios sin publicar</Badge> : <Badge tone="ok">Publicada v{p.published.version}</Badge>}
                  </Card>
                </Link>
              </li>
            ))}
          </ul>
        )}
      <Modal open={open} title="Nueva playlist" onClose={() => setOpen(false)}>
        <form onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); create.mutate(String(new FormData(e.currentTarget).get('name'))); }} className="space-y-4">
          <Field label="Nombre">{(id) => <Input id={id} name="name" required maxLength={120} autoFocus placeholder="Por ejemplo: Programación de tarde" />}</Field>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" type="submit" loading={create.isPending}>Crear</Button></div>
        </form>
      </Modal>
    </>
  );
}

type Row = { key: string; media: Media };

function SortableRow({ row, index, onRemove }: { row: Row; index: number; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.key });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`flex items-center gap-3 rounded-xl bg-white px-3 py-2.5 ring-1 ring-ink-200 dark:bg-ink-900 dark:ring-ink-800 ${isDragging ? 'z-10 shadow-lg' : ''}`}>
      <button {...attributes} {...listeners} aria-label={`Reordenar ${row.media.filename}`} className="cursor-grab touch-none rounded p-1 text-ink-400 hover:bg-ink-100 active:cursor-grabbing dark:hover:bg-ink-800"><GripVertical className="size-4" /></button>
      <span className="w-6 text-center font-mono text-xs text-ink-400">{index + 1}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{row.media.filename}</p>
        <p className="text-xs text-ink-500">{fmtDuration(row.media.durationSec)}</p>
      </div>
      {row.media.status !== 'ready' && <StatusBadge status={row.media.status} />}
      <button onClick={onRemove} aria-label={`Quitar ${row.media.filename}`} className="rounded p-1.5 text-ink-400 hover:bg-ink-100 hover:text-red-600 dark:hover:bg-ink-800"><X className="size-4" /></button>
    </li>
  );
}

export function PlaylistEditor() {
  const { id } = useParams();
  const qc = useQueryClient();
  const nav = useNavigate();
  const q = useQuery<Playlist>({ queryKey: ['playlist', id], queryFn: () => get(`/v1/playlists/${id}`) });
  const media = useMedia();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const seq = useRef(0);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  useEffect(() => { if (q.data && rows === null) setRows(q.data.items.map((m) => ({ key: `${m.id}-${seq.current++}`, media: m }))); }, [q.data, rows]);

  // Guardado automático del borrador (no afecta a lo que se está emitiendo hasta publicar).
  async function save(next: Row[]) {
    setRows(next); setSaving('saving');
    try {
      qc.setQueryData(['playlist', id], await api<Playlist>('PUT', `/v1/playlists/${id}`, { items: next.map((r) => ({ mediaId: r.media.id })) }));
      setSaving('saved');
    } catch (e) { setSaving('error'); toast(errMsg(e), 'error'); }
  }
  const publish = useMutation({
    mutationFn: () => api<Playlist>('POST', `/v1/playlists/${id}/publish`),
    onSuccess: (p) => { qc.setQueryData(['playlist', id], p); void qc.invalidateQueries({ queryKey: ['playlists'] }); toast(`Versión ${p.published!.version} publicada`); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  const del = useMutation({ mutationFn: () => api('DELETE', `/v1/playlists/${id}`), onSuccess: () => { void qc.invalidateQueries({ queryKey: ['playlists'] }); nav('/app/playlists'); } });

  if (q.isLoading || rows === null) return q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : <div className="space-y-3"><Skeleton className="h-9 w-64" /><Skeleton className="h-72" /></div>;
  const p = q.data!;
  const total = rows.reduce((s, r) => s + (r.media.durationSec ?? 0), 0);
  const available = media.data?.items.filter((m) => m.kind === 'video' && m.status !== 'failed' && m.status !== 'uploading') ?? [];
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    void save(arrayMove(rows, rows.findIndex((r) => r.key === e.active.id), rows.findIndex((r) => r.key === e.over!.id)));
  };
  return (
    <>
      <Link to="/app/playlists" className="mb-3 inline-flex items-center gap-1 text-sm text-ink-500 hover:text-ink-800 dark:hover:text-ink-200"><ArrowLeft className="size-4" />Playlists</Link>
      <PageHeader title={p.name}
        description={<>{rows.length} vídeo(s) · {fmtDuration(total)} · <span aria-live="polite">{saving === 'saving' ? 'Guardando…' : saving === 'error' ? 'Error al guardar' : 'Borrador guardado'}</span></>}
        actions={<>
          <ConfirmButton label="Borrar" icon={<Trash2 className="size-4" />} title="Borrar playlist" message="Se borrará la playlist. No se puede borrar si alguna emisión la usa." confirmLabel="Borrar" onConfirm={() => del.mutateAsync()} />
          <Button variant="primary" loading={publish.isPending} disabled={!rows.length || saving === 'saving' || !p.hasUnpublishedChanges} onClick={() => publish.mutate()}>{p.hasUnpublishedChanges ? 'Publicar cambios' : 'Publicada'}</Button>
        </>} />
      <div className="mb-5 rounded-xl bg-ink-100 px-4 py-3 text-sm text-ink-600 dark:bg-ink-900 dark:text-ink-300">
        {p.published ? <>Versión {p.published.version} publicada el {fmtTime(p.published.publishedAt)} ({p.published.itemCount} vídeos). </> : 'Todavía no hay ninguna versión publicada. '}
        Las emisiones en directo adoptan la nueva versión al terminar el vídeo que esté sonando, sin cortes.
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="orden">
          <h2 id="orden" className="mb-3 font-semibold">Orden de emisión</h2>
          {rows.length === 0 ? <EmptyState icon={<ListVideo />} title="Playlist vacía">Añade vídeos desde tu biblioteca.</EmptyState> : (
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={rows.map((r) => r.key)} strategy={verticalListSortingStrategy}>
                <ol className="space-y-2">{rows.map((r, i) => <SortableRow key={r.key} row={r} index={i} onRemove={() => void save(rows.filter((x) => x.key !== r.key))} />)}</ol>
              </SortableContext>
            </DndContext>
          )}
        </section>
        <section aria-labelledby="biblio">
          <h2 id="biblio" className="mb-3 font-semibold">Biblioteca</h2>
          {media.isLoading ? <Skeleton className="h-40" /> : available.length === 0 ? <EmptyState icon={<Plus />} title="No hay vídeos disponibles" action={<Link to="/app/library"><Button>Subir vídeos</Button></Link>} /> : (
            <ul className="space-y-2">
              {available.map((m) => (
                <li key={m.id} className="flex items-center gap-3 rounded-xl px-3 py-2 ring-1 ring-ink-200 dark:ring-ink-800">
                  <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{m.filename}</p><p className="text-xs text-ink-500">{fmtDuration(m.durationSec)}</p></div>
                  {m.status !== 'ready' && <StatusBadge status={m.status} />}
                  <Button className="h-8 px-3" onClick={() => void save([...rows, { key: `${m.id}-${seq.current++}`, media: m }])}><Plus className="size-4" />Añadir</Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
