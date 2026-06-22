import { defineCollection } from '@delfrance/data';
import { historicoEstoqueSchema } from '@delfrance/schemas';

/**
 * The `produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque` subcollection
 * — the audit log behind the conflict-safe quantity editor. Each entrada / saída
 * / balanço appends one record alongside the atomic `increment` (or balanço
 * absolute set) on the parent estoque doc. Matches the Flutter `HistoricoEstoque`
 * so both apps coexist on the same docs.
 */
export const historicoEstoqueCollection = defineCollection({
  path: 'produtos/{produtoId}/estoques/{estoqueId}/historicoEstoque',
  schema: historicoEstoqueSchema,
});
