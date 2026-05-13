import type { Firestore } from 'firebase/firestore';
// Side-effect: registers db.pipeline() on the Firestore type via module
// augmentation (see node_modules/@firebase/firestore/pipelines/pipelines.d.ts).
// Has to come before any consumer of `db.pipeline` for TS to see the method.
import 'firebase/firestore/pipelines';
import {
  type Pipeline,
  ascending,
  descending,
  field,
  or,
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

export interface PipelineSpec {
  collection: string;
  /**
   * Prefix-search across multiple fields, OR-combined. Empty `term` skips
   * the filter entirely so callers can pass `{ term: search.trim() }` and
   * not branch on empties.
   */
  search?: PipelineSearchSpec;
  orderBy?: PipelineOrderSpec[];
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

/**
 * Build a Firestore Pipeline from a declarative spec. Throws
 * `PipelineUnsupportedError` when the installed SDK predates the Pipelines
 * API; callers should fall back to `buildQuery` in that case.
 *
 * The wrapper covers the subset TableView uses today: collection source,
 * multi-field prefix search (OR of `startsWith`), sort, limit. Extend as
 * we adopt more pipeline features.
 */
export function buildPipeline(db: Firestore, spec: PipelineSpec): Pipeline {
  if (!isPipelineSupported(db)) throw new PipelineUnsupportedError();

  let pipe: Pipeline = db.pipeline().collection(spec.collection);

  if (spec.search && spec.search.term && spec.search.fields.length > 0) {
    const term = spec.search.term;
    const perField = spec.search.fields.map((f) => startsWith(f, term));
    pipe =
      perField.length === 1
        ? pipe.where(perField[0]!)
        : pipe.where(or(perField[0]!, perField[1]!, ...perField.slice(2)));
  }

  if (spec.orderBy?.length) {
    const orderings = spec.orderBy.map((o) =>
      (o.direction ?? 'asc') === 'desc'
        ? descending(field(o.field))
        : ascending(field(o.field)),
    );
    pipe = pipe.sort(orderings[0]!, ...orderings.slice(1));
  }

  if (typeof spec.limit === 'number') pipe = pipe.limit(spec.limit);

  return pipe;
}
