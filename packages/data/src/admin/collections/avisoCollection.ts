import { avisoMeta, avisoSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * `avisos` — the operator notification inbox. Admin-only by construction: the
 * generated ruleset denies every client create/update/delete (`serverOwned`),
 * so this handle is the only way anything is written.
 *
 * Prefer `escreverAviso` / `resolverAviso` from `@delfrance/data/admin/avisos`
 * over touching this directly — they carry the dedup identity, the occurrence
 * counter and the concurrency posture that make repeat deliveries collapse
 * instead of duplicating.
 */
export const avisoCollection = defineAdminCollection({
  path: avisoMeta.collectionPath,
  schema: avisoSchema,
});
