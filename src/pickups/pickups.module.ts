import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PickupsController } from './pickups.controller.js';
import { PickupsService } from './pickups.service.js';

@Module({
  imports: [RealtimeModule],
  controllers: [PickupsController],
  providers: [PickupsService],
})
export class PickupsModule {}
