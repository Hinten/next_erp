import { logger } from 'firebase-functions';
import { onDocumentDeleted } from 'firebase-functions/v2/firestore';
import type { Firestore } from 'firebase-admin/firestore';
import { deleteDocumentSubtree, type DeleteSubtreeReport } from '@delfrance/data/admin';
import type { CollectionMetadata } from '@delfrance/schemas';

import { getDb } from './admin';

/**
 * CARO GENÉRICO — one delete cascade that works for any collection, at a price
 * per delete that only makes sense when deletes are RARE.
 *
 * Firestore never cascades subcollections, so a client `deleteDoc` on a parent
 * leaves every child orphaned forever. The five domains that cared enough wrote
 * a bespoke trigger each (`onProdutoDeleted`, `onOperacaoDeleted`,
 * `onCategoriaDeleted`, `onBalancoDeleted`, `onNfeDeleted`), and they are all
 * the same fifteen lines. This factory is those fifteen lines, once.
 *
 * ## Why "caro"
 *
 * `deleteDocumentSubtree` discovers children with `listCollections()` on **every
 * document it reaches**, leaves included — a document with no subcollections
 * still costs a call to find that out. So the toll scales with the SIZE of the
 * subtree, not just with what has to be deleted: a parent with 50 leaf children
 * pays 51 discovery calls, 50 of them returning nothing.
 *
 * That is a bargain next to the alternative (below) and invisible on a
 * two-document credential subtree deleted a few times a month. It is NOT
 * invisible on a hot delete path. **Use this factory where the
 * delete FLOW is low**, and note that flow is the only precondition — a rare
 * delete of a WIDE subtree is still a fine trade, because the toll is paid once
 * and nobody is waiting on it. `chat` is that case (#980): a conversa carries
 * thousands of leaf `mensagem` documents, each costing a `listCollections()`
 * that returns nothing, but an operator deletes a conversa by hand and almost
 * never. The targeted alternative — one kinded paged sweep over the declared
 * `chat/{conversaId}/mensagem` path, zero discovery — was weighed and rejected
 * as machinery bought for a flow that does not exist; it would also stop
 * reclaiming whatever the legacy corpus put under a conversa that this repo
 * never registered, which is the whole reason the walk asks Firestore instead of
 * the registry (see below).
 *
 * ## Volume: the budget, and what happens when it runs out (#980)
 *
 * A subtree wide enough to be worth discussing is a subtree that may not fit in
 * one invocation. Left alone the runtime simply kills the walk mid-flight —
 * queued deletes never flush, nothing is logged, and the remainder is orphaned
 * exactly as if no cascade existed. So a caller that expects volume passes
 * `budgetMs`, and the contract becomes:
 *
 *  - the walk stops CLEANLY at the budget (`DeleteSubtreeReport.truncated`), and
 *    `deleteDocumentSubtree` closes the BulkWriter on its way out, so every
 *    document reached so far is committed — progress is durable, never partial;
 *  - the handler then throws {@link CascadeTruncatedError}, and a budgeted
 *    trigger is defined with `retry: true`, so Eventarc redelivers the event;
 *  - the redelivered walk restarts from the root and finds a smaller subtree
 *    (the walk is idempotent and safe on an already-deleted parent), so each
 *    delivery makes strictly monotone progress until one completes.
 *
 * ⚠️ The budget must leave room for the writer's final flush; `BUDGET_MS_PADRAO`
 * is sized against `timeoutSeconds: 540` the same way `ORCAMENTO_MS` is in
 * `apps/functions/src/estoques/aplicarBalanco.ts`.
 *
 * Without `budgetMs` there is no deadline, no `retry`, and truncation cannot
 * happen — the three credential cascades keep exactly the shape #979 gave them.
 * A `failedDeletes` report never throws under either mode: those are permanent
 * per-document failures the writer already retried, and redelivering the walk
 * would only reproduce them.
 *
 * ## Why not `db.recursiveDelete` (#728 / #729)
 *
 * It is the obvious tool and it is banned here. It issues one **kindless**
 * all-descendants query — `COLLECTION_GROUP * SELECT __name__ LIMIT 5000` — that
 * Firestore Enterprise cannot index and cannot be GIVEN an index for: no
 * wildcard index exists and there is no field predicate to seek on, so the
 * console's "create index" button opens a blank form. Nothing throws; Enterprise
 * simply bills data scanned. Measured on staging: **~6,184 documents per call**,
 * 9,234 calls in 7 days = 93% of the project's read volume. And the query fires
 * *before anything is known about the subtree*, so "this delete is rare" buys
 * less than it looks — the price is identical for an empty subtree and a huge
 * one. Verify live with `scripts/check-delete-cost.mjs`.
 *
 * ## Why the walk is discovery-driven, not meta-driven
 *
 * It would be tidier to sweep exactly the paths a domain declares in
 * `meta.cascade`. It would also be WRONG: Flutter writes subcollections this
 * repo never registered, and `integracaoMeta.cascade` already omits
 * `brandshopee`, which this factory reclaims anyway. See the ⚠️ in
 * `packages/data/src/admin/deleteSubtree.ts`.
 */

/**
 * Wall-clock budget a budgeted cascade gets by default, against
 * `TIMEOUT_SECONDS_PADRAO`. The gap covers the walk's in-flight page plus the
 * BulkWriter flush `deleteDocumentSubtree` performs on its way out — a budget
 * that leaves no room for that flush throws away the progress it just made.
 */
export const BUDGET_MS_PADRAO = 400_000;

/** Function timeout that {@link BUDGET_MS_PADRAO} is sized against. */
export const TIMEOUT_SECONDS_PADRAO = 540;

/**
 * A budgeted walk stopped at its deadline with documents still below the root.
 *
 * Thrown ONLY when the caller asked for a budget, because it exists to be
 * unhandled: the trigger that owns it is defined with `retry: true`, so the
 * throw is how the remainder gets redelivered. Everything the walk reached is
 * already committed, so the redelivery resumes rather than repeats.
 */
export class CascadeTruncatedError extends Error {
  constructor(
    readonly docPath: string,
    readonly report: DeleteSubtreeReport,
  ) {
    super(
      `cascadeCaroGenerico: ${docPath} hit its budget after ` +
        `${report.documentsDeleted} document(s); throwing so Eventarc redelivers the rest`,
    );
    this.name = 'CascadeTruncatedError';
  }
}

/** Per-cascade knobs. Omit the whole bag for the unbudgeted, never-retried shape. */
export interface CascadeCaroGenericoOptions {
  /**
   * Wall-clock budget for ONE invocation, in ms. Supplying it is what turns on
   * the whole truncation contract (deadline → clean stop → throw → `retry`);
   * omitting it means the walk has no deadline and cannot report `truncated`.
   */
  budgetMs?: number;
  /**
   * `timeoutSeconds` for the generated trigger. Must exceed `budgetMs` — the
   * walk stops at the budget and then still has to flush the BulkWriter, so a
   * timeout at or below it kills the invocation before the progress commits.
   * Enforced by {@link assertBudgetFitsTimeout} at definition time.
   */
  timeoutSeconds?: number;
}

/**
 * Fail at MODULE LOAD if a cascade's budget cannot fit inside its timeout.
 *
 * Deliberately a throw rather than a lint rule or a clamp: both values are
 * literals at every call site, so the mistake is fully decidable here, and the
 * failure mode it prevents is silent — the runtime would kill the invocation
 * mid-flush and the remainder would look like an ordinary truncation. Firebase
 * evaluates this during codebase analysis, so a bad pair breaks `deploy` and
 * the functions emulator rather than shipping.
 */
export function assertBudgetFitsTimeout(
  collectionPath: string,
  budgetMs: number,
  timeoutSeconds: number,
): void {
  if (budgetMs < timeoutSeconds * 1000) return;
  throw new Error(
    `defineCascadeCaroGenerico(${collectionPath}): budgetMs (${budgetMs}) must be ` +
      `less than timeoutSeconds (${timeoutSeconds}) in ms (${timeoutSeconds * 1000}) — ` +
      'the walk stops at the budget and still has to flush the BulkWriter.',
  );
}

/**
 * Delete `<collectionPath>/<docId>` and everything beneath it.
 *
 * Exported so the emulator suite drives the SAME code the trigger runs — the
 * convention every `*.storage.test.ts` in this package follows, since trigger
 * delivery on a named database is awkward to exercise in the emulator.
 *
 * Idempotent, and safe on a document that is already gone: subcollections
 * outlive their parent, which is exactly the orphan an `onDocumentDeleted`
 * cascade exists to reclaim. That matters beyond retries — the legacy Flutter
 * app still runs its own `deleteCascade` against these same documents.
 *
 * With `budgetMs`, throws {@link CascadeTruncatedError} when the walk ran out of
 * time with work left. Without it, resolves in every case a walk can reach.
 */
export async function cascadeCaroGenerico(
  db: Firestore,
  collectionPath: string,
  docId: string,
  budgetMs?: number,
): Promise<void> {
  const report = await deleteDocumentSubtree(db, db.collection(collectionPath).doc(docId), {
    deadline: budgetMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + budgetMs,
  });

  // The cost the name warns about, per delete, in production rather than in
  // folklore: `collectionsVisited` IS the listCollections() count.
  logger.info(
    `cascadeCaroGenerico: ${collectionPath}/${docId} → ` +
      `${report.documentsDeleted} docs, ${report.collectionsVisited} listCollections, ` +
      `${report.queriesIssued} queries`,
    { truncated: report.truncated, failedDeletes: report.failedDeletes },
  );

  if (report.failedDeletes > 0) {
    // Deliberately does NOT throw, budgeted or not: the writer already retried
    // these and they failed permanently, so a redelivery reproduces them and
    // buys a retry storm instead of a reclaimed document.
    logger.error(
      `cascadeCaroGenerico: ${collectionPath}/${docId} left ${report.failedDeletes} document(s) behind`,
      report.firstError,
    );
  }

  if (report.truncated) {
    throw new CascadeTruncatedError(`${collectionPath}/${docId}`, report);
  }
}

/**
 * Build the `onDocumentDeleted` trigger for a collection's subtree cascade.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (gotcha #8); a
 * trigger that omits `database` binds to `(default)` and never fires — silently,
 * which is the worst way for a cascade to fail.
 *
 * ⚠️ `retry` is derived from `budgetMs`, never passed separately: redelivery is
 * the only reason a budget is worth having, and a budget without it would stop
 * the walk cleanly and then drop the remainder on purpose. The unbudgeted
 * cascades stay at `retry: false` — their subtrees are two documents and the
 * only thing a redelivery could reproduce is a permanent failure.
 */
export function defineCascadeCaroGenerico(
  meta: CollectionMetadata,
  options: CascadeCaroGenericoOptions = {},
) {
  const { budgetMs, timeoutSeconds } = options;
  if (budgetMs !== undefined && timeoutSeconds !== undefined) {
    assertBudgetFitsTimeout(meta.collectionPath, budgetMs, timeoutSeconds);
  }
  return onDocumentDeleted(
    {
      document: `${meta.collectionPath}/{docId}`,
      database: process.env.FIREBASE_DATABASE_ID ?? 'default',
      retry: budgetMs !== undefined,
      ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    },
    async (event) => {
      const { docId } = event.params as { docId: string };
      await cascadeCaroGenerico(getDb(), meta.collectionPath, docId, budgetMs);
    },
  );
}
