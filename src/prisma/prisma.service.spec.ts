import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';
import { PrismaService } from './prisma.service.js';

describe('PrismaService', () => {
  it('reports a missing database URL during setup', () => {
    const config = new ConfigService();
    vi.spyOn(config, 'get').mockReturnValue(undefined);
    expect(() => new PrismaService(config)).toThrow('DATABASE_URL must be configured for Engagement.');
  });

  it('connects on initialization and disconnects on shutdown', async () => {
    const config = new ConfigService({ DATABASE_URL: 'postgresql://test:test@localhost/engagement' });
    const prisma = new PrismaService(config);
    const connect = vi.spyOn(prisma, '$connect').mockResolvedValue(undefined);
    const disconnect = vi.spyOn(prisma, '$disconnect').mockResolvedValue(undefined);

    await prisma.onModuleInit();
    await prisma.onModuleDestroy();

    expect(connect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
  });
});
