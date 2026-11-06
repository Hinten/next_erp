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
 *     its conflict and no link (`plano.ts`, "The target").
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
 *    category (`categorias.ts`: the job's map, create-and-link when the job says so), then the
 *    WHOLE family in one batch with its links (`familiaNova.ts`: the create probe immediately before
 *    the commit, ids keyed by the SKU). A root found at its id with the store SKU (another conta's
 *    create) is ADOPTED: the cascade runs again and the family takes the path below. A refused
 *    create reports why and creates nothing.
 *  - **A family the ERP has** (`vinculado` or `encontrado`): its EMPTY fields filled
 *    (`completar.ts`), the root first, then each matched variation on its own, with the PARENT's
 *    category (the root's stored one, else the one just resolved) and, when its read detail has no
 *    box, the parent's box. The root's category is resolved only when the root's own is empty, so a
 *    run never creates a category no produto takes. NO link yet.
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
 *    created), `categoria-preenchida`, `sem-categoria` — written by the unit that decided it.
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
 * What the preparation decided — its fields, pendências, counts and photo targets — and the photo
 * cursor, checkpointed after every unit until the closing reports it. ⚠️ The job contract has no
 * field of its own for it: it rides as TAGGED TEXT (`f:<json>`) in `revisao.cursorProdutoId`, which
 * no one reads during the `familias` phase (the `revisao` phase, the field's owner, starts after it
 * and the transition clears it). Only {@link textoDoProgressoDaFamiliaLi} writes it and
 * {@link lerProgressoDaFamiliaLi} reads it back; a text that does not read, or names another family,
 * is no progress, and the family is prepared again — safe, since every write of it is fill-empty,
 * create-only or tier 0, at the price of the residuals of "A retried family".
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
 * option combination (or under a SKU the store repeats) is matched by its link on the retry, so
 * the informational `sku-diferente` / `sku-repetido-na-loja` that attempt reported for it is not
 * reported again (one informational pendência fewer; the link, the action and every other counter
 * agree). Closing it means rung 1 recognising this job's link and falling through to the SKU and
 * combination rungs, which read nothing new for a variation. ⚠️ And a MIRROR REFRESH this job
 * landed reads `sem-mudanca` on a retried unit: `semMudanca + 1`, its informational
 * `vinculo-atualizado` lost; `vinculados` unaffected (`vinculos.ts`, "Accepted residuals"; pinned
 * in `familiaDoJob.test.ts`).
 *
 * Under "complete" a retried unit also meets its own CREATE: a family whose batch landed reaches
 * the cascade's rung 1 through the batch's own link. Its root is recognised as THIS job's creation
 * when its id is a SKU-keyed one (`li-sku-…`), its `createTime` is at or after the job document's,
 * and this conta's link of the store root under it carries the SAME `createTime` (one batch, one
 * commit stamp): the item then says `criar`, `ausente`, with the same create count, links and tax
 * review as the attempt that landed it — never `sku-ja-existe` against itself. ⚠️ Accepted
 * residuals of a retried complete unit: the fields a landed fill wrote are found filled, so they are
 * reported nowhere (`completar.ts`), and a `descricao-longa` of a landed create is not reported
 * again (the create is not re-planned).
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * The cascade's and the writers' own (each module states its indexes); here only documents by id:
 * a matched produto and its `extraData` (whether a detail could fill them, {@link
 * detalhesDaFamiliaLi}; the root's stored category). No query of its own.
 */
import type { DocumentSnapshot, Firestore, Timestamp } from 'firebase-admin/firestore';
import { produtoCollection, produtoExtraDataCollection } from '@delfrance/data/admin/collections';
import {
  ACAO_IMPORTACAO_LI,
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
  SITUACAO_ERP_ITEM_LI,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  parseRef,
  pendenciaImportacaoLiSchema,
  toOuterRefOrNull,
} from '@delfrance/schemas';
import { z } from 'zod';

import { TIPO_CATEGORIA_DO_PRODUTO_LI, resolverCategoriaDoProdutoLi } from './categorias';
import {
  CATEGORIA_NO_PREENCHIMENTO_LI,
  type CategoriaNoPreenchimentoLi,
  type MedidasErpLi,
  TIPO_RESULTADO_PREENCHIMENTO_LI,
  type ValoresDoLiLi,
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
  TIPO_RESULTADO_FAMILIA_NOVA_LI,
  criadoComOVinculoDaContaLi,
  criarFamiliaLi,
} from './familiaNova';
import type { FamiliaLi, FilhoDaFamiliaLi } from './familias';
import { adicionarFilhosLi } from './filhoNovo';
import {
  type AlvoDeFotosLi,
  type CandidatoAFotosLi,
  type ResultadoFotosDaFamiliaLi,
  contarFotosSimuladasLi,
  cursorFotosLiSchema,
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
  type ResolucaoDaRaizLi,
  type ResolucaoDosFilhosLi,
  SITUACAO_DO_FILHO_LI,
  familiaNoAlvoLi,
  resolverFilhosLi,
  resolverRaizLi,
} from './resolucao';
import { adicionarARevisaoFiscalLi } from './revisaoFiscal';
import {
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
  /** `skusRepetidosNaLojaLi` over the job's assembly. */
  readonly skusRepetidos: ReadonlySet<string>;
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
      /**
       * Store ids whose created produto's name was cut at the ERP's limit: the report's closed
       * vocabulary has no code for it, so the caller logs them.
       */
      readonly nomesCortados: readonly number[];
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
}

const matched = (
  r: ResolucaoDaRaizLi,
): r is Extract<ResolucaoDaRaizLi, { readonly erpId: string }> =>
  r.tipo === SITUACAO_ERP_ITEM_LI.vinculado || r.tipo === SITUACAO_ERP_ITEM_LI.encontrado;

/** Steps 1–4 for `familia`. */
async function casarFamilia(
  db: Firestore,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
): Promise<CasamentoLi> {
  const resolucao = { db, contaId: ctx.job.integracaoId };
  const raiz = await resolverRaizLi(resolucao, familia, ctx.skusRepetidos);
  const noAlvo = familiaNoAlvoLi(ctx.job, familia.raiz.id, raiz);

  let filhos: ResolucaoDosFilhosLi | null = null;
  if (noAlvo && familia.raiz.tipo === TIPO_PRODUTO_LI.atributo && matched(raiz)) {
    filhos = await resolverFilhosLi(resolucao, familia, raiz.erpId, {
      grupos: ctx.grupos,
      skusRepetidos: ctx.skusRepetidos,
    });
  }

  const plano = planejarFamiliaLi({
    job: ctx.job,
    familia,
    raiz,
    filhos,
    skusRepetidos: ctx.skusRepetidos,
    recusasDoAprendizado: ctx.recusasDoAprendizado,
  });
  return { raiz, filhos, plano };
}

/**
 * Run one family's unit (module header, "Order"): under "only link" the whole family; under
 * "complete" its preparation, then — when nothing is to be fetched (no photo, or Simular) — its
 * closing in the same unit; otherwise `fotos`, for the caller's photo units.
 */
export async function executarFamiliaLi(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
): Promise<ResultadoDaFamiliaLi> {
  const casamento = await casarFamilia(deps.db, ctx, familia);
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
    nomesCortados: [],
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
 * The store ids whose DETAIL completing `familia` needs, root first, then its variations ascending
 * (the plan's cost rule: a detail is read only where it can change something). Reads the cascade's
 * own reads and the matched produtos by id; calls nothing outside the ERP. `[]` under "only link",
 * outside the target, for a refused or conflicting family. The caller drops the ids whose detail
 * the job already holds or tried (the `orfaos` phase's, or one this family's earlier units read).
 *
 *  - A family the ERP lacks, whose create the plan classifies viable: the root and every variation
 *    the create would add (a create is decided only over a whole family).
 *  - A family the ERP has: the root when it has an empty field a detail fills (weight, box,
 *    description, brand) or — when the run copies photos — no photo (its pictures are the detail's);
 *    a matched variation when it has an empty weight, box or description of its own; a variation
 *    whose box is empty also needs ITS detail (only a read detail without a box inherits the
 *    parent's) and the PARENT's, and one whose brand is empty the parent's; a variation the family
 *    may ADD (visible, with a SKU the store does not repeat, every option resolved) its own and the
 *    parent's. When the run copies photos and any variation's detail is read, the root's is too:
 *    a variation's pictures are copied only when they are not its parent's set (`fotos.ts`), which
 *    only the parent's detail can say. A variation whose detail is not otherwise needed is never
 *    read for its photos alone: a detail never read gives no picture (`fotos.ts`, "Which").
 */
export async function detalhesDaFamiliaLi(
  db: Firestore,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
): Promise<number[]> {
  if (ctx.job.acao !== ACAO_IMPORTACAO_LI.completar) return [];
  const { raiz, filhos, plano } = await casarFamilia(db, ctx, familia);
  if (!plano.noAlvo) return [];
  if (raiz.tipo === SITUACAO_ERP_ITEM_LI.ausente) {
    return plano.criacao?.viavel === true ? [familia.raiz.id, ...plano.criacao.filhos] : [];
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
      !ctx.skusRepetidos.has(linha.sku) &&
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

/** Which path the preparation took, for a family whose photos are under way. */
export const caminhoDoCompletarLiSchema = z.enum(['existente', 'criada']);
export type CaminhoDoCompletarLi = z.infer<typeof caminhoDoCompletarLiSchema>;
/** Named members of {@link caminhoDoCompletarLiSchema} — see `delfrance/prefer-schema-enum`. */
export const CAMINHO_DO_COMPLETAR_LI = {
  /** A family the ERP has: filled, links still to write. */
  existente: 'existente',
  /** A family this job created (links in the batch). */
  criada: 'criada',
} as const satisfies Record<string, CaminhoDoCompletarLi>;

const idLiSchema = z.number().int().positive();

const pendenciaDoProgressoSchema = z.object({
  codigo: pendenciaImportacaoLiSchema,
  liId: idLiSchema.nullable(),
  referencias: z.array(z.string()),
});

const resultadoFotosDoProgressoSchema = z.object({
  produtos: cursorFotosLiSchema.shape.feitos,
  gravadas: z.number().int().nonnegative(),
  pendencias: z.array(pendenciaDoProgressoSchema),
});

/**
 * One family's complete step between its units (module header, "The family's progress"): what the
 * preparation decided, the photo targets, the photo cursor and, once every picture is decided, the
 * photos' result.
 */
export const progressoDaFamiliaLiSchema = z.object({
  /** The family's root store id: a progress of any other family is none. */
  raizLiId: idLiSchema,
  caminho: caminhoDoCompletarLiSchema,
  /** The ERP root: matched, or created by this job. */
  erpRaizId: z.string().min(1),
  /** The variations' category (the parent's stored one, else the one resolved for it). */
  categoria: z.object({
    erpId: z.string().min(1).nullable(),
    criadaPelaImportacao: z.boolean(),
  }),
  /** The plan's create was carried out (or met again, landed, by a retried unit). */
  criacaoAplicada: z.boolean(),
  completado: z.boolean(),
  campos: z.array(z.string()),
  pendencias: z.array(pendenciaDoProgressoSchema),
  nomesCortados: z.array(idLiSchema),
  criados: z.number().int().nonnegative(),
  completados: z.number().int().nonnegative(),
  vinculados: z.number().int().nonnegative(),
  /** ERP produtos the preparation found gone: no link is written for them. */
  sumidos: z.array(z.string().min(1)),
  /** The produtos whose pictures may be copied, in order; their pictures are the details'. */
  alvos: z.array(z.object({ produtoId: z.string().min(1), liId: idLiSchema.nullable() })),
  /** The photo cursor (`fotos.ts`); `null` before the first picture. */
  fotos: cursorFotosLiSchema.nullable(),
  /** Every picture decided: the photos' result, for the closing; `null` while under way. */
  resultadoFotos: resultadoFotosDoProgressoSchema.nullable(),
});
export type ProgressoDaFamiliaLi = z.infer<typeof progressoDaFamiliaLiSchema>;

/** The tag of a family's progress in `revisao.cursorProdutoId` (module header). */
export const PREFIXO_PROGRESSO_DA_FAMILIA_LI = 'f:';

/** The progress as the tagged text the job carries (module header). */
export function textoDoProgressoDaFamiliaLi(progresso: ProgressoDaFamiliaLi): string {
  return `${PREFIXO_PROGRESSO_DA_FAMILIA_LI}${JSON.stringify(progressoDaFamiliaLiSchema.parse(progresso))}`;
}

/**
 * The progress a job's `revisao.cursorProdutoId` carries, or `null`: no text, another tag, a text
 * that is not JSON or does not parse — the family is prepared again (module header).
 */
export function lerProgressoDaFamiliaLi(texto: string | null): ProgressoDaFamiliaLi | null {
  if (texto === null || !texto.startsWith(PREFIXO_PROGRESSO_DA_FAMILIA_LI)) return null;
  let bruto: unknown;
  try {
    bruto = JSON.parse(texto.slice(PREFIXO_PROGRESSO_DA_FAMILIA_LI.length));
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  const lido = progressoDaFamiliaLiSchema.safeParse(bruto);
  return lido.success ? lido.data : null;
}

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
  readonly nomesCortados: number[] = [];
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

/** Resolve (and, under `criarEVincular`, create) the root's store category (`categorias.ts`). */
async function categoriaDaRaiz(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  acc: AcumuladoDoCompletar,
): Promise<CategoriaDaFamiliaLi> {
  const r = await resolverCategoriaDoProdutoLi(
    {
      db: deps.db,
      contaId: ctx.job.integracaoId,
      modo: ctx.job.modo,
      categorias: ctx.job.categorias,
      agoraMs: deps.agoraMs,
    },
    acc.mapa,
    familia.raiz.categorias,
  );
  acc.mapa = r.mapaCategorias;
  const c = r.categoria;
  if (c.tipo === TIPO_CATEGORIA_DO_PRODUTO_LI.resolvida) {
    return { erpId: c.erpCategoriaId, criadaPelaImportacao: c.criadaPelaImportacao };
  }
  if (c.tipo === TIPO_CATEGORIA_DO_PRODUTO_LI.recusada) {
    acc.pendencias.push({ codigo: c.pendencia, liId: null, referencias: c.referencias });
  }
  return SEM_CATEGORIA;
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

/** A stored `categoriaProdutoOuterRef` as the categoria's id; `null` when empty or not one. */
function categoriaArmazenadaLi(produto: Readonly<Record<string, unknown>>): string | null {
  if (vazioNoErpLi(produto, 'categoriaProdutoOuterRef')) return null;
  const ref = toOuterRefOrNull(produto.categoriaProdutoOuterRef);
  if (ref === null) return null;
  const { collection, id } = parseRef(ref);
  return collection === 'categorias' && id !== '' ? id : null;
}

/** A stored category read back as the family's (its creator recognised by its id). */
function categoriaDaFamiliaArmazenada(
  contaId: string,
  produto: Readonly<Record<string, unknown>>,
): CategoriaDaFamiliaLi {
  const erpId = categoriaArmazenadaLi(produto);
  return erpId === null
    ? SEM_CATEGORIA
    : { erpId, criadaPelaImportacao: criadaPorImportacaoLi(contaId, erpId) };
}

/**
 * Fill ONE existing produto and account for it; `false` when the produto is gone (its link is then
 * not written).
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
): Promise<boolean> {
  const r = await preencherProdutoLi(
    { db: deps.db, modo: ctx.job.modo, agoraMs: deps.agoraMs },
    { produtoId: alvo.produtoId, liId: alvo.liId, valores: alvo.valores },
  );
  acc.pendencias.push(...r.pendencias);
  if (r.tipo === TIPO_RESULTADO_PREENCHIMENTO_LI.ausente) return false;
  for (const campo of r.campos) acc.campo(campo);
  const simular = ctx.job.modo === MODO_IMPORTACAO_LI.simular;
  if (simular ? r.campos.length > 0 : r.gravado) {
    acc.completados += 1;
    acc.completado = true;
  }
  acc.revisar(alvo.produtoId, alvo.liId, motivosDoPreenchido(r.categoria, alvo.categoria));
  return true;
}

/**
 * Write the tax-review entries gathered so far (`aplicar` only), in the order the produtos were met,
 * and forget them: each unit writes the entries it decided.
 */
async function gravarRevisao(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  acc: AcumuladoDoCompletar,
): Promise<void> {
  if (ctx.job.modo === MODO_IMPORTACAO_LI.aplicar) {
    for (const [produtoId, { liId, motivos }] of acc.revisao) {
      await adicionarARevisaoFiscalLi(deps.db, deps.jobId, {
        produtoId,
        motivos: [...motivos],
        liId,
        desdeJobId: deps.jobId,
        desdeMs: deps.agoraMs(),
      });
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
    nomesCortados: [...acc.nomesCortados],
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
    const categoria = await categoriaDaRaiz(deps, ctx, familia, acc);
    const r = await criarFamiliaLi(
      {
        db: deps.db,
        contaId: ctx.job.integracaoId,
        modo: ctx.job.modo,
        agoraMs: deps.agoraMs,
      },
      {
        familia,
        criacao: plano.criacao,
        grupos: ctx.grupos,
        categoriaErpId: categoria.erpId,
        marcas: ctx.job.marcas,
      },
    );
    if (r.tipo === TIPO_RESULTADO_FAMILIA_NOVA_LI.criada) {
      acc.criados = r.produtos.filter((p) => p.papel !== PAPEL_DO_PRODUTO_CRIADO_LI.membro).length;
      acc.vinculados = r.vinculos.length;
      acc.pendencias.push(...r.pendencias);
      acc.nomesCortados.push(...r.nomesCortados);
      for (const p of r.produtos) {
        acc.revisar(
          p.produtoId,
          p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
          motivosDoCriado(categoria),
        );
      }
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
      acc.pendencias.push(...r.pendencias);
      return { tipo: 'nada', plano, criacaoRecusada: true };
    }
    // Another writer (another conta's job, a person) created this SKU's root at our id: adopt it,
    // through the cascade again, and complete it as a family the ERP has.
    const adotada = await casarFamilia(deps.db, ctx, familia);
    if (matched(adotada.raiz)) return prepararExistente(deps, ctx, familia, adotada, acc);
    acc.pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita,
      liId: null,
      referencias: [r.raizId],
    });
    return { tipo: 'nada', plano, criacaoRecusada: true };
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
 * Whether the matched root is THIS job's create, landed by an earlier attempt of this unit (module
 * header, "A retried family"): a SKU-keyed id, created at or after the job document, with this
 * conta's link of the store root created in the same commit. `null` otherwise — and for a root
 * matched any other way than by this conta's link (a create always writes its link).
 */
async function criadaPorEsteJob(
  deps: DepsFamiliaLi,
  ctx: ContextoDasFamiliasLi,
  familia: FamiliaLi,
  casamento: CasamentoLi,
): Promise<CriadaPorEsteJobLi | null> {
  const { raiz, filhos } = casamento;
  if (raiz.tipo !== SITUACAO_ERP_ITEM_LI.vinculado) return null;
  if (!raiz.erpId.startsWith(PREFIXO_ID_PRODUTO_CRIADO_LI)) return null;
  const snap = await produtoCollection.docRef(deps.db, {}, raiz.erpId).get();
  const criado = snap.createTime;
  if (!snap.exists || criado === undefined) return null;
  if (criado.valueOf() < deps.criacaoDoJob.valueOf()) return null;
  if (!(await criadoComOVinculoDaContaLi(deps.db, ctx.job.integracaoId, snap, familia.raiz.id))) {
    return null;
  }
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
    skusRepetidos: ctx.skusRepetidos,
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
 * own is empty) and fill, then each matched variation's fill. No link: the closing writes them.
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
  const daRaiz = categoriaArmazenadaLi(armazenada.produto);
  const categoria = vazioNoErpLi(armazenada.produto, 'categoriaProdutoOuterRef')
    ? await categoriaDaRaiz(deps, ctx, familia, acc)
    : SEM_CATEGORIA;
  const raizViva = await preencher(deps, ctx, acc, {
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
  if (!raizViva) return { tipo: 'nada', plano, criacaoRecusada: false };
  // The variations' category: the parent's own, else the one just resolved for it.
  const daFamilia: CategoriaDaFamiliaLi =
    daRaiz !== null
      ? { erpId: daRaiz, criadaPelaImportacao: criadaPorImportacaoLi(ctx.job.integracaoId, daRaiz) }
      : categoria;

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
    if (vivo) alvos.push({ produtoId: r.erp.id, liId: r.liId });
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
  acc.nomesCortados.push(...progresso.nomesCortados);
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
        skusRepetidos: ctx.skusRepetidos,
        recusasDoAprendizado: ctx.recusasDoAprendizado,
      }),
      erpRaizId: progresso.erpRaizId,
      categoria: progresso.categoria,
      alvos,
    };
  } else {
    const casamento = await casarFamilia(deps.db, ctx, familia);
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
    nomesCortados: [...acc.nomesCortados].sort((a, b) => a - b),
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
    },
    {
      familia,
      erpPaiId: preparo.erpRaizId,
      filhos,
      skusRepetidos: ctx.skusRepetidos,
      categoriaErpId: categoria.erpId,
      marcas: ctx.job.marcas,
    },
  );
  acc.pendencias.push(...adicao.pendencias);
  acc.nomesCortados.push(...adicao.nomesCortados);
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
    if (!vivo) continue;
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
