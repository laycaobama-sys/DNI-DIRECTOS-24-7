import { type FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, KeyRound, Lock, LockOpen, Plus, Radio, Send, Trash2 } from 'lucide-react';
import { YoutubeWizard } from './YoutubeWizard';
import { type Destination, type YoutubeAccount, api, fmtTime, get } from '../api';
import { GoogleIcon, YoutubeIcon as Youtube } from '../brand';
import { useTitle } from '../hooks';
import { Badge, Button, Card, ConfirmButton, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Skeleton, buttonCls, cx, errMsg, inputCls, toast } from '../ui';

export const useDestinations = () => useQuery<{ items: Destination[] }>({ queryKey: ['destinations'], queryFn: () => get('/v1/destinations') });

// URLs de ingest publicadas por cada plataforma; el usuario debe confirmarlas en su panel de emisión.
const PRESETS: Record<string, { label: string; url: string; help: string }> = {
  youtube: { label: 'YouTube', url: 'rtmps://a.rtmps.youtube.com/live2', help: 'Copia la clave desde YouTube Studio → Emitir en directo → Clave de emisión. Tu canal debe tener los directos habilitados.' },
  twitch: { label: 'Twitch', url: 'rtmps://ingest.global-contribute.live-video.net:443/app', help: 'Copia la clave desde Panel de control del creador → Configuración → Emisión.' },
  facebook: { label: 'Facebook Live', url: 'rtmps://live-api-s.facebook.com:443/rtmp', help: 'En Facebook → Crear vídeo en directo → Software de streaming, copia la clave de transmisión.' },
  kick: { label: 'Kick', url: '', help: 'En Kick → Panel de creador → Configuración → Stream, copia la URL del servidor y la clave.' },
  custom: { label: 'Otro RTMP / RTMPS', url: '', help: 'Introduce la URL del servidor (rtmps:// recomendado) y la clave por separado.' },
};

const YT_ERRORS: Record<string, string> = {
  google_cancelled: 'Has cancelado la conexión con YouTube.',
  google_state: 'La conexión caducó. Inténtalo de nuevo.',
  youtube_scope: 'No diste permiso para gestionar YouTube. Vuelve a intentarlo y acepta el permiso de YouTube.',
  youtube_api_disabled: 'La API de YouTube no está activada en el proyecto de Google de la plataforma. Avisa al administrador.',
  youtube_no_channel: 'Esa cuenta de Google no tiene canal de YouTube. Crea uno en youtube.com y vuelve a intentarlo.',
  youtube_channels: 'YouTube no devolvió tu canal. Inténtalo de nuevo.',
  youtube_session: 'Tu sesión caducó o no tienes permiso para conectar canales.',
  google_not_configured: 'La conexión con Google aún no está activada en la plataforma.',
};

function YoutubeConnect({ onCreated }: { onCreated: () => void }) {
  const qc = useQueryClient();
  const loc = useLocation();
  const nav = useNavigate();
  const q = useQuery<{ items: YoutubeAccount[]; available: boolean }>({ queryKey: ['yt-accounts'], queryFn: () => get('/v1/integrations/youtube/accounts') });
  const [target, setTarget] = useState<YoutubeAccount | null>(null);
  const [wizard, setWizard] = useState<YoutubeAccount | null>(null);
  const [created, setCreated] = useState<{ watchUrl: string; studioUrl: string } | null>(null);
  useEffect(() => {
    const p = new URLSearchParams(loc.search);
    if (p.get('youtube') === 'connected') toast('Canal de YouTube conectado. Prepara tu directo 24/7.');
    const err = p.get('youtube_error');
    if (err) toast(YT_ERRORS[err] ?? 'No se pudo conectar YouTube.', 'error');
    if (p.has('youtube') || err) nav('/app/destinations', { replace: true });
  }, [loc.search, nav]);
  const create = useMutation({
    mutationFn: (b: { id: string; body: unknown }) => api<{ watchUrl: string; studioUrl: string }>('POST', `/v1/integrations/youtube/accounts/${b.id}/destination`, b.body),
    onSuccess: (r) => { setTarget(null); setCreated(r); onCreated(); },
    onError: (e) => toast(errMsg(e), 'error'),
  });
  const disconnect = useMutation({ mutationFn: (id: string) => api('DELETE', `/v1/integrations/youtube/accounts/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ['yt-accounts'] }) });
  if (!q.data?.available) return null;
  return (
    <Card className="relative mb-6 overflow-hidden">
      <div className="pointer-events-none absolute -right-16 -top-16 size-48 rounded-full bg-red-500/10 blur-3xl" aria-hidden />
      <div className="relative flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><Youtube />YouTube con un clic</h2>
          <p className="mt-1 text-sm text-ink-500">Conecta tu canal con Google y prepara tu directo 24/7 aquí mismo: elige o sube tus vídeos, crea la playlist y emite. Sin copiar claves de emisión.</p>
        </div>
        <a href="/v1/integrations/youtube/start" className={buttonCls('secondary')}><GoogleIcon />{q.data.items.length ? 'Conectar otro canal' : 'Conectar con Google'}</a>
      </div>
      {q.data.items.length > 0 && (
        <ul className="relative mt-5 space-y-2">
          {q.data.items.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-ink-50 px-4 py-3 dark:bg-white/[0.03]">
              <span className="flex min-w-0 items-center gap-3">
                {a.thumbnail ? <img src={a.thumbnail} alt="" className="size-9 rounded-full" referrerPolicy="no-referrer" /> : <span className="flex size-9 items-center justify-center rounded-full bg-red-500/15"><Youtube className="size-4" /></span>}
                <span className="min-w-0"><span className="block truncate font-semibold">{a.title}</span><span className="block text-xs text-ink-500">Conectado el {fmtTime(a.connectedAt)}</span></span>
              </span>
              <span className="flex gap-2">
                <Button variant="primary" onClick={() => setWizard(a)}><Radio className="size-4" />Preparar directo 24/7</Button>
                <Button variant="ghost" onClick={() => setTarget(a)}>Solo crear destino</Button>
                <ConfirmButton buttonVariant="ghost" label="Desconectar" title={`Desconectar ${a.title}`} confirmLabel="Desconectar" message="Se revocará el acceso a tu canal. Los destinos ya creados siguen funcionando con su clave." onConfirm={() => disconnect.mutateAsync(a.id)} />
              </span>
            </li>
          ))}
        </ul>
      )}
      {wizard && <YoutubeWizard account={wizard} open={!!wizard} onClose={() => setWizard(null)} />}
      <Modal open={!!target} title={`Nuevo destino en ${target?.title ?? 'YouTube'}`} onClose={() => setTarget(null)}>
        <form className="space-y-4" onSubmit={(e: FormEvent<HTMLFormElement>) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          create.mutate({ id: target!.id, body: { title: f.get('title'), description: f.get('description') ?? '', privacy: f.get('privacy'), madeForKids: f.get('kids') === 'yes' } });
        }}>
          <Field label="Título del directo" hint="Así aparecerá en YouTube (máx. 100 caracteres).">{(id) => <Input id={id} name="title" required maxLength={100} placeholder="Radio lofi 24/7 · música para estudiar" />}</Field>
          <Field label="Descripción">{(id) => <textarea id={id} name="description" rows={3} maxLength={4900} className={cx(inputCls, 'h-auto py-2.5')} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visibilidad">{(id) => <select id={id} name="privacy" className={inputCls} defaultValue="public"><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select>}</Field>
            <Field label="¿Creado para niños?">{(id) => <select id={id} name="kids" className={inputCls} defaultValue="no"><option value="no">No</option><option value="yes">Sí</option></select>}</Field>
          </div>
          <p className="text-xs text-ink-500">El directo empezará solo en cuanto llegue la señal. YouTube puede no archivar directos de más de 12 horas.</p>
          <div className="flex justify-end gap-2"><Button type="button" onClick={() => setTarget(null)}>Cancelar</Button><Button variant="primary" type="submit" loading={create.isPending}>Crear directo</Button></div>
        </form>
      </Modal>
      <Modal open={!!created} title="Directo creado en YouTube" onClose={() => setCreated(null)}>
        <p className="text-sm text-ink-600 dark:text-ink-300">Ya está añadido como destino. Úsalo en una emisión y pulsa «Iniciar»: el directo de YouTube arrancará solo al recibir la señal.</p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href={created?.watchUrl} target="_blank" rel="noreferrer" className={buttonCls('secondary')}><ExternalLink className="size-4" />Ver en YouTube</a>
          <a href={created?.studioUrl} target="_blank" rel="noreferrer" className={buttonCls('secondary')}><ExternalLink className="size-4" />Abrir YouTube Studio</a>
          <Link to="/app/streams/new" className={buttonCls('primary')}>Crear emisión</Link>
        </div>
      </Modal>
    </Card>
  );
}

export function Destinations() {
  useTitle('Destinos');
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
      <YoutubeConnect onCreated={refresh} />
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
                      {d.secure ? <Badge tone="ok"><Lock className="size-3" />RTMPS</Badge> : <Badge tone="warn"><LockOpen className="size-3" />Sin cifrar</Badge>}
                      {d.youtube && <a href={d.youtube.watchUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-red-500 hover:underline"><Youtube className="size-3.5" />Ver directo</a>}</p>
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
