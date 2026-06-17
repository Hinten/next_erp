import {
  FieldPath,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { type MigrationContext, type MigrationSummary, runMigration } from '../runner';
import {
  buildUpdate,
  transformMetodoPgto,
  transformPagamento,
  transformPedido,
  type DocTransform,
} from './transform';

/**
 * Backfill: `pedido` / `pagamento` / embedded `frete` / `metodo_pgto` datetime
 * fields → microseconds since epoch. Idempotent (already-µs values are
 * no-ops), dry-run by default. Runbook + rationale:
 * `tools/migrations/pedido-pagamento-micros.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros -- \
 *     --project <staging-id>            # dry-run: logs intended changes
 *   pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros -- \
 *     --project <staging-id> --apply    # write
 */

const PAGE_SIZE = 300;

const SKIP_REASON = 'undeterminable epoch (ms/µs gap or unparseable) — left as-is';

function record(ctx: MigrationContext, path: string, t: DocTransform): boolean {
  for (const s of t.skips) ctx.sink.skip(path, s.path.join('.'), s.value, SKIP_REASON);
  for (const c of t.changes) ctx.sink.change(path, c.path.join('.'), c.from, c.to);
  return t.changes.length > 0;
}

async function applyTransform(
  ctx: MigrationContext,
  ref: DocumentReference,
  data: Record<string, unknown>,
  transform: (d: Record<string, unknown>) => DocTransform,
): Promise<boolean> {
  const t = transform(data);
  const changed = record(ctx, ref.path, t);
  if (changed) await ctx.writer.update(ref, buildUpdate(t.changes));
  return changed;
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  let docsScanned = 0;
  let docsChanged = 0;

  // pedidos (top-level + embedded frete/itens) and each one's pagamento
  // subcollection. The Admin SDK doesn't cascade, so paginate by document id.
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db.collection('pedidos').orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) break;

    for (const doc of snap.docs) {
      docsScanned += 1;
      if (
        await applyTransform(ctx, doc.ref, doc.data() as Record<string, unknown>, transformPedido)
      ) {
        docsChanged += 1;
      }
      const pagSnap = await doc.ref.collection('pagamento').get();
      for (const pag of pagSnap.docs) {
        docsScanned += 1;
        const data = pag.data() as Record<string, unknown>;
        if (await applyTransform(ctx, pag.ref, data, transformPagamento)) docsChanged += 1;
      }
    }

    cursor = snap.docs[snap.docs.length - 1];
    if (snap.size < PAGE_SIZE) break;
  }

  // metodo_pgto (top-level)
  const mp = await ctx.db.collection('metodo_pgto').get();
  for (const doc of mp.docs) {
    docsScanned += 1;
    const data = doc.data() as Record<string, unknown>;
    if (await applyTransform(ctx, doc.ref, data, transformMetodoPgto)) docsChanged += 1;
  }

  return { docsScanned, docsChanged };
}

const isDirectInvocation =
  process.argv[1]?.endsWith('migrate.ts') === true ||
  process.argv[1]?.endsWith('migrate.js') === true;

if (isDirectInvocation) {
  runMigration('pedido-pagamento-micros', run).catch((err: unknown) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exitCode = 1;
  });
}
