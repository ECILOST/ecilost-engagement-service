/**
 * La infraestructura real de las pruebas de integracion: un PostgreSQL y un RabbitMQ propios.
 * En CI los levanta el workflow; en local, cualquier par de contenedores sirve:
 *
 *   docker run -d --name engagement-it-db -p 5437:5432 -e POSTGRES_USER=engagement \
 *     -e POSTGRES_PASSWORD=engagement -e POSTGRES_DB=ecilost_engagement_it postgres:17-alpine
 *   docker run -d --name engagement-it-mq -p 5672:5672 -e RABBITMQ_DEFAULT_USER=ecilost \
 *     -e RABBITMQ_DEFAULT_PASS=ecilost rabbitmq:4-alpine
 *
 * Nunca apuntes estas variables a dev o prod: las pruebas vacian las tablas y purgan la cola
 * `engagement.events.v1`, que en esos ambientes es la de verdad.
 */
export const integrationDatabaseUrl =
  process.env.TEST_DATABASE_URL ??
  'postgresql://engagement:engagement@localhost:5437/ecilost_engagement_it?schema=public';

export const integrationRabbitmqUrl = process.env.TEST_RABBITMQ_URL ?? 'amqp://ecilost:ecilost@localhost:5672';
