# Activity

Actividad publica de una sala: `GET /rooms/:roomId/activity`. Sale de la bandeja de eventos (`consumed_events`).

- Pujas sin autor (monto, si fue automatica, si extendio el cierre), inicio y cierre de cada ronda (adjudicada o desierta).
- Nunca dice quien pujo ni quien gano.
- La ve quien puede ver la sala segun auction (`GET /rooms/:roomId`): participantes, quien la sigue desde afuera y el funcionario.
