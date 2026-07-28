import { valuesEqual, type EstadoPedido, type Pedido } from '@delfrance/schemas';
import type { PedidoDataPort, PedidoDocData, PedidoWriteOp } from './port';

/**
 * Money caches the legacy factory derives — never edited directly, so they ride
 * the patch only when their inputs (items / desconto / frete / devolução)
 * changed. Kept in sync with `derivePedidoTotals` (`@delfrance/schemas`).
 */
const DERIVED_CACHES = [
  'valorCobrado',
  'valorCusto',
  'valorFreteInicial',
  'custoFreteInicial',
  'valorDevolucao',
  'valorCustoDevolvidos',
] as const;

/**
 * Form-only / transient keys that must never reach the pedido doc: the
 * synthetic flat-items array, the persisted error, and the page-model transient
 * validation context (`id` / `ehSaidaOriginal`).
 */
const NON_DOC_KEYS = new Set(['_itensFlat', 'error', 'id', 'ehSaidaOriginal']);

/**
 * Build the **partial** Firestore patch for a pedido update from the resolved
 * (validate-what-you-save) form values + RHF's `dirtyFields`. Only the fields
 * the user actually touched are written — never the whole document (the legacy
 * app overwrote everything, clobbering concurrent edits to untouched fields).
 *
 * Items and the money caches are derived, not bound to inputs, so they don't
 * appear in `dirtyFields` on their own: when the items field (`_itensFlat`),
 * `descontoTotal`, `freteInicial` or `itensDevolvidos` is dirty we pull the
 * recomputed `itens` / `itensIds` and the derived caches from `values` (which
 * the resolver already filled via `derivePedidoTotals`).
 *
 * Pure — no clock. `savePedido` stamps `ultimaModificacao` at commit time, after
 * the no-op check, mirroring `ui/object/saveRecord`.
 */
export function buildPedidoPatch(
  values: Pedido,
  dirtyFields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const docValues = values as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  const isDirty = (k: string): boolean => Boolean(dirtyFields[k]);

  const itemsDirty = isDirty('_itensFlat') || isDirty('itens');
  const devolucaoDirty = isDirty('itensDevolvidos');
  const totalsDirty =
    itemsDirty || devolucaoDirty || isDirty('descontoTotal') || isDirty('freteInicial');

  for (const key of Object.keys(dirtyFields)) {
    if (NON_DOC_KEYS.has(key)) continue;
    // itens / itensIds and the derived caches are added by the branches below so
    // they reflect the recomputed values, not the (stale) form-state copy.
    if (key === 'itens' || key === 'itensIds') continue;
    if ((DERIVED_CACHES as readonly string[]).includes(key)) continue;
    if (key in docValues) patch[key] = docValues[key];
  }

  if (itemsDirty) {
    patch.itens = docValues.itens;
    patch.itensIds = docValues.itensIds;
  }
  if (devolucaoDirty) {
    patch.itensDevolvidos = docValues.itensDevolvidos;
  }
  if (totalsDirty) {
    for (const cache of DERIVED_CACHES) patch[cache] = docValues[cache];
  }

  return patch;
}

/** Thrown when a save's dirty patch is empty (nothing to persist). */
export class PedidoNothingChangedError extends Error {
  constructor() {
    super('Nenhuma alteração para salvar.');
    this.name = 'PedidoNothingChangedError';
  }
}

/**
 * Thrown when the pedido changed in Firestore since it was loaded — the
 * optimistic-concurrency guard (legacy `cadastroPedidoProvider.save`'s re-read).
 * Carries the current doc (null when the doc was deleted) so the UI can show the
 * conflict (F3 modal); the message is tailored to the deleted vs edited case.
 */
export class PedidoConflictError extends Error {
  constructor(readonly current: PedidoDocData) {
    super(
      current === null
        ? 'O pedido não existe mais — pode ter sido excluído. Recarregue a lista.'
        : 'O pedido foi alterado por outra pessoa. Recarregue antes de salvar.',
    );
    this.name = 'PedidoConflictError';
  }
}

/**
 * Doc metadata excluded from the concurrency snapshot: `ultimaModificacao` /
 * `timestamp` are stamps, not user data, so a difference in them alone is not a
 * meaningful conflict to warn about.
 */
const CONCURRENCY_IGNORE = new Set(['ultimaModificacao', 'timestamp']);

/**
 * Field keys whose value changed between the doc as loaded into the editor
 * (`baseline`) and the doc now in Firestore (`current`) — i.e. what someone (or
 * something) else changed since the editor opened. Structural + order-independent
 * (`valuesEqual`); metadata stamps are ignored.
 *
 * This is the heart of the guard: comparing a SNAPSHOT, not just
 * `ultimaModificacao`, is what lets it catch raw backend edits (a Firebase
 * console / script change that never stamps `ultimaModificacao`) — exactly the
 * case a timestamp-only check silently misses.
 */
export function remotelyChangedFields(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (CONCURRENCY_IGNORE.has(key)) continue;
    if (!valuesEqual(baseline[key], current[key])) changed.push(key);
  }
  return changed;
}

/**
 * Persist a pedido patch with a SNAPSHOT optimistic-concurrency guard. Inside a
 * transaction it re-reads the doc and aborts (`PedidoConflictError`) when any
 * field differs from `baseline` (the doc as it was loaded into the editor) —
 * porting the legacy `cadastroPedidoProvider.save` "if changed since load,
 * abort". Unlike a bare `ultimaModificacao` check, this catches backend edits
 * that never stamp the timestamp.
 *
 * There is no "force" escape hatch: F3's "salvar mesmo assim" overrides a
 * conflict by re-calling with `baseline` set to the version the user JUST
 * reviewed — so a *further* edit landing after the review is still caught instead
 * of clobbered blindly. Always stamps a fresh `ultimaModificacao` on the write
 * (after the no-op check, so an unchanged save still throws
 * `PedidoNothingChangedError`).
 */
export async function savePedido(
  port: PedidoDataPort,
  args: {
    pedidoId: string;
    patch: Record<string, unknown>;
    /** The pedido document as loaded into the editor — the concurrency baseline. */
    baseline: Record<string, unknown>;
  },
): Promise<void> {
  if (Object.keys(args.patch).length === 0) throw new PedidoNothingChangedError();

  await port.updatePedido(args.pedidoId, (current) => {
    if (current === null) throw new PedidoConflictError(null);
    if (remotelyChangedFields(args.baseline, current).length > 0) {
      throw new PedidoConflictError(current);
    }
    return { ...args.patch, ultimaModificacao: port.now() };
  });
}

// ---------------------------------------------------------------------------
// Estado history (legacy `HistoricoEstadosPedido` write on estado change)
// ---------------------------------------------------------------------------

const HISTORICO_ESTADO_PATH = (pedidoId: string, docId: string): string =>
  `pedidos/${pedidoId}/historicoEstadoPedido/${docId}`;

/**
 * Build one `historicoEstadoPedido` set-op recording a pedido's new `estado` and
 * who set it — mirror of the legacy `Pedido.save()` history write
 * (`models.dart:3838`). `data` is a µs-epoch stamp; `usuarioRef` is the
 * `documents/usuarios/<uid>` outer-ref string (null when unknown).
 */
export function buildEstadoHistoryOp(
  port: PedidoDataPort,
  pedidoId: string,
  estado: EstadoPedido,
  usuarioRef: string | null,
): PedidoWriteOp {
  return {
    type: 'set',
    path: HISTORICO_ESTADO_PATH(pedidoId, port.newId()),
    data: {
      estado,
      usuarioHistoricoEstadosPedidoOuterRef: usuarioRef,
      data: port.now(),
    },
  };
}

/**
 * Append a `historicoEstadoPedido` audit row for a manual estado change. The
 * editor calls this AFTER the pedido doc save committed the new `estado`, so the
 * history reflects what was persisted; a future MCP agent calls it the same way.
 */
export async function recordEstadoChange(
  port: PedidoDataPort,
  args: { pedidoId: string; estado: EstadoPedido; usuarioRef?: string | null },
): Promise<void> {
  await port.commit([
    buildEstadoHistoryOp(port, args.pedidoId, args.estado, args.usuarioRef ?? null),
  ]);
}

// ---------------------------------------------------------------------------
// Incidentes (pedidos/{id}/incidentes subcollection CRUD)
// ---------------------------------------------------------------------------

const INCIDENTE_PATH = (pedidoId: string, docId: string): string =>
  `pedidos/${pedidoId}/incidentes/${docId}`;

/**
 * Build a set-op for an incidente. Create (`incidenteId` null → mint an id +
 * stamp `timestamp`) or update (id given → preserve the caller-supplied
 * `timestamp`, which the editor spreads from the existing doc so `externalId` /
 * `resolucao` survive). Always stamps `ultimaModificacao`. The adapter's `set`
 * runs through the Zod converter (validates + fills defaults).
 */
export function buildIncidenteOp(
  port: PedidoDataPort,
  pedidoId: string,
  incidenteId: string | null,
  incidente: Record<string, unknown>,
): PedidoWriteOp {
  const id = incidenteId ?? port.newId();
  const data: Record<string, unknown> = { ...incidente, ultimaModificacao: port.now() };
  if (incidenteId === null) data.timestamp = port.now();
  return { type: 'set', path: INCIDENTE_PATH(pedidoId, id), data };
}

/** Create (no `incidenteId`) or update an incidente. */
export async function saveIncidente(
  port: PedidoDataPort,
  args: { pedidoId: string; incidenteId?: string | null; incidente: Record<string, unknown> },
): Promise<void> {
  await port.commit([
    buildIncidenteOp(port, args.pedidoId, args.incidenteId ?? null, args.incidente),
  ]);
}

/** Delete an incidente. */
export async function deleteIncidente(
  port: PedidoDataPort,
  args: { pedidoId: string; incidenteId: string },
): Promise<void> {
  await port.commit([{ type: 'delete', path: INCIDENTE_PATH(args.pedidoId, args.incidenteId) }]);
}

// ---------------------------------------------------------------------------
// Pagamentos (pedidos/{id}/pagamentos subcollection CRUD)
// ---------------------------------------------------------------------------

const PAGAMENTO_PATH = (pedidoId: string, docId: string): string =>
  `pedidos/${pedidoId}/pagamentos/${docId}`;

/**
 * Build a set-op for a pagamento. Create (`pagamentoId` null → mint an id +
 * stamp `dataCadastro`, the field the list sorts by) or update (id given →
 * preserve the caller-supplied `dataCadastro` + the passthrough `cartao` /
 * `cheque` / `metodoPagamentoOuterRef`, which the editor spreads from the
 * existing doc). Always stamps `ultimaModificacao`. The adapter's `set` runs
 * through the Zod converter (validates + fills defaults). No auto-`estado` side
 * effect (legacy `statusToEstadoPedido` stays a TODO).
 */
export function buildPagamentoOp(
  port: PedidoDataPort,
  pedidoId: string,
  pagamentoId: string | null,
  pagamento: Record<string, unknown>,
): PedidoWriteOp {
  const id = pagamentoId ?? port.newId();
  const data: Record<string, unknown> = { ...pagamento, ultimaModificacao: port.now() };
  if (pagamentoId === null) data.dataCadastro = port.now();
  return { type: 'set', path: PAGAMENTO_PATH(pedidoId, id), data };
}

/** Create (no `pagamentoId`) or update a pagamento. */
export async function savePagamento(
  port: PedidoDataPort,
  args: { pedidoId: string; pagamentoId?: string | null; pagamento: Record<string, unknown> },
): Promise<void> {
  await port.commit([
    buildPagamentoOp(port, args.pedidoId, args.pagamentoId ?? null, args.pagamento),
  ]);
}

/** Delete a pagamento. */
export async function deletePagamento(
  port: PedidoDataPort,
  args: { pedidoId: string; pagamentoId: string },
): Promise<void> {
  await port.commit([{ type: 'delete', path: PAGAMENTO_PATH(args.pedidoId, args.pagamentoId) }]);
}

// ---------------------------------------------------------------------------
// Auto-estado from pagamentos (legacy `cadastroPedidoProvider` transition)
// ---------------------------------------------------------------------------

/**
 * Estados the payment auto-transition is allowed to act ON. An ALLOW-list (not a
 * deny-list) so a newly-added `EstadoPedido` defaults to "not auto-driven": the
 * transition must never revert a terminal / post-cancel / refund / fulfilled
 * pedido just because its payments still sum to the total (e.g. a `cancelado`
 * order whose approved payment wasn't refunded, or a `finalizado` sale). Only the
 * open payment-pending states — plus `pago` itself, so a refund can downgrade it
 * — participate.
 */
const AUTO_ESTADO_SOURCES = new Set<EstadoPedido>([
  'iniciado',
  'carrinho',
  'escolhendoFormaDePagamento',
  'aguardandoConfirmacaoDePagamento',
  'pagamentoNaoRealizado',
  'emAnalise',
  'emProcessamento',
  'pago',
]);

/**
 * Pure rule: the pedido `estado` implied by how much has been paid, or `null`
 * when there is no transition (current estado already matches, the estado isn't
 * payment-driven, or the pedido has no total). Ports the legacy auto-transition
 * that ran after each pagamento change:
 *
 *  - **fully paid** (`valorPago ≥ total`, `total > 0`) → `pago` and authorize
 *    frete dispatch (`despachoAutorizado`);
 *  - **partially paid** (`0 < valorPago < total`) → `aguardandoConfirmacaoDePagamento`;
 *  - a **`pago`** pedido that drops below its total → downgraded back to
 *    `aguardandoConfirmacaoDePagamento`.
 *
 * Only the {@link AUTO_ESTADO_SOURCES} states are touched, so a cancelado /
 * finalizado / estornado* / fraude pedido is never reverted by a payment sum. A
 * zero-total pedido is left alone (nothing to settle). Inputs are expected
 * already 2-decimal-rounded (`derivePedidoTotals` / `sumPagamentosPagos`).
 */
export function nextPedidoEstado(
  estado: EstadoPedido,
  total: number,
  valorPago: number,
): { estado: EstadoPedido; autorizarDespacho: boolean } | null {
  if (!AUTO_ESTADO_SOURCES.has(estado)) return null;
  if (total <= 0) return null;
  const fullyPaid = valorPago >= total;
  if (fullyPaid) {
    return estado === 'pago' ? null : { estado: 'pago', autorizarDespacho: true };
  }
  if (valorPago > 0 && estado !== 'pago' && estado !== 'aguardandoConfirmacaoDePagamento') {
    return { estado: 'aguardandoConfirmacaoDePagamento', autorizarDespacho: false };
  }
  if (estado === 'pago') {
    // Was fully paid, no longer is → downgrade.
    return { estado: 'aguardandoConfirmacaoDePagamento', autorizarDespacho: false };
  }
  return null;
}

// The client-side reconcile that used to live here
// (`reconcilePedidoEstadoFromPagamentos`) was removed in favour of the
// server-owned `reconcilePedidoEstado` (`../admin/pedidoReconcile`), exposed as
// the `reconciliarPagamentoPedido` callable: the Firebase JS SDK cannot read a
// query inside `runTransaction` (only documents), so the client could never sum
// the pagamentos atomically with the pedido read and two concurrent reconciles
// could settle on a stale estado (#308). The Admin SDK can, so the reconcile
// moved server-side. `nextPedidoEstado` above stays — it is the pure rule the
// server path applies.
