import { Module } from '@nestjs/common';
import { HttpAuthGuard } from '../notifications/http-auth.guard.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { RoomActivityController } from './room-activity.controller.js';

@Module({
  imports: [RealtimeModule],
  controllers: [RoomActivityController],
  providers: [HttpAuthGuard],
})
export class ActivityModule {}
