import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
import type { CollectionMetadata } from './types';

// Permission bits live in @delfrance/auth. Duplicating literal values here
// would create a circular dep; mirror the bit positions instead. Cargos and
// Usuarios are gated by the existing `configuracoes` domain.
const PERM_CONFIG_READ = 1n << 40n;
const PERM_CONFIG_WRITE = 1n << 41n;

/**
 * Cargo (role/position). Bundles a set of permissions assignable to users.
 * Replaces the Flutter `permissoes_base` + `permissoes_fields` arrays with a
 * single BigInt bitmask encoded as a decimal string in Firestore — same wire
 * format as the `permissions` custom claim.
 */
export const cargoSchema = z.object({
  nome: z.string().min(1).max(255),
  // Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc payloads, so
  // optional Firestore fields must resolve to `T | null` after parse — never
  // `T | null | undefined`. Forms default empty inputs to `null`.
  descricao: z.string().max(500).nullable(),
  permissoes: z.string().regex(/^\d+$/, 'apenas dígitos').default('0'),
  // Milliseconds since epoch (numeric-epoch standard); reads tolerantly.
  timestamp: millisSinceEpoch().nullable().default(null),
});

export type Cargo = z.infer<typeof cargoSchema>;

export const cargoMeta: CollectionMetadata = {
  collectionPath: 'cargos',
  permissions: {
    read: PERM_CONFIG_READ,
    write: PERM_CONFIG_WRITE,
    delete: PERM_CONFIG_WRITE,
  },
};

export const cargo = { schema: cargoSchema, meta: cargoMeta };

export function decodePermissoes(c: Pick<Cargo, 'permissoes'>): bigint {
  try {
    return BigInt(c.permissoes ?? '0');
  } catch {
    return 0n;
  }
}

export function encodePermissoes(p: bigint): string {
  return p.toString();
}
