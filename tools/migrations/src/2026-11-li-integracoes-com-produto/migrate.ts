import {
  FieldPath,
  FieldValue,
  type DocumentSnapshot,
  type Query,
  type QueryDocumentSnapshot,
} from 'firebase-admin/firestore';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  produtoShopeeLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  adicionarContaSeViva,
  sobrevivemVinculosDoProdutoLi,
  type SentinelasDeArray,
} from '@delfrance/data/admin/produtos';

import {
  isMainModule,
  type MigrationContext,
  type MigrationSummary,
  runMigration,
} from '../runner';
import {
  CLASSE,
  censar,
  contagemPorConta,
  contasLojaIntegrada,
  linhaDeRecusa,
  linhaDoGate,
  produtosDosVinculosLi,
  recusaSemContasLi,
  type Achado,
  type Adicao,
  type ContaLida,
  type MotivoDeRecusa,
  type ProdutoLido,
  type ResultadoDoCenso,
  type VinculoLido,
  type VinculosDeOutrosCanais,
} from './transform';

/**
 * The Loja Integrada anchor census: every produto holding a `produtolojaintegrada`
 * link, checked against `produtos.integracoesComProduto`. Dry run by default;
 * `--apply` adds the missing Loja Integrada contas and nothing else. Runbook:
 * `tools/migrations/li-integracoes-com-produto.README.md`. The decisions are
 * `transform.ts`; this file is Firestore I/O and nothing else.
 *
 *   pnpm --filter @delfrance/migrations migrate:li-integracoes-com-produto --project <id>
 *   pnpm --filter @delfrance/migrations migrate:li-integracoes-com-produto --project <id> --apply
 *
 * ## What it reads, in order
 *
 * 1. `integracao`, masked to `tipo`: which contas exist and of which channel.
 *    No Loja Integrada conta ⇒ a REFUSAL before anything else is read.
 * 2. Every `produtolojaintegrada` doc, by document KEY:
 *    `collectionGroup(...).select(conta, id, removido).orderBy(documentId()).limit(300)`
 *    with `startAfter`, on the DECLARED key index `produtolojaintegrada
 *    (__name__ ASC)`, collection-group scope (`key-walks.json`). Enterprise has no
 *    implicit key index; without one each page scans the whole group. A
 *    per-conta query would be worse twice over: the only composite on the group
 *    filters on the two canonical ref forms, so it misses a ref the shared
 *    reader folds (a leading slash) and every link of a conta whose doc is gone,
 *    the silent direction; and an `array-contains` per conta over `produtos`
 *    full-scans once per conta.
 * 3. The produtos those links name, point reads (`getAll`, chunks of 200) masked
 *    to `integracoesComProduto` + `paiId`.
 * 4. For each produto that exists, its OWN `produtoMercadoLivre`,
 *    `variacaoMercadoLivre` and `prodshopee` links: three unfiltered, unordered,
 *    unpaged reads through the `@delfrance/data/admin/collections` handles, so
 *    no index is involved. A pool of {@link CONCORRENCIA} produtos at a time.
 *    ⚠️ Whether Enterprise plans such a read over the produto's own docs only,
 *    or over the whole group, is not measured yet; the runbook makes that
 *    measurement a precondition of the production run.
 *
 * ## The write path (`--apply`)
 *
 * For each `li-ausente` pair, ONE call of the core's guarded, read-derived add
 * (`adicionarContaSeViva` in `@delfrance/data/admin/produtos`) bound to the
 * shared Loja Integrada survivor read (`sobrevivemVinculosDoProdutoLi`, the same
 * one the anchor trigger's remove runs). Never the trigger's unguarded add: this
 * census's evidence is a walk page, not an event, and a stale union landing
 * after the link was trashed would stay listed for good, because the trash's
 * own trigger already ran and ignores every later write to a link that no
 * longer counts. The core re-reads the produto's links inside its own read set
 * and adds only while one still counts.
 *
 * - A `false` from the core (the link stopped counting, or the produto is gone)
 *   is a `divergente` row, never a change. A re-run classifies it afresh.
 * - Anything the core rethrows aborts the run. It is idempotent: run it again.
 * - Produtos run {@link CONCORRENCIA} at a time; one produto's contas run in
 *   sequence, so no attempt contends with its own sibling.
 * - Mercado Livre and Shopee findings never reach it, and neither does
 *   `li-campo-invalido` (a union over a non-array overwrites it; a person fixes
 *   the field and re-runs).
 *
 * ## `0 writes` is expected
 *
 * The core writes on its own, outside the runner's `BatchWriter`, so the
 * runner's closing `… 0 writes` figure is 0 BY DESIGN. This script counts its
 * own adds (`adicionados=`) and says so; the JSONL is the record.
 *
 * ## Refusals (exit 1, in every mode, before any write)
 *
 * No Loja Integrada conta, or no counting link walked: the gate line reads
 * `GATE li: NAO-AVALIADO <motivo>`, never `0 0`, and the run throws.
 *
 * ## ⛔ Agents never run this. It runs in the migration window only — root `CLAUDE.md` rule 8.
 */

export const NOME_DO_CENSO = 'li-integracoes-com-produto';

const PAGE_SIZE = 300;
/** Documents per `getAll`: Firestore accepts more, this keeps a request small. */
const GET_ALL_CHUNK = 200;
/** Produtos read (and, on `--apply`, added to) at once. */
export const CONCORRENCIA = 8;

/** The masked fields of each read. The readers in `transform.ts` read nothing else. */
export const CAMPOS_DO_VINCULO_LI = ['contaLojaIntegrada', 'id', 'removido'] as const;
export const CAMPOS_DO_PRODUTO = ['integracoesComProduto', 'paiId'] as const;
export const CAMPOS_PRODUTO_ML = ['contaOuterRef', 'id', 'estado'] as const;
export const CAMPOS_VARIACAO_ML = ['contaOuterRef', 'id', 'itemId'] as const;
export const CAMPOS_PRODSHOPEE = [
  'contaProdutoShopeeOuterRef',
  'item_id',
  'estadoAnuncio',
] as const;

/** The census could not judge the corpus. Thrown after the gate line is printed. */
export class CensoNaoAvaliado extends Error {
  constructor(readonly motivo: MotivoDeRecusa) {
    super(
      `GATE li: NAO-AVALIADO ${motivo}. Nothing was written. Check --project, the database and ` +
        'that the import has finished (runbook: li-integracoes-com-produto.README.md).',
    );
    this.name = 'CensoNaoAvaliado';
  }
}

/** The array sentinels the core needs, by NAME (a swap would make the add remove). */
export const SENTINELAS: SentinelasDeArray = {
  arrayUnion: (id) => FieldValue.arrayUnion(id),
  arrayRemove: (id) => FieldValue.arrayRemove(id),
};

/** What the `--apply` leg calls. Injected so the I/O tests can watch every call. */
export interface DependenciasDoCenso {
  readonly adicionarContaSeViva: typeof adicionarContaSeViva;
  readonly sobrevivemVinculosDoProdutoLi: typeof sobrevivemVinculosDoProdutoLi;
  readonly sentinelas: SentinelasDeArray;
}

export const DEPENDENCIAS_DO_CENSO: DependenciasDoCenso = {
  adicionarContaSeViva,
  sobrevivemVinculosDoProdutoLi,
  sentinelas: SENTINELAS,
};

function log(message: string): void {
  // eslint-disable-next-line no-console -- operator-facing run output
  console.log(message);
}

/**
 * Run `fn` over `itens`, at most `limite` at a time. The first rejection rejects the whole
 * call, and no further item starts after it.
 */
async function emPiscina<T>(
  itens: readonly T[],
  limite: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let proximo = 0;
  let falhou = false;
  async function trabalhador(): Promise<void> {
    while (!falhou && proximo < itens.length) {
      const item = itens[proximo]!;
      proximo += 1;
      let concluiu = false;
      try {
        await fn(item);
        concluiu = true;
      } finally {
        // No handler: a rejection propagates as is, and stops the others taking new items.
        if (!concluiu) falhou = true;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limite, itens.length) }, () => trabalhador()));
}

/* -------------------------------------------------------------------------- */
/*                                   Reads                                     */
/* -------------------------------------------------------------------------- */

async function lerContas(ctx: MigrationContext): Promise<ContaLida[]> {
  const snap = await ctx.db.collection('integracao').select('tipo').get();
  return snap.docs.map((d) => ({ id: d.id, tipo: d.get('tipo') as unknown }));
}

/** Every `produtolojaintegrada` doc, page by page on the declared key index. */
async function lerVinculosLi(ctx: MigrationContext): Promise<VinculoLido[]> {
  const vinculos: VinculoLido[] = [];
  let cursor: QueryDocumentSnapshot | undefined;
  for (;;) {
    let q: Query = ctx.db
      .collectionGroup('produtolojaintegrada')
      .select(...CAMPOS_DO_VINCULO_LI)
      .orderBy(FieldPath.documentId())
      .limit(PAGE_SIZE);
    if (cursor) q = q.startAfter(cursor);
    const snap = await q.get();
    for (const doc of snap.docs) {
      vinculos.push({ caminho: doc.ref.path, dados: doc.data() as Record<string, unknown> });
    }
    if (snap.size < PAGE_SIZE) return vinculos;
    cursor = snap.docs[snap.docs.length - 1];
  }
}

function lerProduto(snap: DocumentSnapshot): ProdutoLido {
  if (!snap.exists) return { existe: false, integracoesComProduto: undefined, paiId: undefined };
  const dados = (snap.data() ?? {}) as Record<string, unknown>;
  return {
    existe: true,
    integracoesComProduto: dados.integracoesComProduto,
    paiId: dados.paiId,
  };
}

async function lerProdutos(
  ctx: MigrationContext,
  ids: readonly string[],
): Promise<Map<string, ProdutoLido>> {
  const produtos = new Map<string, ProdutoLido>();
  for (let i = 0; i < ids.length; i += GET_ALL_CHUNK) {
    const refs = ids
      .slice(i, i + GET_ALL_CHUNK)
      .map((id) => produtoCollection.docRef(ctx.db, {}, id));
    const snaps = await ctx.db.getAll(...refs, { fieldMask: [...CAMPOS_DO_PRODUTO] });
    for (const snap of snaps) produtos.set(snap.id, lerProduto(snap));
  }
  return produtos;
}

/** One produto's own Mercado Livre and Shopee links. Unfiltered: no index involved. */
async function lerOutrosCanais(
  ctx: MigrationContext,
  produtoId: string,
): Promise<VinculosDeOutrosCanais> {
  const comoVinculos = (docs: readonly QueryDocumentSnapshot[]): VinculoLido[] =>
    docs.map((d) => ({ caminho: d.ref.path, dados: d.data() as Record<string, unknown> }));
  const [produtoMercadoLivre, variacaoMercadoLivre, prodshopee] = await Promise.all([
    produtoMercadoLivreLinkCollection
      .ref(ctx.db, { produtoId })
      .select(...CAMPOS_PRODUTO_ML)
      .get(),
    variacaoMercadoLivreLinkCollection
      .ref(ctx.db, { produtoId })
      .select(...CAMPOS_VARIACAO_ML)
      .get(),
    produtoShopeeLinkCollection
      .ref(ctx.db, { produtoId })
      .select(...CAMPOS_PRODSHOPEE)
      .get(),
  ]);
  return {
    produtoMercadoLivre: comoVinculos(produtoMercadoLivre.docs),
    variacaoMercadoLivre: comoVinculos(variacaoMercadoLivre.docs),
    prodshopee: comoVinculos(prodshopee.docs),
  };
}

/* -------------------------------------------------------------------------- */
/*                                  Output                                     */
/* -------------------------------------------------------------------------- */

function gravar(ctx: MigrationContext, achado: Achado): void {
  if (achado.classe === CLASSE.liAusente) {
    ctx.sink.change(achado.caminho, achado.campo, achado.valor, achado.contaId);
    return;
  }
  ctx.sink.skip(
    achado.caminho,
    achado.campo,
    { conta: achado.contaId, valor: achado.valor },
    achado.classe,
  );
}

function logarResumo(resultado: ResultadoDoCenso): void {
  log(`[${NOME_DO_CENSO}] contagem por (canal, conta, classe):`);
  for (const linha of contagemPorConta(resultado.achados)) {
    log(`  ${linha.canal} conta=${linha.contaId ?? '-'} ${linha.classe}=${linha.n}`);
  }
  for (const [contaId, n] of resultado.vinculosPorConta) {
    log(`  li conta=${contaId} vinculos-que-contam=${n}`);
  }
  log(linhaDoGate(resultado.gate));
  if (resultado.gate.contaInexistente > 0) {
    log(
      `AVISO li: conta-inexistente=${resultado.gate.contaInexistente} vinculo(s) que contam ` +
        'apontam para uma conta que não existe. Um número grande aqui, com o gate em 0 0, é o ' +
        'retrato de vínculos de uma conta recriada com outro id: leia o JSONL antes de seguir.',
    );
  }
}

/* -------------------------------------------------------------------------- */
/*                                 The apply                                   */
/* -------------------------------------------------------------------------- */

async function aplicar(
  ctx: MigrationContext,
  deps: DependenciasDoCenso,
  plano: readonly Adicao[],
): Promise<{ adicionados: number; divergentes: number; produtos: number }> {
  const porProduto = new Map<string, string[]>();
  for (const { produtoId, contaId } of plano) {
    const contas = porProduto.get(produtoId);
    if (contas) contas.push(contaId);
    else porProduto.set(produtoId, [contaId]);
  }
  let adicionados = 0;
  let divergentes = 0;
  const produtosAlterados = new Set<string>();

  await emPiscina([...porProduto.entries()], CONCORRENCIA, async ([produtoId, contas]) => {
    const caminho = `produtos/${produtoId}`;
    for (const contaId of contas) {
      // Through the deps object at call time — never a function taken from it at bind time.
      const ok = await deps.adicionarContaSeViva(
        ctx.db,
        produtoId,
        contaId,
        deps.sobrevivemVinculosDoProdutoLi(ctx.db, produtoId, contaId),
        deps.sentinelas,
      );
      if (ok) {
        adicionados += 1;
        produtosAlterados.add(produtoId);
        ctx.sink.change(caminho, 'aplicado', null, contaId);
      } else {
        divergentes += 1;
        ctx.sink.skip(caminho, 'integracoesComProduto', contaId, 'divergente');
      }
    }
  });
  return { adicionados, divergentes, produtos: produtosAlterados.size };
}

/* -------------------------------------------------------------------------- */
/*                                 The body                                    */
/* -------------------------------------------------------------------------- */

/** The migration body, bound to its `--apply` dependencies. */
export function criarCenso(
  deps: DependenciasDoCenso = DEPENDENCIAS_DO_CENSO,
): (ctx: MigrationContext) => Promise<MigrationSummary> {
  return async function run(ctx: MigrationContext): Promise<MigrationSummary> {
    /* -- 1. Contas ---------------------------------------------------------- */
    const contas = await lerContas(ctx);
    const contasLi = contasLojaIntegrada(contas);
    // Refused before the walk: on the wrong project there is nothing worth paying to read.
    const semContas = recusaSemContasLi(contas);
    if (semContas !== null) {
      log(linhaDeRecusa(semContas, 0, null));
      throw new CensoNaoAvaliado(semContas);
    }
    log(`[${NOME_DO_CENSO}] ${contasLi.length} conta(s) Loja Integrada: ${contasLi.join(', ')}`);

    /* -- 2. Every link, by key ---------------------------------------------- */
    const vinculosLi = await lerVinculosLi(ctx);
    log(`[${NOME_DO_CENSO}] ${vinculosLi.length} vínculo(s) produtolojaintegrada lido(s)`);

    /* -- 3. The produtos they name ------------------------------------------ */
    const produtos = await lerProdutos(ctx, produtosDosVinculosLi(vinculosLi));

    /* -- 4. Their own other-channel links ----------------------------------- */
    const existentes = [...produtos.entries()].filter(([, p]) => p.existe).map(([id]) => id);
    const outrosCanais = new Map<string, VinculosDeOutrosCanais>();
    let outrosLidos = 0;
    await emPiscina(existentes, CONCORRENCIA, async (produtoId) => {
      const outros = await lerOutrosCanais(ctx, produtoId);
      outrosCanais.set(produtoId, outros);
      outrosLidos +=
        outros.produtoMercadoLivre.length +
        outros.variacaoMercadoLivre.length +
        outros.prodshopee.length;
    });

    const resultado = censar({ contas, vinculosLi, produtos, outrosCanais });
    const docsScanned = contas.length + vinculosLi.length + produtos.size + outrosLidos;

    /* -- Refusal: before any row and any write, in every mode --------------- */
    if (resultado.gate.recusa !== null) {
      log(linhaDoGate(resultado.gate));
      throw new CensoNaoAvaliado(resultado.gate.recusa);
    }

    if (!ctx.reportOnly) for (const achado of resultado.achados) gravar(ctx, achado);
    logarResumo(resultado);
    const produtosNoPlano = new Set(resultado.plano.map((a) => a.produtoId)).size;

    if (!ctx.apply) {
      log(
        `[${NOME_DO_CENSO}] ${resultado.plano.length} conta(s) a adicionar em ${produtosNoPlano} ` +
          `produto(s). ${ctx.reportOnly ? 'REPORT-ONLY' : 'DRY-RUN'}: nada foi escrito.`,
      );
      return { docsScanned, docsChanged: produtosNoPlano };
    }

    const aplicado = await aplicar(ctx, deps, resultado.plano);
    log(
      `[${NOME_DO_CENSO}] adicionados=${aplicado.adicionados} divergentes=${aplicado.divergentes} ` +
        '(grep "divergente" no JSONL: o vínculo deixou de contar, ou o produto sumiu).',
    );
    log(
      `[${NOME_DO_CENSO}] o "0 writes" abaixo é esperado: o núcleo escreve na própria ` +
        'leitura guardada, fora do BatchWriter. Rode o dry-run de novo: o GATE li deve ler 0 0.',
    );
    return { docsScanned, docsChanged: aplicado.produtos };
  };
}

export const run = criarCenso();

if (isMainModule(import.meta.url)) {
  await runMigration(NOME_DO_CENSO, run);
}
