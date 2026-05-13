import * as firestoreSdk from 'firebase/firestore';
import type { Firestore } from 'firebase/firestore';

/**
 * Thrown when the installed firebase SDK does not expose the Pipelines API
 * (`pipeline()`). Callers can catch this and fall back to the classic
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

/**
 * Minimal type for the Pipeline object so call sites don't need to import
 * from a path the SDK may not export yet. Methods we touch are intentionally
 * narrow — extend as we adopt more pipeline features.
 */
export interface Pipeline {
  __pipeline: true;
}

interface PipelineCapableSdk {
  pipeline(db: Firestore): {
    collection(path: string): PipelineStage;
  };
  Field?: (name: string) => unknown;
}

interface PipelineStage {
  where(filter: unknown): PipelineStage;
  sort(...orderings: unknown[]): PipelineStage;
  limit(n: number): PipelineStage;
}

/**
 * Build a Firestore Pipeline from a declarative spec. Throws
 * `PipelineUnsupportedError` when the installed SDK predates the Pipelines
 * API; callers should fall back to `buildQuery` in that case.
 *
 * NOTE: the Pipelines API surface (`Field`, `or`, `lt`/`gte`, etc.) is
 * deliberately accessed through the raw SDK without TypeScript imports so
 * this wrapper compiles against older firebase versions. The runtime check
 * gates actual usage.
 */
export function buildPipeline(db: Firestore, spec: PipelineSpec): Pipeline {
  const sdk = firestoreSdk as unknown as PipelineCapableSdk;
  if (typeof sdk.pipeline !== 'function') throw new PipelineUnsupportedError();

  let stage = sdk.pipeline(db).collection(spec.collection);

  if (spec.search && spec.search.term && spec.search.fields.length > 0) {
    const term = spec.search.term;
    const upper = `${term}`;
    const sdkAny = sdk as unknown as Record<string, unknown>;
    const Field = sdk.Field;
    const and = sdkAny['and'] as (...args: unknown[]) => unknown;
    const or = sdkAny['or'] as (...args: unknown[]) => unknown;
    const gte = sdkAny['gte'] as (a: unknown, b: unknown) => unknown;
    const lte = sdkAny['lte'] as (a: unknown, b: unknown) => unknown;
    if (Field && and && or && gte && lte) {
      const perField = spec.search.fields.map((f) => {
        const field = Field(f);
        return and(gte(field, term), lte(field, upper));
      });
      stage = stage.where(perField.length === 1 ? perField[0] : or(...perField));
    }
    // If the helpers aren't available, skip the filter rather than throw — a
    // loud surface error during typeahead would be worse than no filter.
  }

  if (spec.orderBy?.length) {
    const sdkAny = sdk as unknown as Record<string, unknown>;
    const Field = sdk.Field;
    const ascending = sdkAny['ascending'] as (f: unknown) => unknown;
    const descending = sdkAny['descending'] as (f: unknown) => unknown;
    if (Field && ascending && descending) {
      stage = stage.sort(
        ...spec.orderBy.map((o) =>
          (o.direction ?? 'asc') === 'desc' ? descending(Field(o.field)) : ascending(Field(o.field)),
        ),
      );
    }
  }

  if (typeof spec.limit === 'number') stage = stage.limit(spec.limit);

  return stage as unknown as Pipeline;
}

/**
 * Quick predicate so callers (and the TableView) can pick fallback paths
 * without hand-rolling try/catch around `buildPipeline`.
 */
export function isPipelineSupported(): boolean {
  return typeof (firestoreSdk as unknown as { pipeline?: unknown }).pipeline === 'function';
}
