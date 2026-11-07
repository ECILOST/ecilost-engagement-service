/**
 * Semanas del top semanal. Empiezan el lunes a las 00:00 de Bogota (UTC-5, sin horario de
 * verano) y se nombran por la fecha de ese lunes: `2026-11-02`. Asi la clave ordena bien
 * como texto y no depende del reloj del servidor ni de la zona del contenedor.
 */
const BOGOTA_OFFSET_MS = -5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;
/** Instante (UTC) en que empieza la semana que contiene `at`. */
export function weekStart(at) {
    const local = new Date(at.getTime() + BOGOTA_OFFSET_MS);
    const daysSinceMonday = (local.getUTCDay() + 6) % 7;
    const mondayLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - daysSinceMonday * DAY_MS;
    return new Date(mondayLocal - BOGOTA_OFFSET_MS);
}
/** Clave de la semana: la fecha (en Bogota) de su lunes. */
export function weekKey(at) {
    return new Date(weekStart(at).getTime() + BOGOTA_OFFSET_MS).toISOString().slice(0, 10);
}
/** La semana anterior a la de `at`. */
export function previousWeekKey(at) {
    return weekKey(new Date(weekStart(at).getTime() - 1));
}
/** Lunes y domingo de una semana, como fechas `YYYY-MM-DD`, para mostrar el rango. */
export function weekRange(key) {
    const monday = Date.parse(`${key}T00:00:00Z`);
    return { from: key, to: new Date(monday + 6 * DAY_MS).toISOString().slice(0, 10) };
}
/**
 * Semanas seguidas ganando, contando hacia atras desde la de `now`. Si esta semana todavia
 * no gano, la racha cuenta desde la anterior: no se rompe hasta que una semana termina en
 * cero.
 */
export function streakWeeks(winWeeks, now) {
    const won = new Set(winWeeks);
    let cursor = weekStart(now);
    if (!won.has(weekKey(cursor)))
        cursor = new Date(cursor.getTime() - WEEK_MS);
    let streak = 0;
    while (won.has(weekKey(cursor))) {
        streak += 1;
        cursor = new Date(cursor.getTime() - WEEK_MS);
    }
    return streak;
}
//# sourceMappingURL=weeks.js.map