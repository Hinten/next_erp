import {
  FieldPath,
  type CollectionReference,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import { type EnderecoLike, decideCodigoMunicipio } from './transform';

/**
 * Backfill: `endereco.codigoMunicipio` (IBGE) from the endereço's CEP, using
 * the offline CEP-range table (#785).
 *
 * Idempotent (an already-valid código is a no-op), dry-run by default. Runbook:
 * `tools/migrations/endereco-cmun.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:endereco-cmun -- \
 *     --project <staging-id>            # dry-run: logs intended changes
 *   pnpm --filter @delfrance/migrations migrate:endereco-cmun -- \
 *     --project <staging-id> --apply    # write
 *
 * ⚠️ Run this only AFTER the table is vendored
 * (`pnpm --filter @delfrance/cmun-table vendor`). Against the unvendored
 * placeholder every row resolves to nothing and the run is a very expensive
 * no-op.
 */

const PAGE_SIZE = 300;

/**
 * Page a collection by document id — a stable cursor with bounded memory.
 *
 * ⚠️ `enderecos` is a SUBCOLLECTION, and this migration deliberately walks it
 * per-cliente rather than with `collectionGroup('enderecos')`. Two reasons:
 *
 *  1. On Firestore Enterprise a collection-group scan ordered only by
 *     `__name__` cannot be indexed at all (index entries are real field paths,
 *     and Enterprise omits the implicit trailing `__name__`), so it silently
 *     full-scans and bills bytes scanned. That exact shape was 93% of staging
 *     reads once already (PR #737).
 *  2. Narrowing it with `where('codigoMunicipio','==',null)` would be UNSOUND:
 *     Firestore's `== null` matches explicit nulls but NOT absent fields, so it
 *     would silently skip the oldest Flutter-written docs — precisely the ones
 *     that need the backfill.
 */
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

/**
 * Apply the decision to one endereço, embedded or standalone.
 *
 * `fieldPath` is the DOTTED leaf (`'codigoMunicipio'`,
 * `'sede.codigoMunicipio'`, `'enderecoDeOrigem.codigoMunicipio'`) so an
 * embedded endereço is patched without rewriting the whole map — which would
 * clobber a concurrent edit to `filiais` / `int_frete`, both human-managed.
 */
async function applyToEndereco(
  ctx: MigrationContext,
  ref: DocumentReference,
  endereco: EnderecoLike | null | undefined,
  fieldPath: string,
): Promise<boolean> {
  if (endereco == null || typeof endereco !== 'object') return false;

  const outcome = decideCodigoMunicipio(endereco);
  if (outcome.kind === 'ok') return false;
  if (outcome.kind === 'skip') {
    ctx.sink.skip(ref.path, fieldPath, endereco.codigoMunicipio ?? null, outcome.reason);
    return false;
  }

  ctx.sink.change(ref.path, fieldPath, endereco.codigoMunicipio ?? null, outcome.codigoMunicipio);
  await ctx.writer.update(ref, { [fieldPath]: outcome.codigoMunicipio });
  return true;
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  // 1. filiais.sede — a handful of docs, but this one gates `ide.cMunFG` on
  //    EVERY NF-e, so it matters most.
  for await (const docs of pagesByDocId(ctx.db.collection('filiais'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const sede = (doc.data() as { sede?: EnderecoLike }).sede;
      if (await applyToEndereco(ctx, doc.ref, sede, 'sede.codigoMunicipio')) docsChanged += 1;
    }
  }

  // 2. int_frete.enderecoDeOrigem — also a handful; keeps the three places
  //    `enderecoSchema` is embedded consistent.
  for await (const docs of pagesByDocId(ctx.db.collection('int_frete'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const origem = (doc.data() as { enderecoDeOrigem?: EnderecoLike | null }).enderecoDeOrigem;
      if (await applyToEndereco(ctx, doc.ref, origem, 'enderecoDeOrigem.codigoMunicipio')) {
        docsChanged += 1;
      }
    }
  }

  // 3. clientes/{id}/enderecos — the bulk, and the Mercado Livre rows. See
  //    `pagesByDocId`'s note for why this descends per-cliente.
  for await (const docs of pagesByDocId(ctx.db.collection('clientes'))) {
    for (const cliente of docs) {
      // Unfiltered read of one cliente's endereços — a handful of docs each,
      // no `where`/`orderBy`, so no index is involved.
      const enderecos = await cliente.ref.collection('enderecos').get();
      for (const endereco of enderecos.docs) {
        docsScanned += 1;
        const data = endereco.data() as EnderecoLike;
        if (await applyToEndereco(ctx, endereco.ref, data, 'codigoMunicipio')) docsChanged += 1;
      }
    }
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('endereco-cmun', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
