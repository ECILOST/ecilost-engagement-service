import { createHash } from 'node:crypto';
/** Largo maximo de un mensaje, en caracteres (no en bytes: un emoji cuenta como uno). */
export const MAX_MESSAGE_LENGTH = 280;
/** Mensajes que alguien puede mandar en la ventana, y la pausa minima entre dos. */
export const MAX_MESSAGES_PER_WINDOW = 5;
export const SEND_WINDOW_MS = 10_000;
export const MIN_SEND_INTERVAL_MS = 1_000;
/**
 * Deja el texto listo para guardar: sin caracteres de control ni saltos de linea (el chat
 * es de una linea) y sin espacios repetidos. React escapa el HTML al dibujarlo, asi que no
 * hace falta tocar `<` ni `&`.
 */
export function normalizeMessage(text) {
    if (typeof text !== 'string')
        return { ok: false, reason: 'empty' };
    const body = text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim();
    if (!body)
        return { ok: false, reason: 'empty' };
    if ([...body].length > MAX_MESSAGE_LENGTH)
        return { ok: false, reason: 'too-long' };
    return { ok: true, body };
}
/**
 * Como se le muestra a la sala quien escribio. Auction no publica quien puja, y el chat
 * tampoco publica el userId: cada participante tiene un alias estable dentro de la sala
 * (el mismo al reconectar) y distinto en cada sala, para que no se le pueda seguir entre
 * subastas.
 */
export function chatAlias(roomId, userId) {
    const code = createHash('sha256').update(`${roomId}:${userId}`).digest('hex').slice(0, 4).toUpperCase();
    return `Participante ${code}`;
}
/**
 * Limite de envio por persona y sala, en memoria. Igual que las salas de Socket.IO, vive en
 * cada replica: hoy Engagement corre con una sola (ver ADR-0001).
 */
export class SendLimiter {
    now;
    sent = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    /** Registra el envio si cabe en el limite; si no, no cuenta. */
    tryConsume(roomId, userId) {
        const key = `${roomId}:${userId}`;
        const now = this.now();
        const recent = (this.sent.get(key) ?? []).filter((at) => now - at < SEND_WINDOW_MS);
        const last = recent[recent.length - 1];
        if (recent.length >= MAX_MESSAGES_PER_WINDOW || (last !== undefined && now - last < MIN_SEND_INTERVAL_MS)) {
            this.sent.set(key, recent);
            return false;
        }
        recent.push(now);
        this.sent.set(key, recent);
        this.prune(now);
        return true;
    }
    /** Olvida a quien ya no esta escribiendo, para que el mapa no crezca sin fin. */
    prune(now) {
        if (this.sent.size < 1_000)
            return;
        for (const [key, times] of this.sent) {
            if (times.every((at) => now - at >= SEND_WINDOW_MS))
                this.sent.delete(key);
        }
    }
}
//# sourceMappingURL=chat-rules.js.map