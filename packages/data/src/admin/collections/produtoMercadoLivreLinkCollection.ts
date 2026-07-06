import { produtoMercadoLivreLinkSchema, variacaoMercadoLivreLinkSchema } from '@delfrance/schemas';

import { defineAdminCollection } from '../defineAdminCollection';

/**
 * Admin-SDK handles for the Mercado Livre listing link docs, written by the
 * apps/mercado-livre publish flow in the EXACT old Flutter wire shape (dual-run
 * coexistence — the Flutter app keeps reading these). Client-side reads go
 * through the loose pass-through subcollection domains (`subcollections.ts`);
 * these typed handles exist so server writes can't drift from the wire format.
 * Doc ids are Firestore auto-ids (the ML item id lives in the `id` field).
 */
export const produtoMercadoLivreLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/produtoMercadoLivre',
  schema: produtoMercadoLivreLinkSchema,
});

/** Variation link — saved under the variation CHILD produto. */
export const variacaoMercadoLivreLinkCollection = defineAdminCollection({
  path: 'produtos/{produtoId}/variacaoMercadoLivre',
  schema: variacaoMercadoLivreLinkSchema,
});
