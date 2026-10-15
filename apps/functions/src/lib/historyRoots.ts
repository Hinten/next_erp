import {
  historicoModificacaoCollection,
  historicoModificacaoPedidoCollection,
  pedidoCollection,
  produtoCollection,
} from '@delfrance/data/admin/collections';
import {
  CAMPO_HISTORICO_PRECO_CUSTO,
  RETENCAO_HISTORICO_PEDIDO_ANOS,
  RETENCAO_HISTORICO_PRODUTO_DIAS,
  expiraEmApos,
  expiraEmAposAnos,
} from '@delfrance/schemas';

import type { ModificationEntry, ModificationHistoryRoot } from './modificationHistory';

/**
 * A `delete` row is kept forever under every root: it carries the full
 * pre-delete snapshot, which is what #648's "Restaurar documento" rebuilds
 * from — and under `pedidos` it is the only record a deleted pedido existed.
 */
const ehExclusao = (entry: ModificationEntry) => entry.kind === 'delete';

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
 *
 * Retention (#651): hot produtos write a row on every import re-write, so rows
 * expire after a year — EXCEPT delete rows and rows touching price or cost,
 * which the "Histórico de preço/custo" button reads with no time bound.
 */
export const PRODUTO_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: produtoCollection,
  historyCollection: historicoModificacaoCollection,
  parentIdParam: 'produtoId',
  retencao: {
    expiraEm: (eventoMs) => expiraEmApos(eventoMs, RETENCAO_HISTORICO_PRODUTO_DIAS),
    manter: (entry) =>
      ehExclusao(entry) ||
      entry.campos.includes(CAMPO_HISTORICO_PRECO_CUSTO.preco) ||
      entry.campos.includes(CAMPO_HISTORICO_PRECO_CUSTO.custo),
  },
};

/**
 * `pedidos/{pedidoId}/historicoDeModificacoes`.
 *
 * ⚠️ `pedidos` declares a cascade and deliberately has NO delete trigger (owner
 * call, 2026-08 — `pedidos/{id}/nfev4` holds emitted fiscal documents), so
 * NOTHING sweeps this subtree. The opposite conclusion follows: pedido sources
 * leave `requireParentExists` OFF, because here a row that outlives its pedido is
 * the only surviving record that the order existed and who removed it.
 *
 * Retention: six CALENDAR years (`RETENCAO_HISTORICO_PEDIDO_ANOS` says why six,
 * and why not 2190 days), and a delete row never expires, for the reason above.
 */
export const PEDIDO_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: pedidoCollection,
  historyCollection: historicoModificacaoPedidoCollection,
  parentIdParam: 'pedidoId',
  retencao: {
    expiraEm: (eventoMs) => expiraEmAposAnos(eventoMs, RETENCAO_HISTORICO_PEDIDO_ANOS),
    manter: ehExclusao,
  },
};
