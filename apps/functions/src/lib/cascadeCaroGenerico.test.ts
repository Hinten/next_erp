import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionMetadata } from '@delfrance/schemas';

const h = vi.hoisted(() => ({ deleteDocumentSubtree: vi.fn() }));

vi.mock('@delfrance/data/admin', () => ({
  deleteDocumentSubtree: h.deleteDocumentSubtree,
}));

import { cascadeCaroGenerico, defineCascadeCaroGenerico } from './cascadeCaroGenerico';

const META: CollectionMetadata = {
  collectionPath: 'integracao',
  permissions: { read: 1n, write: 2n, delete: 4n },
};

/**
 * The two fields firebase-tools reads off a v2 trigger to wire Eventarc. They
 * live in different maps: `document` is a path PATTERN (it carries `{docId}`),
 * `database` is an exact-match filter.
 */
function endpointOf(fn: unknown) {
  const { eventTrigger } = (
    fn as {
      __endpoint: {
        eventTrigger: {
          eventFilters: Record<string, string>;
          eventFilterPathPatterns: Record<string, string>;
        };
      };
    }
  ).__endpoint;
  return { ...eventTrigger.eventFilters, ...eventTrigger.eventFilterPathPatterns };
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
    expect(h.deleteDocumentSubtree).toHaveBeenCalledWith(expect.anything(), {
      path: 'integracao/abc',
    });
  });

  it('does not throw when the walk reports failed deletes', async () => {
    // A cascade that partially failed must still resolve: the trigger has
    // nothing useful to retry (the parent is already gone) and throwing would
    // only buy a redelivery of the same walk. The report is logged instead.
    h.deleteDocumentSubtree.mockResolvedValue({
      documentsDeleted: 2,
      collectionsVisited: 2,
      queriesIssued: 1,
      truncated: true,
      failedDeletes: 1,
      firstError: new Error('permission denied'),
    });

    await expect(
      cascadeCaroGenerico(fakeDb([]) as never, 'metodo_pgto', 'xyz'),
    ).resolves.toBeUndefined();
  });
});
