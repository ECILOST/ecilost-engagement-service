# ADR-0002: Modelo de lectura en MongoDB para el perfil, el top semanal y las medallas

## Estado

Accepted (semana 12: NoSQL y consistencia).

## Contexto

El estudiante quiere ver su historial como postor: cuántas pujas hizo, cuántas subastas ganó,
cuánto ECICoin gastó, en qué modalidad juega más, sus medallas y un top semanal. Esos datos ya
existen repartidos en auction (pujas, rondas, ganadores) pero calcularlos en cada visita
exigiría agregaciones sobre todas las pujas, en otro servicio y en cada petición.

Engagement ya consume los eventos de auction (`bid.accepted`, `round.closed`) para el canal en
vivo y la bandeja. Las pantallas nuevas son de solo lectura y toleran unos segundos de atraso.

## Decisiones

1. **Modelo de lectura (CQRS) en MongoDB Atlas**, alimentado por eventos y separado de la
   PostgreSQL de engagement. Auction sigue siendo la fuente de verdad: el modelo se puede
   reconstruir reprocesando eventos.
2. **Modelado por consulta.**
   - `student_profiles`: todo "Mi perfil" en un documento (una lectura por `_id`), con las
     últimas 5 subastas **embebidas** porque son acotadas y siempre se leen juntas.
   - `weekly_scores`: un documento por estudiante y semana, **referenciado**, porque crece sin
     límite y el top se pide por semana. El índice `{ week, wins: -1, spent: 1, userId: 1 }`
     entrega el top ya ordenado.
3. **Consistencia por operación.**

   | Operación | Garantía | Por qué |
   |---|---|---|
   | Pujar, cerrar ronda, cobrar | Fuerte (PostgreSQL, `FOR UPDATE`, outbox en auction; holds en wallet) | Es dinero y unicidad del ganador. No cambia. |
   | Ver perfil y top | **Eventual** | Unos segundos de atraso no hacen daño; la respuesta trae `updatedAt` y el front lo dice ("Actualizado hace 8 s"). |
   | Medallas en el chat | Eventual con caché de 60 s | Un mensaje no debe esperar a Mongo. |

4. **Idempotencia con escrituras condicionales, sin transacciones multi-documento.** Cada
   documento guarda sus últimos `eventId` y cada actualización lleva el filtro
   `appliedEvents: { $ne: eventId }`. La condición y el cambio van en una sola operación sobre un
   documento, que MongoDB aplica de forma atómica: una reentrega de RabbitMQ (incluso concurrente)
   no suma dos veces. Es detección optimista de conflictos a nivel de documento.
5. **Cola propia (`engagement.gamification.v1`).** Si Atlas falla, la gamificación se atrasa sin
   frenar la bandeja ni el tiempo real, y un evento no aplicado vuelve a la cola en vez de
   perderse. Se procesa de a uno para respetar el orden puja → cierre.
6. **Auction publica `participants` y `runnerUpAmount` en `round.closed`.** Sin ellos engagement no
   sabría quién perdió en un sobre cerrado (las ofertas selladas no se publican) ni podría
   calcular "Sobre perfecto". Viajan solo por el bus interno.
7. **Privacidad.** El top usa un alias público derivado del userId; el chat solo lleva
   identificadores de medalla; la actividad pública de la sala sigue sin autor y sin medallas.

## Alternativas descartadas

- **Calcularlo en auction con consultas SQL a demanda:** acopla las pantallas de perfil al
  servicio que decide las pujas y repite agregaciones caras en cada visita.
- **Tablas nuevas en la PostgreSQL de engagement:** posible, pero el perfil es un documento
  anidado (modalidades, medallas, últimas subastas) que en relacional serían varias tablas y
  joins para una sola pantalla; y el curso pide practicar el modelado documental.
- **Embeber las semanas en el perfil:** el documento crecería sin límite y el top tendría que
  recorrer todos los perfiles.
- **Transacciones multi-documento de MongoDB:** funcionan en Atlas, pero no hacen falta: cada
  escritura toca un solo documento y la idempotencia condicional basta.

## Consecuencias

- Una dependencia más (Atlas) que se configura con `MONGODB_URI`. Sin ella engagement arranca
  igual y los endpoints de gamificación responden 503.
- El perfil puede ir unos segundos detrás del cierre. Es visible y explicado en la interfaz.
- El podio de una semana se premia con el primer cierre de la semana siguiente, no a la
  medianoche del domingo.
