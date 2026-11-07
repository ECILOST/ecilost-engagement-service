var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import { Injectable } from '@nestjs/common';
import { MongoServerError } from 'mongodb';
import { favoriteMode, featuredMedals, medalProgress, reachedMedals, } from './medals.js';
import { MongoService } from './mongo.service.js';
import { publicAlias } from './public-alias.js';
import { isLastSecondBid, roundOutcome } from './round-outcome.js';
import { previousWeekKey, streakWeeks, weekKey, weekRange } from './weeks.js';
/*
 * Documentos del modelo de lectura. Se modelan por la consulta que los lee (semana 12):
 *
 * - `student_profiles`: un documento por estudiante con todo lo que pinta "Mi perfil". Las
 *   ultimas subastas van EMBEBIDAS porque son a lo sumo cinco y siempre se leen con el
 *   perfil.
 * - `weekly_scores`: un documento por estudiante y semana, REFERENCIADO (no embebido en el
 *   perfil) porque crece sin limite y el top se consulta por semana, no por persona.
 * - `rounds`: traza de cada ronda abierta (pujas por postor y si fueron de ultimo segundo).
 * - `weeks`: semanas cuyo podio ya se premio.
 */
/** Cuantos `eventId` recuerda cada documento para no aplicar dos veces el mismo evento. */
const APPLIED_EVENTS_KEPT = 100;
const RECENT_KEPT = 5;
const ROUND_TRACE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DUPLICATE_KEY = 11000;
export const LEADERBOARD_SIZE = 10;
const isDuplicate = (error) => error instanceof MongoServerError && error.code === DUPLICATE_KEY;
const money = (value) => (Math.round(value * 100) / 100).toFixed(2);
function counters(doc) {
    return {
        wins: doc.wins ?? 0,
        modes: doc.modes ?? {},
        perfectSeals: doc.perfectSeals ?? 0,
        lastSecondWins: doc.lastSecondWins ?? 0,
        bestStreak: doc.bestStreak ?? 0,
        podiums: doc.podiumWeeks?.length ?? 0,
    };
}
const isoMedals = (medals) => Object.fromEntries(Object.entries(medals ?? {}).map(([id, at]) => [id, new Date(at).toISOString()]));
/**
 * Modelo de lectura de la gamificacion: lo escribe el consumidor de eventos y lo leen el
 * perfil, el top y el chat.
 *
 * Consistencia eventual a proposito: el perfil se pone al dia unos milisegundos o segundos
 * despues de que cierra la ronda, y cada respuesta lleva `updatedAt` para decirlo.
 *
 * Idempotencia sin transacciones: cada documento recuerda los ultimos `eventId` que le
 * aplicaron, y cada escritura es CONDICIONAL ("solo si este evento no esta en la lista").
 * La condicion y el cambio van en la misma operacion sobre un documento, que en MongoDB es
 * atomica, asi que una reentrega de RabbitMQ no suma dos veces aunque llegue en paralelo.
 */
let GamificationReadModel = class GamificationReadModel {
    mongo;
    constructor(mongo) {
        this.mongo = mongo;
    }
    get enabled() {
        return this.mongo.enabled;
    }
    // ---------------------------------------------------------------- escritura (eventos)
    /** Una puja aceptada: se recuerda por postor en la traza de la ronda. */
    async recordBid(event) {
        const rounds = await this.mongo.rounds();
        const amount = Number(event.amount) || 0;
        const bidder = `bidders.${event.bidderId}`;
        try {
            await rounds.updateOne({ _id: event.roundId, appliedEvents: { $ne: event.eventId } }, {
                $setOnInsert: { roomId: event.roomId },
                $inc: { [`${bidder}.bids`]: 1 },
                $max: { [`${bidder}.best`]: amount },
                $set: { [`${bidder}.lastSecond`]: isLastSecondBid(event), expiresAt: new Date(Date.now() + ROUND_TRACE_TTL_MS) },
                $push: { appliedEvents: { $each: [event.eventId], $slice: -APPLIED_EVENTS_KEPT } },
            }, { upsert: true });
        }
        catch (error) {
            if (!isDuplicate(error))
                throw error;
        }
    }
    /** El cierre de una ronda: perfil y semana de cada participante, medallas y podio. */
    async recordRoundClosed(event) {
        const rounds = await this.mongo.rounds();
        const trace = await rounds.findOne({ _id: event.roundId });
        const outcome = roundOutcome(event, trace);
        for (const participant of outcome.participants) {
            await this.applyToProfile(outcome, participant);
            await this.applyToWeek(outcome, participant);
            await this.settleProfile(participant.userId, outcome.closedAt);
        }
        // El podio de la semana pasada se premia con el primer cierre de la semana siguiente.
        await this.awardPodium(previousWeekKey(outcome.closedAt), outcome.closedAt);
        return outcome;
    }
    async applyToProfile(outcome, p) {
        const profiles = await this.mongo.profiles();
        const recent = {
            roundId: outcome.roundId,
            roomId: outcome.roomId,
            entry: outcome.entry,
            mode: outcome.mode,
            amount: p.amount,
            result: p.won ? 'WON' : 'LOST',
            at: outcome.closedAt,
        };
        const mode = `modes.${outcome.mode}`;
        try {
            await profiles.updateOne({ _id: p.userId, appliedEvents: { $ne: outcome.eventId } }, {
                $setOnInsert: { alias: publicAlias(p.userId), createdAt: outcome.closedAt },
                $inc: {
                    bids: p.bids,
                    played: 1,
                    wins: p.won ? 1 : 0,
                    spent: p.won ? p.amount : 0,
                    [`${mode}.played`]: 1,
                    [`${mode}.won`]: p.won ? 1 : 0,
                    [`${mode}.bids`]: p.bids,
                    perfectSeals: p.perfectSeal ? 1 : 0,
                    lastSecondWins: p.lastSecondWin ? 1 : 0,
                },
                ...(p.won ? { $addToSet: { winWeeks: weekKey(outcome.closedAt) } } : {}),
                $push: {
                    recent: { $each: [recent], $position: 0, $slice: RECENT_KEPT },
                    appliedEvents: { $each: [outcome.eventId], $slice: -APPLIED_EVENTS_KEPT },
                },
                $set: { updatedAt: new Date() },
            }, { upsert: true });
        }
        catch (error) {
            // El filtro no encontro el documento porque ya tenia el evento, y el upsert choco con su
            // `_id`: es una reentrega y no hay nada que sumar.
            if (!isDuplicate(error))
                throw error;
        }
    }
    async applyToWeek(outcome, p) {
        const scores = await this.mongo.weeklyScores();
        const week = weekKey(outcome.closedAt);
        try {
            await scores.updateOne({ _id: `${week}:${p.userId}`, appliedEvents: { $ne: outcome.eventId } }, {
                $setOnInsert: { week, userId: p.userId, alias: publicAlias(p.userId) },
                $inc: {
                    wins: p.won ? 1 : 0,
                    bids: p.bids,
                    played: 1,
                    spent: p.won ? p.amount : 0,
                    [`modes.${outcome.mode}`]: p.bids,
                },
                $push: { appliedEvents: { $each: [outcome.eventId], $slice: -APPLIED_EVENTS_KEPT } },
                $set: { updatedAt: new Date() },
            }, { upsert: true });
        }
        catch (error) {
            if (!isDuplicate(error))
                throw error;
        }
    }
    /**
     * Lo que se deriva de los contadores: la mejor racha y las medallas nuevas. Se recalcula
     * siempre, tambien en una reentrega, para que un fallo entre la suma y este paso se
     * corrija con el siguiente evento. Cada medalla se fija una sola vez (`$exists: false`):
     * la fecha de la primera vez no se pisa.
     */
    async settleProfile(userId, at) {
        const profiles = await this.mongo.profiles();
        const doc = await profiles.findOne({ _id: userId });
        if (!doc)
            return;
        const streak = streakWeeks(doc.winWeeks ?? [], at);
        if (streak > (doc.bestStreak ?? 0)) {
            await profiles.updateOne({ _id: userId }, { $max: { bestStreak: streak } });
            doc.bestStreak = streak;
        }
        for (const id of reachedMedals(counters(doc))) {
            if (doc.medals?.[id])
                continue;
            await profiles.updateOne({ _id: userId, [`medals.${id}`]: { $exists: false } }, { $set: { [`medals.${id}`]: at } });
        }
    }
    /**
     * Premia el podio de una semana terminada. Primero los perfiles (con `$addToSet`, que no
     * duplica) y al final la marca de la semana: si algo falla en medio, el siguiente cierre lo
     * vuelve a intentar sin premiar dos veces.
     */
    async awardPodium(week, at) {
        const weeks = await this.mongo.weeks();
        if (await weeks.findOne({ _id: week }))
            return;
        const scores = await this.mongo.weeklyScores();
        const podium = await scores
            .find({ week, wins: { $gt: 0 } })
            .sort({ wins: -1, spent: 1, userId: 1 })
            .limit(3)
            .toArray();
        const profiles = await this.mongo.profiles();
        for (const score of podium) {
            await profiles.updateOne({ _id: score.userId }, { $addToSet: { podiumWeeks: week } });
            await this.settleProfile(score.userId, at);
        }
        try {
            await weeks.insertOne({ _id: week, podiumAwardedAt: at });
        }
        catch (error) {
            if (!isDuplicate(error))
                throw error;
        }
    }
    // ---------------------------------------------------------------- lectura
    async profile(userId, now = new Date()) {
        const profiles = await this.mongo.profiles();
        const doc = await profiles.findOne({ _id: userId });
        const current = await this.rankOf(weekKey(now), userId);
        if (!doc) {
            return {
                alias: publicAlias(userId),
                stats: { bids: 0, wins: 0, spent: money(0), streakWeeks: 0, favoriteMode: null, favoriteModeBids: 0 },
                weeklyRank: null,
                medals: medalProgress(counters({}), {}),
                modes: [],
                recent: [],
                updatedAt: now.toISOString(),
            };
        }
        const favorite = favoriteMode(doc.modes ?? {});
        return {
            alias: doc.alias,
            stats: {
                bids: doc.bids ?? 0,
                wins: doc.wins ?? 0,
                spent: money(doc.spent ?? 0),
                streakWeeks: streakWeeks(doc.winWeeks ?? [], now),
                favoriteMode: favorite.mode,
                favoriteModeBids: favorite.bids,
            },
            weeklyRank: current?.rank ?? null,
            medals: medalProgress(counters(doc), isoMedals(doc.medals)),
            modes: Object.entries(doc.modes ?? {})
                .filter(([, stat]) => stat.played > 0)
                .map(([mode, stat]) => ({ mode, played: stat.played, won: stat.won })),
            recent: (doc.recent ?? []).map((item) => ({
                roundId: item.roundId,
                roomId: item.roomId,
                entry: item.entry,
                mode: item.mode,
                amount: money(item.amount),
                result: item.result,
                at: new Date(item.at).toISOString(),
            })),
            updatedAt: new Date(doc.updatedAt ?? now).toISOString(),
        };
    }
    async leaderboard(userId, which, now = new Date()) {
        const week = which === 'current' ? weekKey(now) : previousWeekKey(now);
        const scores = await this.mongo.weeklyScores();
        const top = await scores
            .find({ week, wins: { $gt: 0 } })
            .sort({ wins: -1, spent: 1, userId: 1 })
            .limit(LEADERBOARD_SIZE)
            .toArray();
        const mine = await this.rankOf(week, userId);
        const badges = await this.badgesFor([...top.map((score) => score.userId), ...(mine ? [userId] : [])]);
        const view = (score, rank) => {
            const favorite = favoriteMode(Object.fromEntries(Object.entries(score.modes ?? {}).map(([mode, bids]) => [mode, { played: 0, won: 0, bids }])));
            return {
                rank,
                alias: score.alias,
                wins: score.wins,
                bids: score.bids,
                spent: money(score.spent),
                favoriteMode: favorite.mode,
                badges: badges[score.userId] ?? [],
                mine: score.userId === userId,
            };
        };
        const updatedAt = [...top, ...(mine ? [mine.score] : [])].reduce((latest, score) => (score.updatedAt > latest ? score.updatedAt : latest), new Date(0));
        return {
            week: which,
            ...weekRange(week),
            entries: top.map((score, index) => view(score, index + 1)),
            me: mine ? view(mine.score, mine.rank) : null,
            updatedAt: (updatedAt.getTime() > 0 ? updatedAt : now).toISOString(),
        };
    }
    /** Puesto de alguien en una semana, contando quien va delante con el mismo orden del top. */
    async rankOf(week, userId) {
        const scores = await this.mongo.weeklyScores();
        const score = await scores.findOne({ _id: `${week}:${userId}` });
        if (!score || score.wins <= 0)
            return null;
        const ahead = await scores.countDocuments({
            week,
            wins: { $gt: 0 },
            $or: [
                { wins: { $gt: score.wins } },
                { wins: score.wins, spent: { $lt: score.spent } },
                { wins: score.wins, spent: score.spent, userId: { $lt: userId } },
            ],
        });
        return { rank: ahead + 1, score };
    }
    /** Las medallas que luce cada persona (las dos mas recientes), para el chat y el top. */
    async badgesFor(userIds) {
        const ids = [...new Set(userIds)];
        if (ids.length === 0)
            return {};
        const profiles = await this.mongo.profiles();
        const docs = await profiles.find({ _id: { $in: ids } }, { projection: { medals: 1 } }).toArray();
        return Object.fromEntries(docs.map((doc) => [doc._id, featuredMedals(isoMedals(doc.medals))]));
    }
};
GamificationReadModel = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [MongoService])
], GamificationReadModel);
export { GamificationReadModel };
//# sourceMappingURL=read-model.js.map