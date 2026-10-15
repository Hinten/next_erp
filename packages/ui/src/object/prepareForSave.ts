import type { FieldConfig } from '../schema/types';

/**
 * Flattening and application of the `prepareForSave` transforms declared across
 * a `Record<string, FieldConfig>` tree — the top-level entries AND the
 * sub-field overrides nested under `FieldConfig.fields`.
 *
 * `renderInput` has always recursed into `fields` (`FieldRenderer` is a
 * recursive component binding leaves to the dotted RHF path), but both of
 * `ObjectView`'s `prepareForSave` application points iterated only top-level
 * entries — so a nested transform typechecked and silently did nothing (#870).
 *
 * The work is split in two on purpose. `collectPrepareForSave` walks the config
 * tree ONCE per `fieldOverrides` identity (ObjectView memoizes it) and yields a
 * flat path list; `applyPrepareForSave` then runs on every validation and every
 * save as a plain loop with no tree walk at all.
 *
 * Rules this module fixes, and which the tests pin:
 *
 *  - **Order is pre-order**: a parent's transform runs before any of its own
 *    descendants', so the more specific config wins for its own key — the same
 *    precedence `renderInput` already has.
 *  - **A null or absent parent is skipped, never materialized.** A nullable
 *    `kind: 'object'` field whose Switch is off is literally `null`, and it
 *    must stay `null`.
 *  - **Copy-on-write, never mutation.** Only the objects along a path that is
 *    actually written get cloned; everything else stays reference-shared. The
 *    resolver receives react-hook-form's live values object and `doSave` feeds
 *    its result back through `form.reset`, so mutating an input here would
 *    corrupt form state.
 */

/** One flattened transform: the path to the value, and the function to apply. */
export interface PreparedTransform {
  /** Path segments from the record root, e.g. `['enderecoDeOrigem', 'telefone']`. */
  readonly path: readonly string[];
  readonly fn: (value: unknown) => unknown;
}

/**
 * Hard cap on how deep `FieldConfig.fields` nesting is followed. The deepest
 * config in the repo today is ONE level (`intFreteFields.enderecoDeOrigem`,
 * `filialFields.sede`), so this is pure backstop: a belt-and-braces bound that
 * holds even if the cycle guard below were ever wrong.
 */
export const MAX_NESTING_DEPTH = 8;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten every `prepareForSave` in the tree into an ordered path list.
 *
 * Termination is structural, and both guards matter:
 *
 *  - `ancestors` holds the configs on the CURRENT PATH — added before
 *    descending, removed on the way back up — so a config reachable from itself
 *    is not descended into twice. ⚠️ It must stay path-scoped: a global visited
 *    set would be wrong here, because the repo shares leaf configs by identity
 *    across branches (`intFreteFields.tsx` spreads `enderecoNestedFields`, so
 *    the same `cep` object hangs under two different parents). Skipping the
 *    second occurrence would reintroduce exactly the silent no-op this module
 *    exists to remove.
 *  - `depth` caps the walk regardless.
 */
export function collectPrepareForSave(
  overrides: Record<string, FieldConfig>,
): readonly PreparedTransform[] {
  const out: PreparedTransform[] = [];
  const ancestors = new Set<FieldConfig>();

  function walk(level: Record<string, FieldConfig>, prefix: readonly string[], depth: number) {
    if (depth > MAX_NESTING_DEPTH) return;
    for (const [key, cfg] of Object.entries(level)) {
      if (!cfg) continue;
      const path = [...prefix, key];
      if (cfg.prepareForSave) {
        out.push({ path, fn: cfg.prepareForSave as (value: unknown) => unknown });
      }
      if (!cfg.fields || ancestors.has(cfg)) continue;
      ancestors.add(cfg);
      walk(cfg.fields, path, depth + 1);
      ancestors.delete(cfg);
    }
  }

  walk(overrides, [], 0);
  return out;
}

/**
 * Rebuild `root` with `fn` applied at `path`. Iterative — the descent is
 * bounded by `path.length` — and copy-on-write: the objects along the path are
 * cloned, every sibling subtree keeps its original reference. Returns `root`
 * untouched when an intermediate value is null/absent or not a plain object.
 */
function withTransformAt(
  root: Record<string, unknown>,
  path: readonly string[],
  fn: (value: unknown) => unknown,
): Record<string, unknown> {
  const chain: Record<string, unknown>[] = [root];
  for (let i = 0; i < path.length - 1; i++) {
    const child = chain[i]![path[i]!];
    // A switched-off nullable object is `null`: skip it rather than
    // materializing a parent the operator deliberately cleared.
    if (!isRecord(child)) return root;
    chain.push(child);
  }
  const leafKey = path[path.length - 1]!;
  const leafParent = chain[chain.length - 1]!;
  let next: Record<string, unknown> = { ...leafParent, [leafKey]: fn(leafParent[leafKey]) };
  for (let i = chain.length - 2; i >= 0; i--) {
    next = { ...chain[i]!, [path[i]!]: next };
  }
  return next;
}

/**
 * Apply a collected list to a values object, in order. Pure: `values` is never
 * mutated, and the returned root is always a fresh object.
 */
export function applyPrepareForSave(
  values: Record<string, unknown>,
  transforms: readonly PreparedTransform[],
): Record<string, unknown> {
  let out: Record<string, unknown> = { ...values };
  for (const { path, fn } of transforms) {
    if (path.length === 0) continue;
    out = withTransformAt(out, path, fn);
  }
  return out;
}
