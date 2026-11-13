import { describe, expect, it } from 'vitest';
import {
  STREAM_STATUSES, advance, canTransition, destinationCreateSchema, hasRole, isPrivateHost, joinRtmp, maskSecret, nextOccurrence, orderForCycle,
  redactRtmp, registerSchema, resolve, validateRtmpUrl, validateStreamKey, wallTimeToUtc, type CursorState, type PlayMode,
} from '@dni/shared';

function play(length: number, mode: PlayMode, seed: number, steps: number): (number | null)[] {
  const out: (number | null)[] = [];
  let s: CursorState = { cycle: 0, position: 0 };
  for (let i = 0; i < steps; i++) {
    const r = resolve(length, mode, seed, s);
    out.push(r.index);
    if (r.index === null) break;
    s = advance(r.state);
  }
  return out;
}

describe('secuenciador de playlist', () => {
  it('loop: A→B→C→A→B→C→A', () => expect(play(3, 'loop', 1, 7)).toEqual([0, 1, 2, 0, 1, 2, 0]));
  it('once: reproduce una pasada y termina', () => expect(play(3, 'once', 1, 10)).toEqual([0, 1, 2, null]));
  it('playlist vacía: no hay nada que emitir', () => expect(play(0, 'loop', 1, 3)).toEqual([null]));
  it('shuffle: cada vuelta recorre todos los ítems sin repetir', () => {
    const seq = play(5, 'shuffle', 42, 25) as number[];
    for (let c = 0; c < 5; c++) expect([...seq.slice(c * 5, c * 5 + 5)].sort()).toEqual([0, 1, 2, 3, 4]);
  });
  it('shuffle: determinista por semilla (reanudable tras una caída)', () => {
    expect(play(6, 'shuffle', 7, 18)).toEqual(play(6, 'shuffle', 7, 18));
    expect(play(6, 'shuffle', 7, 18)).not.toEqual(play(6, 'shuffle', 8, 18));
  });
  it('shuffle: no repite el mismo ítem al enlazar dos vueltas', () => {
    for (let seed = 1; seed <= 200; seed++) for (let c = 1; c < 6; c++) {
      const prev = orderForCycle(4, 'shuffle', seed, c - 1), cur = orderForCycle(4, 'shuffle', seed, c);
      expect(cur[0]).not.toBe(prev[3]);
    }
  });
  it('reanuda desde una posición guardada', () => {
    expect(resolve(3, 'loop', 1, { cycle: 4, position: 2 }).index).toBe(2);
    expect(resolve(3, 'loop', 1, { cycle: 4, position: 3 })).toEqual({ index: 0, state: { cycle: 5, position: 0 } });
  });
});

describe('máquina de estados', () => {
  it('permite el ciclo de vida normal', () => {
    for (const [a, b] of [['ready', 'starting'], ['starting', 'live'], ['live', 'degraded'], ['degraded', 'live'], ['live', 'recovering'], ['recovering', 'live'], ['live', 'stopping'], ['stopping', 'stopped'], ['stopped', 'starting']] as const) {
      expect(canTransition(a, b), `${a}→${b}`).toBe(true);
    }
  });
  it('rechaza transiciones imposibles', () => {
    expect(canTransition('stopped', 'live')).toBe(false);
    expect(canTransition('draft', 'live')).toBe(false);
    expect(canTransition('stopping', 'live')).toBe(false);
    expect(canTransition('suspended', 'starting')).toBe(false);
  });
  it('define los 11 estados de la especificación', () => expect(STREAM_STATUSES).toHaveLength(11));
  it('jerarquía de roles', () => {
    expect(hasRole('owner', 'admin')).toBe(true);
    expect(hasRole('operator', 'editor')).toBe(false);
    expect(hasRole('viewer', 'operator')).toBe(false);
  });
});

describe('destinos RTMP: validación y SSRF', () => {
  it('acepta RTMPS públicos y normaliza', () => {
    expect(validateRtmpUrl(' rtmps://a.rtmps.youtube.com/live2/ ')).toEqual({ ok: true, secure: true, host: 'a.rtmps.youtube.com', url: 'rtmps://a.rtmps.youtube.com/live2' });
    expect(validateRtmpUrl('rtmp://live.example.com:1935/app')).toMatchObject({ ok: true, secure: false });
  });
  it.each(['http://example.com/x', 'file:///etc/passwd', 'rtmp://', 'javascript:alert(1)', 'rtmp://user:pass@host/app', 'rtmp://host/app -f lavfi', 'rtmp://host/a"b', 'rtmp://host/$(id)'])('rechaza %s', (u) => {
    expect(validateRtmpUrl(u).ok).toBe(false);
  });
  it.each(['localhost', '127.0.0.1', '10.0.0.5', '172.16.9.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '[::1]', '[fe80::1]', '[fd00::1]', '[::ffff:127.0.0.1]', '2130706433', '0x7f000001', 'metadata.internal', 'db.local'])('bloquea host privado %s', (h) => {
    expect(validateRtmpUrl(`rtmp://${h}/live`)).toMatchObject({ ok: false, code: 'url_private_host' });
  });
  it('permite redes privadas solo con el flag de desarrollo', () => expect(validateRtmpUrl('rtmp://127.0.0.1:1935/live', { allowPrivate: true }).ok).toBe(true));
  it('no trata como privados hosts públicos parecidos', () => { expect(isPrivateHost('172.32.0.1')).toBe(false); expect(isPrivateHost('fcbarcelona.com')).toBe(false); });
  it('valida claves de emisión', () => {
    expect(validateStreamKey('abcd-1234-efgh?x=1').ok).toBe(true);
    expect(validateStreamKey('clave con espacios').ok).toBe(false);
    expect(validateStreamKey('a;rm -rf /').ok).toBe(false);
  });
  it('enmascara y redacta secretos', () => {
    expect(maskSecret('abcd-efgh-1234')).toBe('••••••••1234');
    expect(maskSecret('abc')).toBe('••••');
    const url = joinRtmp('rtmps://a.rtmps.youtube.com/live2/', '/CLAVE-SUPER-SECRETA');
    expect(url).toBe('rtmps://a.rtmps.youtube.com/live2/CLAVE-SUPER-SECRETA');
    const red = redactRtmp(`Error opening output ${url}: I/O error; also rtmp://127.0.0.1:1935/live/otra`);
    expect(red).not.toContain('SECRETA');
    expect(red).not.toContain('otra');
    expect(red).toContain('rtmps://a.rtmps.youtube.com/live2/***');
  });
  it('RTMP sin cifrar no se acepta por defecto en el esquema', () => expect(destinationCreateSchema.parse({ name: 'x', url: 'rtmp://h/app', streamKey: 'k' }).allowInsecure).toBe(false));
});

describe('programación con zonas horarias y cambio de hora (Europe/Madrid)', () => {
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const madrid = (time: string) => ({ timeZone: 'Europe/Madrid', time, recurrence: { type: 'daily' as const } });
  it('invierno (CET, UTC+1) y verano (CEST, UTC+2)', () => {
    expect(iso(wallTimeToUtc({ year: 2026, month: 1, day: 15, hour: 9, minute: 0 }, 'Europe/Madrid'))).toBe('2026-01-15T08:00:00.000Z');
    expect(iso(wallTimeToUtc({ year: 2026, month: 7, day: 15, hour: 9, minute: 0 }, 'Europe/Madrid'))).toBe('2026-07-15T07:00:00.000Z');
  });
  it('diaria a las 09:00 mantiene la hora local al cruzar el cambio de primavera (29-mar-2026)', () => {
    const a = nextOccurrence(madrid('09:00'), Date.parse('2026-03-27T12:00:00Z'))!;
    const b = nextOccurrence(madrid('09:00'), a)!;
    const c = nextOccurrence(madrid('09:00'), b)!;
    expect([a, b, c].map(iso)).toEqual(['2026-03-28T08:00:00.000Z', '2026-03-29T07:00:00.000Z', '2026-03-30T07:00:00.000Z']);
    expect(b - a).toBe(23 * 3600_000); // día de 23 horas
  });
  it('diaria a las 09:00 mantiene la hora local al cruzar el cambio de otoño (25-oct-2026)', () => {
    const a = nextOccurrence(madrid('09:00'), Date.parse('2026-10-24T00:00:00Z'))!;
    const b = nextOccurrence(madrid('09:00'), a)!;
    expect([a, b].map(iso)).toEqual(['2026-10-24T07:00:00.000Z', '2026-10-25T08:00:00.000Z']);
    expect(b - a).toBe(25 * 3600_000); // día de 25 horas
  });
  it('hora inexistente (02:30 del salto de primavera) se desplaza a las 03:30 locales', () => {
    expect(iso(wallTimeToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, 'Europe/Madrid'))).toBe('2026-03-29T01:30:00.000Z');
  });
  it('hora ambigua (02:30 del cambio de otoño) elige la primera ocurrencia y no se duplica', () => {
    const first = wallTimeToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, 'Europe/Madrid');
    expect(iso(first)).toBe('2026-10-25T00:30:00.000Z');
    expect(iso(nextOccurrence(madrid('02:30'), first))).toBe('2026-10-26T01:30:00.000Z');
  });
  it('semanal: solo los días elegidos', () => {
    const rule = { timeZone: 'Europe/Madrid', time: '20:00', recurrence: { type: 'weekly' as const, weekdays: [1, 5] } }; // lunes y viernes
    const a = nextOccurrence(rule, Date.parse('2026-11-12T12:00:00Z'))!; // jueves
    expect(iso(a)).toBe('2026-11-13T19:00:00.000Z');
    expect(iso(nextOccurrence(rule, a))).toBe('2026-11-16T19:00:00.000Z');
  });
  it('una vez: no se repite ni se programa en el pasado', () => {
    const rule = { timeZone: 'Europe/Madrid', time: '10:00', recurrence: { type: 'once' as const, date: '2026-12-01' } };
    const t = nextOccurrence(rule, Date.parse('2026-11-12T00:00:00Z'));
    expect(iso(t)).toBe('2026-12-01T09:00:00.000Z');
    expect(nextOccurrence(rule, t!)).toBeNull();
  });
  it('otras zonas: America/New_York', () => expect(iso(wallTimeToUtc({ year: 2026, month: 7, day: 4, hour: 12, minute: 0 }, 'America/New_York'))).toBe('2026-07-04T16:00:00.000Z'));
});

describe('validación de entrada', () => {
  it('exige contraseña de 10+ caracteres y email válido', () => {
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'corta', name: 'A', organizationName: 'O' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'no-es-email', password: 'suficientemente-larga', name: 'A', organizationName: 'O' }).success).toBe(false);
    expect(registerSchema.parse({ email: ' Ana@Ejemplo.ES ', password: 'suficientemente-larga', name: 'A', organizationName: 'O' }).email).toBe('ana@ejemplo.es');
  });
});
