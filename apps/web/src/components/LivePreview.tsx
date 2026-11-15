/**
 * Monitor del directo: imagen y sonido REALES de la señal que sale hacia los destinos (no una imagen fija).
 * El motor solo genera la vista previa mientras alguien la mira. Incluye vúmetros L/R (RMS y pico), alertas de
 * silencio y saturación, latencia, bitrate, resolución y FPS medidos en el propio reproductor.
 */
import { useEffect, useRef, useState } from 'react';
import type HlsType from 'hls.js';
import { Maximize2, PictureInPicture2, Volume2, VolumeX } from 'lucide-react';
import { Button, cx } from '../ui';

interface Stats { latency: number | null; kbps: number | null; width: number; height: number; fps: number | null; dropped: number }
interface Meter { rmsL: number; rmsR: number; peakL: number; peakR: number }
const dbfs = (v: number) => (v <= 0.00001 ? -100 : 20 * Math.log10(v));
const pct = (db: number) => Math.max(0, Math.min(100, ((db + 60) / 60) * 100));

export function LivePreview({ streamId, live }: { streamId: string; live: boolean }) {
  const video = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsType | null>(null);
  const audio = useRef<{ ctx: AudioContext; gain: GainNode; l: AnalyserNode; r: AnalyserNode } | null>(null);
  const [phase, setPhase] = useState<'off' | 'starting' | 'playing' | 'error'>('off');
  const [message, setMessage] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [stats, setStats] = useState<Stats | null>(null);
  const [meter, setMeter] = useState<Meter>({ rmsL: 0, rmsR: 0, peakL: 0, peakR: 0 });
  const [silentFor, setSilentFor] = useState(0);
  const [clips, setClips] = useState(0);
  const [nativeHls, setNativeHls] = useState(false);
  const url = `/v1/streams/${streamId}/preview.m3u8`;

  // Arranque: espera a que el motor tenga fragmentos (la primera petición le avisa de que alguien mira).
  useEffect(() => {
    if (!live || phase !== 'starting') return;
    let stop = false;
    let tries = 0;
    const boot = async () => {
      while (!stop) {
        const res = await fetch(url, { credentials: 'include' }).catch(() => null);
        if (res?.ok) break;
        const j = res ? await res.json().catch(() => null) : null;
        if (res?.status === 409) { setPhase('error'); setMessage(j?.error?.message ?? 'La emisión no está en marcha.'); return; }
        setMessage(j?.error?.message ?? 'Preparando la vista previa…');
        if (++tries > 30) { setPhase('error'); setMessage('El motor no ha publicado la vista previa. Comprueba el registro de eventos.'); return; }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (stop) return;
      const v = video.current!;
      const Hls = (await import('hls.js')).default;
      if (Hls.isSupported()) {
        const hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 2, maxBufferLength: 10, backBufferLength: 10, xhrSetup: (x) => { x.withCredentials = true; } });
        hlsRef.current = hls;
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          if (d.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls.startLoad(), 2000);
          else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else { setPhase('error'); setMessage('El reproductor no pudo continuar. Pulsa «Reintentar».'); }
        });
        let bytes = 0, secs = 0;
        hls.on(Hls.Events.FRAG_LOADED, (_e, d) => { bytes += d.frag.stats.total; secs += d.frag.duration; if (secs > 0) setStats((s) => ({ ...(s ?? { latency: null, kbps: null, width: 0, height: 0, fps: null, dropped: 0 }), kbps: Math.round((bytes * 8) / secs / 1000) })); if (secs > 30) { bytes = 0; secs = 0; } });
        hls.loadSource(url);
        hls.attachMedia(v);
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        setNativeHls(true);
        v.src = url;
      } else { setPhase('error'); setMessage('Este navegador no puede reproducir vídeo HLS.'); return; }
      v.muted = true;
      await v.play().catch(() => {});
      setPhase('playing');
      setMessage(null);
    };
    void boot();
    return () => { stop = true; };
  }, [phase, live, url]);

  // Parar todo al salir, al detener la emisión o al pulsar «Detener».
  const teardown = () => {
    hlsRef.current?.destroy(); hlsRef.current = null;
    if (video.current) { video.current.removeAttribute('src'); video.current.load(); }
    void audio.current?.ctx.close(); audio.current = null;
    setListening(false); setStats(null); setSilentFor(0); setClips(0);
  };
  useEffect(() => () => teardown(), []);
  useEffect(() => { if (!live && phase !== 'off') { teardown(); setPhase('off'); } }, [live]);

  // Estadísticas del reproductor
  useEffect(() => {
    if (phase !== 'playing') return;
    let lastFrames = 0, lastT = performance.now();
    const t = setInterval(() => {
      const v = video.current;
      if (!v) return;
      const q = v.getVideoPlaybackQuality?.();
      const now = performance.now();
      const frames = q?.totalVideoFrames ?? 0;
      const fps = lastFrames && frames >= lastFrames ? ((frames - lastFrames) * 1000) / (now - lastT) : null;
      lastFrames = frames; lastT = now;
      const end = v.seekable.length ? v.seekable.end(v.seekable.length - 1) : null;
      setStats((s) => ({ kbps: s?.kbps ?? null, latency: hlsRef.current?.latency ?? (end ? end - v.currentTime : null), width: v.videoWidth, height: v.videoHeight, fps: fps && !v.paused ? fps : null, dropped: q?.droppedVideoFrames ?? 0 }));
    }, 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Escuchar y medir el audio: requiere un toque del usuario (política de reproducción automática del navegador).
  const enableAudio = async () => {
    const v = video.current;
    if (!v) return;
    if (!audio.current) {
      const ctx = new AudioContext();
      const src = ctx.createMediaElementSource(v);
      const split = ctx.createChannelSplitter(2);
      const l = ctx.createAnalyser(), r = ctx.createAnalyser();
      l.fftSize = r.fftSize = 2048;
      const gain = ctx.createGain();
      src.connect(split); split.connect(l, 0); split.connect(r, 1);
      src.connect(gain); gain.connect(ctx.destination);
      audio.current = { ctx, gain, l, r };
    }
    await audio.current.ctx.resume();
    v.muted = false;
    audio.current.gain.gain.value = volume;
    setListening(true);
  };
  const toggleListen = () => {
    if (!audio.current) return void enableAudio();
    const next = !listening;
    audio.current.gain.gain.value = next ? volume : 0; // los vúmetros siguen midiendo aunque no lo oigas
    setListening(next);
  };
  useEffect(() => { if (audio.current && listening) audio.current.gain.gain.value = volume; }, [volume, listening]);

  // Vúmetros (≈ 20 lecturas por segundo) y detección de silencio / saturación
  useEffect(() => {
    if (!audio.current || phase !== 'playing') return;
    const a = audio.current;
    const buf = new Float32Array(a.l.fftSize);
    let silentSince: number | null = null, raf = 0, last = 0;
    const read = (n: AnalyserNode) => { n.getFloatTimeDomainData(buf); let s = 0, p = 0; for (const x of buf) { s += x * x; const ax = Math.abs(x); if (ax > p) p = ax; } return { rms: Math.sqrt(s / buf.length), peak: p }; };
    const tick = (t: number) => {
      raf = requestAnimationFrame(tick);
      if (t - last < 50) return;
      last = t;
      const L = read(a.l), R = read(a.r);
      setMeter((m) => ({ rmsL: L.rms, rmsR: R.rms, peakL: Math.max(L.peak, m.peakL * 0.94), peakR: Math.max(R.peak, m.peakR * 0.94) }));
      if (L.peak >= 0.999 || R.peak >= 0.999) setClips((c) => c + 1);
      const quiet = dbfs(Math.max(L.rms, R.rms)) < -50;
      if (quiet && !video.current?.paused) { silentSince ??= t; setSilentFor((t - silentSince) / 1000); } else { silentSince = null; setSilentFor(0); }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, listening]);

  const bar = (rms: number, peak: number, label: string) => {
    const db = dbfs(rms);
    return (
      <div className="flex items-center gap-2">
        <span className="w-3 font-mono text-[10px] text-ink-400">{label}</span>
        <div className="relative h-2.5 flex-1 overflow-hidden rounded-full bg-ink-200 dark:bg-white/10">
          <div className="absolute inset-y-0 left-0 rounded-full bg-gradient-to-r from-emerald-500 via-lime-400 via-75% to-red-500 transition-[width] duration-75" style={{ width: `${pct(db)}%` }} />
          <div className="absolute inset-y-0 w-0.5 bg-ink-900 dark:bg-white" style={{ left: `${pct(dbfs(peak))}%` }} />
        </div>
        <span className="w-14 text-right font-mono text-[10px] tabular-nums text-ink-500">{db <= -99 ? '−∞' : db.toFixed(1)} dB</span>
      </div>
    );
  };

  if (!live) {
    return (
      <div className="flex aspect-video flex-col items-center justify-center gap-2 rounded-xl bg-ink-100 p-4 text-center text-sm text-ink-500 dark:bg-ink-800">
        La vista previa aparece cuando la emisión está en marcha.
      </div>
    );
  }
  return (
    <div>
      <div className="relative overflow-hidden rounded-xl bg-black">
        <video ref={video} playsInline className="aspect-video w-full" aria-label="Vista previa del directo" />
        {phase !== 'playing' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-ink-950/80 p-4 text-center text-sm text-white">
            {phase === 'off' && <><p>Mira y escucha la señal exacta que reciben tus destinos.</p><Button variant="primary" onClick={() => setPhase('starting')}>Ver el directo</Button></>}
            {phase === 'starting' && <p className="shimmer rounded-lg px-3 py-1.5">{message ?? 'Pidiendo la vista previa al motor…'}</p>}
            {phase === 'error' && <><p>{message}</p><Button onClick={() => { teardown(); setPhase('starting'); }}>Reintentar</Button></>}
          </div>
        )}
        {phase === 'playing' && (
          <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"><span className="live-dot size-1.5 rounded-full bg-white" />Señal de salida</div>
        )}
      </div>
      {phase === 'playing' && (
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button className="h-8" variant={listening ? 'primary' : 'secondary'} onClick={toggleListen}>{listening ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}{listening ? 'Escuchando' : audio.current ? 'Silenciado' : 'Escuchar y medir audio'}</Button>
            {audio.current && <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volumen" className="w-24 accent-[#ff4f2e]" />}
            <div className="ml-auto flex gap-1">
              {'pictureInPictureEnabled' in document && <Button variant="ghost" className="h-8 px-2" aria-label="Imagen en imagen" onClick={() => video.current?.requestPictureInPicture().catch(() => {})}><PictureInPicture2 className="size-4" /></Button>}
              <Button variant="ghost" className="h-8 px-2" aria-label="Pantalla completa" onClick={() => video.current?.requestFullscreen?.().catch(() => {})}><Maximize2 className="size-4" /></Button>
              <Button variant="ghost" className="h-8" onClick={() => { teardown(); setPhase('off'); }}>Cerrar</Button>
            </div>
          </div>
          {audio.current ? (
            <div className="space-y-1.5 rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]">
              {bar(meter.rmsL, meter.peakL, 'L')}{bar(meter.rmsR, meter.peakR, 'R')}
              {silentFor >= 5 && <p role="alert" className="text-xs font-medium text-amber-700 dark:text-amber-300">Sin audio audible desde hace {Math.round(silentFor)} s. Comprueba que el vídeo tiene sonido.</p>}
              {clips > 3 && <p role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">Audio saturado (picos a 0 dBFS): puede sonar distorsionado.</p>}
              {nativeHls && <p className="text-[11px] text-ink-500">Safari no permite medir el audio de vídeo HLS: los vúmetros pueden marcar cero aunque se oiga bien.</p>}
            </div>
          ) : <p className="text-xs text-ink-500">Pulsa «Escuchar y medir audio» para oír el directo y ver los niveles L/R.</p>}
          {stats && (
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              {[
                ['Resolución', stats.width ? `${stats.width}×${stats.height}` : '—'],
                ['FPS en pantalla', stats.fps ? stats.fps.toFixed(1) : '—'],
                ['Bitrate', stats.kbps ? `${stats.kbps.toLocaleString('es-ES')} kb/s` : '—'],
                ['Retraso', stats.latency != null ? `${stats.latency.toFixed(1)} s` : '—'],
              ].map(([k, v]) => <div key={k} className="rounded-lg bg-ink-50 px-2.5 py-2 dark:bg-white/[0.03]"><dt className="text-ink-500">{k}</dt><dd className={cx('mt-0.5 font-mono font-semibold tabular-nums')}>{v}</dd></div>)}
            </dl>
          )}
          <p className="text-[11px] text-ink-500">Retraso de la vista previa respecto a la salida: unos segundos. Lo que ves y oyes es la señal real enviada a los destinos, sin recodificar.</p>
        </div>
      )}
    </div>
  );
}

