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
import {
  entraNaContagem,
  montarLinhaDaContagem,
  resumirContagem,
  type FilhoContado,
  type LinhaDaContagem,
  type ProdutoContado,
  type VinculosDoProduto,
} from './predicate';

/**
 * AUDIT (read-only): the L7 CONTAGEM of Shopee step 19 (#1527) — every produto
 * whose stored `ehKitVirtual` is `true`, split by whether it carries a Mercado
 * Livre link, for Lucas to review at the cutover BEFORE production `apps/shopee`
 * serves a `--live` publish. The why is in `predicate.ts`.
 *
 *   pnpm --filter @delfrance/migrations audit:kit-virtual-contagem --project <id>
 *
 * ## No `--apply`, by construction
 *
 * Nothing is flipped by a script. Lucas reads the list and decides produto by
 * produto (switch the flag off on the produto screen, or keep it). The flag is
 * REJECTED rather than ignored, so nobody can assume it worked. There is no write
 * path in this file at all — no `writer`, no `set`, no `update`.
 *
 * ## No index required
 *
 * The walk is a plain `orderBy(documentId())` key-order scan of `produtos` with
 * the `ehKitVirtual === true` test done in memory — the `2026-08-ml-pedido-pago-audit`
 * shape, and the ONE ordering Firestore always serves without a declared index.
 * `where('ehKitVirtual','==',true)` looks cheaper and is not: Firestore ENTERPRISE
 * never throws for a missing index, it silently full-scans and bills data scanned,
 * and indexing it would need a NEW composite for a one-off report.
 *
 * Per counted row: FOUR reads of its own subcollections, each `limit(1)` and
 * unfiltered (`produtoMercadoLivre`, `variacaoMercadoLivre`, `prodshopee`,
 * `variashopee` — both kinds, because a mirrored família-de-um member holds the
 * variation kinds); plus the children query, which is NEITHER: a top-level
 * `produtos where('paiId','==',<id>)` with no `limit`, because every child must
 * be asked; then ONE `variacaoMercadoLivre` `limit(1)` per child — 5 + F reads,
 * F being the number of children (the README's "Cost"). The children query is
 * the shape the app already runs (`resolveProduto.ts`, `receitaKitShopee.ts`) on
 * the declared `produtos (paiId, …)` composites. Only a counted row pays for any
 * of it; every other produto costs its share of the key-order scan.
 */

const PAGE_SIZE = 300;

/** The runner's log name — the JSONL lands at `out/<stamp>-kit-virtual-contagem-dryrun.jsonl`. */
export const NOME_DA_CONTAGEM = 'kit-virtual-contagem';

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

/** Whether a subcollection holds at least one document — one `limit(1)` read. */
async function temDocumento(ctx: MigrationContext, caminho: string): Promise<boolean> {
  const snap = await ctx.db.collection(caminho).limit(1).get();
  return !snap.empty;
}

async function lerVinculosDoProduto(
  ctx: MigrationContext,
  produtoId: string,
): Promise<VinculosDoProduto> {
  const base = `produtos/${produtoId}`;
  const [produtoMercadoLivre, variacaoMercadoLivre, prodshopee, variashopee] = await Promise.all([
    temDocumento(ctx, `${base}/produtoMercadoLivre`),
    temDocumento(ctx, `${base}/variacaoMercadoLivre`),
    temDocumento(ctx, `${base}/prodshopee`),
    temDocumento(ctx, `${base}/variashopee`),
  ]);
  return { produtoMercadoLivre, variacaoMercadoLivre, prodshopee, variashopee };
}

/** Every child of `produtoId`, each with its own `variacaoMercadoLivre` probe. */
async function lerFilhos(ctx: MigrationContext, produtoId: string): Promise<FilhoContado[]> {
  const snap = await ctx.db.collection('produtos').where('paiId', '==', produtoId).get();
  const filhos: FilhoContado[] = [];
  // One probe per child, in order: a family holds at most a handful (a Shopee kit
  // takes ≤ 9), so there is nothing to gain from fanning out.
  for (const doc of snap.docs) {
    filhos.push({
      id: doc.id,
      variacaoMercadoLivre: await temDocumento(ctx, `produtos/${doc.id}/variacaoMercadoLivre`),
    });
  }
  return filhos;
}

function lerProduto(doc: QueryDocumentSnapshot): ProdutoContado {
  const data = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    paiId: data.paiId,
    ehKit: data.ehKit,
    ehKitVirtual: data.ehKitVirtual,
    componentesKit: data.componentesKit,
  };
}

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.apply) {
    throw new MigrationArgError(
      'This is a read-only CONTAGEM, not a migration: it has no --apply path. Lucas reviews ' +
        'the list and decides produto by produto on the produto screen — there is no backfill ' +
        '(Shopee step 19, L7). Read the JSONL under out/.',
    );
  }

  const linhas: LinhaDaContagem[] = [];
  let docsScanned = 0;

  for await (const docs of pagesByDocId(ctx.db.collection('produtos'))) {
    for (const doc of docs) {
      docsScanned += 1;
      const produto = lerProduto(doc);
      // The cheap in-memory filter first: only a counted row pays for its reads.
      if (!entraNaContagem(produto)) continue;

      const [vinculos, filhos] = await Promise.all([
        lerVinculosDoProduto(ctx, produto.id),
        lerFilhos(ctx, produto.id),
      ]);
      const linha = montarLinhaDaContagem(produto, vinculos, filhos);
      linhas.push(linha);
      registrar(ctx, `produtos/${produto.id}`, linha);
    }
  }

  const resumo = resumirContagem(linhas);
  log(
    `[${NOME_DA_CONTAGEM}] ehKitVirtual === true: ${resumo.total} produto(s) — ` +
      `comMercadoLivre=${resumo.comMercadoLivre}, semMercadoLivre=${resumo.semMercadoLivre}`,
  );
  log(
    `[${NOME_DA_CONTAGEM}] ehKit !== true: ${resumo.semEhKit} (a publicação Shopee recusa ` +
      '`kit-virtual-sem-kit` e a tela do produto desliga o flag no próximo salvar)',
  );
  log(
    `[${NOME_DA_CONTAGEM}] comShopee=${resumo.comShopee}; filhos (paiId preenchido)=${resumo.filhos} ` +
      '— um membro de família de um espelha o flag do pai e nunca é publicado sozinho',
  );
  log(`[${NOME_DA_CONTAGEM}] somente leitura: nenhum documento foi alterado.`);

  return { docsScanned, docsChanged: linhas.length };
}

/**
 * One JSONL line per counted produto. Uses `sink.change` because the runner's
 * counters and log format are already wired to it — `field` carries the split
 * (`com-mercado-livre` / `sem-mercado-livre`, so the file greps by it), `from` is
 * `null` and `to` is the row, since this script can never write. Same shape as the
 * #931 and #1402 audits.
 */
function registrar(ctx: MigrationContext, caminho: string, linha: LinhaDaContagem): void {
  ctx.sink.change(
    caminho,
    linha.comMercadoLivre ? 'com-mercado-livre' : 'sem-mercado-livre',
    null,
    linha,
  );
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DA_CONTAGEM, run);
}

export { run };
