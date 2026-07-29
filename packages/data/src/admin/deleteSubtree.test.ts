import { describe, expect, it } from 'vitest';
import { deleteDocumentSubtree } from './deleteSubtree';

/**
 * A tree-shaped Firestore stand-in.
 *
 * `tree` maps a document path to its subcollections, so `listCollections()` can
 * answer honestly and the walk can be checked against a subtree the registry
 * would NOT know about (the `variacoesml` case that makes `listCollections()`
 * the only correct child source — see the module docblock).
 */
type Tree = Record<string, Record<string, readonly string[]>>;

interface Recorded {
  /** Document paths handed to the writer, in order. Order is the C2 assertion. */
  deletes: string[];
  /** Collection paths queried, one entry per page. */
  queries: string[];
  /** True once `select()` was called without a field mask on every query. */
  selectCalls: number;
  closed: boolean;
}

function fakeDb(tree: Tree, recorded: Recorded, pageSize = 300) {
  const makeDoc = (path: string) => ({
    path,
    listCollections: () => {
      const children = tree[path] ?? {};
      return Promise.resolve(
        Object.keys(children).map((name) => makeCollection(`${path}/${name}`)),
      );
    },
  });

  const makeCollection = (path: string) => {
    const parentPath = path.slice(0, path.lastIndexOf('/'));
    const name = path.slice(path.lastIndexOf('/') + 1);
    const ids = tree[parentPath]?.[name] ?? [];

    const page = (after: string | undefined) => {
      const start = after ? ids.indexOf(after) + 1 : 0;
      const slice = ids.slice(start, start + pageSize);
      return {
        empty: slice.length === 0,
        size: slice.length,
        docs: slice.map((id) => ({ id, ref: makeDoc(`${path}/${id}`) })),
      };
    };

    const query = (after?: string) => ({
      limit: () => query(after),
      startAfter: (cursor: { id: string }) => query(cursor.id),
      get: () => {
        recorded.queries.push(path);
        return Promise.resolve(page(after));
      },
    });

    return {
      path,
      select: (...fields: string[]) => {
        // A field mask here would mean the walk is paying for document bodies.
        expect(fields).toEqual([]);
        recorded.selectCalls += 1;
        return query();
      },
    };
  };

  return {
    db: {
      bulkWriter: () => ({
        delete: (ref: { path: string }) => {
          recorded.deletes.push(ref.path);
          return Promise.resolve();
        },
        close: () => {
          recorded.closed = true;
          return Promise.resolve();
        },
      }),
    },
    doc: makeDoc,
  };
}

function noneRecorded(): Recorded {
  return { deletes: [], queries: [], selectCalls: 0, closed: false };
}

describe('deleteDocumentSubtree', () => {
  it('deletes the parent BEFORE its children, so history triggers see a dead parent', async () => {
    // `recordModification({ requireParentExists: true })` skips its write only
    // when the parent is GONE. Children-first would let every imposto/extraData
    // delete append a fresh historicoDeModificacoes row under the produto being
    // deleted — the exact reason this does not copy `recursiveDelete`, which
    // deletes the root last.
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({ 'produtos/p1': { imposto: ['i1'] } }, recorded);

    await deleteDocumentSubtree(db as never, doc('produtos/p1') as never);

    expect(recorded.deletes).toEqual(['produtos/p1', 'produtos/p1/imposto/i1']);
  });

  it('reclaims a subcollection the schema registry does not declare', async () => {
    // `variacoesml` is a legacy Flutter spelling deliberately absent from
    // ALL_DOMAINS. A registry-driven walk orphans it; listCollections() cannot.
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({ 'produtos/p1': { variacoesml: ['v1'] } }, recorded);

    await deleteDocumentSubtree(db as never, doc('produtos/p1') as never);

    expect(recorded.deletes).toContain('produtos/p1/variacoesml/v1');
  });

  it('recurses two levels (produtos → estoques → historicoEstoque)', async () => {
    const recorded = noneRecorded();
    const { db, doc } = fakeDb(
      {
        'produtos/p1': { estoques: ['e1'] },
        'produtos/p1/estoques/e1': { historicoEstoque: ['h1', 'h2'] },
      },
      recorded,
    );

    const report = await deleteDocumentSubtree(db as never, doc('produtos/p1') as never);

    expect(recorded.deletes).toEqual([
      'produtos/p1',
      'produtos/p1/estoques/e1',
      'produtos/p1/estoques/e1/historicoEstoque/h1',
      'produtos/p1/estoques/e1/historicoEstoque/h2',
    ]);
    expect(report.documentsDeleted).toBe(4);
  });

  it('issues no query at all for a document with no subcollections', async () => {
    // The whole point: `recursiveDelete` pays its ~6,184-document kindless scan
    // here regardless. This must cost one listCollections() and nothing else.
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({}, recorded);

    const report = await deleteDocumentSubtree(db as never, doc('produtos/empty') as never);

    expect(recorded.queries).toEqual([]);
    expect(report.queriesIssued).toBe(0);
    expect(report.collectionsVisited).toBe(1);
    expect(recorded.deletes).toEqual(['produtos/empty']);
  });

  it('pages with a cursor across a pageSize boundary instead of re-reading page 1', async () => {
    // Loop-until-empty would re-read the same page forever: the writer is
    // fire-and-forget, so the deletes are not visible to the next query.
    const recorded = noneRecorded();
    const ids = ['a', 'b', 'c', 'd', 'e'];
    const { db, doc } = fakeDb({ 'produtos/p1': { historicoDePrecos: ids } }, recorded, 2);

    const report = await deleteDocumentSubtree(db as never, doc('produtos/p1') as never, {
      pageSize: 2,
    });

    expect(recorded.deletes).toEqual([
      'produtos/p1',
      ...ids.map((id) => `produtos/p1/historicoDePrecos/${id}`),
    ]);
    // 3 pages: [a,b] [c,d] [e] — the last is short, so no fourth query.
    expect(report.queriesIssued).toBe(3);
  });

  it('projects keys only — never fetches document bodies', async () => {
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({ 'produtos/p1': { imposto: ['i1'] } }, recorded);

    await deleteDocumentSubtree(db as never, doc('produtos/p1') as never);

    // The `expect(fields).toEqual([])` inside the fake is the real assertion;
    // this proves it actually ran.
    expect(recorded.selectCalls).toBe(1);
  });

  it('stops at the deadline and reports truncation rather than throwing', async () => {
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({ 'produtos/p1': { imposto: ['i1'] } }, recorded);

    const report = await deleteDocumentSubtree(db as never, doc('produtos/p1') as never, {
      deadline: Date.now() - 1,
    });

    expect(report.truncated).toBe(true);
    // The root still goes — it is queued before the deadline is consulted, so a
    // truncated walk can never leave a live parent above dead children.
    expect(recorded.deletes).toEqual(['produtos/p1']);
    expect(recorded.queries).toEqual([]);
  });

  it('closes a writer it created, and leaves a caller-supplied one open', async () => {
    const own = noneRecorded();
    const ownFake = fakeDb({}, own);
    await deleteDocumentSubtree(ownFake.db as never, ownFake.doc('produtos/p1') as never);
    expect(own.closed).toBe(true);

    const shared = noneRecorded();
    const sharedFake = fakeDb({}, shared);
    const writer = sharedFake.db.bulkWriter();
    await deleteDocumentSubtree(sharedFake.db as never, sharedFake.doc('produtos/p2') as never, {
      writer: writer as never,
    });
    // Closing it here would strand every other in-flight call on that writer.
    expect(shared.closed).toBe(false);
  });

  it('records a failed delete instead of swallowing it or aborting the walk', async () => {
    const recorded = noneRecorded();
    const { db, doc } = fakeDb({ 'produtos/p1': { imposto: ['i1'] } }, recorded);
    const boom = new Error('PERMISSION_DENIED');
    const failing = {
      ...db,
      bulkWriter: () => ({
        delete: (ref: { path: string }) => {
          recorded.deletes.push(ref.path);
          return ref.path.endsWith('/i1') ? Promise.reject(boom) : Promise.resolve();
        },
        close: () => Promise.resolve(),
      }),
    };

    const report = await deleteDocumentSubtree(failing as never, doc('produtos/p1') as never);

    expect(report.failedDeletes).toBe(1);
    expect(report.firstError).toBe(boom);
    expect(report.documentsDeleted).toBe(2);
  });
});
