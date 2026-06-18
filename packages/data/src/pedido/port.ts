/**
 * The pedido data-access **port** — the surface the pedido use-cases
 * (`usecases.ts`) need, abstracted from any Firestore SDK. The same partial-save
 * orchestration therefore runs under the client SDK (apps/web adapter) and
 * firebase-admin (a future agent / MCP adapter); each SDK supplies its own thin
 * adapter, and all wire-shape + path knowledge stays in the use-cases.
 *
 * Mirrors `../produto/port.ts`. The pedido doc save needs a transactional
 * read-modify-write (the optimistic-concurrency guard the legacy
 * `cadastroPedidoProvider.save` ran), so the port exposes that primitive instead
 * of produto's fire-and-forget `commit(ops)`.
 */

/**
 * A pedido document as the use-cases read it inside the transaction (null when
 * the doc is missing). Field values MUST already be in the parsed **wire shape**
 * the use-cases expect — in particular `ultimaModificacao` is a `number | null`
 * (µs epoch), NOT a raw Firestore `Timestamp`. The client adapter gets this for
 * free by reading through the Zod converter; a firebase-admin adapter MUST
 * normalize SDK types (e.g. `Timestamp` → µs epoch) before calling `apply`, or
 * the concurrency guard would never match and conflict permanently.
 */
export type PedidoDocData = Record<string, unknown> | null;

/**
 * One write in a logical batch — `path` is a full Firestore document path
 * (e.g. `pedidos/<id>/historicoEstadoPedido/<docId>`). The adapter chunks the op
 * list into ≤499-op batches, preserving order. Mirrors `ProdutoWriteOp`.
 */
export type PedidoWriteOp =
  | { type: 'set'; path: string; data: Record<string, unknown> }
  | { type: 'update'; path: string; data: Record<string, unknown> }
  | { type: 'delete'; path: string };

export interface PedidoDataPort {
  /**
   * Current time as a µs-epoch int — the wire unit for the pedido's
   * `microsSinceEpoch()` datetime fields (`ultimaModificacao`, history `data`).
   */
  now(): number;

  /** Mint a new document id (client random id or admin auto-id). */
  newId(): string;

  /**
   * Atomically read-modify-write the pedido doc. `apply` runs INSIDE the
   * transaction with the current doc data (null if the doc is gone) and returns
   * the patch to `update()`; throwing from `apply` aborts the transaction with
   * no write (how the use-case raises a concurrency conflict).
   */
  updatePedido(
    pedidoId: string,
    apply: (current: PedidoDocData) => Record<string, unknown>,
  ): Promise<void>;

  /**
   * Apply subcollection writes (history, incidentes, pagamentos) — fire-and-
   * forget, in order. The adapter chunks into ≤499-op batches.
   */
  commit(ops: PedidoWriteOp[]): Promise<void>;
}
