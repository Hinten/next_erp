import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { coerceToMicros, coerceToMillis, millisToMicros } from '@delfrance/core/datetime';
import {
  type MigrationContext,
  type MigrationSummary,
  isMainModule,
  runMigration,
} from '../runner';

/**
 * Backfill `pedido.lastMarketplaceUpdate` with the TRUE Mercado Livre order
 * clock, seeded from the pedido's `orderML` mirror children.
 *
 *   pnpm --filter @delfrance/migrations migrate:ml-lastmarketplaceupdate -- --project <id>
 *   pnpm --filter @delfrance/migrations migrate:ml-lastmarketplaceupdate -- --project <id> --apply
 *
 * ## Why this is MANDATORY, not optional
 *
 * `lastMarketplaceUpdate` was created to be the marketplace event-clock
 * watermark, but ten of its twelve write sites stamped it with `nowUs` — a WALL
 * CLOCK, which is by construction LATER than the `order.last_updated` it was
 * supposed to hold (ML stamps when the order changed; we stamped when we
 * processed it). #791 makes the field truthful going forward and starts reading
 * it as the guard on the estado downgrade, so the polluted historic values have
 * to be corrected or a late-delivered `cancelled` payload is dropped for any
 * pedido whose stored value is still a wall clock.
 *
 * ## Why `orderML` is the right source
 *
 * `orderML/{orderId}.last_updated` is the ML order clock, per order, with only
 * the import as its writer, and it is already stored for every pedido this app
 * has imported. This is the last useful job that collection does before it can
 * be retired.
 *
 * ## Ordering
 *
 * Run this AFTER deploying the fixed functions, never before: the old code is
 * still re-polluting the field until it is replaced, and this backfill only ever
 * LOWERS a polluted value, so anything dropped in the meantime is unblocked on
 * its next delivery.
 *
 * Idempotent: a pedido already carrying the max of its mirrors is left alone.
 * Needs no index — a plain `orderBy(documentId())` key-order scan (see the audit
 * script for why the narrower query would be worse on Firestore Enterprise).
 */

const PAGE_SIZE = 300;

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
 * The max `orderML.last_updated` across a pedido's mirrors, in MICROSECONDS.
 *
 * The mirror schema declares MILLISECONDS, so read with `coerceToMillis` and
 * scale — reading it as µs directly would be wrong by 1000x. `null` when the
 * pedido has no mirror (not an ML pedido, or one imported before the mirror
 * existed): nothing to seed from, so it is left untouched.
 */
async function relogioDoPedido(doc: QueryDocumentSnapshot): Promise<number | null> {
  const snap = await doc.ref.collection('orderML').get();
  let maiorMs: number | null = null;
  for (const m of snap.docs) {
    const ms = coerceToMillis(m.get('last_updated'));
    if (ms == null) continue;
    if (maiorMs == null || ms > maiorMs) maiorMs = ms;
  }
  return maiorMs == null ? null : millisToMicros(maiorMs);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('pedidos'))) {
    for (const doc of docs) {
      docsScanned += 1;

      const alvoUs = await relogioDoPedido(doc);
      if (alvoUs == null) continue;

      const armazenadoUs = coerceToMicros(doc.get('lastMarketplaceUpdate'));
      if (armazenadoUs === alvoUs) continue;

      if (armazenadoUs != null && armazenadoUs < alvoUs) {
        // Already BELOW the true clock — that is not the pollution this fixes
        // (a wall clock runs ahead), so raising it could hide a genuinely stale
        // payload. Record it and move on rather than guessing.
        ctx.sink.skip(
          doc.ref.path,
          'lastMarketplaceUpdate',
          armazenadoUs,
          `stored is OLDER than the orderML max (${alvoUs}) — not wall-clock pollution, left as-is`,
        );
        continue;
      }

      ctx.sink.change(doc.ref.path, 'lastMarketplaceUpdate', armazenadoUs, alvoUs);
      docsChanged += 1;
      await ctx.writer.update(doc.ref, { lastMarketplaceUpdate: alvoUs });
    }
  }

  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  await runMigration('ml-lastmarketplaceupdate', run);
}

export { run };
