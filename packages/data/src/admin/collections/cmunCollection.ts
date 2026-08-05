import { cmunMeta, cmunSchema } from '@delfrance/schemas';
import { defineAdminCollection } from '../defineAdminCollection';

/**
 * `CMUN` — the CEP-faixa → IBGE município table.
 *
 * Admin-only by design (`cmunMeta.serverOwned`): the sole writer is the NF-e
 * resolver's ViaCEP write-back in `../cmun.ts`.
 */
export const cmunCollection = defineAdminCollection({
  path: cmunMeta.collectionPath,
  schema: cmunSchema,
});
