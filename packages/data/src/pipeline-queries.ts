import type { Firestore } from 'firebase/firestore';
// Side-effect: registers db.pipeline() on the Firestore type via module
// augmentation (see node_modules/@firebase/firestore/pipelines/pipelines.d.ts).
// Has to come before any consumer of `db.pipeline` for TS to see the method.
import 'firebase/firestore/pipelines';
import {
  type BooleanExpression,
  type Pipeline,
  and,
  arrayContains,
  arrayContainsAny,
  ascending,
  descending,
  documentId,
  equal,
  field,
  greaterThan,
  greaterThanOrEqual,
  lessThan,
  lessThanOrEqual,
  or,
  regexContains,
  startsWith,
} from 'firebase/firestore/pipelines';

/**
 * Field alias under which `buildPipeline` projects the document id when a
 * `select` is requested. `.select()` makes the server return ad-hoc records
 * with no document key, so `PipelineResult.ref` is `undefined`. The id is
 * carried as a normal field via `documentId(field('__name__'))` — `__name__`
 * is the SDK's special-cased synthetic field for the document path.
 * `usePipelineSnapshot` reads this back and strips it from the row data.
 *
 * Plain alias (no leading/trailing `__`): `__`-pattern names are reserved
 * by Firestore and can't be used as projection output names.
 */
export const PIPELINE_ID_FIELD = 'rowId';

/**
 * Thrown when the installed firebase SDK does not expose the Pipelines API
 * (`db.pipeline()`). Callers can catch this and fall back to the classic
 * `query()`+`buildQuery()` pipeline used by the rest of the data layer.
 */
export class PipelineUnsupportedError extends Error {
  constructor() {
    super(
      'firebase/firestore does not expose pipeline() in this version. ' +
        'Fall back to buildQuery() until the SDK is upgraded.',
    );
    this.name = 'PipelineUnsupportedError';
  }
}

export interface PipelineSearchSpec {
  fields: string[];
  term: string;
}

export interface PipelineOrderSpec {
  field: string;
  direction?: 'asc' | 'desc';
}

export type PipelineFilterOp =
  | 'contains'
  | 'startsWith'
  | 'eq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'array-contains'
  | 'array-contains-any';

export interface PipelineFieldFilter {
  field: string;
  op: PipelineFilterOp;
  /**
   * The array form is ONLY for `array-contains-any` (membership against a
   * list of candidates) — `buildPipeline` throws if any other op receives an
   * array. `array-contains-any` with an EMPTY list also throws — an empty
   * candidate set means "no rows", and callers must short-circuit to an
   * empty result set instead of querying.
   */
  value: string | number | boolean | null | ReadonlyArray<string | number | boolean | null>;
}

/**
 * One `select` projection entry: a bare field path passed through as-is, or
 * `{ field, as }` to project `field` under an alias (Pipeline
 * `field(entry.field).as(entry.as)`). Aliasing lets a caller pull a single
 * nested value (e.g. `changes.precos`) out under a short, stable row key
 * instead of the caller having to know the source field's dotted path.
 */
export type PipelineSelectEntry = string | { field: string; as: string };

export interface PipelineSpec {
  collection: string;
  /**
   * Substring search across multiple fields, OR-combined. Each field is
   * matched with `regexContains` using a case-insensitive, accent-folded
   * pattern so "ana" matches "Aná" / "Aná" / "AnA" and "açaí" matches
   * "Acai". Empty / whitespace-only `term` skips the filter entirely so
   * callers can pass the user input as-is without branching.
   */
  search?: PipelineSearchSpec;
  /**
   * Per-field column filters, AND-combined and applied as a second `where`
   * stage after the global search (which is OR-combined). Use this for the
   * "filter icon" affordance in each TableView column header.
   */
  filters?: PipelineFieldFilter[];
  orderBy?: PipelineOrderSpec[];
  /**
   * Project only these fields (Pipeline `select` stage) to cut data
   * transfer. `.select()` strips `PipelineResult.ref`, so `buildPipeline`
   * automatically appends the document id as a field aliased to
   * `PIPELINE_ID_FIELD` — `usePipelineSnapshot` reads it back. Row identity
   * is preserved; callers just pass the fields they want. Entries may be a
   * bare field path or `{ field, as }` to project under an alias.
   */
  select?: PipelineSelectEntry[];
  /**
   * Restrict the source to a specific set of document ids (within
   * `collection`). When present and non-empty the pipeline sources from
   * `documents([...])` instead of the whole `collection(...)`, then applies the
   * same filters/sort/select/limit. Used by subcollection-lookup filters (e.g.
   * the pedido NF column) that resolve a sibling collection-group query to a
   * handful of parent ids. An empty array means "no rows" — callers must skip
   * building the pipeline entirely (`buildPipeline` THROWS on `[]`; falling
   * through to the collection source would silently full-scan it, the exact
   * Enterprise data-scanned billing trap, mirroring the `array-contains-any`
   * empty-list rule).
   */
  idIn?: string[];
  limit?: number;
}

export type { Pipeline };

/**
 * Quick predicate so callers (and TableView) can pick fallback paths without
 * hand-rolling try/catch around `buildPipeline`. Takes the Firestore instance
 * because `pipeline()` is an instance method registered via the side-effect
 * import above — not a module-level export.
 */
export function isPipelineSupported(db: Firestore): boolean {
  return typeof (db as Firestore & { pipeline?: unknown }).pipeline === 'function';
}

// Each ASCII letter expands to a character class covering its accented
// variants (and cedilla for c). The (?i) flag in the final pattern handles
// case. Letters not in this map are matched literally.
const ACCENT_GROUPS: Record<string, string> = {
  a: '[aàáâãäå]',
  e: '[eèéêë]',
  i: '[iìíîï]',
  o: '[oòóôõö]',
  u: '[uùúûü]',
  c: '[cç]',
  n: '[nñ]',
  y: '[yýÿ]',
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build a case- and accent-insensitive regex pattern for substring search.
 * Input is trimmed, NFD-stripped of diacritics, lowercased, regex-escaped,
 * then each ASCII letter is expanded to its accent class. Returns `''` for
 * empty / whitespace-only input so callers can skip the `where` entirely.
 *
 * Example: "Açaí" → "(?i)[aàáâãäå][cç][aàáâãäå][iìíîï]"
 */
export function buildSimilarityPattern(term: string): string {
  const trimmed = term.trim();
  if (!trimmed) return '';
  const ascii = trimmed.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const escaped = escapeRegex(ascii);
  const expanded = escaped.replace(/[aeiouncy]/g, (ch) => ACCENT_GROUPS[ch] ?? ch);
  return `(?i)${expanded}`;
}

/**
 * JS `RegExp` form of {@link buildSimilarityPattern} for client-side filtering
 * (the classic-query / queryOverride paths can't push a regex to the server).
 * Strips the server-only `(?i)` inline flag and applies the `i` flag instead.
 * Returns `null` for empty / whitespace-only input so callers can skip the
 * filter (matching the server-side "empty pattern → no filter" semantics).
 */
export function buildSimilarityRegExp(term: string): RegExp | null {
  const pattern = buildSimilarityPattern(term);
  if (!pattern) return null;
  return new RegExp(pattern.replace(/^\(\?i\)/, ''), 'i');
}

function filterExpr(f: PipelineFieldFilter): BooleanExpression {
  // Only `array-contains-any` takes a candidate LIST; every other op compares
  // against a single scalar. The type on `PipelineFieldFilter.value` admits
  // the array form for all ops, so guard at runtime — otherwise an array
  // would be passed silently into equal()/lessThan()/arrayContains()/… and
  // produce a nonsense server-side comparison instead of a clear failure.
  if (f.op !== 'array-contains-any' && Array.isArray(f.value)) {
    throw new Error(
      `buildPipeline: op "${f.op}" on "${f.field}" received an array value. ` +
        `Only "array-contains-any" accepts a list; pass a scalar instead.`,
    );
  }
  const fld = field(f.field);
  switch (f.op) {
    case 'contains': {
      // Default string-column filter: case- and accent-insensitive
      // substring match, same semantics as the (now removed) global
      // search. Empty pattern would match everything — guard with `(?i)`.
      const pattern = buildSimilarityPattern(String(f.value));
      return regexContains(f.field, pattern || '(?i)');
    }
    case 'startsWith':
      return startsWith(f.field, String(f.value));
    case 'eq':
      return equal(fld, f.value);
    case 'lt':
      return lessThan(fld, f.value);
    case 'lte':
      return lessThanOrEqual(fld, f.value);
    case 'gt':
      return greaterThan(fld, f.value);
    case 'gte':
      return greaterThanOrEqual(fld, f.value);
    case 'array-contains':
      return arrayContains(f.field, f.value);
    case 'array-contains-any': {
      const values = Array.isArray(f.value) ? f.value : [f.value];
      // Empty candidate list means "no rows" — callers must short-circuit to
      // an empty result set instead of querying (mirrors the `idIn: []` rule).
      if (values.length === 0) {
        throw new Error(
          `buildPipeline: array-contains-any on "${f.field}" received an empty ` +
            `value list. Skip the query and render an empty result set instead.`,
        );
      }
      return arrayContainsAny(f.field, [...values]);
    }
  }
}

/**
 * Build a Firestore Pipeline from a declarative spec. Throws
 * `PipelineUnsupportedError` when the installed SDK predates the Pipelines
 * API; callers should fall back to `buildQuery` in that case.
 *
 * The wrapper covers the subset TableView uses today: collection source,
 * multi-field prefix search (OR of `startsWith`), per-column filters
 * (AND-combined), sort, projection, limit.
 */
export function buildPipeline(db: Firestore, spec: PipelineSpec): Pipeline {
  if (!isPipelineSupported(db)) throw new PipelineUnsupportedError();

  // An empty id set means "no rows" — falling through to the collection
  // source would silently FULL-SCAN it (Enterprise bills data scanned), so
  // fail loudly instead, mirroring the `array-contains-any` empty-list rule.
  if (spec.idIn && spec.idIn.length === 0) {
    throw new Error(
      `buildPipeline: idIn on "${spec.collection}" received an empty id list. ` +
        `Skip the query and render an empty result set instead.`,
    );
  }

  // `idIn` sources from the specific parent documents a subcollection lookup
  // resolved to; otherwise scan the whole collection. `eqAny`/`in` over
  // `__name__` isn't in the Pipelines API of this SDK, so the
  // `documents([...])` source stage is how we constrain to an id set.
  let pipe: Pipeline = spec.idIn
    ? db.pipeline().documents(spec.idIn.map((id) => `${spec.collection}/${id}`))
    : db.pipeline().collection(spec.collection);

  if (spec.search && spec.search.fields.length > 0) {
    const pattern = buildSimilarityPattern(spec.search.term);
    if (pattern) {
      const perField = spec.search.fields.map((f) => regexContains(f, pattern));
      pipe =
        perField.length === 1
          ? pipe.where(perField[0]!)
          : pipe.where(or(perField[0]!, perField[1]!, ...perField.slice(2)));
    }
  }

  if (spec.filters?.length) {
    const exprs = spec.filters.map(filterExpr);
    pipe =
      exprs.length === 1
        ? pipe.where(exprs[0]!)
        : pipe.where(and(exprs[0]!, exprs[1]!, ...exprs.slice(2)));
  }

  if (spec.orderBy?.length) {
    const orderings = spec.orderBy.map((o) =>
      (o.direction ?? 'asc') === 'desc' ? descending(field(o.field)) : ascending(field(o.field)),
    );
    pipe = pipe.sort(orderings[0]!, ...orderings.slice(1));
  }

  if (spec.select?.length) {
    // Project the requested fields PLUS the document id. `.select()` drops
    // `PipelineResult.ref` (the server omits the document key for projected
    // results), so without this the row identity is lost. `field('__name__')`
    // is the SDK-special-cased reference to the document path; `documentId()`
    // extracts the short id from it. The alias is RESERVED: a caller selection
    // that would emit its own output field under the same name would collide
    // with the appended id projection and break row-id reading downstream.
    for (const entry of spec.select) {
      const outputName = typeof entry === 'string' ? entry : entry.as;
      if (outputName === PIPELINE_ID_FIELD) {
        throw new Error(
          `buildPipeline: select output "${PIPELINE_ID_FIELD}" is reserved for the ` +
            `document-id projection. Pick a different alias/field name.`,
        );
      }
    }
    const idSelection = documentId(field('__name__')).as(PIPELINE_ID_FIELD);
    // Bare-string entries pass through unchanged; `{ field, as }` entries
    // become `field(entry.field).as(entry.as)` so the caller can pull a
    // nested value out under a short, stable alias.
    const requested = spec.select.map((entry) =>
      typeof entry === 'string' ? entry : field(entry.field).as(entry.as),
    );
    const selections = [...requested, idSelection];
    pipe = pipe.select(selections[0]!, ...selections.slice(1));
  }

  if (typeof spec.limit === 'number') pipe = pipe.limit(spec.limit);

  return pipe;
}
