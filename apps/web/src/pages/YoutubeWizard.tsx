/**
 * Asistente «Directo 24/7 en YouTube» para un canal conectado con Google.
 * 1 · Contenido: playlist existente o nueva (vídeos de la biblioteca + subida aquí mismo, en paralelo).
 * 2 · Directo: título, descripción, visibilidad, calidad y modo.
 * 3 · Revisar: crear y emitir ahora, o dejarlo preparado.
 * Usa solo la API pública de la plataforma; cada paso se valida antes de avanzar.
 */
import { type FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CloudUpload, Film, ListVideo, Loader2, Radio } from 'lucide-react';
import { ApiError, type Media, type Playlist, type Stream, type YoutubeAccount, api, fmtDuration, fmtSpeed, get, uploadFile } from '../api';
import { YoutubeIcon } from '../brand';
import { useMe } from '../hooks';
import { Button, Field, Input, Modal, Progress, StatusBadge, cx, errMsg, inputCls, toast } from '../ui';
import { useMedia } from './Library';
import { usePlaylists } from './Playlists';

interface Upload { key: string; name: string; pct: number; speed: number; mediaId?: string; error?: string }
type Step = 1 | 2 | 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function YoutubeWizard({ account, open, onClose }: { account: YoutubeAccount; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const me = useMe();
  const media = useMedia();
  const playlists = usePlaylists();
  const fileInput = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>(1);
  const [source, setSource] = useState<'new' | 'existing'>('new');
  const [playlistId, setPlaylistId] = useState('');
  const [playlistName, setPlaylistName] = useState(`Directo 24/7 · ${account.title}`.slice(0, 120));
  const [selected, setSelected] = useState<string[]>([]);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [details, setDetails] = useState({ title: '', description: '', privacy: 'public', kids: 'no', profile: '720p30', mode: 'loop' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Lo ya creado en un intento anterior se reutiliza al reintentar (sin duplicar playlists, directos ni emisiones).
  const [made, setMade] = useState<{ playlistId?: string; destinationId?: string; streamId?: string }>({});

  const videos = (media.data?.items ?? []).filter((m) => m.kind === 'video' || (m.kind === null && m.status !== 'failed'));
  const byId = new Map(videos.map((m) => [m.id, m]));
  const published = (playlists.data?.items ?? []).filter((p) => p.published);
  const profiles = me.data?.current.limits.profiles ?? ['720p30'];
  const chosenPlaylist = published.find((p) => p.id === playlistId);
  const pendingUploads = uploads.filter((u) => !u.mediaId && !u.error).length;
  const notReady = selected.filter((id) => byId.get(id)?.status !== 'ready');
  const contentOk = source === 'existing' ? !!chosenPlaylist : selected.length > 0 && playlistName.trim().length > 0;

  function reset() {
    setStep(1); setError(null); setBusy(null); setUploads([]); setSelected([]); setMade({});
  }
  function close() { if (!busy) { reset(); onClose(); } }

  function addFiles(files: FileList) {
    const list = [...files];
    const batch = list.map((f, i) => ({ key: `${f.name}-${f.size}-${Date.now()}-${i}`, name: f.name, pct: 0, speed: 0 }));
    setUploads((u) => [...u, ...batch]);
    list.forEach((file, i) => {
      const key = batch[i]!.key;
      const set = (patch: Partial<Upload>) => setUploads((u) => u.map((x) => (x.key === key ? { ...x, ...patch } : x)));
      void uploadFile(file, (p) => set({ pct: p.pct, speed: p.bytesPerSec }))
        .then(async (id) => { set({ mediaId: id, pct: 100 }); setSelected((s) => (s.includes(id) ? s : [...s, id])); await qc.invalidateQueries({ queryKey: ['media'] }); })
        .catch((e) => set({ error: errMsg(e) }));
    });
  }

  /** Espera a que los vídeos elegidos estén convertidos (el servidor de conversión arranca solo). */
  async function waitReady(ids: string[]) {
    const deadline = Date.now() + 30 * 60_000;
    for (;;) {
      const items = (await get<{ items: Media[] }>('/v1/media')).items;
      const mine = items.filter((m) => ids.includes(m.id));
      const failed = mine.find((m) => m.status === 'failed');
      if (failed) throw new Error(`«${failed.filename}» no se pudo procesar: ${failed.error?.message ?? 'error'}. Quítalo de la selección.`);
      const pending = mine.filter((m) => m.status !== 'ready');
      if (!pending.length) return;
      const avg = Math.round(pending.reduce((s, m) => s + m.progress, 0) / pending.length);
      setBusy(`Preparando ${pending.length} vídeo(s) para emitir… ${avg}%`);
      if (Date.now() > deadline) throw new Error('La conversión está tardando demasiado. Vuelve a intentarlo en unos minutos.');
      await sleep(2500);
    }
  }

  async function finish(startNow: boolean) {
    setError(null);
    try {
      // 1. Playlist
      let plId = made.playlistId ?? playlistId;
      if (source === 'new' && !made.playlistId) {
        await waitReady(selected);
        setBusy('Creando la playlist…');
        const pl = await api<Playlist>('POST', '/v1/playlists', { name: playlistName.trim() });
        await api('PUT', `/v1/playlists/${pl.id}`, { items: selected.map((mediaId) => ({ mediaId })) });
        await api('POST', `/v1/playlists/${pl.id}/publish`);
        plId = pl.id;
        setMade((m) => ({ ...m, playlistId: pl.id }));
      }
      // 2. Directo en YouTube (stream + broadcast enlazados) → destino
      let destinationId = made.destinationId;
      if (!destinationId) {
        setBusy('Creando el directo en YouTube…');
        const yt = await api<{ destination: { id: string }; watchUrl: string }>('POST', `/v1/integrations/youtube/accounts/${account.id}/destination`, {
          title: details.title.trim(), description: details.description, privacy: details.privacy, madeForKids: details.kids === 'yes',
        });
        destinationId = yt.destination.id;
        setMade((m) => ({ ...m, destinationId }));
      }
      // 3. Emisión
      let streamId = made.streamId;
      if (!streamId) {
        setBusy('Creando la emisión…');
        const stream = await api<Stream>('POST', '/v1/streams', { name: details.title.trim().slice(0, 120), playlistId: plId, mode: details.mode, profile: details.profile, destinationIds: [destinationId] });
        streamId = stream.id;
        setMade((m) => ({ ...m, streamId }));
      }
      // 4. Inicio (si falta convertir a otra calidad, la API lo encola: se reintenta solo)
      if (startNow) {
        setBusy('Iniciando la emisión…');
        for (let i = 0; ; i++) {
          try { await api('POST', `/v1/streams/${streamId}/start`); break; } catch (e) {
            if (e instanceof ApiError && e.code === 'media_preparing' && i < 360) { setBusy(`Convirtiendo los vídeos a ${details.profile}…`); await sleep(5000); continue; }
            throw e;
          }
        }
      }
      await Promise.all(['streams', 'playlists', 'destinations', 'overview'].map((k) => qc.invalidateQueries({ queryKey: [k] })));
      toast(startNow ? 'Emisión iniciada: YouTube la pondrá en directo al recibir la señal.' : 'Directo preparado. Inícialo cuando quieras.');
      reset(); onClose();
      nav(`/app/streams/${streamId}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(null);
    }
  }

  const stepsUi = (
    <ol className="mb-5 flex items-center gap-2 text-xs font-semibold">
      {(['Contenido', 'Directo', 'Revisar'] as const).map((l, i) => (
        <li key={l} className={cx('flex items-center gap-1.5 sm:gap-2', step === i + 1 ? 'text-ink-900 dark:text-white' : 'text-ink-400')}>
          <span className={cx('flex size-6 items-center justify-center rounded-full', step > i + 1 ? 'bg-emerald-500 text-white' : step === i + 1 ? 'bg-signal text-white' : 'bg-ink-100 dark:bg-white/[0.06]')}>{step > i + 1 ? <Check className="size-3.5" /> : i + 1}</span>
          <span className={cx(step !== i + 1 && 'max-sm:hidden')}>{l}</span>{i < 2 && <span className="mx-1 h-px w-4 bg-ink-200 sm:w-5 dark:bg-white/10" />}
        </li>
      ))}
    </ol>
  );

  return (
    <Modal open={open} title={`Directo 24/7 en ${account.title}`} onClose={close}>
      {stepsUi}

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Origen del contenido">
            {([['new', 'Elegir vídeos'], ['existing', 'Usar una playlist']] as const).map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={source === k} onClick={() => setSource(k)}
                className={cx('rounded-xl px-3 py-2.5 text-sm font-semibold ring-1 transition', source === k ? 'bg-ink-900 text-white ring-ink-900 dark:bg-white dark:text-ink-950 dark:ring-white' : 'ring-ink-200 dark:ring-white/10')}>{l}</button>
            ))}
          </div>

          {source === 'existing' ? (
            published.length === 0
              ? <p className="rounded-xl bg-ink-50 px-4 py-3 text-sm text-ink-500 dark:bg-white/[0.03]">Aún no tienes playlists publicadas. Elige «Elegir vídeos» para crear una aquí mismo.</p>
              : <ul className="max-h-72 space-y-2 overflow-y-auto">
                  {published.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => setPlaylistId(p.id)} className={cx('flex w-full items-center gap-3 rounded-xl px-4 py-3 text-left ring-1 transition', playlistId === p.id ? 'bg-air-500/[0.07] ring-air-500/50' : 'ring-ink-200 hover:bg-ink-50 dark:ring-white/10 dark:hover:bg-white/[0.03]')}>
                        <ListVideo className="size-5 shrink-0 text-air-500" />
                        <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{p.name}</span><span className="text-xs text-ink-500">{p.published!.itemCount} vídeo(s) · {fmtDuration(p.totalDurationSec)}</span></span>
                        {playlistId === p.id && <Check className="size-4 text-air-500" />}
                      </button>
                    </li>
                  ))}
                </ul>
          ) : (
            <>
              <Field label="Nombre de la playlist">{(id) => <Input id={id} value={playlistName} onChange={(e) => setPlaylistName(e.target.value)} maxLength={120} />}</Field>
              <input ref={fileInput} type="file" multiple hidden accept=".mp4,.mov,.mkv,.webm,.m4v" onChange={(e) => { if (e.target.files?.length) addFiles(e.target.files); e.target.value = ''; }} />
              <button type="button" onClick={() => fileInput.current?.click()} className="flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink-300 py-4 text-sm font-semibold transition hover:border-air-500 dark:border-white/15">
                <CloudUpload className="size-5 text-air-500" />Subir vídeos nuevos aquí
              </button>
              {uploads.filter((u) => !u.mediaId || u.error).map((u) => (
                <div key={u.key} className="text-sm">
                  <div className="mb-1 flex justify-between gap-3"><span className="truncate">{u.name}</span><span className="shrink-0 font-mono text-xs text-ink-500">{u.error ? 'Error' : `${Math.floor(u.pct)}%${u.speed ? ` · ${fmtSpeed(u.speed)}` : ''}`}</span></div>
                  {u.error ? <p className="text-xs text-red-500">{u.error}</p> : <Progress value={u.pct} />}
                </div>
              ))}
              <div>
                <p className="mb-2 text-sm font-semibold">Vídeos de tu biblioteca <span className="font-normal text-ink-500">({selected.length} elegidos, en este orden)</span></p>
                {videos.length === 0 ? <p className="text-sm text-ink-500">Sube tus vídeos con el botón de arriba.</p> : (
                  <ul className="max-h-64 space-y-1.5 overflow-y-auto pr-1">
                    {videos.map((m) => {
                      const pos = selected.indexOf(m.id);
                      return (
                        <li key={m.id}>
                          <label className={cx('flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2 ring-1 transition', pos >= 0 ? 'bg-air-500/[0.06] ring-air-500/40' : 'ring-ink-200 dark:ring-white/[0.08]')}>
                            <input type="checkbox" className="size-4 accent-[#ff4f2e]" checked={pos >= 0} disabled={m.status === 'failed'}
                              onChange={() => setSelected((s) => (pos >= 0 ? s.filter((x) => x !== m.id) : [...s, m.id]))} />
                            {m.hasThumbnail ? <img src={`/v1/media/${m.id}/thumbnail`} alt="" className="h-9 w-16 shrink-0 rounded-md object-cover" loading="lazy" /> : <span className="flex h-9 w-16 shrink-0 items-center justify-center rounded-md bg-ink-100 dark:bg-white/[0.05]"><Film className="size-4 text-ink-400" /></span>}
                            <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{m.filename}</span><span className="text-xs text-ink-500">{fmtDuration(m.durationSec)}</span></span>
                            {m.status !== 'ready' ? <StatusBadge status={m.status} /> : pos >= 0 ? <span className="font-mono text-xs font-bold text-air-500">#{pos + 1}</span> : null}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {notReady.length > 0 && <p className="mt-2 text-xs text-ink-500">{notReady.length} vídeo(s) aún se están preparando: puedes seguir, la emisión esperará a que terminen.</p>}
              </div>
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" onClick={close}>Cancelar</Button>
            <Button variant="primary" type="button" disabled={!contentOk || pendingUploads > 0} onClick={() => setStep(2)}>{pendingUploads ? `Subiendo ${pendingUploads}…` : 'Siguiente'}</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); setStep(3); }}>
          <Field label="Título del directo en YouTube" hint="Máximo 100 caracteres.">{(id) => <Input id={id} required maxLength={100} value={details.title} onChange={(e) => setDetails({ ...details, title: e.target.value })} placeholder="🔴 EN VIVO 24/7 | Canciones infantiles" />}</Field>
          <Field label="Descripción">{(id) => <textarea id={id} rows={3} maxLength={4900} className={cx(inputCls, 'h-auto py-2.5')} value={details.description} onChange={(e) => setDetails({ ...details, description: e.target.value })} />}</Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Visibilidad">{(id) => <select id={id} className={inputCls} value={details.privacy} onChange={(e) => setDetails({ ...details, privacy: e.target.value })}><option value="public">Público</option><option value="unlisted">Oculto</option><option value="private">Privado</option></select>}</Field>
            <Field label="¿Creado para niños?">{(id) => <select id={id} className={inputCls} value={details.kids} onChange={(e) => setDetails({ ...details, kids: e.target.value })}><option value="no">No</option><option value="yes">Sí</option></select>}</Field>
            <Field label="Calidad">{(id) => <select id={id} className={inputCls} value={details.profile} onChange={(e) => setDetails({ ...details, profile: e.target.value })}>{profiles.map((p) => <option key={p} value={p}>{p === '1080p30' ? '1080p · 30 fps' : '720p · 30 fps (recomendado)'}</option>)}</select>}</Field>
            <Field label="Reproducción">{(id) => <select id={id} className={inputCls} value={details.mode} onChange={(e) => setDetails({ ...details, mode: e.target.value })}><option value="loop">Bucle infinito (24/7)</option><option value="shuffle">Aleatorio sin repetir</option><option value="once">Una sola vez</option></select>}</Field>
          </div>
          {details.kids === 'yes' && <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">YouTube desactiva el chat y la publicidad personalizada en el contenido creado para niños.</p>}
          <div className="flex justify-between gap-2 pt-2">
            <Button type="button" onClick={() => setStep(1)}>Atrás</Button>
            <Button variant="primary" type="submit">Siguiente</Button>
          </div>
        </form>
      )}

      {step === 3 && (
        <div className="space-y-4">
          <dl className="divide-y divide-ink-100 rounded-xl text-sm ring-1 ring-ink-200 dark:divide-white/[0.06] dark:ring-white/10">
            {[
              ['Canal', <span key="c" className="flex items-center gap-2"><YoutubeIcon className="size-4" />{account.title}</span>],
              ['Contenido', source === 'existing' ? chosenPlaylist?.name : `${playlistName} (${selected.length} vídeos)`],
              ['Título', details.title],
              ['Visibilidad', { public: 'Público', unlisted: 'Oculto', private: 'Privado' }[details.privacy]],
              ['Calidad y modo', `${details.profile === '1080p30' ? '1080p' : '720p'} · ${{ loop: 'bucle infinito', shuffle: 'aleatorio', once: 'una vez' }[details.mode]}`],
            ].map(([k, v]) => <div key={String(k)} className="flex justify-between gap-4 px-4 py-2.5"><dt className="text-ink-500">{k}</dt><dd className="min-w-0 truncate text-right font-medium">{v}</dd></div>)}
          </dl>
          <p className="text-xs text-ink-500">El directo de YouTube empieza solo en cuanto llega la señal (unos 20–40 s). Puedes cerrar el navegador: la emisión sigue desde la nube.</p>
          {busy && <p className="flex items-center gap-2 rounded-xl bg-sky-500/10 px-4 py-3 text-sm text-sky-800 dark:text-sky-200"><Loader2 className="size-4 animate-spin" />{busy}</p>}
          {error && <p role="alert" className="rounded-xl bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
          <div className="flex flex-wrap justify-between gap-2 pt-2">
            <Button type="button" onClick={() => setStep(2)} disabled={!!busy}>Atrás</Button>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => finish(false)} disabled={!!busy}>Crear sin emitir</Button>
              <Button variant="primary" type="button" onClick={() => finish(true)} loading={!!busy}><Radio className="size-4" />Crear y emitir ahora</Button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
