import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { RoomAccessVerifier } from './room-access.js';
import { TokenVerifier } from './token-verifier.js';

@Module({
  providers: [TokenVerifier, RoomAccessVerifier, RealtimeGateway],
  exports: [RealtimeGateway, TokenVerifier],
})
export class RealtimeModule {}
