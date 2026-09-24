import { Module } from '@nestjs/common';
import { AuctionEventConsumer } from './auction-event.consumer.js';

@Module({
  providers: [AuctionEventConsumer],
})
export class EventsModule {}
