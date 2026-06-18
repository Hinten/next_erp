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

/** A raw pedido document as the transaction reads it (null when missing). */
export type PedidoDocData = Record<string, unknown> | null;

export interface PedidoDataPort {
  /**
   * Current time as a µs-epoch int — the wire unit for the pedido's
   * `microsSinceEpoch()` `ultimaModificacao` field.
   */
  now(): number;

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
}
