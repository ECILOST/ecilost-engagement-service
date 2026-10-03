import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Cuanto se espera a auction antes de negar la entrada al canal. */
const AUCTION_TIMEOUT_MS = 3_000;

export type RoomAccess = 'granted' | 'not-found' | 'denied' | 'unavailable';

/**
 * Decide si alguien puede escuchar el canal en vivo de una sala.
 *
 * La regla es la misma de auction, y por eso se le pregunta a auction en vez de copiarla:
 * puede escuchar quien puede ver la sala con `GET /rooms/:roomId`. No se exige estar
 * inscrito, porque quien llego tarde sigue la sala en modo "solo seguimiento" con este mismo
 * canal; lo que el canal difunde (precio, cierre, cambio de ronda) es lo mismo que esa ruta
 * ya publica. Los avisos personales van aparte, al canal propio de cada usuario.
 *
 * Se consulta con el token de quien pide entrar, asi auction aplica su propia autenticacion
 * y sus roles. Sin respuesta de auction no se concede: el cliente sigue con su sondeo lento.
 */
@Injectable()
export class RoomAccessVerifier {
  private readonly logger = new Logger(RoomAccessVerifier.name);
  private readonly auctionUrl: string | null;

  constructor(config: ConfigService) {
    const url = config.get<string>('AUCTION_SERVICE_URL');
    this.auctionUrl = url ? url.replace(/\/+$/, '') : null;
    if (!this.auctionUrl) {
      this.logger.warn('AUCTION_SERVICE_URL no esta configurada: room.join solo valida el formato de la sala.');
    }
  }

  async check(roomId: string, token: string): Promise<RoomAccess> {
    if (!this.auctionUrl) return 'granted';
    try {
      const response = await fetch(`${this.auctionUrl}/rooms/${encodeURIComponent(roomId)}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(AUCTION_TIMEOUT_MS),
      });
      if (response.ok) return 'granted';
      if (response.status === 404 || response.status === 400) return 'not-found';
      if (response.status === 401 || response.status === 403) return 'denied';
      this.logger.warn(`Auction respondio ${response.status} al verificar la sala ${roomId}.`);
      return 'unavailable';
    } catch (error) {
      this.logger.warn(`No se pudo verificar la sala ${roomId} con auction: ${String(error)}`);
      return 'unavailable';
    }
  }
}
