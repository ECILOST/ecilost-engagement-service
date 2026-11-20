import {
  Body, Controller, ForbiddenException, Get, Headers, Param, Post, UnauthorizedException,
} from '@nestjs/common';
import { TokenVerifier } from '../realtime/token-verifier.js';
import { PickupsService } from './pickups.service.js';

@Controller('pickups')
export class PickupsController {
  constructor(private readonly tokens: TokenVerifier, private readonly pickups: PickupsService) {}

  private async principal(header: string | undefined, role: 'STAFF' | 'STUDENT') {
    const [scheme, token] = header?.split(' ') ?? [];
    const user = scheme === 'Bearer' ? await this.tokens.verifyClaims(token) : null;
    if (!user) throw new UnauthorizedException('El token de acceso no es válido.');
    if (user.role !== role) throw new ForbiddenException();
    return user.userId;
  }

  @Get('mine')
  async mine(@Headers('authorization') header?: string) {
    return this.pickups.list(await this.principal(header, 'STUDENT'));
  }

  @Get('mine/:roundId')
  async conversation(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string) {
    return this.pickups.conversation(roundId, await this.principal(header, 'STUDENT'));
  }

  @Get('slots')
  async slots(@Headers('authorization') header?: string) {
    await this.principal(header, 'STUDENT');
    return this.pickups.availableSlots();
  }

  @Post('mine/:roundId/booking')
  async book(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string, @Body('slotId') slotId: unknown) {
    return this.pickups.book(roundId, await this.principal(header, 'STUDENT'), slotId);
  }

  @Post('mine/:roundId/code')
  async code(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string) {
    return this.pickups.issueCode(roundId, await this.principal(header, 'STUDENT'));
  }

  @Post('mine/:roundId/help')
  async help(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string, @Body('message') message: unknown) {
    return this.pickups.help(roundId, await this.principal(header, 'STUDENT'), message);
  }

  @Get('staff')
  async staff(@Headers('authorization') header?: string) {
    await this.principal(header, 'STAFF');
    return this.pickups.list();
  }

  @Get('staff/slots')
  async staffSlots(@Headers('authorization') header?: string) {
    await this.principal(header, 'STAFF');
    return this.pickups.staffSlots();
  }

  @Post('staff/slots')
  async createSlot(@Headers('authorization') header: string | undefined, @Body() input: unknown) {
    await this.principal(header, 'STAFF');
    return this.pickups.createSlot(input);
  }

  @Get('staff/:roundId')
  async staffConversation(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string) {
    await this.principal(header, 'STAFF');
    return this.pickups.conversation(roundId);
  }

  @Post('staff/:roundId/reply')
  async reply(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string, @Body('message') message: unknown) {
    await this.principal(header, 'STAFF');
    return this.pickups.reply(roundId, message);
  }

  @Post('staff/:roundId/missed')
  async missed(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string) {
    await this.principal(header, 'STAFF');
    return this.pickups.markMissed(roundId);
  }

  @Post('staff/:roundId/delivery')
  async deliver(@Headers('authorization') header: string | undefined, @Param('roundId') roundId: string, @Body('code') code: unknown) {
    return this.pickups.deliver(roundId, await this.principal(header, 'STAFF'), code);
  }
}
