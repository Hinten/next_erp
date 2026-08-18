import { pagamentoMeta } from '@delfrance/schemas';

import { PEDIDO_HISTORY_ROOT } from '../lib/historyRoots';
import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `pedidos/{pedidoId}/pagamentos/{docId}` modification-history trigger.
 *
 * Rows land in the PEDIDO's `historicoDeModificacoes` (tagged
 * `subcolecao: 'pagamentos'`), not in a subcollection of the pagamento — that is
 * what makes a pedido's edit history one chronological feed, and it is the
 * deliberate difference from the legacy Flutter `histpgto`, which hung a
 * status-only trail off each pagamento.
 *
 * This supersedes that trail in both directions: `status_pagamento` is recorded
 * like any other field, so the transition legacy captured is still there, and so
 * is everything it silently ignored (`valor`, `forma_de_pagamento`, `parcelas`,
 * `vencimento`, the cartão/cheque blocks, …). A payment whose VALUE changed
 * without its status moving used to be invisible; it is the change most likely
 * to move money.
 *
 * `requireParentExists` is deliberately OFF — see {@link PEDIDO_HISTORY_ROOT}.
 * With no pedido delete-cascade, a pagamento delete arriving after its pedido is
 * gone is exactly the event that most needs a row, and the guard would drop it.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const pagamentoHistorySource: ModificationHistorySource = {
  root: PEDIDO_HISTORY_ROOT,
  subcolecao: 'pagamentos',
  /**
   * `id` mirrors the document id (never a meaningful edit — same reasoning as
   * `impostoHistorySource`). `ultimaModificacao` is stamped on every write AND
   * is the Mercado Livre importer's update-if-newer key, so it advances on every
   * accepted re-import; because that importer does a wholesale `tx.set`,
   * ignoring the stamp is what makes a content-identical re-import produce an
   * empty diff and therefore NO row at all.
   *
   * `dataCadastro` is deliberately NOT ignored: it never moves on an update, so
   * ignoring it would buy nothing, while recording it makes a backdated payment
   * visible.
   */
  ignoreFields: ['id', 'ultimaModificacao'],
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { pedidoId, docId } = params as { pedidoId: string; docId: string };
    return { parentId: pedidoId, docId, path: `pedidos/${pedidoId}/pagamentos/${docId}` };
  },
};

export const onPagamentoChanged = makeModificationHistoryTrigger(
  `${pagamentoMeta.collectionPath}/{docId}`,
  pagamentoHistorySource,
);
