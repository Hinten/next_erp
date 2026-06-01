import { defineCollection } from '@delfrance/data';
import { enviNfeMsgSchema } from '@delfrance/schemas';

/**
 * Subcollection: `filiais/{filialId}/enviNfe` — the append-only audit log of
 * every SEFAZ round-trip (emission, consult, cancelamento). Filtered by
 * `targetsChnfe array-contains <chave>` to show one NF-e's communication
 * history on the per-NF-e screen.
 */
export const enviNfeCollection = defineCollection({
  path: 'filiais/{filialId}/enviNfe',
  schema: enviNfeMsgSchema,
});
