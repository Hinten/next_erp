import { z } from 'zod';
import type { CollectionMetadata } from './types';
import { type Cargo, decodePermissoes } from './cargo';

const PERM_CONFIG_READ = 1n << 40n;
const PERM_CONFIG_WRITE = 1n << 41n;

/**
 * Usuario — ERP user document. The Firestore doc ID matches the Firebase Auth
 * UID. Mirrors the Flutter `Usuario` model shape but drops field-level perms
 * and the paired Cliente sync — both deferred for now (see plan).
 *
 * `cargos` is an array of `cargos/<id>` document IDs (matches Flutter's
 * `cargo: List<String>` which stored doc IDs as plain strings).
 */
export const usuarioSchema = z.object({
  nome: z.string().min(1).max(255),
  email: z.string().email().max(255),
  cargos: z.array(z.string()).default([]),
  colaborador: z.boolean().default(false),
  ativo: z.boolean().default(true),
  isSuperUser: z.boolean().default(false),
  grupoEconomico: z.string().min(1),
  jaFoiColaborador: z.boolean().default(false),
  jaFoiSuperUser: z.boolean().default(false),
  ultimoAcesso: z.string().datetime().nullable().optional(),
  timestamp: z.string().datetime().nullable().optional(),
});

export type Usuario = z.infer<typeof usuarioSchema>;

export const usuarioMeta: CollectionMetadata = {
  collectionPath: 'usuarios',
  permissions: {
    read: PERM_CONFIG_READ,
    write: PERM_CONFIG_WRITE,
    delete: PERM_CONFIG_WRITE,
  },
};

export const usuario = { schema: usuarioSchema, meta: usuarioMeta };

/**
 * Superuser sentinel — every defined bit in PERM falls below 2^56, so this
 * mask is "all bits granted" for any current or near-future domain. Stored
 * as the user's `permissions` custom claim when isSuperUser is true.
 */
const SUPERUSER_MASK = (1n << 64n) - 1n;

/**
 * Aggregate a user's effective permission bitmask from their cargos.
 * Caller must pass the Cargo docs for every id in `user.cargos`; missing
 * cargos contribute 0n (treated as having been deleted).
 */
export function aggregatePermissoes(
  user: Pick<Usuario, 'cargos' | 'isSuperUser'>,
  cargosById: Map<string, Pick<Cargo, 'permissoes'>>,
): bigint {
  if (user.isSuperUser) return SUPERUSER_MASK;
  let bits = 0n;
  for (const id of user.cargos) {
    const c = cargosById.get(id);
    if (c) bits |= decodePermissoes(c);
  }
  return bits;
}
