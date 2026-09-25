import { Module } from '@nestjs/common';
import { RealtimeGateway } from './realtime.gateway.js';
import { TokenVerifier } from './token-verifier.js';

@Module({
  providers: [TokenVerifier, RealtimeGateway],
  exports: [RealtimeGateway, TokenVerifier],
})
export class RealtimeModule {}
