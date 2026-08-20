import type { CollectionMetadata } from '../../types';

export {
  historicoModificacaoSchema,
  type HistoricoModificacao,
} from '../../shared/historicoModificacoes';
import { historicoModificacaoSchema } from '../../shared/historicoModificacoes';

// Unified modification history is produto-scoped: it reuses the produto
// permission bits (byte 8 — see `produto.ts`), so reading a produto's history
// requires the same read claim as the produto itself. Write/delete bits are
// declared (required by `resolvePermissions`, which throws on an invalid bit)
// but stay inert — `meta.serverOwned` makes the rules generator deny every
// client write regardless of claim.
const PERM_PRODUTO_READ = 1n << 8n;
const PERM_PRODUTO_WRITE = 1n << 9n;
const PERM_PRODUTO_DELETE = 1n << 10n;

/**
 * `produtos/{id}/historicoDeModificacoes` — the produto-rooted instance of the
 * shared entry schema (`../../shared/historicoModificacoes`). Written
 * EXCLUSIVELY by the `onProdutoChanged` trigger family (Admin SDK,
 * `apps/functions`).
 *
 * This supersedes the per-field `historicoDePrecos`/`historicoDeCusto`
 * subcollections (`./historicos.ts`) for produto writes made through this app:
 * those two stay registered (the migrated corpus holds rows in them), but the
 * Next trigger no longer writes them.
 *
 * The pedido-rooted twin is
 * `../../pedido/collection/historicoModificacoes.ts`; the two metas are pinned
 * to each other by `../../shared/historicoModificacoes.meta.test.ts`.
 */
export const historicoModificacaoMeta: CollectionMetadata = {
  collectionPath: 'produtos/{produtoId}/historicoDeModificacoes',
  permissions: {
    read: PERM_PRODUTO_READ,
    write: PERM_PRODUTO_WRITE,
    delete: PERM_PRODUTO_DELETE,
  },
  serverOwned: true,
  // Every read is scoped to ONE produto (`ModificacoesManager` /
  // `ProdutoHistoryButton` both resolve `{ produtoId }`), so the generator's
  // default `{path=**}/historicoDeModificacoes` block buys nothing — and it
  // actively hurts now that a second root shares this leaf name: `emit.ts`
  // makes a group block's read check the UNION of every owning collection's
  // read claim, so leaving it on would let `d_pedido` group-read every
  // produto's history (custo and precos included) and vice versa. Suppressing
  // it on ONE meta is not enough — the wildcard matches any parent, so the
  // surviving block would still cover the other root's docs. Both metas set it.
  noCollectionGroupRead: true,
  // The Modificações tab's feed query (`ModificacoesManager`): newest-first,
  // one page. Declared so the `defaultQuery.indexes` meta-test REQUIRES the
  // matching `historicoDeModificacoes(timestamp desc)` entry — the tab has
  // always issued this sort, but with no defaultQuery nothing forced the index
  // and Enterprise would silently full-scan (the #717 failure, on produto this
  // time). `campos CONTAINS + timestamp desc` (ProdutoHistoryButton) stays
  // hand-maintained: `CollectionDefaultQuery` has no array-contains form.
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoModificacao = {
  schema: historicoModificacaoSchema,
  meta: historicoModificacaoMeta,
};
