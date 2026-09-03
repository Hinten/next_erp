import {
  FieldPath,
  type DocumentReference,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import { identityValue, idFromRef } from '@delfrance/schemas';
import {
  MigrationArgError,
  type MigrationContext,
  type MigrationSummary,
  isMainModule,
  runMigration,
} from '../runner';
import {
  KINDS_ACIONAVEIS,
  auditPedidoCliente,
  normalizarBuyerId,
  type ForkAuditKind,
  type ForkAuditRow,
} from './predicate';

/**
 * AUDIT (read-only): Mercado Livre pedidos whose linked cliente does not own the
 * buyer's `idMercadoLivre` — the forks left behind by the order import never
 * supplying that key (#1087, fixed forward by #1407).
 *
 *   pnpm --filter @delfrance/migrations audit:ml-cliente-fork --project <id>
 *
 * ## No `--apply`, by construction
 *
 * Repairing a fork means MOVING pedidos, conversas and endereços from one
 * cliente to another. `claimCliente.ts` already calls that "a migration, not a
 * webhook's job", and it is a decision per pair of documents, not one a script
 * makes in bulk from a count. The flag is rejected rather than ignored so nobody
 * can assume it worked.
 *
 * ## No ML API calls
 *
 * `orderMLWire.ts` persists `buyer: { id, … }` into `pedidos/{id}/orderML/{orderId}`,
 * so the whole join is local: the buyer id, the pedido's cliente and the clientes
 * carrying that id are all already in Firestore.
 *
 * ## Why the walk starts at `orderML`, not at `pedidos`
 *
 * ⚠️ **`lastMarketplaceUpdate` is NOT usable as the ML filter here**, even though
 * `pedidoTravadoSweep` uses it at runtime. It has a sole writer
 * (`discoverPedidoMercadoLivre`), so pedidos imported by THIS app carry it — but
 * the migrated legacy corpus does not until its own backfill
 * (`2026-08-ml-lastmarketplaceupdate`) has run, and the legacy rows are precisely
 * the population this audit exists to measure. Filtering on it would report a
 * confident, small, wrong number.
 *
 * A non-empty `orderML` mirror is the definitional test instead (the same one
 * `2026-08-ml-pedido-pago-audit` uses for confirmation), so the walk enumerates
 * the mirror by collection group and reads only those parents. That also means
 * a non-ML pedido is never fetched at all.
 *
 * ## No index required
 *
 * Both walks are plain `orderBy(documentId())` key-order scans — the ONE
 * ordering Firestore always serves without a declared index. On ENTERPRISE a
 * missing index does NOT throw, it silently full-scans and bills data scanned,
 * so a "narrower" filtered query here would be more expensive, not less. Do not
 * "optimize" this into a `where`.
 *
 * ## Memory
 *
 * Two maps are held for the whole run: every cliente's `idMercadoLivre`, and one
 * entry per ML pedido. Both are a couple of short strings per document — tens of
 * MB at hundreds of thousands of rows — and buying them makes the per-pedido
 * work zero-read. A streaming version would trade that for a query per pedido.
 */

const PAGE_SIZE = 300;
/** Documents per `getAll` — Firestore accepts more, this keeps a request small. */
const GET_ALL_CHUNK = 200;

/** Page any query by document id — a stable cursor with bounded memory. */
async function* pagesByDocId(base: Query): AsyncGenerator<QueryDocumentSnapshot[]> {
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = base.orderBy(FieldPath.documentId()).limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    if (snap.empty) return;
    yield snap.docs;
    if (snap.size < PAGE_SIZE) return;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

interface IndiceClientes {
  /** Every cliente id → its stored `idMercadoLivre` (or `null`). */
  readonly idMlPorCliente: Map<string, string | null>;
  /** Every `idMercadoLivre` → the clientes carrying it. Length > 1 is a finding. */
  readonly donosPorIdMl: Map<string, string[]>;
}

/**
 * One pass over `clientes`, building both directions at once.
 *
 * The reverse index is what makes "who else owns this id?" free per pedido; the
 * forward one answers "does the pedido's cliente exist, and what does it carry?"
 * without re-reading the document.
 */
async function indexarClientes(ctx: MigrationContext): Promise<IndiceClientes> {
  const idMlPorCliente = new Map<string, string | null>();
  const donosPorIdMl = new Map<string, string[]>();
  let n = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('clientes'))) {
    for (const doc of docs) {
      n += 1;
      // `identityValue`, not a raw read: `clienteSchema` permits `''` and a
      // soft-parsed row can hand back a number, and the cascade leg queries the
      // trimmed form. Indexing the raw value would invent forks.
      const idMl = identityValue(doc.get('idMercadoLivre'));
      idMlPorCliente.set(doc.id, idMl);
      if (idMl != null) {
        const donos = donosPorIdMl.get(idMl);
        if (donos) donos.push(doc.id);
        else donosPorIdMl.set(idMl, [doc.id]);
      }
    }
  }

  const duplicados = [...donosPorIdMl.values()].filter((d) => d.length > 1).length;
  log(
    `[ml-cliente-fork-audit] clientes=${n} com idMercadoLivre=${donosPorIdMl.size} ` +
      `ids com MAIS DE UM dono=${duplicados}`,
  );
  return { idMlPorCliente, donosPorIdMl };
}

/**
 * Every ML pedido → the raw `buyer.id` values its mirror docs carry.
 *
 * A pack holds several `orderML` documents; they are collected per parent so a
 * pedido is classified once, and so orders naming DIFFERENT buyers surface as
 * `buyers-divergentes` rather than being resolved by picking one.
 */
async function indexarBuyerIds(ctx: MigrationContext): Promise<Map<string, unknown[]>> {
  const porPedido = new Map<string, unknown[]>();
  let mirrors = 0;

  for await (const docs of pagesByDocId(ctx.db.collectionGroup('orderML'))) {
    for (const doc of docs) {
      mirrors += 1;
      const pedidoRef = doc.ref.parent.parent;
      // A collection group reaches every `orderML` anywhere; only the ones under
      // `pedidos` are this audit's subject.
      if (pedidoRef == null || pedidoRef.parent.id !== 'pedidos') continue;
      const buyer = doc.get('buyer') as { id?: unknown } | null | undefined;
      const lista = porPedido.get(pedidoRef.path);
      if (lista) lista.push(buyer?.id ?? null);
      else porPedido.set(pedidoRef.path, [buyer?.id ?? null]);
    }
  }

  log(`[ml-cliente-fork-audit] orderML lidos=${mirrors} pedidos ML=${porPedido.size}`);
  return porPedido;
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.apply) {
    throw new MigrationArgError(
      'This is an AUDIT, not a migration: it has no --apply path. Repairing a fork moves ' +
        'pedidos, conversas and endereços between clientes — a decision per pair of ' +
        'documents, not one a script makes in bulk. Read the JSONL under out/ and decide.',
    );
  }

  const { idMlPorCliente, donosPorIdMl } = await indexarClientes(ctx);
  const buyerIdsPorPedido = await indexarBuyerIds(ctx);

  const porKind = new Map<ForkAuditKind, number>();
  let docsScanned = 0;
  let docsChanged = 0;

  const caminhos = [...buyerIdsPorPedido.keys()];
  for (let i = 0; i < caminhos.length; i += GET_ALL_CHUNK) {
    const fatia = caminhos.slice(i, i + GET_ALL_CHUNK);
    const refs = fatia.map((p) => ctx.db.doc(p) as DocumentReference);
    const snaps = await ctx.db.getAll(...refs);

    for (const snap of snaps) {
      docsScanned += 1;
      const outerRef = snap.get('clientePedidoOuterRef');
      // `idFromRef` takes the LAST segment, so it accepts both the canonical
      // `documents/clientes/<id>` and the bare `clientes/<id>` the legacy corpus
      // also contains.
      const clienteId =
        typeof outerRef === 'string' && outerRef !== '' ? idFromRef(outerRef) : null;
      const buyerIdsBrutos = buyerIdsPorPedido.get(snap.ref.path) ?? [];
      // The classifier re-derives this itself; it is needed one step early only
      // to look the owner list up. A pack whose orders disagree yields `null`,
      // so no owner list is attached to a `buyers-divergentes` row.
      const buyerId = buyerIdUnico(buyerIdsBrutos);

      const row = auditPedidoCliente({
        pedidoPath: snap.ref.path,
        buyerIdsBrutos,
        // ⚠️ `getAll` returns a snapshot for a document that does not exist, and
        // `pedidoMeta`'s cascade over `orderML` is DECLARED BUT NOT ENFORCED —
        // there is no `onPedidoDeleted` trigger, so a deleted pedido leaves its
        // mirror behind on purpose and the collection-group walk still finds it.
        // Without this the orphan reads as `pedido-sem-cliente`, an actionable
        // finding about a pedido that no longer exists.
        pedidoExiste: snap.exists,
        clienteId,
        clienteExiste: clienteId != null && idMlPorCliente.has(clienteId),
        idMlDoCliente: clienteId == null ? null : (idMlPorCliente.get(clienteId) ?? null),
        donosDoBuyerId: buyerId == null ? [] : (donosPorIdMl.get(buyerId) ?? []),
      });

      porKind.set(row.kind, (porKind.get(row.kind) ?? 0) + 1);
      if (KINDS_ACIONAVEIS.includes(row.kind)) {
        docsChanged += 1;
        registrar(ctx, row);
      } else {
        // `ok`, `sem-buyer-id` and `nao-carimbado`: logged as skips so the
        // runner's counters stay meaningful — changes = findings, skips = clean
        // — and so changes + skips reconciles with the ML pedido count above.
        //
        // ⚠️ `nao-carimbado` is on this side deliberately. It is the big benign
        // background population (every ML cliente created before #1407) and it
        // self-heals on that buyer's next import once the fix deploys; counting
        // it as a finding would drown the forks this audit exists to surface.
        // The per-kind tally still reports it, so it is never invisible.
        ctx.sink.skip(row.pedidoPath, row.kind, row.buyerId, 'nada a fazer');
      }
    }
  }

  log(
    `[ml-cliente-fork-audit] por kind: ${
      [...porKind.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || 'nenhum'
    }`,
  );
  return { docsScanned, docsChanged };
}

/**
 * The single normalized buyer id a pedido's mirror docs agree on, or `null` when
 * there is none or they disagree. Routed through the predicate's own
 * `normalizarBuyerId` so the lookup key cannot drift from the classification.
 */
function buyerIdUnico(brutos: readonly unknown[]): string | null {
  const vistos = new Set<string>();
  for (const bruto of brutos) {
    const v = normalizarBuyerId(bruto);
    if (v != null) vistos.add(v);
  }
  return vistos.size === 1 ? [...vistos][0]! : null;
}

/**
 * One JSONL line per finding. Uses `sink.change` because the runner's counters
 * and log format are already wired to it — `from`/`to` carry the verdict rather
 * than an intended write, and this script can never write.
 */
function registrar(ctx: MigrationContext, row: ForkAuditRow): void {
  ctx.sink.change(row.pedidoPath, row.kind, row.buyerId, {
    clienteDoPedido: row.clienteDoPedido,
    idMlDoCliente: row.idMlDoCliente,
    donos: row.donos,
  });
}

if (isMainModule(import.meta.url)) {
  await runMigration('ml-cliente-fork-audit', run);
}

export { run };
