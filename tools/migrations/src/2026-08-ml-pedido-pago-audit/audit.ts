import {
  FieldPath,
  type CollectionReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  MigrationArgError,
  type MigrationContext,
  type MigrationSummary,
  isMainModule,
  runMigration,
} from '../runner';
import { auditPedidoPago, type PagamentoResumo, type PagoAuditRow } from './predicate';

/**
 * AUDIT (read-only): Mercado Livre pedidos sitting at `pago` whose APPROVED-only
 * payment sum does not cover `valorCobrado` — the population left behind by the
 * `sumAllValores` defect (#791/O13), which let a REJECTED payment advance a
 * pedido to `pago` and so authorize dispatch and NF-e emission.
 *
 * Run it BEFORE the fix ships, to get a baseline, and again after, to prove
 * `never-covered` did not grow.
 *
 *   pnpm --filter @delfrance/migrations audit:ml-pedido-pago -- --project <id>
 *
 * ## No `--apply`, by construction
 *
 * Advancing a pedido to `pago` is one-way, and un-advancing one is a business
 * decision about a real order — not something a script gets to make in bulk.
 * The flag is rejected rather than ignored, so nobody can assume it worked.
 *
 * ## No index required
 *
 * The walk is a plain `orderBy(documentId())` key-order scan with the filtering
 * done in memory. That is the ONE ordering Firestore always serves without a
 * declared index. The narrower `where('estado','==','pago')` form looks cheaper
 * and is not: Firestore ENTERPRISE never throws `FAILED_PRECONDITION` for a
 * missing index — it silently full-scans and bills data scanned — and making it
 * genuinely indexed needs a NEW composite (`estado ASC, __name__ ASC`, since
 * Enterprise omits the implicit trailing `__name__`), i.e. an index deploy and a
 * build wait, for a one-off read-only report. Do not "optimize" this.
 *
 * ## Both pagamento paths
 *
 * This app writes `pedidos/{id}/pagamentos` (plural); legacy Flutter wrote
 * `pedidos/{id}/pagamento` (singular). Reading only the plural path reports a
 * FALSE POSITIVE on every pedido whose payments came from the Flutter app, so
 * both are read and unioned by pagamento id. Each row records which path its
 * payments came from.
 */

const PAGE_SIZE = 300;

/** `integracao.tipo` for Mercado Livre — see `packages/schemas` `INTEGRACAO_TIPO`. */
const INTEGRACAO_TIPO_MERCADO_LIVRE = 1;

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

/**
 * Every outer-ref that points at a Mercado Livre `integracao`. Read ONCE (there
 * are a handful of accounts), then matched per pedido with a string compare —
 * so identifying ML pedidos costs nothing per document.
 *
 * Both the canonical `documents/integracao/<id>` form and the bare
 * `integracao/<id>` one are accepted: the dual-run corpus contains both.
 */
async function mlIntegracaoRefs(ctx: MigrationContext): Promise<Set<string>> {
  const snap = await ctx.db.collection('integracao').get();
  const refs = new Set<string>();
  for (const doc of snap.docs) {
    if (doc.get('tipo') !== INTEGRACAO_TIPO_MERCADO_LIVRE) continue;
    refs.add(`documents/integracao/${doc.id}`);
    refs.add(`integracao/${doc.id}`);
  }
  return refs;
}

function resumosFrom(
  docs: readonly QueryDocumentSnapshot[],
  fonte: PagamentoResumo['fonte'],
): PagamentoResumo[] {
  return docs.map((d) => ({
    id: typeof d.get('id') === 'string' ? (d.get('id') as string) : d.id,
    valor: typeof d.get('valor') === 'number' ? (d.get('valor') as number) : 0,
    status_pagamento:
      typeof d.get('status_pagamento') === 'number' ? (d.get('status_pagamento') as number) : null,
    fonte,
  }));
}

async function lerPagamentos(doc: QueryDocumentSnapshot): Promise<PagamentoResumo[]> {
  const [plural, singular] = await Promise.all([
    doc.ref.collection('pagamentos').get(),
    doc.ref.collection('pagamento').get(),
  ]);
  const porId = new Map<string, PagamentoResumo>();
  // Plural (this app) wins a collision — it is the path currently written.
  for (const r of resumosFrom(singular.docs, 'pagamento')) porId.set(r.id, r);
  for (const r of resumosFrom(plural.docs, 'pagamentos')) porId.set(r.id, r);
  return [...porId.values()];
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.apply) {
    throw new MigrationArgError(
      'This is an AUDIT, not a migration: it has no --apply path. Advancing a pedido to ' +
        '`pago` is one-way and un-advancing it is a business decision, not a script’s. ' +
        'Read the JSONL under out/ and decide per pedido.',
    );
  }

  const refsMl = await mlIntegracaoRefs(ctx);
  const porKind = new Map<string, number>();
  let docsScanned = 0;
  let docsChanged = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('pedidos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const data = doc.data() as Record<string, unknown>;

      // Cheap filters first: `estado` and ML-ness cost nothing, and only a hit
      // pays for the two subcollection reads below.
      if (data.estado !== 'pago') continue;
      const integracao = data.integracaoPedidoOuterRef;
      if (typeof integracao !== 'string' || !refsMl.has(integracao)) continue;

      const pagamentos = await lerPagamentos(doc);
      const row = auditPedidoPago(doc.ref.path, data, pagamentos);
      if (row == null) continue;

      // Confirmation, on hits only: only the ML import writes `orderML`, so a
      // non-empty mirror is definitional. Its ids make each row a link a human
      // can open in Mercado Livre.
      const orderMl = await doc.ref.collection('orderML').get();
      const orderIds = orderMl.docs.map((d) => d.id);

      docsChanged += 1;
      porKind.set(row.kind, (porKind.get(row.kind) ?? 0) + 1);
      registrar(ctx, row, orderIds);
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[ml-pedido-pago-audit] por kind: ${
      [...porKind.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || 'nenhum'
    }`,
  );
  return { docsScanned, docsChanged };
}

/**
 * One JSONL line per flagged pedido. Uses `sink.change` because the runner's
 * counters and log format are already wired to it — `from`/`to` carry the
 * shortfall rather than an intended write, and this script can never write.
 */
function registrar(ctx: MigrationContext, row: PagoAuditRow, orderIds: readonly string[]): void {
  ctx.sink.change(row.pedidoPath, row.kind, `aprovado=${row.somaAprovada}`, {
    valorCobrado: row.valorCobrado,
    somaAprovada: row.somaAprovada,
    somaTodos: row.somaTodos,
    deficit: row.deficit,
    fonte: row.fonte,
    orderIds,
    ultimaModificacao: row.ultimaModificacao,
    lastMarketplaceUpdate: row.lastMarketplaceUpdate,
    pagamentos: row.pagamentos,
  });
}

if (isMainModule(import.meta.url)) {
  await runMigration('ml-pedido-pago-audit', run);
}

export { run };
