import {
  FieldPath,
  FieldValue,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import { ghostFieldPath, planGhostKeys } from './transform';

/**
 * Cleanup: remove the unreadable `listaDePrecos/<id>` ghost keys the legacy
 * Flutter ML price handler accumulated in `produto.precos` (#803). Idempotent
 * (a second run finds nothing), dry-run by default.
 *
 *   pnpm --filter @delfrance/migrations migrate:ml-precos-ghost-keys -- \
 *     --project <staging-id>            # dry-run: logs what it would remove
 *   pnpm --filter @delfrance/migrations migrate:ml-precos-ghost-keys -- \
 *     --project <staging-id> --apply    # write
 *
 * ---- Cost: this walks every produto, and Firestore Enterprise bills DATA
 * SCANNED. The walk is paged by document id — Firestore's always-available
 * native ordering, so it needs no index — and the ghost test runs in code on the
 * fetched page. There is deliberately no server-side filter: no query can ask
 * "has a map key containing a slash", and inventing an indexed marker field for
 * a one-off cleanup would cost a write per produto to save a read per produto.
 */

const PAGE_SIZE = 300;

/** Page a collection by document id — a stable cursor with bounded memory. */
async function* pagesByDocId(coll: CollectionReference): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = coll.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('produtos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const plan = planGhostKeys((doc.data() as Record<string, unknown>).precos);

      for (const s of plan.skips) ctx.sink.skip(doc.ref.path, s.key, null, s.reason);
      if (plan.deletes.length === 0) continue;

      const patch: Record<string, unknown> = {};
      for (const key of plan.deletes) {
        // `to: null` in the log is the sentinel for "removed" — the sink writes
        // JSON, and a FieldValue sentinel does not serialize meaningfully.
        ctx.sink.change(doc.ref.path, ghostFieldPath(key), 'ghost key', null);
        patch[ghostFieldPath(key)] = FieldValue.delete();
      }
      await ctx.writer.update(doc.ref, patch);
      docsChanged += 1;
    }
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('ml-precos-ghost-keys', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
