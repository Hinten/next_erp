/**
 * ONE family of the product import's `familias` phase (master plan step 9): the match cascade, the
 * plan, the links, the report item — and, under "complete", the ERP side completed — composed in
 * that order for one store family, with no Loja Integrada call. The dispatch runs it as the
 * family's unit (a `familia` unit of the time budget) and checkpoints what it returns: the family
 * cursor moved past the family, the counters plus the item's delta and (under "complete") the job's
 * category map, in ONE write, so a retried unit redoes the same family from the same base (and,
 * past links it already created, reports the same delta: "A retried family").
 *
 * ## Order
 *
 *  1. The root through the cascade (`resolverRaizLi`).
 *  2. The target (`familiaNoAlvoLi`): a family outside it stops here — no variation resolved, no
 *     link, no item — unless it is in CONFLICT under `jaNoErp`/`naoNoErp`, which is reported with
 *     its conflict and no link (`plano.ts`, "The target"). **The target is decided once**, on the
 *     ERP as it stood when the job STARTED, wherever an import's own writes could move it. Under
 *     "complete" a matched root at the id the family's create would take (`li-sku-…`, which only an
 *     import writes) and created at or after the job document was `ausente` then — THIS job's
 *     landed create ("A retried family"), or another conta's create this job adopted, or met
 *     already landed — so the family is ALSO in the target `ausente` puts it in (`naoNoErp`): on
 *     the first attempt and on every retry alike, whether the retry meets the root through this
 *     job's own link, through the SKU (a fill landed, the link not yet), or with the photo
 *     progress lost. It adds a target, never removes one: `jaNoErp` keeps the cascade's answer, so
 *     such a root is in both. And the re-runs of the cascade a unit makes after its own writes (an
 *     adoption, a closing) keep the verdict the preparation reached. So a `naoNoErp` family never
 *     drops out of its own target halfway through being imported. One document by id, read only
 *     where it can matter (a `vinculado` root under `aplicar`, a match outside `naoNoErp`); a root
 *     at any other id keeps the cascade's answer.
 *     ⚠️ Accepted residuals: a root deleted and created again at that id during the run reads as
 *     absent at the start; and a family whose earlier attempt wrote ONLY its report item (nothing
 *     imported: "only link"'s `ausente` item, a refused create) and whose retry meets a root another
 *     writer created since — by hand at an auto id, or anywhere under "only link" — is outside a
 *     `naoNoErp` target on the retry: that item stays, uncounted.
 *  3. A matched parent's variations (`resolverFilhosLi`), resolved against the grupos the caller
 *     passes: the dispatch's memo, plus, under Simular, the overlay of what the job would have
 *     learned (`gruposParaResolverLi`), so a Simular verdict equals an `aplicar` one.
 *  4. The plan (`plano.ts`), pure.
 *  5. Under "only link": the links (`vinculos.ts`), written under `aplicar`, decided only under
 *     Simular. Under "complete": "Complete" below.
 *  6. The report item (`relatorio.ts`), written whole at the root's store id (tier 0).
 *
 * ## Complete (`acao: completar`)
 *
 * The dispatch runs a family's complete step only once every detail it needs is read
 * ({@link detalhesDaFamiliaLi}, one unit each, tracked in the job's `familias.filhosLidos`), so an
 * all-or-nothing create never sees half a family. Then, with no Loja Integrada call, the
 * PREPARATION ({@link executarFamiliaLi}):
 *
 *  - **A family the ERP lacks** (`ausente`, its create classified viable by the plan): the root's
 *    category PLANNED (`categorias.ts` run as Simular runs it: reads, no write — its ids are
 *    deterministic), then the WHOLE family in one batch with its links (`familiaNova.ts`: every
 *    refusal, then the create probe immediately before the commit, ids keyed by the SKU). Only once
 *    the batch is about to be committed are the planned categories created and linked
 *    (`criarEVincular`) and the family's tax review made durable (`familiaNova.ts`'s
 *    `antesDoLote`), so a refused create leaves no category behind and reports no category
 *    pendência (it imported nothing). A root found at its id with the store SKU (another conta's
 *    create) is ADOPTED: the cascade runs again and the family takes the path below; when that
 *    cascade no longer matches the root (another shape, a second root with the SKU), the item
 *    carries the cascade's own verdict, and only a root found GONE is `conflito-de-escrita`.
 *  - **A family the ERP has** (`vinculado` or `encontrado`): its EMPTY fields filled
 *    (`completar.ts`), the root first, then each matched variation on its own, with the PARENT's
 *    category as the root's fill LEFT it — the one the fill wrote, else the one its last read found
 *    stored (an operator's, landed meanwhile), else none — and, when its read detail has no box, the
 *    parent's box. The root's category is resolved only when the root's own is empty, planned
 *    first and created only when the plan resolves, so a run never creates a category no produto
 *    takes (but for a fill that then loses its race). NO link yet.
 *
 * Each category a create-and-link run creates is named on the item of the family that created it
 * (`categoriasCriadas`, recorded where the plan is carried out, {@link aplicarCategoriaDaRaiz}, so a
 * category a refused create already made is named too). A duplicate of a category of the same name
 * shows in the ERP's category list, not on the card.
 *
 * Then the PHOTOS (`fotos.ts`, the job's `fotos: soSemFotos` with a default bucket): onto every
 * produto the preparation filled or created that has none — under `aplicar` one budgeted unit per
 * picture, driven by the dispatch from the family's progress ({@link ProgressoDaFamiliaLi}); under
 * Simular counted in the same unit, with no download. Then the CLOSING ({@link fecharFamiliaLi}, the
 * same unit when nothing is to be fetched):
 *
 *  - for a family the ERP has: the links LAST (`vinculos.ts`), so the anchor trigger's write on a
 *    produto — its link's consequence — never lands between this job's read of that produto and its
 *    fill or photo write; then, beside the root's CONFIRMED link, the variations the ERP family
 *    lacks (`filhoNovo.ts`, the parent's `filhoUnicoId` re-derived in the same batch); a variation
 *    another writer added meanwhile is filled and linked like a matched one;
 *  - the item and the counters.
 *
 * Per produto the order is therefore always fill, then photos, then link — except for what a
 * create's or an add's batch writes, whose links ride the batch itself; their photos follow it and
 * absorb the anchor's write through their own guarded write (`fotos.ts`, the plan's row 14).
 * ⚠️ Accepted residual: a variation the closing ADDS gets no photos in this run — the next
 * "complete" run, which finds it with none, adds them (the captured store gives a variation no
 * picture of its own anyway).
 *
 *  - **The tax review** (`aplicar` only): every produto created, and every produto whose EMPTY
 *    category was filled or stays empty, joins this job's list (`revisaoFiscal.ts`, tier 0, merged
 *    on `ALREADY_EXISTS`) with why: `produto-criado`, `categoria-criada` (a categoria an import
 *    created), `categoria-preenchida`, `sem-categoria`. The entry a WRITE calls for — a create's
 *    batch, an add's batch, a fill of an empty category — is written BEFORE that write (each
 *    writer's hook), never after it: a write that lands and whose unit then fails is met by the
 *    retry as already done, and an entry the retry cannot re-derive would be lost for good. The
 *    direction is safe: a write that then loses leaves an entry one review too many (a produto that
 *    does not exist leaves the list at the re-check). The other entries (`sem-categoria`) are
 *    written by the unit that decided them, at its end; a retry decides them again.
 *
 * The item says `criar` for a create (also on a retried unit that meets its own landed create,
 * below), `completar` when a field was filled, a photo stored or a variation added, `vincular` when
 * only links were created; `camposPreenchidos` is the distinct field names filled across the family
 * (root first, table order, `fotos` last); the counters gain `criados` (the produtos created, a sole
 * member not counted apart from its root), `completados` (each existing produto filled: `aplicar`
 * when a write landed, Simular when one would), `fotos` (pictures written, or that would be) and
 * the links a create's batch wrote.
 *
 * What a unit writes, and nothing else: link documents (a produto's `produtolojaintegrada`
 * subcollection) and the job's own `itens/{liId}`; under "complete" also produtos, their
 * `extraData`, categorias and their links, the job's `revisao/*` and (photos) `arquivos` with their
 * bucket objects — all under `aplicar` only. No grupo document — option learning is the
 * `aprendizado` phase's.
 *
 * ## The family's progress between its units ({@link ProgressoDaFamiliaLi})
 *
 * What the preparation decided — its fields, pendências, the categories it created, counts and
 * photo targets — and the photo cursor, checkpointed after every unit until the closing reports it:
 * the job's own `progressoDaFamilia`, which the closing clears. A stored value that does not parse,
 * or that names another family, is no progress, and the family is prepared again — safe, since every
 * write of it is fill-empty, create-only or tier 0, at the price of the residuals of "A retried
 * family".
 *
 * ## A retried family
 *
 * The links land BEFORE the item and the checkpoint, so a unit that fails after a create landed
 * re-runs over this job's own links: the cascade's rung 1 now answers the root `vinculado` and
 * every link reads unchanged. `vinculos.ts` tells a link this job created from one it found by the
 * link's `createTime` against the job document's ({@link DepsFamiliaLi.criacaoDoJob}, from the
 * dispatch's job read) and reports it `criado` again; the report maps a root `vinculado` only
 * through such a link back to `encontrado` (`relatorio.ts`). So the retry's item and counter delta
 * equal the first attempt's — and Simular's for the same store — with the residuals
 * `vinculos.ts` states, and one of the cascade's own: a VARIATION the first attempt matched by its
 * option combination (or under a SKU in conflict in the store) is matched by its link on the retry,
 * so the `sku-diferente`, `sku-repetido-na-loja` or `sku-parecido-na-loja` that attempt reported for
 * it is not reported again (one pendência fewer; the link and the action agree). Closing it means rung 1 recognising this job's link and falling through to the SKU and
 * combination rungs, which read nothing new for a variation. ⚠️ And a MIRROR REFRESH this job
 * landed reads `sem-mudanca` on a retried unit: `semMudanca + 1`, its informational
 * `vinculo-atualizado` lost; `vinculados` unaffected (`vinculos.ts`, "Accepted residuals"; pinned
 * in `familiaDoJob.test.ts`).
 *
 * Under "complete" a retried unit also meets its own CREATE: a family whose batch landed reaches
 * the cascade's rung 1 through the batch's own link. Its root is recognised as THIS job's creation
 * when its id is the family's SKU-keyed one (`li-sku-…`), its `createTime` is at or after the job
 * document's, and this conta's link of the store root under it carries the SAME `createTime` (one
 * batch, one commit stamp) — decided in the cascade itself, BEFORE the target (step 2): the item
 * then says `criar`, `ausente`, with the same create count, links and tax review as the attempt
 * that landed it, in a `naoNoErp` job too — never `sku-ja-existe` against itself. An ADOPTED family
 * (another conta's create at our id) is met again through this job's own root link (or, the link
 * not landed yet, through the SKU): in the target by step 2, its link `retomado`, the item
 * `encontrado` as the first attempt said it. A VARIATION THIS job added
 * to an existing family is recognised the same way, by its own link: matched (`casado`) through
 * it, a SKU-keyed id, and the link born in the variation's own commit — counted as created again,
 * the item `completar`, its tax review re-written (the add's batch made it durable first anyway).
 * ⚠️ Accepted residuals of a retried complete unit: the fields a landed fill wrote are found
 * filled, so the REPORT names none of them (`completar.ts`; the tax review of a filled category
 * was written before the fill, so the durable list loses nothing), and a `descricao-longa` or
 * `nome-cortado` of a landed create or add is not reported again (neither is re-planned), nor are
 * the `categoriasCriadas` of a landed create (the categories stand; only the item stops naming them).
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * The cascade's and the writers' own (each module states its indexes), and the create probe the
 * detail list asks before any detail is read (`familiaNova.ts`, `produtos (sku ASC)`); here only
 * documents by id: a matched produto and its `extraData` (whether a detail could fill them, {@link
 * detalhesDaFamiliaLi}; the root's stored category), a SKU-keyed root or variation and this conta's
 * link under it (this job's own create or add). No query of its own. A unit whose detail list
 * found nothing to read reuses that list's cascade instead of running it again
 * ({@link executarFamiliaLi}'s `casamento`).
 */
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore';
import { produtoCollection, produtoExtraDataCollection } from '@delfrance/data/admin/collections';
import {
  ACAO_IMPORTACAO_LI,
  CAMINHO_DO_COMPLETAR_LI,
  type CategoriaDoJobLi,
  type ContadoresImportacaoLi,
  type DetalheImportacaoLi,
  type GrupoComLinksLi,
  type ImportacaoLojaIntegrada,
  type ItemImportacaoLi,
  MODO_IMPORTACAO_LI,
  MOTIVO_REVISAO_FISCAL_LI,
  type MotivoRevisaoFiscalLi,
  PENDENCIA_IMPORTACAO_LI,
  PRODUTO_EXTRA_DATA_DOC_ID,
  type ProgressoDaFamiliaLi,
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  progressoDaFamiliaLiSchema,
} from '@delfrance/schemas';

import {
  type ResultadoCategoriaDoProdutoLi,
  TIPO_CATEGORIA_DO_PRODUTO_LI,
  resolverCategoriaDoProdutoLi,
} from './categorias';
import {
  CATEGORIA_NO_PREENCHIMENTO_LI,
  type CategoriaNoPreenchimentoLi,
  type MedidasErpLi,
  type ResultadoDoPreenchimentoLi,
  TIPO_RESULTADO_PREENCHIMENTO_LI,
  type ValoresDoLiLi,
  categoriaErpArmazenadaLi,
  planejarPreenchimentoExtraDataLi,
  planejarPreenchimentoProdutoLi,
  preencherProdutoLi,
  valoresDoLiLi,
  vazioNoErpLi,
} from './completar';
import { detalheLidoLi } from './detalhes';
import {
  PAPEL_DO_PRODUTO_CRIADO_LI,
  PREFIXO_ID_PRODUTO_CRIADO_LI,
  type ProdutoCriadoLi,
  TIPO_RESULTADO_FAMILIA_NOVA_LI,
  criadoComOVinculoDaContaLi,
  criarFamiliaLi,
  idProdutoCriadoLi,
  recusasAntesDosDetalhesLi,
} from './familiaNova';
import type { FamiliaLi, FilhoDaFamiliaLi } from './familias';
import { adicionarFilhosLi } from './filhoNovo';
import {
  type AlvoDeFotosLi,
  type CandidatoAFotosLi,
  type ResultadoFotosDaFamiliaLi,
  contarFotosSimuladasLi,
  planejarAlvosDeFotosLi,
  semFotosNoErpLi,
} from './fotos';
import type { RecusaNoRelatorioLi } from './gruposLi';
import {
  PAPEL_DO_VINCULO_LI,
  type PendenciaDoPlanoLi,
  type PlanoDaFamiliaLi,
  ocultoNaLojaLi,
  planejarFamiliaLi,
  planejarVinculoLi,
} from './plano';
import {
  type ContagemDoCompletarLi,
  contadoresDoItemLi,
  gravarItemLi,
  montarItemDaFamiliaLi,
} from './relatorio';
import {
  type ConflitoDeSkuNaLojaLi,
  type ResolucaoDaRaizLi,
  type ResolucaoDosFilhosLi,
  SITUACAO_DO_FILHO_LI,
  familiaNoAlvoLi,
  resolverFilhosLi,
  resolverRaizLi,
} from './resolucao';
import { adicionarARevisaoFiscalLi } from './revisaoFiscal';
import {
  DESFECHO_DO_VINCULO_LI,
  type ResultadoDoVinculoLi,
  type ResultadoDosVinculosLi,
  vincularFamiliaLi,
  vincularProdutoLi,
  vinculoConfirmadoLi,
} from './vinculos';

export interface DepsFamiliaLi {
  readonly db: Firestore;
  readonly jobId: string;
  /**
   * The job document's own `createTime`, from the dispatch's job read: what tells a link (and,
   * under "complete", a family) this job created from one it found (module header, "A retried
   * family").
   */
  readonly criacaoDoJob: Timestamp;
  /** The item's `atualizadoEmMs`; under "complete", every stamp a write carries (ms). */
  readonly agoraMs: () => number;
}

/** What every family of one dispatch shares (computed once per dispatch by the caller). */
export interface ContextoDasFamiliasLi {
  /** The job as last checkpointed: its options, and under "complete" its category map and brands. */
  readonly job: Pick<
    ImportacaoLojaIntegrada,
    | 'integracaoId'
    | 'modo'
    | 'alvo'
    | 'acao'
    | 'selecionados'
    | 'categorias'
    | 'mapaCategorias'
    | 'marcas'
  >;
  /** `conflitosDeSkuNaLojaLi` over the job's assembly. */
  readonly skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>;
  /** The grupos to resolve options against (`gruposParaResolverLi`). */
  readonly grupos: readonly GrupoComLinksLi[];
  /** The learning's refusals, keyed `<gradeId>_<opcaoId>` (`recusasDoAprendizadoLi`). */
  readonly recusasDoAprendizado: ReadonlyMap<string, RecusaNoRelatorioLi>;
  /**
   * Under "complete": whether this run copies the store's photos — the job asks for them
   * (`deveImportarFotosLi`) and the functions codebase found a default bucket. Absent = no.
   */
  readonly importarFotos?: boolean;
}

/** How one family unit ended. */
export type ResultadoDaFamiliaLi =
  /** Outside the job's target and not reported: nothing resolved past the root, nothing written. */
  | {
      readonly tipo: 'fora-do-alvo';
      readonly plano: PlanoDaFamiliaLi;
      /** The job's category map, unchanged. */
      readonly mapaCategorias: readonly CategoriaDoJobLi[];
    }
  /** Planned, linked (or decided) and reported; `contadores` is the item's delta. */
  | {
      readonly tipo: 'relatado';
      readonly plano: PlanoDaFamiliaLi;
      readonly vinculos: ResultadoDosVinculosLi;
      readonly item: ItemImportacaoLi;
      readonly contadores: ContadoresImportacaoLi;
      /** The job's category map after this family: the caller checkpoints it with the unit. */
      readonly mapaCategorias: readonly CategoriaDoJobLi[];
    }
  /**
   * `aplicar` under "complete": the family is PREPARED and has pictures to fetch. The caller
   * checkpoints `progresso` (and the map) and drives the photo units, then {@link fecharFamiliaLi}.
   */
  | {
      readonly tipo: 'fotos';
      readonly progresso: ProgressoDaFamiliaLi;
      readonly mapaCategorias: readonly CategoriaDoJobLi[];
    };

/** The `relatado` member of {@link ResultadoDaFamiliaLi}. */
export type FamiliaRelatadaLi = Extract<ResultadoDaFamiliaLi, { readonly tipo: 'relatado' }>;

/** Where the cascade and the plan put one family (module header, "Order", steps 1–4). */
interface CasamentoLi {
  readonly raiz: ResolucaoDaRaizLi;
  readonly filhos: ResolucaoDosFilhosLi | null;
  readonly plano: PlanoDaFamiliaLi;
  /**
   * The matched root's snapshot when it is THIS job's create, landed by an earlier attempt of the
   * unit (module header, "A retried family"); `null` otherwise, and always under Simular.
   */
  readonly criadaPorEsteJob: DocumentSnapshot | null;
}

/**
 * The cascade and plan of one family, as {@link detalhesDaFamiliaLi} computed them: handed back to
 * {@link executarFamiliaLi} by a caller in the SAME unit, over the same family and context.
 */
export type CasamentoDaFamiliaLi = CasamentoLi;

const matched = (
  r: ResolucaoDaRaizLi,
): r is Extract<ResolucaoDaRaizLi, { readonly erpId: string }> =>
  r.tipo === SITUACAO_ERP_ITEM_LI.vinculado || r.tipo === SITUACAO_ERP_ITEM_LI.encontrado;

/** What the cascade needs of the deps: the ERP, and the job's `createTime` (its own creates). */
type DepsDoCasamentoLi = Pick<DepsFamiliaLi, 'db' | 'criacaoDoJob'>;

const AUSENTE: ResolucaoDaRaizLi = { tipo: SITUACAO_ERP_ITEM_LI.ausente };

/**
 * The matched root's document when it shows the family was ABSENT from the ERP when the job
 * started (module header, "Order", step 2): "complete" only, the root at the id the family's own
 * create takes (`idProdutoCriadoLi` of the store root's SKU — only an import writes there) and
 * created at or after the job document. Its snapshot, else `null`. ONE document by id, read only
 * where its answer can matter: a root `vinculado` under `aplicar` (it may be this job's own create,
 * {@link criadaPorEsteJobDoSnapLi}), or a match that leaves the family outside a target an `ausente`
 * root is in (`naoNoErp`). A root at any other id keeps the cascade's answer: an adoption only ever
 * meets a root at this one.
 */
async function raizNascidaDuranteOJobLi(
  deps: DepsDoCasamentoLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  raiz: ResolucaoDaRaizLi,
): Promise<DocumentSnapshot | null> {
  if (ctx.job.acao !== ACAO_IMPORTACAO_LI.completar || !matched(raiz)) return null;
  const sku = familia.raiz.sku;
  if (sku === null || sku === '' || raiz.erpId !== idProdutoCriadoLi(sku)) return null;
  const propria =
    ctx.job.modo === MODO_IMPORTACAO_LI.aplicar && raiz.tipo === SITUACAO_ERP_ITEM_LI.vinculado;
  const mudaOAlvo =
    !familiaNoAlvoLi(ctx.job, familia.raiz.id, raiz) &&
    familiaNoAlvoLi(ctx.job, familia.raiz.id, AUSENTE);
  if (!propria && !mudaOAlvo) return null;
  const snap = await produtoCollection.docRef(deps.db, {}, raiz.erpId).get();
  const criado = snap.createTime;
  if (!snap.exists || criado === undefined) return null;
  return criado.valueOf() >= deps.criacaoDoJob.valueOf() ? snap : null;
}

/**
 * The matched root when it is THIS job's create, landed by an earlier attempt of the unit (module
 * header, "A retried family"): `aplicar`, matched through this conta's link, born during the job
 * ({@link raizNascidaDuranteOJobLi}'s `nascida`), and this conta's link of the store root under it
 * created in the SAME commit. Its snapshot, else `null`. One link document by id.
 */
async function criadaPorEsteJobDoSnapLi(
  deps: DepsDoCasamentoLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  raiz: ResolucaoDaRaizLi,
  nascida: DocumentSnapshot | null,
): Promise<DocumentSnapshot | null> {
  if (nascida === null || ctx.job.modo !== MODO_IMPORTACAO_LI.aplicar) return null;
  if (raiz.tipo !== SITUACAO_ERP_ITEM_LI.vinculado) return null;
  return (await criadoComOVinculoDaContaLi(deps.db, ctx.job.integracaoId, nascida, familia.raiz.id))
    ? nascida
    : null;
}

/** How a re-run of the cascade inside a unit is told the target the unit already decided. */
interface OpcoesDoCasamentoLi {
  /**
   * The target as the unit decided it BEFORE its own writes (module header, "Order", step 2): the
   * adoption's re-run and the photo closing pass the preparation's verdict. The root is then never
   * asked when it was born (both callers met it as someone else's).
   */
  readonly alvoDecidido?: boolean;
}

/** Steps 1–4 for `familia`. */
async function casarFamilia(
  deps: DepsDoCasamentoLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  opcoes: OpcoesDoCasamentoLi = {},
): Promise<CasamentoLi> {
  const resolucao = { db: deps.db, contaId: ctx.job.integracaoId };
  const raiz = await resolverRaizLi(resolucao, familia, ctx.skusEmConflito);
  const nascida =
    opcoes.alvoDecidido === undefined
      ? await raizNascidaDuranteOJobLi(deps, ctx, familia, raiz)
      : null;
  const criadaPorEsteJob = await criadaPorEsteJobDoSnapLi(deps, ctx, familia, raiz, nascida);
  // A root born during the job (this job's create, or another conta's it adopted or met) was
  // `ausente` when the job STARTED: the family is also in the target that verdict puts it in.
  const noAlvo =
    opcoes.alvoDecidido ??
    (familiaNoAlvoLi(ctx.job, familia.raiz.id, raiz) ||
      (nascida !== null && familiaNoAlvoLi(ctx.job, familia.raiz.id, AUSENTE)));

  let filhos: ResolucaoDosFilhosLi | null = null;
  if (noAlvo && familia.raiz.tipo === TIPO_PRODUTO_LI.atributo && matched(raiz)) {
    filhos = await resolverFilhosLi(resolucao, familia, raiz.erpId, {
      grupos: ctx.grupos,
      skusEmConflito: ctx.skusEmConflito,
    });
  }

  const plano = planejarFamiliaLi({
    job: ctx.job,
    familia,
    raiz,
    filhos,
    skusEmConflito: ctx.skusEmConflito,
    recusasDoAprendizado: ctx.recusasDoAprendizado,
    noAlvo,
  });
  return { raiz, filhos, plano, criadaPorEsteJob };
}

/**
 * Run one family's unit (module header, "Order"): under "only link" the whole family; under
 * "complete" its preparation, then — when nothing is to be fetched (no photo, or Simular) — its
 * closing in the same unit; otherwise `fotos`, for the caller's photo units. `casamento`: the
 * cascade {@link detalhesDaFamiliaLi} ran over this SAME family and context in this SAME unit,
 * reused instead of running it again (absent ⇒ it runs here).
 */
export async function executarFamiliaLi(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamentoDaUnidade?: CasamentoDaFamiliaLi,
): Promise<ResultadoDaFamiliaLi> {
  const casamento = casamentoDaUnidade ?? (await casarFamilia(deps, ctx, familia));
  const { plano } = casamento;
  if (!plano.relatar) {
    return { tipo: 'fora-do-alvo', plano, mapaCategorias: ctx.job.mapaCategorias };
  }
  if (ctx.job.acao === ACAO_IMPORTACAO_LI.completar) {
    return completarFamilia(deps, ctx, familia, casamento);
  }

  const vinculos = await vincularFamiliaLi(depsDosVinculos(deps, ctx), plano);
  const item = montarItemDaFamiliaLi({
    familia,
    plano,
    vinculos,
    modo: ctx.job.modo,
    agoraMs: deps.agoraMs(),
  });
  await gravarItemLi(deps.db, deps.jobId, item);
  return {
    tipo: 'relatado',
    plano,
    vinculos,
    item,
    contadores: contadoresDoItemLi(item, vinculos),
    mapaCategorias: ctx.job.mapaCategorias,
  };
}

function depsDosVinculos(deps: DepsFamiliaLi, ctx: ContextoDasFamiliasLi) {
  return {
    db: deps.db,
    contaId: ctx.job.integracaoId,
    modo: ctx.job.modo,
    criacaoDoJob: deps.criacaoDoJob,
  };
}

/* -------------------------------------------------------------------------- */
/*                           The details a family needs                        */
/* -------------------------------------------------------------------------- */

/**
 * `familia` with every detail `detalhes` holds attached where the assembly had none (the details
 * the complete step read for it, `familias.filhosLidos`). The family's shape never changes: a root
 * or a listed variation only gains its detail. Pure.
 */
export function comDetalhesLi(
  familia: FamiliaLi,
  detalhes: ReadonlyMap<number, DetalheImportacaoLi>,
): FamiliaLi {
  return {
    ...familia,
    detalheDaRaiz: familia.detalheDaRaiz ?? detalheLidoLi(detalhes, familia.raiz.id),
    filhos: familia.filhos.map((f) => ({
      ...f,
      detalhe: f.detalhe ?? detalheLidoLi(detalhes, f.linha.id),
    })),
  };
}

/** A store value for every detail-sourced field, to ask the fill planner what an empty ERP takes. */
function sonda(
  medidas: MedidasErpLi,
  descricao: string | null,
  marca: string | null,
): ValoresDoLiLi {
  return {
    gtin: null,
    medidas,
    categoriaErpId: null,
    descricao,
    descricaoLongaTamanho: null,
    marca,
  };
}

const TODAS_AS_MEDIDAS: MedidasErpLi = {
  pesoKg: 1,
  alturaCm: 1,
  larguraCm: 1,
  profundidadeCm: 1,
};
const SO_A_CAIXA: MedidasErpLi = { pesoKg: null, alturaCm: 1, larguraCm: 1, profundidadeCm: 1 };
const NENHUMA_MEDIDA: MedidasErpLi = {
  pesoKg: null,
  alturaCm: null,
  larguraCm: null,
  profundidadeCm: null,
};

/** A produto and its extraData as stored (raw; the extraData `null` when absent). */
interface ProdutoArmazenadoLi {
  readonly produto: Readonly<Record<string, unknown>>;
  readonly extra: Readonly<Record<string, unknown>> | null;
}

async function lerArmazenado(
  db: Firestore,
  produtoId: string,
): Promise<ProdutoArmazenadoLi | null> {
  const [produto, extra] = await Promise.all([
    produtoCollection.docRef(db, {}, produtoId).get(),
    produtoExtraDataCollection.docRef(db, { produtoId }, PRODUTO_EXTRA_DATA_DOC_ID).get(),
  ]);
  if (!produto.exists) return null;
  return {
    produto: (produto.data() ?? {}) as Record<string, unknown>,
    extra: extra.exists ? ((extra.data() ?? {}) as Record<string, unknown>) : null,
  };
}

/** Whether the fill would write any field of `a` that only `valores` (a detail's) could give. */
function preenche(a: ProdutoArmazenadoLi, valores: ValoresDoLiLi): boolean {
  return (
    planejarPreenchimentoProdutoLi(a.produto, valores).campos.length > 0 ||
    planejarPreenchimentoExtraDataLi(a.extra, valores).campos.length > 0
  );
}

/**
 * What completing `familia` needs before its preparation: the store ids whose DETAIL it needs, root
 * first, then its variations ascending (the plan's cost rule: a detail is read only where it can
 * change something), and the cascade that answer was decided on, for {@link executarFamiliaLi} to
 * reuse when the caller runs the family in the same unit. Reads the cascade's own reads, the
 * matched produtos by id and — for a family the ERP lacks — the create probe; calls nothing outside
 * the ERP. No id under "only link" (and no cascade), outside the target, for a refused or
 * conflicting family, for a family this job already created. The caller drops the ids whose detail
 * the job already holds or tried (the `orfaos` phase's, or one this family's earlier units read).
 *
 *  - A family the ERP lacks, whose create the plan classifies viable: the root and every variation
 *    the create would add (a create is decided only over a whole family) — unless a check that
 *    needs no detail already refuses the create (an option, a combination, the probe over the rows'
 *    SKUs: `recusasAntesDosDetalhesLi`), which then costs no call; the create reports it.
 *  - A family the ERP has: the root when it has an empty field a detail fills (weight, box,
 *    description, brand) or — when the run copies photos — no photo (its pictures are the detail's);
 *    a matched variation when it has an empty weight, box or description of its own; a variation
 *    whose box is empty also needs ITS detail (only a read detail without a box inherits the
 *    parent's) and the PARENT's, and one whose brand is empty the parent's; a variation the family
 *    may ADD (visible, with a SKU in no conflict in the store, every option resolved) its own and the
 *    parent's. When the run copies photos and any variation's detail is read, the root's is too:
 *    a variation's pictures are copied only when they are not its parent's set (`fotos.ts`), which
 *    only the parent's detail can say. A variation whose detail is not otherwise needed is never
 *    read for its photos alone: a detail never read gives no picture (`fotos.ts`, "Which").
 */
export async function detalhesDaFamiliaLi(
  deps: DepsDoCasamentoLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
): Promise<DetalhesDaFamiliaLi> {
  if (ctx.job.acao !== ACAO_IMPORTACAO_LI.completar) return { ids: [], casamento: null };
  const casamento = await casarFamilia(deps, ctx, familia);
  const ids = await idsADetalhar(deps.db, ctx, familia, casamento);
  return { ids, casamento };
}

/** {@link detalhesDaFamiliaLi}'s answer. */
export interface DetalhesDaFamiliaLi {
  readonly ids: readonly number[];
  /** The cascade the ids were decided on; `null` under "only link" (none ran). */
  readonly casamento: CasamentoDaFamiliaLi | null;
}

async function idsADetalhar(
  db: Firestore,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
): Promise<number[]> {
  const { raiz, filhos, plano } = casamento;
  if (!plano.noAlvo) return [];
  // This job's own landed create: every detail it took was read before it.
  if (casamento.criadaPorEsteJob !== null) return [];
  if (raiz.tipo === SITUACAO_ERP_ITEM_LI.ausente) {
    if (plano.criacao?.viavel !== true) return [];
    const recusas = await recusasAntesDosDetalhesLi(
      { db, contaId: ctx.job.integracaoId },
      { familia, criacao: plano.criacao, grupos: ctx.grupos },
    );
    return recusas.length > 0 ? [] : [familia.raiz.id, ...plano.criacao.filhos];
  }
  if (!matched(raiz)) return [];

  const armazenadaRaiz = await lerArmazenado(db, raiz.erpId);
  if (armazenadaRaiz === null) return [];
  let precisaRaiz =
    preenche(armazenadaRaiz, sonda(TODAS_AS_MEDIDAS, 'x', 'x')) ||
    (ctx.importarFotos === true && semFotosNoErpLi(armazenadaRaiz.produto));
  const ids: number[] = [];
  const porId = new Map<number, FilhoDaFamiliaLi>(familia.filhos.map((f) => [f.linha.id, f]));
  for (const r of filhos?.filhos ?? []) {
    if (r.situacao === SITUACAO_DO_FILHO_LI.casado && r.erp !== null) {
      const armazenado = await lerArmazenado(db, r.erp.id);
      if (armazenado === null) continue;
      const semCaixa = preenche(armazenado, sonda(SO_A_CAIXA, null, null));
      const semMarca = preenche(armazenado, sonda(NENHUMA_MEDIDA, null, 'x'));
      if (semCaixa || preenche(armazenado, sonda(TODAS_AS_MEDIDAS, 'x', null))) ids.push(r.liId);
      if (semCaixa || semMarca) precisaRaiz = true;
      continue;
    }
    const linha = porId.get(r.liId)?.linha;
    const podeEntrar =
      r.situacao === SITUACAO_DO_FILHO_LI.ausente &&
      linha !== undefined &&
      !ocultoNaLojaLi(linha) &&
      linha.sku !== null &&
      !ctx.skusEmConflito.has(linha.sku) &&
      r.opcoes.length > 0 &&
      r.opcoes.every((o) => o.tipo === TIPO_RESOLUCAO_OPCAO_LI.resolvida);
    if (podeEntrar) {
      ids.push(r.liId);
      precisaRaiz = true;
    }
  }
  if (ctx.importarFotos === true && ids.length > 0) precisaRaiz = true;
  return precisaRaiz ? [familia.raiz.id, ...ids] : ids;
}

/* -------------------------------------------------------------------------- */
/*                         The progress between units                          */
/* -------------------------------------------------------------------------- */

/** A family's photo candidates, each with its detail's pictures (none when no detail was read). */
function candidatosDeFotos(
  familia: FamiliaLi,
  alvos: readonly { readonly produtoId: string; readonly liId: number | null }[],
): { raiz: CandidatoAFotosLi; filhos: CandidatoAFotosLi[] } | null {
  const [raiz, ...filhos] = alvos;
  if (raiz === undefined) return null;
  const porId = new Map<number, FilhoDaFamiliaLi>(familia.filhos.map((f) => [f.linha.id, f]));
  return {
    raiz: { ...raiz, imagens: familia.detalheDaRaiz?.imagens ?? [] },
    filhos: filhos.map((f) => ({
      ...f,
      imagens: f.liId === null ? [] : (porId.get(f.liId)?.detalhe?.imagens ?? []),
    })),
  };
}

/**
 * The photo targets of a family in progress (`fotos.ts`'s plan over the progress's candidates and
 * the family's details): the same list on every unit, so the cursor always names one of them.
 */
export function alvosDeFotosDaFamiliaLi(
  familia: FamiliaLi,
  progresso: {
    readonly alvos: readonly { readonly produtoId: string; readonly liId: number | null }[];
  },
): AlvoDeFotosLi[] {
  const candidatos = candidatosDeFotos(familia, progresso.alvos);
  return candidatos === null ? [] : planejarAlvosDeFotosLi(candidatos);
}

/** The photos' result as the progress keeps it (`fotos.ts`'s result, copied). */
export function resultadoFotosDoProgressoLi(
  r: ResultadoFotosDaFamiliaLi,
): NonNullable<ProgressoDaFamiliaLi['resultadoFotos']> {
  return {
    produtos: r.produtos.map((p) => ({ ...p })),
    gravadas: r.gravadas,
    pendencias: r.pendencias.map((p) => ({ ...p, referencias: [...p.referencias] })),
  };
}

/* -------------------------------------------------------------------------- */
/*                                   Complete                                  */
/* -------------------------------------------------------------------------- */

/** What the complete step gathers for one family's item, counters and tax review. */
class AcumuladoDoCompletar {
  mapa: readonly CategoriaDoJobLi[];
  readonly pendencias: PendenciaDoPlanoLi[] = [];
  readonly campos: string[] = [];
  /** The store categories this family's run created (Simular: would), each once, root-most first. */
  readonly categoriasCriadas: number[] = [];
  criados = 0;
  completados = 0;
  vinculados = 0;
  fotos = 0;
  completado = false;
  /** The tax-review entries not written yet, in the order the produtos were met. */
  readonly revisao = new Map<
    string,
    { readonly liId: number | null; readonly motivos: Set<MotivoRevisaoFiscalLi> }
  >();
  /** The motivos this unit already WROTE per produto (a write's hook, before the write). */
  readonly gravadas = new Map<string, Set<MotivoRevisaoFiscalLi>>();

  /** Whether every motivo of `motivos` is already written for `produtoId` by this unit. */
  jaGravado(produtoId: string, motivos: Iterable<MotivoRevisaoFiscalLi>): boolean {
    const feitas = this.gravadas.get(produtoId);
    return feitas !== undefined && [...motivos].every((m) => feitas.has(m));
  }

  marcarGravado(produtoId: string, motivos: Iterable<MotivoRevisaoFiscalLi>): void {
    const feitas = this.gravadas.get(produtoId) ?? new Set();
    for (const m of motivos) feitas.add(m);
    this.gravadas.set(produtoId, feitas);
  }

  constructor(mapa: readonly CategoriaDoJobLi[]) {
    this.mapa = mapa;
  }

  revisar(produtoId: string, liId: number | null, motivos: readonly MotivoRevisaoFiscalLi[]): void {
    if (motivos.length === 0) return;
    const entrada = this.revisao.get(produtoId) ?? { liId, motivos: new Set() };
    for (const m of motivos) entrada.motivos.add(m);
    this.revisao.set(produtoId, entrada);
  }

  campo(nome: string): void {
    if (!this.campos.includes(nome)) this.campos.push(nome);
  }

  categoriaCriada(liIds: readonly number[]): void {
    for (const liId of liIds) {
      if (!this.categoriasCriadas.includes(liId)) this.categoriasCriadas.push(liId);
    }
  }

  contagem(): ContagemDoCompletarLi {
    return {
      criados: this.criados,
      completados: this.completados,
      vinculados: this.vinculados,
      fotos: this.fotos,
    };
  }

  /** The photos' result joins the family's report (module header, the item). */
  comFotos(fotos: ResultadoFotosDaFamiliaLi | null): void {
    if (fotos === null) return;
    this.pendencias.push(...fotos.pendencias);
    this.fotos = fotos.gravadas;
    if (fotos.gravadas > 0) {
      this.completado = true;
      this.campo(CAMPO_FOTOS_LI);
    }
  }
}

/** The report's name for the photos the complete step copied (after the fill's field names). */
export const CAMPO_FOTOS_LI = 'fotos';

/** The root's category for the complete step: its ERP id, and whether an import created it. */
interface CategoriaDaFamiliaLi {
  readonly erpId: string | null;
  readonly criadaPelaImportacao: boolean;
}

const SEM_CATEGORIA: CategoriaDaFamiliaLi = { erpId: null, criadaPelaImportacao: false };

/** The root's store category as `categorias.ts` decided it (module header, "Complete"). */
interface CategoriaDecididaLi {
  readonly categoria: CategoriaDaFamiliaLi;
  /** Why the produto gets none, reported only with a produto that IS completed or created. */
  readonly pendencia: PendenciaDoPlanoLi | null;
  /** Store categories the decision creates and links (planned: would) before the produto takes it. */
  readonly criadas: readonly number[];
  /** The job's map after the decision (a plan's: its creates as `simulada`). */
  readonly mapa: readonly CategoriaDoJobLi[];
}

function categoriaDecidida(r: ResultadoCategoriaDoProdutoLi): CategoriaDecididaLi {
  const c = r.categoria;
  if (c.tipo === TIPO_CATEGORIA_DO_PRODUTO_LI.resolvida) {
    return {
      categoria: { erpId: c.erpCategoriaId, criadaPelaImportacao: c.criadaPelaImportacao },
      pendencia: null,
      criadas: c.criadas,
      mapa: r.mapaCategorias,
    };
  }
  return {
    categoria: SEM_CATEGORIA,
    pendencia:
      c.tipo === TIPO_CATEGORIA_DO_PRODUTO_LI.recusada
        ? { codigo: c.pendencia, liId: null, referencias: c.referencias }
        : null,
    criadas: c.tipo === TIPO_CATEGORIA_DO_PRODUTO_LI.recusada ? c.criadas : [],
    mapa: r.mapaCategorias,
  };
}

function resolverCategoria(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  modo: typeof MODO_IMPORTACAO_LI.simular | typeof MODO_IMPORTACAO_LI.aplicar,
  mapa: readonly CategoriaDoJobLi[],
): Promise<ResultadoCategoriaDoProdutoLi> {
  return resolverCategoriaDoProdutoLi(
    {
      db: deps.db,
      contaId: ctx.job.integracaoId,
      modo,
      categorias: ctx.job.categorias,
      agoraMs: deps.agoraMs,
    },
    mapa,
    familia.raiz.categorias,
  );
}

/**
 * The root's store category PLANNED (module header, "Complete"): `categorias.ts` run as Simular
 * runs it, whatever the job's mode — every read, no write (the ids it would create are
 * deterministic). The job's map is not touched.
 */
async function planejarCategoriaDaRaiz(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  acc: AcumuladoDoCompletar,
): Promise<CategoriaDecididaLi> {
  return categoriaDecidida(
    await resolverCategoria(deps, ctx, familia, MODO_IMPORTACAO_LI.simular, acc.mapa),
  );
}

/**
 * The planned category CARRIED OUT, for a produto that is about to take it: under `aplicar`, the
 * resolution run for real only when the plan resolves AND creates (a linked leaf, a refusal and no
 * category write nothing); the job's map then takes the real outcome. Under Simular the plan is the
 * outcome, and the map takes its `simulada` creates. Returns the outcome — the real one, which may
 * differ from the plan when another writer acted in between. The ONE place the categories a family
 * created are recorded for its item: the real run's, a refusal's included (its first creates stand),
 * since this runs once per attempt of a create and only the record outlives an attempt.
 */
async function aplicarCategoriaDaRaiz(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  acc: AcumuladoDoCompletar,
  planejada: CategoriaDecididaLi,
): Promise<CategoriaDecididaLi> {
  if (planejada.categoria.erpId === null || planejada.criadas.length === 0) return planejada;
  if (ctx.job.modo === MODO_IMPORTACAO_LI.simular) {
    acc.mapa = planejada.mapa;
    acc.categoriaCriada(planejada.criadas);
    return planejada;
  }
  const real = categoriaDecidida(
    await resolverCategoria(deps, ctx, familia, MODO_IMPORTACAO_LI.aplicar, acc.mapa),
  );
  acc.mapa = real.mapa;
  acc.categoriaCriada(real.criadas);
  return real;
}

/** Write now (`aplicar` only) the tax-review entries a write is about to call for (module header). */
async function gravarRevisaoAntes(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  acc: AcumuladoDoCompletar,
  entradas: readonly {
    readonly produtoId: string;
    readonly liId: number | null;
    readonly motivos: readonly MotivoRevisaoFiscalLi[];
  }[],
): Promise<void> {
  if (ctx.job.modo !== MODO_IMPORTACAO_LI.aplicar) return;
  await Promise.all(
    entradas.map(async ({ produtoId, liId, motivos }) => {
      if (motivos.length === 0 || acc.jaGravado(produtoId, motivos)) return;
      await adicionarARevisaoFiscalLi(deps.db, deps.jobId, {
        produtoId,
        motivos: [...motivos],
        liId,
        desdeJobId: deps.jobId,
        desdeMs: deps.agoraMs(),
      });
      acc.marcarGravado(produtoId, motivos);
    }),
  );
}

/** The tax-review motivos of a CREATED produto (module header, "The tax review"). */
function motivosDoCriado(categoria: CategoriaDaFamiliaLi): MotivoRevisaoFiscalLi[] {
  if (categoria.erpId === null) {
    return [MOTIVO_REVISAO_FISCAL_LI.produtoCriado, MOTIVO_REVISAO_FISCAL_LI.semCategoria];
  }
  return categoria.criadaPelaImportacao
    ? [MOTIVO_REVISAO_FISCAL_LI.produtoCriado, MOTIVO_REVISAO_FISCAL_LI.categoriaCriada]
    : [MOTIVO_REVISAO_FISCAL_LI.produtoCriado];
}

/** The tax-review motivos of an EXISTING produto after its fill. */
function motivosDoPreenchido(
  categoria: CategoriaNoPreenchimentoLi,
  dada: CategoriaDaFamiliaLi,
): MotivoRevisaoFiscalLi[] {
  if (categoria === CATEGORIA_NO_PREENCHIMENTO_LI.vazia) {
    return [MOTIVO_REVISAO_FISCAL_LI.semCategoria];
  }
  if (categoria === CATEGORIA_NO_PREENCHIMENTO_LI.existente) return [];
  return dada.criadaPelaImportacao
    ? [MOTIVO_REVISAO_FISCAL_LI.categoriaPreenchida, MOTIVO_REVISAO_FISCAL_LI.categoriaCriada]
    : [MOTIVO_REVISAO_FISCAL_LI.categoriaPreenchida];
}

/**
 * Whether ERP categoria `erpId` is one an import of conta `contaId` created: the id
 * `idCategoriaCriadaLi` gives, `li-<contaId>-<store id>` (the store id digits only). Such a categoria
 * has no tax setting of its own, so a produto it lands on joins the tax review (`categoria-criada`).
 */
function criadaPorImportacaoLi(contaId: string, erpId: string): boolean {
  const prefixo = `li-${contaId}-`;
  return erpId.startsWith(prefixo) && /^[1-9]\d{0,14}$/.test(erpId.slice(prefixo.length));
}

/** A categoria id read back as the family's (its creator recognised by its id). */
function categoriaDaFamiliaPeloId(contaId: string, erpId: string | null): CategoriaDaFamiliaLi {
  return erpId === null
    ? SEM_CATEGORIA
    : { erpId, criadaPelaImportacao: criadaPorImportacaoLi(contaId, erpId) };
}

/** A stored category read back as the family's (its creator recognised by its id). */
function categoriaDaFamiliaArmazenada(
  contaId: string,
  produto: Readonly<Record<string, unknown>>,
): CategoriaDaFamiliaLi {
  return categoriaDaFamiliaPeloId(contaId, categoriaErpArmazenadaLi(produto));
}

/**
 * The variations' category (module header, "Complete"): the root's as its fill LEFT it — the one
 * the fill wrote (Simular: would), else the one its last read found stored, else none — never the
 * one resolved before the fill, which an operator's edit or a lost race may have kept off the root.
 */
function categoriaDosFilhosLi(
  contaId: string,
  daRaiz: Extract<ResultadoDoPreenchimentoLi, { readonly tipo: 'preenchido' }>,
  resolvida: CategoriaDaFamiliaLi,
): CategoriaDaFamiliaLi {
  if (daRaiz.categoria === CATEGORIA_NO_PREENCHIMENTO_LI.preenchida) return resolvida;
  return categoriaDaFamiliaPeloId(contaId, daRaiz.categoriaErpId);
}

/**
 * Fill ONE existing produto and account for it: its fill's outcome, or `null` when the produto is
 * gone (its link is then not written). The tax review a filled EMPTY category calls for is written
 * BEFORE the write that fills it (module header, "The tax review").
 */
async function preencher(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  acc: AcumuladoDoCompletar,
  alvo: {
    readonly produtoId: string;
    readonly liId: number | null;
    readonly valores: ValoresDoLiLi;
    readonly categoria: CategoriaDaFamiliaLi;
  },
): Promise<Extract<ResultadoDoPreenchimentoLi, { readonly tipo: 'preenchido' }> | null> {
  const r = await preencherProdutoLi(
    {
      db: deps.db,
      modo: ctx.job.modo,
      agoraMs: deps.agoraMs,
      antesDePreencherCategoria: () =>
        gravarRevisaoAntes(deps, ctx, acc, [
          {
            produtoId: alvo.produtoId,
            liId: alvo.liId,
            motivos: motivosDoPreenchido(CATEGORIA_NO_PREENCHIMENTO_LI.preenchida, alvo.categoria),
          },
        ]),
    },
    { produtoId: alvo.produtoId, liId: alvo.liId, valores: alvo.valores },
  );
  acc.pendencias.push(...r.pendencias);
  if (r.tipo === TIPO_RESULTADO_PREENCHIMENTO_LI.ausente) return null;
  for (const campo of r.campos) acc.campo(campo);
  const simular = ctx.job.modo === MODO_IMPORTACAO_LI.simular;
  if (simular ? r.campos.length > 0 : r.gravado) {
    acc.completados += 1;
    acc.completado = true;
  }
  acc.revisar(alvo.produtoId, alvo.liId, motivosDoPreenchido(r.categoria, alvo.categoria));
  return r;
}

/**
 * Write the tax-review entries gathered so far (`aplicar` only), in the order the produtos were met,
 * and forget them: each unit writes the entries it decided. An entry whose every motivo this unit
 * already wrote before a write (module header, "The tax review") costs nothing more.
 */
async function gravarRevisao(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  acc: AcumuladoDoCompletar,
): Promise<void> {
  if (ctx.job.modo === MODO_IMPORTACAO_LI.aplicar) {
    for (const [produtoId, { liId, motivos }] of acc.revisao) {
      if (acc.jaGravado(produtoId, motivos)) continue;
      await adicionarARevisaoFiscalLi(deps.db, deps.jobId, {
        produtoId,
        motivos: [...motivos],
        liId,
        desdeJobId: deps.jobId,
        desdeMs: deps.agoraMs(),
      });
      acc.marcarGravado(produtoId, motivos);
    }
  }
  acc.revisao.clear();
}

const SEM_VINCULOS: ResultadoDosVinculosLi = { raiz: null, filhos: [] };

/** How a family's preparation ended (module header, "Complete"). */
type PreparoLi =
  /** A family the ERP has, filled: the links, the adds and the item are the closing's. */
  | {
      readonly tipo: typeof CAMINHO_DO_COMPLETAR_LI.existente;
      readonly casamento: CasamentoLi;
      readonly erpRaizId: string;
      /** The variations' category. */
      readonly categoria: CategoriaDaFamiliaLi;
      readonly sumidos: ReadonlySet<string>;
      readonly alvos: readonly { readonly produtoId: string; readonly liId: number | null }[];
    }
  /** A family this job created (or would: Simular), links in its batch. */
  | {
      readonly tipo: typeof CAMINHO_DO_COMPLETAR_LI.criada;
      readonly plano: PlanoDaFamiliaLi;
      readonly erpRaizId: string;
      readonly categoria: CategoriaDaFamiliaLi;
      readonly alvos: readonly { readonly produtoId: string; readonly liId: number | null }[];
    }
  /** Nothing to complete (refused, in conflict, not creatable): the plan and, maybe, links. */
  | {
      readonly tipo: 'nada';
      readonly plano: PlanoDaFamiliaLi;
      readonly criacaoRecusada: boolean;
    };

/** The unit's complete path (module header, "Complete"). */
async function completarFamilia(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
): Promise<ResultadoDaFamiliaLi> {
  const acc = new AcumuladoDoCompletar(ctx.job.mapaCategorias);
  const preparo = await prepararFamilia(deps, ctx, familia, casamento, acc);
  await gravarRevisao(deps, ctx, acc);

  const alvos =
    preparo.tipo === 'nada' || ctx.importarFotos !== true
      ? []
      : alvosDeFotosDaFamiliaLi(familia, { alvos: preparo.alvos });
  if (alvos.length > 0 && ctx.job.modo === MODO_IMPORTACAO_LI.aplicar && preparo.tipo !== 'nada') {
    return {
      tipo: 'fotos',
      progresso: paraProgresso(familia, preparo, acc),
      mapaCategorias: acc.mapa,
    };
  }
  let fotos: ResultadoFotosDaFamiliaLi | null = null;
  if (alvos.length > 0 && preparo.tipo !== 'nada') {
    // Simular: counted, nothing fetched; a produto the run would create is counted with no read.
    const criados = new Set(
      preparo.tipo === CAMINHO_DO_COMPLETAR_LI.criada ? preparo.alvos.map((a) => a.produtoId) : [],
    );
    fotos = await contarFotosSimuladasLi(deps.db, alvos, criados);
  }
  return fechar(deps, ctx, familia, preparo, acc, fotos);
}

/** The progress of a prepared family whose photos are to be fetched. */
function paraProgresso(
  familia: FamiliaLi,
  preparo: Exclude<PreparoLi, { readonly tipo: 'nada' }>,
  acc: AcumuladoDoCompletar,
): ProgressoDaFamiliaLi {
  return progressoDaFamiliaLiSchema.parse({
    raizLiId: familia.raiz.id,
    caminho: preparo.tipo,
    erpRaizId: preparo.erpRaizId,
    categoria: preparo.categoria,
    criacaoAplicada: preparo.tipo === CAMINHO_DO_COMPLETAR_LI.criada,
    completado: acc.completado,
    campos: [...acc.campos],
    pendencias: acc.pendencias.map((p) => ({ ...p, referencias: [...p.referencias] })),
    categoriasCriadas: [...acc.categoriasCriadas],
    criados: acc.criados,
    completados: acc.completados,
    vinculados: acc.vinculados,
    sumidos: preparo.tipo === CAMINHO_DO_COMPLETAR_LI.existente ? [...preparo.sumidos] : [],
    alvos: preparo.alvos.map((a) => ({ produtoId: a.produtoId, liId: a.liId })),
    fotos: null,
    resultadoFotos: null,
  });
}

/** The preparation (module header, "Complete"): a create, or the fills of a family the ERP has. */
async function prepararFamilia(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
  acc: AcumuladoDoCompletar,
): Promise<PreparoLi> {
  const { raiz, plano } = casamento;
  if (raiz.tipo === SITUACAO_ERP_ITEM_LI.ausente && plano.criacao?.viavel === true) {
    return criarFamilia(deps, ctx, familia, casamento, plano.criacao, acc);
  }
  if (!matched(raiz)) return { tipo: 'nada', plano, criacaoRecusada: false };

  const criadaAntes = await criadaPorEsteJob(deps, ctx, familia, casamento);
  if (criadaAntes === null) return prepararExistente(deps, ctx, familia, casamento, acc);
  // A retried unit meeting this job's own landed create: what it created counts as created again,
  // and nothing of it as filled (a landed create leaves nothing for the fill to write).
  acc.criados = criadaAntes.criados;
  acc.vinculados = criadaAntes.criados;
  for (const p of criadaAntes.produtos) {
    acc.revisar(p.produtoId, p.liId, motivosDoCriado(criadaAntes.categoria));
  }
  return {
    tipo: CAMINHO_DO_COMPLETAR_LI.criada,
    plano: criadaAntes.plano,
    erpRaizId: raiz.erpId,
    categoria: criadaAntes.categoria,
    alvos: criadaAntes.produtos.filter((p) => !p.membro),
  };
}

/**
 * A family the ERP lacks, CREATED (module header, "Complete"): its category planned with no write,
 * the whole family through `familiaNova.ts` — whose `antesDoLote`, once every refusal and the
 * probe passed, creates the planned categories and makes the family's tax review durable right
 * before the batch — or ADOPTED when another writer's root holds our id.
 */
async function criarFamilia(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
  criacao: NonNullable<PlanoDaFamiliaLi['criacao']>,
  acc: AcumuladoDoCompletar,
): Promise<PreparoLi> {
  const { plano } = casamento;
  const planejada = await planejarCategoriaDaRaiz(deps, ctx, familia, acc);
  // What `antesDoLote` carried out, when it ran (a holder: it is set inside the hook).
  const lote: { aplicada: CategoriaDecididaLi | null } = { aplicada: null };
  const revisaoDoLote = (produtos: readonly ProdutoCriadoLi[], categoria: CategoriaDaFamiliaLi) =>
    produtos.map((p) => ({
      produtoId: p.produtoId,
      liId: p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
      motivos: motivosDoCriado(categoria),
    }));
  const r = await criarFamiliaLi(
    {
      db: deps.db,
      contaId: ctx.job.integracaoId,
      modo: ctx.job.modo,
      agoraMs: deps.agoraMs,
      antesDoLote: async (produtos) => {
        const real = await aplicarCategoriaDaRaiz(deps, ctx, familia, acc, planejada);
        lote.aplicada = real;
        // Another writer changed what the category comes to since the plan: the batch was planned
        // on the plan's, so it is not committed.
        if (real.categoria.erpId !== planejada.categoria.erpId) {
          return [
            real.pendencia ?? {
              codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
              liId: null,
              referencias: [planejada.categoria.erpId ?? ''],
            },
          ];
        }
        await gravarRevisaoAntes(deps, ctx, acc, revisaoDoLote(produtos, real.categoria));
        return null;
      },
    },
    {
      familia,
      criacao,
      grupos: ctx.grupos,
      categoriaErpId: planejada.categoria.erpId,
      marcas: ctx.job.marcas,
    },
  );
  if (r.tipo === TIPO_RESULTADO_FAMILIA_NOVA_LI.criada) {
    // Simular, or an earlier attempt's batch met again (`retomada`): the plan carried out now — under
    // Simular its `simulada` map, under `aplicar` the categories that batch already took, adopted.
    const final: CategoriaDecididaLi =
      lote.aplicada ?? (await aplicarCategoriaDaRaiz(deps, ctx, familia, acc, planejada));
    const { categoria } = final;
    if (final.pendencia !== null) acc.pendencias.push(final.pendencia);
    acc.criados = r.produtos.filter((p) => p.papel !== PAPEL_DO_PRODUTO_CRIADO_LI.membro).length;
    acc.vinculados = r.vinculos.length;
    acc.pendencias.push(...r.pendencias);
    for (const e of revisaoDoLote(r.produtos, categoria))
      acc.revisar(e.produtoId, e.liId, e.motivos);
    return {
      tipo: CAMINHO_DO_COMPLETAR_LI.criada,
      plano,
      erpRaizId: r.raizId,
      categoria,
      // The sole member is never a photo target: its root carries the pictures.
      alvos: r.produtos
        .filter((p) => p.papel !== PAPEL_DO_PRODUTO_CRIADO_LI.membro)
        .map((p) => ({
          produtoId: p.produtoId,
          liId: p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
        })),
    };
  }
  if (r.tipo === TIPO_RESULTADO_FAMILIA_NOVA_LI.recusada) {
    // Nothing imported: no category pendência rides the refusal (it named no produto's category).
    acc.pendencias.push(...r.pendencias);
    return { tipo: 'nada', plano, criacaoRecusada: true };
  }
  // Another writer (another conta's job, a person) created this SKU's root at our id: adopt it,
  // through the cascade again — in the target this unit decided — and complete it as a family the
  // ERP has. A cascade that no longer matches it reports its OWN verdict (another shape, a second
  // root with the SKU); only a root found gone is a lost write.
  const adotada = await casarFamilia(deps, ctx, familia, { alvoDecidido: plano.noAlvo });
  if (matched(adotada.raiz)) return prepararExistente(deps, ctx, familia, adotada, acc);
  if (adotada.raiz.tipo === SITUACAO_ERP_ITEM_LI.ausente) {
    acc.pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      liId: null,
      referencias: [r.raizId],
    });
    return { tipo: 'nada', plano, criacaoRecusada: true };
  }
  return { tipo: 'nada', plano: adotada.plano, criacaoRecusada: true };
}

/** A family this job created in an earlier attempt of the unit (module header, "A retried family"). */
interface CriadaPorEsteJobLi {
  /** The plan the attempt that created it made (the root `ausente`, the create viable). */
  readonly plano: PlanoDaFamiliaLi;
  /** The produtos of the family that share the root's commit stamp (the batch's). */
  readonly produtos: readonly {
    readonly produtoId: string;
    readonly liId: number | null;
    readonly membro: boolean;
  }[];
  /** What the create counted: the root and its variations, a sole member not apart from its root. */
  readonly criados: number;
  /** The category the create wrote on the root. */
  readonly categoria: CategoriaDaFamiliaLi;
}

/**
 * The matched root as THIS job's create, landed by an earlier attempt of this unit (module header,
 * "A retried family"), with the produtos of its batch — when the cascade recognised it
 * (`criadaPorEsteJobDoSnapLi`: the family's SKU-keyed id, created at or after the job document, with
 * this conta's link of the store root created in the same commit). `null` otherwise.
 */
async function criadaPorEsteJob(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
): Promise<CriadaPorEsteJobLi | null> {
  const { raiz, filhos, criadaPorEsteJob: snap } = casamento;
  const criado = snap?.createTime;
  if (snap === null || criado === undefined || !matched(raiz)) return null;
  const dados = (snap.data() ?? {}) as Record<string, unknown>;
  const produtos: { produtoId: string; liId: number | null; membro: boolean }[] = [
    { produtoId: raiz.erpId, liId: null, membro: false },
  ];
  const simples = familia.raiz.tipo === TIPO_PRODUTO_LI.normal;
  const membro = dados.filhoUnicoId;
  if (simples && typeof membro === 'string' && membro !== '') {
    produtos.push({ produtoId: membro, liId: null, membro: true });
  }
  for (const r of filhos?.filhos ?? []) {
    if (r.situacao !== SITUACAO_DO_FILHO_LI.casado || r.erp === null) continue;
    const doFilho: DocumentSnapshot = await produtoCollection.docRef(deps.db, {}, r.erp.id).get();
    if (doFilho.createTime?.isEqual(criado) === true) {
      produtos.push({ produtoId: r.erp.id, liId: r.liId, membro: false });
    }
  }
  const criados = simples ? 1 : produtos.length;
  const plano = planejarFamiliaLi({
    job: ctx.job,
    familia,
    raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
    filhos: null,
    skusEmConflito: ctx.skusEmConflito,
    recusasDoAprendizado: ctx.recusasDoAprendizado,
  });
  if (plano.criacao?.viavel !== true) return null;
  return {
    plano,
    produtos,
    criados,
    categoria: categoriaDaFamiliaArmazenada(ctx.job.integracaoId, dados),
  };
}

/** The values the fill takes for one variation of `familia`. */
function valoresDoFilho(
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  filho: FilhoDaFamiliaLi,
  categoria: CategoriaDaFamiliaLi,
): ValoresDoLiLi {
  return valoresDoLiLi({
    papel: PAPEL_DO_VINCULO_LI.filho,
    linha: filho.linha,
    detalhe: filho.detalhe,
    detalheDoPai: familia.detalheDaRaiz,
    categoriaErpId: categoria.erpId,
    marcas: ctx.job.marcas,
  });
}

/**
 * A family the ERP has, PREPARED (module header, "Complete"): the root's category (only when its
 * own is empty; planned, then carried out) and fill, then each matched variation's fill with the
 * category the root's fill LEFT. No link: the closing writes them.
 */
async function prepararExistente(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
  acc: AcumuladoDoCompletar,
): Promise<PreparoLi> {
  const { raiz, filhos, plano } = casamento;
  if (!matched(raiz)) return { tipo: 'nada', plano, criacaoRecusada: false };

  // The root: its category only when its own is empty, then its fill.
  const armazenada = await lerArmazenado(deps.db, raiz.erpId);
  if (armazenada === null) {
    acc.pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      liId: null,
      referencias: [raiz.erpId],
    });
    return { tipo: 'nada', plano, criacaoRecusada: false };
  }
  let categoria = SEM_CATEGORIA;
  if (vazioNoErpLi(armazenada.produto, 'categoriaProdutoOuterRef')) {
    const planejada = await planejarCategoriaDaRaiz(deps, ctx, familia, acc);
    const final = await aplicarCategoriaDaRaiz(deps, ctx, familia, acc, planejada);
    if (final.pendencia !== null) acc.pendencias.push(final.pendencia);
    categoria = final.categoria;
  }
  const daRaiz = await preencher(deps, ctx, acc, {
    produtoId: raiz.erpId,
    liId: null,
    valores: valoresDoLiLi({
      papel: PAPEL_DO_VINCULO_LI.raiz,
      linha: familia.raiz,
      detalhe: familia.detalheDaRaiz,
      detalheDoPai: null,
      categoriaErpId: categoria.erpId,
      marcas: ctx.job.marcas,
    }),
    categoria,
  });
  if (daRaiz === null) return { tipo: 'nada', plano, criacaoRecusada: false };
  // The variations' category: the root's as its fill LEFT it, never the pre-fill read's guess.
  const daFamilia = categoriaDosFilhosLi(ctx.job.integracaoId, daRaiz, categoria);

  // Each matched variation, filled on its own.
  const porId = new Map<number, FilhoDaFamiliaLi>(familia.filhos.map((f) => [f.linha.id, f]));
  const sumidos = new Set<string>();
  const alvos: { produtoId: string; liId: number | null }[] = [
    { produtoId: raiz.erpId, liId: null },
  ];
  for (const r of filhos?.filhos ?? []) {
    const filho = porId.get(r.liId);
    if (r.situacao !== SITUACAO_DO_FILHO_LI.casado || r.erp === null || filho === undefined) {
      continue;
    }
    const vivo = await preencher(deps, ctx, acc, {
      produtoId: r.erp.id,
      liId: r.liId,
      valores: valoresDoFilho(ctx, familia, filho, daFamilia),
      categoria: daFamilia,
    });
    if (vivo !== null) alvos.push({ produtoId: r.erp.id, liId: r.liId });
    else sumidos.add(r.erp.id);
  }
  return {
    tipo: CAMINHO_DO_COMPLETAR_LI.existente,
    casamento,
    erpRaizId: raiz.erpId,
    categoria: daFamilia,
    sumidos,
    alvos: alvos.filter((a, i) => alvos.findIndex((b) => b.produtoId === a.produtoId) === i),
  };
}

/**
 * The CLOSING of a family whose photos ran in units of their own (module header, "Complete"):
 * the preparation's account read back from `progresso`, the photos' result joined, then — for a
 * family the ERP has — the cascade run again (the fill and the photos change nothing it reads) and
 * the links, the adds and the item, as {@link executarFamiliaLi} closes a family in one unit.
 */
export async function fecharFamiliaLi(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  progresso: ProgressoDaFamiliaLi,
  fotos: ResultadoFotosDaFamiliaLi,
): Promise<FamiliaRelatadaLi> {
  const acc = new AcumuladoDoCompletar(ctx.job.mapaCategorias);
  acc.pendencias.push(...progresso.pendencias);
  for (const c of progresso.campos) acc.campo(c);
  acc.categoriaCriada(progresso.categoriasCriadas);
  acc.criados = progresso.criados;
  acc.completados = progresso.completados;
  acc.vinculados = progresso.vinculados;
  acc.completado = progresso.completado;
  const alvos = progresso.alvos;

  let preparo: PreparoLi;
  if (progresso.caminho === CAMINHO_DO_COMPLETAR_LI.criada) {
    preparo = {
      tipo: CAMINHO_DO_COMPLETAR_LI.criada,
      plano: planejarFamiliaLi({
        job: ctx.job,
        familia,
        raiz: { tipo: SITUACAO_ERP_ITEM_LI.ausente },
        filhos: null,
        skusEmConflito: ctx.skusEmConflito,
        recusasDoAprendizado: ctx.recusasDoAprendizado,
      }),
      erpRaizId: progresso.erpRaizId,
      categoria: progresso.categoria,
      alvos,
    };
  } else {
    // The family was in the target when it was prepared: the closing keeps that verdict (module
    // header, "Order", step 2).
    const casamento = await casarFamilia(deps, ctx, familia, { alvoDecidido: true });
    if (!matched(casamento.raiz) || casamento.raiz.erpId !== progresso.erpRaizId) {
      // The root the preparation filled is no longer the one the cascade answers (deleted, or
      // re-linked meanwhile): nothing is linked over it, and nothing is created in its place.
      acc.pendencias.push({
        codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
        liId: null,
        referencias: [progresso.erpRaizId],
      });
      preparo = { tipo: 'nada', plano: casamento.plano, criacaoRecusada: true };
    } else {
      preparo = {
        tipo: CAMINHO_DO_COMPLETAR_LI.existente,
        casamento,
        erpRaizId: progresso.erpRaizId,
        categoria: progresso.categoria,
        sumidos: new Set(progresso.sumidos),
        alvos,
      };
    }
  }
  return fechar(deps, ctx, familia, preparo, acc, fotos);
}

/** The closing (module header, "Complete"): the links and adds, the tax review, the item. */
async function fechar(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  preparo: PreparoLi,
  acc: AcumuladoDoCompletar,
  fotos: ResultadoFotosDaFamiliaLi | null,
): Promise<FamiliaRelatadaLi> {
  acc.comFotos(fotos);
  let vinculos = SEM_VINCULOS;
  let plano: PlanoDaFamiliaLi;
  let criacaoAplicada = false;
  let criacaoRecusada = false;
  let erpIdCriado: string | null = null;
  if (preparo.tipo === CAMINHO_DO_COMPLETAR_LI.existente) {
    plano = preparo.casamento.plano;
    vinculos = await vincularEAdicionar(deps, ctx, familia, preparo, acc);
  } else if (preparo.tipo === CAMINHO_DO_COMPLETAR_LI.criada) {
    plano = preparo.plano;
    criacaoAplicada = ctx.job.modo === MODO_IMPORTACAO_LI.aplicar;
    erpIdCriado = preparo.erpRaizId;
  } else {
    plano = preparo.plano;
    criacaoRecusada = preparo.criacaoRecusada;
  }

  await gravarRevisao(deps, ctx, acc);
  const item = montarItemDaFamiliaLi({
    familia,
    plano,
    vinculos,
    modo: ctx.job.modo,
    criacaoAplicada,
    criacaoRecusada,
    erpIdCriado,
    completado: acc.completado,
    camposPreenchidos: acc.campos,
    categoriasCriadas: acc.categoriasCriadas,
    pendenciasDoCompletar: acc.pendencias,
    agoraMs: deps.agoraMs(),
  });
  await gravarItemLi(deps.db, deps.jobId, item);
  return {
    tipo: 'relatado',
    plano,
    vinculos,
    item,
    contadores: contadoresDoItemLi(item, vinculos, acc.contagem()),
    mapaCategorias: acc.mapa,
  };
}

/**
 * The closing of a family the ERP has: its links LAST, then the variations the ERP family lacks
 * beside the root's CONFIRMED link. Returns the links' outcomes.
 */
async function vincularEAdicionar(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  preparo: Extract<PreparoLi, { readonly tipo: typeof CAMINHO_DO_COMPLETAR_LI.existente }>,
  acc: AcumuladoDoCompletar,
): Promise<ResultadoDosVinculosLi> {
  const { casamento, sumidos, categoria } = preparo;
  const { filhos, plano } = casamento;

  const resultado = await vincularFamiliaLi(depsDosVinculos(deps, ctx), {
    raizVinculo: plano.raizVinculo,
    filhosVinculos: plano.filhosVinculos.filter((v) => !sumidos.has(v.produtoId)),
  });
  await recontarAdicionadosPorEsteJob(deps, ctx, resultado, categoria, acc);

  // The variations the ERP family lacks, beside the root's CONFIRMED link.
  const ausentes = (filhos?.filhos ?? []).some((r) => r.situacao === SITUACAO_DO_FILHO_LI.ausente);
  if (
    filhos === null ||
    !ausentes ||
    resultado.raiz === null ||
    !vinculoConfirmadoLi(resultado.raiz.desfecho)
  ) {
    return resultado;
  }
  const adicao = await adicionarFilhosLi(
    {
      db: deps.db,
      contaId: ctx.job.integracaoId,
      modo: ctx.job.modo,
      agoraMs: deps.agoraMs,
      // The added variations' tax review, durable before they exist (module header).
      antesDoLote: (adicionados) =>
        gravarRevisaoAntes(
          deps,
          ctx,
          acc,
          adicionados.map((a) => ({
            produtoId: a.produtoId,
            liId: a.liId,
            motivos: motivosDoCriado(categoria),
          })),
        ),
    },
    {
      familia,
      erpPaiId: preparo.erpRaizId,
      filhos,
      skusEmConflito: ctx.skusEmConflito,
      categoriaErpId: categoria.erpId,
      marcas: ctx.job.marcas,
    },
  );
  acc.pendencias.push(...adicao.pendencias);
  for (const a of adicao.adicionados) {
    acc.criados += 1;
    acc.vinculados += 1;
    acc.completado = true;
    acc.revisar(a.produtoId, a.liId, motivosDoCriado(categoria));
  }
  // Another writer's add under this parent: filled and linked like a matched variation.
  const porId = new Map<number, FilhoDaFamiliaLi>(familia.filhos.map((f) => [f.linha.id, f]));
  const filhosVinculados: ResultadoDoVinculoLi[] = [...resultado.filhos];
  for (const e of adicao.existentes) {
    const filho = porId.get(e.liId);
    if (filho === undefined) continue;
    const vivo = await preencher(deps, ctx, acc, {
      produtoId: e.produtoId,
      liId: e.liId,
      valores: valoresDoFilho(ctx, familia, filho, categoria),
      categoria,
    });
    if (vivo === null) continue;
    const planejado = planejarVinculoLi(
      ctx.job.integracaoId,
      PAPEL_DO_VINCULO_LI.filho,
      e.produtoId,
      filho.linha,
      filho.detalhe,
      familia.raiz.id,
    );
    if (planejado.tipo === 'invalido') {
      acc.pendencias.push({
        codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
        liId: e.liId,
        referencias: [...planejado.campos],
      });
      continue;
    }
    filhosVinculados.push(await vincularProdutoLi(depsDosVinculos(deps, ctx), planejado.vinculo));
  }
  return { raiz: resultado.raiz, filhos: filhosVinculados };
}

/**
 * The variations THIS job ADDED to the family in an earlier attempt of the unit (module header, "A
 * retried family"), met again through their own links: a child link this job created (`criado`,
 * `retomado`) under a SKU-keyed produto born in the SAME commit as that link — the add's batch, one
 * commit stamp. Each is counted as created again (its link already counts as created), the item
 * says `completar`, and its tax review is gathered again. Never under Simular (it writes no link).
 * One produto and one link by id per such variation.
 */
async function recontarAdicionadosPorEsteJob(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  vinculos: ResultadoDosVinculosLi,
  categoria: CategoriaDaFamiliaLi,
  acc: AcumuladoDoCompletar,
): Promise<void> {
  for (const v of vinculos.filhos) {
    const { desfecho } = v;
    const { produtoId, liId } = v.vinculo;
    if (desfecho.tipo !== DESFECHO_DO_VINCULO_LI.criado || desfecho.retomado !== true) continue;
    if (!produtoId.startsWith(PREFIXO_ID_PRODUTO_CRIADO_LI)) continue;
    const snap = await produtoCollection.docRef(deps.db, {}, produtoId).get();
    if (!snap.exists) continue;
    if (!(await criadoComOVinculoDaContaLi(deps.db, ctx.job.integracaoId, snap, liId))) continue;
    acc.criados += 1;
    acc.completado = true;
    acc.revisar(produtoId, liId, motivosDoCriado(categoria));
  }
}
