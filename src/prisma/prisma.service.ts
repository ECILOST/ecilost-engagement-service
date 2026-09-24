import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: ConfigService) {
    const databaseUrl = config.get<string>('DATABASE_URL');
    if (!databaseUrl) throw new Error('DATABASE_URL must be configured for Engagement.');
    super({ adapter: new PrismaPg(databaseUrl) });
  }

  onModuleInit(): Promise<void> {
    return this.$connect();
  }

  onModuleDestroy(): Promise<void> {
    return this.$disconnect();
  }
}
