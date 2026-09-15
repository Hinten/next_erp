import { enderecoMeta } from '@delfrance/schemas';

import { CLIENTE_HISTORY_ROOT } from '../lib/historyRoots';
import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `clientes/{clienteId}/enderecos/{docId}` modification-history trigger. Rows
 * land in the CLIENTE's `historicoDeModificacoes` (tagged
 * `subcolecao: 'enderecos'`), not in a subcollection of the endereço — the same
 * shape the pedido `pagamentos`/`incidentes` sources and the produto
 * `extraData`/`imposto` sources already use.
 *
 * `requireParentExists` is deliberately OFF — see {@link CLIENTE_HISTORY_ROOT}.
 * With no cliente delete-cascade, an endereço delete arriving after its cliente
 * is gone is exactly the event that most needs a row, and the guard would drop
 * it.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const enderecoHistorySource: ModificationHistorySource = {
  root: CLIENTE_HISTORY_ROOT,
  subcolecao: 'enderecos',
  ignoreFields: ['timestamp', 'ultimaModificacao'],
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { clienteId, docId } = params as { clienteId: string; docId: string };
    return { parentId: clienteId, docId, path: `clientes/${clienteId}/enderecos/${docId}` };
  },
};

export const onEnderecoChanged = makeModificationHistoryTrigger(
  `${enderecoMeta.collectionPath}/{docId}`,
  enderecoHistorySource,
);
