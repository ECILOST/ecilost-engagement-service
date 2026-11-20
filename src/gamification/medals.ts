/**
 * Medallas. Aqui solo viven las reglas: cuanto falta para cada una a partir de los
 * contadores del perfil. El nombre, el icono y el color son del front, que recibe solo el
 * identificador.
 */
export type MedalId =
  | 'FIRST_WIN'
  | 'DUTCH_KING'
  | 'PERFECT_SEAL'
  | 'STREAK_3'
  | 'DETECTIVE'
  | 'COLLECTOR'
  | 'LAST_SECOND'
  | 'WEEKLY_PODIUM';

export type RoundMode = 'CLASSIC' | 'DUTCH' | 'SEALED' | 'MYSTERY';
export const ROUND_MODES: readonly RoundMode[] = ['CLASSIC', 'DUTCH', 'SEALED', 'MYSTERY'];

/** Diferencia maxima con el segundo para "Sobre perfecto", en ECICoin. */
export const PERFECT_SEAL_MARGIN = 10;
/** Una puja es "de ultimo segundo" si llega a 3 s o menos del cierre que tenia la ronda. */
export const LAST_SECOND_MS = 3_000;

/** Lo que el perfil acumula y de donde salen las medallas. */
export interface MedalCounters {
  wins: number;
  modes: Partial<Record<RoundMode, { played: number; won: number; bids: number }>>;
  perfectSeals: number;
  lastSecondWins: number;
  bestStreak: number;
  podiums: number;
}

interface MedalRule {
  id: MedalId;
  goal: number;
  progress: (counters: MedalCounters) => number;
}

const wonIn = (counters: MedalCounters, mode: RoundMode) => counters.modes[mode]?.won ?? 0;

/** En orden de catalogo: es el orden en que el perfil las lista antes de ordenarlas. */
export const MEDAL_RULES: readonly MedalRule[] = [
  { id: 'FIRST_WIN', goal: 1, progress: (c) => c.wins },
  { id: 'DUTCH_KING', goal: 5, progress: (c) => wonIn(c, 'DUTCH') },
  { id: 'PERFECT_SEAL', goal: 1, progress: (c) => c.perfectSeals },
  { id: 'STREAK_3', goal: 3, progress: (c) => c.bestStreak },
  { id: 'DETECTIVE', goal: 3, progress: (c) => wonIn(c, 'MYSTERY') },
  { id: 'COLLECTOR', goal: 4, progress: (c) => ROUND_MODES.filter((mode) => wonIn(c, mode) > 0).length },
  { id: 'LAST_SECOND', goal: 1, progress: (c) => c.lastSecondWins },
  { id: 'WEEKLY_PODIUM', goal: 1, progress: (c) => c.podiums },
];

export interface MedalProgress {
  id: MedalId;
  unlockedAt: string | null;
  progress: number;
  goal: number;
}

/** Medallas que los contadores ya alcanzan. */
export function reachedMedals(counters: MedalCounters): MedalId[] {
  return MEDAL_RULES.filter((rule) => rule.progress(counters) >= rule.goal).map((rule) => rule.id);
}

/**
 * Estado de todas las medallas. `unlocked` guarda cuando se gano cada una: una vez ganada no
 * se pierde, aunque un contador cambie (por ejemplo, la racha).
 */
export function medalProgress(counters: MedalCounters, unlocked: Partial<Record<MedalId, string>>): MedalProgress[] {
  return MEDAL_RULES.map((rule) => {
    const unlockedAt = unlocked[rule.id] ?? null;
    const progress = Math.min(rule.goal, rule.progress(counters));
    return { id: rule.id, unlockedAt, goal: rule.goal, progress: unlockedAt ? rule.goal : progress };
  });
}

/** Las que se lucen junto al alias (chat y top): las dos ganadas mas recientes. */
export function featuredMedals(unlocked: Partial<Record<MedalId, string>>, max = 2): MedalId[] {
  return (Object.entries(unlocked) as Array<[MedalId, string]>)
    .sort(([, a], [, b]) => b.localeCompare(a))
    .slice(0, max)
    .map(([id]) => id);
}

/** La modalidad en la que mas puja. En empate, la que va primero en el catalogo. */
export function favoriteMode(modes: MedalCounters['modes']): { mode: RoundMode | null; bids: number } {
  let best: { mode: RoundMode | null; bids: number } = { mode: null, bids: 0 };
  for (const mode of ROUND_MODES) {
    const bids = modes[mode]?.bids ?? 0;
    if (bids > best.bids) best = { mode, bids };
  }
  return best;
}
