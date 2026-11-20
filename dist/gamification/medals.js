export const ROUND_MODES = ['CLASSIC', 'DUTCH', 'SEALED', 'MYSTERY'];
/** Diferencia maxima con el segundo para "Sobre perfecto", en ECICoin. */
export const PERFECT_SEAL_MARGIN = 10;
/** Una puja es "de ultimo segundo" si llega a 3 s o menos del cierre que tenia la ronda. */
export const LAST_SECOND_MS = 3_000;
const wonIn = (counters, mode) => counters.modes[mode]?.won ?? 0;
/** En orden de catalogo: es el orden en que el perfil las lista antes de ordenarlas. */
export const MEDAL_RULES = [
    { id: 'FIRST_WIN', goal: 1, progress: (c) => c.wins },
    { id: 'DUTCH_KING', goal: 5, progress: (c) => wonIn(c, 'DUTCH') },
    { id: 'PERFECT_SEAL', goal: 1, progress: (c) => c.perfectSeals },
    { id: 'STREAK_3', goal: 3, progress: (c) => c.bestStreak },
    { id: 'DETECTIVE', goal: 3, progress: (c) => wonIn(c, 'MYSTERY') },
    { id: 'COLLECTOR', goal: 4, progress: (c) => ROUND_MODES.filter((mode) => wonIn(c, mode) > 0).length },
    { id: 'LAST_SECOND', goal: 1, progress: (c) => c.lastSecondWins },
    { id: 'WEEKLY_PODIUM', goal: 1, progress: (c) => c.podiums },
];
/** Medallas que los contadores ya alcanzan. */
export function reachedMedals(counters) {
    return MEDAL_RULES.filter((rule) => rule.progress(counters) >= rule.goal).map((rule) => rule.id);
}
/**
 * Estado de todas las medallas. `unlocked` guarda cuando se gano cada una: una vez ganada no
 * se pierde, aunque un contador cambie (por ejemplo, la racha).
 */
export function medalProgress(counters, unlocked) {
    return MEDAL_RULES.map((rule) => {
        const unlockedAt = unlocked[rule.id] ?? null;
        const progress = Math.min(rule.goal, rule.progress(counters));
        return { id: rule.id, unlockedAt, goal: rule.goal, progress: unlockedAt ? rule.goal : progress };
    });
}
/** Las que se lucen junto al alias (chat y top): las dos ganadas mas recientes. */
export function featuredMedals(unlocked, max = 2) {
    return Object.entries(unlocked)
        .sort(([, a], [, b]) => b.localeCompare(a))
        .slice(0, max)
        .map(([id]) => id);
}
/** La modalidad en la que mas puja. En empate, la que va primero en el catalogo. */
export function favoriteMode(modes) {
    let best = { mode: null, bids: 0 };
    for (const mode of ROUND_MODES) {
        const bids = modes[mode]?.bids ?? 0;
        if (bids > best.bids)
            best = { mode, bids };
    }
    return best;
}
//# sourceMappingURL=medals.js.map