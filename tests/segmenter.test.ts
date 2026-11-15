import { describe, expect, it, vi } from 'vitest';

// Simula la API interna: registra cada llamada del grabador sin red.
const calls: { method: string; path: string; body?: any; size?: number }[] = [];
vi.mock('../apps/engine/src/core', () => ({
  log: { info: () => {}, warn: () => {}, error: () => {} },
  api: async (method: string, path: string, body?: unknown, opts: { raw?: Buffer } = {}) => {
    calls.push({ method, path, body, size: opts.raw?.length });
    if (path.endsWith('/recordings/start')) return { recordingId: 'rec_test' };
    if (/\/segments$/.test(path)) return { seq: calls.filter((c) => /\/segments$/.test(c.path)).length - 1 };
    if (path.includes('/parts/')) return { etag: `e${calls.length}` };
    return { ok: true };
  },
}));

const { Recorder, Previewer } = await import('../apps/engine/src/segmenter');
const PART = 8 * 1024 * 1024;
const TS = 188;

/** Paquete TS: PID de vídeo 0x100; `key` marca random_access_indicator (fotograma clave) con PCR. */
function packet(key: boolean): Buffer {
  const b = Buffer.alloc(TS, 0xff);
  b[0] = 0x47; b[1] = 0x40 | 0x01; b[2] = 0x00; b[3] = 0x30; // PUSI, PID 0x100, adaptación + carga
  b[4] = 7; b[5] = key ? 0x50 : 0x10; // longitud de adaptación; RAI + PCR
  return b;
}
const state = { pat: Buffer.alloc(TS, 0x47), pmt: Buffer.alloc(TS, 0x47), pmtPid: 0x1000, videoPid: 0x100, pcr: 0 };

describe('Recorder (grabación en la nube)', () => {
  it('sube partes de tamaño EXACTAMENTE igual (exigencia de R2) salvo la última y completa el fragmento', async () => {
    calls.length = 0;
    const rec = new Recorder('str_1', 'ses_1', 1, 'node', 3600);
    const chunk = Buffer.concat(Array.from({ length: 700 }, (_, i) => packet(i === 0))); // ~128 KB por escritura
    for (let i = 0; i < 200; i++) rec.write(chunk, state); // ~25,6 MB → 3 partes llenas + resto
    await rec.close(0);
    const parts = calls.filter((c) => c.path.includes('/parts/')).map((c) => c.size!);
    expect(parts.length).toBeGreaterThanOrEqual(4);
    expect(parts.slice(0, -1).every((s) => s === PART)).toBe(true);
    expect(parts.at(-1)!).toBeLessThanOrEqual(PART);
    const complete = calls.find((c) => c.path.endsWith('/complete'))!;
    expect(complete.body.parts.map((p: any) => p.partNumber)).toEqual(parts.map((_, i) => i + 1));
    expect(complete.body.sizeBytes).toBe(parts.reduce((a, b) => a + b, 0));
    expect(calls.at(-1)!.path).toBe('/internal/recordings/rec_test/finish');
    expect(calls.at(-1)!.body.sessionId).toBe('ses_1');
  });

  it('cada fragmento empieza en fotograma clave con PAT/PMT delante', async () => {
    calls.length = 0;
    const prev = new Previewer('str_1', 1);
    prev.write(Buffer.concat([packet(false), packet(false)]), state); // sin fotograma clave: se ignora
    prev.write(Buffer.concat([packet(false), packet(true), packet(false)]), state);
    await prev.close(0);
    const put = calls.find((c) => c.path.includes('/preview/'))!;
    // PAT + PMT + desde el fotograma clave (2 paquetes): lo anterior al fotograma clave no entra
    expect(put.size).toBe(TS * 4);
  });
});
