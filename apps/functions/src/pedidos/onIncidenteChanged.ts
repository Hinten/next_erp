import { incidenteMeta } from '@delfrance/schemas';

import { PEDIDO_HISTORY_ROOT } from '../lib/historyRoots';
import {
  makeModificationHistoryTrigger,
  type ModificationHistorySource,
} from '../lib/modificationHistory';

/**
 * `pedidos/{pedidoId}/incidentes/{docId}` modification-history trigger — troca
 * and devolução incidents. Rows land in the PEDIDO's history tagged
 * `subcolecao: 'incidentes'`, so an incident shows up in the same chronology as
 * the pedido edit that caused it.
 *
 * `resolucao` is a small nested object compared wholesale; that is intended,
 * because its movement carries money (`resolucao.valor`).
 *
 * Worth knowing, and a feature rather than churn: `sincronizarEstoquePedido`
 * CREATES an incidente inside its own transaction (the legacy-reconstruction
 * path). That produces a legitimate `kind: 'create'` row with
 * `usuarioOuterRef: null` → "Sistema", which is precisely the record that
 * explains an otherwise-unexplained stock movement.
 *
 * `requireParentExists` is deliberately OFF — see {@link PEDIDO_HISTORY_ROOT}.
 *
 * Exported for the offline + emulator suites; `makeModificationHistoryTrigger`
 * targets the NAMED `default` database (gotcha #8).
 */
export const incidenteHistorySource: ModificationHistorySource = {
  root: PEDIDO_HISTORY_ROOT,
  subcolecao: 'incidentes',
  /**
   * `saveIncidente` stamps `ultimaModificacao` on EVERY write, including a save
   * that changed nothing else, and `incidenteDataFromForm` spreads the existing
   * doc first (specifically so out-of-band fields survive), which round-trips
   * `timestamp` on every edit. Neither is ever an operator edit.
   */
  ignoreFields: ['timestamp', 'ultimaModificacao'],
  resolve(params) {
    // Both wildcards are always present at runtime; the Record index type
    // can't know that (same cast as `onEstoqueDeleted`).
    const { pedidoId, docId } = params as { pedidoId: string; docId: string };
    return { parentId: pedidoId, docId, path: `pedidos/${pedidoId}/incidentes/${docId}` };
  },
};

export const onIncidenteChanged = makeModificationHistoryTrigger(
  `${incidenteMeta.collectionPath}/{docId}`,
  incidenteHistorySource,
);
