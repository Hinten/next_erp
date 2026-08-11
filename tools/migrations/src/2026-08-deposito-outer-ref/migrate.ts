import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import { planDepositoOuterRef } from './transform';

/**
 * Normalize every stored `depositoOuterRef` to the canonical
 * `documents/depositos/<id>` form. See `transform.ts` for the encodings and for
 * why an unrecognized ref is reported rather than rewritten.
 *
 *   pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- \
 *     --project <project-id> --report-only  # pre-flight: counts the stored forms
 *   pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- \
 *     --project <project-id>            # dry-run: logs every doc it would touch
 *   pnpm --filter @delfrance/migrations migrate:deposito-outer-ref -- \
 *     --project <project-id> --apply    # write
 *
 * Run `--report-only` FIRST. A dry-run enumerates documents; the number that
 * decides whether this is worth a window slot is *how many docs are actually in
 * the bare form*, per collection — and whether any `desconhecido` exists, since
 * those need a human before anything is written.
 *
 * ---- ⚠️ WHEN. Inside the cutover window (root `CLAUDE.md` rule 8 / ADR 0013),
 * and **after** the historicoEstoque v1 → v2 pass (#933). Two reasons, in order:
 * the Flutter app is still writing, so an earlier run is partially undone by
 * every write that lands after it; and the v2 pass itself authors canonical
 * `depositoOuterRef` values on the rows it converts, so running it first leaves
 * this pass strictly less to do. Running early is not harmful — the pass is
 * idempotent — it is simply not finished.
 *
 * ---- ⚠️ This normalizes DATA ONLY. Nothing in the read path is narrowed by it:
 * the sweep's two-form disjunction and its accumulate-don't-overwrite aggregate
 * stay exactly as they are, because Flutter keeps writing until it is
 * decommissioned. Tightening readers to a single encoding is a separate,
 * post-cutover question (#836).
 *
 * ---- Cost, honestly: two collection-group scans plus one root-collection scan,
 * and Firestore Enterprise bills DATA SCANNED. Paged by document key —
 * Firestore's always-available native ordering, so no index is needed — with
 * every decision made in code on the fetched page. A `where` on the field could
 * not narrow it: the values that need changing are the ones NOT equal to a
 * canonical value, and Firestore has no "not prefix" predicate.
 */

const PAGE_SIZE = 300;

/** The three collections carrying the field, in scan order. */
const ALVOS = [
  { nome: 'estoques', escopo: 'grupo' },
  { nome: 'historicoEstoque', escopo: 'grupo' },
  { nome: 'integracao', escopo: 'raiz' },
] as const;

type Alvo = (typeof ALVOS)[number];

/**
 * Page one target by document key. The two subcollections need a collection
 * GROUP scan (their docs live two and four levels deep, with no other way to
 * reach them all); `integracao` is a root collection.
 */
async function* pagesByDocId(
  ctx: MigrationContext,
  alvo: Alvo,
): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    const base =
      alvo.escopo === 'grupo' ? ctx.db.collectionGroup(alvo.nome) : ctx.db.collection(alvo.nome);
    let q: Query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

/**
 * `--report-only`: classify everything and print counts per collection, writing
 * nothing and logging no per-field rows. This answers what a dry-run cannot —
 * *which encodings are actually stored, and where* — and surfaces any
 * `desconhecido` up front, which is the one verdict that needs a decision before
 * an `--apply` run rather than after it.
 */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const linhas = ['[deposito-outer-ref] REPORT'];
  let docsScanned = 0;

  for (const alvo of ALVOS) {
    const veredito = new Map<string, number>();
    const motivos = new Map<string, number>();
    const conta = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);
    let doAlvo = 0;

    for await (const docs of pagesByDocId(ctx, alvo)) {
      for (const doc of docs) {
        doAlvo += 1;
        docsScanned += 1;
        const v = planDepositoOuterRef(doc.data().depositoOuterRef);
        conta(veredito, v.kind);
        if (v.kind === 'desconhecido') conta(motivos, v.motivo);
      }
    }

    linhas.push(`  ${alvo.nome} (${alvo.escopo}) — ${doAlvo} documento(s)`);
    for (const [k, n] of [...veredito.entries()].sort((a, b) => b[1] - a[1])) {
      linhas.push(`    ${k.padEnd(16)} ${String(n).padStart(8)}`);
    }
    for (const [motivo, n] of [...motivos.entries()].sort((a, b) => b[1] - a[1])) {
      linhas.push(`      desconhecido: ${String(n).padStart(6)}  ${motivo}`);
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
  let desconhecidos = 0;

  for (const alvo of ALVOS) {
    for await (const docs of pagesByDocId(ctx, alvo)) {
      for (const doc of docs) {
        docsScanned += 1;
        const verdict = planDepositoOuterRef(doc.data().depositoOuterRef);

        if (verdict.kind === 'ja-canonico' || verdict.kind === 'ausente') continue;

        if (verdict.kind === 'desconhecido') {
          // Left exactly as found. A ref pointing somewhere unexpected is a data
          // problem to look at, not one to paper over with a guessed rewrite.
          desconhecidos += 1;
          ctx.sink.skip(doc.ref.path, 'depositoOuterRef', verdict.valor, verdict.motivo);
          continue;
        }

        ctx.sink.change(doc.ref.path, 'depositoOuterRef', verdict.de, verdict.para);
        await ctx.writer.update(doc.ref, { depositoOuterRef: verdict.para });
        docsChanged += 1;
      }
    }
  }

  if (desconhecidos > 0) {
    // eslint-disable-next-line no-console -- operator-facing run summary
    console.log(
      `[deposito-outer-ref] ${desconhecidos} documento(s) com depositoOuterRef fora das duas ` +
        `formas aceitas — NÃO alterados. Procure "skip" no JSONL, ou rode --report-only para o ` +
        `resumo por motivo. Cada um precisa de decisão humana.`,
    );
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('deposito-outer-ref', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
