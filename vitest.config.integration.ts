import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int-spec.ts'],
    // Aplica las migraciones una vez sobre una base propia de las pruebas.
    globalSetup: ['./test/global-setup.ts'],
    // Las pruebas comparten base y colas de RabbitMQ: ejecutarlas en paralelo las haria interferir.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
