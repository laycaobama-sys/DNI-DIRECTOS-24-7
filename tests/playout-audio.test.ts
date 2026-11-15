import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { feederArgs } from '../apps/engine/src/playout';

const req = createRequire(import.meta.url);
const FF: string = req('ffmpeg-static');
const FP: string = req('ffprobe-static').path;
const dir = mkdtempSync(path.join(tmpdir(), 'dni-audio-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Ítem canónico como los que produce el motor (AAC 48 kHz con apad + -t), de duración NO múltiplo de un frame AAC. */
function canonical(name: string, sec: number, freq: number) {
  const out = path.join(dir, name);
  const r = spawnSync(FF, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-f', 'lavfi', '-i', `sine=f=${freq}:r=48000`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-bf', '0', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-af', 'aresample=async=1:first_pts=0,apad', '-t', sec.toFixed(3), '-movflags', '+faststart', out]);
  expect(r.status).toBe(0);
  return out;
}

const ptsOf = (file: string, stream: 'a' | 'v') => spawnSync(FP, ['-v', 'error', '-select_streams', stream, '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { encoding: 'utf8' })
  .stdout.split(/\r?\n/).filter(Boolean).map(Number);

describe('Cortes entre ítems', () => {
  it('la cadena real (feeder → bus → emisor FLV) no solapa el audio ni deja huecos de imagen', async () => {
    const durations = [3.1, 2.9, 3.05];
    const items = [canonical('a.mp4', durations[0]!, 440), canonical('b.mp4', durations[1]!, 660), canonical('c.mp4', durations[2]!, 880)];
    const flv = path.join(dir, 'out.flv');
    const pusher = spawn(FF, ['-hide_banner', '-loglevel', 'repeat+warning', '-y', '-fflags', '+genpts', '-f', 'mpegts', '-i', 'pipe:0',
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'flv', '-flvflags', 'no_duration_filesize', flv]);
    let warnings = '';
    pusher.stderr.on('data', (d: Buffer) => { warnings += d.toString(); });
    const done = new Promise((r) => pusher.on('close', r));
    const cc = new Map<number, number>();
    let offset = 0;
    for (const [i, file] of items.entries()) {
      // Mismos argumentos que StreamRunner.playItem.
      const p = spawn(FF, feederArgs(file, offset, durations[i]!));
      let err = '';
      p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      let carry = Buffer.alloc(0);
      for await (const chunk of p.stdout as AsyncIterable<Buffer>) {
        const buf = Buffer.concat([carry, chunk]);
        const usable = buf.length - (buf.length % 188);
        for (let o = 0; o < usable; o += 188) {
          if (!(buf[o + 3]! & 0x10)) continue;
          const pid = ((buf[o + 1]! & 0x1f) << 8) | buf[o + 2]!;
          const c = ((cc.get(pid) ?? 15) + 1) & 15;
          cc.set(pid, c);
          buf[o + 3] = (buf[o + 3]! & 0xf0) | c;
        }
        if (!pusher.stdin.write(buf.subarray(0, usable))) await new Promise((r) => pusher.stdin.once('drain', r));
        carry = Buffer.from(buf.subarray(usable));
      }
      expect(err).toBe('');
      offset += durations[i]!;
    }
    pusher.stdin.end();
    await done;
    expect(warnings).not.toMatch(/non-monotonic/i);
    // Audio: cada frame AAC dura 21,33 ms (FLV redondea a ms). Nunca un solape (paso < 1 frame); en los cortes, como
    // mucho un hueco de menos de un frame (paso < 2 frames).
    const a = ptsOf(flv, 'a');
    expect(a.length).toBeGreaterThan(400);
    const badA = a.slice(1).map((t, i) => [a[i]!, t] as const).filter(([x, y]) => y - x < 0.02 || y - x >= 0.043);
    expect(badA).toEqual([]);
    // Vídeo: 30 fps continuos, sin saltos en los cortes (mismo criterio que el e2e).
    const v = ptsOf(flv, 'v');
    expect(v.length).toBeGreaterThan(260);
    const badV = v.slice(1).map((t, i) => [v[i]!, t] as const).filter(([x, y]) => y - x < 0.02 || y - x > 0.045);
    expect(badV).toEqual([]);
  }, 60_000);
});
