/**
 * Estudio de miniaturas: compone una portada 1280×720 en el navegador (sin subir nada hasta guardar).
 * Fondo desde imagen propia, fotograma del vídeo o degradado; título y subtítulo con contorno y sombra; logotipo;
 * distintivo «EN DIRECTO»; zona segura de YouTube; exporta a JPG por debajo de 2 MB (límite de YouTube).
 */
import { type DragEvent, type PointerEvent as RPointerEvent, useEffect, useRef, useState } from 'react';
import { Camera, ImagePlus, LayoutTemplate, Stamp, Trash2, Type, Upload } from 'lucide-react';
import { api } from '../api';
import { Button, Modal, cx, errMsg, inputCls, toast } from '../ui';

export type ThumbEntity = 'media' | 'playlist' | 'stream' | 'recording';
const W = 1280, H = 720;
const FONTS = [
  { id: 'Inter, system-ui, sans-serif', label: 'Moderna' },
  { id: '"Arial Black", Impact, sans-serif', label: 'Impacto' },
  { id: 'Impact, "Arial Narrow", sans-serif', label: 'Condensada' },
  { id: 'Georgia, "Times New Roman", serif', label: 'Clásica' },
  { id: '"Trebuchet MS", system-ui, sans-serif', label: 'Amable' },
];
interface Layer { text: string; size: number; color: string; x: number; y: number }
interface State {
  bgColorA: string; bgColorB: string; angle: number; dim: number;
  title: Layer; subtitle: Layer; font: string; align: CanvasTextAlign; stroke: boolean; shadow: boolean;
  badge: boolean; badgeText: string; logoCorner: 'tl' | 'tr' | 'bl' | 'br'; logoSize: number; safe: boolean;
}
const TEMPLATES: { name: string; s: Partial<State> }[] = [
  { name: 'Directo 24/7', s: { bgColorA: '#1b1036', bgColorB: '#ff4f2e', angle: 35, dim: 0.35, align: 'left', badge: true, title: { text: 'EN DIRECTO 24/7', size: 120, color: '#ffffff', x: 80, y: 360 }, subtitle: { text: 'Música sin pausa', size: 56, color: '#ffd8cc', x: 84, y: 450 } } },
  { name: 'Centrado', s: { bgColorA: '#0b1220', bgColorB: '#1e3a8a', angle: 90, dim: 0.45, align: 'center', badge: false, title: { text: 'TÍTULO', size: 140, color: '#ffffff', x: 640, y: 380 }, subtitle: { text: 'Subtítulo', size: 54, color: '#c7d2fe', x: 640, y: 470 } } },
  { name: 'Lo-fi', s: { bgColorA: '#ffb199', bgColorB: '#7b2ff7', angle: 140, dim: 0.2, align: 'left', badge: true, title: { text: 'lofi beats', size: 130, color: '#fff7ed', x: 90, y: 560 }, subtitle: { text: 'para estudiar y relajarse', size: 52, color: '#fde68a', x: 94, y: 640 } } },
  { name: 'Noticias', s: { bgColorA: '#111827', bgColorB: '#b91c1c', angle: 0, dim: 0.5, align: 'left', badge: true, badgeText: 'AHORA', title: { text: 'ÚLTIMA HORA', size: 110, color: '#ffffff', x: 70, y: 600 }, subtitle: { text: '', size: 50, color: '#fecaca', x: 74, y: 670 } } },
];
const DEFAULT: State = {
  bgColorA: '#1b1036', bgColorB: '#ff4f2e', angle: 35, dim: 0.3, font: FONTS[1]!.id, align: 'left', stroke: true, shadow: true,
  title: { text: '', size: 112, color: '#ffffff', x: 80, y: 380 }, subtitle: { text: '', size: 52, color: '#ffe4dc', x: 84, y: 460 },
  badge: false, badgeText: 'EN DIRECTO', logoCorner: 'tr', logoSize: 160, safe: true,
};

function loadImage(src: string | Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
    img.src = typeof src === 'string' ? src : URL.createObjectURL(src);
  });
}
const cover = (ctx: CanvasRenderingContext2D, img: CanvasImageSource & { width: number; height: number }) => {
  const r = Math.max(W / img.width, H / img.height);
  const w = img.width * r, h = img.height * r;
  ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
};

export function ThumbnailStudio({ open, onClose, entity, id, name, videoSrc, initialSrc, onSaved }: {
  open: boolean; onClose: () => void; entity: ThumbEntity; id: string; name: string;
  /** Vídeo del que capturar fotogramas (opcional). */ videoSrc?: string;
  /** Miniatura actual (para partir de ella). */ initialSrc?: string;
  onSaved?: (r: { youtube?: { ok: boolean; name: string; error?: string }[] | null }) => void;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [st, setSt] = useState<State>({ ...DEFAULT, title: { ...DEFAULT.title, text: name.slice(0, 40) } });
  const [bg, setBg] = useState<CanvasImageSource & { width: number; height: number } | null>(null);
  const [logo, setLogo] = useState<HTMLImageElement | null>(null);
  const [drag, setDrag] = useState<'title' | 'subtitle' | null>(null);
  const [saving, setSaving] = useState(false);
  const [size, setSize] = useState<number | null>(null);
  const [tab, setTab] = useState<'bg' | 'text' | 'extra'>('bg');
  const set = (p: Partial<State>) => setSt((s) => ({ ...s, ...p }));
  const setLayer = (k: 'title' | 'subtitle', p: Partial<Layer>) => setSt((s) => ({ ...s, [k]: { ...s[k], ...p } }));

  useEffect(() => { if (open && initialSrc) loadImage(initialSrc).then(setBg).catch(() => {}); }, [open, initialSrc]);

  // Dibujo
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (!ctx) return;
    ctx.save();
    ctx.clearRect(0, 0, W, H);
    const rad = (st.angle * Math.PI) / 180;
    const g = ctx.createLinearGradient(W / 2 - Math.cos(rad) * W / 2, H / 2 - Math.sin(rad) * H / 2, W / 2 + Math.cos(rad) * W / 2, H / 2 + Math.sin(rad) * H / 2);
    g.addColorStop(0, st.bgColorA); g.addColorStop(1, st.bgColorB);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    if (bg) cover(ctx, bg);
    if (st.dim > 0) {
      const d = ctx.createLinearGradient(0, 0, 0, H);
      d.addColorStop(0, `rgba(0,0,0,${st.dim * 0.5})`); d.addColorStop(1, `rgba(0,0,0,${Math.min(0.9, st.dim * 1.6)})`);
      ctx.fillStyle = d; ctx.fillRect(0, 0, W, H);
    }
    for (const k of ['title', 'subtitle'] as const) {
      const l = st[k];
      if (!l.text) continue;
      ctx.font = `${k === 'title' ? 800 : 600} ${l.size}px ${st.font}`;
      ctx.textAlign = st.align; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = st.shadow ? 'rgba(0,0,0,0.55)' : 'transparent'; ctx.shadowBlur = st.shadow ? l.size * 0.25 : 0; ctx.shadowOffsetY = st.shadow ? l.size * 0.06 : 0;
      if (st.stroke) { ctx.lineWidth = Math.max(3, l.size * 0.08); ctx.strokeStyle = 'rgba(0,0,0,0.85)'; ctx.lineJoin = 'round'; ctx.strokeText(l.text, l.x, l.y, W - 120); }
      ctx.fillStyle = l.color; ctx.fillText(l.text, l.x, l.y, W - 120);
    }
    ctx.shadowColor = 'transparent';
    if (st.badge && st.badgeText) {
      ctx.font = `800 38px Inter, system-ui, sans-serif`; ctx.textAlign = 'left';
      const tw = ctx.measureText(st.badgeText).width, bx = 60, by = 56, bh = 64;
      ctx.fillStyle = '#e11d48'; ctx.beginPath(); ctx.roundRect(bx, by, tw + 92, bh, 16); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(bx + 34, by + bh / 2, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillText(st.badgeText, bx + 60, by + 46);
    }
    if (logo) {
      const lw = st.logoSize, lh = (logo.height / logo.width) * lw, m = 48;
      const x = st.logoCorner.endsWith('l') ? m : W - lw - m, y = st.logoCorner.startsWith('t') ? m : H - lh - m;
      ctx.drawImage(logo, x, y, lw, lh);
    }
    ctx.restore();
  }, [st, bg, logo]);

  const pickFile = (accept: (f: File) => void) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = 'image/png,image/jpeg,image/webp';
    i.onchange = () => { const f = i.files?.[0]; if (f) accept(f); };
    i.click();
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f?.type.startsWith('image/')) loadImage(f).then(setBg).catch((x) => toast(errMsg(x), 'error'));
  };
  const captureFrame = async () => {
    const v = video.current;
    if (!v || !v.videoWidth) return toast('El vídeo aún no ha cargado.', 'error');
    setBg(await createImageBitmap(v));
  };

  // Arrastrar los textos sobre el lienzo
  const toCanvas = (e: RPointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const onDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    const p = toCanvas(e);
    const near = (l: Layer) => Math.abs(p.y - (l.y - l.size / 3)) < l.size * 0.7;
    const hit = st.subtitle.text && near(st.subtitle) ? 'subtitle' : st.title.text && near(st.title) ? 'title' : null;
    if (hit) { setDrag(hit); e.currentTarget.setPointerCapture(e.pointerId); }
  };
  const onMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const p = toCanvas(e);
    setLayer(drag, { x: Math.round(p.x), y: Math.round(p.y + st[drag].size / 3) });
  };

  const exportJpeg = async (): Promise<Blob> => {
    for (const q of [0.92, 0.85, 0.75, 0.62, 0.5]) {
      const b = await new Promise<Blob | null>((r) => canvas.current!.toBlob(r, 'image/jpeg', q));
      if (b && b.size <= 2 * 1024 * 1024 - 1024) return b;
    }
    throw new Error('No se pudo reducir la miniatura por debajo de 2 MB.');
  };
  const save = async () => {
    setSaving(true);
    try {
      const blob = await exportJpeg();
      setSize(blob.size);
      const r = await api<{ youtube?: { ok: boolean; name: string; error?: string }[] | null }>('PUT', `/v1/thumbnails/${entity}/${id}`, undefined, blob);
      toast('Miniatura guardada');
      const yt = r.youtube ?? [];
      for (const y of yt) toast(y.ok ? `Miniatura enviada a YouTube (${y.name})` : `YouTube (${y.name}): ${y.error}`, y.ok ? 'ok' : 'error');
      onSaved?.(r);
      onClose();
    } catch (e) { toast(errMsg(e), 'error'); } finally { setSaving(false); }
  };
  const download = async () => {
    const b = await exportJpeg();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(b); a.download = `${name.replace(/[^\w\- ]/g, '_').slice(0, 60) || 'miniatura'}.jpg`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };

  const tabBtn = (k: typeof tab, label: string, Icon: typeof Type) => (
    <button type="button" onClick={() => setTab(k)} className={cx('flex flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold', tab === k ? 'bg-white shadow-sm dark:bg-ink-700' : 'text-ink-500')}><Icon className="size-3.5" />{label}</button>
  );
  const color = (label: string, v: string, on: (v: string) => void) => (
    <label className="flex items-center justify-between gap-2 text-xs text-ink-600 dark:text-ink-300">{label}<input type="color" value={v} onChange={(e) => on(e.target.value)} className="h-8 w-12 cursor-pointer rounded-md border-0 bg-transparent" /></label>
  );
  const range = (label: string, v: number, min: number, max: number, step: number, on: (v: number) => void) => (
    <label className="block text-xs text-ink-600 dark:text-ink-300">{label}<input type="range" min={min} max={max} step={step} value={v} onChange={(e) => on(Number(e.target.value))} className="mt-1 w-full accent-[#ff4f2e]" /></label>
  );

  return (
    <Modal open={open} onClose={onClose} title={`Miniatura · ${name}`} wide
      footer={<>
        <span className="mr-auto self-center text-xs text-ink-500">1280×720 JPG · máx. 2 MB{size ? ` · última: ${(size / 1024).toFixed(0)} KB` : ''}</span>
        <Button onClick={download}>Descargar</Button>
        <Button variant="primary" loading={saving} onClick={save}>{entity === 'stream' ? 'Guardar (y enviar a YouTube)' : 'Guardar miniatura'}</Button>
      </>}>
      <div className="grid gap-5 lg:grid-cols-[1fr_18rem]">
        <div>
          <div className="relative overflow-hidden rounded-xl ring-1 ring-ink-200 dark:ring-white/10" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
            <canvas ref={canvas} width={W} height={H} className={cx('block aspect-video w-full touch-none', drag ? 'cursor-grabbing' : 'cursor-grab')}
              onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDrag(null)} aria-label="Lienzo de la miniatura" />
            {st.safe && <div aria-hidden className="pointer-events-none absolute bottom-[3%] right-[2%] h-[9%] w-[13%] rounded border-2 border-dashed border-white/70"><span className="absolute -top-5 right-0 text-[10px] font-semibold text-white drop-shadow">duración</span></div>}
          </div>
          <p className="mt-2 text-xs text-ink-500">Arrastra los textos sobre la imagen para moverlos. Suelta una imagen encima para usarla de fondo.</p>
          {videoSrc && (
            <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl bg-ink-50 p-3 dark:bg-white/[0.03]">
              <video ref={video} src={videoSrc} controls muted playsInline preload="metadata" className="h-28 rounded-lg bg-black" />
              <div className="min-w-0 flex-1 text-xs text-ink-500">Busca el momento que quieras en el vídeo y captura ese fotograma como fondo.
                <div className="mt-2"><Button className="h-8" onClick={captureFrame}><Camera className="size-4" />Usar este fotograma</Button></div></div>
            </div>
          )}
        </div>
        <div className="space-y-4">
          <div className="flex gap-1 rounded-xl bg-ink-100 p-1 dark:bg-white/[0.05]">{tabBtn('bg', 'Fondo', ImagePlus)}{tabBtn('text', 'Texto', Type)}{tabBtn('extra', 'Extras', Stamp)}</div>
          {tab === 'bg' && (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <Button className="h-8" onClick={() => pickFile((f) => loadImage(f).then(setBg).catch((x) => toast(errMsg(x), 'error')))}><Upload className="size-4" />Subir imagen</Button>
                {bg && <Button variant="ghost" className="h-8" onClick={() => setBg(null)}><Trash2 className="size-4" />Quitar</Button>}
              </div>
              {color('Degradado: color 1', st.bgColorA, (v) => set({ bgColorA: v }))}
              {color('Degradado: color 2', st.bgColorB, (v) => set({ bgColorB: v }))}
              {range('Ángulo del degradado', st.angle, 0, 180, 5, (v) => set({ angle: v }))}
              {range('Oscurecer para leer mejor', st.dim, 0, 0.8, 0.05, (v) => set({ dim: v }))}
              <p className="flex items-center gap-1.5 pt-1 text-xs font-semibold text-ink-600 dark:text-ink-300"><LayoutTemplate className="size-3.5" />Plantillas</p>
              <div className="grid grid-cols-2 gap-2">
                {TEMPLATES.map((t) => (
                  <button key={t.name} type="button" onClick={() => setSt((s) => ({ ...s, ...t.s, title: { ...s.title, ...t.s.title, text: s.title.text || t.s.title!.text }, subtitle: { ...s.subtitle, ...t.s.subtitle, text: s.subtitle.text || t.s.subtitle!.text } }))}
                    className="h-12 rounded-lg text-xs font-bold text-white ring-1 ring-black/10" style={{ background: `linear-gradient(${(t.s.angle ?? 0) + 90}deg, ${t.s.bgColorA}, ${t.s.bgColorB})` }}>{t.name}</button>
                ))}
              </div>
            </div>
          )}
          {tab === 'text' && (
            <div className="space-y-3">
              <input className={inputCls} placeholder="Título" value={st.title.text} maxLength={60} onChange={(e) => setLayer('title', { text: e.target.value })} aria-label="Título" />
              <input className={inputCls} placeholder="Subtítulo (opcional)" value={st.subtitle.text} maxLength={80} onChange={(e) => setLayer('subtitle', { text: e.target.value })} aria-label="Subtítulo" />
              <select className={inputCls} value={st.font} onChange={(e) => set({ font: e.target.value })} aria-label="Tipografía">{FONTS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select>
              {range('Tamaño del título', st.title.size, 40, 220, 2, (v) => setLayer('title', { size: v }))}
              {range('Tamaño del subtítulo', st.subtitle.size, 24, 120, 2, (v) => setLayer('subtitle', { size: v }))}
              {color('Color del título', st.title.color, (v) => setLayer('title', { color: v }))}
              {color('Color del subtítulo', st.subtitle.color, (v) => setLayer('subtitle', { color: v }))}
              <div className="flex gap-1">
                {(['left', 'center', 'right'] as const).map((a) => (
                  <button key={a} type="button" onClick={() => { const x = a === 'left' ? 80 : a === 'center' ? W / 2 : W - 80; setSt((s) => ({ ...s, align: a, title: { ...s.title, x }, subtitle: { ...s.subtitle, x } })); }}
                    className={cx('flex-1 rounded-lg py-1.5 text-xs ring-1 ring-ink-200 dark:ring-white/10', st.align === a && 'bg-ink-900 text-white dark:bg-white/10')}>{a === 'left' ? 'Izquierda' : a === 'center' ? 'Centro' : 'Derecha'}</button>
                ))}
              </div>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={st.stroke} onChange={(e) => set({ stroke: e.target.checked })} />Contorno</label>
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={st.shadow} onChange={(e) => set({ shadow: e.target.checked })} />Sombra</label>
            </div>
          )}
          {tab === 'extra' && (
            <div className="space-y-3">
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={st.badge} onChange={(e) => set({ badge: e.target.checked })} />Distintivo</label>
              {st.badge && <input className={inputCls} value={st.badgeText} maxLength={20} onChange={(e) => set({ badgeText: e.target.value.toUpperCase() })} aria-label="Texto del distintivo" />}
              <div className="flex flex-wrap gap-2">
                <Button className="h-8" onClick={() => pickFile((f) => loadImage(f).then(setLogo).catch((x) => toast(errMsg(x), 'error')))}><ImagePlus className="size-4" />{logo ? 'Cambiar logotipo' : 'Añadir logotipo'}</Button>
                {logo && <Button variant="ghost" className="h-8" onClick={() => setLogo(null)}><Trash2 className="size-4" /></Button>}
              </div>
              {logo && <>
                <select className={inputCls} value={st.logoCorner} onChange={(e) => set({ logoCorner: e.target.value as State['logoCorner'] })} aria-label="Posición del logotipo">
                  <option value="tl">Arriba izquierda</option><option value="tr">Arriba derecha</option><option value="bl">Abajo izquierda</option><option value="br">Abajo derecha (la tapa la duración)</option>
                </select>
                {range('Tamaño del logotipo', st.logoSize, 60, 400, 10, (v) => set({ logoSize: v }))}
              </>}
              <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={st.safe} onChange={(e) => set({ safe: e.target.checked })} />Mostrar la zona que tapa YouTube (no se exporta)</label>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
