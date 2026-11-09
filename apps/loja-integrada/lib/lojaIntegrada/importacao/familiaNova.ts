/**
 * The product import's WHOLE-FAMILY CREATE (master plan step 9, "complete"): a store family the ERP
 * does not have (`ausente`, after the match cascade) created in ONE batch of `create()`s — the
 * root, its variations or its sole member, their `extraData`, and this conta's link documents —
 * or nothing at all. Under Simular the same reads, checks and probe run and nothing is written:
 * the result is the outcome an `aplicar` run would have.
 *
 * Call it only for a family `plano.ts` classified as creatable (`criacao.viavel`): the root visible,
 * not an empty family, its name and SKU parsing, every kept variation visible with a SKU the store
 * does not repeat or nearly repeat. Hidden or blocked variations are already left out there (`oculto-nao-criado`):
 * this module creates exactly `criacao.filhos`.
 *
 * ## The checks before anything is planned
 *
 *  - **Every kept variation's options resolve** to an ERP variante (`resolverOpcoesDoFilhoLi`, over
 *    the grupos the caller passes — the dispatch's memo, plus, under Simular, the overlay of what
 *    the job would have learned): a variation with no option, or with any option that does not
 *    resolve, refuses the WHOLE family with `variacao-sem-vinculo` naming the options
 *    (`<grade>/<opção>`). No grupo and no variante is ever created (decided 2026-10-27).
 *  - **Two kept variations on one combination** of variantes refuse it with `variacao-ambigua`: an
 *    ERP family never holds two children of one combination.
 *  - **Every planned document parses** through its schema (`produto`, `extraData`, the link): a
 *    failure is `dado-invalido` with the field names, and nothing is created. The only truncation
 *    is a name: cut at {@link MAX_NOME_PRODUTO_LI} and reported (`nome-cortado`, informational, on the
 *    created family only: a refused create reports none).
 *    Two created variations whose CUT names come out equal refuse the create with `dado-invalido`
 *    (`nome`) on each: the ERP family builder never makes such a pair (its names fit the field
 *    whole), and two variations told apart by nothing but their ids would be one name twice in
 *    every list. A description over the ERP's limit is not written and is reported
 *    (`descricao-longa`), the product still created (decided 2026-11-03).
 *
 * ## The details (the store's fresher view)
 *
 * The plan classified the family on its LIST rows; the complete step then read the detail of the
 * root and of every kept variation, and a create is decided on those details too:
 *  - a detail that says the product is hidden, blocked or TRASHED: the root ⇒ the create is
 *    refused (`oculto-nao-criado`); a variation ⇒ it is left out like a hidden row
 *    (`oculto-nao-criado` on it, informational), and a family left with none is not created;
 *  - a detail whose SKU is not the row's (exact bytes): the ids are keyed by the SKU, so the create
 *    is refused (`dado-invalido`, `sku`) rather than key them on a stale one;
 *  - a detail that was never READ (the store answered 404 — a product deleted since the listing —
 *    or a body off its schema): the create is refused (`dado-invalido`, `detalhe`), so a product
 *    the store no longer has is never created, nor linked. This one is checked only AFTER the
 *    probe (step 2 below): a family whose details were never asked for because the probe would
 *    refuse it anyway ({@link recusasAntesDosDetalhesLi}) then reports the probe's verdict.
 *
 * ## Before the details ({@link recusasAntesDosDetalhesLi})
 *
 * The checks that need no detail — the options, the combinations, the probe over the SKUs the rows
 * give — are offered to the caller BEFORE it reads any detail, so a family the create would refuse
 * anyway costs no Loja Integrada call. They are run again, unchanged, by the create itself.
 *
 * ## The shapes — the ERP family builder's
 *
 *  - **A simple store product** becomes an ERP FAMÍLIA DE UM, the shape the web's "Novo produto"
 *    builds: the root carrying the store SKU, plus its SOLE MEMBER (`montarMembroUnico`: the
 *    root's mirror, its SKU derived by the ERP's own rule, no variation taxonomy, no `extraData`),
 *    and the root's `filhoUnicoId` naming the member. So the SKU rungs and the order import's
 *    sole-member hop answer for it exactly as for a hand-made product.
 *  - **A store family** becomes an ERP parent plus one child per kept variation. A child's NAME is
 *    the ERP family rule — the parent's name, then its variante names in grupo order
 *    (`reconstructFromVariacoesUid`, the web's reconstruct) — never the store variation's own
 *    `nome`; its `variacoesUid` / `grupoDeVariacoesUid` come from the resolution (normalised and
 *    ordered by the grupos' `ordem`), its `ordem` is its rank in the store's id order. The parent
 *    carries the union of its children's selection, as the variation screen stores it.
 *    `filhoUnicoId` is `derivarFilhoUnico` over the FULL child set: a one-child family names its
 *    child, a family of many names none.
 *  - **The store's values** are those of the fill-empty (`completar.ts`): ONE field map and ONE unit
 *    conversion, applied to a document with every field empty — so a created produto holds exactly
 *    what a fill of an empty one would. A variation takes its parent's resolved category and, when
 *    its read detail has no dimension of its own, its parent's box; its brand is its parent's.
 *    `ehUsado` is the detail's (a variation without one takes its parent's). Never written:
 *    `precos`, `custo`, any `estoques` or `imposto` document, the kit fields, `publicado`, `codPai`
 *    — each document is the produto schema's parse, so those hold the schema's defaults.
 *  - **The links** are the ones `plano.ts` plans for a matched family (`planejarVinculoLi`): on the
 *    ROOT for a simple product (never on its sole member), on the parent and on every child for a
 *    family, in the SAME batch as the produtos they sit under.
 *
 * ## Ids keyed by the SKU
 *
 * `li-sku-<sha256 hex of the UTF-8 SKU>` for a root or a child ({@link idProdutoCriadoLi}),
 * `li-sku-<sha256 of the root SKU>-un` for a sole member ({@link idMembroCriadoLi}). Exact bytes:
 * `'X'` and `'x'` are two ids. A retry meets its own documents, and two contas creating one SKU —
 * two stores selling one product — collide on one id instead of making two produtos.
 *
 * ## Each attempt (root rule 7, the plan's row 7) — tier 0 by construction
 *
 *  1. **The planned ids, read by id.** A produto already at one of them is judged: one holding the
 *     SAME SKU (exact bytes, `mesmoSkuLi`) with the planned parent (none for the root, the planned
 *     root for a child or the sole member) is OURS by construction; anything else at the id — a
 *     SKU edited since, a root sitting there as somebody's child — is `sku-ja-existe` naming it,
 *     never adopted. With the ROOT ours:
 *     - when this conta's link of the store root sits under it, created in the SAME commit as the
 *       root (equal `createTime`s: a batch commits under one stamp), it is THIS conta's batch,
 *       landed with its reply lost — the outcome is that creation (`criada`, `retomada`);
 *     - otherwise another conta's job created it (or a person keyed it so): the family is ADOPTED —
 *       `existente`, and the caller takes the existing-product path (fill and link).
 *     A variation or a sole member at its id with the root absent is `sku-ja-existe`: the ERP has
 *     that SKU outside this family.
 *  2. **The create probe** (`sondarSkusLi`), over EVERY SKU the batch would write — the root's,
 *     each child's, the sole member's derived one — across the WHOLE catalogue (roots and children,
 *     exact and the "parecido" forms), in the same dispatch and immediately before the commit, with
 *     no Loja Integrada call in between. An exact hit refuses the WHOLE family with `sku-ja-existe`
 *     naming the ERP ids; a "parecido" hit alone, with `sku-parecido` (decided 2026-11-03: a person
 *     decides). A hit on one of the planned ids is left to the commit, whose `ALREADY_EXISTS` is
 *     judged by step 1 on the next attempt. Then the details' presence ("The details" above).
 *  3. **What must precede the batch** ({@link DepsFamiliaNovaLi.antesDoLote}, `aplicar` only): the
 *     caller's own writes the batch depends on — the categories the produtos take, created only now
 *     that the family WILL be committed, and the tax-review entries the create calls for, made
 *     durable before the produtos exist (`familiaDoJob.ts`). Firestore writes only, no Loja
 *     Integrada call. Its refusal refuses the create with nothing of the batch written.
 *  4. **ONE batch of `create()`s**, all or nothing (Firestore rejects the whole commit when any of
 *     them exists). `ALREADY_EXISTS` starts the next attempt from step 1; a second one with nothing
 *     there to explain it (a stray link or `extraData` document left under one of the planned ids)
 *     is `conflito-de-escrita` ({@link MAX_TENTATIVAS_FAMILIA_NOVA_LI}).
 *
 * ⚠️ Accepted residual: an operator's hand-made produto with one of the SKUs (an AUTO id) landing
 * between the probe and the commit — a window step 3's few Firestore writes widen; the next run's
 * cascade finds two produtos for that SKU (`sku-ambiguo`). And a unit RETRIED after its batch
 * landed meets this conta's link through the cascade's rung 1 and never reaches this module:
 * telling that family "created by this job" apart from one found is the caller's (the link's and
 * the root's `createTime` against the job's).
 *
 * The batch holds at most 3 writes per produto (the produto, its `extraData`, its link): a store
 * family is capped at 50 variations, far under Firestore's 500 writes per commit; a plan past it is
 * refused (`dado-invalido`, `filhos`), never split.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 *  - the planned produtos, the root's link and the grupos the children name: documents by id;
 *  - the probe: `produtos where sku in [...]`, served by `produtos (sku ASC)` (`sondaSkuLi.ts`).
 *
 * ## Errors (root rule 6)
 *
 * Only `ALREADY_EXISTS` is caught, narrowed by its code; every other Firestore failure propagates and
 * the task retries.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { DocumentSnapshot, Firestore, WriteBatch } from 'firebase-admin/firestore';
import { sha256Hex } from '@delfrance/data/admin';
import {
  grupoDeVariacoesCollection,
  produtoCollection,
  produtoExtraDataCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import { isAlreadyExists } from '@delfrance/data/admin/grpcErrors';
import { type SondaSkuLi, sondarSkusLi } from '@delfrance/data/admin/produtos';
import {
  type GrupoComId,
  type GrupoComLinksLi,
  type MarcaCatalogoLi,
  MODO_IMPORTACAO_LI,
  type ModoImportacaoLi,
  PENDENCIA_IMPORTACAO_LI,
  PRODUTO_EXTRA_DATA_DOC_ID,
  type PendenciaImportacaoLi,
  type Produto,
  type ProdutoLiDetalhado,
  type ProdutoLiLido,
  RELACAO_VINCULO_LI,
  type ResolucaoOpcaoLi,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  derivarFilhoUnico,
  grupoDeVariacoesSchema,
  mesmoSkuLi,
  montarMembroUnico,
  normalizeVariacoesUid,
  produtoSchema,
  reconstructFromVariacoesUid,
  resolverOpcoesDoFilhoLi,
  sameCombo,
  sortGrupoUids,
  varianteFakePath,
  vinculoLiDaContaEId,
} from '@delfrance/schemas';

import {
  type ValoresDoLiLi,
  planejarPreenchimentoExtraDataLi,
  planejarPreenchimentoProdutoLi,
  valoresDoLiLi,
} from './completar';
import type { FamiliaLi, FilhoDaFamiliaLi } from './familias';
import {
  type CriacaoPlanejadaLi,
  MAX_NOME_PRODUTO_LI,
  PAPEL_DO_VINCULO_LI,
  type PapelDoVinculoLi,
  type PendenciaDoPlanoLi,
  type VinculoPlanejadoLi,
  camposDoErro,
  ocultoNaLojaLi,
  planejarVinculoLi,
} from './plano';

/** The id prefix of every produto the import creates (module header, "Ids keyed by the SKU"). */
export const PREFIXO_ID_PRODUTO_CRIADO_LI = 'li-sku-';

/** The suffix of a created sole member's id. */
export const SUFIXO_ID_MEMBRO_CRIADO_LI = '-un';

/** The attempts of one create: the first, and one more after an `ALREADY_EXISTS` (module header). */
export const MAX_TENTATIVAS_FAMILIA_NOVA_LI = 2;

/** Firestore's ceiling on the writes of one commit. */
export const MAX_ESCRITAS_POR_LOTE_LI = 500;

/** The id of a root or a variation the import creates for store SKU `sku`. Throws on `''`. */
export function idProdutoCriadoLi(sku: string): string {
  if (typeof sku !== 'string' || sku === '') {
    throw new RangeError('idProdutoCriadoLi: um SKU vazio não identifica um produto');
  }
  return `${PREFIXO_ID_PRODUTO_CRIADO_LI}${sha256Hex(sku)}`;
}

/** The id of the sole member the import creates under the root of store SKU `skuDaRaiz`. */
export function idMembroCriadoLi(skuDaRaiz: string): string {
  return `${idProdutoCriadoLi(skuDaRaiz)}${SUFIXO_ID_MEMBRO_CRIADO_LI}`;
}

/* -------------------------------------------------------------------------- */
/*                     The ERP family rule: grupos and names                    */
/* -------------------------------------------------------------------------- */

/** A grupo as the ERP family rule reads it (names, `ordem`), by id. */
export type GrupoErpLidoLi =
  | { readonly tipo: 'ok'; readonly grupo: GrupoComId }
  | { readonly tipo: 'ausente' }
  /** It does not parse as a grupo: its variantes cannot be named. */
  | { readonly tipo: 'invalido'; readonly campos: readonly string[] };

/** Read the grupos `ids` by id, each once. */
export async function lerGruposErpLi(
  db: Firestore,
  ids: Iterable<string>,
): Promise<ReadonlyMap<string, GrupoErpLidoLi>> {
  const unicos = [...new Set(ids)].sort();
  const lidos = await Promise.all(
    unicos.map(async (id): Promise<readonly [string, GrupoErpLidoLi]> => {
      const snap = await grupoDeVariacoesCollection.docRef(db, {}, id).get();
      if (!snap.exists) return [id, { tipo: 'ausente' }];
      const lido = grupoDeVariacoesSchema.safeParse(snap.data());
      return [
        id,
        lido.success
          ? { tipo: 'ok', grupo: { id, data: lido.data } }
          : { tipo: 'invalido', campos: camposDoErro(lido.error.issues) },
      ];
    }),
  );
  return new Map(lidos);
}

/** One store option resolved to ONE ERP variante. */
export interface OpcaoResolvidaLi {
  readonly gradeId: number;
  readonly opcaoId: number;
  readonly grupoId: string;
  readonly varianteId: string;
}

/** An option as the report names it: `<grade>/<opção>`, or nothing when it did not read. */
function referenciaDaOpcao(o: Pick<ResolucaoOpcaoLi, 'gradeId' | 'opcaoId'>): string[] {
  return o.gradeId === null || o.opcaoId === null
    ? []
    : [`${String(o.gradeId)}/${String(o.opcaoId)}`];
}

/**
 * A variation's options, every one resolved to ONE variante — or the options that are not (module
 * header, "The checks"). No option at all is not resolved either: an ERP family child needs one.
 * Pure.
 */
export function opcoesResolvidasLi(
  opcoes: readonly ResolucaoOpcaoLi[],
):
  | { readonly tipo: 'ok'; readonly opcoes: readonly OpcaoResolvidaLi[] }
  | { readonly tipo: 'recusada'; readonly referencias: readonly string[] } {
  const resolvidas: OpcaoResolvidaLi[] = [];
  const referencias: string[] = [];
  let recusada = opcoes.length === 0;
  for (const o of opcoes) {
    const [grupoId] = o.grupoIds;
    const [varianteId] = o.varianteIds;
    if (
      o.tipo !== TIPO_RESOLUCAO_OPCAO_LI.resolvida ||
      o.gradeId === null ||
      o.opcaoId === null ||
      o.grupoIds.length !== 1 ||
      o.varianteIds.length !== 1 ||
      grupoId === undefined ||
      varianteId === undefined
    ) {
      recusada = true;
      referencias.push(...referenciaDaOpcao(o));
      continue;
    }
    resolvidas.push({ gradeId: o.gradeId, opcaoId: o.opcaoId, grupoId, varianteId });
  }
  return recusada ? { tipo: 'recusada', referencias } : { tipo: 'ok', opcoes: resolvidas };
}

/**
 * Whether a store product's DETAIL says it is not to be created (module header, "The details"):
 * hidden (`ativo: false`), blocked (`bloqueado: true`) or trashed (`removido: true`). Pure.
 */
export function foraDaLojaNoDetalheLi(
  detalhe: Pick<ProdutoLiDetalhado, 'ativo' | 'bloqueado' | 'removido'>,
): boolean {
  return ocultoNaLojaLi(detalhe) || detalhe.removido === true;
}

/**
 * The store ids of created variations whose names the cut made EQUAL (module header, "The
 * checks"): every member of a group of two or more equal names of which at least one was cut.
 * Equal without any cut (two variantes of one name in two grupos) is the ERP builder's own result,
 * and is left alone. Pure.
 */
export function nomesIguaisPeloCorteLi(
  nomes: readonly { readonly liId: number; readonly nome: string; readonly cortado: boolean }[],
): number[] {
  const porNome = new Map<string, { liIds: number[]; cortado: boolean }>();
  for (const n of nomes) {
    const grupo = porNome.get(n.nome) ?? { liIds: [], cortado: false };
    grupo.liIds.push(n.liId);
    grupo.cortado ||= n.cortado;
    porNome.set(n.nome, grupo);
  }
  return [...porNome.values()]
    .filter((g) => g.liIds.length > 1 && g.cortado)
    .flatMap((g) => g.liIds)
    .sort((a, b) => a - b);
}

/** A created variation's taxonomy and name (module header, "The shapes"). */
export type TaxonomiaDoFilhoLi =
  | {
      readonly tipo: 'ok';
      readonly nome: string;
      readonly nomeCortado: boolean;
      readonly variacoesUid: readonly string[];
      readonly grupoDeVariacoesUid: readonly string[];
    }
  | {
      readonly tipo: 'recusada';
      readonly codigo: PendenciaImportacaoLi;
      readonly referencias: readonly string[];
    };

/** The variante fake paths of resolved options, in the store's order. */
export function combinacaoLi(opcoes: readonly OpcaoResolvidaLi[]): string[] {
  return opcoes.map((o) => varianteFakePath(o.grupoId, o.varianteId));
}

/**
 * A created variation's name, `variacoesUid` and `grupoDeVariacoesUid` by the ERP family rule
 * (module header): the parent's name, then the variante names in grupo order. A grupo gone ⇒
 * `variacao-sem-vinculo` on its options; a grupo that does not parse ⇒ `dado-invalido`
 * (`grupoDeVariacoes.<campo>`); a variante the grupo no longer holds ⇒ `variacao-sem-vinculo`. Pure.
 */
export function taxonomiaDoFilhoLi(
  opcoes: readonly OpcaoResolvidaLi[],
  nomeDoPai: string,
  grupos: ReadonlyMap<string, GrupoErpLidoLi>,
): TaxonomiaDoFilhoLi {
  const comGrupo: GrupoComId[] = [];
  const ausentes: string[] = [];
  const invalidos = new Set<string>();
  for (const o of opcoes) {
    const lido = grupos.get(o.grupoId);
    if (lido === undefined || lido.tipo === 'ausente') {
      ausentes.push(...referenciaDaOpcao(o));
    } else if (lido.tipo === 'invalido') {
      for (const c of lido.campos) invalidos.add(`grupoDeVariacoes.${c}`);
    } else if (!comGrupo.some((g) => g.id === lido.grupo.id)) {
      comGrupo.push(lido.grupo);
    }
  }
  if (invalidos.size > 0) {
    return {
      tipo: 'recusada',
      codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
      referencias: [...invalidos],
    };
  }
  if (ausentes.length > 0) {
    return {
      tipo: 'recusada',
      codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
      referencias: ausentes,
    };
  }
  const nomeado = reconstructFromVariacoesUid({
    childUids: combinacaoLi(opcoes),
    parentNome: nomeDoPai,
    parentSku: '',
    grupos: comGrupo,
  });
  if (!nomeado.ok) {
    return {
      tipo: 'recusada',
      codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
      referencias: opcoes.flatMap(referenciaDaOpcao),
    };
  }
  return {
    tipo: 'ok',
    nome: nomeado.nome.slice(0, MAX_NOME_PRODUTO_LI),
    nomeCortado: nomeado.nome.length > MAX_NOME_PRODUTO_LI,
    variacoesUid: nomeado.variacoesUid,
    grupoDeVariacoesUid: sortGrupoUids(
      opcoes.map((o) => o.grupoId),
      comGrupo,
    ),
  };
}

/* -------------------------------------------------------------------------- */
/*                               The planned documents                          */
/* -------------------------------------------------------------------------- */

/** What a created produto is in its family. */
export type PapelDoProdutoCriadoLi = 'raiz' | 'membro' | 'filho';

/** Named members of {@link PapelDoProdutoCriadoLi}. */
export const PAPEL_DO_PRODUTO_CRIADO_LI = {
  raiz: 'raiz',
  membro: 'membro',
  filho: 'filho',
} as const satisfies Record<string, PapelDoProdutoCriadoLi>;

/** One produto a batch creates, with everything that rides with it. */
export interface ProdutoPlanejadoLi {
  readonly produtoId: string;
  readonly papel: PapelDoProdutoCriadoLi;
  /** The store product it comes from (a sole member: its root's). */
  readonly liId: number;
  /** The SKU it writes — what the probe looks up. */
  readonly sku: string;
  /** The parent it is created under (`null` for a root). */
  readonly paiId: string | null;
  /** The produto document, as parsed by the produto schema. */
  readonly doc: Readonly<Record<string, unknown>>;
  /** Its `extraData/singleton` (only the filled keys), or `null` when the store gives none. */
  readonly extraData: Readonly<Record<string, unknown>> | null;
  /** This conta's link under it, or `null` (a sole member carries none). */
  readonly vinculo: VinculoPlanejadoLi | null;
}

/** A planned document, or the field names that refused it. */
type DocPlanejado =
  | {
      readonly tipo: 'ok';
      readonly doc: Produto;
      readonly extraData: Record<string, unknown> | null;
      readonly descricaoLongaTamanho: number | null;
    }
  | { readonly tipo: 'invalido'; readonly campos: readonly string[] };

/**
 * A created produto's documents (module header, "The shapes"): `base` (name, SKU, parent,
 * taxonomy, `ordem`, `filhoUnicoId`) plus the store's values exactly as the fill-empty plans them
 * on a document with every field EMPTY, `ehUsado` and the job's ms stamps, parsed by the produto
 * schema. Any field the plan or the parse refuses refuses the document. Pure.
 */
export function planejarDocCriadoLi(
  base: Readonly<Record<string, unknown>>,
  valores: ValoresDoLiLi,
  ehUsado: boolean | null,
  agoraMs: number,
): DocPlanejado {
  const produto = planejarPreenchimentoProdutoLi({}, valores);
  const extra = planejarPreenchimentoExtraDataLi(null, valores);
  const candidato: Record<string, unknown> = {
    ...base,
    ...produto.patch,
    ...(ehUsado === null ? {} : { ehUsado }),
    timestamp: agoraMs,
    ultimaModificacao: agoraMs,
  };
  const lido = produtoSchema.safeParse(candidato);
  const campos = [
    ...produto.invalidos,
    ...extra.invalidos,
    ...(lido.success ? [] : camposDoErro(lido.error.issues)),
  ];
  if (!lido.success || campos.length > 0) return { tipo: 'invalido', campos: [...new Set(campos)] };
  return {
    tipo: 'ok',
    doc: lido.data,
    // Only the filled keys, validated as the collection validates a merge (`completar.ts`).
    extraData:
      Object.keys(extra.patch).length === 0
        ? null
        : produtoExtraDataCollection.parseMerge({ ...extra.patch }),
    descricaoLongaTamanho: extra.descricaoLongaTamanho,
  };
}

/** `ehUsado` from a detail: its own boolean, else (a variation) its parent's, else nothing. */
function usadoDe(
  detalhe: ProdutoLiDetalhado | null,
  doPai: ProdutoLiDetalhado | null,
): boolean | null {
  if (typeof detalhe?.usado === 'boolean') return detalhe.usado;
  return typeof doPai?.usado === 'boolean' ? doPai.usado : null;
}

/** How many writes a batch of `produtos` takes (the produto, its `extraData`, its link). */
export function escritasDoLoteLi(produtos: readonly ProdutoPlanejadoLi[]): number {
  return produtos.reduce(
    (n, p) => n + 1 + (p.extraData === null ? 0 : 1) + (p.vinculo?.doc ? 1 : 0),
    0,
  );
}

/** Queue every create of `produtos` on ONE batch (module header, step 3). */
export function enfileirarCriacoesLi(
  db: Firestore,
  lote: WriteBatch,
  produtos: readonly ProdutoPlanejadoLi[],
): void {
  for (const p of produtos) {
    lote.create(produtoCollection.docRef(db, {}, p.produtoId), { ...p.doc });
    if (p.extraData !== null) {
      lote.create(
        produtoExtraDataCollection.docRef(
          db,
          { produtoId: p.produtoId },
          PRODUTO_EXTRA_DATA_DOC_ID,
        ),
        { ...p.extraData },
      );
    }
    if (p.vinculo?.doc) {
      lote.create(
        produtoLojaIntegradaLinkCollection.docRef(
          db,
          { produtoId: p.produtoId },
          String(p.vinculo.liId),
        ),
        { ...p.vinculo.doc },
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/*                         The planned ids and the probe                        */
/* -------------------------------------------------------------------------- */

/** What sits at a planned id (module header, step 1). */
export type EstadoDoIdPlanejadoLi =
  /** Nothing. */
  | 'livre'
  /** A produto with the planned SKU (exact bytes) and the planned parent. */
  | 'nosso'
  /** Anything else: another SKU, another parent. */
  | 'outro';

/** Named members of {@link EstadoDoIdPlanejadoLi}. */
export const ESTADO_DO_ID_PLANEJADO_LI = {
  livre: 'livre',
  nosso: 'nosso',
  outro: 'outro',
} as const satisfies Record<string, EstadoDoIdPlanejadoLi>;

/** A stored `paiId` as a parent id: a non-empty string, else none (absent and `null` alike). */
export function paiArmazenadoLi(dados: Readonly<Record<string, unknown>>): string | null {
  const paiId = dados.paiId;
  return typeof paiId === 'string' && paiId !== '' ? paiId : null;
}

/**
 * What a read of planned produto `p` found (module header, step 1). Equal (`nosso`): the stored
 * `sku` is the planned one byte for byte AND its `paiId` is the planned parent. Distinct (`outro`):
 * `'x'` or `'X '` for `'X'`; the planned SKU under another parent; a root found as a child. Pure.
 */
export function estadoDoIdPlanejadoLi(
  snap: Pick<DocumentSnapshot, 'exists' | 'data'>,
  p: Pick<ProdutoPlanejadoLi, 'sku' | 'paiId'>,
): EstadoDoIdPlanejadoLi {
  if (!snap.exists) return ESTADO_DO_ID_PLANEJADO_LI.livre;
  const dados = (snap.data() ?? {}) as Record<string, unknown>;
  return mesmoSkuLi(p.sku, dados.sku) && paiArmazenadoLi(dados) === p.paiId
    ? ESTADO_DO_ID_PLANEJADO_LI.nosso
    : ESTADO_DO_ID_PLANEJADO_LI.outro;
}

/**
 * Whether this conta's link of store product `liId` sits under the produto of `snapDoProduto`,
 * created in the SAME commit as the produto (module header, step 1): equal `createTime`s are one
 * batch, so it is this conta's create, landed. One read by id. Never under Simular.
 */
export async function criadoComOVinculoDaContaLi(
  db: Firestore,
  contaId: string,
  snapDoProduto: Pick<DocumentSnapshot, 'id' | 'createTime'>,
  liId: number,
): Promise<boolean> {
  const criado = snapDoProduto.createTime;
  if (criado === undefined) return false;
  const vinculo = await produtoLojaIntegradaLinkCollection
    .docRef(db, { produtoId: snapDoProduto.id }, String(liId))
    .get();
  if (!vinculo.exists || vinculo.createTime === undefined) return false;
  return (
    vinculoLiDaContaEId(vinculo.data(), contaId, liId) === RELACAO_VINCULO_LI.mesmo &&
    vinculo.createTime.isEqual(criado)
  );
}

/** One SKU the probe asked about, and the pendência's subject. */
export interface SkuSondadoLi {
  readonly sku: string;
  /** The variation a refusal names; `null` for the family (the root and a sole member). */
  readonly liId: number | null;
}

/**
 * The probe's verdict (module header, step 2): per SKU, an exact hit ⇒ `sku-ja-existe` naming the
 * ERP ids; else a "parecido" hit ⇒ `sku-parecido`. Hits on `idsPlanejados` are left to the commit.
 * Pure.
 */
export function veredictoDaSondaLi(
  sonda: ReadonlyMap<string, SondaSkuLi>,
  skus: readonly SkuSondadoLi[],
  idsPlanejados: ReadonlySet<string>,
): PendenciaDoPlanoLi[] {
  const pendencias: PendenciaDoPlanoLi[] = [];
  for (const { sku, liId } of skus) {
    const achado = sonda.get(sku);
    const exatos = (achado?.exatos ?? []).filter((id) => !idsPlanejados.has(id));
    const parecidos = (achado?.parecidos ?? []).filter((id) => !idsPlanejados.has(id));
    if (exatos.length > 0) {
      pendencias.push({ codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste, liId, referencias: exatos });
    } else if (parecidos.length > 0) {
      pendencias.push({
        codigo: PENDENCIA_IMPORTACAO_LI.skuParecido,
        liId,
        referencias: parecidos,
      });
    }
  }
  return pendencias;
}

/* -------------------------------------------------------------------------- */
/*                                  The family                                  */
/* -------------------------------------------------------------------------- */

export interface DepsFamiliaNovaLi {
  readonly db: Firestore;
  /** The Loja Integrada conta (integração doc id) the job reads. */
  readonly contaId: string;
  /** Simular reads, checks and probes exactly as `aplicar` does, and writes nothing. */
  readonly modo: ModoImportacaoLi;
  /** The job's clock, ms: `timestamp` and `ultimaModificacao` of every created produto. */
  readonly agoraMs: () => number;
  /**
   * Test seam: runs after an attempt's reads and its probe, right before its commit — the window a
   * concurrent writer lands in. Production passes nothing.
   */
  readonly antesDoCommit?: () => Promise<void> | void;
  /**
   * What must precede the batch (module header, step 3), `aplicar` only: runs once an attempt's ids
   * are judged, its probe passed and every detail is there, with the produtos the batch creates.
   * `null` (or none) ⇒ the batch is committed; pendências ⇒ the create is refused with them and
   * nothing of the batch is written. A throw propagates.
   */
  readonly antesDoLote?: (
    produtos: readonly ProdutoCriadoLi[],
  ) => Promise<readonly PendenciaDoPlanoLi[] | null>;
}

export interface EntradaDaFamiliaNovaLi {
  /** The store family, with the details this job read. */
  readonly familia: FamiliaLi;
  /** `plano.ts`'s create classification; `viavel` must be `true`. */
  readonly criacao: CriacaoPlanejadaLi;
  /** What options resolve against: the dispatch's memo, plus the Simular overlay. */
  readonly grupos: readonly GrupoComLinksLi[];
  /** The root's resolved ERP categoria (`categorias.ts`), which its variations take too. */
  readonly categoriaErpId: string | null;
  /** The job's brand list. */
  readonly marcas: readonly MarcaCatalogoLi[];
}

/** One produto the family create wrote (or, under Simular, would write). */
export interface ProdutoCriadoLi {
  readonly produtoId: string;
  readonly papel: PapelDoProdutoCriadoLi;
  readonly liId: number;
}

/** How a family create ended. */
export type ResultadoDaFamiliaNovaLi =
  | {
      readonly tipo: 'criada';
      readonly raizId: string;
      /** The root first, then the sole member or the children (ascending store id). */
      readonly produtos: readonly ProdutoCriadoLi[];
      /** The links the batch wrote (the root's first). */
      readonly vinculos: readonly VinculoPlanejadoLi[];
      /**
       * What a created family still reports: a description too long to write (`descricao-longa`), a
       * name cut at {@link MAX_NOME_PRODUTO_LI} (`nome-cortado`), a variation left out.
       */
      readonly pendencias: readonly PendenciaDoPlanoLi[];
      /** The batch landed (`aplicar` only). */
      readonly gravado: boolean;
      /** This conta's batch had already landed (its reply lost): nothing written by this call. */
      readonly retomada: boolean;
    }
  /** The root exists at its id with the store SKU: the caller takes the existing-product path. */
  | { readonly tipo: 'existente'; readonly raizId: string }
  /** Nothing created; `pendencias` say why. */
  | { readonly tipo: 'recusada'; readonly pendencias: readonly PendenciaDoPlanoLi[] };

/** Named members of {@link ResultadoDaFamiliaNovaLi}'s `tipo`. */
export const TIPO_RESULTADO_FAMILIA_NOVA_LI = {
  criada: 'criada',
  existente: 'existente',
  recusada: 'recusada',
} as const satisfies Record<string, ResultadoDaFamiliaNovaLi['tipo']>;

/** The family's plan: every document of the batch, or the refusals. */
type PlanoDaFamiliaNova =
  | {
      readonly tipo: 'ok';
      readonly raizId: string;
      readonly produtos: readonly ProdutoPlanejadoLi[];
      readonly pendencias: readonly PendenciaDoPlanoLi[];
      /**
       * The produtos planned WITHOUT a read detail (module header, "The details"): `dado-invalido`
       * (`detalhe`) each, checked only after the probe.
       */
      readonly semDetalhe: readonly PendenciaDoPlanoLi[];
    }
  | { readonly tipo: 'recusada'; readonly pendencias: readonly PendenciaDoPlanoLi[] };

function recusa(pendencias: readonly PendenciaDoPlanoLi[]): {
  readonly tipo: 'recusada';
  readonly pendencias: readonly PendenciaDoPlanoLi[];
} {
  return { tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.recusada, pendencias };
}

/** A kept variation, its resolved options and its taxonomy. */
interface FilhoDoPlano {
  readonly filho: FilhoDaFamiliaLi;
  readonly sku: string;
  readonly opcoes: readonly OpcaoResolvidaLi[];
}

/** The kept variations of a create, each with every option resolved — or what refuses them. */
interface FilhosDaCriacao {
  readonly filhos: readonly FilhoDoPlano[];
  /** What refuses the WHOLE family (no SKU, an option, a combination, a detail's SKU). */
  readonly recusas: readonly PendenciaDoPlanoLi[];
  /** Variations a read detail shows hidden, blocked or trashed: left out (informational). */
  readonly deixados: readonly PendenciaDoPlanoLi[];
}

/**
 * The kept variations — exactly `criacao.filhos`, minus those a read detail shows out of the store —
 * each with every option resolved, and no two on one combination (module header, "The checks" and
 * "The details"). Pure; needs no detail (a variation whose detail is not read is judged on its row).
 */
function filhosDaCriacaoLi(
  contaId: string,
  entrada: Pick<EntradaDaFamiliaNovaLi, 'familia' | 'criacao' | 'grupos'>,
): FilhosDaCriacao {
  const { familia, criacao } = entrada;
  const ehFamilia = familia.raiz.tipo === TIPO_PRODUTO_LI.atributo;
  const porId = new Map(familia.filhos.map((f) => [f.linha.id, f]));
  const filhos: FilhoDoPlano[] = [];
  const recusas: PendenciaDoPlanoLi[] = [];
  const deixados: PendenciaDoPlanoLi[] = [];
  for (const liId of ehFamilia ? criacao.filhos : []) {
    const filho = porId.get(liId);
    if (filho === undefined) {
      throw new RangeError(`criarFamiliaLi: a variação ${String(liId)} não está na família`);
    }
    const { sku } = filho.linha;
    if (sku === null) {
      recusas.push({ codigo: PENDENCIA_IMPORTACAO_LI.semSku, liId, referencias: [] });
      continue;
    }
    if (filho.detalhe !== null && foraDaLojaNoDetalheLi(filho.detalhe)) {
      deixados.push({ codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId, referencias: [] });
      continue;
    }
    if (filho.detalhe !== null && !mesmoSkuLi(sku, filho.detalhe.sku)) {
      recusas.push({ codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId, referencias: ['sku'] });
      continue;
    }
    const opcoes = opcoesResolvidasLi(
      resolverOpcoesDoFilhoLi({
        contaId,
        opcoesUris: filho.linha.variacoes,
        grupos: entrada.grupos,
      }),
    );
    if (opcoes.tipo === 'recusada') {
      recusas.push({
        codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
        liId,
        referencias: opcoes.referencias,
      });
      continue;
    }
    filhos.push({ filho, sku, opcoes: opcoes.opcoes });
  }
  // Two kept variations on one combination: an ERP family never holds two such children.
  for (const a of filhos) {
    const outros = filhos.filter(
      (b) => b !== a && sameCombo(combinacaoLi(a.opcoes), combinacaoLi(b.opcoes)),
    );
    if (outros.length > 0) {
      recusas.push({
        codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
        liId: a.filho.linha.id,
        referencias: outros.map((b) => String(b.filho.linha.id)),
      });
    }
  }
  return { filhos, recusas, deixados };
}

/**
 * What refuses a create WITHOUT any detail (module header, "Before the details"): the kept
 * variations' options and combinations, then the create probe over every SKU the batch would write
 * as the ROWS give it (the root's, each kept variation's, a sole member's derived one). The caller
 * asks it before reading a family's details, so a family the create would refuse anyway costs no
 * Loja Integrada call. `[]` ⇒ nothing refuses it yet. Reads: the probe only (`produtos (sku ASC)`).
 */
export async function recusasAntesDosDetalhesLi(
  deps: Pick<DepsFamiliaNovaLi, 'db' | 'contaId'>,
  entrada: Pick<EntradaDaFamiliaNovaLi, 'familia' | 'criacao' | 'grupos'>,
): Promise<readonly PendenciaDoPlanoLi[]> {
  const { raiz } = entrada.familia;
  if (raiz.sku === null) {
    return [{ codigo: PENDENCIA_IMPORTACAO_LI.semSku, liId: null, referencias: [] }];
  }
  const { filhos, recusas } = filhosDaCriacaoLi(deps.contaId, entrada);
  if (recusas.length > 0) return recusas;
  const skus: SkuSondadoLi[] = [{ sku: raiz.sku, liId: null }];
  const ids = new Set([idProdutoCriadoLi(raiz.sku)]);
  // The sole member's SKU exactly as the create derives it: the ERP builder's own mirror.
  const membro: unknown =
    raiz.tipo === TIPO_PRODUTO_LI.atributo
      ? null
      : montarMembroUnico(idProdutoCriadoLi(raiz.sku), { sku: raiz.sku }).sku;
  if (typeof membro === 'string' && membro !== '') {
    skus.push({ sku: membro, liId: null });
    ids.add(idMembroCriadoLi(raiz.sku));
  }
  for (const f of filhos) {
    skus.push({ sku: f.sku, liId: f.filho.linha.id });
    ids.add(idProdutoCriadoLi(f.sku));
  }
  const sonda = await sondarSkusLi(
    deps.db,
    skus.map((s) => s.sku),
  );
  return veredictoDaSondaLi(sonda, skus, ids);
}

/** The plan of the whole batch (module header, "The checks", "The details" and "The shapes"). */
async function planejarFamiliaNova(
  deps: DepsFamiliaNovaLi,
  entrada: EntradaDaFamiliaNovaLi,
): Promise<PlanoDaFamiliaNova> {
  const { familia, criacao, categoriaErpId, marcas } = entrada;
  const { raiz, detalheDaRaiz } = familia;
  const agora = deps.agoraMs();
  if (raiz.sku === null) {
    return recusa([{ codigo: PENDENCIA_IMPORTACAO_LI.semSku, liId: null, referencias: [] }]);
  }
  const nome = criacao.nome;
  if (nome === null) {
    return recusa([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['nome'] },
    ]);
  }
  // The root's detail, when read, is the fresher view (module header, "The details").
  if (detalheDaRaiz !== null && foraDaLojaNoDetalheLi(detalheDaRaiz)) {
    return recusa([
      { codigo: PENDENCIA_IMPORTACAO_LI.ocultoNaoCriado, liId: null, referencias: [] },
    ]);
  }
  if (detalheDaRaiz !== null && !mesmoSkuLi(raiz.sku, detalheDaRaiz.sku)) {
    return recusa([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['sku'] },
    ]);
  }
  const raizId = idProdutoCriadoLi(raiz.sku);
  const ehFamilia = raiz.tipo === TIPO_PRODUTO_LI.atributo;

  // The kept variations: `criacao.filhos` minus those a detail shows out of the store, each with
  // every option resolved.
  const daCriacao = filhosDaCriacaoLi(deps.contaId, entrada);
  const { filhos } = daCriacao;
  const pendencias: PendenciaDoPlanoLi[] = [...daCriacao.deixados];
  if (criacao.nomeCortado) {
    pendencias.push({ codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado, liId: null, referencias: [] });
  }
  const recusas: PendenciaDoPlanoLi[] = [...daCriacao.recusas];
  if (ehFamilia && filhos.length + recusas.length === 0) {
    // Every kept variation left out by its detail: the family is not created.
    if (daCriacao.deixados.length > 0) return recusa(daCriacao.deixados);
    throw new RangeError('criarFamiliaLi: uma família sem variação a criar não é viável');
  }
  if (recusas.length > 0) return recusa(recusas);

  // The children's taxonomy, by the ERP family rule over the grupos as stored.
  const grupos = await lerGruposErpLi(
    deps.db,
    filhos.flatMap((f) => f.opcoes.map((o) => o.grupoId)),
  );
  const taxonomias = filhos.map((f) => taxonomiaDoFilhoLi(f.opcoes, nome, grupos));
  taxonomias.forEach((t, i) => {
    if (t.tipo === 'recusada') {
      recusas.push({
        codigo: t.codigo,
        liId: filhos[i]?.filho.linha.id ?? null,
        referencias: t.referencias,
      });
    }
  });
  // Two variations the name cut made one name (module header, "The checks").
  const iguais = nomesIguaisPeloCorteLi(
    filhos.flatMap((f, i) => {
      const t = taxonomias[i];
      return t?.tipo === 'ok'
        ? [{ liId: f.filho.linha.id, nome: t.nome, cortado: t.nomeCortado }]
        : [];
    }),
  );
  for (const liId of iguais) {
    recusas.push({ codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId, referencias: ['nome'] });
  }
  if (recusas.length > 0) return recusa(recusas);

  const invalido = (liId: number | null, campos: readonly string[]) => {
    recusas.push({ codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId, referencias: [...campos] });
  };
  const descricaoLonga = (liId: number | null, tamanho: number | null) => {
    if (tamanho !== null) {
      pendencias.push({
        codigo: PENDENCIA_IMPORTACAO_LI.descricaoLonga,
        liId,
        referencias: [String(tamanho)],
      });
    }
  };
  const vinculoDe = (
    papel: PapelDoVinculoLi,
    produtoId: string,
    f: { readonly linha: ProdutoLiLido; readonly detalhe: ProdutoLiDetalhado | null },
  ): VinculoPlanejadoLi | null => {
    const plano = planejarVinculoLi(
      deps.contaId,
      papel,
      produtoId,
      f.linha,
      f.detalhe,
      papel === PAPEL_DO_VINCULO_LI.filho ? raiz.id : null,
    );
    if (plano.tipo === 'invalido') {
      invalido(papel === PAPEL_DO_VINCULO_LI.filho ? f.linha.id : null, plano.campos);
      return null;
    }
    return plano.vinculo;
  };

  // The children first: the root's `filhoUnicoId` and selection are derived from them.
  const produtosDosFilhos: ProdutoPlanejadoLi[] = [];
  filhos.forEach((f, ordem) => {
    const t = taxonomias[ordem];
    if (t?.tipo !== 'ok') return;
    const { linha, detalhe } = f.filho;
    const produtoId = idProdutoCriadoLi(f.sku);
    if (t.nomeCortado) {
      pendencias.push({
        codigo: PENDENCIA_IMPORTACAO_LI.nomeCortado,
        liId: linha.id,
        referencias: [],
      });
    }
    const doc = planejarDocCriadoLi(
      {
        nome: t.nome,
        sku: f.sku,
        paiId: raizId,
        ordem,
        variacoesUid: [...t.variacoesUid],
        grupoDeVariacoesUid: [...t.grupoDeVariacoesUid],
      },
      valoresDoLiLi({
        papel: PAPEL_DO_VINCULO_LI.filho,
        linha,
        detalhe,
        detalheDoPai: detalheDaRaiz,
        categoriaErpId,
        marcas,
      }),
      usadoDe(detalhe, detalheDaRaiz),
      agora,
    );
    if (doc.tipo === 'invalido') {
      invalido(linha.id, doc.campos);
      return;
    }
    descricaoLonga(linha.id, doc.descricaoLongaTamanho);
    const vinculo = vinculoDe(PAPEL_DO_VINCULO_LI.filho, produtoId, f.filho);
    if (vinculo === null) return;
    produtosDosFilhos.push({
      produtoId,
      papel: PAPEL_DO_PRODUTO_CRIADO_LI.filho,
      liId: linha.id,
      sku: f.sku,
      paiId: raizId,
      doc: doc.doc,
      extraData: doc.extraData,
      vinculo,
    });
  });

  // The root: a family's parent, or a simple product's root with its sole member.
  const membroId = ehFamilia ? null : idMembroCriadoLi(raiz.sku);
  // The FULL child set: the children planned, or the one sole member.
  const filhosIds =
    membroId === null ? produtosDosFilhos.map((p) => ({ id: p.produtoId })) : [{ id: membroId }];
  const selecao = taxonomias.flatMap((t) => (t.tipo === 'ok' ? t.variacoesUid : []));
  const gruposDaSelecao: GrupoComId[] = [...grupos.values()].flatMap((g) =>
    g.tipo === 'ok' ? [g.grupo] : [],
  );
  const raizDoc = planejarDocCriadoLi(
    {
      nome,
      sku: raiz.sku,
      paiId: null,
      filhoUnicoId: derivarFilhoUnico(filhosIds),
      ...(ehFamilia
        ? {
            variacoesUid: normalizeVariacoesUid(selecao, gruposDaSelecao),
            grupoDeVariacoesUid: sortGrupoUids(
              taxonomias.flatMap((t) => (t.tipo === 'ok' ? t.grupoDeVariacoesUid : [])),
              gruposDaSelecao,
            ),
          }
        : {}),
    },
    valoresDoLiLi({
      papel: PAPEL_DO_VINCULO_LI.raiz,
      linha: raiz,
      detalhe: detalheDaRaiz,
      detalheDoPai: null,
      categoriaErpId,
      marcas,
    }),
    usadoDe(detalheDaRaiz, null),
    agora,
  );
  if (raizDoc.tipo === 'invalido') {
    invalido(null, raizDoc.campos);
    return recusa(recusas);
  }
  descricaoLonga(null, raizDoc.descricaoLongaTamanho);
  const raizVinculo = vinculoDe(PAPEL_DO_VINCULO_LI.raiz, raizId, {
    linha: raiz,
    detalhe: detalheDaRaiz,
  });
  if (raizVinculo === null || recusas.length > 0) return recusa(recusas);

  const produtos: ProdutoPlanejadoLi[] = [
    {
      produtoId: raizId,
      papel: PAPEL_DO_PRODUTO_CRIADO_LI.raiz,
      liId: raiz.id,
      sku: raiz.sku,
      paiId: null,
      doc: { ...raizDoc.doc },
      extraData: raizDoc.extraData,
      vinculo: raizVinculo,
    },
  ];
  if (membroId !== null) {
    // The sole member: the root's mirror by the ERP's own rule, its SKU derived from the root's.
    // Only the fields the store gave: everything else of the mirror is the schema's default.
    const r = raizDoc.doc;
    const membro = produtoSchema.safeParse({
      ...montarMembroUnico(raizId, {
        nome: r.nome,
        sku: r.sku,
        gtin: r.gtin,
        ehUsado: r.ehUsado,
        categoriaProdutoOuterRef: r.categoriaProdutoOuterRef,
        pesoLiquidoKg: r.pesoLiquidoKg,
        pesoBrutoKg: r.pesoBrutoKg,
        alturaCm: r.alturaCm,
        larguraCm: r.larguraCm,
        profundidadeCm: r.profundidadeCm,
      }),
      timestamp: agora,
      ultimaModificacao: agora,
    });
    if (!membro.success) {
      return recusa([
        {
          codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
          liId: null,
          referencias: camposDoErro(membro.error.issues).map((c) => `membro.${c}`),
        },
      ]);
    }
    if (typeof membro.data.sku !== 'string' || membro.data.sku === '') {
      // A root SKU of spaces only derives no member SKU: nothing could identify the member.
      return recusa([
        { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['sku'] },
      ]);
    }
    produtos.push({
      produtoId: membroId,
      papel: PAPEL_DO_PRODUTO_CRIADO_LI.membro,
      liId: raiz.id,
      sku: membro.data.sku,
      paiId: raizId,
      doc: { ...membro.data },
      extraData: null,
      vinculo: null,
    });
  }
  produtos.push(...produtosDosFilhos);
  if (escritasDoLoteLi(produtos) > MAX_ESCRITAS_POR_LOTE_LI) {
    return recusa([
      { codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['filhos'] },
    ]);
  }
  // Every produto created from a store product whose detail was never read (module header, "The
  // details"): refused, but only once the probe had its say.
  const semDetalhe: PendenciaDoPlanoLi[] = [
    ...(detalheDaRaiz === null
      ? [{ codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido, liId: null, referencias: ['detalhe'] }]
      : []),
    ...filhos
      .filter((f) => f.filho.detalhe === null)
      .map((f) => ({
        codigo: PENDENCIA_IMPORTACAO_LI.dadoInvalido,
        liId: f.filho.linha.id,
        referencias: ['detalhe'],
      })),
  ];
  return { tipo: 'ok', raizId, produtos, pendencias, semDetalhe };
}

/** What step 1 decided over the planned ids. */
type JulgamentoDosIds =
  | { readonly tipo: 'livre' }
  | { readonly tipo: 'existente' }
  | { readonly tipo: 'retomada' }
  | { readonly tipo: 'recusada'; readonly pendencias: readonly PendenciaDoPlanoLi[] };

/** Step 1 of an attempt (module header): every planned produto, read by id, judged. */
async function julgarIdsPlanejados(
  deps: DepsFamiliaNovaLi,
  produtos: readonly ProdutoPlanejadoLi[],
): Promise<JulgamentoDosIds> {
  const snaps = await Promise.all(
    produtos.map((p) => produtoCollection.docRef(deps.db, {}, p.produtoId).get()),
  );
  const outros: PendenciaDoPlanoLi[] = [];
  const nossos: { readonly p: ProdutoPlanejadoLi; readonly snap: DocumentSnapshot }[] = [];
  produtos.forEach((p, i) => {
    const snap = snaps[i];
    if (snap === undefined) return;
    const estado = estadoDoIdPlanejadoLi(snap, p);
    if (estado === ESTADO_DO_ID_PLANEJADO_LI.outro) {
      outros.push({
        codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste,
        liId: p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
        referencias: [p.produtoId],
      });
    } else if (estado === ESTADO_DO_ID_PLANEJADO_LI.nosso) {
      nossos.push({ p, snap });
    }
  });
  if (outros.length > 0) return { tipo: 'recusada', pendencias: outros };
  const raiz = nossos.find((n) => n.p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.raiz);
  if (raiz === undefined) {
    if (nossos.length === 0) return { tipo: 'livre' };
    // A variation or a sole member at its id with no root: the ERP has that SKU outside the family.
    return {
      tipo: 'recusada',
      pendencias: nossos.map(({ p }) => ({
        codigo: PENDENCIA_IMPORTACAO_LI.skuJaExiste,
        liId: p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
        referencias: [p.produtoId],
      })),
    };
  }
  if (
    deps.modo !== MODO_IMPORTACAO_LI.simular &&
    (await criadoComOVinculoDaContaLi(deps.db, deps.contaId, raiz.snap, raiz.p.liId))
  ) {
    return { tipo: 'retomada' };
  }
  return { tipo: 'existente' };
}

/**
 * Create a whole store family the ERP does not have (module header), or — under Simular — decide
 * exactly what `aplicar` would. Call it only for a `criacao` with `viavel: true`, once every
 * detail the family needs is read and with no Loja Integrada call between this call's start and
 * its end.
 */
export async function criarFamiliaLi(
  deps: DepsFamiliaNovaLi,
  entrada: EntradaDaFamiliaNovaLi,
): Promise<ResultadoDaFamiliaNovaLi> {
  if (!entrada.criacao.viavel) {
    throw new RangeError('criarFamiliaLi: só uma criação viável (plano.ts) chega aqui');
  }
  const plano = await planejarFamiliaNova(deps, entrada);
  if (plano.tipo === 'recusada') return plano;
  const { raizId, produtos } = plano;
  const criada = (gravado: boolean, retomada: boolean): ResultadoDaFamiliaNovaLi => ({
    tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.criada,
    raizId,
    produtos: produtos.map((p) => ({ produtoId: p.produtoId, papel: p.papel, liId: p.liId })),
    vinculos: produtos.flatMap((p) => (p.vinculo === null ? [] : [p.vinculo])),
    pendencias: plano.pendencias,
    gravado,
    retomada,
  });
  const idsPlanejados = new Set(produtos.map((p) => p.produtoId));

  for (let tentativa = 0; tentativa < MAX_TENTATIVAS_FAMILIA_NOVA_LI; tentativa += 1) {
    // (1) The planned ids.
    const julgamento = await julgarIdsPlanejados(deps, produtos);
    if (julgamento.tipo === 'recusada') return recusa(julgamento.pendencias);
    if (julgamento.tipo === 'existente') {
      return { tipo: TIPO_RESULTADO_FAMILIA_NOVA_LI.existente, raizId };
    }
    if (julgamento.tipo === 'retomada') return criada(true, true);

    // (2) The probe, immediately before the commit.
    const skus: SkuSondadoLi[] = produtos.map((p) => ({
      sku: p.sku,
      liId: p.papel === PAPEL_DO_PRODUTO_CRIADO_LI.filho ? p.liId : null,
    }));
    const sonda = await sondarSkusLi(
      deps.db,
      skus.map((s) => s.sku),
    );
    const colisoes = veredictoDaSondaLi(sonda, skus, idsPlanejados);
    if (colisoes.length > 0) return recusa(colisoes);
    // Every detail the create takes was read — asked only now (module header, "The details").
    if (plano.semDetalhe.length > 0) return recusa(plano.semDetalhe);
    if (deps.modo === MODO_IMPORTACAO_LI.simular) return criada(false, false);

    // (3) What must precede the batch: the caller's categories and tax review.
    const antes = await deps.antesDoLote?.(
      produtos.map((p) => ({ produtoId: p.produtoId, papel: p.papel, liId: p.liId })),
    );
    if (antes !== undefined && antes !== null && antes.length > 0) return recusa(antes);

    // (4) ONE batch, all or nothing.
    const lote = deps.db.batch();
    enfileirarCriacoesLi(deps.db, lote, produtos);
    await deps.antesDoCommit?.();
    try {
      await lote.commit();
      return criada(true, false);
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
    }
  }
  return recusa([
    { codigo: PENDENCIA_IMPORTACAO_LI.conflitoDeEscrita, liId: null, referencias: [raizId] },
  ]);
}
