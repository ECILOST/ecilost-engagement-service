import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoClient, type Collection, type Db } from 'mongodb';
import type { ProfileDoc, RoundDoc, WeekDoc, WeeklyScoreDoc } from './read-model.js';

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
@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MongoService.name);
  private client?: MongoClient;
  private db?: Db;
  private ready?: Promise<Db>;
  private stopped = false;

  constructor(private readonly config: ConfigService) {}

  get enabled(): boolean {
    return !!this.config.get<string>('MONGODB_URI');
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
  database(): Promise<Db> {
    if (!this.enabled) return Promise.reject(new Error('Gamification is disabled (MONGODB_URI is not set).'));
    this.ready ??= this.connect().catch((error: unknown) => {
      this.ready = undefined;
      this.logger.warn(`No se pudo conectar a MongoDB: ${String(error)}`);
      throw error;
    });
    return this.ready;
  }

  async profiles(): Promise<Collection<ProfileDoc>> {
    return (await this.database()).collection<ProfileDoc>('student_profiles');
  }

  async weeklyScores(): Promise<Collection<WeeklyScoreDoc>> {
    return (await this.database()).collection<WeeklyScoreDoc>('weekly_scores');
  }

  async rounds(): Promise<Collection<RoundDoc>> {
    return (await this.database()).collection<RoundDoc>('rounds');
  }

  async weeks(): Promise<Collection<WeekDoc>> {
    return (await this.database()).collection<WeekDoc>('weeks');
  }

  private async connect(): Promise<Db> {
    if (this.stopped) throw new Error('MongoService is stopped.');
    const uri = this.config.get<string>('MONGODB_URI') as string;
    const name = this.config.get<string>('MONGODB_DB') || 'ecilost_engagement';
    const client = new MongoClient(uri, { appName: 'ecilost-engagement', serverSelectionTimeoutMS: RETRY_DELAY_MS });
    await client.connect();
    const db = client.db(name);
    await ensureIndexes(db);
    this.client = client;
    this.db = db;
    this.logger.log(`Modelo de lectura de gamificacion en MongoDB (${name}).`);
    return db;
  }
}

/**
 * Indices del modelo de lectura. Cada uno existe por una consulta concreta:
 * - el top de una semana sale ordenado del indice, sin ordenar en memoria;
 * - las trazas de rondas se borran solas a los 30 dias (TTL): solo sirven mientras la
 *   ronda esta abierta y para reprocesar un cierre repetido.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection('weekly_scores').createIndex({ week: 1, wins: -1, spent: 1, userId: 1 }, { name: 'week_ranking' });
  await db.collection('rounds').createIndex({ expiresAt: 1 }, { name: 'rounds_ttl', expireAfterSeconds: 0 });
}
