import type { Firestore } from 'firebase/firestore';
// Side-effect: registers db.pipeline() on the Firestore type via module
// augmentation (see node_modules/@firebase/firestore/pipelines/pipelines.d.ts).
// Has to come before any consumer of `db.pipeline` for TS to see the method.
import 'firebase/firestore/pipelines';
import {
  type BooleanExpression,
  type Pipeline,
  and,
  ascending,
  descending,
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

export type PipelineFilterOp = 'startsWith' | 'eq' | 'lt' | 'lte' | 'gt' | 'gte';

export interface PipelineFieldFilter {
  field: string;
  op: PipelineFilterOp;
  value: string | number | boolean | null;
}

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
   * Project only these fields (Pipeline `select` stage). WARNING: the
   * `.select()` stage produces ad-hoc records — `PipelineResult.ref` and
   * `.id` come back `undefined`, so callers that need the document id
   * (e.g. row-click navigation) MUST omit this. Use it only for read-only
   * aggregations / exports where the row identity doesn't matter.
   */
  select?: string[];
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
  const ascii = trimmed
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  const escaped = escapeRegex(ascii);
  const expanded = escaped.replace(/[aeiouncy]/g, (ch) => ACCENT_GROUPS[ch] ?? ch);
  return `(?i)${expanded}`;
}

function filterExpr(f: PipelineFieldFilter): BooleanExpression {
  const fld = field(f.field);
  switch (f.op) {
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

  let pipe: Pipeline = db.pipeline().collection(spec.collection);

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
      (o.direction ?? 'asc') === 'desc'
        ? descending(field(o.field))
        : ascending(field(o.field)),
    );
    pipe = pipe.sort(orderings[0]!, ...orderings.slice(1));
  }

  if (spec.select?.length) {
    pipe = pipe.select(spec.select[0]!, ...spec.select.slice(1));
  }

  if (typeof spec.limit === 'number') pipe = pipe.limit(spec.limit);

  return pipe;
}
