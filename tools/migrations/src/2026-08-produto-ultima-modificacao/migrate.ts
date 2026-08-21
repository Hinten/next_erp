import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import { planUltimaModificacao } from './transform';

/**
 * Backfill: give every `produtos/{id}` an `ultimaModificacao` key, so none is
 * hidden by the `/produtos` default sort. Idempotent, dry-run by default.
 * Runbook: `tools/migrations/produto-ultima-modificacao.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:produto-ultima-modificacao -- \
 *     --project <id>                    # dry-run: count + log what would change
 *   pnpm --filter @delfrance/migrations migrate:produto-ultima-modificacao -- \
 *     --project <id> --apply            # write
 *
 * ⚠️ This is a FULL collection walk, not a query. Firestore cannot express
 * "field is missing" as a filter — an absent key is simply not in any index —
 * so every produto has to be read and inspected. On Enterprise that is billed
 * by data scanned, which is precisely why this is a one-shot manual run inside
 * the cutover window rather than anything scheduled. See root `CLAUDE.md`
 * rule 8 / ADR 0013.
 */

const PAGE_SIZE = 300;

/** Page by document id — a stable cursor with bounded memory. */
async function* pagesByDocId(
  coll: CollectionReference | Query,
): AsyncGenerator<QueryDocumentSnapshot[]> {
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

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  // One clock for the whole run, so produtos that fall back to it stay
  // mutually ordered by their `timestamp` tiebreak rather than by scan order.
  const fallbackMs = Date.now();
  log(`[produto-ultima-modificacao] full walk of produtos; fallback stamp ${fallbackMs}`);

  let docsScanned = 0;
  let docsChanged = 0;
  let alreadyPresent = 0;

  // The top-level collection only. Variation CHILDREN live in `produtos` too
  // (they carry `paiId != null`), so they are covered by the same walk — and
  // they need it: `VariationManager` is one of the writers that dropped the key.
  for await (const docs of pagesByDocId(ctx.db.collection('produtos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const plan = planUltimaModificacao(doc.data() as Record<string, unknown>, fallbackMs);
      if (plan.action === 'skip') {
        // The overwhelming majority once this has run once — logging each would
        // bury the rows that actually changed. The summary still counts them.
        alreadyPresent += 1;
        continue;
      }
      ctx.sink.change(doc.ref.path, 'ultimaModificacao', plan.from, plan.to);
      docsChanged += 1;
      await ctx.writer.update(doc.ref, { ultimaModificacao: plan.to });
    }
  }

  log(
    `[produto-ultima-modificacao] ${docsChanged} missing the key, ` +
      `${alreadyPresent} already had it (skipped)`,
  );
  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  runMigration('produto-ultima-modificacao', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
