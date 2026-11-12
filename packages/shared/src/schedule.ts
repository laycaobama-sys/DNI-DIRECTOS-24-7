/** Cálculo de ocurrencias de programación con zonas IANA y cambios de hora (DST), sin dependencias. */

export interface WallTime { year: number; month: number; day: number; hour: number; minute: number }

function partsInZone(utcMs: number, timeZone: string): WallTime & { weekday: number } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short',
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value;
  return {
    year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour), minute: Number(p.minute),
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday!),
  };
}

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Convierte una hora local de pared a instante UTC.
 * - Hora inexistente (salto de primavera): se desplaza hacia delante (02:30 → 03:30).
 * - Hora ambigua (otoño): se elige la primera ocurrencia.
 */
export function wallTimeToUtc(w: WallTime, timeZone: string): number {
  const naive = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  const offsetAt = (ms: number) => {
    const p = partsInZone(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - ms;
  };
  const candidates = [...new Set([naive - offsetAt(naive - 86_400_000), naive - offsetAt(naive + 86_400_000)])].sort((a, b) => a - b);
  for (const c of candidates) {
    const p = partsInZone(c, timeZone);
    if (p.hour === w.hour && p.minute === w.minute && p.day === w.day) return c;
  }
  // Hora inexistente: el desfase anterior al salto produce el instante desplazado hacia delante.
  return candidates[0]!;
}

export type Recurrence =
  | { type: 'once'; date: string /* YYYY-MM-DD */ }
  | { type: 'daily' }
  | { type: 'weekly'; weekdays: number[] /* 0=domingo */ };

export interface ScheduleRule { timeZone: string; time: string /* HH:mm */; recurrence: Recurrence }

/** Siguiente inicio (UTC ms) estrictamente posterior a `afterUtcMs`, o null si no hay más. */
export function nextOccurrence(rule: ScheduleRule, afterUtcMs: number): number | null {
  const [hh, mm] = rule.time.split(':').map(Number) as [number, number];
  if (rule.recurrence.type === 'once') {
    const [y, m, d] = rule.recurrence.date.split('-').map(Number) as [number, number, number];
    const t = wallTimeToUtc({ year: y, month: m, day: d, hour: hh, minute: mm }, rule.timeZone);
    return t > afterUtcMs ? t : null;
  }
  const start = partsInZone(afterUtcMs, rule.timeZone);
  for (let i = 0; i <= 8; i++) {
    // Aritmética de calendario en UTC "naive" para avanzar días sin depender del offset.
    const d = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const weekday = d.getUTCDay();
    if (rule.recurrence.type === 'weekly' && !rule.recurrence.weekdays.includes(weekday)) continue;
    const t = wallTimeToUtc({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: hh, minute: mm }, rule.timeZone);
    if (t > afterUtcMs) return t;
  }
  return null;
}
