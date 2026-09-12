import {
  clienteCollection,
  historicoModificacaoClienteCollection,
  historicoModificacaoCollection,
  historicoModificacaoOperacaoCollection,
  historicoModificacaoPedidoCollection,
  operacaoCollection,
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

/**
 * `clientes/{clienteId}/historicoDeModificacoes`.
 *
 * Like `pedidos`, `clientes` declares a cascade (`enderecos`) but deliberately
 * has NO delete trigger enforcing it (owner call, 2026-08 — an endereço is read
 * LIVE by ref from the NF-e orchestrator and the pedido printer, so cascading it
 * would break reprinting/re-emission for every historical pedido of that
 * customer). Nothing sweeps this subtree, so cliente sources leave
 * `requireParentExists` OFF — a row that outlives its cliente is the only
 * surviving record that the customer existed and who removed it.
 */
export const CLIENTE_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: clienteCollection,
  historyCollection: historicoModificacaoClienteCollection,
  parentIdParam: 'clienteId',
};

/**
 * `operacao/{operacaoId}/historicoDeModificacoes`.
 *
 * This subtree IS swept on an operação delete (`onOperacaoDeleted` walks it via
 * `deleteDocumentSubtree`'s `listCollections()` discovery), which is why every
 * operação source sets `requireParentExists: true` — an entry recorded under an
 * already-gone operação would be swept a moment later or orphaned outright.
 */
export const OPERACAO_HISTORY_ROOT: ModificationHistoryRoot = {
  parentCollection: operacaoCollection,
  historyCollection: historicoModificacaoOperacaoCollection,
  parentIdParam: 'operacaoId',
};
