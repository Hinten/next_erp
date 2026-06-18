import { defineCollection } from '@delfrance/data';
import { produtoExtraDataSchema } from '@delfrance/schemas';

/**
 * The `produtos/{produtoId}/extraData` singleton subcollection — the
 * Descrição + Google Merchant block of a produto. Only ever one doc, with the
 * fixed id `PRODUTO_EXTRA_DATA_DOC_ID` (`'singleton'`), matching the Flutter
 * `ProdutoExtraData.save()` so both apps coexist on the same doc.
 */
export const produtoExtraDataCollection = defineCollection({
  path: 'produtos/{produtoId}/extraData',
  schema: produtoExtraDataSchema,
});
