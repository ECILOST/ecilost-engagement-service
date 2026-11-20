var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var RoomAccessVerifier_1;
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
/** Cuanto se espera a auction antes de negar la entrada al canal. */
const AUCTION_TIMEOUT_MS = 3_000;
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
let RoomAccessVerifier = RoomAccessVerifier_1 = class RoomAccessVerifier {
    logger = new Logger(RoomAccessVerifier_1.name);
    auctionUrl;
    constructor(config) {
        const url = config.get('AUCTION_SERVICE_URL');
        this.auctionUrl = url ? url.replace(/\/+$/, '') : null;
        if (!this.auctionUrl) {
            this.logger.warn('AUCTION_SERVICE_URL no esta configurada: room.join solo valida el formato de la sala.');
        }
    }
    async check(roomId, token) {
        if (!this.auctionUrl)
            return 'granted';
        const response = await this.fetchRoom(roomId, token);
        return typeof response === 'string' ? response : 'granted';
    }
    /**
     * Como `check`, pero ademas devuelve si quien pregunta participa o es el dueño, y en que
     * estado esta la sala. El chat lo necesita: solo escriben los admitidos antes del inicio
     * y solo mientras la sala esta en curso. Sin auction configurada no se concede nada,
     * porque sin esa respuesta no hay forma de saber quien participa.
     */
    async lookup(roomId, token) {
        if (!this.auctionUrl)
            return { access: 'unavailable' };
        const response = await this.fetchRoom(roomId, token);
        if (typeof response === 'string')
            return { access: response };
        try {
            const room = (await response.json());
            if (typeof room?.status !== 'string')
                return { access: 'unavailable' };
            return {
                access: 'granted',
                room: { status: room.status, isParticipant: room.isParticipant === true, isOwner: room.isOwner === true },
            };
        }
        catch (error) {
            this.logger.warn(`Auction devolvio una sala ilegible para ${roomId}: ${String(error)}`);
            return { access: 'unavailable' };
        }
    }
    async fetchRoom(roomId, token) {
        try {
            const response = await fetch(`${this.auctionUrl}/rooms/${encodeURIComponent(roomId)}`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(AUCTION_TIMEOUT_MS),
            });
            if (response.ok)
                return response;
            if (response.status === 404 || response.status === 400)
                return 'not-found';
            if (response.status === 401 || response.status === 403)
                return 'denied';
            this.logger.warn(`Auction respondio ${response.status} al verificar la sala ${roomId}.`);
            return 'unavailable';
        }
        catch (error) {
            this.logger.warn(`No se pudo verificar la sala ${roomId} con auction: ${String(error)}`);
            return 'unavailable';
        }
    }
};
RoomAccessVerifier = RoomAccessVerifier_1 = __decorate([
    Injectable(),
    __metadata("design:paramtypes", [ConfigService])
], RoomAccessVerifier);
export { RoomAccessVerifier };
//# sourceMappingURL=room-access.js.map