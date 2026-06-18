import { defineCollection } from '@delfrance/data';
import { estoqueProdutoSchema } from '@delfrance/schemas';

/**
 * The `produtos/{produtoId}/estoques` subcollection — per-depósito stock for a
 * produto. Each doc has the deterministic id `est-<produtoId>-<depositoId>`
 * (`makeEstoqueUid`), matching the Flutter `Estoque.save()` so both apps coexist
 * on the same docs. `quantidade`/`quantidadeReservada` are movement-owned; the
 * produto screen only edits `localizacao`.
 */
export const estoqueProdutoCollection = defineCollection({
  path: 'produtos/{produtoId}/estoques',
  schema: estoqueProdutoSchema,
});
