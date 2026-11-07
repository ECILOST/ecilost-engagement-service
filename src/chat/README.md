# Chat

Chat de la sala en curso, en el namespace `/realtime` (misma conexion que el canal de la sala).

- Escriben solo los participantes admitidos antes del inicio, y solo con la sala `ACTIVE`.
- El funcionario dueño de la sala lee, pero no escribe. Quien sigue la sala desde afuera no recibe el chat.
- A la sala nunca se le publica el userId: cada participante tiene un alias estable por sala.
- Eventos: `chat.join` (responde historial, alias y `canWrite`), `chat.send`, `chat.leave`; la sala recibe `chat.message`.
- Quien participa y en que estado esta la sala lo decide auction (`GET /rooms/:roomId`), no este servicio.
