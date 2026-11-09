/**
 * The product import's PLAN for one store family (master plan step 9): from the family as the
 * assembly built it and where the match cascade placed it, what the run decides — whether the
 * family is in the job's target, which link documents it writes (or, under Simular, would write),
 * whether "complete" may CREATE it, and every pendência the report shows. Pure and total: no
 * clock, no network, no Firestore. A refusal is a pendência, never a throw, so one bad product
 * never stops the job.
 *
 * ## The target ({@link planejarFamiliaLi})
 *
 * `familiaNoAlvoLi` (the cascade's): `todos` takes every family, `selecionados` the roots the start
 * body named, `jaNoErp` a root the cascade matched to one ERP produto, `naoNoErp` an `ausente` one —
 * unless the caller passes the target it decided (`noAlvo`): a family whose root was absent when
 * the job started (this job's create, another conta's it adopted), met again matched, stays in the
 * `naoNoErp` target it was in (`familiaDoJob.ts`, "Order", step 2).
 * A family outside the target is planned as `noAlvo: false` with no link and no create, and the
 * caller writes no report item for it — except a family in CONFLICT (two owners, two SKU hits, a
 * shape mismatch, no SKU, a SKU the store repeats or nearly repeats): it belongs to no target but
 * `todos` and `selecionados`, and under `jaNoErp` and `naoNoErp` it is still REPORTED (`relatar`), with its
 * conflict and no link, so a run of either never reads as "everything on this side is done".
 *
 * ## The links (`raizVinculo`, `filhosVinculos`)
 *
 * Only for a family in the target whose root the cascade matched (`vinculado` or `encontrado`):
 * one link for the root, under the matched ERP produto, then one per variation the cascade matched
 * (`casado`) under its ERP child. Whether each is CREATED, REFRESHED or refused is decided against
 * the produto's own links when it is written (`vinculos.ts`); a variation's link is written only
 * beside its parent's confirmed link.
 *
 * Every link carries the planned document a create writes ({@link VinculoPlanejadoLi.doc}),
 * `safeParse`d through `produtoLojaIntegradaLinkSchema` here: a document that does not parse is
 * `dado-invalido` with the FIELD NAMES, and that link is not planned. A store product with no SKU
 * has no creatable document (the link schema requires one): `doc` is `null`, and only an existing
 * link of it can be refreshed.
 *
 * What a link document holds (the field map of the plan's link table):
 *  - `contaLojaIntegrada` = `documents/integracao/<conta>`; `id` = the store id, a NUMBER (text
 *    matches no field query); `paiProdutoIntegradaId` = the parent's store id on a variation;
 *  - `sku`, `nome`, the URIs verbatim — `grades` on a root, `variacoes` on a variation, `categorias`
 *    on both; an empty list or a `null` text is "nothing", never written;
 *  - the store-state MIRROR ({@link VinculoPlanejadoLi.espelho}): `removido: false` (every planned
 *    product came from the live list, never the trash), and `ativo` / `bloqueado` only when the
 *    store sent a boolean;
 *  - `estadoPublicacao`: `p` when the store says `ativo: true`, `pa` when `false`, nothing when it
 *    sent no boolean. Nothing in the import decides on it;
 *  - `destaque`, `usado` and `marca` (the brand URI, verbatim like the row's URIs) ONLY from a
 *    detail this job read: a list row has none of them, so a link written from a row alone leaves
 *    them ABSENT — never an invented `false` or `null`;
 *  - never `descricao_html` (the ERP's own description is what publishing sends), never `error`.
 *
 * ## The create ({@link CriacaoPlanejadaLi}) — "complete" only
 *
 * Classified here, executed by the complete step: an `ausente` family in the target under
 * `completar` may be created only when
 *  - the root is visible: a HIDDEN (`ativo: false`) or BLOCKED (`bloqueado: true`) store product the
 *    ERP lacks is never created (`oculto-nao-criado`), while one the ERP has is linked like any
 *    other (decided 2026-11-03);
 *  - it is not an empty family (`familia-vazia`, already the assembly's pendência);
 *  - its LI-sourced fields parse through the produto schema (`nome` cut at
 *    {@link MAX_NOME_PRODUTO_LI} first; a `null` name is `dado-invalido(nome)`);
 *  - a parent keeps at least one VISIBLE variation: a hidden or blocked one is left out
 *    (`oculto-nao-criado` on it, beside its store conflict when its SKU has one: it refuses its
 *    partner, never this family), and a family whose every variation is hidden is not created;
 *  - every kept variation has a SKU no other store row repeats or nearly repeats
 *    (`conflitosDeSkuNaLojaLi`) and parses through the produto schema, and no claimed variation is
 *    still without a usable detail.
 * Whether every kept variation's options resolve is the complete step's check (it needs the grupo
 * memo); this plan only lists them.
 *
 * ## The pendências
 *
 * The assembly's (`orfao`, `na-lixeira`, `familia-vazia`), the root's conflict (with the ERP ids
 * involved), the variations' (each with its store id), the link and create refusals above. An
 * option the variation could not resolve whose claims the learning refused reads as the learning's
 * verdict instead (`evidencia-divergente` when the claims disagree, `conflito-de-escrita` when its
 * grupo write was lost twice, `variacao-sem-vinculo` otherwise): what the person must look at is
 * the disagreement, not the missing link. The verdict is reported on EVERY resolved variation that
 * carries such an option — the ones matched by their link or their exact SKU included, which leave
 * no pendência for an unlinked option of their own: those are exactly the variations whose claims
 * the evidence pass recorded, so every family involved in a disagreement says so. Exact duplicates
 * are dropped. Whether a code is actionable is the report's (`relatorio.ts`).
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`).
 */
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  ESTADO_PUBLICACAO_LI,
  type EstadoPublicacaoLi,
  type ImportacaoLojaIntegrada,
  PENDENCIA_IMPORTACAO_LI,
  type PendenciaImportacaoLi,
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  SITUACAO_ERP_ITEM_LI,
  type SituacaoErpItemLi,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  type TipoResolucaoOpcaoLi,
  idEvidenciaImportacaoLi,
  produtoLojaIntegradaLinkSchema,
  produtoSchema,
  toOuterRef,
} from '@delfrance/schemas';

import type { FamiliaLi, FilhoDaFamiliaLi } from './familias';
import { type RecusaNoRelatorioLi, pendenciaDaRecusaLi } from './gruposLi';
import {
  type ConflitoDeSkuNaLojaLi,
  type PendenciaDaResolucaoLi,
  type ResolucaoDaRaizLi,
  type ResolucaoDoFilhoLi,
  type ResolucaoDosFilhosLi,
  SITUACAO_DO_FILHO_LI,
  familiaNoAlvoLi,
} from './resolucao';

/** The ERP's `produto.nome` ceiling: a created product's name is cut here (the one truncation). */
export const MAX_NOME_PRODUTO_LI = 100;

/** A pendência the plan decided: about one variation (`liId`) or the family (`null`). */
export interface PendenciaDoPlanoLi {
  readonly codigo: PendenciaImportacaoLi;
  readonly liId: number | null;
  /** What the code names: ERP ids, the two SKUs of `sku-diferente`, FIELD names, an option. */
  readonly referencias: readonly string[];
}

/** Which side of a family a link stands for. */
export type PapelDoVinculoLi = 'raiz' | 'filho';

/** Named members of {@link PapelDoVinculoLi}. */
export const PAPEL_DO_VINCULO_LI = {
  raiz: 'raiz',
  filho: 'filho',
} as const satisfies Record<string, PapelDoVinculoLi>;

/** The store-state mirror a link carries and every run refreshes (module header). */
export interface EspelhoDoVinculoLi {
  readonly removido: boolean;
  readonly ativo?: boolean;
  readonly bloqueado?: boolean;
}

/** The fields a link fills only where the stored document has none (module header). */
export interface PreenchimentoDoVinculoLi {
  readonly sku?: string;
  readonly nome?: string;
  readonly grades?: readonly string[];
  readonly variacoes?: readonly string[];
  readonly categorias?: readonly string[];
  readonly destaque?: boolean;
  readonly usado?: boolean;
  readonly marca?: string;
  readonly estadoPublicacao?: EstadoPublicacaoLi;
  readonly paiProdutoIntegradaId?: number;
}

/** One link the run writes — or, under Simular, would write. */
export interface VinculoPlanejadoLi {
  readonly papel: PapelDoVinculoLi;
  /** The store product. The link's doc id is its decimal text. */
  readonly liId: number;
  /** The ERP produto the link sits under (the root, or the matched ERP child). */
  readonly produtoId: string;
  /** A variation's parent store id (`null` on a root). */
  readonly paiLiId: number | null;
  readonly espelho: EspelhoDoVinculoLi;
  readonly preencher: PreenchimentoDoVinculoLi;
  /**
   * The whole document a CREATE writes, already parsed through the link schema; `null` when the
   * store product has no SKU (a link of it can then only be refreshed, never created).
   */
  readonly doc: Readonly<Record<string, unknown>> | null;
}

/** What a create would write from the store, as the complete step takes it. */
export interface CriacaoPlanejadaLi {
  /** Every check of the module header passed. */
  readonly viavel: boolean;
  /** The root's name cut at {@link MAX_NOME_PRODUTO_LI}; `null` when the store sent none. */
  readonly nome: string | null;
  readonly nomeCortado: boolean;
  /** The VISIBLE variations a family create would add, ascending. Empty for a simple product. */
  readonly filhos: readonly number[];
  /** The hidden or blocked variations left out, ascending. */
  readonly ocultos: readonly number[];
}

/** What the run decides for one family. */
export interface PlanoDaFamiliaLi {
  /** The family's root store id (its report item's id). */
  readonly liId: number;
  /** In the job's target (`familiaNoAlvoLi`): only then can a link or a create be planned. */
  readonly noAlvo: boolean;
  /** The caller writes its report item: in the target, or in conflict under `jaNoErp`/`naoNoErp`. */
  readonly relatar: boolean;
  readonly situacaoErp: SituacaoErpItemLi;
  /** The matched ERP root, when the cascade matched one. */
  readonly erpId: string | null;
  /** The root's link; `null` when nothing is linked (out of target, unmatched, refused). */
  readonly raizVinculo: VinculoPlanejadoLi | null;
  /** The matched variations' links, ascending store id — written only beside the root's link. */
  readonly filhosVinculos: readonly VinculoPlanejadoLi[];
  /** `completar` + `ausente` + in the target only. */
  readonly criacao: CriacaoPlanejadaLi | null;
  readonly pendencias: readonly PendenciaDoPlanoLi[];
}

export interface EntradaDoPlanoLi {
  readonly job: Pick<
    ImportacaoLojaIntegrada,
    'integracaoId' | 'modo' | 'alvo' | 'acao' | 'selecionados'
  >;
  readonly familia: FamiliaLi;
  /** The cascade's verdict on the root (`resolverRaizLi`). */
  readonly raiz: ResolucaoDaRaizLi;
  /** The variations' match under the matched root (`resolverFilhosLi`); `null` when not run. */
  readonly filhos: ResolucaoDosFilhosLi | null;
  /** SKUs in conflict in the store, with their code (`conflitosDeSkuNaLojaLi`): never created. */
  readonly skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>;
  /** Why each claimed option stays unlearned (`recusasDoAprendizadoLi`), keyed `<g>_<v>`. */
  readonly recusasDoAprendizado: ReadonlyMap<string, RecusaNoRelatorioLi>;
  /**
   * The target as the caller DECIDED it (`familiaDoJob.ts`, "Order", step 2: decided once);
   * absent ⇒ `familiaNoAlvoLi` over `raiz`. A family whose root was absent when the job started
   * (this job's create, another conta's it adopted) is still in a `naoNoErp` target when a retried
   * unit meets that root matched.
   */
  readonly noAlvo?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                The link fields                              */
/* -------------------------------------------------------------------------- */

/** The publication code the store's `ativo` implies, or nothing when it sent no boolean. */
function estadoPublicacaoDe(ativo: boolean | null): EstadoPublicacaoLi | undefined {
  if (ativo === null) return undefined;
  return ativo ? ESTADO_PUBLICACAO_LI.publicado : ESTADO_PUBLICACAO_LI.pausado;
}

/** A non-empty list, copied; nothing otherwise. */
function lista(v: readonly string[]): readonly string[] | undefined {
  return v.length > 0 ? [...v] : undefined;
}

/** The field names a failed parse names (each once, in order). */
export function camposDoErro(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): string[] {
  return [...new Set(issues.map((i) => String(i.path[0] ?? '')).filter((c) => c !== ''))];
}

/** One link's plan: the planned link, or the field names its document fails on. */
export type PlanoDoVinculoLi =
  | { readonly tipo: 'ok'; readonly vinculo: VinculoPlanejadoLi }
  | { readonly tipo: 'invalido'; readonly campos: readonly string[] };

/**
 * One link's fields and its create document (module header, "The links"). Exported for the complete
 * step, whose created produtos carry the SAME link document, in their create's batch. Pure.
 */
export function planejarVinculoLi(
  contaId: string,
  papel: PapelDoVinculoLi,
  produtoId: string,
  linha: ProdutoLiLido,
  detalhe: ProdutoLiDetalhado | null,
  paiLiId: number | null,
): PlanoDoVinculoLi {
  const espelho: EspelhoDoVinculoLi = {
    removido: false,
    ...(linha.ativo === null ? {} : { ativo: linha.ativo }),
    ...(linha.bloqueado === null ? {} : { bloqueado: linha.bloqueado }),
  };
  const raiz = papel === PAPEL_DO_VINCULO_LI.raiz;
  const campos: { -readonly [K in keyof PreenchimentoDoVinculoLi]: PreenchimentoDoVinculoLi[K] } =
    {};
  if (linha.sku !== null) campos.sku = linha.sku;
  if (linha.nome !== null) campos.nome = linha.nome;
  const uris = lista(raiz ? linha.grades : linha.variacoes);
  if (uris !== undefined) campos[raiz ? 'grades' : 'variacoes'] = uris;
  const categorias = lista(linha.categorias);
  if (categorias !== undefined) campos.categorias = categorias;
  if (typeof detalhe?.destaque === 'boolean') campos.destaque = detalhe.destaque;
  if (typeof detalhe?.usado === 'boolean') campos.usado = detalhe.usado;
  if (typeof detalhe?.marca === 'string') campos.marca = detalhe.marca;
  const estado = estadoPublicacaoDe(linha.ativo);
  if (estado !== undefined) campos.estadoPublicacao = estado;
  if (paiLiId !== null) campos.paiProdutoIntegradaId = paiLiId;
  const preencher: PreenchimentoDoVinculoLi = campos;

  let doc: Readonly<Record<string, unknown>> | null = null;
  if (linha.sku !== null) {
    const candidato: Record<string, unknown> = {
      contaLojaIntegrada: toOuterRef(`integracao/${contaId}`),
      id: linha.id,
      ...espelho,
      ...preencher,
    };
    const lido = produtoLojaIntegradaLinkSchema.safeParse(candidato);
    if (!lido.success) return { tipo: 'invalido', campos: camposDoErro(lido.error.issues) };
    // The document as PLANNED, never the parse's output: the parse fills defaults (`destaque:
    // null`, `ativo: true`, …) a row-only link must leave absent (module header).
    doc = candidato;
  }
  return {
    tipo: 'ok',
    vinculo: { papel, liId: linha.id, produtoId, paiLiId, espelho, preencher, doc },
  };
}

/* -------------------------------------------------------------------------- */
/*                                  The create                                 */
/* -------------------------------------------------------------------------- */

/** The produto fields a create takes from the store, parsed through the produto schema. */
const camposDaRaizSchema = produtoSchema.pick({ nome: true, sku: true, gtin: true });
const camposDoFilhoSchema = produtoSchema.pick({ sku: true, gtin: true });

/** Hidden (`ativo: false`) or blocked (`bloqueado: true`) in the store: never created. */
export function ocultoNaLojaLi(linha: Pick<ProdutoLiLido, 'ativo' | 'bloqueado'>): boolean {
  return linha.ativo === false || linha.bloqueado === true;
}

/** The create's classification (module header, "The create"). */
function planejarCriacao(
  familia: FamiliaLi,
  skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>,
): { readonly criacao: CriacaoPlanejadaLi; readonly pendencias: readonly PendenciaDoPlanoLi[] } {
  const { raiz } = familia;
  const pendencias: PendenciaDoPlanoLi[] = [];
  const recusar = (codigo: PendenciaImportacaoLi, liId: number | null, refs: string[] = []) => {
    pendencias.push({ codigo, liId, referencias: refs });
  };
  const nomeCortado = raiz.nome !== null && raiz.nome.length > MAX_NOME_PRODUTO_LI;
  const nome = raiz.nome === null ? null : raiz.nome.slice(0, MAX_NOME_PRODUTO_LI);

  let viavel = true;
  if (ocultoNaLojaLi(raiz)) {
    recusar(PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, null);
    viavel = false;
  }
  if (familia.pendencias.some((p) => p.codigo === PENDENCIA_IMPORTACAO_LI.familiaVazia)) {
    viavel = false;
  }
  const camposDaRaiz = camposDaRaizSchema.safeParse({ nome, sku: raiz.sku, gtin: raiz.gtin });
  if (!camposDaRaiz.success) {
    recusar(PENDENCIA_IMPORTACAO_LI.dadoInvalido, null, camposDoErro(camposDaRaiz.error.issues));
    viavel = false;
  }

  const filhos: number[] = [];
  const ocultos: number[] = [];
  if (raiz.tipo === TIPO_PRODUTO_LI.atributo) {
    for (const { linha } of familia.filhos) {
      if (ocultoNaLojaLi(linha)) {
        ocultos.push(linha.id);
        recusar(PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, linha.id);
        // Left out, so it refuses nothing here; but a hidden row counts in the store's conflicts and
        // its partner is refused over it, so the report must carry the code on this row too.
        const conflitoDoOculto = linha.sku === null ? undefined : skusEmConflito.get(linha.sku);
        if (conflitoDoOculto !== undefined) recusar(conflitoDoOculto, linha.id);
        continue;
      }
      filhos.push(linha.id);
      if (linha.sku === null) {
        recusar(PENDENCIA_IMPORTACAO_LI.semSku, linha.id);
        viavel = false;
        continue;
      }
      const emConflito = skusEmConflito.get(linha.sku);
      if (emConflito !== undefined) {
        recusar(emConflito, linha.id);
        viavel = false;
      }
      const camposDoFilho = camposDoFilhoSchema.safeParse({ sku: linha.sku, gtin: linha.gtin });
      if (!camposDoFilho.success) {
        recusar(
          PENDENCIA_IMPORTACAO_LI.dadoInvalido,
          linha.id,
          camposDoErro(camposDoFilho.error.issues),
        );
        viavel = false;
      }
    }
    // A claimed variation still without a usable detail: the family is not known whole.
    for (const id of familia.semDetalhe) {
      recusar(PENDENCIA_IMPORTACAO_LI.dadoInvalido, id, ['detalhe']);
      viavel = false;
    }
    if (filhos.length === 0) viavel = false;
  }

  return {
    criacao: {
      viavel,
      nome,
      nomeCortado,
      filhos: filhos.sort((a, b) => a - b),
      ocultos: ocultos.sort((a, b) => a - b),
    },
    pendencias,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 The pendências                              */
/* -------------------------------------------------------------------------- */

/** The option codes the learning's verdict replaces (module header, "The pendências"). */
const CODIGOS_DE_OPCAO_SEM_VINCULO: ReadonlySet<PendenciaImportacaoLi> = new Set([
  PENDENCIA_IMPORTACAO_LI.gradeSemVinculo,
  PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo,
]);

/** `<grade>/<opção>` (the cascade's option reference) → the claim document id, or `null`. */
function idDaEvidencia(referencia: string | undefined): string | null {
  const partes = /^(\d{1,15})\/(\d{1,15})$/.exec(referencia ?? '');
  if (partes === null) return null;
  const g = Number(partes[1]);
  const v = Number(partes[2]);
  return g > 0 && v > 0 ? idEvidenciaImportacaoLi(g, v) : null;
}

/** A cascade pendência, read through the learning's verdict on its option. */
function comVeredictoDoAprendizado(
  p: PendenciaDaResolucaoLi,
  recusas: ReadonlyMap<string, RecusaNoRelatorioLi>,
): PendenciaDoPlanoLi {
  if (!CODIGOS_DE_OPCAO_SEM_VINCULO.has(p.codigo)) return p;
  const id = idDaEvidencia(p.referencias[0]);
  const motivo = id === null ? undefined : recusas.get(id);
  return motivo === undefined ? p : { ...p, codigo: pendenciaDaRecusaLi(motivo) };
}

/** The option verdicts the learning could have changed (the ones it replaces, above). */
const OPCOES_SEM_VINCULO: ReadonlySet<TipoResolucaoOpcaoLi> = new Set([
  TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo,
  TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo,
]);

/**
 * The learning's verdict on each unlinked option of ONE resolved variation, whatever its rung (module
 * header, "The pendências"). A variation matched by its link or by its SKU leaves no pendência for
 * an unlinked option — the link needs none — yet THAT is the variation whose claim the evidence
 * pass recorded: without this, claims that disagree would show on no family at all.
 */
function veredictosDasOpcoes(
  r: ResolucaoDoFilhoLi,
  recusas: ReadonlyMap<string, RecusaNoRelatorioLi>,
): PendenciaDoPlanoLi[] {
  const pendencias: PendenciaDoPlanoLi[] = [];
  for (const o of r.opcoes) {
    if (!OPCOES_SEM_VINCULO.has(o.tipo) || o.gradeId === null || o.opcaoId === null) continue;
    const motivo = recusas.get(idEvidenciaImportacaoLi(o.gradeId, o.opcaoId));
    if (motivo === undefined) continue;
    pendencias.push({
      codigo: pendenciaDaRecusaLi(motivo),
      liId: r.liId,
      referencias: [`${String(o.gradeId)}/${String(o.opcaoId)}`],
    });
  }
  return pendencias;
}

/** Exact duplicates dropped, first occurrence kept. */
function semRepetir(pendencias: readonly PendenciaDoPlanoLi[]): PendenciaDoPlanoLi[] {
  const vistas = new Set<string>();
  return pendencias.filter((p) => {
    const chave = JSON.stringify([p.codigo, p.liId, p.referencias]);
    if (vistas.has(chave)) return false;
    vistas.add(chave);
    return true;
  });
}

/* -------------------------------------------------------------------------- */
/*                                   The plan                                  */
/* -------------------------------------------------------------------------- */

/** One family's plan (module header). Pure and total. */
export function planejarFamiliaLi(e: EntradaDoPlanoLi): PlanoDaFamiliaLi {
  const { familia, raiz: res, job } = e;
  const raiz = familia.raiz;
  const pendencias: PendenciaDoPlanoLi[] = familia.pendencias.map((p) => ({
    codigo: p.codigo,
    liId: p.liId,
    referencias: [],
  }));
  const noAlvo = e.noAlvo ?? familiaNoAlvoLi(job, raiz.id, res);
  // A family in conflict is in no target but todos/selecionados, and reported under the other two.
  const relatar =
    noAlvo ||
    (res.tipo === SITUACAO_ERP_ITEM_LI.conflito &&
      (job.alvo === ALVO_IMPORTACAO_LI.jaNoErp || job.alvo === ALVO_IMPORTACAO_LI.naoNoErp));
  const base = {
    liId: raiz.id,
    noAlvo,
    relatar,
    situacaoErp: res.tipo,
    erpId:
      res.tipo === SITUACAO_ERP_ITEM_LI.vinculado || res.tipo === SITUACAO_ERP_ITEM_LI.encontrado
        ? res.erpId
        : null,
  };
  const vazio = { raizVinculo: null, filhosVinculos: [], criacao: null };

  if (!relatar) return { ...base, ...vazio, pendencias: semRepetir(pendencias) };

  if (res.tipo === SITUACAO_ERP_ITEM_LI.conflito) {
    pendencias.push({ codigo: res.pendencia, liId: null, referencias: [...res.erpIds] });
    return { ...base, ...vazio, pendencias: semRepetir(pendencias) };
  }

  if (res.tipo === SITUACAO_ERP_ITEM_LI.ausente) {
    if (job.acao !== ACAO_IMPORTACAO_LI.completar) {
      return { ...base, ...vazio, pendencias: semRepetir(pendencias) };
    }
    const { criacao, pendencias: daCriacao } = planejarCriacao(familia, e.skusEmConflito);
    return {
      ...base,
      ...vazio,
      criacao,
      pendencias: semRepetir([...pendencias, ...daCriacao]),
    };
  }

  // Matched: the root's link, then each matched variation's.
  const planoDaRaiz = planejarVinculoLi(
    job.integracaoId,
    PAPEL_DO_VINCULO_LI.raiz,
    res.erpId,
    raiz,
    familia.detalheDaRaiz,
    null,
  );
  if (planoDaRaiz.tipo === 'invalido') {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      liId: null,
      referencias: [...planoDaRaiz.campos],
    });
  }
  const raizVinculo = planoDaRaiz.tipo === 'ok' ? planoDaRaiz.vinculo : null;

  const filhosVinculos: VinculoPlanejadoLi[] = [];
  if (e.filhos !== null) {
    for (const p of e.filhos.pendencias) {
      pendencias.push(comVeredictoDoAprendizado(p, e.recusasDoAprendizado));
    }
    const porId = new Map<number, FilhoDaFamiliaLi>(familia.filhos.map((f) => [f.linha.id, f]));
    for (const r of e.filhos.filhos) {
      for (const p of r.pendencias) {
        pendencias.push(comVeredictoDoAprendizado(p, e.recusasDoAprendizado));
      }
      // The same verdict for an option the rung left silent (an exact duplicate is dropped below).
      pendencias.push(...veredictosDasOpcoes(r, e.recusasDoAprendizado));
      const filho = porId.get(r.liId);
      if (r.situacao !== SITUACAO_DO_FILHO_LI.casado || r.erp === null || filho === undefined) {
        continue;
      }
      if (raizVinculo === null) {
        // The root's link cannot be planned: no variation is linked without it.
        pendencias.push({
          codigo: PENDENCIA_IMPORTACAO_LI.vinculoPaiAusente,
          liId: r.liId,
          referencias: [],
        });
        continue;
      }
      const planoDoFilho = planejarVinculoLi(
        job.integracaoId,
        PAPEL_DO_VINCULO_LI.filho,
        r.erp.id,
        filho.linha,
        filho.detalhe,
        raiz.id,
      );
      if (planoDoFilho.tipo === 'invalido') {
        pendencias.push({
          codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
          liId: r.liId,
          referencias: [...planoDoFilho.campos],
        });
        continue;
      }
      filhosVinculos.push(planoDoFilho.vinculo);
    }
  }
  // A claimed variation still without a usable detail cannot be matched or linked.
  for (const id of familia.semDetalhe) {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      liId: id,
      referencias: ['detalhe'],
    });
  }

  return {
    ...base,
    raizVinculo,
    filhosVinculos: filhosVinculos.sort((a, b) => a.liId - b.liId),
    criacao: null,
    pendencias: semRepetir(pendencias),
  };
}
