import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import { planHistoricoV2 } from './transform';

/**
 * Reshape `historicoEstoque` v1 → v2 so the stock ledger can be SUMMED
 * (ADR 0014, #695). See `transform.ts` for the field mapping and, above all,
 * for why a balanço's delta is sometimes left `null` instead of guessed.
 *
 *   pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- \
 *     --project <project-id>            # dry-run: logs every row it would touch
 *   pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- \
 *     --project <project-id> --apply    # write
 *
 * ---- ⚠️ WHEN. This runs inside the cutover window (root `CLAUDE.md` rule 8 /
 * ADR 0013), not before. The Flutter app still writes v1 rows, so an earlier run
 * is partially undone by every write that lands after it — the authoritative
 * run is the one inside the window, after Flutter stops. Running early is not
 * harmful (the pass is idempotent), it is simply not finished.
 *
 * ---- Cost, honestly: this walks EVERY `historicoEstoque` row in the database
 * via a collection-group scan, and Firestore Enterprise bills DATA SCANNED. The
 * walk is paged by document key — Firestore's always-available native ordering,
 * so it needs no index — and every decision is made in code on the fetched page.
 * There is no cheaper shape: the rows to convert are exactly "all of them", so
 * no predicate could narrow it, and a `where movimento == null` filter would
 * need an index over a field that does not exist yet on any row.
 *
 * ---- Idempotent: a row already carrying a numeric `movimento` is skipped, so a
 * re-run after an interrupted pass converts only what is left.
 */

const PAGE_SIZE = 300;

/**
 * Page the `historicoEstoque` COLLECTION GROUP by document key. Unlike a
 * single-collection walk this crosses every produto × estoque, which is the
 * point: the rows live three levels deep and there is no other way to reach
 * them all without enumerating parents.
 */
async function* pagesByDocId(ctx: MigrationContext): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .collectionGroup('historicoEstoque')
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
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
  let semDelta = 0;

  for await (const docs of pagesByDocId(ctx)) {
    for (const doc of docs) {
      docsScanned += 1;
      const verdict = planHistoricoV2(doc.data(), doc.ref.path);

      if (verdict.kind === 'ja-migrado') continue;
      if (verdict.kind === 'sem-dados') {
        ctx.sink.skip(doc.ref.path, 'movimento', null, 'linha sem shape reconhecível');
        continue;
      }

      for (const [campo, valor] of Object.entries(verdict.patch)) {
        ctx.sink.change(doc.ref.path, campo, null, valor);
      }
      if (verdict.kind === 'movimento-desconhecido') {
        semDelta += 1;
        // Loud in the JSONL as well as in the change log: these rows contribute
        // nothing to `sum(movimento)`, which makes the sweep SEND rather than
        // skip. Correct, but the operator should know how many there are.
        ctx.sink.skip(doc.ref.path, 'movimento', doc.data().quantidade, verdict.motivo);
      }
      await ctx.writer.update(doc.ref, verdict.patch);
      docsChanged += 1;
    }
  }

  if (semDelta > 0) {
    console.log(
      `[historico-estoque-v2] ${semDelta} balanço(s) sem delta recuperável — gravados com ` +
        `movimento: null (fail-open: o sweep envia em vez de pular). Procure "balanço sem" no JSONL.`,
    );
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('historico-estoque-v2', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
