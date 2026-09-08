import type { CollectionMetadata } from './types';

export {
  historicoModificacaoSchema,
  type HistoricoModificacao,
} from './shared/historicoModificacoes';
import { historicoModificacaoSchema } from './shared/historicoModificacoes';

// Mirrors `operacaoMeta` (`./operacao.ts`) — the fiscal permission domain (byte
// 9, bits 72-74), same convention as the produto/pedido twins: reading an
// operação's history requires the same read claim as the operação itself.
// Write/delete bits are declared (required by `resolvePermissions`, which
// throws on an invalid bit) but stay inert — `meta.serverOwned` makes the
// rules generator deny every client write regardless of claim.
const PERM_FISCAL_READ = 1n << 72n;
const PERM_FISCAL_WRITE = 1n << 73n;
const PERM_FISCAL_DELETE = 1n << 74n;

/**
 * `operacao/{id}/historicoDeModificacoes` — the operação-rooted instance of the
 * shared entry schema (`./shared/historicoModificacoes`). Written EXCLUSIVELY by
 * the `apps/functions` operação trigger family (`onOperacaoChanged` for the
 * operação document itself, `onRegraImpostoChanged` for its covered `regras`
 * subcollection).
 *
 * ⚠️ Unlike `clientes`/`pedidos`, `operacao` DOES have a delete-cascade trigger
 * (`onOperacaoDeleted`, `apps/functions/src/operacoes/onOperacaoDeleted.ts`),
 * which sweeps the operação's WHOLE subtree via `deleteDocumentSubtree`'s
 * `listCollections()` discovery — this collection included, with no code change
 * needed on that side. That is why every operação source sets
 * `requireParentExists: true`, the same convention `historicoModificacaoMeta`
 * (produto) uses: a write racing that cascade must not record (and therefore
 * orphan) an entry under an already-gone operação.
 *
 * The other rooted instances are `../produto/collection/historicoModificacoes.ts`,
 * `../pedido/collection/historicoModificacoes.ts` and
 * `./clienteHistoricoModificacoes.ts`; all four metas are pinned to each other
 * by `./shared/historicoModificacoes.meta.test.ts`.
 */
export const historicoModificacaoOperacaoMeta: CollectionMetadata = {
  collectionPath: 'operacao/{operacaoId}/historicoDeModificacoes',
  permissions: {
    read: PERM_FISCAL_READ,
    write: PERM_FISCAL_WRITE,
    delete: PERM_FISCAL_DELETE,
  },
  serverOwned: true,
  // Shares the `historicoDeModificacoes` leaf with the produto/pedido/cliente
  // roots — see the cliente twin for why every root sharing the leaf must set
  // this.
  noCollectionGroupRead: true,
  // Same shape the produto/pedido feeds issue (newest first). The existing
  // `historicoDeModificacoes(timestamp desc)` COLLECTION-scope index already
  // covers it — see the cliente twin.
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoModificacaoOperacao = {
  schema: historicoModificacaoSchema,
  meta: historicoModificacaoOperacaoMeta,
};
