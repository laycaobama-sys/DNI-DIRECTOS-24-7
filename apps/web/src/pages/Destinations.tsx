import { type FormEvent, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, LockOpen, Plus, Send, Trash2 } from 'lucide-react';
import { type Destination, api, fmtTime, get } from '../api';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, errMsg, inputCls, toast } from '../ui';

export const useDestinations = () => useQuery<{ items: Destination[] }>({ queryKey: ['destinations'], queryFn: () => get('/v1/destinations') });

// URLs de ingest publicadas por cada plataforma; el usuario debe confirmarlas en su panel de emisión.
const PRESETS: Record<string, { label: string; url: string; help: string }> = {
  youtube: { label: 'YouTube', url: 'rtmps://a.rtmps.youtube.com/live2', help: 'Copia la clave desde YouTube Studio → Emitir en directo → Clave de emisión. Tu canal debe tener los directos habilitados.' },
  twitch: { label: 'Twitch', url: 'rtmps://ingest.global-contribute.live-video.net:443/app', help: 'Copia la clave desde Panel de control del creador → Configuración → Emisión.' },
  custom: { label: 'RTMP personalizado', url: '', help: 'Introduce la URL del servidor (rtmps:// recomendado) y la clave por separado.' },
};

export function Destinations() {
  const qc = useQueryClient();
  const q = useDestinations();
  const [open, setOpen] = useState(false);
  const [rotate, setRotate] = useState<Destination | null>(null);
  const [platform, setPlatform] = useState('youtube');
  const [url, setUrl] = useState(PRESETS.youtube!.url);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['destinations'] });
  const create = useMutation({
    mutationFn: (b: unknown) => api('POST', '/v1/destinations', b),
    onSuccess: () => { setOpen(false); setError(null); toast('Destino guardado'); return refresh(); },
    onError: (e) => setError(errMsg(e)),
  });
  const patch = useMutation({
    mutationFn: (v: { id: string; streamKey: string }) => api('PATCH', `/v1/destinations/${v.id}`, { streamKey: v.streamKey }),
    onSuccess: () => { setRotate(null); toast('Clave actualizada. Las emisiones en directo se reconectan con la nueva clave.'); return refresh(); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `/v1/destinations/${id}`), onSuccess: () => { toast('Destino borrado'); return refresh(); } });
  const insecure = url.trim().toLowerCase().startsWith('rtmp://');

  return (
    <>
      <PageHeader title="Destinos" description="Dónde se envía tu señal. Las claves se guardan cifradas y nunca se muestran completas."
        actions={<Button variant="primary" onClick={() => { setError(null); setOpen(true); }}><Plus className="size-4" />Añadir destino</Button>} />
      {q.isLoading ? <div className="space-y-3">{[0, 1].map((i) => <Skeleton key={i} className="h-20" />)}</div>
        : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} />
        : q.data!.items.length === 0 ? <EmptyState icon={<Send />} title="Sin destinos" action={<Button variant="primary" onClick={() => setOpen(true)}>Añadir destino</Button>}>Añade el servidor RTMP(S) y la clave de emisión de YouTube, Twitch u otra plataforma.</EmptyState>
        : (
          <ul className="space-y-3">
            {q.data!.items.map((d) => (
              <li key={d.id}>
                <Card className="flex flex-wrap items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 font-medium">{d.name} <Badge>{PRESETS[d.platform]?.label ?? d.platform}</Badge>
                      {d.secure ? <Badge tone="ok"><Lock className="size-3" />RTMPS</Badge> : <Badge tone="warn"><LockOpen className="size-3" />Sin cifrar</Badge>}</p>
                    <p className="mt-1 break-all font-mono text-xs text-ink-500">{d.url}</p>
                    <p className="mt-1 text-xs text-ink-500">Clave <span className="font-mono">{d.streamKeyMasked}</span> · actualizada el {fmtTime(d.keyRotatedAt)}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button onClick={() => setRotate(d)}><KeyRound className="size-4" />Cambiar clave</Button>
                    <ConfirmButton label={<span className="sr-only">Borrar {d.name}</span>} icon={<Trash2 className="size-4" />} title="Borrar destino" confirmLabel="Borrar"
                      message={<>Se borrará <strong>{d.name}</strong> y su clave cifrada. No se puede borrar mientras una emisión en directo lo use.</>} onConfirm={() => del.mutateAsync(d.id)} />
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}

      <Modal open={open} title="Añadir destino" onClose={() => setOpen(false)}>
        <form className="space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({ name: f.get('name'), platform, url, streamKey: f.get('streamKey'), allowInsecure: f.get('allowInsecure') === 'on' });
        }}>
          <Field label="Plataforma">{(id) => (
            <select id={id} className={inputCls} value={platform} onChange={(e) => { setPlatform(e.target.value); setUrl(PRESETS[e.target.value]!.url); }}>
              {Object.entries(PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          )}</Field>
          <p className="text-xs text-ink-500">{PRESETS[platform]!.help}</p>
          <Field label="Nombre">{(id) => <Input id={id} name="name" required maxLength={120} placeholder="Mi canal de YouTube" />}</Field>
          <Field label="URL del servidor">{(id) => <Input id={id} value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="rtmps://servidor/app" className="font-mono" />}</Field>
          <Field label="Clave de emisión" hint="Se cifra al guardarla. Después solo verás los últimos 4 caracteres.">{(id) => <Input id={id} name="streamKey" type="password" required autoComplete="off" className="font-mono" />}</Field>
          {insecure && (
            <label className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
              <input type="checkbox" name="allowInsecure" required className="mt-0.5" />
              <span>Este destino usa RTMP sin cifrar: la clave viaja en claro por la red. Acepto el riesgo.</span>
            </label>
          )}
          {error && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/50 dark:text-red-300">{error}</p>}
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setOpen(false)}>Cancelar</Button><Button variant="primary" type="submit" loading={create.isPending}>Guardar destino</Button></div>
        </form>
      </Modal>

      <Modal open={!!rotate} title={`Cambiar clave · ${rotate?.name ?? ''}`} onClose={() => setRotate(null)}>
        <form className="space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => { e.preventDefault(); patch.mutate({ id: rotate!.id, streamKey: String(new FormData(e.currentTarget).get('streamKey')) }); }}>
          <Field label="Nueva clave de emisión" hint="La clave anterior se sustituye y no puede recuperarse.">{(id) => <Input id={id} name="streamKey" type="password" required autoComplete="off" className="font-mono" autoFocus />}</Field>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setRotate(null)}>Cancelar</Button><Button variant="primary" type="submit" loading={patch.isPending}>Actualizar clave</Button></div>
        </form>
      </Modal>
    </>
  );
}
