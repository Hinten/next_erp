import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionMetadata } from '@delfrance/schemas';

const h = vi.hoisted(() => ({ deleteDocumentSubtree: vi.fn() }));

vi.mock('@delfrance/data/admin', () => ({
  deleteDocumentSubtree: h.deleteDocumentSubtree,
}));

import {
  BUDGET_MS_PADRAO,
  TIMEOUT_SECONDS_PADRAO,
  assertBudgetFitsTimeout,
  CascadeTruncatedError,
  cascadeCaroGenerico,
  defineCascadeCaroGenerico,
} from './cascadeCaroGenerico';

const META: CollectionMetadata = {
  collectionPath: 'integracao',
  permissions: { read: 1n, write: 2n, delete: 4n },
};

/** The slice of a v2 trigger's `__endpoint` these tests read. */
interface Endpoint {
  eventTrigger: {
    retry: boolean;
    eventFilters: Record<string, string>;
    eventFilterPathPatterns: Record<string, string>;
  };
  timeoutSeconds?: unknown;
}

/**
 * The two fields firebase-tools reads off a v2 trigger to wire Eventarc. They
 * live in different maps: `document` is a path PATTERN (it carries `{docId}`),
 * `database` is an exact-match filter.
 */
function endpointOf(fn: unknown) {
  const { eventTrigger } = (fn as { __endpoint: Endpoint }).__endpoint;
  return { ...eventTrigger.eventFilters, ...eventTrigger.eventFilterPathPatterns };
}

/** The runtime half of the endpoint — what `retry`/`timeoutSeconds` land in. */
function runtimeOf(fn: unknown) {
  const endpoint = (fn as { __endpoint: Endpoint }).__endpoint;
  return { retry: endpoint.eventTrigger.retry, timeoutSeconds: endpoint.timeoutSeconds };
}

afterEach(() => {
  vi.unstubAllEnvs();
  h.deleteDocumentSubtree.mockReset();
});

describe('defineCascadeCaroGenerico', () => {
  it('derives the document pattern from the meta collectionPath', () => {
    expect(endpointOf(defineCascadeCaroGenerico(META)).document).toBe('integracao/{docId}');
    expect(
      endpointOf(defineCascadeCaroGenerico({ ...META, collectionPath: 'int_frete' })).document,
    ).toBe('int_frete/{docId}');
  });

  it('binds the NAMED `default` database, not `(default)`', () => {
    // Gotcha #8. A trigger that binds `(default)` never fires, and it fails
    // silently — no error, no invocation, orphans forever.
    expect(endpointOf(defineCascadeCaroGenerico(META)).database).toBe('default');
  });

  it('honours FIREBASE_DATABASE_ID when set', () => {
    vi.stubEnv('FIREBASE_DATABASE_ID', 'staging-db');
    expect(endpointOf(defineCascadeCaroGenerico(META)).database).toBe('staging-db');
  });

  it('leaves an unbudgeted cascade at retry: false with no timeout override', () => {
    // The three credential cascades. Their subtrees are two documents, so they
    // cannot truncate; `retry: true` there would only redeliver a permanent
    // failure the writer already exhausted.
    const runtime = runtimeOf(defineCascadeCaroGenerico(META));
    expect(runtime.retry).toBe(false);
    // Not asserted as `undefined`: firebase-functions normalizes an omitted
    // runtime option to its `ResetValue` sentinel — "leave the platform
    // default" — so the assertion is that no number was pinned here.
    expect(typeof runtime.timeoutSeconds).not.toBe('number');
  });

  it('turns retry ON exactly when a budget is given', () => {
    // Not a separate knob on purpose: redelivery is the only reason a budget is
    // worth having, so a budgeted trigger that did not retry would stop the walk
    // cleanly and then drop the remainder deliberately.
    expect(
      runtimeOf(defineCascadeCaroGenerico(META, { budgetMs: 400_000, timeoutSeconds: 540 })),
    ).toEqual({ retry: true, timeoutSeconds: 540 });
  });

  it('sizes the default budget to leave room inside the default timeout', () => {
    // The BulkWriter flush happens after the deadline stops the walk; a budget
    // that filled the timeout would throw away the progress it just made.
    expect(BUDGET_MS_PADRAO).toBeLessThan(TIMEOUT_SECONDS_PADRAO * 1000);
  });

  it('rejects a caller whose own budget/timeout pair does not fit', () => {
    // The constants above are only the DEFAULT pair; the guard is what covers a
    // future call site that passes its own. Equal is a failure too — the budget
    // has to leave room for the flush, not merely match the timeout.
    expect(() => assertBudgetFitsTimeout('chat', 540_000, 540)).toThrow(/must be\s+less than/);
    expect(() => assertBudgetFitsTimeout('chat', 600_000, 540)).toThrow(/budgetMs/);
    expect(() => assertBudgetFitsTimeout('chat', 400_000, 540)).not.toThrow();
  });

  it('runs the guard when a cascade is defined with both knobs', () => {
    // Reaches the guard through the real entry point, so the wiring is covered
    // and not just the helper: Firebase evaluates this at codebase analysis, so
    // a bad pair must break the deploy rather than ship.
    expect(() =>
      defineCascadeCaroGenerico(META, { budgetMs: 600_000, timeoutSeconds: 540 }),
    ).toThrow(/must be\s+less than/);
  });
});

describe('cascadeCaroGenerico', () => {
  function fakeDb(seen: string[]) {
    return {
      collection: (path: string) => ({
        doc: (id: string) => {
          seen.push(`${path}/${id}`);
          return { path: `${path}/${id}` };
        },
      }),
    };
  }

  it('walks the subtree of the deleted document', async () => {
    const seen: string[] = [];
    h.deleteDocumentSubtree.mockResolvedValue({
      documentsDeleted: 3,
      collectionsVisited: 3,
      queriesIssued: 2,
      truncated: false,
      failedDeletes: 0,
    });

    await cascadeCaroGenerico(fakeDb(seen) as never, 'integracao', 'abc');

    expect(seen).toEqual(['integracao/abc']);
    expect(h.deleteDocumentSubtree).toHaveBeenCalledWith(
      expect.anything(),
      { path: 'integracao/abc' },
      // No budget → no deadline, so the walk can never report `truncated` and
      // the redelivery contract below stays switched off.
      { deadline: Number.POSITIVE_INFINITY },
    );
  });

  it('does not throw when the walk reports failed deletes', async () => {
    // A permanent per-document failure must still resolve: the BulkWriter
    // already retried it, so a redelivery reproduces it rather than reclaiming
    // anything. The report is logged instead.
    h.deleteDocumentSubtree.mockResolvedValue({
      documentsDeleted: 2,
      collectionsVisited: 2,
      queriesIssued: 1,
      truncated: false,
      failedDeletes: 1,
      firstError: new Error('permission denied'),
    });

    await expect(
      cascadeCaroGenerico(fakeDb([]) as never, 'metodo_pgto', 'xyz'),
    ).resolves.toBeUndefined();
  });

  it('turns budgetMs into an absolute deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-20T00:00:00Z'));
    h.deleteDocumentSubtree.mockResolvedValue({
      documentsDeleted: 1,
      collectionsVisited: 1,
      queriesIssued: 0,
      truncated: false,
      failedDeletes: 0,
    });

    await cascadeCaroGenerico(fakeDb([]) as never, 'chat', 'c1', 60_000);

    expect(h.deleteDocumentSubtree).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      deadline: Date.now() + 60_000,
    });
    vi.useRealTimers();
  });

  it('throws CascadeTruncatedError when a budgeted walk runs out of time', async () => {
    // The throw IS the resume mechanism: the trigger is defined `retry: true`,
    // so an unhandled rejection is what makes Eventarc redeliver the event and
    // walk the (now smaller) remainder. Everything reached is already committed
    // — `deleteDocumentSubtree` closes its BulkWriter before returning.
    h.deleteDocumentSubtree.mockResolvedValue({
      documentsDeleted: 4_000,
      collectionsVisited: 4_000,
      queriesIssued: 14,
      truncated: true,
      failedDeletes: 0,
    });

    await expect(
      cascadeCaroGenerico(fakeDb([]) as never, 'chat', 'c1', BUDGET_MS_PADRAO),
    ).rejects.toBeInstanceOf(CascadeTruncatedError);
  });
});
