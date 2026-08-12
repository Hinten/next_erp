import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import { planHistoricoV2 } from './transform';

/**
 * Reshape `historicoEstoque` v1 → v2 so the stock ledger can be SUMMED
 * (ADR 0014, #695). See `transform.ts` for the field mapping and, above all,
 * for why a balanço's delta is sometimes left UNKNOWN instead of guessed.
 *
 *   pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- \
 *     --project <project-id> --report-only  # pre-flight: counts the stored shapes
 *   pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- \
 *     --project <project-id>            # dry-run: logs every row it would touch
 *   pnpm --filter @delfrance/migrations migrate:historico-estoque-v2 -- \
 *     --project <project-id> --apply    # write
 *
 * Run `--report-only` FIRST: a dry-run enumerates what the transform already
 * knows how to handle, which is precisely why it cannot describe the corpus.
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
 * re-run after an interrupted pass converts only what is left. The rows with an
 * UNKNOWN movimento are the exception — they never gain the field, so each pass
 * re-writes them with the same values. Deliberate: it keeps the count in front
 * of the operator, and re-writing identical values costs one write each.
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

/**
 * `--report-only`: classify the whole corpus and print counts, writing nothing
 * and logging no per-field rows. This answers the question a dry-run cannot —
 * *what shapes are actually stored?* — and specifically the one number worth
 * knowing before committing to a run: **how many balanços will end up with no
 * recoverable delta**, because those are exactly the rows that will make the ML
 * sweep re-send rather than skip until they age out of every window.
 *
 * Same scan, same cost as a dry-run (see the cost note above) — it just tallies
 * instead of enumerating.
 */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const veredito = new Map<string, number>();
  const motivos = new Map<string, number>();
  const conta = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
  let docsScanned = 0;

  for await (const docs of pagesByDocId(ctx)) {
    for (const doc of docs) {
      docsScanned += 1;
      const v = planHistoricoV2(doc.data(), doc.ref.path);
      conta(veredito, v.kind);
      if (v.kind === 'movimento-desconhecido') conta(motivos, v.motivo);
    }
  }

  const linhas = [
    `[historico-estoque-v2] REPORT — ${docsScanned} linha(s) de historicoEstoque`,
    ...[...veredito.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `  ${k.padEnd(24)} ${String(n).padStart(8)}`),
  ];
  if (motivos.size > 0) {
    linhas.push('  motivos de "movimento-desconhecido":');
    for (const [motivo, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) {
      linhas.push(`    ${String(n).padStart(8)}  ${motivo}`);
    }
  }
  // eslint-disable-next-line no-console -- the report IS the deliverable
  console.log(linhas.join('\n'));

  return { docsScanned, docsChanged: 0 };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.reportOnly) return runReport(ctx);

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
        // Loud in the JSONL as well as in the change log: `movimento` is left
        // ABSENT on these rows, which is how the sweep's fail-open counter sees
        // them — it SENDS rather than skips. Correct, but the operator should
        // know how many there are (`--report-only` counts them up front).
        ctx.sink.skip(doc.ref.path, 'movimento', doc.data().quantidade, verdict.motivo);
      }
      await ctx.writer.update(doc.ref, verdict.patch);
      docsChanged += 1;
    }
  }

  if (semDelta > 0) {
    // eslint-disable-next-line no-console -- operator-facing run summary
    console.log(
      `[historico-estoque-v2] ${semDelta} linha(s) sem delta recuperável — gravadas SEM o campo ` +
        `movimento (fail-open: o sweep envia em vez de pular). Procure "sem" no JSONL, ou rode ` +
        `--report-only para o resumo por motivo.`,
    );
  }

  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  runMigration('historico-estoque-v2', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
