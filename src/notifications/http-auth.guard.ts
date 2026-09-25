import { CanActivate, type ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { TokenVerifier } from '../realtime/token-verifier.js';

export interface AuthenticatedRequest {
  headers: { authorization?: string };
  userId?: string;
}

/** El mismo JWT que exige el canal en vivo, ahora para la bandeja por HTTP. */
@Injectable()
export class HttpAuthGuard implements CanActivate {
  constructor(private readonly tokens: TokenVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const [scheme, token] = request.headers.authorization?.split(' ') ?? [];
    const userId = scheme === 'Bearer' ? await this.tokens.verify(token) : null;
    if (!userId) throw new UnauthorizedException('El token de acceso no es valido.');
    request.userId = userId;
    return true;
  }
}
