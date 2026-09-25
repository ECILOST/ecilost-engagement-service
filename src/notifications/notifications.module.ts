import { Module } from '@nestjs/common';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { HttpAuthGuard } from './http-auth.guard.js';
import { NotificationsController } from './notifications.controller.js';

@Module({
  imports: [RealtimeModule],
  controllers: [NotificationsController],
  providers: [HttpAuthGuard],
})
export class NotificationsModule {}
