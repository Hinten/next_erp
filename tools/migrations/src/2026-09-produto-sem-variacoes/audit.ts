import { FieldPath, type Query, type QueryDocumentSnapshot } from 'firebase-admin/firestore';
import {
  MigrationArgError,
  type MigrationContext,
  type MigrationSummary,
  isMainModule,
  runMigration,
} from '../runner';
import {
  classificarProduto,
  depositoIdDoRef,
  montarLinha,
  resumirEstoques,
  type EstoqueBruto,
  type ProdutoBruto,
  type ProdutoSemVariacoesRow,
  type ResumoEstoque,
  type VereditoProduto,
} from './predicate';

/**
 * AUDIT (read-only): produtos that hold their OWN stock because they have no
 * variation children — the legacy "Produto Simples" shape — #1402.
 *
 *   pnpm --filter @delfrance/migrations audit:produto-sem-variacoes --project <id>
 *
 * ## Why
 *
 * #1398 settles that **a produto never holds available stock; the sellable unit
 * is always a child**. The legacy corpus disagrees — see the header of
 * `predicate.ts` for the two Flutter sources. This counts the disagreement
 * before the one-time conversion script is written, because the count is what
 * tells that script what it has to handle.
 *
 * `census-up-single.ts:9-15` puts the reason better than a restatement would:
 * *"'we think the corpus is empty' and 'we counted and it is empty' are not the
 * same claim, and only one of them survives being wrong."*
 *
 * ## No `--apply`, by construction
 *
 * Minting a produto document and relocating real inventory is not something a
 * census gets to do, and per root `CLAUDE.md` rule 8 a bulk write against
 * production belongs in the coordinated cutover window (#1402 is that step).
 * The flag is REJECTED rather than ignored, so nobody can assume it worked.
 *
 * ## No index required, and deliberately so
 *
 * Every walk here is a plain `orderBy(documentId())` key-order scan with the
 * tests done in memory — the ONE ordering Firestore always serves without a
 * declared index.
 *
 * ⚠️ `where('paiId','==',null)` looks cheaper and is a trap. On Firestore
 * ENTERPRISE an undeclared filter never throws `FAILED_PRECONDITION` — it
 * silently full-scans and bills data scanned (rule 1) — and `produtos(paiId ASC,
 * nome ASC)` exists but would then have to serve a query it was not declared
 * for. More to the point it would not help: this census must see EVERY produto
 * anyway, because "has children" is only knowable by observing some other
 * document's `paiId`.
 *
 * ## One pass, not N queries
 *
 * `census-up-single.ts:136` asks `where('paiId','==',<id>).limit(1)` per
 * candidate. That is right for its universe — a handful of Mercado Livre links —
 * and wrong for this one, where the candidate set is the whole catalogue and
 * that shape would cost one query per produto.
 *
 * Instead a single key-order pass buffers a compact record per produto and
 * derives, for free, three things a per-candidate query could not: which parents
 * have children (every child names its own parent), which produtos are named by
 * some kit's `componentesKitKeys`, and which `paiId`s point at nothing.
 *
 * ⚠️ That buffer is the one scaling limit here — roughly 200 bytes per produto,
 * so a 500k-produto catalogue is ~100MB of heap. The buffered count is printed;
 * if it is ever surprising, that is the number to react to.
 *
 * ## Optional passes
 *
 * Two collateral questions cost a full extra collection scan each, so they are
 * opt-in and their columns read `null` — "not measured" — when they do not run.
 * `null` rather than `false`, because "no open pedido reserves against this" and
 * "we did not look" must never be the same value in a report someone sizes a
 * migration from.
 *
 *   --target pedidos     count open reservations per produto (scans `pedidos`)
 *   --target balancos    flag produtos inside an OPEN balanço (scans `balanco`)
 *   --target residuais   also read estoques for produtos that ALREADY have
 *                        children, to size the risk-2 residual
 *
 * Combine with commas: `--target pedidos,balancos,residuais`.
 */

const PAGE_SIZE = 300;

/** Above this, the in-memory buffer is worth a word in the output. */
const AVISO_BUFFER = 200_000;

/** Which verdicts get a JSONL row. The rest are counted only — see `run`. */
const VEREDITOS_RELATADOS: ReadonlySet<VereditoProduto> = new Set<VereditoProduto>([
  'simples-com-estoque',
  'simples-sem-estoque',
  'orfao',
]);

/** Page any collection by document id — stable cursor, bounded memory, no index. */
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

/* -------------------------------------------------------------------------- */
/*                          Pass 1 — the produtos walk                        */
/* -------------------------------------------------------------------------- */

interface Corpus {
  /** Every produto, in the order read. */
  produtos: ProdutoBruto[];
  /** Every produto id that exists — answers "does this `paiId` point at anything?". */
  ids: Set<string>;
  /** Every id that some other produto names as its `paiId`. */
  paisComFilhos: Set<string>;
  /** produto id → how many OTHER produtos list it in `componentesKitKeys`. */
  referenciasDeKit: Map<string, number>;
}

/**
 * ⚠️ `Object.hasOwn` for `ultimaModificacao`, not `?? null`. An ABSENT key makes
 * the produto invisible to `/produtos`, whose `defaultQuery` orders by it and
 * whose `orderBy` skips documents missing the ordered field (#1213). A stored
 * `null` is fine. Collapsing the two would hide the finding.
 */
function lerProduto(doc: QueryDocumentSnapshot): ProdutoBruto {
  const data = doc.data() as Record<string, unknown>;
  return {
    id: doc.id,
    nome: data.nome,
    sku: data.sku,
    paiId: data.paiId,
    ehKit: data.ehKit,
    publicado: data.publicado,
    ultimaModificacao: Object.hasOwn(data, 'ultimaModificacao')
      ? data.ultimaModificacao
      : undefined,
  };
}

async function lerCorpus(ctx: MigrationContext): Promise<Corpus> {
  const corpus: Corpus = {
    produtos: [],
    ids: new Set(),
    paisComFilhos: new Set(),
    referenciasDeKit: new Map(),
  };

  for await (const docs of pagesByDocId(ctx.db.collection('produtos'))) {
    for (const doc of docs) {
      const data = doc.data() as Record<string, unknown>;
      corpus.ids.add(doc.id);
      corpus.produtos.push(lerProduto(doc));

      const paiId = data.paiId;
      if (typeof paiId === 'string' && paiId !== '') corpus.paisComFilhos.add(paiId);

      // `componentesKitKeys` is the array-contains index of `componentesKit`'s
      // map keys, written together and never one without the other
      // (`onProdutoDeleted.ts:73-78`). Reading the array avoids walking the map.
      const chaves = data.componentesKitKeys;
      if (Array.isArray(chaves)) {
        for (const chave of chaves) {
          if (typeof chave !== 'string' || chave === '') continue;
          corpus.referenciasDeKit.set(chave, (corpus.referenciasDeKit.get(chave) ?? 0) + 1);
        }
      }
    }
  }

  return corpus;
}

/* -------------------------------------------------------------------------- */
/*                          Pass 2 — the optional walks                       */
/* -------------------------------------------------------------------------- */

/**
 * produto id → how many pedidos currently hold an APPLIED reservation against it.
 *
 * Keyed on `estoqueAplicado.reservado` rather than on `estado`, deliberately.
 * `ESTADOS_PEDIDO_RESERVA` says which estados *should* hold one; the applied map
 * says which pedido actually *does*, and it is that map the release diffs against
 * (`estoquePlan.ts:249-274`). A pedido in a reserva estado whose sync has not run
 * yet holds nothing to strand, and one that drifted out of that set while still
 * applied is exactly the case worth counting.
 */
async function contarReservasAbertas(ctx: MigrationContext): Promise<Map<string, number>> {
  const porProduto = new Map<string, number>();

  for await (const docs of pagesByDocId(ctx.db.collection('pedidos'))) {
    for (const doc of docs) {
      const data = doc.data() as Record<string, unknown>;
      const aplicado = data.estoqueAplicado;
      if (typeof aplicado !== 'object' || aplicado === null) continue;
      const reservado = (aplicado as Record<string, unknown>).reservado;
      if (typeof reservado !== 'object' || reservado === null) continue;

      for (const [produtoId, qtd] of Object.entries(reservado as Record<string, unknown>)) {
        if (typeof qtd !== 'number' || !Number.isFinite(qtd) || qtd <= 0) continue;
        porProduto.set(produtoId, (porProduto.get(produtoId) ?? 0) + 1);
      }
    }
  }

  return porProduto;
}

/**
 * The depósitos covered by an OPEN balanço.
 *
 * ⚠️ An open balanço stores `estado: null` — the unstored `'aberto'`
 * (`balanco.ts:95-108`). Filtering in memory rather than with `where('estado','==',null)`
 * keeps the walk index-free and treats an ABSENT key the same as a stored null,
 * which `balancoAceitaLancamento` also does.
 */
async function lerDepositosEmBalanco(ctx: MigrationContext): Promise<Set<string>> {
  const depositos = new Set<string>();

  for await (const docs of pagesByDocId(ctx.db.collection('balanco'))) {
    for (const doc of docs) {
      const data = doc.data() as Record<string, unknown>;
      if (data.estado != null) continue;
      const depositoId = depositoIdDoRef(data.depositoOuterRef);
      if (depositoId != null) depositos.add(depositoId);
    }
  }

  return depositos;
}

/* -------------------------------------------------------------------------- */
/*                              Estoque per produto                           */
/* -------------------------------------------------------------------------- */

async function lerEstoques(ctx: MigrationContext, produtoId: string): Promise<ResumoEstoque> {
  const snap = await ctx.db.collection(`produtos/${produtoId}/estoques`).get();
  const brutos: EstoqueBruto[] = snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    return {
      docId: d.id,
      depositoOuterRef: data.depositoOuterRef,
      quantidade: data.quantidade,
      quantidadeReservada: data.quantidadeReservada,
    };
  });
  return resumirEstoques(produtoId, brutos);
}

/* -------------------------------------------------------------------------- */
/*                                    Run                                     */
/* -------------------------------------------------------------------------- */

async function run(ctx: MigrationContext): Promise<MigrationSummary> {
  if (ctx.apply) {
    throw new MigrationArgError(
      'This is a CENSUS, not a migration: it has no --apply path. Minting a produto and ' +
        'relocating real inventory belongs in the coordinated cutover window (#1402), per ' +
        'root CLAUDE.md rule 8. Read the JSONL under out/ and size the conversion from it.',
    );
  }

  const quer = (alvo: string): boolean => ctx.args.targets.includes(alvo);

  const corpus = await lerCorpus(ctx);
  log(`[produto-sem-variacoes] ${corpus.produtos.length} produtos lidos`);
  if (corpus.produtos.length > AVISO_BUFFER) {
    log(
      `[produto-sem-variacoes] ⚠️ ${corpus.produtos.length} produtos em memória — ` +
        'acima do esperado; confira o uso de heap antes de confiar no resultado.',
    );
  }

  const reservasPorProduto = quer('pedidos') ? await contarReservasAbertas(ctx) : null;
  if (reservasPorProduto) {
    log(
      `[produto-sem-variacoes] ${reservasPorProduto.size} produtos com reserva aplicada em algum pedido`,
    );
  }
  const depositosEmBalanco = quer('balancos') ? await lerDepositosEmBalanco(ctx) : null;
  if (depositosEmBalanco) {
    log(`[produto-sem-variacoes] ${depositosEmBalanco.size} depósito(s) com balanço aberto`);
  }
  const lerResiduais = quer('residuais');

  const porVeredito = new Map<VereditoProduto, number>();
  let docsChanged = 0;
  let moveriaTotal = 0;
  let ficariaNoPaiTotal = 0;
  let comLinhaNaoCanonica = 0;
  let comDepositoIrreconhecivel = 0;
  let residuaisEmFamilias = 0;

  for (const produto of corpus.produtos) {
    const paiId = typeof produto.paiId === 'string' && produto.paiId !== '' ? produto.paiId : null;
    const ehRaiz = paiId == null;
    const temFilhos = corpus.paisComFilhos.has(produto.id);

    // Only a root produto pays for the estoque read — and a root that already
    // has children only under `--target residuais`.
    const precisaEstoque = ehRaiz && (!temFilhos || lerResiduais);
    const resumo = precisaEstoque ? await lerEstoques(ctx, produto.id) : null;

    const veredito = classificarProduto({
      paiId,
      paiExiste: paiId != null && corpus.ids.has(paiId),
      temFilhos,
      resumo,
    });
    porVeredito.set(veredito, (porVeredito.get(veredito) ?? 0) + 1);

    if (veredito === 'ja-familia' && resumo?.temEstoque === true) residuaisEmFamilias += 1;

    const relatar =
      VEREDITOS_RELATADOS.has(veredito) ||
      (veredito === 'ja-familia' && lerResiduais && resumo?.temEstoque === true);
    if (!relatar) continue;

    if (resumo) {
      moveriaTotal += resumo.moveriaTotal;
      ficariaNoPaiTotal += resumo.ficariaNoPaiTotal;
      if (resumo.nLinhasNaoCanonicas > 0) comLinhaNaoCanonica += 1;
      if (resumo.nDepositosIrreconheciveis > 0) comDepositoIrreconhecivel += 1;
    }

    const emBalancoAberto =
      depositosEmBalanco == null || resumo == null
        ? null
        : resumo.linhas.some((l) => l.depositoId != null && depositosEmBalanco.has(l.depositoId));

    docsChanged += 1;
    registrar(
      ctx,
      montarLinha({
        produto,
        veredito,
        resumo,
        nKitsQueReferenciam: corpus.referenciasDeKit.get(produto.id) ?? 0,
        emBalancoAberto,
        nPedidosAbertosQueReservam:
          reservasPorProduto?.get(produto.id) ?? (reservasPorProduto ? 0 : null),
      }),
    );
  }

  log(
    `[produto-sem-variacoes] por veredito: ${
      [...porVeredito.entries()].map(([k, n]) => `${k}=${n}`).join(', ') || 'nenhum'
    }`,
  );
  log(
    `[produto-sem-variacoes] unidades que a conversão MOVERIA para o filho único: ${moveriaTotal}`,
  );
  log(
    `[produto-sem-variacoes] unidades que FICARIAM no pai (reserva de pedido aberto): ${ficariaNoPaiTotal}`,
  );
  log(
    `[produto-sem-variacoes] produtos com linha de estoque não canônica: ${comLinhaNaoCanonica}; ` +
      `com depositoOuterRef irreconhecível: ${comDepositoIrreconhecivel}`,
  );
  log(
    lerResiduais
      ? `[produto-sem-variacoes] famílias que ainda guardam estoque no pai: ${residuaisEmFamilias}`
      : '[produto-sem-variacoes] famílias existentes NÃO foram medidas (use --target residuais)',
  );
  // No silent caps: say what was counted but not written out.
  log(
    `[produto-sem-variacoes] o JSONL traz apenas ${[...VEREDITOS_RELATADOS].join(', ')}` +
      `${lerResiduais ? ' e as famílias com resíduo' : ''}; 'filho' e 'ja-familia' são só contados.`,
  );
  if (reservasPorProduto == null) {
    log('[produto-sem-variacoes] reservas de pedido NÃO foram medidas (use --target pedidos)');
  }
  if (depositosEmBalanco == null) {
    log('[produto-sem-variacoes] balanços abertos NÃO foram medidos (use --target balancos)');
  }

  return { docsScanned: corpus.produtos.length, docsChanged };
}

/**
 * One JSONL line per reported produto. Uses `sink.change` because the runner's
 * counters and log format are already wired to it — `from` carries the verdict
 * and `to` the forensic payload, rather than an intended write, since this
 * script can never write. Same shape as the #931 audit.
 */
function registrar(ctx: MigrationContext, row: ProdutoSemVariacoesRow): void {
  ctx.sink.change(row.produtoPath, row.veredito, row.sku ?? '(sem sku)', {
    produtoId: row.produtoId,
    nome: row.nome,
    sku: row.sku,
    paiId: row.paiId,
    ehKit: row.ehKit,
    publicado: row.publicado,
    semUltimaModificacao: row.semUltimaModificacao,
    estoque: row.estoque,
    nKitsQueReferenciam: row.nKitsQueReferenciam,
    emBalancoAberto: row.emBalancoAberto,
    nPedidosAbertosQueReservam: row.nPedidosAbertosQueReservam,
  });
}

function log(message: string): void {
  // eslint-disable-next-line no-console
  console.log(message);
}

if (isMainModule(import.meta.url)) {
  await runMigration('produto-sem-variacoes', run);
}

export { run };
