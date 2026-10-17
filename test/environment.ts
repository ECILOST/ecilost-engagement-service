/**
 * Infraestructura de las pruebas de integracion: mismo PostgreSQL y RabbitMQ que el desarrollo
 * local, pero otra base y otro vhost, para no mezclar eventos ni datos con un engagement que
 * este corriendo. En CI se pasan por variables de entorno.
 */
export const integrationDatabaseUrl =
  process.env.TEST_DATABASE_URL ?? 'postgresql://engagement:engagement@localhost:5437/ecilost_engagement_it?schema=public';

export const integrationRabbitmqUrl = process.env.TEST_RABBITMQ_URL ?? 'amqp://ecilost:ecilost@localhost:5672/engagement_it';
