import type { CollectionMetadata } from '../../types';
import { historicoModificacaoSchema } from '../../shared/historicoModificacoes';

// Shares the PEDIDO permission domain (audit trail of the parent order), the
// same convention as `historicoEstadoPedido` / `historicoFtIni`. NOT the
// pagamento bits (1n<<24n..): pagamento changes are recorded as rows of THIS
// collection (`subcolecao: 'pagamentos'`), the collection lives under
// `pedidos/{id}`, and its feed is a tab of the pedido editor — so a `d_pedido`
// holder must not need a second claim to open it. Write/delete bits are
// declared because `resolvePermissions` throws on an invalid bit, but stay
// inert under `serverOwned`.
const PERM_PEDIDO_READ = 1n << 16n;
const PERM_PEDIDO_WRITE = 1n << 17n;
const PERM_PEDIDO_DELETE = 1n << 18n;

/**
 * `pedidos/{pedidoId}/historicoDeModificacoes` — the pedido-rooted instance of
 * the shared entry schema (`../../shared/historicoModificacoes`).
 *
 * ⚠️ There is exactly ONE history collection per root, not one per covered
 * subcollection. Changes to `pedidos/{id}/pagamentos/{pagamentoId}` and
 * `pedidos/{id}/incidentes/{incidenteId}` are recorded as rows HERE, tagged
 * with `subcolecao: 'pagamentos' | 'incidentes'` and `docId: <childId>` — the
 * same shape produto already uses for its `extraData` / `imposto` subdocs. That
 * is what makes the pedido's edit history one chronological feed instead of
 * three, and it is why the payment trail hangs off the pedido rather than off
 * the pagamento (which is where the legacy Flutter `histpgto` put it).
 *
 * Written EXCLUSIVELY by the `apps/functions` pedido trigger family
 * (`onPedidoEstadoChanged`, `onPagamentoChanged`, `onIncidenteChanged`).
 *
 * ⚠️ Unlike produto, `pedidos` has NO delete-cascade trigger (owner call,
 * 2026-08 — `pedidos/{id}/nfev4` holds emitted fiscal documents), so a row here
 * SURVIVES the deletion of its pedido rather than being swept. That is
 * deliberate: a delete row is then the only surviving record that the order
 * existed and who removed it. See the `requireParentExists` rationale on each
 * `ModificationHistorySource`.
 */
export const historicoModificacaoPedidoMeta: CollectionMetadata = {
  collectionPath: 'pedidos/{pedidoId}/historicoDeModificacoes',
  permissions: {
    read: PERM_PEDIDO_READ,
    write: PERM_PEDIDO_WRITE,
    delete: PERM_PEDIDO_DELETE,
  },
  serverOwned: true,
  // See the twin in `../../produto/collection/historicoModificacoes.ts`: the
  // generator unions the read claims of every collection sharing a leaf name
  // into one `{path=**}` block, so leaving this on would let `d_pedido`
  // group-read every produto's history and vice versa. Must be set on BOTH.
  noCollectionGroupRead: true,
  // Identical to the produto twin, and identical to what the feed issues.
  // Because `deriveRequiredIndex` keys on the collection LEAF, this derives the
  // same `historicoDeModificacoes(timestamp desc)` requirement the produto twin
  // does — and a `queryScope: COLLECTION` index keyed on a collection id
  // applies at any path, so the existing entry already covers this collection.
  defaultQuery: {
    orderBy: [{ field: 'timestamp', direction: 'desc' }],
    limit: 50,
  },
};

export const historicoModificacaoPedido = {
  schema: historicoModificacaoSchema,
  meta: historicoModificacaoPedidoMeta,
};
