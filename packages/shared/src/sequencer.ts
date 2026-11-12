/** Secuenciador determinista de playlist: loop, una pasada y shuffle con semilla sin repetir hasta recorrer. */
export type PlayMode = 'loop' | 'once' | 'shuffle';

export interface CursorState {
  /** Vuelta actual (0-based). */
  cycle: number;
  /** Posición dentro de la vuelta (0-based, sobre el orden efectivo). */
  position: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Orden efectivo de índices para una vuelta. En shuffle evita repetir el último de la vuelta anterior al empezar. */
export function orderForCycle(length: number, mode: PlayMode, seed: number, cycle: number): number[] {
  const idx = Array.from({ length }, (_, i) => i);
  if (mode !== 'shuffle' || length < 2) return idx;
  const shuffleWith = (c: number) => {
    const rnd = mulberry32(seed + Math.imul(c + 1, 0x9e3779b1));
    const a = [...idx];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  };
  const cur = shuffleWith(cycle);
  if (cycle > 0) {
    const prev = orderForCycle(length, mode, seed, cycle - 1);
    if (prev[prev.length - 1] === cur[0]) [cur[0], cur[1]] = [cur[1]!, cur[0]!];
  }
  return cur;
}

export interface Step {
  /** Índice del ítem en la playlist original; null si la emisión terminó (modo once). */
  index: number | null;
  state: CursorState;
}

/** Devuelve el ítem a reproducir en `state` y normaliza el cursor. */
export function resolve(length: number, mode: PlayMode, seed: number, state: CursorState): Step {
  if (length <= 0) return { index: null, state };
  let { cycle, position } = state;
  if (position >= length) {
    cycle += Math.floor(position / length);
    position = position % length;
  }
  if (mode === 'once' && cycle > 0) return { index: null, state: { cycle, position } };
  return { index: orderForCycle(length, mode, seed, cycle)[position]!, state: { cycle, position } };
}

export function advance(state: CursorState): CursorState {
  return { cycle: state.cycle, position: state.position + 1 };
}
