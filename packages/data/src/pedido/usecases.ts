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
