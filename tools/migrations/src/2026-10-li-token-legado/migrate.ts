import { FieldPath, FieldValue, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import {
  describeRemoval,
  planTokenLegado,
  TOKEN_FIELD,
  tallyByTipo,
  type TokenLegadoPlan,
} from './transform';

/**
 * Remove the legacy `token_id` credential field from every `integracao`
 * document that carries it, whatever the document's `tipo`. Runbook:
 * `tools/migrations/li-token-legado.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:li-token-legado \
 *     --project <project-id> --report-only   # counts per tipo, no per-doc rows
 *   pnpm --filter @delfrance/migrations migrate:li-token-legado \
 *     --project <project-id>                 # dry-run: logs each doc it would touch
 *   pnpm --filter @delfrance/migrations migrate:li-token-legado \
 *     --project <project-id> --apply         # write
 *
 * ---- ⚠️ WHEN. Only inside the migration window (root `CLAUDE.md` rule 8 /
 * ADR 0013). The legacy app still READS `token_id` until it is switched off, so
 * deleting the field earlier would break the legacy integration it serves, and
 * an earlier run is superseded by every legacy write after it. The pass is
 * idempotent, so an early dry-run is harmless; the authoritative run is the one
 * inside the window.
 *
 * ---- ⚠️ The value is never copied into a variable, logged, or printed. A log
 * row names the document path and its `tipo`, nothing else.
 *
 * ---- Cost: `integracao` holds about ten documents, so the full scan is
 * negligible. It is paged by document key anyway, as the sibling scripts are, so
 * the shape does not break if the collection grows.
 *
 * ---- Race (root `CLAUDE.md` rule 7): tier 0. `FieldValue.delete()` on one named
 * field is idempotent and order-free, and nothing here is derived from the read
 * beyond "the key is there", so there is nothing to compare.
 */

const PAGE_SIZE = 300;

/** The patch for one document: delete `token_id` and nothing else. */
export function buildPatch(): Record<string, unknown> {
  return { [TOKEN_FIELD]: FieldValue.delete() };
}

async function* pagesByDocId(ctx: MigrationContext): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q = ctx.db.collection('integracao').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

/**
 * `--report-only`: count the documents carrying the field, per `tipo`, writing
 * nothing and logging no per-document rows. Also the post-apply census — it must
 * read 0.
 */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const plans: TokenLegadoPlan[] = [];
  let docsScanned = 0;
  for await (const docs of pagesByDocId(ctx)) {
    for (const doc of docs) {
      docsScanned += 1;
      plans.push(planTokenLegado(doc.data()));
    }
  }
  const tally = tallyByTipo(plans);
  const total = [...tally.values()].reduce((a, b) => a + b, 0);
  const lines = [
    `[li-token-legado] REPORT — ${docsScanned} integracao doc(s), ${total} carrying ${TOKEN_FIELD}`,
  ];
  for (const [tipo, n] of [...tally.entries()].sort()) {
    lines.push(`  tipo ${tipo.padEnd(12)} ${String(n).padStart(6)}`);
  }
  log(lines.join('\n'));
  return { docsScanned, docsChanged: 0 };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.reportOnly) return runReport(ctx);

  let docsScanned = 0;
  let docsChanged = 0;
  for await (const docs of pagesByDocId(ctx)) {
    for (const doc of docs) {
      docsScanned += 1;
      const plan = planTokenLegado(doc.data());
      if (plan.action === 'skip') continue;
      const { from, to } = describeRemoval(plan);
      ctx.sink.change(doc.ref.path, TOKEN_FIELD, from, to);
      await ctx.writer.update(doc.ref, buildPatch());
      docsChanged += 1;
    }
  }
  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  runMigration('li-token-legado', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
