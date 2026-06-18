import type { Pedido } from '@delfrance/schemas';
import type { PedidoDataPort, PedidoDocData } from './port';

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
 * Persist a pedido patch with an optimistic-concurrency guard. Inside a
 * transaction it re-reads the doc and aborts (`PedidoConflictError`) when its
 * `ultimaModificacao` no longer matches `baseUltimaModificacao` (the value
 * loaded into the form). `baseUltimaModificacao` is a real baseline, not a
 * sentinel: `null` means "the doc had no `ultimaModificacao` when loaded", and a
 * concurrent write that stamps one (null → number) is correctly flagged as a
 * conflict. To deliberately bypass the guard — F3's "salvar mesmo assim" after
 * the user reviewed the conflicting changes — pass `force: true`. Always stamps a
 * fresh `ultimaModificacao` on the write (after the no-op check, so an unchanged
 * save still throws `PedidoNothingChangedError`).
 */
export async function savePedido(
  port: PedidoDataPort,
  args: {
    pedidoId: string;
    patch: Record<string, unknown>;
    /** The pedido's `ultimaModificacao` as loaded (µs epoch, or null if absent). */
    baseUltimaModificacao: number | null;
    /** Bypass the concurrency guard (F3 override). Default false. */
    force?: boolean;
  },
): Promise<void> {
  if (Object.keys(args.patch).length === 0) throw new PedidoNothingChangedError();

  await port.updatePedido(args.pedidoId, (current) => {
    if (current === null) throw new PedidoConflictError(null);
    if (!args.force) {
      const currentUM =
        typeof current.ultimaModificacao === 'number' ? current.ultimaModificacao : null;
      if (currentUM !== args.baseUltimaModificacao) throw new PedidoConflictError(current);
    }
    return { ...args.patch, ultimaModificacao: port.now() };
  });
}
