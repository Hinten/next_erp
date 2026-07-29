import type {
  BulkWriter,
  CollectionReference,
  DocumentReference,
  Firestore,
  Query,
  QueryDocumentSnapshot,
} from 'firebase-admin/firestore';

/**
 * Delete a document and everything below it, WITHOUT a kindless descendant scan
 * (#728 / #729).
 *
 * `db.recursiveDelete(ref)` looks like the obvious tool and was the original
 * implementation everywhere. It issues one **kindless all-descendants** query
 * per call — `COLLECTION_GROUP * SELECT __name__ LIMIT 5000`, built by
 * `RecursiveDelete.getAllDescendants()` via
 * `QueryOptions.forKindlessAllDescendants()`. It is already keys-only, so
 * document bodies were never the cost; the *kindless* shape is. On Firestore
 * **Enterprise** that query rides no index — Enterprise auto-creates none, has
 * no wildcard index, and a kindless descendant scan carries no field predicate
 * to seek on, so the console's "create index" button has nothing to propose. It
 * silently full-scans and Enterprise bills DATA SCANNED. Measured on the staging
 * project: **~6,184 documents scanned per call**, 9,234 calls in 7 days = 57.1M
 * documents, 93% of the project's read volume.
 *
 * Worse, the query is issued **unconditionally, before anything is known about
 * the subtree** — a produto with zero subcollections costs exactly as much as
 * one with fifty. So there is no seeding or usage change that helps; the query
 * shape itself has to go.
 *
 * `docRef.listCollections()` answers the same question for **~5 read units**
 * (measured: 330 units over 66 calls), returns only the subcollections that
 * actually hold documents, and works on a ref whose document is already gone —
 * which is exactly how an `onDocumentDeleted` cascade reaches its orphans. Every
 * delete query below it is then **kinded** and bounded to one parent path, so it
 * rides Firestore's always-available document-key index and needs nothing
 * declared in `firestore.indexes.json`. Precedent: the cursor-paged
 * `fetchArquivoPage` in `apps/functions/src/arquivos/arquivoOrphanSweep.ts` (#234).
 *
 * ⚠️ **Do not replace `listCollections()` with a registry-derived list.** It is
 * tempting — `ALL_DOMAINS` knows most of these paths — but it is wrong, not
 * merely slower. Flutter still writes subcollections this repo deliberately does
 * not register: `packages/schemas/src/produto/collection/subcollections.ts`
 * documents `variacoesml` as a legacy spelling that never matched production,
 * and `apps/functions/src/produtos/onProdutoDeleted.storage.test.ts` seeds
 * exactly that name and asserts it is reclaimed. A registry walk orphans it
 * silently. The same defect is why `metodo_pgto/{id}/credenciais` was orphaned
 * by the e2e sweep for as long as that sweep consulted `ALL_DOMAINS`.
 *
 * ⚠️ **The parent document is deleted FIRST**, unlike `recursiveDelete` (which
 * deletes it last, in `onQueryEnd`). `recordModification(..., { requireParentExists: true })`
 * in `apps/functions/src/lib/modificationHistory.ts` skips its write only when
 * the parent is *gone*, and `onProdutoImpostoChanged` / `onProdutoExtraDataChanged`
 * are `onDocumentWritten` — they fire on deletes. Sweeping children while the
 * parent still exists therefore writes NEW `historicoDeModificacoes` rows under
 * a document we are half-way through deleting.
 *
 * No runtime `firebase-admin` import: every type here is `import type` and the
 * caller supplies `db`. `packages/data/src/admin/adminBundleSafety.test.ts`
 * enforces that for the whole subtree, which is also why paging uses a bare
 * `.select()` (keys-only projection) plus a **snapshot** cursor rather than
 * `orderBy(FieldPath.documentId())` — `FieldPath` is a runtime value. An
 * unordered query already carries an implicit `__name__` ordering, so
 * `startAfter(lastSnapshot)` is the same walk with no import.
 */

/** Documents fetched per page. Matches `PAGE_SIZE` in the e2e sweep. */
const DEFAULT_PAGE_SIZE = 300;

/** Sibling subcollections walked at once. Matches `CHILD_DELETE_CONCURRENCY`. */
const DEFAULT_CONCURRENCY = 5;

export interface DeleteSubtreeOptions {
  /**
   * Shared writer, created ONCE by the caller and closed by the caller.
   * Without it the SDK lazily shares a single writer and every call awaits
   * *everyone else's* pending operations.
   */
  writer?: BulkWriter;
  /** Documents fetched per page. Defaults to 300. */
  pageSize?: number;
  /** Sibling subcollections walked at once. Defaults to 5. */
  concurrency?: number;
  /**
   * Absolute wall-clock deadline (`Date.now()` scale). Past it the walk stops
   * cleanly and reports `truncated` — it never throws, and never leaves a
   * half-committed batch.
   */
  deadline?: number;
}

export interface DeleteSubtreeReport {
  /** Documents queued on the writer, including the root ref. */
  documentsDeleted: number;
  /** `listCollections()` calls made — one per document reached. */
  collectionsVisited: number;
  /** Delete queries issued. The number a cost gate watches. */
  queriesIssued: number;
  /** True when the deadline stopped the walk with work left behind. */
  truncated: boolean;
  /** Queued deletes that failed permanently (after the writer's own retries). */
  failedDeletes: number;
  /** First such failure, kept so a caller can log something actionable. */
  firstError?: unknown;
}

/** Mutable accumulator so the recursion reports one total, not a tree of them. */
interface Walk {
  report: DeleteSubtreeReport;
  writer: BulkWriter;
  pageSize: number;
  concurrency: number;
  deadline: number;
}

/** True once the wall-clock budget is spent; flips `truncated` on the way out. */
function outOfTime(walk: Walk): boolean {
  if (Date.now() <= walk.deadline) return false;
  walk.report.truncated = true;
  return true;
}

/**
 * Run `task` over `items` with at most `limit` in flight.
 *
 * Slice-at-a-time rather than a worker pool: it matches the existing
 * `CHILD_DELETE_CONCURRENCY` batching in `onProdutoDeleted` and keeps the
 * ordering predictable for the unit test.
 */
async function inBatches<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.all(items.slice(i, i + limit).map(task));
  }
}

/**
 * Delete every document in `col` and, depth-first, each one's own subtree.
 *
 * Cursor paging (`startAfter(lastSnapshot)`), never loop-until-empty: the writer
 * is fire-and-forget, so re-querying from the top would depend on reading back
 * deletes that have not committed and would re-walk the same page forever.
 */
async function deleteCollection(col: CollectionReference, walk: Walk): Promise<void> {
  let cursor: QueryDocumentSnapshot | undefined;

  for (;;) {
    if (outOfTime(walk)) return;

    const base: Query = col.select().limit(walk.pageSize);
    const page = cursor ? base.startAfter(cursor) : base;
    walk.report.queriesIssued += 1;
    const snap = await page.get();
    if (snap.empty) return;

    // Each doc is queued for deletion and THEN descended into (parent-first at
    // every level — see the module docblock: children-first resurrects history
    // rows). A crash mid-walk therefore leaves an orphaned subtree, exactly as
    // an interrupted `recursiveDelete` did; the periodic sweep reclaims it,
    // since `listCollections()` still reports children of a deleted doc.
    await inBatches(snap.docs, walk.concurrency, (doc) => walkSubtree(doc.ref, walk));
    if (walk.report.truncated) return;

    if (snap.size < walk.pageSize) return;
    cursor = snap.docs[snap.size - 1];
  }
}

/** Delete `ref` (parent-first) then recurse into whatever `listCollections()` reports. */
async function walkSubtree(ref: DocumentReference, walk: Walk): Promise<void> {
  // Fire-and-forget onto the shared writer, which batches and retries on its
  // own; awaiting each delete would serialize the whole walk. The rejection is
  // RECORDED, never swallowed — one stale ref racing another sweep to NOT_FOUND
  // must not abandon the backlog, but a permission or quota failure has to be
  // visible in the report. Mirrors `RecursiveDelete.onQueryEnd`, which does the
  // same thing with an error counter.
  walk.writer.delete(ref).catch((err: unknown) => {
    walk.report.failedDeletes += 1;
    walk.report.firstError ??= err;
  });
  walk.report.documentsDeleted += 1;

  if (outOfTime(walk)) return;

  walk.report.collectionsVisited += 1;
  const children = await ref.listCollections();
  if (children.length === 0) return;

  await inBatches(children, walk.concurrency, (col) => deleteCollection(col, walk));
}

/**
 * Delete `ref` and its entire subtree. Idempotent, and safe on a ref whose
 * document no longer exists (the subcollections outlive it — that is exactly the
 * orphan case a delete cascade has to reclaim).
 *
 * The caller owns the `BulkWriter`: pass one in and `close()` it once, after the
 * last call. Without that, each call awaits every other caller's queued writes.
 */
export async function deleteDocumentSubtree(
  db: Firestore,
  ref: DocumentReference,
  options: DeleteSubtreeOptions = {},
): Promise<DeleteSubtreeReport> {
  const ownWriter = options.writer === undefined;
  const writer = options.writer ?? db.bulkWriter();
  const walk: Walk = {
    report: {
      documentsDeleted: 0,
      collectionsVisited: 0,
      queriesIssued: 0,
      truncated: false,
      failedDeletes: 0,
    },
    writer,
    pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
    concurrency: options.concurrency ?? DEFAULT_CONCURRENCY,
    deadline: options.deadline ?? Number.POSITIVE_INFINITY,
  };

  try {
    await walkSubtree(ref, walk);
  } finally {
    // Only a writer we created is ours to close; a shared one belongs to the
    // caller, who is still queueing work onto it.
    if (ownWriter) await writer.close();
  }

  return walk.report;
}
