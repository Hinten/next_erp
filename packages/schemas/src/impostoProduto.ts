import { z } from 'zod';
import { millisSinceEpoch } from './datetime';
import type { CollectionMetadata } from './types';

const PERM_IMPOSTO_PRODUTO_READ = 1n << 75n;
const PERM_IMPOSTO_PRODUTO_WRITE = 1n << 76n;
const PERM_IMPOSTO_PRODUTO_DELETE = 1n << 77n;

/**
 * ImpostoProduto — subcoleção `produtos/{produtoId}/imposto/{auto-id}`.
 * Per-produto Imposto override, looked up by the orchestrator's
 * `resolveItemImposto` cascade when a pedido item lacks pre-stamped
 * `imposto`.
 *
 * `impostoOperacaoOuterRef` is the scope pointer (Flutter parity):
 *   - `null`        → applies to any operação (default fallback)
 *   - operação id   → only matches when the active emission's operação
 *                     matches this id
 *
 * The imposto blob fields (`origem`, `cfop`, `NCM`, `configuracaoICMS`,
 * `configuracaoISSQN`, `configuracaoIPI`, `configuracaoPIS`,
 * `configuracaoCOFINS`, `retencao`, ...) are pass-through here and
 * validated downstream by integrations-nfe's tribute `impostoSchema`
 * at use time — same posture as `pedido.itens[i].imposto`. Keeps
 * packages/schemas free of a circular dep on the NF-e tribute engine.
 */
export const impostoProdutoSchema = z
  .object({
    id: z.string().nullable().default(null),
    impostoOperacaoOuterRef: z.string().nullable().default(null),
    dataCadastro: millisSinceEpoch().nullable().default(null),
  })
  .passthrough();

export type ImpostoProduto = z.infer<typeof impostoProdutoSchema>;

export const impostoProdutoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/imposto',
  permissions: {
    read: PERM_IMPOSTO_PRODUTO_READ,
    write: PERM_IMPOSTO_PRODUTO_WRITE,
    delete: PERM_IMPOSTO_PRODUTO_DELETE,
  },
};

export const impostoProduto = {
  schema: impostoProdutoSchema,
  meta: impostoProdutoMeta,
};
