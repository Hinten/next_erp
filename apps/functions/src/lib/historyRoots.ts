import {
  historicoModificacaoCollection,
  historicoModificacaoPedidoCollection,
  pedidoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';

import type { ModificationHistoryRoot } from './modificationHistory';

/**
 * The concrete {@link ModificationHistoryRoot}s. Kept out of
 * `./modificationHistory` so that module imports no domain collection and
 * cannot grow a per-root branch — same split as `cascadeCaroGenerico.ts`
 * (generic) vs `../cascades/caroGenericoTriggers.ts` (its instantiations).
 */

/**
 * `produtos/{produtoId}/historicoDeModificacoes`.
 *
 * This subtree IS swept on a produto delete (`onProdutoDeleted` walks it), which
 * is why every produto source sets `requireParentExists: true` — an entry
 * recorded under an already-gone produto would be swept a moment later or
 * orphaned outright.
 */
export const PRODUTO_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: produtoCollection,
  historyCollection: historicoModificacaoCollection,
  parentIdParam: 'produtoId',
};

/**
 * `pedidos/{pedidoId}/historicoDeModificacoes`.
 *
 * ⚠️ `pedidos` declares a cascade and deliberately has NO delete trigger (owner
 * call, 2026-08 — `pedidos/{id}/nfev4` holds emitted fiscal documents), so
 * NOTHING sweeps this subtree. The opposite conclusion follows: pedido sources
 * leave `requireParentExists` OFF, because here a row that outlives its pedido is
 * the only surviving record that the order existed and who removed it.
 */
export const PEDIDO_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: pedidoCollection,
  historyCollection: historicoModificacaoPedidoCollection,
  parentIdParam: 'pedidoId',
};
