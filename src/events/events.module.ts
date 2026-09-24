import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { AuctionEventConsumer } from './auction-event.consumer.js';

@Module({
  imports: [RealtimeModule],
  providers: [AuctionEventConsumer],
})
export class EventsModule {}
