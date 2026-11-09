/**
 * The product import's MATCH CASCADE (master plan step 9): where a store family stands against the
 * ERP, for ONE Loja Integrada conta — its root's ERP produto, then each variation's — and whether a
 * link of this conta may sit on an ERP produto. Reads only: it writes nothing, decides no create and
 * calls nothing outside the ERP.
 *
 * ## The import's own cascade, never the order resolver's
 *
 * The order import's SKU stage answers the SELLABLE UNIT (a família-de-um root hops to its member);
 * a link must sit on the ROOT, which the stock and price sweeps pre-filter on. So the rungs here are
 * the import's own, narrowest first, and every probe that could answer "exactly one" asks for two
 * (`limit(2)`: the second document is the ambiguity detector). The only piece shared with the order
 * import is the link lookup itself, {@link vinculoDoProdutoLi}, used for EVERY link lookup here.
 *
 * ### The root (a parent or a simple product), {@link resolverRaizLi}
 *
 *  1. **Link** — the link docs of this conta naming the store id (`vinculoDoProdutoLi`). An owner
 *     that no longer exists is no hit. One live owner binds (`vinculado`); two ⇒ `vinculo-ambiguo`;
 *     an owner that is an ERP CHILD ⇒ `forma-diferente` (its shape reads `forma-ilegivel`, below).
 *     A link of ANOTHER conta never answers here
 *     (the lookup is filtered by this conta's stored ref forms): the same store SKU on two contas is
 *     one ERP produto with one link per conta.
 *  2. **Root by SKU** — `produtos where sku == <store sku> and paiId == null limit 2`: exactly one ⇒
 *     `encontrado`; two ⇒ `sku-ambiguo`.
 *  3. **Any by SKU, with the sole-member hop** — `produtos where sku == <store sku> limit 2`. For a
 *     store SIMPLE product, one hit on a child that is the SOLE MEMBER of its root (the root's
 *     `filhoUnicoId` names it and it carries no variation taxonomy, `formaDaRaizErp` ⇒
 *     `familia-de-um`) ⇒ that ROOT. Exact bytes on the member's STORED SKU: no suffix is stripped,
 *     nothing is trimmed. Any other child hit ⇒ `forma-diferente` (a link never sits on an ERP
 *     child). A hit with NO `paiId` field at all (a document rung 2's `paiId == null` cannot see)
 *     is a root. Two hits ⇒ `sku-ambiguo`.
 *  4. Nothing ⇒ `ausente` (only "complete" may create, after its own probe — 9-d's).
 *
 * A store root with no SKU (`''` or none) answers only rung 1, else `sem-sku`; one whose SKU another
 * snapshot row also carries, or nearly does ({@link conflitosDeSkuNaLojaLi}: exact bytes, or a SKU
 * that shares a probe form with another row's or meets another row's derived sole-member SKU),
 * answers only rung 1, else `sku-repetido-na-loja` or `sku-parecido-na-loja` — decided from the whole
 * snapshot before anything is created, so processing order never picks a winner between them and
 * Simular answers as `aplicar` does.
 *
 * **Shapes must agree** ({@link formaConcordaLi}), read by `formaDaRaizErp` from the matched root,
 * its member when `filhoUnicoId` is set, and a `paiId == <root> limit 2` children read otherwise:
 * a store simple product ↔ an ERP `raiz-simples` or `familia-de-um` (a kit root is one of those,
 * and keeps its link on itself); a store parent ↔ `familia-de-muitas` or `familia-de-uma-variacao`.
 * Anything else, `forma-ilegivel` included, is `forma-diferente`: a store family of one variation
 * never meets an ERP sole member, and a store simple product never meets an ERP one-variation
 * family. The import never turns one shape into the other.
 *
 * ### The variations of a matched family, {@link resolverFilhosLi}
 *
 * The ERP parent's children are read ONCE (`paiId == <parent>`), then per store variation:
 *  1. its own link, whose live owner must be a child of the matched parent (else
 *     `filho-de-outra-familia`; two owners ⇒ `vinculo-ambiguo`);
 *  2. the SKU among the parent's children, compared by `mesmoSkuLi` — the exact bytes a
 *     `sku == x and paiId == <parent>` query would match, at one read per family instead of one per
 *     variation: one ⇒ matched; two ⇒ `sku-ambiguo`. A SKU in conflict in the store
 *     ({@link conflitosDeSkuNaLojaLi}) skips this rung and carries its code on to the next;
 *  3. the COMBINATION: every option resolved to an ERP variante (`resolverOpcoesDoFilhoLi`, over the
 *     grupos the caller passes — the dispatch's memo, plus the Simular overlay), then `sameCombo`
 *     against the children's `variacoesUid`: one ⇒ matched, and when the two SKUs differ the
 *     variation also says `sku-diferente` (informational, both SKUs). Two ⇒ `variacao-ambigua`.
 *     Two store siblings with the SAME option set make the family ambiguous: rung 3 is off for every
 *     variation of it and each sibling says `variacao-ambigua`;
 *  4. nothing ⇒ `ausente`, carrying what kept its options from resolving.
 *
 * Two store variations landing on ONE ERP child are both refused (`vinculo-ambiguo` when both came
 * through links, else `variacao-ambigua`). Whether a link may be WRITTEN is not decided here: a
 * variation is linked only beside its parent's confirmed link, and a SKU-less one gets no link at
 * all (the link doc requires a SKU) — the plan's and the link writer's calls.
 *
 * ### One store product per conta per ERP produto, {@link escanearVinculosDoProdutoLi}
 *
 * Before a link of conta C for store id L is written under produto P, P's OWN link subcollection is
 * read unfiltered and every document judged by `vinculoLiDaContaEId` (never string equality): a link
 * of C with ANOTHER id ⇒ `vinculado-a-outro` (never deleted, never re-pointed); a link of C whose
 * `id` is not a number ⇒ `vinculo-ilegivel` (invisible to every field query, so never adopted or
 * filled); a document of another conta at L's own doc id ⇒ `vinculo-ambiguo`; C's link for L ⇒
 * `proprio` (it exists: refresh it); nothing ⇒ `livre`.
 *
 * ### Targets ({@link alvoDaRaizLi}, {@link familiaNoAlvoLi})
 *
 * `jaNoErp` = rung 1, 2 or 3 answered one ERP produto; `naoNoErp` = `ausente`; `todos` = every
 * family; `selecionados` = the roots the start body named. A family in conflict (two owners, two SKU
 * hits, a shape mismatch, no SKU, a SKU repeated or nearly repeated in the store) belongs to no target
 * but `todos` and `selecionados`, and is reported.
 *
 * ## The reads, against the indexes (root rule 1)
 *
 * Every query here rides an index `firestore.indexes.json` declares (`resolucao.test.ts` checks
 * each recorded query against it):
 *  - the link lookup: the `produtolojaintegrada (contaLojaIntegrada ASC, id ASC)` collection group;
 *  - rung 2: `produtos (sku ASC, paiId ASC)`; rung 3: `produtos (sku ASC)`;
 *  - the children reads (`paiId == <root>`, with or without `limit 2`): the prefix of
 *    `produtos (paiId ASC, nome ASC)`, the read the Mercado Livre importer rides too;
 *  - a produto by id; a produto's OWN link subcollection, whole and unfiltered (no index; small).
 *
 * ## Sameness
 *
 * This module folds nothing. A SKU is compared by Firestore equality or `mesmoSkuLi` (both exact
 * bytes), the store's near duplicates by `skusParecidosNaLojaLi`, a link's id and conta by
 * `vinculoLiDaContaEId`, a combination by `sameCombo`, a shape by `formaDaRaizErp` — each owned by
 * `packages/schemas` with its pairs pinned there; the near-misses that matter at this altitude are
 * pinned in `resolucao.test.ts`.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`). Next-free; `db` is a parameter.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  produtoCollection,
  produtoLojaIntegradaLinkCollection,
} from '@delfrance/data/admin/collections';
import {
  ALVO_IMPORTACAO_LI,
  FORMA_RAIZ_ERP,
  type FormaRaizErp,
  type GrupoComLinksLi,
  type ImportacaoLojaIntegrada,
  PENDENCIA_IMPORTACAO_LI,
  type PendenciaImportacaoLi,
  type ProdutoLiLido,
  RELACAO_VINCULO_LI,
  type ResolucaoOpcaoLi,
  SITUACAO_ERP_ITEM_LI,
  type SkuDaLojaLi,
  TIPO_PRODUTO_LI,
  TIPO_RESOLUCAO_OPCAO_LI,
  type TipoProdutoLi,
  type TipoResolucaoOpcaoLi,
  formaDaRaizErp,
  mesmoSkuLi,
  resolverOpcoesDoFilhoLi,
  sameCombo,
  skusParecidosNaLojaLi,
  varianteFakePath,
  vinculoLiDaContaEId,
} from '@delfrance/schemas';

import { vinculoDoProdutoLi } from '../pedidos/vinculoProdutoLi';
import type { FamiliaLi, MontagemLi } from './familias';

export interface DepsResolucaoLi {
  readonly db: Firestore;
  /** The Loja Integrada conta (integração doc id) the job reads. */
  readonly contaId: string;
}

/** A pendência the cascade decided: about one variation (`liId`) or the family (`null`). */
export interface PendenciaDaResolucaoLi {
  readonly codigo: PendenciaImportacaoLi;
  readonly liId: number | null;
  /** What the code names: ERP ids, the two SKUs of `sku-diferente`, an option `<grade>/<opção>`. */
  readonly referencias: readonly string[];
}

/* -------------------------------------------------------------------------- */
/*                              The ERP produto, read                          */
/* -------------------------------------------------------------------------- */

/** The ERP produto fields the cascade reads — projected from the RAW document, never parsed. */
export interface ProdutoErpLi {
  readonly id: string;
  /** The stored SKU when it is a non-empty string, else `null`. */
  readonly sku: string | null;
  /** The parent, when the stored `paiId` is a non-empty string; `null` otherwise (absent too). */
  readonly paiId: string | null;
  readonly filhoUnicoId: string | null;
  /** The variante fake paths (string elements only), or `null` when none is stored. */
  readonly variacoesUid: readonly string[] | null;
  readonly grupoDeVariacoesUid: readonly string[] | null;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

function listaDeTextos(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const lista: readonly unknown[] = v;
  return lista.filter((x): x is string => typeof x === 'string');
}

/** Project a raw produto document (module header: nothing is parsed, nothing is refused). */
export function projetarProdutoErpLi(id: string, raw: Record<string, unknown>): ProdutoErpLi {
  return {
    id,
    sku: typeof raw.sku === 'string' && raw.sku !== '' ? raw.sku : null,
    paiId: textoOuNulo(raw.paiId),
    filhoUnicoId: textoOuNulo(raw.filhoUnicoId),
    variacoesUid: listaDeTextos(raw.variacoesUid),
    grupoDeVariacoesUid: listaDeTextos(raw.grupoDeVariacoesUid),
  };
}

async function lerProdutoErp(db: Firestore, id: string): Promise<ProdutoErpLi | null> {
  const snap = await produtoCollection.docRef(db, {}, id).get();
  if (!snap.exists) return null;
  return projetarProdutoErpLi(id, (snap.data() ?? {}) as Record<string, unknown>);
}

/** The produtos a query answered, projected. */
function projetarDocs(docs: readonly { id: string; data(): unknown }[]): ProdutoErpLi[] {
  return docs.map((d) => projetarProdutoErpLi(d.id, (d.data() ?? {}) as Record<string, unknown>));
}

/** The children of root `paiId` (`paiId == <root>`, module header "The reads"), capped or whole. */
async function lerFilhosErp(
  db: Firestore,
  paiId: string,
  limite: number | null,
): Promise<ProdutoErpLi[]> {
  const consulta = produtoCollection.ref(db, {}).where('paiId', '==', paiId);
  const snap = await (limite === null ? consulta : consulta.limit(limite)).get();
  return projetarDocs(snap.docs);
}

/* -------------------------------------------------------------------------- */
/*                                   Shapes                                    */
/* -------------------------------------------------------------------------- */

/**
 * Whether a store product of `tipo` may meet an ERP root of `forma` (module header, "Shapes must
 * agree"). Pure.
 */
export function formaConcordaLi(tipo: TipoProdutoLi, forma: FormaRaizErp): boolean {
  if (tipo === TIPO_PRODUTO_LI.normal) {
    return forma === FORMA_RAIZ_ERP.raizSimples || forma === FORMA_RAIZ_ERP.familiaDeUm;
  }
  if (tipo === TIPO_PRODUTO_LI.atributo) {
    return (
      forma === FORMA_RAIZ_ERP.familiaDeMuitas || forma === FORMA_RAIZ_ERP.familiaDeUmaVariacao
    );
  }
  return false;
}

/** The ERP root's shape: from its member when it names one, else from a two-child read. */
async function formaDaRaiz(db: Firestore, raiz: ProdutoErpLi): Promise<FormaRaizErp> {
  const raizDeFamilia = { id: raiz.id, paiId: raiz.paiId, filhoUnicoId: raiz.filhoUnicoId };
  if (raiz.paiId !== null) {
    return formaDaRaizErp({ raiz: raizDeFamilia, membro: null, contagemDeFilhos: null });
  }
  if (raiz.filhoUnicoId !== null) {
    const membro = await lerProdutoErp(db, raiz.filhoUnicoId);
    return formaDaRaizErp({ raiz: raizDeFamilia, membro, contagemDeFilhos: null });
  }
  const filhos = await lerFilhosErp(db, raiz.id, 2);
  return formaDaRaizErp({ raiz: raizDeFamilia, membro: null, contagemDeFilhos: filhos.length });
}

/* -------------------------------------------------------------------------- */
/*                          The store's repeated SKUs                          */
/* -------------------------------------------------------------------------- */

/**
 * The SKUs two or more rows of the assembly carry — every family's root and every attached
 * variation — compared by EXACT bytes (`'X'` and `'X '` are two SKUs). Each is `sku-repetido-na-loja`:
 * never linked or created by SKU (an existing link still answers). Pure.
 */
export function skusRepetidosNaLojaLi(montagem: MontagemLi): ReadonlySet<string> {
  const vistos = new Set<string>();
  const repetidos = new Set<string>();
  const contar = (linha: ProdutoLiLido): void => {
    if (linha.sku === null) return;
    if (vistos.has(linha.sku)) repetidos.add(linha.sku);
    else vistos.add(linha.sku);
  };
  for (const familia of montagem.familias) {
    contar(familia.raiz);
    for (const filho of familia.filhos) contar(filho.linha);
  }
  return repetidos;
}

/** Why a store SKU may be neither created nor matched by SKU: an exact repeat, or a near one. */
export type ConflitoDeSkuNaLojaLi =
  | typeof PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja
  | typeof PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja;

/**
 * Every SKU of the assembly that is in conflict in the store, with its code: computed with the
 * assembly, from the whole snapshot, before anything is created, so processing order never picks a
 * winner and Simular answers as `aplicar` does. Exact repeats are {@link skusRepetidosNaLojaLi}'s;
 * near duplicates are `skusParecidosNaLojaLi`'s, over every root (a simple product also writes its
 * sole member's derived SKU) and every attached variation, hidden rows included. A SKU that is both
 * is a repeat. Equal and near-miss pairs are pinned in `produtoImportacaoLi.test.ts`. Pure.
 */
export function conflitosDeSkuNaLojaLi(
  montagem: MontagemLi,
): ReadonlyMap<string, ConflitoDeSkuNaLojaLi> {
  const linhas: SkuDaLojaLi[] = [];
  for (const familia of montagem.familias) {
    linhas.push({ sku: familia.raiz.sku, simples: familia.raiz.tipo === TIPO_PRODUTO_LI.normal });
    for (const filho of familia.filhos) linhas.push({ sku: filho.linha.sku, simples: false });
  }
  const conflitos = new Map<string, ConflitoDeSkuNaLojaLi>();
  for (const sku of skusParecidosNaLojaLi(linhas)) {
    conflitos.set(sku, PENDENCIA_IMPORTACAO_LI.skuParecidoNaLoja);
  }
  for (const sku of skusRepetidosNaLojaLi(montagem)) {
    conflitos.set(sku, PENDENCIA_IMPORTACAO_LI.skuRepetidoNaLoja);
  }
  return conflitos;
}

/* -------------------------------------------------------------------------- */
/*                                  The root                                   */
/* -------------------------------------------------------------------------- */

/** How a root was matched. */
export type ViaDaRaizLi =
  /** Rung 1: this conta's link names it. */
  | 'vinculo'
  /** Rung 2 (or rung 3's field-less root): its own SKU. */
  | 'sku-raiz'
  /** Rung 3: its sole member's stored SKU, hopped to the root. */
  | 'membro-unico';

/** Named members of {@link ViaDaRaizLi}. */
export const VIA_DA_RAIZ_LI = {
  vinculo: 'vinculo',
  skuRaiz: 'sku-raiz',
  membroUnico: 'membro-unico',
} as const satisfies Record<string, ViaDaRaizLi>;

/** Why a root stands in no target. */
export type ConflitoDaRaizLi =
  | typeof PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo
  | typeof PENDENCIA_IMPORTACAO_LI.skuAmbiguo
  | typeof PENDENCIA_IMPORTACAO_LI.formaDiferente
  | typeof PENDENCIA_IMPORTACAO_LI.semSku
  | ConflitoDeSkuNaLojaLi;

/**
 * Where a store root stands (module header). `tipo` is the report's `situacaoErp`: `vinculado`
 * (rung 1), `encontrado` (rungs 2–3: found, not linked yet), `ausente`, `conflito`.
 */
export type ResolucaoDaRaizLi =
  | {
      readonly tipo: typeof SITUACAO_ERP_ITEM_LI.vinculado;
      readonly erpId: string;
      readonly via: typeof VIA_DA_RAIZ_LI.vinculo;
      readonly forma: FormaRaizErp;
    }
  | {
      readonly tipo: typeof SITUACAO_ERP_ITEM_LI.encontrado;
      readonly erpId: string;
      readonly via: typeof VIA_DA_RAIZ_LI.skuRaiz | typeof VIA_DA_RAIZ_LI.membroUnico;
      readonly forma: FormaRaizErp;
    }
  | { readonly tipo: typeof SITUACAO_ERP_ITEM_LI.ausente }
  | {
      readonly tipo: typeof SITUACAO_ERP_ITEM_LI.conflito;
      readonly pendencia: ConflitoDaRaizLi;
      /** The ERP produtos involved (owners, hits, the mismatched root), ascending. */
      readonly erpIds: readonly string[];
    };

function conflito(pendencia: ConflitoDaRaizLi, erpIds: readonly string[] = []): ResolucaoDaRaizLi {
  return { tipo: SITUACAO_ERP_ITEM_LI.conflito, pendencia, erpIds: [...erpIds].sort() };
}

/** The live owners of this conta's links naming store id `liId` (gone owners dropped). */
async function donosVivos(deps: DepsResolucaoLi, liId: number): Promise<ProdutoErpLi[]> {
  const v = await vinculoDoProdutoLi(deps.db, deps.contaId, String(liId));
  if (v.tipo === 'nenhum') return [];
  const vivos: ProdutoErpLi[] = [];
  for (const id of v.tipo === 'um' ? [v.donoId] : v.donoIds) {
    const dono = await lerProdutoErp(deps.db, id);
    if (dono !== null) vivos.push(dono);
  }
  return vivos;
}

/** A matched root, once its shape is read and judged against the store `tipo`. */
async function comForma(
  deps: DepsResolucaoLi,
  tipo: TipoProdutoLi,
  raiz: ProdutoErpLi,
  via: ViaDaRaizLi,
): Promise<ResolucaoDaRaizLi> {
  const forma = await formaDaRaiz(deps.db, raiz);
  if (!formaConcordaLi(tipo, forma)) {
    return conflito(PENDENCIA_IMPORTACAO_LI.formaDiferente, [raiz.id]);
  }
  return via === VIA_DA_RAIZ_LI.vinculo
    ? { tipo: SITUACAO_ERP_ITEM_LI.vinculado, erpId: raiz.id, via, forma }
    : { tipo: SITUACAO_ERP_ITEM_LI.encontrado, erpId: raiz.id, via, forma };
}

/**
 * Rung 3's one child hit: the ROOT it is the sole member of (store simple products only), or
 * `forma-diferente` (module header).
 */
async function pelaUnicaFilha(
  deps: DepsResolucaoLi,
  tipo: TipoProdutoLi,
  filho: ProdutoErpLi & { readonly paiId: string },
): Promise<ResolucaoDaRaizLi> {
  if (tipo !== TIPO_PRODUTO_LI.normal) {
    return conflito(PENDENCIA_IMPORTACAO_LI.formaDiferente, [filho.id]);
  }
  const raiz = await lerProdutoErp(deps.db, filho.paiId);
  if (raiz?.filhoUnicoId !== filho.id) {
    return conflito(PENDENCIA_IMPORTACAO_LI.formaDiferente, [filho.id]);
  }
  const forma = formaDaRaizErp({
    raiz: { id: raiz.id, paiId: raiz.paiId, filhoUnicoId: raiz.filhoUnicoId },
    membro: filho,
    contagemDeFilhos: null,
  });
  if (forma !== FORMA_RAIZ_ERP.familiaDeUm) {
    return conflito(PENDENCIA_IMPORTACAO_LI.formaDiferente, [filho.id]);
  }
  return {
    tipo: SITUACAO_ERP_ITEM_LI.encontrado,
    erpId: raiz.id,
    via: VIA_DA_RAIZ_LI.membroUnico,
    forma,
  };
}

/**
 * The cascade for one store family's ROOT (module header, "The root"). `skusEmConflito` is
 * {@link conflitosDeSkuNaLojaLi} over the job's assembly.
 */
export async function resolverRaizLi(
  deps: DepsResolucaoLi,
  familia: Pick<FamiliaLi, 'raiz'>,
  skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>,
): Promise<ResolucaoDaRaizLi> {
  const { raiz } = familia;

  // (1) The link.
  const donos = await donosVivos(deps, raiz.id);
  if (donos.length > 1) {
    return conflito(
      PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo,
      donos.map((d) => d.id),
    );
  }
  const [dono] = donos;
  // An owner that is an ERP CHILD reads `forma-ilegivel` (a "root" with a `paiId`), so the shape
  // check refuses it as `forma-diferente`, with zero further reads.
  if (dono !== undefined) return comForma(deps, raiz.tipo, dono, VIA_DA_RAIZ_LI.vinculo);

  const { sku } = raiz;
  if (sku === null) return conflito(PENDENCIA_IMPORTACAO_LI.semSku);
  const emConflito = skusEmConflito.get(sku);
  if (emConflito !== undefined) return conflito(emConflito);

  // (2) A root by its own SKU.
  const raizes = projetarDocs(
    (
      await produtoCollection
        .ref(deps.db, {})
        .where('sku', '==', sku)
        .where('paiId', '==', null)
        .limit(2)
        .get()
    ).docs,
  );
  if (raizes.length > 1) {
    return conflito(
      PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
      raizes.map((r) => r.id),
    );
  }
  const [porSku] = raizes;
  if (porSku !== undefined) return comForma(deps, raiz.tipo, porSku, VIA_DA_RAIZ_LI.skuRaiz);

  // (3) Any produto by SKU: the sole-member hop, or a root with no `paiId` field at all.
  const hits = projetarDocs(
    (await produtoCollection.ref(deps.db, {}).where('sku', '==', sku).limit(2).get()).docs,
  );
  if (hits.length > 1) {
    return conflito(
      PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
      hits.map((h) => h.id),
    );
  }
  const [hit] = hits;
  if (hit === undefined) return { tipo: SITUACAO_ERP_ITEM_LI.ausente };
  if (hit.paiId === null) return comForma(deps, raiz.tipo, hit, VIA_DA_RAIZ_LI.skuRaiz);
  return pelaUnicaFilha(deps, raiz.tipo, { ...hit, paiId: hit.paiId });
}

/* -------------------------------------------------------------------------- */
/*                                 The variations                              */
/* -------------------------------------------------------------------------- */

/** How a variation was matched. */
export type ViaDoFilhoLi = 'vinculo' | 'sku' | 'combinacao';

/** Named members of {@link ViaDoFilhoLi}. */
export const VIA_DO_FILHO_LI = {
  vinculo: 'vinculo',
  sku: 'sku',
  combinacao: 'combinacao',
} as const satisfies Record<string, ViaDoFilhoLi>;

/** Where one store variation stands against the matched ERP family. */
export type SituacaoDoFilhoLi =
  /** Matched to one ERP child of the matched parent. */
  | 'casado'
  /** No ERP child (complete may add it — 9-d's — when every option resolves). */
  | 'ausente'
  /** Refused: two owners, two hits, another family, a shared target. */
  | 'conflito';

/** Named members of {@link SituacaoDoFilhoLi}. */
export const SITUACAO_DO_FILHO_LI = {
  casado: 'casado',
  ausente: 'ausente',
  conflito: 'conflito',
} as const satisfies Record<string, SituacaoDoFilhoLi>;

export interface ResolucaoDoFilhoLi {
  readonly liId: number;
  readonly situacao: SituacaoDoFilhoLi;
  /** The matched ERP child (`casado` only). */
  readonly erp: ProdutoErpLi | null;
  readonly via: ViaDoFilhoLi | null;
  /** Each store option, resolved against the grupos passed in (in the store's order). */
  readonly opcoes: readonly ResolucaoOpcaoLi[];
  readonly pendencias: readonly PendenciaDaResolucaoLi[];
}

export interface ResolucaoDosFilhosLi {
  /** One per variation of the family that has a view, ascending store id. */
  readonly filhos: readonly ResolucaoDoFilhoLi[];
  /** The matched ERP parent's children, as read (ascending id). */
  readonly erpFilhos: readonly ProdutoErpLi[];
  /** Two store siblings share one option set: no variation of the family matches by combination. */
  readonly combinacaoAmbiguaNaLoja: boolean;
  /** Family-level pendências (the siblings of a shared option set). */
  readonly pendencias: readonly PendenciaDaResolucaoLi[];
}

/** An option that did not resolve, as the report names it. */
const PENDENCIA_DA_OPCAO: Record<
  Exclude<TipoResolucaoOpcaoLi, typeof TIPO_RESOLUCAO_OPCAO_LI.resolvida>,
  PendenciaImportacaoLi
> = {
  // An option URI that does not read cannot be linked: the variation stays unlinked by option.
  [TIPO_RESOLUCAO_OPCAO_LI.ilegivel]: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
  [TIPO_RESOLUCAO_OPCAO_LI.gradeSemVinculo]: PENDENCIA_IMPORTACAO_LI.gradeSemVinculo,
  [TIPO_RESOLUCAO_OPCAO_LI.gradeEmDoisGrupos]: PENDENCIA_IMPORTACAO_LI.gradeEmDoisGrupos,
  [TIPO_RESOLUCAO_OPCAO_LI.opcaoSemVinculo]: PENDENCIA_IMPORTACAO_LI.opcaoSemVinculo,
  [TIPO_RESOLUCAO_OPCAO_LI.opcaoEmDoisGrupos]: PENDENCIA_IMPORTACAO_LI.opcaoEmDoisGrupos,
  [TIPO_RESOLUCAO_OPCAO_LI.variacaoAmbigua]: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
};

function referenciaDaOpcao(o: ResolucaoOpcaoLi): string[] {
  return o.gradeId === null || o.opcaoId === null
    ? []
    : [`${String(o.gradeId)}/${String(o.opcaoId)}`];
}

/**
 * The store variations of `familia` whose readable option set another sibling also carries (the
 * set compared as numbers, order ignored). A variation with an unreadable option takes no part:
 * its set is not known. Pure.
 */
export function irmaosComMesmasOpcoesLi(familia: Pick<FamiliaLi, 'filhos'>): number[] {
  const porConjunto = new Map<string, number[]>();
  for (const { linha } of familia.filhos) {
    if (linha.opcoes.length === 0 || linha.ilegiveis.opcoes > 0) continue;
    const chave = linha.opcoes
      .map((o) => [o.gradeId, o.opcaoId] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([g, v]) => `${String(g)}/${String(v)}`)
      .join(',');
    porConjunto.set(chave, [...(porConjunto.get(chave) ?? []), linha.id]);
  }
  return [...porConjunto.values()]
    .filter((ids) => ids.length > 1)
    .flat()
    .sort((a, b) => a - b);
}

/** One variation through the rungs (module header, "The variations"). */
async function resolverFilho(
  deps: DepsResolucaoLi,
  linha: ProdutoLiLido,
  contexto: {
    readonly erpPaiId: string;
    readonly erpFilhos: readonly ProdutoErpLi[];
    readonly grupos: readonly GrupoComLinksLi[];
    readonly skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>;
    readonly combinacaoLiberada: boolean;
  },
): Promise<ResolucaoDoFilhoLi> {
  const opcoes = resolverOpcoesDoFilhoLi({
    contaId: deps.contaId,
    opcoesUris: linha.variacoes,
    grupos: contexto.grupos,
  });
  const base = { liId: linha.id, opcoes };
  const recusa = (codigo: PendenciaImportacaoLi, referencias: readonly string[] = []) => ({
    ...base,
    situacao: SITUACAO_DO_FILHO_LI.conflito,
    erp: null,
    via: null,
    pendencias: [{ codigo, liId: linha.id, referencias }],
  });
  const casado = (
    erp: ProdutoErpLi,
    via: ViaDoFilhoLi,
    pendencias: readonly PendenciaDaResolucaoLi[] = [],
  ): ResolucaoDoFilhoLi => ({
    ...base,
    situacao: SITUACAO_DO_FILHO_LI.casado,
    erp,
    via,
    pendencias,
  });

  // (1) Its own link.
  const donos = await donosVivos(deps, linha.id);
  if (donos.length > 1) {
    return recusa(PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo, donos.map((d) => d.id).sort());
  }
  const [dono] = donos;
  if (dono !== undefined) {
    if (dono.paiId !== contexto.erpPaiId) {
      return recusa(PENDENCIA_IMPORTACAO_LI.filhoDeOutraFamilia, [dono.id]);
    }
    return casado(dono, VIA_DO_FILHO_LI.vinculo);
  }

  const { sku } = linha;
  if (sku === null) return recusa(PENDENCIA_IMPORTACAO_LI.semSku);
  const pendencias: PendenciaDaResolucaoLi[] = [];

  // (2) Its SKU among the parent's children — never a SKU in conflict in the store.
  const emConflito = contexto.skusEmConflito.get(sku);
  if (emConflito !== undefined) {
    pendencias.push({ codigo: emConflito, liId: linha.id, referencias: [] });
  } else {
    const porSku = contexto.erpFilhos.filter((e) => mesmoSkuLi(sku, e.sku));
    if (porSku.length > 1) {
      return recusa(
        PENDENCIA_IMPORTACAO_LI.skuAmbiguo,
        porSku.map((e) => e.id),
      );
    }
    const [unico] = porSku;
    if (unico !== undefined) return casado(unico, VIA_DO_FILHO_LI.sku);
  }

  // (3) The combination.
  const naoResolvidas = opcoes.filter((o) => o.tipo !== TIPO_RESOLUCAO_OPCAO_LI.resolvida);
  if (opcoes.length === 0) {
    pendencias.push({
      codigo: PENDENCIA_IMPORTACAO_LI.variacaoSemVinculo,
      liId: linha.id,
      referencias: [],
    });
  }
  for (const o of naoResolvidas) {
    if (o.tipo === TIPO_RESOLUCAO_OPCAO_LI.resolvida) continue;
    pendencias.push({
      codigo: PENDENCIA_DA_OPCAO[o.tipo],
      liId: linha.id,
      referencias: referenciaDaOpcao(o),
    });
  }
  if (contexto.combinacaoLiberada && opcoes.length > 0 && naoResolvidas.length === 0) {
    const combinacao = opcoes.map((o) => varianteFakePath(o.grupoIds[0]!, o.varianteIds[0]!));
    const pelaCombinacao = contexto.erpFilhos.filter(
      (e) => e.variacoesUid !== null && sameCombo([...e.variacoesUid], combinacao),
    );
    if (pelaCombinacao.length > 1) {
      return recusa(
        PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
        pelaCombinacao.map((e) => e.id),
      );
    }
    const [porCombinacao] = pelaCombinacao;
    if (porCombinacao !== undefined) {
      const diferente: PendenciaDaResolucaoLi[] = mesmoSkuLi(sku, porCombinacao.sku)
        ? []
        : [
            {
              codigo: PENDENCIA_IMPORTACAO_LI.skuDiferente,
              liId: linha.id,
              referencias: [sku, porCombinacao.sku ?? ''],
            },
          ];
      const naLoja = pendencias.filter((p) => p.codigo === emConflito);
      return casado(porCombinacao, VIA_DO_FILHO_LI.combinacao, [...naLoja, ...diferente]);
    }
  }

  // (4) Nothing.
  return { ...base, situacao: SITUACAO_DO_FILHO_LI.ausente, erp: null, via: null, pendencias };
}

/**
 * The variations of `familia`, matched against the ERP family whose parent is `erpPaiId` (module
 * header, "The variations"). `grupos` is what options resolve against — the dispatch's grupo memo,
 * plus, under Simular, the overlay of what the job would have learned.
 */
export async function resolverFilhosLi(
  deps: DepsResolucaoLi,
  familia: Pick<FamiliaLi, 'filhos'>,
  erpPaiId: string,
  contexto: {
    readonly grupos: readonly GrupoComLinksLi[];
    readonly skusEmConflito: ReadonlyMap<string, ConflitoDeSkuNaLojaLi>;
  },
): Promise<ResolucaoDosFilhosLi> {
  const erpFilhos = (await lerFilhosErp(deps.db, erpPaiId, null)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  const irmaos = irmaosComMesmasOpcoesLi(familia);
  const pendencias: PendenciaDaResolucaoLi[] = irmaos.map((liId) => ({
    codigo: PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
    liId,
    referencias: [],
  }));

  const resolvidos: ResolucaoDoFilhoLi[] = [];
  for (const { linha } of [...familia.filhos].sort((a, b) => a.linha.id - b.linha.id)) {
    resolvidos.push(
      await resolverFilho(deps, linha, {
        erpPaiId,
        erpFilhos,
        grupos: contexto.grupos,
        skusEmConflito: contexto.skusEmConflito,
        combinacaoLiberada: irmaos.length === 0,
      }),
    );
  }

  // Two variations on ONE ERP child: both refused, whichever came first.
  const porErp = new Map<string, ResolucaoDoFilhoLi[]>();
  for (const r of resolvidos) {
    if (r.erp !== null) porErp.set(r.erp.id, [...(porErp.get(r.erp.id) ?? []), r]);
  }
  const filhos = resolvidos.map((r): ResolucaoDoFilhoLi => {
    const mesmos = r.erp === null ? [] : (porErp.get(r.erp.id) ?? []);
    if (mesmos.length < 2 || r.erp === null) return r;
    const todosPorVinculo = mesmos.every((m) => m.via === VIA_DO_FILHO_LI.vinculo);
    return {
      ...r,
      situacao: SITUACAO_DO_FILHO_LI.conflito,
      erp: null,
      via: null,
      pendencias: [
        {
          codigo: todosPorVinculo
            ? PENDENCIA_IMPORTACAO_LI.vinculoAmbiguo
            : PENDENCIA_IMPORTACAO_LI.variacaoAmbigua,
          liId: r.liId,
          referencias: [r.erp.id],
        },
      ],
    };
  });

  return { filhos, erpFilhos, combinacaoAmbiguaNaLoja: irmaos.length > 0, pendencias };
}

/* -------------------------------------------------------------------------- */
/*                         One store product per conta                         */
/* -------------------------------------------------------------------------- */

/** What produto P's own links say about a link of this conta for store id L. */
export type SituacaoDoVinculoNoProdutoLi =
  /** No link of this conta, nothing at L's doc id: a link may be created at `String(L)`. */
  | 'livre'
  /** This conta's link for L exists (`docIds`, the one at `String(L)` first): refresh it. */
  | 'proprio'
  /** This conta links P to ANOTHER store product: refused, never re-pointed. */
  | 'vinculado-a-outro'
  /** A link of this conta whose `id` is not a number: refused, never adopted or filled. */
  | 'vinculo-ilegivel'
  /** Another conta's (or an unreadable) document sits at L's own doc id: refused. */
  | 'vinculo-ambiguo';

/** Named members of {@link SituacaoDoVinculoNoProdutoLi}. */
export const SITUACAO_DO_VINCULO_NO_PRODUTO_LI = {
  livre: 'livre',
  proprio: 'proprio',
  vinculadoAOutro: 'vinculado-a-outro',
  vinculoIlegivel: 'vinculo-ilegivel',
  vinculoAmbiguo: 'vinculo-ambiguo',
} as const satisfies Record<string, SituacaoDoVinculoNoProdutoLi>;

export interface VinculoNoProdutoLi {
  readonly situacao: SituacaoDoVinculoNoProdutoLi;
  /** `proprio`: this conta's link docs for L; the others: the documents that refused it. */
  readonly docIds: readonly string[];
  /** `vinculado-a-outro`: the other store ids, ascending. */
  readonly outrosIdsLi: readonly number[];
}

/**
 * The one-store-product-per-conta scan (module header): produto `produtoId`'s OWN link
 * subcollection, read whole and unfiltered, each document judged by `vinculoLiDaContaEId` for
 * (this conta, store id `liId`).
 */
export async function escanearVinculosDoProdutoLi(
  deps: DepsResolucaoLi,
  produtoId: string,
  liId: number,
): Promise<VinculoNoProdutoLi> {
  const snap = await produtoLojaIntegradaLinkCollection.ref(deps.db, { produtoId }).get();
  const nossoDocId = String(liId);
  const proprios: string[] = [];
  const ilegiveis: string[] = [];
  const outros = new Set<number>();
  const outrosDocs: string[] = [];
  let noNossoId: string | null = null;
  for (const doc of snap.docs) {
    const dados = (doc.data() ?? {}) as Record<string, unknown>;
    const relacao = vinculoLiDaContaEId(dados, deps.contaId, liId);
    if (relacao === RELACAO_VINCULO_LI.mesmo) {
      if (doc.id === nossoDocId) proprios.unshift(doc.id);
      else proprios.push(doc.id);
    } else if (relacao === RELACAO_VINCULO_LI.outroId) {
      outrosDocs.push(doc.id);
      // `outro-id` is answered only for a positive safe-integer NUMBER id.
      if (typeof dados.id === 'number') outros.add(dados.id);
    } else if (relacao === RELACAO_VINCULO_LI.idIlegivel) {
      ilegiveis.push(doc.id);
    } else if (doc.id === nossoDocId) {
      noNossoId = doc.id;
    }
  }
  const resposta = (
    situacao: SituacaoDoVinculoNoProdutoLi,
    docIds: readonly string[] = [],
  ): VinculoNoProdutoLi => ({
    situacao,
    docIds,
    outrosIdsLi: [...outros].sort((a, b) => a - b),
  });
  if (outrosDocs.length > 0) {
    return resposta(SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculadoAOutro, outrosDocs);
  }
  if (ilegiveis.length > 0)
    return resposta(SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoIlegivel, ilegiveis);
  if (noNossoId !== null)
    return resposta(SITUACAO_DO_VINCULO_NO_PRODUTO_LI.vinculoAmbiguo, [noNossoId]);
  if (proprios.length > 0) return resposta(SITUACAO_DO_VINCULO_NO_PRODUTO_LI.proprio, proprios);
  return resposta(SITUACAO_DO_VINCULO_NO_PRODUTO_LI.livre);
}

/* -------------------------------------------------------------------------- */
/*                                   Targets                                   */
/* -------------------------------------------------------------------------- */

/** The target a root's match puts it in: `jaNoErp`, `naoNoErp`, or neither (a conflict). Pure. */
export function alvoDaRaizLi(
  resolucao: ResolucaoDaRaizLi,
): typeof ALVO_IMPORTACAO_LI.jaNoErp | typeof ALVO_IMPORTACAO_LI.naoNoErp | null {
  if (
    resolucao.tipo === SITUACAO_ERP_ITEM_LI.vinculado ||
    resolucao.tipo === SITUACAO_ERP_ITEM_LI.encontrado
  ) {
    return ALVO_IMPORTACAO_LI.jaNoErp;
  }
  if (resolucao.tipo === SITUACAO_ERP_ITEM_LI.ausente) return ALVO_IMPORTACAO_LI.naoNoErp;
  return null;
}

/** Whether the job's target takes the family rooted at store id `raizLiId`. Pure. */
export function familiaNoAlvoLi(
  job: Pick<ImportacaoLojaIntegrada, 'alvo' | 'selecionados'>,
  raizLiId: number,
  resolucao: ResolucaoDaRaizLi,
): boolean {
  if (job.alvo === ALVO_IMPORTACAO_LI.todos) return true;
  if (job.alvo === ALVO_IMPORTACAO_LI.selecionados) return job.selecionados.includes(raizLiId);
  return alvoDaRaizLi(resolucao) === job.alvo;
}
