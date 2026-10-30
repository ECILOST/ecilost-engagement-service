import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { installMetrics } from './observability/metrics.js';
import { RealtimeGateway } from './realtime/realtime.gateway.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const gateway = app.get(RealtimeGateway);
  installMetrics(app, 'engagement', [
    {
      name: 'realtime_connected_sockets',
      help: 'Conexiones Socket.IO abiertas en el namespace /realtime.',
      read: () => gateway.connectedSockets,
    },
  ]);
  await app.listen(process.env.PORT ?? 3005);
}

void bootstrap();
