import { clienteMeta } from '@delfrance/schemas';

import { CLIENTE_HISTORY_ROOT } from '../lib/historyRoots';
import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `clientes/{clienteId}` modification-history trigger — the cliente DOCUMENT's
 * own entry. Rows land in `clientes/{clienteId}/historicoDeModificacoes`
 * (`subcolecao: null`); the covered `enderecos` subcollection rides its own
 * trigger (`onEnderecoChanged`), tagging its rows `subcolecao: 'enderecos'`, so
 * the whole cliente reads as ONE chronological feed — the same shape produto
 * and pedido already use.
 *
 * Unlike produto (and like pedido), a cliente delete IS recorded rather than
 * skipped: `clientes` declares a cascade over `enderecos` but deliberately has
 * NO delete trigger enforcing it (owner call, 2026-08 — an endereço is read
 * LIVE by ref from the NF-e orchestrator and the pedido printer), so nothing
 * sweeps a cliente's subtree. The row this trigger writes on delete is then the
 * only surviving record that the customer existed and who removed it —
 * `makeModificationHistoryTrigger`'s default (`requireParentExists` unset)
 * already does this: it only skips a write when the PARENT is gone, and here
 * the cliente's own delete write has no parent to check against.
 *
 * `nome_embedding`/`telefone_embedding` are NOT ignored: nothing in
 * `apps/functions` currently writes them back after the fact (unlike the
 * estoque-sync-style phantom-row cases `PEDIDO_HISTORY_IGNORE_FIELDS` guards
 * against), so there is no repeated-write-back noise to suppress yet — revisit
 * if that changes.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const clienteHistorySource: ModificationHistorySource = {
  root: CLIENTE_HISTORY_ROOT,
  subcolecao: null,
  ignoreFields: ['timestamp', 'ultimaModificacao'],
  resolve(params) {
    const { clienteId } = params as { clienteId: string };
    return { parentId: clienteId, docId: clienteId, path: `clientes/${clienteId}` };
  },
};

export const onClienteChanged = makeModificationHistoryTrigger(
  `${clienteMeta.collectionPath}/{clienteId}`,
  clienteHistorySource,
);
