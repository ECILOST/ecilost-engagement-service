import { createHash } from 'node:crypto';

const ANIMALS = [
  'buho', 'zorro', 'gata', 'tucan', 'ardilla', 'colibri', 'lobo', 'nutria', 'pulpo', 'oso',
  'jaguar', 'condor', 'tortuga', 'delfin', 'puma', 'ballena', 'mono', 'rana', 'halcon', 'llama',
  'perezoso', 'tigrillo', 'guacamaya', 'chiguiro', 'manati', 'armadillo', 'cusumbo', 'danta',
];

const TRAITS = [
  'nocturno', 'rojo', 'lunar', 'veloz', 'gris', 'zen', 'andino', 'feliz', 'astuto', 'sereno',
  'audaz', 'curioso', 'tranquilo', 'sabio', 'agil', 'valiente', 'paciente', 'atento', 'certero', 'brillante',
];

/**
 * Alias publico de un estudiante: el que se ve en el top semanal y en su perfil.
 *
 * El top es publico, asi que no puede mostrar nombres ni correos. Tampoco usa el alias del
 * chat, que cambia en cada sala a proposito para que no se pueda seguir a nadie entre
 * subastas. Este es estable (el mismo siempre, sin guardarlo) y legible; los dos digitos
 * del final evitan que dos estudiantes del campus terminen con el mismo.
 */
export function publicAlias(userId: string): string {
  const digest = createHash('sha256').update(`ecilost-public-alias:${userId}`).digest();
  const animal = ANIMALS[digest.readUInt16BE(0) % ANIMALS.length];
  const trait = TRAITS[digest.readUInt16BE(2) % TRAITS.length];
  const suffix = String(digest.readUInt16BE(4) % 100).padStart(2, '0');
  return `${animal}-${trait}-${suffix}`;
}
