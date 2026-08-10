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
import { auditarReservaNegativa, type HistoricoResumo, type ReservaNegativaRow } from './predicate';

/**
 * AUDIT (read-only): estoque documents holding a NEGATIVE
 * `quantidadeReservada` — #931.
 *
 *   pnpm --filter @delfrance/migrations audit:estoque-reservada-negativa -- --project <id>
 *
 * ## Why
 *
 * `disponivel = quantidade − quantidadeReservada`, so a negative reservation
 * *increases* availability — `8 − (−2) = 10`, two units that do not exist —
 * which is the one failure direction that oversells on Mercado Livre. #925
 * floored it inside `estoqueDisponivel` and #931 floored the two ML-import sites
 * doing their own arithmetic, so such a row is harmless to availability TODAY.
 * It is still a real data defect, and nothing had ever looked for one. This
 * finds them and attributes each to a writer via its `historicoEstoque`.
 *
 * ## No `--apply`, by construction
 *
 * Correcting a stock counter is a business decision about real inventory, not
 * something a script gets to make in bulk — and per root `CLAUDE.md` rule 8 a
 * bulk write against production data belongs in the coordinated cutover window.
 * The flag is REJECTED rather than ignored, so nobody can assume it worked.
 *
 * ## No index required
 *
 * The walk is a plain `orderBy(documentId())` key-order scan with the `< 0` test
 * done in memory. That is the ONE ordering Firestore always serves without a
 * declared index. `where('quantidadeReservada','<',0)` looks cheaper and is not:
 * on Firestore ENTERPRISE an undeclared range filter never throws
 * `FAILED_PRECONDITION` — it silently full-scans and bills data scanned — and on
 * STANDARD, where production still lives (rule 8), it throws and demands a new
 * composite. Either way it costs an index deploy and a build wait for a one-off
 * read-only report. Do not "optimize" this.
 *
 * Only a document that actually holds a negative pays for the `historicoEstoque`
 * read below.
 *
 * ## Two walk shapes
 *
 * Default is a `collectionGroup('estoques')` key-order scan. If a target project
 * refuses to serve it unindexed, pass `--target produtos` for the fallback: walk
 * `produtos` by document id and read each one's `estoques` subcollection. Same
 * report, more round trips. The flag exists so the fallback is a runtime choice
 * rather than a code edit mid-incident.
 */

const PAGE_SIZE = 300;

/** Page any collection/collection-group by document id — stable cursor, bounded memory. */
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

/**
 * The estoque's ledger, reduced to what the classification needs.
 *
 * ⚠️ `Object.hasOwn` before reading each value, NOT `?? null`. An ABSENT
 * `movimentoReservada` is the v1 (Flutter) shape and the wire encoding of
 * "unknown" that ADR 0014 §4 rests on; collapsing it to `null` would make an
 * unsummable v1 trail look like a v2 one that recorded a zero, and the row would
 * be classified as reconciling when it cannot be.
 */
async function lerHistorico(estoque: QueryDocumentSnapshot): Promise<HistoricoResumo[]> {
  const snap = await estoque.ref.collection('historicoEstoque').get();
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const ler = (campo: string): unknown => (Object.hasOwn(data, campo) ? data[campo] : undefined);
    return {
      movimentoReservada: ler('movimentoReservada') as number | null | undefined,
      saldoReservada: ler('saldoReservada') as number | null | undefined,
      timestamp: ler('timestamp') as number | null | undefined,
      tipo: ler('tipo') as string | null | undefined,
      motivo: ler('motivo') as string | null | undefined,
    };
  });
}

/** Every estoque document in the project, whichever walk shape was selected. */
async function* todosOsEstoques(ctx: MigrationContext): AsyncGenerator<QueryDocumentSnapshot[]> {
  if (!ctx.args.targets.includes('produtos')) {
    yield* pagesByDocId(ctx.db.collectionGroup('estoques'));
    return;
  }
  // Fallback: produtos by key order, then each one's subcollection. More round
  // trips, but it needs nothing beyond the native document-key ordering on a
  // plain collection.
  const produtos = ctx.db.collection('produtos') as CollectionReference;
  for await (const docs of pagesByDocId(produtos)) {
    for (const produto of docs) {
      const estoques = await produto.ref.collection('estoques').get();
      if (!estoques.empty) yield estoques.docs;
    }
  }
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.apply) {
    throw new MigrationArgError(
      'This is an AUDIT, not a migration: it has no --apply path. Correcting a stock ' +
        'counter is a decision about real inventory, and per root CLAUDE.md rule 8 a bulk ' +
        'write against production belongs in the coordinated cutover window. Read the JSONL ' +
        'under out/ and decide per document.',
    );
  }

  const porKind = new Map<string, number>();
  let docsScanned = 0;
  let docsChanged = 0;
  let unidadesInventadas = 0;

  for await (const docs of todosOsEstoques(ctx)) {
    for (const doc of docs) {
      docsScanned += 1;
      const data = doc.data() as Record<string, unknown>;

      // Cheap in-memory filter first: only a real hit pays for the ledger read.
      const reservada = data.quantidadeReservada;
      if (typeof reservada !== 'number' || !Number.isFinite(reservada) || reservada >= 0) continue;

      const historico = await lerHistorico(doc);
      const row = auditarReservaNegativa(doc.ref.path, data, historico);
      if (row == null) continue;

      docsChanged += 1;
      unidadesInventadas += row.unidadesInventadas;
      porKind.set(row.kind, (porKind.get(row.kind) ?? 0) + 1);
      registrar(ctx, row);
    }
  }

  /* eslint-disable no-console */
  console.log(
    `[estoque-reservada-negativa] por kind: ${
      [...porKind.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || 'nenhum'
    }`,
  );
  console.log(
    `[estoque-reservada-negativa] unidades que teriam sido inventadas sem o piso: ${unidadesInventadas}`,
  );
  /* eslint-enable no-console */

  return { docsScanned, docsChanged };
}

/**
 * One JSONL line per flagged estoque. Uses `sink.change` because the runner's
 * counters and log format are already wired to it — `from` carries the stored
 * counter and `to` the forensic payload, rather than an intended write, since
 * this script can never write.
 */
function registrar(ctx: MigrationContext, row: ReservaNegativaRow): void {
  ctx.sink.change(row.estoquePath, row.kind, `reservada=${row.quantidadeReservada}`, {
    quantidade: row.quantidade,
    quantidadeReservada: row.quantidadeReservada,
    disponivelIngenuo: row.disponivelIngenuo,
    disponivelFloored: row.disponivelFloored,
    unidadesInventadas: row.unidadesInventadas,
    parentId: row.parentId,
    depositoOuterRef: row.depositoOuterRef,
    ultimaModificacao: row.ultimaModificacao,
    somaMovimentoReservada: row.somaMovimentoReservada,
    nLinhas: row.nLinhas,
    nSemMovimentoReservada: row.nSemMovimentoReservada,
    ultimasLinhas: row.ultimasLinhas,
  });
}

if (isMainModule(import.meta.url)) {
  await runMigration('estoque-reservada-negativa', run);
}

export { run };
