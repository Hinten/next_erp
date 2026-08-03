import { z } from 'zod';
import { millisSinceEpoch } from './shared/datetime';
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
  // Legacy `Usuario.apelido` — the external-channel nickname (e.g. a Mercado
  // Livre buyer's site nickname), distinct from `nome`. Written by the ML
  // claims import (Step 14) when resolving a sem-auth buyer contact; null for
  // every real (authenticated) user and for channels without a nickname.
  apelido: z.string().nullable().default(null).describe('Apelido'),
  // Nullable: sem-auth external-channel contacts (see `externalId` below) are
  // never real Firebase Auth accounts, so they carry no email at all — only
  // a `usuarios` doc identified by `externalId`. Every collaborator/admin
  // account created through `/api/admin/users` still requires a real email
  // at the Firebase Auth layer; this field just stops rejecting the docs
  // that legitimately have none.
  email: z.string().email().max(255).nullable().default(null),
  cargos: z.array(z.string()).default([]),
  colaborador: z.boolean().default(false),
  ativo: z.boolean().default(true),
  isSuperUser: z.boolean().default(false),
  jaFoiColaborador: z.boolean().default(false),
  jaFoiSuperUser: z.boolean().default(false),
  // Datetime fields — millisecondsSinceEpoch INT wire format (#484/#486, legacy
  // `maybeDateTimeToJson` parity); reads tolerate a stray ISO/µs value via the codec.
  ultimoAcesso: millisSinceEpoch().nullable().default(null),
  // System stamps — create-only `timestamp` and last-modified on every write.
  timestamp: millisSinceEpoch().nullable().default(null),
  ultimaModificacao: millisSinceEpoch('Última modificação').nullable().optional(),
  /**
   * Sem-auth external-channel contact key — legacy `generateExternalId`:
   * `sha256('<canal>-<externalId>')` (e.g. `'whatsapp-5511999999999'`),
   * used to identify a chat participant that never signs into Firebase Auth
   * (a WhatsApp/Facebook end customer). Used by the WhatsApp
   * `discover_user`/contact-resolution port (#527) to find-or-create a
   * `usuarios` doc for an inbound message's sender without an Auth account.
   * Null for every real (authenticated) user.
   */
  externalId: z.string().nullable().default(null),
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
 * Superuser sentinel — "all bits granted" for any current or near-future
 * domain. Stored as the user's `permissions` custom claim when isSuperUser
 * is true.
 *
 * Was `(1n << 64n) - 1n` until the frete domain landed: PERM had already
 * outgrown 64 bits (estoque=64+, fiscal=72+, arquivo=80+, frete=88+), and
 * `hasPerm` is a plain bit-AND, so superusers minted with the old mask are
 * missing those domains — re-mint their claims (toggle isSuperUser or run
 * grant-all-perms) after deploying this change.
 */
export const SUPERUSER_MASK = (1n << 128n) - 1n;

/**
 * Detector for superuser identity from a raw bitmask: a superuser claim
 * carries every `SUPERUSER_MASK` bit. Used by both UI (toggle visibility)
 * and the backend cascade-guard (to gate creation/promotion of other
 * superusers).
 *
 * The previous heuristic (`bits >= 2^60`) broke once PERM domains crossed
 * bit 60 — any user holding estoque/fiscal/arquivo/frete bits was
 * mis-detected as superuser and could promote superusers. Claims minted
 * with the old 64-bit mask no longer qualify; re-mint them.
 */
export function isSuperUserBits(bits: bigint): boolean {
  return (bits & SUPERUSER_MASK) === SUPERUSER_MASK;
}

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
