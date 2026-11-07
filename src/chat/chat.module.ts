import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { ChatGateway } from './chat.gateway.js';

@Module({
  imports: [RealtimeModule],
  providers: [ChatGateway],
})
export class ChatModule {}
