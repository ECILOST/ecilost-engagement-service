import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { integrationDatabaseUrl } from './environment.js';

/**
 * La prueba levanta el servicio compilado (`dist/main.js`), igual que el contenedor: requiere
 * `npm run build` antes. Aqui se deja la base de pruebas al dia; Prisma la crea si no existe.
 */
export default function setup(): void {
  if (!existsSync('dist/main.js')) throw new Error('Falta dist/main.js: corre `npm run build` antes de las pruebas de integracion.');
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: integrationDatabaseUrl },
  });
}
