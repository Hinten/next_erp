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

/**
 * One multi-document transaction: read `reads`, then let `apply` decide the
 * writes. Generalizes `updatePedido` (one doc, one patch) to the devolução
 * save-time side effects (counter + N origin pedidos + 2 new pedidos in ONE
 * atomic commit).
 */
export interface PedidoTransactArgs {
  /**
   * Full doc paths to read (e.g. `counters/pedido`, `pedidos/<id>`). All reads
   * happen INSIDE the transaction and BEFORE any write — the Firestore JS SDK
   * requires every `tx.get` to precede the first write. The adapter dedupes.
   */
  reads: ReadonlyArray<string>;
  /**
   * Compute the writes from the tx-read docs (keyed by the requested path;
   * `null` when a doc is missing). Doc data is in the converter-parsed wire
   * shape (see {@link PedidoDocData}). The transaction may re-run `apply` on
   * contention, so it MUST be pure/re-entrant — derive everything from `docs`,
   * never from external mutable state. Throwing aborts with no write.
   */
  apply: (docs: ReadonlyMap<string, PedidoDocData>) => PedidoWriteOp[];
}

/**
 * The extended port the devolução (returns) use-cases need on top of
 * {@link PedidoDataPort}: a multi-doc transaction plus the one-shot reads that
 * resolve the devolução operação and the origin NF-e chaves. All read results
 * are converter-parsed wire shape (admin adapters must normalize `Timestamp` →
 * µs epoch, as with {@link PedidoDocData}).
 */
export interface PedidoDevolucaoDataPort extends PedidoDataPort {
  /** Run one atomic read-then-write transaction. See {@link PedidoTransactArgs}. */
  transact(args: PedidoTransactArgs): Promise<void>;

  /** One-shot read of a pedido doc (null when missing). */
  getPedido(pedidoId: string): Promise<PedidoDocData>;

  /** One-shot read of an `integracao` doc (null when missing). */
  getIntegracao(integracaoId: string): Promise<Record<string, unknown> | null>;

  /** One-shot read of an `operacao` doc (null when missing). */
  getOperacao(operacaoId: string): Promise<Record<string, unknown> | null>;

  /**
   * The default entrada operação: operações with `tipo === 0` (entrada) and
   * `ativo === true`, picking `find(padrao) ?? first` client-side (the repo's
   * existing default-operação pattern). Null when none exists.
   */
  findOperacaoEntradaPadrao(): Promise<{ id: string; data: Record<string, unknown> } | null>;

  /** The pedido's `nfev4` subcollection docs with `estado === 'a'` (aprovada). */
  listNFesAprovadas(pedidoId: string): Promise<ReadonlyArray<Record<string, unknown>>>;

  /**
   * Whether the pedido has ANY `nfev4` doc, regardless of estado (a limit-1
   * probe — cheaper than listing when only existence matters).
   */
  hasNFe(pedidoId: string): Promise<boolean>;
}
