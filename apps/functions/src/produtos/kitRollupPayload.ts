/**
 * The `recalcularDimensoesKit` task payload and the pure helpers both the
 * trigger and the worker need (#1152).
 *
 * Kept apart from `kitRollup.ts` so `onProdutoChanged` can build a payload
 * without importing the `onTaskDispatched` declaration — and so the gate, the
 * supersede comparison and the paging arithmetic stay unit-testable with no
 * Firestore and no firebase-functions runtime in the way.
 */
import { z } from 'zod';
import { CAMPOS_DIMENSOES_KIT, type CampoDimensoesKit } from '@delfrance/schemas';

/**
 * The produto fields the rollup DERIVES, and therefore also the exact fields
 * whose change must trigger it. Reusing the schemas constant is deliberate: a
 * sixth derived field added to `DimensoesKit` becomes a gate field here for
 * free, instead of being written by the rollup but never triggering it.
 */
export const CAMPOS_ROLLUP_KIT = CAMPOS_DIMENSOES_KIT;

/** A produto's five rollup-relevant values, as read off a raw Firestore doc. */
export type ValoresRollup = Record<CampoDimensoesKit, number | null>;

const numeroOuNulo = z.number().nullable().catch(null);

export const valoresRollupSchema = z.object({
  pesoBrutoKg: numeroOuNulo,
  pesoLiquidoKg: numeroOuNulo,
  alturaCm: numeroOuNulo,
  larguraCm: numeroOuNulo,
  profundidadeCm: numeroOuNulo,
});

/**
 * How many produto ids one `array-contains-any` disjunction may carry. Firestore
 * caps it at 30; the worker walks `seedIds` in chunks of this size, one chunk at
 * a time, so the cursor stays meaningful.
 */
export const SEEDS_POR_CONSULTA = 30;

/** How many kits one dispatch processes before re-enqueuing itself. */
export const KITS_POR_PAGINA = 300;

/**
 * Cascade bound for the kit-of-kit case. #239 forbids a kit from being a
 * component and the human UI enforces it, so in a healthy catalogue the probe
 * that would grow `depth` finds nothing and this is never reached. It exists for
 * the migrated corpus and the picker-less agent/MCP save path (#347), where a
 * nested kit — or an outright cycle — can still exist.
 */
export const PROFUNDIDADE_MAX_KIT = 3;

/**
 * Payload size guard. Cloud Tasks caps a task body at 100KB; ~500 ids is a few
 * KB and far more seeds than any real produto has. Truncation is logged, never
 * silent — a silent cap reads as "covered everything".
 */
export const MAX_SEED_IDS = 500;

export const kitRollupPayloadSchema = z.object({
  /**
   * The produto whose weight/box changed. It stays FIXED through continuation
   * pages and through the nested cascade, because it is what the supersede
   * guard compares against: if the edit that started all this has been
   * superseded, the whole chain must stop, not just its first page.
   */
  rootId: z.string().min(1),
  /** The five values `rootId` carried at enqueue time — the supersede clock. */
  rootValores: valoresRollupSchema,
  /**
   * Produtos to look up in `componentesKitKeys`. `null` on the first dispatch,
   * where the worker derives them (the root plus the variation children that
   * INHERIT what changed).
   */
  seedIds: z.array(z.string()).nullable().default(null),
  /** Which `SEEDS_POR_CONSULTA`-sized chunk of `seedIds` this dispatch is on. */
  seedOffset: z.number().int().min(0).default(0),
  /** Last produto id of the previous page within the current chunk. */
  cursor: z.string().nullable().default(null),
  /** Nested-kit cascade depth; `0` for a task the trigger enqueued. */
  depth: z.number().int().min(0).default(0),
  /** Seeds already fanned out from — the cycle break for a corrupt nested kit. */
  visitados: z.array(z.string()).default([]),
});

export type KitRollupPayload = z.infer<typeof kitRollupPayloadSchema>;

/** Read the five rollup values off a raw produto document. */
export function lerValoresRollup(data: Record<string, unknown> | undefined): ValoresRollup {
  const out = {} as ValoresRollup;
  for (const campo of CAMPOS_ROLLUP_KIT) {
    const raw = data?.[campo];
    out[campo] = typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
  }
  return out;
}

/** Whether any of the five rollup fields differs between two produto states. */
export function valoresRollupDiferem(
  a: ValoresRollup | null | undefined,
  b: ValoresRollup | null | undefined,
): boolean {
  if (!a || !b) return a !== b;
  return CAMPOS_ROLLUP_KIT.some((campo) => a[campo] !== b[campo]);
}

/** `seedIds` trimmed to what a task body can carry, plus what was dropped. */
export function limitarSeeds(ids: readonly string[]): {
  seeds: string[];
  descartados: string[];
} {
  const unicos = [...new Set(ids)];
  return {
    seeds: unicos.slice(0, MAX_SEED_IDS),
    descartados: unicos.slice(MAX_SEED_IDS),
  };
}

/**
 * Decide whether a produto write must fan out to the kits containing it, and
 * build the task payload if so. Pure — no Firestore, no firebase-functions — so
 * the gate that keeps a normal produto write at ZERO extra reads is unit-tested
 * rather than inferred.
 *
 * ⚠️ It compares the RAW before/after, deliberately not the modification-history
 * diff's `campos`. The two must stay decoupled: adding a field to the history
 * ignore list is a presentation decision and must never be able to silently
 * switch the rollup off.
 *
 * Four reasons to do nothing, in order:
 *
 *  1. **A delete.** The kits that listed it are rewritten by
 *     `onProdutoDeleted`'s `cleanupInboundKitReferences`, and that write
 *     re-enters this trigger as a `componentesKit` change on each kit.
 *  2. **A create.** A produto that did not exist a moment ago is in no kit's
 *     `componentesKitKeys`, so the fan-out could only ever match nothing.
 *  3. **The produto is itself a kit.** Those five fields are this rollup's
 *     OUTPUT (the form locks them), so re-entry after our own write must not
 *     fan out again. A kit that is itself a component — which #239 forbids and
 *     the UI enforces — is reached by the worker's nested probe instead, which
 *     is a strict superset and costs one keys-only query per 30 changed kits.
 *  4. **No rollup field actually moved.** This is what makes an ordinary produto
 *     save (nome, preço, foto, stock) cost nothing at all.
 */
export function planejarRollupKit(
  produtoId: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): KitRollupPayload | null {
  if (after === undefined) return null;
  if (before === undefined) return null;
  if (after.ehKit === true) return null;

  const rootValores = lerValoresRollup(after);
  if (!valoresRollupDiferem(lerValoresRollup(before), rootValores)) return null;

  return {
    rootId: produtoId,
    rootValores,
    seedIds: null,
    seedOffset: 0,
    cursor: null,
    depth: 0,
    visitados: [],
  };
}
