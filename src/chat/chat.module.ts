import { Module } from '@nestjs/common';
import { GamificationModule } from '../gamification/gamification.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [RealtimeModule, GamificationModule],
  providers: [ChatGateway],
})
export class ChatModule {}
