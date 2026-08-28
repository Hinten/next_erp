import {
  FieldPath,
  type CollectionReference,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import {
  FRETE_FIELDS,
  PAGAMENTO_FIELDS,
  PEDIDO_FIELDS,
  buildUpdate,
  transformMetodoPgto,
  transformPagamento,
  transformPedido,
  type DocTransform,
} from './transform';
import { emptyStats, formatReport, record as recordShape, type ShapeStats } from './shapeReport';

/**
 * Backfill: `pedido` / `pagamento` / embedded `frete` / `metodo_pgto` datetime
 * fields → microseconds since epoch. Idempotent (already-µs values are
 * no-ops), dry-run by default. Runbook + rationale:
 * `tools/migrations/pedido-pagamento-micros.README.md`.
 *
 *   pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros \
 *     --project <staging-id>            # dry-run: logs intended changes
 *   pnpm --filter @delfrance/migrations migrate:pedido-pagamento-micros \
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

/** `--report-only`: classify every datetime field, write nothing, print a table. */
async function runReport(ctx: MigrationContext): Promise<MigrationSummary> {
  const porCampo = new Map<string, ShapeStats>();
  const anota = (campo: string, valor: unknown): void => {
    let s = porCampo.get(campo);
    if (!s) porCampo.set(campo, (s = emptyStats()));
    recordShape(s, valor);
  };
  let docsScanned = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('pedidos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const data = doc.data() as Record<string, unknown>;
      for (const f of PEDIDO_FIELDS) anota(`pedido.${f}`, data[f]);

      const frete = data.freteInicial;
      if (frete != null && typeof frete === 'object') {
        const bloco = frete as Record<string, unknown>;
        for (const f of FRETE_FIELDS) anota(`pedido.freteInicial.${f}`, bloco[f]);
      }

      for (const nome of ['pagamento', 'pagamentos'] as const) {
        const pagSnap = await doc.ref.collection(nome).get();
        for (const pag of pagSnap.docs) {
          docsScanned += 1;
          const pagData = pag.data() as Record<string, unknown>;
          for (const f of PAGAMENTO_FIELDS) anota(`${nome}.${f}`, pagData[f]);
        }
      }
    }
  }

  for await (const docs of pagesByDocId(ctx.db.collection('metodo_pgto'))) {
    for (const doc of docs) {
      docsScanned += 1;
      anota('metodo_pgto.dataCadastro', doc.get('dataCadastro'));
    }
  }

  // eslint-disable-next-line no-console
  console.log(formatReport(porCampo));
  return { docsScanned, docsChanged: 0 };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.reportOnly) return runReport(ctx);

  let docsScanned = 0;
  let docsChanged = 0;

  // pedidos (top-level + embedded frete/itens) and each one's pagamento
  // subcollection. The Admin SDK doesn't cascade, so paginate by document id.
  for await (const docs of pagesByDocId(ctx.db.collection('pedidos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const data = doc.data() as Record<string, unknown>;
      if (await applyTransform(ctx, doc.ref, data, transformPedido)) docsChanged += 1;

      // BOTH pagamento subcollections. Legacy Flutter wrote the SINGULAR
      // `pagamento`; this app writes the PLURAL `pagamentos`
      // (`pagamentoMeta.collectionPath`). Walking only one silently skips every
      // document written by the other — and a clean report would then be read as
      // "pagamento datetimes are canonical" when half of them were never looked
      // at. Both are small per-pedido subcollections, so a single get each is fine.
      for (const nome of ['pagamento', 'pagamentos'] as const) {
        const pagSnap = await doc.ref.collection(nome).get();
        for (const pag of pagSnap.docs) {
          docsScanned += 1;
          const pagData = pag.data() as Record<string, unknown>;
          if (await applyTransform(ctx, pag.ref, pagData, transformPagamento)) docsChanged += 1;
        }
      }
    }
  }

  // metodo_pgto (top-level) — paginated too, so a large collection never loads
  // entirely into memory.
  for await (const docs of pagesByDocId(ctx.db.collection('metodo_pgto'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const data = doc.data() as Record<string, unknown>;
      if (await applyTransform(ctx, doc.ref, data, transformMetodoPgto)) docsChanged += 1;
    }
  }

  return { docsScanned, docsChanged };
}

if (isMainModule(import.meta.url)) {
  runMigration('pedido-pagamento-micros', run).catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
}
