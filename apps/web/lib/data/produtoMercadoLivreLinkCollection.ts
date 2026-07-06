import { produtoMercadoLivreLinkSchema } from '@delfrance/schemas';
import { defineCollection } from '@delfrance/data';

/**
 * Typed handle for the `produtos/{id}/produtoMercadoLivre` link subcollection —
 * one doc per connected Mercado Livre account carrying the listing binding
 * (ML item id, estado, category, errors…) in the exact old Flutter wire shape.
 * The Mercado Livre tab on the produto editor READS these live to surface the
 * publish status; the docs themselves are written server-side by
 * apps/mercado-livre (`publishProduto`) and by the still-running Flutter app.
 *
 * Rules coverage comes from the loose marketplace-subcollection domain
 * (`PRODUTO_SUBCOLLECTION_NAMES`), same as the deletion-guard handles.
 */
export const produtoMercadoLivreLinkCollection = defineCollection({
  path: 'produtos/{produtoId}/produtoMercadoLivre',
  schema: produtoMercadoLivreLinkSchema,
});
