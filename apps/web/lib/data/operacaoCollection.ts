import { defineCollection } from '@delfrance/data';
import { operacaoSchema } from '@delfrance/schemas';

/**
 * Top-level: `operacao`. Fiscal operations (Venda, Compra, …) the
 * NFe orchestrator reads through `pedido.operacaoPedidoOuterRef`.
 */
export const operacaoCollection = defineCollection({
  path: 'operacao',
  schema: operacaoSchema,
});
