import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { impostoCategoriaSchema, regraImpostoSchema } from '@delfrance/schemas';
import type { ZodType } from 'zod';
import { runMigration, type MigrationContext, type MigrationSummary } from '../runner';
import {
  LEGACY_CATEGORIA_TAX_SUBCOLL,
  LEGACY_REGRA_SUBCOLL,
  NEW_CATEGORIA_TAX_SUBCOLL,
  NEW_REGRA_SUBCOLL,
  translateLegacyImpostoCategoria,
  translateLegacyRegra,
  type TranslationResult,
} from './transform';

/**
 * Copy + translate the legacy Flutter tax-config docs into the subcollections
 * the new imposto resolver reads (#398):
 *
 *   categorias/{id}/imposto/*   → categorias/{id}/impostocategoria/*
 *   operacao/{id}/regras/*      → operacao/{id}/regraimposto/*
 *
 * COPY, not move — the legacy Flutter app keeps reading its own paths until
 * it is decommissioned. Idempotent: a target doc that already exists (same
 * doc id) is never overwritten, so re-runs are safe and docs created/edited
 * via the new tax editor are protected. Docs the legacy app writes AFTER a
 * run stay invisible to the resolver until the migration is re-run — see the
 * runbook (`tools/migrations/imposto-legacy-names.README.md`).
 *
 * `produtos/{id}/imposto` is deliberately untouched: the new resolver already
 * reads that subcollection in its legacy shape (typo scope key included).
 *
 *   pnpm --filter @delfrance/migrations migrate:imposto-legacy-names -- \
 *     --project <staging-id>            # dry-run: logs intended copies
 *   pnpm --filter @delfrance/migrations migrate:imposto-legacy-names -- \
 *     --project <staging-id> --apply    # write
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

interface SubcollJob {
  /** Top-level collection whose docs parent the legacy subcollection. */
  readonly parentColl: string;
  readonly legacySubcoll: string;
  readonly newSubcoll: string;
  readonly translate: (raw: Record<string, unknown>) => TranslationResult;
  /** New-shape schema the translated doc must satisfy before writing. */
  readonly schema: ZodType;
}

const JOBS: readonly SubcollJob[] = [
  {
    parentColl: 'categorias',
    legacySubcoll: LEGACY_CATEGORIA_TAX_SUBCOLL,
    newSubcoll: NEW_CATEGORIA_TAX_SUBCOLL,
    translate: translateLegacyImpostoCategoria,
    schema: impostoCategoriaSchema,
  },
  {
    parentColl: 'operacao',
    legacySubcoll: LEGACY_REGRA_SUBCOLL,
    newSubcoll: NEW_REGRA_SUBCOLL,
    translate: translateLegacyRegra,
    schema: regraImpostoSchema,
  },
];

async function runJob(ctx: MigrationContext, job: SubcollJob): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  // NO collectionGroup here: the legacy categoria subcollection is named
  // 'imposto', which would also match produtos/{id}/imposto (already in the
  // shape the resolver reads). Iterate parents instead.
  for await (const parents of pagesByDocId(ctx.db.collection(job.parentColl))) {
    for (const parent of parents) {
      const legacySnap = await parent.ref.collection(job.legacySubcoll).get();
      for (const legacyDoc of legacySnap.docs) {
        docsScanned += 1;
        const legacyPath = legacyDoc.ref.path;
        const { doc, notes, drops } = job.translate(legacyDoc.data() as Record<string, unknown>);
        for (const n of notes) ctx.sink.change(legacyPath, n.field, n.from, n.to);
        for (const d of drops) ctx.sink.skip(legacyPath, d.field, d.value, d.reason);

        const parsed = job.schema.safeParse({ id: legacyDoc.id, ...doc });
        if (!parsed.success) {
          const first = parsed.error.issues[0];
          ctx.sink.skip(
            legacyPath,
            first?.path.map(String).join('.') || '(root)',
            undefined,
            `translated doc still fails ${job.newSubcoll} schema: ${first?.message ?? 'parse failed'} — fix the legacy doc and re-run`,
          );
          continue;
        }

        const target = parent.ref.collection(job.newSubcoll).doc(legacyDoc.id);
        const existing = await target.get();
        if (existing.exists) {
          ctx.sink.skip(
            target.path,
            '(doc)',
            undefined,
            'target already exists — not overwritten (new-name doc wins)',
          );
          continue;
        }

        // Write the schema output (defaults applied, unknown legacy keys
        // stripped) minus the read-side `id` injection — the doc id is the
        // Firestore key, not a body field.
        const body = { ...(parsed.data as Record<string, unknown>) };
        delete body.id;
        ctx.sink.change(target.path, '(doc)', null, `copied from ${legacyPath}`);
        await ctx.writer.set(target, body);
        docsChanged += 1;
      }
    }
  }

  return { docsScanned, docsChanged };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;
  for (const job of JOBS) {
    const s = await runJob(ctx, job);
    docsScanned += s.docsScanned;
    docsChanged += s.docsChanged;
  }
  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('imposto-legacy-names', run).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
