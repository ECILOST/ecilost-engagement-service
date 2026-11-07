var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var MongoService_1;
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoClient } from 'mongodb';
const RETRY_DELAY_MS = 5_000;
/**
 * Conexion con la base del modelo de lectura (MongoDB Atlas en dev y prod).
 *
 * Es opcional: sin `MONGODB_URI` engagement arranca igual, sin gamificacion, y sus endpoints
 * responden 503. Asi una falla de Mongo no tumba la bandeja, el chat ni el canal en vivo,
 * que siguen en PostgreSQL.
 *
 * La base y las colecciones no se crean a mano: Mongo las crea con la primera escritura, y
 * los indices se aseguran aqui al conectar (`createIndex` es idempotente).
 */
let MongoService = MongoService_1 = class MongoService {
    config;
    logger = new Logger(MongoService_1.name);
    client;
    db;
    ready;
    stopped = false;
    constructor(config) {
        this.config = config;
    }
    get enabled() {
        return !!this.config.get('MONGODB_URI');
    }
    onModuleInit() {
        if (!this.enabled) {
            this.logger.warn('MONGODB_URI no esta configurada: la gamificacion queda apagada.');
            return;
        }
        // No se espera: si Atlas tarda o no responde, el resto del servicio arranca igual.
        void this.database().catch(() => undefined);
    }
    async onModuleDestroy() {
        this.stopped = true;
        await this.client?.close().catch(() => undefined);
    }
    /** La base, conectada y con sus indices. Reintenta si la conexion anterior fallo. */
    database() {
        if (!this.enabled)
            return Promise.reject(new Error('Gamification is disabled (MONGODB_URI is not set).'));
        this.ready ??= this.connect().catch((error) => {
            this.ready = undefined;
            this.logger.warn(`No se pudo conectar a MongoDB: ${String(error)}`);
            throw error;
        });
        return this.ready;
    }
    async profiles() {
        return (await this.database()).collection('student_profiles');
    }
    async weeklyScores() {
        return (await this.database()).collection('weekly_scores');
    }
    async rounds() {
        return (await this.database()).collection('rounds');
    }
    async weeks() {
        return (await this.database()).collection('weeks');
    }
    async connect() {
        if (this.stopped)
            throw new Error('MongoService is stopped.');
        const uri = this.config.get('MONGODB_URI');
        const name = this.config.get('MONGODB_DB') || 'ecilost_engagement';
        const client = new MongoClient(uri, { appName: 'ecilost-engagement', serverSelectionTimeoutMS: RETRY_DELAY_MS });
        await client.connect();
        const db = client.db(name);
        await ensureIndexes(db);
        this.client = client;
        this.db = db;
        this.logger.log(`Modelo de lectura de gamificacion en MongoDB (${name}).`);
        return db;
    }
};
MongoService = MongoService_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ConfigService])
], MongoService);
export { MongoService };
/**
 * Indices del modelo de lectura. Cada uno existe por una consulta concreta:
 * - el top de una semana sale ordenado del indice, sin ordenar en memoria;
 * - las trazas de rondas se borran solas a los 30 dias (TTL): solo sirven mientras la
 *   ronda esta abierta y para reprocesar un cierre repetido.
 */
export async function ensureIndexes(db) {
    await db.collection('weekly_scores').createIndex({ week: 1, wins: -1, spent: 1, userId: 1 }, { name: 'week_ranking' });
    await db.collection('rounds').createIndex({ expiresAt: 1 }, { name: 'rounds_ttl', expireAfterSeconds: 0 });
}
//# sourceMappingURL=mongo.service.js.map