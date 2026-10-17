import { execFileSync } from 'node:child_process';
import { integrationDatabaseUrl } from './infrastructure.js';

/**
 * Deja la base de pruebas al dia antes de la primera prueba: las mismas migraciones que se
 * aplican en dev y prod, no un esquema armado a mano. Prisma la crea si no existe.
 */
export default function setup(): void {
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: { ...process.env, DATABASE_URL: integrationDatabaseUrl },
  });
}
