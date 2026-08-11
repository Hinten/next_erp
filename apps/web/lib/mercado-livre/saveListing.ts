/**
 * Writing operator edits back to a `produtoMercadoLivre` link doc.
 *
 * The concurrency design is `listingPatch.ts`'s, made operational here:
 *
 *  - **tier 0** — only operator-owned keys ride, and a key whose value did not
 *    actually change is dropped, so the write surface is as small as the edit;
 *  - **tier 3** — the doc is re-read inside a transaction and compared against
 *    the snapshot the form was seeded from. An overlap raises
 *    {@link ListingConflictError} carrying the remote doc, so a human decides.
 *
 * Port-shaped for the same reason `savePedido` is: the whole decision tree runs
 * in a unit test with a fake, and the Firestore transaction lives in exactly one
 * place (`listingPort.ts`).
 */
import { valuesEqual } from '@delfrance/core/equality';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import {
  buildListingPatch,
  detectConflict,
  OPERATOR_OWNED_KEYS,
  type ListingPatch,
  type OperatorOwnedKey,
} from './listingPatch';

/** Thrown when the dirty patch carries nothing the stored doc does not already hold. */
export class ListingNothingChangedError extends Error {
  constructor() {
    super('Nenhuma alteração para salvar no anúncio.');
    this.name = 'ListingNothingChangedError';
  }
}

/**
 * Thrown when the link doc changed remotely on a key this save also writes.
 * Carries the remote doc so the UI can show the diff and offer an override that
 * re-baselines on the version the operator just read.
 */
export class ListingConflictError extends Error {
  constructor(
    readonly current: ProdutoMercadoLivreLink,
    readonly fields: OperatorOwnedKey[],
  ) {
    super('O anúncio foi alterado por outra pessoa desde que você o abriu.');
    this.name = 'ListingConflictError';
  }
}

/** Thrown when the link doc is gone — publish or Flutter deleted it mid-edit. */
export class ListingMissingError extends Error {
  constructor() {
    super('O anúncio não existe mais neste produto.');
    this.name = 'ListingMissingError';
  }
}

export interface ListingSavePort {
  /**
   * Re-read the link doc and apply `patchFor` to it atomically. `patchFor`
   * receives the CURRENT doc (null when absent) and returns the patch to write;
   * returning an empty patch writes nothing. Throwing aborts the transaction.
   */
  update(
    patchFor: (current: ProdutoMercadoLivreLink | null) => Record<string, unknown>,
  ): Promise<void>;
  /** Millisecond clock — `ultimaModificacao` on the ML links is ms, not µs. */
  now(): number;
}

export interface SaveListingArgs {
  /** Current form values, already normalized (empty strings turned into null). */
  values: Partial<Record<OperatorOwnedKey, unknown>>;
  /** react-hook-form's `dirtyFields`. */
  dirty: Record<string, unknown>;
  /** The link doc the form was seeded from — the concurrency baseline. */
  baseline: ProdutoMercadoLivreLink;
  /**
   * `baseline.ultimaModificacao`, passed separately so a force-save can
   * re-baseline on the remote doc the operator just reviewed.
   */
  baselineMs: number | null;
}

/**
 * Persist the operator's edits, or refuse and say why.
 *
 * Resolves with the patch that was written.
 */
export async function saveListing(
  port: ListingSavePort,
  args: SaveListingArgs,
): Promise<ListingPatch> {
  const built = buildListingPatch(args.values, args.dirty, port.now());
  // react-hook-form calls a field dirty as soon as it differs from the value it
  // was SEEDED with, which includes round trips that end where they started —
  // and a nullable input round-trips through '' on every clear. Writing those
  // keys would widen the write surface for no edit, and worse, would let a
  // no-op overwrite a value someone else legitimately changed.
  const patch: Record<string, unknown> = { ultimaModificacao: built.ultimaModificacao };
  const changed = OPERATOR_OWNED_KEYS.filter(
    (key) => key in built && !valuesEqual(built[key], args.baseline[key]),
  );
  for (const key of changed) patch[key] = built[key];
  if (changed.length === 0) throw new ListingNothingChangedError();

  await port.update((current) => {
    if (current === null) throw new ListingMissingError();
    const check = detectConflict(args.baseline, current, patch as ListingPatch, args.baselineMs);
    if (check.conflict) throw new ListingConflictError(current, check.fields);
    // Re-stamp at commit time rather than reusing the stamp taken before the
    // transaction: the retry loop can run this callback more than once.
    return { ...patch, ultimaModificacao: port.now() };
  });

  return patch as ListingPatch;
}
