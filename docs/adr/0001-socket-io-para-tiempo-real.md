# ADR-0001: Socket.IO en vez de STOMP para el tiempo real

## Estado

Accepted para HU-18, HU-23, HU-26, HU-27 y HU-29.

## Contexto

El único requisito con número del proyecto es de tiempo real: el precio, el contador y el cambio
de ronda deben llegar a la sala en menos de 1 segundo. Auction decide y publica en RabbitMQ
(`ecilost.events`); Engagement consume esos eventos y los empuja al navegador. Además de lo que ve
toda la sala, hay avisos personales: "te superaron" o "ganaste".

La opción clásica en el curso es STOMP sobre WebSocket, con un broker de mensajes detrás (por
ejemplo, Spring y su relay, o el plugin `web-stomp` de RabbitMQ). Los servicios de ECILOST son NestJS
y el frontend es React.

## Decisiones

1. **Socket.IO sobre el namespace `/realtime` de Engagement**, con `@nestjs/platform-socket.io` en
   el servidor y `socket.io-client` en el navegador. Solo WebSocket (`transports: ['websocket']`).
2. **Canales con las salas de Socket.IO:** `room:{roomId}` para lo que ve toda la sala y
   `user:{userId}` para los avisos personales. Engagement decide a quién va cada mensaje; el
   navegador no se suscribe a destinos del broker.
3. **El broker no se expone al navegador.** RabbitMQ queda entre servicios. El navegador habla
   solo con Engagement, que autentica en el handshake con el mismo JWT RS256 que verifican los
   demás servicios. Al entrar a una sala (`room.join`, con confirmación), Auction verifica si esa
   persona puede verla.
4. **El navegador nunca decide.** Cada mensaje trae `eventId`, para descartar repetidos, y
   `serverTime`, para dibujar el contador sin confiar en el reloj local. Al reconectarse, el cliente
   recibe `resync` y vuelve a leer el estado de la sala en Auction.
5. **Primero el tiempo real, después la persistencia.** Engagement difunde el evento apenas lo
   recibe (descarta en memoria los `eventId` ya vistos), luego lo guarda en la bandeja durable
   (`consumed_events`) junto con las notificaciones, y recién entonces lo confirma a RabbitMQ. Lo
   que no se puede guardar va a `engagement.events.dlq`; la bandeja de notificaciones sigue
   disponible por HTTP aunque el navegador haya estado desconectado.

## Alternativas descartadas

- **STOMP con un relay a RabbitMQ (`web-stomp`):** el navegador se suscribiría directo a destinos
  del broker. La autorización por sala y por usuario quedaría en la configuración del broker, no
  en código revisable y probado, y RabbitMQ tendría que quedar expuesto a Internet.
- **STOMP con un broker en memoria:** en NestJS no hay un soporte equivalente al de Spring. Habría
  que mantener un servidor STOMP propio y, del lado React, un cliente con menos uso.
- **Sondeo HTTP:** no cumple 1 s sin multiplicar las peticiones a Auction. Queda solo como respaldo
  cuando el canal no está disponible.

## Consecuencias

- Medido en local con la prueba de integración, que también corre en CI: un evento publicado en
  RabbitMQ llega al navegador en unos 3 ms; en una ráfaga de 50 pujas, p95 de 149 ms y máximo de
  158 ms. El presupuesto de 1 s se cumple con margen.
- Las salas de Socket.IO viven en la memoria de cada réplica. Hoy Engagement corre con una sola
  (`max_replicas = 1` en Terraform). Para escalar hay que agregar un adaptador compartido (por
  ejemplo, `@socket.io/redis-adapter`) y sesiones fijas.
- El protocolo de Socket.IO no es STOMP estándar: un cliente STOMP genérico no puede conectarse.

## Evidencia

- `src/realtime/realtime.gateway.ts`: namespace, autenticación, `room.join` y difusión.
- `src/events/auction-event.consumer.ts`: bandeja durable, deduplicación y cola de errores.
- `test/realtime.int-spec.ts`: RabbitMQ → Engagement → Socket.IO con el servicio compilado y el
  presupuesto de 1 s como aserción (`npm run test:integration`).
- `ecilost-frontend/src/features/auctions/api/realtime-channel.ts`: cliente, deduplicación y
  `resync`.
