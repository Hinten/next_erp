/**
 * What the listing editor is allowed to write to a `produtoMercadoLivre` link
 * doc, and how it detects that someone else got there first.
 *
 * Five writers touch these documents: this editor, `publishProduto`, the
 * `items` status webhook, the price sync, and the stock sender. The browser SDK
 * has no `lastUpdateTime` precondition, so tier 1 is unreachable here
 * (`apps/web/CLAUDE.md` rule 3) and the design is:
 *
 *  - **tier 0 by field disjointness** — patch only operator-owned keys, so a
 *    webhook advancing `estado` can never collide with a `descricao` edit;
 *  - **tier 3 for the residual overlap** — two operators editing the same
 *    listing raise a conflict for a human instead of silently overwriting.
 */
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';
import { valuesEqual } from '@delfrance/core/equality';

/**
 * Keys the OPERATOR owns. Everything else on the link doc is server-written and
 * a UI patch would clobber live truth:
 *
 *  - `id` / `estado` / `status` / `sub_status` / `errors` / `precoPublicado` /
 *    `freteGratis` / `comissao` / `sku` — publish and the webhooks own these;
 *  - `contaOuterRef` / `dataCadastro` — set once, at creation;
 *  - **`isUserProductModel`** — the stock sweep branches on it and it only ever
 *    flips via the server's UPtin migration. An editable toggle here would
 *    silently re-route publishing.
 *
 * ⚠️ `channels`, `crossdocking`, `tarifaFrete`, `video_id` and `condition` were
 * here and are not any more. The first three never reach the ML payload at all
 * (`buildItemPayload` does not read them), and `crossdocking`/`video_id`/
 * `condition` duplicate produto fields — a second editable copy could only
 * diverge from the produto that publish actually reads.
 *
 * ⚠️ `condition` is the one worth spelling out: it is **create-only** at ML
 * (`buildItemPayload`, inside `if (!input.isUpdate)`), so writing it from here
 * never reached an existing listing — it only looked like it did. It now derives
 * from `produto.ehUsado` at publish time (`resolveCondition`).
 *
 * Their stored values are left untouched; they are simply no longer written from
 * this screen.
 */
export const OPERATOR_OWNED_KEYS = [
  'title',
  'descricao',
  'category_id',
  'listing_type_id',
  'attributes',
] as const;

export type OperatorOwnedKey = (typeof OPERATOR_OWNED_KEYS)[number];

export type ListingPatch = Partial<Pick<ProdutoMercadoLivreLink, OperatorOwnedKey>> & {
  ultimaModificacao: number;
};

type LinkLike = Partial<Record<OperatorOwnedKey, unknown>> & {
  ultimaModificacao?: number | null;
};

/**
 * Build the patch from the form values and react-hook-form's `dirtyFields`.
 *
 * Only dirty AND operator-owned keys ride, which is what makes the disjointness
 * argument hold: an untouched field is not written at all, so it cannot lose a
 * race it never entered.
 *
 * ⚠️ `ultimaModificacao` on the ML link docs is **milliseconds**, unlike the
 * microsecond stamps on pedido/pagamento/produto. Mixing the units gives a
 * comparison that never fires (root `CLAUDE.md` rule 7).
 */
export function buildListingPatch(
  values: Partial<Record<OperatorOwnedKey, unknown>>,
  dirty: Partial<Record<string, unknown>>,
  nowMs: number,
): ListingPatch {
  const patch: Record<string, unknown> = {};
  for (const key of OPERATOR_OWNED_KEYS) {
    if (!isDirty(dirty[key])) continue;
    // A dirty key with no value is a form bug, not an instruction. The Firebase
    // SDK REJECTS `undefined` outright (the repo's `.nullable().default(null)`
    // rule exists for this), and letting it through would also make
    // `detectConflict` treat the key as written when it carries nothing.
    // Clearing a field is `null`, which passes.
    if (values[key] === undefined) continue;
    patch[key] = values[key];
  }
  patch.ultimaModificacao = nowMs;
  return patch as ListingPatch;
}

/**
 * `dirtyFields` is a boolean for a scalar but a nested object or array of
 * objects for a composite field (`attributes`), so a plain truthiness test
 * would miss an edited array whose entry flags are the only `true`s.
 */
function isDirty(flag: unknown): boolean {
  if (flag === true) return true;
  if (Array.isArray(flag)) return flag.some(isDirty);
  if (flag && typeof flag === 'object') return Object.values(flag).some(isDirty);
  return false;
}

export interface ConflictCheck {
  /** True ⇒ show the operator the diff before writing. */
  conflict: boolean;
  /** Operator-owned keys that changed remotely AND are being written here. */
  fields: OperatorOwnedKey[];
  /** The stamp to re-baseline on — set even when there is no conflict. */
  nextBaselineMs: number | null;
}

/**
 * Compare the live doc against the baseline captured when the form was seeded.
 *
 * A remote write is only a CONFLICT when it touched a key this save also
 * writes. If `ultimaModificacao` merely advanced — the publish flow stamping
 * `estado`, the price sync refreshing `precoPublicado` — the baseline is
 * refreshed silently and the save proceeds, because blocking there would make
 * the editor unusable on any actively-syncing listing.
 */
export function detectConflict(
  baseline: LinkLike | null,
  live: LinkLike | null,
  patch: ListingPatch,
  baselineMs: number | null,
): ConflictCheck {
  const liveMs = live?.ultimaModificacao ?? null;
  if (!live || !baseline || liveMs == null || baselineMs == null || liveMs <= baselineMs) {
    return { conflict: false, fields: [], nextBaselineMs: liveMs };
  }
  // `valuesEqual` is the repo's canonical non-serializing deep compare
  // (`@delfrance/core/equality`), already used by the pedido concurrency guard
  // and the ObjectView dirty check. A `JSON.stringify` comparison would be
  // key-ORDER dependent — two Firestore reads of the same `attributes` array
  // can differ only in key order and would raise a phantom conflict modal —
  // and it throws outright on a BigInt.
  const fields = OPERATOR_OWNED_KEYS.filter(
    (key) => key in patch && !valuesEqual(baseline[key], live[key]),
  );
  return { conflict: fields.length > 0, fields, nextBaselineMs: liveMs };
}
