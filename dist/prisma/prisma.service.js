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
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
let PrismaService = class PrismaService extends PrismaClient {
    constructor(config) {
        const databaseUrl = config.get('DATABASE_URL');
        if (!databaseUrl)
            throw new Error('DATABASE_URL must be configured for Engagement.');
        super({ adapter: new PrismaPg(databaseUrl) });
    }
    onModuleInit() {
        return this.$connect();
    }
    onModuleDestroy() {
        return this.$disconnect();
    }
};
PrismaService = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ConfigService])
], PrismaService);
export { PrismaService };
//# sourceMappingURL=prisma.service.js.map