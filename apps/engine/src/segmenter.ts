/**
 * Segmentador de la señal de salida (MPEG-TS del bus, sin recodificar).
 *
 * Corta la señal en fragmentos que empiezan siempre en un fotograma clave de vídeo con PAT/PMT por delante, de modo
 * que cada fragmento es reproducible por sí solo. Dos usos:
 *  - Grabación en la nube: fragmentos de ~60 s subidos a R2 por partes (multipart) mientras se graban; un fallo
 *    pierde como mucho el fragmento en curso, nunca la grabación entera.
 *  - Vista previa en directo: fragmentos de ~2 s (un GOP) para un reproductor HLS con imagen y sonido reales.
 * Las subidas van en una cola en segundo plano: nunca bloquean la emisión. Si la cola crece demasiado (red lenta), se
 * descartan fragmentos de vista previa; en grabación se registra el hueco.
 */
import { createHash } from 'node:crypto';
import { api, log } from './core';

const TS = 188;
const PART = 8 * 1024 * 1024;

export interface TsState { pat: Buffer | null; pmt: Buffer | null; pmtPid: number; videoPid: number; pcr: number }

const pidOf = (b: Buffer, o: number) => ((b[o + 1]! & 0x1f) << 8) | b[o + 2]!;
export function isVideoKey(b: Buffer, o: number, videoPid: number): boolean {
  return pidOf(b, o) === videoPid && !!(b[o + 1]! & 0x40) && !!(b[o + 3]! & 0x20) && b[o + 4]! > 0 && !!(b[o + 5]! & 0x40);
}

interface Segment { seq: number; chunks: Buffer[]; size: number; startPcr: number; startWall: number; parts: { partNumber: number; etag: string }[]; hash: ReturnType<typeof createHash>; uploaded: number; opened: Promise<boolean> | null; remote: number }

abstract class Segmenter {
  protected cur: Segment | null = null;
  protected seq = 0;
  private queue: Promise<unknown> = Promise.resolve();
  protected backlog = 0;
  closed = false;

  constructor(protected readonly targetSec: number, protected readonly maxBacklog: number) {}

  protected enqueue(bytes: number, task: () => Promise<unknown>) {
    this.backlog += bytes;
    this.queue = this.queue.then(task).catch((e) => log.warn(`segmenter: ${e instanceof Error ? e.message : e}`)).finally(() => { this.backlog -= bytes; });
  }

  write(chunk: Buffer, ts: TsState) {
    if (this.closed || !ts.pat || !ts.pmt || ts.videoPid < 0) return;
    let from = 0;
    const due = !this.cur || (Date.now() - this.cur.startWall) / 1000 >= this.targetSec;
    if (due) {
      // Se corta exactamente en el siguiente fotograma clave.
      for (let o = 0; o + TS <= chunk.length; o += TS) {
        if (chunk[o] === 0x47 && isVideoKey(chunk, o, ts.videoPid)) {
          if (this.cur && o > 0) this.append(chunk.subarray(0, o));
          this.rotate(ts);
          from = o;
          break;
        }
      }
      if (!this.cur) return; // aún sin fotograma clave inicial
    }
    this.append(from ? chunk.subarray(from) : chunk);
  }

  private rotate(ts: TsState) {
    const prev = this.cur;
    if (prev) this.finishSegment(prev, ts.pcr);
    const seg: Segment = { seq: this.seq++, chunks: [], size: 0, startPcr: ts.pcr, startWall: Date.now(), parts: [], hash: createHash('sha256'), uploaded: 0, opened: null, remote: -1 };
    this.cur = seg;
    this.onOpen(seg);
    this.append(Buffer.concat([ts.pat!, ts.pmt!]));
  }

  private append(b: Buffer) {
    const seg = this.cur;
    if (!seg || !b.length) return;
    const copy = Buffer.from(b); // el bus reutiliza memoria: se copia antes de encolar
    seg.chunks.push(copy);
    seg.size += copy.length;
    seg.hash.update(copy);
    this.onData(seg);
  }

  protected takeBuffered(seg: Segment): Buffer {
    const buf = Buffer.concat(seg.chunks);
    seg.chunks = [];
    return buf;
  }

  /** Duración del fragmento: por PCR (exacta); si hay discontinuidad, por reloj de pared. */
  protected durationOf(seg: Segment, endPcr: number) {
    const d = endPcr - seg.startPcr;
    return d > 0 && d < this.targetSec * 4 ? d : (Date.now() - seg.startWall) / 1000;
  }

  /** Cierra el fragmento en curso (fin de emisión). */
  async close(lastPcr: number) {
    if (this.closed) return;
    this.closed = true;
    if (this.cur) this.finishSegment(this.cur, lastPcr);
    this.cur = null;
    await this.queue;
    await this.onClosed();
  }

  protected abstract onOpen(seg: Segment): void;
  protected abstract onData(seg: Segment): void;
  protected abstract finishSegment(seg: Segment, endPcr: number): void;
  protected abstract onClosed(): Promise<void>;
}

/** Grabación en la nube: multipart a R2 por fragmento. */
export class Recorder extends Segmenter {
  private recordingId: string | null = null;
  private starting: Promise<void>;
  lostSegments = 0;

  constructor(private readonly streamId: string, private readonly sessionId: string, private readonly fencingToken: number, private readonly nodeId: string, segmentSec = 60) {
    super(segmentSec, 256 * 1024 * 1024);
    this.starting = api<{ recordingId: string }>('POST', '/internal/recordings/start', { streamId, sessionId, fencingToken, nodeId })
      .then((r) => { this.recordingId = r.recordingId; })
      .catch((e) => { log.error(`recording start failed: ${e}`); this.closed = true; });
  }

  get id() { return this.recordingId; }

  protected onOpen(seg: Segment) {
    seg.opened = this.starting.then(async () => {
      if (!this.recordingId) return false;
      // El número definitivo lo asigna la API (continúa tras el último fragmento si otro nodo grabó antes).
      const r = await api<{ seq: number }>('POST', `/internal/recordings/${this.recordingId}/segments`, { seq: seg.seq, fencingToken: this.fencingToken, streamId: this.streamId });
      seg.remote = r.seq;
      return true;
    }).catch((e) => { log.warn(`segment open failed: ${e}`); return false; });
  }

  /**
   * R2 exige que todas las partes de una subida multipart, salvo la última, midan EXACTAMENTE lo mismo: se cortan
   * trozos de PART bytes y el resto vuelve al búfer (el simulador local no lo comprueba; R2 real rechaza la subida).
   */
  private uploadPart(seg: Segment, part: Buffer) {
    seg.uploaded += part.length;
    const n = seg.parts.length + 1;
    const slot = { partNumber: n, etag: '' };
    seg.parts.push(slot);
    this.enqueue(part.length, async () => {
      if (!(await seg.opened)) return;
      const r = await api<{ etag: string }>('PUT', `/internal/recordings/${this.recordingId}/segments/${seg.remote}/parts/${n}`, undefined, { raw: part, timeoutMs: 120_000 });
      slot.etag = r.etag;
    });
  }

  protected onData(seg: Segment) {
    if (seg.size - seg.uploaded < PART) return;
    if (this.backlog > this.maxBacklog) return; // red saturada: se mantiene en memoria y se sube después
    let buf = this.takeBuffered(seg);
    while (buf.length >= PART) { this.uploadPart(seg, buf.subarray(0, PART)); buf = buf.subarray(PART); }
    if (buf.length) seg.chunks.push(buf);
  }

  protected finishSegment(seg: Segment, endPcr: number) {
    let rest = this.takeBuffered(seg);
    // Si la red fue lenta, el resto puede superar una parte: se trocea igual que el resto (solo la última es menor).
    while (rest.length > PART) { this.uploadPart(seg, rest.subarray(0, PART)); rest = rest.subarray(PART); }
    if (rest.length) this.uploadPart(seg, rest);
    const duration = this.durationOf(seg, endPcr);
    const sha = seg.hash.digest('hex');
    this.enqueue(0, async () => {
      if (!(await seg.opened)) { this.lostSegments++; return; }
      const parts = seg.parts.slice();
      if (!parts.length || parts.some((p) => !p.etag)) { this.lostSegments++; throw new Error(`fragmento ${seg.seq} incompleto`); }
      await api('POST', `/internal/recordings/${this.recordingId}/segments/${seg.remote}/complete`, { parts, durationSec: duration, sizeBytes: seg.size, sha256: sha });
    });
  }

  protected async onClosed() {
    if (this.recordingId) await api('POST', `/internal/recordings/${this.recordingId}/finish`, { lostSegments: this.lostSegments, sessionId: this.sessionId }).catch((e) => log.warn(`recording finish failed: ${e}`));
  }
}

/** Vista previa en directo: fragmentos de ~2 s publicados para un reproductor HLS. */
export class Previewer extends Segmenter {
  constructor(private readonly streamId: string, private readonly fencingToken: number) {
    super(2, 12 * 1024 * 1024);
  }

  protected onOpen() { /* nada que preparar */ }
  protected onData() { /* se sube entero al cerrar (≈ 1 GOP) */ }

  protected finishSegment(seg: Segment, endPcr: number) {
    const body = this.takeBuffered(seg);
    if (this.backlog > this.maxBacklog) return; // mejor saltar un fragmento de vista previa que acumular retraso
    const duration = this.durationOf(seg, endPcr);
    this.enqueue(body.length, () => api('PUT', `/internal/streams/${this.streamId}/preview/${seg.seq}?d=${duration.toFixed(3)}&f=${this.fencingToken}`, undefined, { raw: body, timeoutMs: 20_000 }));
  }

  protected async onClosed() { /* los fragmentos caducan solos */ }
}
