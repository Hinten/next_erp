/**
 * The ITEM-level payload mapper (step 11, S4) — produto graph in, `add_item` /
 * `update_item` bodies plus `problemas[]` out.
 *
 * PURE: no Firestore, no Shopee call, no clock, no environment. Everything it
 * needs arrives as an argument, and everything it decides is a function of those
 * arguments alone — which is what makes the two bodies comparable, key by key,
 * against a documented payload sample in a unit test.
 *
 * ## The two bodies are NOT the same body
 *
 * `add_item` REQUIRES six fields and carries the whole initial state;
 * `update_item` is FIELD-WISE ("fields that are not uploaded will not be
 * updated", `guide 221 §5`), so an omitted key PRESERVES and a key sent empty
 * DELETES. Three consequences this module encodes rather than comments:
 *
 * 1. **`item_status`, `original_price` and `seller_stock` never ride an update.**
 *    A pause is the operator's (the legacy hardcoded `"NORMAL"` on every save and
 *    silently re-listed paused items); price and stock are steps 12/13 and are
 *    absent from `update_item`'s own table.
 *    ⚠️ **A field that never rides an update cannot refuse one**, so FIVE members
 *    of the vocabulary below are CREATE-ONLY and are gated on `!ehAtualizacao`:
 *    `sem-preco`, `filho-sem-preco`, `preco-fora-da-faixa` (no `original_price`),
 *    `estoque-abaixo-do-minimo` (no `seller_stock`) and `marca-sem-nome` (both
 *    `brand` children are required on create and optional on update, so an
 *    unresolvable name merely OMITS the block). Every other refusal applies to
 *    both bodies. Refusing an update over a field it does not send makes the
 *    produto permanently unpublishable-and-unupdatable — which is precisely what
 *    the price pair did to a produto with no entry in the conta's tabela normal.
 * 2. **`item_sku` and `gtin_code` are OMITTED when the ERP has no value**, never
 *    sent blank or as a placeholder — both are fields `guide 221 §5` names as
 *    deletable by an empty string.
 * 3. **`attribute_list`, `image` and `logistic_info` always carry the FULL list.**
 *    Whether those three replace wholesale on an update is undocumented (only
 *    `wholesale` / `video_upload_id` / `item_sku` are), and sending the whole list
 *    is correct under either reading.
 *
 * ## What the STORED link decides, and why
 *
 * `link.item_name`, `link.description`, `link.category_id`, `link.attributes` and
 * `link.brand_id` come from the last read-back of the LIVE listing, so they carry
 * the operator's Seller Centre choices — or, on a DRAFT (#1911), from the draft
 * route that wrote them (`rascunho.ts`; `attributes` in the request shape since
 * P6). They WIN over the ERP produto, blank
 * meaning absent — the `linkTitle` rule in Mercado Livre's `assemblePublishInput`
 * (`publishCore.ts`),
 * adopted verbatim and for the same measured reason (#799 bug 4a: without it an
 * operator can never give a listing a marketplace-optimised name of its own).
 * The produto is the fallback, which is what a first publish uses.
 *
 * ## The vocabulary this file PRODUCES (nineteen of thirty)
 *
 * `sem-nome`, `nome-fora-da-faixa`, `sem-descricao`, `descricao-fora-da-faixa`,
 * `sem-preco`, `filho-sem-preco`, `preco-fora-da-faixa`, `sem-peso`,
 * `sem-dimensoes`, `sem-fotos`, `sem-gtin`, `categoria-invalida`,
 * `atributo-obrigatorio`, `marca-sem-nome`, `estoque-abaixo-do-minimo`,
 * `listagem-removida`, `produto-e-filho`, `produto-e-kit` — and, since #1911
 * (P3, D10), `marca-nao-escolhida`: a DRAFT whose brand was never chosen
 * ({@link LinkListagemLido.marcaNaoEscolhida}). It is not gated on
 * `ehAtualizacao` like the five create-only members: a draft has no `item_id`,
 * so it only ever reaches the create body, and the flag alone decides.
 *
 * The other eleven are produced ELSEWHERE and are listed here so a reader does not
 * hunt for them in this file: `variacao-sem-vinculo`, `combinacao-duplicada` and
 * `opcoes-demais` are `anuncios/tiersPublicacao.ts`'s; `logistica-sem-canal` is
 * `anuncios/logisticaPublicacao.ts`'s, and this module RELAYS that module's
 * `problemas[]` rather than re-deciding it; and, since #1911 (P5, D5),
 * `criacao-incerta-ambigua`, `busca-de-anuncio-incompleta`,
 * `criacao-incerta-sem-sku` and `criacao-incerta-ja-vinculada` are
 * `anuncios/criacaoIncerta.ts`'s — the ENSURE a draft in `incerta` runs, under
 * its lock, before any second `add_item` (a Shopee scan by SKU over the
 * attempt's window; refused outright when the SKU folds blank) — and, since
 * P5b, `anuncio-existente-sem-vinculo`, `anuncio-existente-de-outro-produto` and
 * `busca-de-anuncio-existente-incompleta` are that file's too: the look-up a
 * `livre` draft's FIRST `add_item` runs, under its lock, for a listing the conta
 * already holds with the SKU the body sends. Never this module's: a montagem
 * builds a body, and these decide whether one may be SENT at all. The wire-rejection-only motivos
 * (`bloqueado-por-promocao`, `imposto-recusado`, `anuncio-semelhante-existente`
 * and `desconhecido` among them) are `anuncios/problemasPublicacao.ts`'s and
 * cannot be reached by reading a produto.
 *
 * ⚠️ **`problemas` is the UNION of every refusal found, not the first.** An
 * operator fixing a produto sees everything that is wrong in one pass; stopping
 * at the first refusal turns one publish attempt into five.
 *
 * ⚠️ **A montagem carrying any problema is NEVER sent.** The caller raises
 * `ShopeePublishBlockedError` before the first Shopee call, which is why the
 * required wire fields of a refused `criar` hold harmless placeholders (`''`,
 * `0`, an empty `image_id_list`) instead of the module refusing to build a body
 * at all — a partial body type would force every caller to branch on a case that
 * never reaches the wire.
 *
 * ## `size_chart_info` (step 18, #1526)
 *
 * BOTH bodies carry it, decided by `anuncios/tabelaMedidasPublicacao.ts` over
 * the produto's tabela as read for THIS conta and the listing's RESOLVED
 * category ({@link categoriaDoAnuncio} — the same expression the leaf gate and
 * `category_id` read): a matching template entry ⇒ `{ size_chart_id }` (the
 * template WINS); else the tabela's FIRST photo, uploaded by the I/O half ⇒
 * `{ size_chart: image_id }`; else the KEY IS ABSENT — never `size_chart_id: 0`
 * and never `size_chart: ''`, which are Shopee's DETACH sentinels, so a chart
 * set in Seller Centre survives an update where nothing matched. ⚠️ Once
 * something matches, every republish puts the ERP's pick back over a
 * Seller-Centre change (the legacy behaviour, Lucas's Q3). The decision never
 * refuses: a photo that could not be uploaded is refused by the PLAN
 * (`planoPublicacao.ts`, motivo `tabela-de-medidas-foto-recusada`), because that
 * motivo is wire-only and no problema produced here may carry it.
 */
import {
  type ShopeeAddItemRequest,
  type ShopeeAttributeRequest,
  type ShopeeCondition,
  type ShopeeDimensionRequest,
  type ShopeeItemStatusWritable,
  type ShopeeLogisticInfoRequest,
  type ShopeePreOrderRequest,
  type ShopeeSellerStockRequest,
  type ShopeeSizeChartInfoRequest,
  type ShopeeTaxInfoRequest,
  type ShopeeUpdateItemRequest,
  SHOPEE_CONDITION,
  SHOPEE_ITEM_IMAGE_MAX,
} from '@delfrance/integrations-shopee';
import {
  type ComponentesKit,
  type EstadoAnuncioShopee,
  type Foto,
  atributosParaEnvioShopee,
  dentroDaFaixaShopee,
  descreverFaixaShopee,
  descricaoDoAnuncioShopee,
  ESTADO_ANUNCIO_SHOPEE,
  lerAtributosArmazenadosShopee,
  precoDaTabela,
  textoNaFaixaShopee,
  textoUtilizavelShopee,
  TIPO_PROBLEMA_ATRIBUTO_SHOPEE,
  tituloDoAnuncioShopee,
  validarAtributosShopee,
} from '@delfrance/schemas';

import { quantidadeParaPublicarShopee } from '../estoque/quantidadeEstoque';
import { EIXOS_PACOTE_SHOPEE_INVERSO } from '../produtos/eixos';
import type { AtributosProjetados } from '../taxonomia/dto';
import type { VerdictoFolha } from '../taxonomia/categorias';
import type { FaixaDto, LimitesDeItemLidos } from '../taxonomia/limites';
import { CANAL_SEM_PRE_ORDER } from './constantesAnuncio';
import {
  type ProblemaPublicacao,
  limitarMensagemProblema,
  MOTIVO_PUBLICACAO_BLOQUEADA,
} from './errosPublicacao';
import type { LeituraTabelaDeMedidasShopee } from './lerTabelaMedidasDoProduto';
import {
  type ResultadoTabelaDeMedidasShopee,
  FONTE_TABELA_MEDIDAS,
  resolverTabelaDeMedidasDoAnuncio,
} from './tabelaMedidasPublicacao';

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                   */
/* -------------------------------------------------------------------------- */

/**
 * The produto graph, projected to exactly what the ITEM payload reads.
 *
 * ⚠️ **`ehKit` does NOT refuse anything here** (corrected in step 12, #1520).
 * It is the ERP's "assembled from `componentesKit`, availability derived from
 * the components" flag (`produto/collection/produto.ts:102-108`), and such a
 * produto publishes as an ORDINARY Shopee listing — the legacy app published
 * thousands of them. Its only consequence in this module is that the publish
 * quantity takes the kit branch, a fold that now lives in
 * `../estoque/quantidadeEstoque` and is re-exported from here.
 *
 * What `produto-e-kit` refuses is a **NATIVE Shopee kit** (`add_kit_item`,
 * step 19), decided by {@link kitNativoDoAnuncio}: the stored link's
 * `kitNativo` on a republish, `ehKitVirtual` on a first publish — a DRAFT
 * link's included (#1911). Step 11 keyed
 * that refusal on `ehKit` alone, which made the entire legacy kit catalogue
 * permanently unpublishable. Since step 19 (PR 7) that refusal is a defensive
 * assertion: the dispatcher sends a native kit to the kit arms before this
 * mapper runs (see {@link kitNativoDoAnuncio}).
 */
export interface ProdutoParaPublicar {
  readonly id: string;
  readonly nome: string;
  readonly sku: string | null;
  readonly gtin: string | null;
  /** Non-null ⇒ this produto is a variação's own produto ⇒ `produto-e-filho`. */
  readonly paiId: string | null;
  readonly ehKit: boolean;
  readonly ehKitVirtual: boolean;
  readonly ehUsado: boolean;
  readonly ofereceFreteGratis: boolean;
  /** Days. Compared against the category's `non_pre_order_days_to_ship`. */
  readonly crossdocking: number | null;
  readonly pesoBrutoKg: number | null;
  readonly pesoLiquidoKg: number | null;
  readonly alturaCm: number | null;
  readonly larguraCm: number | null;
  readonly profundidadeCm: number | null;
  /** Keyed by ListaDePrecos DOC ID — see {@link ArgsMontarAnuncio.tabelaNormalId}. */
  readonly precos: Record<string, { readonly valor: number }> | null;
  readonly variacoesUid: readonly string[];
  readonly componentesKit: ComponentesKit | null;
  /** Carried for the photo resolver's pass; this module reads only `imagens`. */
  readonly fotos: readonly Foto[];
}

/**
 * The stored `prodshopee` fields the ITEM payload reads.
 *
 * Structurally a subset of `produtoShopeeLinkSchema`'s inferred type, so a parsed
 * link document is assignable without a projection step. `logistic_info` is
 * carried for the CALLER's benefit — it is what `construirLogistica` takes as its
 * `armazenado` — and is not read here.
 */
export interface LinkListagemLido {
  readonly item_id: number | null;
  readonly item_name: string | null;
  readonly description: string | null;
  readonly category_id: number | null;
  readonly brand_id: number | null;
  readonly attributes: readonly unknown[] | null;
  readonly logistic_info: readonly unknown[] | null;
  readonly estadoAnuncio: EstadoAnuncioShopee | null;
  /**
   * What SHOPEE reported about the live listing (`tag.kit`), three-valued and
   * read by {@link kitNativoDoAnuncio} — the ONE field that refuses a publish
   * as `produto-e-kit`.
   *
   * ⚠️ **OPTIONAL, not merely nullable, and the two are different facts.**
   * `null` is a link this repo read back and recorded as "not a kit-tagged
   * listing"; an ABSENT key is a link document written before step 12 declared
   * the field at all, which is most of the corpus. Both publish — the
   * comparison is `=== true` — but the type admits the absence the stored
   * documents actually contain instead of asking every caller to invent a
   * reading for it.
   */
  readonly kitNativo?: boolean | null;
  /**
   * Whether the stored document is a DRAFT (#1911, D3) — a listing the ERP
   * intends to create and Shopee never answered for — as `ehRascunhoShopee`
   * (`@delfrance/schemas`, THE one predicate) reads the RAW document. Set by the
   * ONE builder, `linkListagemLido` in `publicarAnuncio.ts`; read by
   * {@link vinculoDecideKitNativo} alone.
   *
   * ⚠️ **Never re-derived from `item_id` above.** That field is already FOLDED
   * (`0`, `-1`, `'123'` all read `null`), so a CORRUPT link would pass for a
   * draft here and stop being decided by its own `kitNativo` — the raw document
   * is the only input that keeps a corrupt link out of the class.
   *
   * OPTIONAL and read `=== true`: a projection built without it (a hand-built
   * fixture predating #1911) keeps the pre-#1911 reading — the link decides.
   */
  readonly ehRascunho?: boolean;
  /**
   * Whether the stored document is a DRAFT whose brand was never CHOSEN
   * (#1911, P3, D10) — `rascunhoSemMarcaShopee` (`@delfrance/schemas`, the ONE
   * predicate the web's pendência calls too) over the RAW document: a draft
   * whose `brand_id` is not a safe non-negative integer (`null`, absent, `-1`,
   * `'77'`, `1.5`… — fail-closed since P5). Set by the ONE builder, `linkListagemLido`
   * in `publicarAnuncio.ts`; read by {@link montarAnuncio} alone, which refuses
   * it as `marca-nao-escolhida` BEFORE the brand cascade's `0` could turn "not
   * chosen" into Shopee's "No Brand" on the operator's behalf.
   *
   * ⚠️ **Never re-derived here from `brand_id` + `item_id` above.** `item_id` is
   * FOLDED (a corrupt `0` reads `null`), so a corrupt link would pass for a
   * draft; only the raw document keeps it out of the class — the
   * {@link ehRascunho} rule.
   *
   * ⚠️ **REQUIRED, unlike {@link ehRascunho}.** A builder that forgot it must
   * fail to compile: an absent flag reads as "chosen", and the cascade then
   * publishes "No Brand" for a draft nobody picked a brand for — the silent
   * direction. A listing's link always carries `false`: its `brand_id: null`
   * keeps today's cascade (D10 leaves every non-draft link untouched).
   */
  readonly marcaNaoEscolhida: boolean;
}

/**
 * What the channel builder hands over.
 *
 * Declared structurally rather than imported from `logisticaPublicacao.ts` on
 * purpose: this module must not depend on that one to compile, and the wire list
 * plus the enabled ids plus the problemas are the whole of what the ITEM payload
 * needs. `ResultadoLogistica` satisfies it.
 */
export interface LogisticaParaMontar {
  readonly logistic_info: readonly ShopeeLogisticInfoRequest[];
  /** The `logistic_id`s that go out `enabled: true` — the `pre_order` gate reads them. */
  readonly canaisHabilitados: readonly number[];
  readonly problemas: readonly ProblemaPublicacao[];
}

/**
 * What the `tax_info` builder hands over — `ResultadoTaxInfo` satisfies it.
 *
 * ⚠️ ONE arm is built (`POLITICA_TAX_INFO = 'omitir'`): a `taxInfo` of `null`
 * means the ten-member BR block could not be completed, and then the `tax_info`
 * KEY IS ABSENT from both bodies. Never `null` as a value, never a partial block
 * — Shopee validates the block all-or-nothing and a `null` key would be a
 * refusal instead of an omission.
 */
export interface TaxInfoParaMontar {
  readonly taxInfo: ShopeeTaxInfoRequest | null;
  /** Why it was omitted. Recorded on the link document by the caller, not here. */
  readonly omitido: string | null;
}

export interface ArgsMontarAnuncio {
  readonly produto: ProdutoParaPublicar;
  /** `extraData.descricao`. The stored link's own description WINS over it. */
  readonly descricao: string | null;
  readonly link: LinkListagemLido | null;
  readonly limites: LimitesDeItemLidos;
  readonly atributos: AtributosProjetados;
  /** The leaf verdict for the RESOLVED category id — `folha` is the only publishable one. */
  readonly veredictoFolha: VerdictoFolha;
  /** The operator's choice on a FIRST publish; the stored `link.category_id` wins. */
  readonly categoryId: number | null;
  /** C17's cascade, already resolved. `brandId: 0` is Shopee's "No Brand". */
  readonly marca: { readonly brandId: number; readonly nome: string | null };
  readonly logistica: LogisticaParaMontar;
  readonly taxInfo: TaxInfoParaMontar | null;
  /** `image_id`s, in render ORDER, already resolved and uploaded. */
  readonly imagens: readonly string[];
  readonly ehAtualizacao: boolean;
  /** CREATE only — an update never carries `item_status`. */
  readonly statusPedido: ShopeeItemStatusWritable;
  readonly temFilhos: boolean;
  /**
   * The ListaDePrecos DOC ID of the conta's normal table — the trailing segment
   * of `deps.tabelaNormalOuterRef`, folded by the caller.
   *
   * ⚠️ A whole outer ref here resolves NOTHING (`precos` is keyed by the bare id)
   * and the produto reads as priceless. Pinned by a near-miss test rather than by
   * a comment.
   */
  readonly tabelaNormalId: string | null;
  /** The throwaway item-level price of a has-model CREATE. */
  readonly precoDoPrimeiroFilho: number | null;
  /**
   * That first child's `precoDoPai` (D-9): its price is the PARENT's because the
   * parent propagates. Words the create's `filho-sem-preco` only — the motivo
   * is the same either way.
   */
  readonly precoDoPrimeiroFilhoVemDoPai: boolean;
  /** The throwaway item-level stock of a has-model CREATE (O3). */
  readonly estoqueDoPrimeiroFilho: number | null;
  /** This produto's own available stock at the conta's depósito. */
  readonly ownDisponivel: number;
  /** Component produto id → its available stock, for the kit branch. */
  readonly disponivelByProdutoId: Record<string, number | null | undefined>;
  /**
   * The produto's tabela de medidas as read for THIS conta (step 18,
   * `lerTabelaMedidasDoProduto`). REQUIRED, so a caller that forgot the read
   * fails to compile instead of publishing every listing without a chart.
   */
  readonly tabelaDeMedidas: LeituraTabelaDeMedidasShopee;
  /**
   * The `image_id` the I/O half uploaded for the tabela's FIRST photo, or
   * `null` — no photo was due, or its upload failed (the plan refuses that
   * case). Read ONLY when the decision's `fonte` is `foto`: a template that
   * matched always wins, whatever this holds.
   */
  readonly imagemTabelaDeMedidas: string | null;
}

/* -------------------------------------------------------------------------- */
/*                                   Output                                   */
/* -------------------------------------------------------------------------- */

export interface ItemMontado {
  readonly criar: ShopeeAddItemRequest;
  /**
   * `null` exactly when no positive `item_id` is known.
   *
   * ⚠️ Deliberately nullable rather than built with a `0`: `item_id` is REQUIRED
   * on `update_item` and `0` is Shopee's "this item has no id" sentinel, so a
   * placeholder there would be a value that goes OUT on the wire. An update path
   * without an item id is unreachable in practice — the caller only takes it when
   * it resolved a link carrying one — and a `null` says so in the type.
   */
  readonly atualizar: ShopeeUpdateItemRequest | null;
  readonly problemas: readonly ProblemaPublicacao[];
  /**
   * The size-chart decision both bodies were built from — present on a BLOCKED
   * montagem too, so the dry run reports the diagnosis whatever else refused.
   */
  readonly tabelaDeMedidas: ResultadoTabelaDeMedidasShopee;
}

/* -------------------------------------------------------------------------- */
/*                                   Helpers                                  */
/* -------------------------------------------------------------------------- */

/** `brand.original_brand_name` for `brand_id: 0` — `add_item.brand`'s own wording. */
const NOME_SEM_MARCA = 'No Brand';

/** The `gtin_validation_rule` value that makes a GTIN a refusal. */
const REGRA_GTIN_OBRIGATORIA = 'Mandatory';

function problema(
  campo: string | null,
  motivo: ProblemaPublicacao['motivo'],
  mensagem: string,
): ProblemaPublicacao {
  return { campo, motivo, mensagem: limitarMensagemProblema(mensagem) };
}

/*
 * "Usable text" (trimmed, blank ⇒ ABSENT), the band check (`null` band or end =
 * NO bound, both ends inclusive) and its description live in
 * `@delfrance/schemas`' `faixaShopee.ts` (#1911) — `textoUtilizavelShopee`,
 * `dentroDaFaixaShopee`, `descreverFaixaShopee`, `textoNaFaixaShopee` — together
 * with the name and description resolutions (`tituloDoAnuncioShopee`,
 * `descricaoDoAnuncioShopee`), so a browser surface (#1911's draft editor) can
 * ask the same questions this module refuses on, with no second copy (#1369).
 */

/** A usable positive number. `0`, a negative and a non-finite all read as absent. */
function numeroPositivo(valor: number | null | undefined): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) return null;
  return valor;
}

/** A band's lower bound as a number, `0` when the category states none. */
function minimoDaFaixa(banda: FaixaDto | null | undefined): number {
  if (banda == null || banda.min === null || !Number.isFinite(banda.min)) return 0;
  return banda.min;
}

/**
 * `condition` — total over a boolean, so it cannot fail, and it rides EVERY
 * create AND update (`announcement 1528` makes it mandatory for BR on both).
 */
export function condicaoDoProduto(produto: ProdutoParaPublicar): ShopeeCondition {
  return produto.ehUsado ? SHOPEE_CONDITION.used : SHOPEE_CONDITION.new;
}

/**
 * `weight` in kg — the first USABLE of gross then net, or `null`.
 *
 * ⚠️ **Never a default.** The legacy exporter sent `1` kg when the produto had
 * none (`exportar.dart:1000`), which published a freight quote nobody chose and
 * a parcel nobody weighed. An absent weight is a refusal.
 *
 * ⚠️ The order is gross THEN net and the test is "usable", not "present": a
 * stored `0` gross beside a real net weight is a produto whose gross was never
 * measured, and a plain `??` would answer `0` for it and then refuse a produto
 * this ERP can perfectly well publish.
 */
export function pesoParaPublicar(produto: ProdutoParaPublicar): number | null {
  return numeroPositivo(produto.pesoBrutoKg) ?? numeroPositivo(produto.pesoLiquidoKg);
}

/**
 * `dimension` in whole centimetres, or `null` when any axis is missing.
 *
 * ⚠️ **`Math.ceil`, never truncation.** Understating a box by a fraction of a
 * centimetre enables a logistics channel the parcel does not fit, and the
 * rejection arrives at the carrier rather than at Shopee.
 *
 * ⚠️ **The axis names come from {@link EIXOS_PACOTE_SHOPEE_INVERSO}** and from no
 * second table. The legacy import and export disagreed about which produto field
 * was `package_width`, and a round trip TRANSPOSED two dimensions; the map is
 * derived from its own inverse and `eixos.test.ts` asserts the bijection, so
 * reading it here is what keeps the transposition dead.
 *
 * All three axes are BR-mandatory (`announcement 1100`) — a volume is not enough,
 * and the legacy's `10` cm default is never reachable from here.
 */
export function dimensaoParaPublicar(produto: ProdutoParaPublicar): ShopeeDimensionRequest | null {
  const altura = numeroPositivo(produto.alturaCm);
  const largura = numeroPositivo(produto.larguraCm);
  const profundidade = numeroPositivo(produto.profundidadeCm);
  if (altura === null || largura === null || profundidade === null) return null;
  return {
    [EIXOS_PACOTE_SHOPEE_INVERSO.alturaCm]: Math.ceil(altura),
    [EIXOS_PACOTE_SHOPEE_INVERSO.larguraCm]: Math.ceil(largura),
    [EIXOS_PACOTE_SHOPEE_INVERSO.profundidadeCm]: Math.ceil(profundidade),
  };
}

/**
 * `attribute_list` from the stored attributes, plus the mandatory set it misses.
 *
 * ⚠️ **Neither half is decided here** (#1911, D9). Both come from
 * `@delfrance/schemas`' `atributosShopee.ts` — the ONE decoder and the ONE
 * validator, which the draft route and the produto's Shopee tab in `apps/web`
 * read too (#1369: a second copy here would drift toward plausible while both
 * read correct). This function only composes them, and keeps its signature
 * because `publicarAnuncioCli.ts`'s dry run calls it with the same two
 * arguments.
 *
 * **`lista`** — `lerAtributosArmazenadosShopee` → `atributosParaEnvioShopee`:
 * whichever of the three stored shapes the link holds (write-back #1's REQUEST
 * shape, as sent; the product import's READ shape; the legacy value with no
 * `value_id`), in stored order, always in the request shape. The ERP models no
 * Shopee attribute of its own, so the stored list is the ONLY source there is.
 *
 * - Everything usable that is stored is SENT — an attribute the current tree
 *   does not show (another category's, a child whose parent value is no longer
 *   chosen) included. Dropping those is the web editor's save (P13, via
 *   `atributosParaGravarShopee`, before it posts); the draft route stores what
 *   it receives, and the publisher sends what is stored.
 * - An entry with no usable value is dropped rather than sent empty: Shopee
 *   reads an empty `attribute_value_list` as a DELETION. A custom value
 *   (`value_id: 0`) with a blank name is such a value — dropped, so the
 *   attribute may end up missing, which is how it reaches
 *   `atributo-obrigatorio` instead of a wire rejection.
 * - ⚠️ **A legacy custom value stored with NO `value_id` is SENT**, as
 *   `{value_id: 0, original_value_name}` (Lucas, #1911 Round 3 Q1 — the legacy
 *   app sent it too). Before #1911 this function dropped it in silence, which on
 *   a mandatory attribute read only as "missing"; a refusal by name is routable
 *   to the attribute editor. A blank name is still dropped.
 * - ⚠️ A DATE stored in the READ form (`06/2021`, what the product import
 *   stores verbatim) goes out in the WRITE form: guide 209 §2.3 documents the
 *   write as a Unix timestamp in `original_value_name`, so the read form sent
 *   as is would be refused. The tree says which attributes are dates
 *   (`inputValidationType` 4), and the conversion is the shared module's
 *   (`atributosParaEnvioShopee` → `timestampDeDataShopee`) — never decided
 *   here. Its instant-of-day (12:00 UTC) stays UNVERIFIED until the BR
 *   captures (Q-DB2) and lives in that ONE place. A timestamp, a date the tree
 *   does not know and a text that is no real date go out as stored.
 *
 * **`faltando`** — the `obrigatorio-ausente` rows of `validarAtributosShopee`,
 * and ONLY those: a VISIBLE mandatory attribute with no decoded value. A ROOT
 * (named `name ?? '#<id>'`, the pre-#1911 check) or — new in #1911 — a
 * mandatory CHILD that a value the listing CHOSE unlocks, named
 * `"<filho> (em <pai>: <valor>)"`; the child of an unchosen value is invisible
 * and never missing. Every other kind the validator finds (a custom value on a
 * list-only attribute, a value outside the list, too many values, a unit, a
 * value type, an orphan) reaches Shopee, which names it — a read-form date
 * reaches it CONVERTED (above): the editor shows them, the publisher refuses
 * none of them. `obrigatorio-requer-busca`
 * is an EXTRA row beside `obrigatorio-ausente`, so filtering on the latter names
 * each missing attribute exactly once.
 *
 * ⚠️ `variation_id != 0 ⇒ never send variation_name` is the TIER rule
 * (`announcement 873`) and has nothing to do with attributes. It lives in
 * `tiersPublicacao.ts`.
 */
export function atributosParaPublicar(
  armazenados: readonly unknown[] | null,
  projetados: AtributosProjetados,
): { readonly lista: readonly ShopeeAttributeRequest[]; readonly faltando: readonly string[] } {
  const lidos = lerAtributosArmazenadosShopee(armazenados).atributos;
  const faltando = validarAtributosShopee(projetados, lidos)
    .filter((p) => p.tipo === TIPO_PROBLEMA_ATRIBUTO_SHOPEE.obrigatorioAusente)
    .map((p) => p.nome);
  return { lista: atributosParaEnvioShopee(projetados, lidos), faltando };
}

/**
 * `pre_order`, whose wrong-way default is `false`.
 *
 * `true` requires ALL of: the shop's own `supportsPreOrder` for this category, a
 * `crossdocking` strictly above `non_pre_order_days_to_ship`, that value inside
 * `days_to_ship_limit`, and **no enabled channel numbered
 * {@link CANAL_SEM_PRE_ORDER}** (`announcement 1094`: that channel refuses
 * pre-order). Anything else is `{is_pre_order: false}` with `days_to_ship`
 * omitted.
 *
 * ⚠️ The channel gate drops PRE-ORDER, never the channel — the produto still
 * publishes on 90021, it just ships inside the normal window.
 *
 * ⚠️ CREATE only. `update_item` declares no `pre_order` at all, so a republish
 * cannot move it; that is `update_model`'s field and step 12's business.
 */
export function preOrderParaPublicar(
  crossdocking: number | null,
  limites: LimitesDeItemLidos,
  canaisHabilitados: readonly number[],
): ShopeePreOrderRequest {
  const negado: ShopeePreOrderRequest = { is_pre_order: false };
  if (canaisHabilitados.includes(CANAL_SEM_PRE_ORDER)) return negado;
  if (!limites.supportsPreOrder) return negado;
  const dias = numeroPositivo(crossdocking);
  if (dias === null) return negado;
  const dts = limites.limites.dtsLimit;
  const normal = dts?.nonPreOrderDaysToShip;
  if (typeof normal !== 'number' || !Number.isFinite(normal)) return negado;
  if (dias <= normal) return negado;
  if (!dentroDaFaixaShopee(dias, dts?.daysToShipLimit)) return negado;
  return { is_pre_order: true, days_to_ship: dias };
}

/**
 * The kit-aware publish quantity — **MOVED** to
 * `../estoque/quantidadeEstoque` (step 12, #1520) and re-exported from here so
 * every importer and both step-11 suites are untouched.
 *
 * It moved because the fold stopped being a publish detail: the stock sync
 * needs the same number for `update_stock`, and Mercado Livre has been
 * computing it since #678. All three now call ONE implementation in
 * `@delfrance/data/admin/estoque`, with each channel supplying its own
 * parameters — which is what turns "two files that claim to agree" into
 * something the compiler checks. The band's maximum still clamps DOWN and the
 * minimum still never clamps UP; {@link montarAnuncio} raises
 * `estoque-abaixo-do-minimo` for the latter, as before.
 *
 * ⚠️ **Sharing the fold is NOT sharing the kit own-stock knob.**
 * `SHOPEE_STOCK_KIT_INCLUI_PROPRIO` moves the sync only — the sweep and the
 * manual push — and never the create-time `seller_stock` built here: the
 * function binds the core through `opcoesPublicacaoShopee`, which pins that
 * parameter `false`, so a kit is still created at the minimum over its
 * components exactly as step 11 designed (no own-stock hook), and a kit
 * published as a no-model item agrees with a kit published as a MODEL, whose
 * `seller_stock` `filhoParaPublicar` (`./publicarAnuncio`) folds with no hook
 * either. With the knob ON, the sync raises a new kit listing by its own stock
 * on its first send — accepted; `opcoesPublicacaoShopee`'s docblock says why.
 */
export { quantidadeParaPublicarShopee };

/* -------------------------------------------------------------------------- */
/*                  The ONE category resolution, and the size chart            */
/* -------------------------------------------------------------------------- */

/**
 * The listing's RESOLVED category: the stored link's `category_id`, else the
 * operator's choice (C36 — a stored value always wins, `null` meaning absent).
 *
 * ⚠️ **ONE expression, and every reader of "which category is this listing in"
 * calls it** (step 18, A.1.3): {@link montarAnuncio} (the `category_id` of both
 * bodies, the leaf gate and the size-chart pick), `prepararPublicacao` (the
 * taxonomy reads) and the size-chart PHOTO pass in `publicarAnuncio.ts`, which
 * has to decide whether to upload the tabela's first photo BEFORE this module
 * runs. A second copy of this one-line cascade is how the photo
 * pass would pick against one category while the body went out under another
 * — a stored link in category 200 with an entry only for the operator's 100
 * must attach no TEMPLATE, in both places at once (the tabela's first photo
 * may still go, by the same decision).
 */
export function categoriaDoAnuncio(
  link: { readonly category_id: number | null } | null,
  categoryId: number | null,
): number | null {
  return link?.category_id ?? categoryId;
}

/**
 * `size_chart_info` from the decision — EXACTLY one key, or `null` for an
 * absent key.
 *
 * `modelo` ⇒ `{ size_chart_id }`, and the image is never looked at (the
 * template wins, A.1.2); `foto` with an uploaded id ⇒ `{ size_chart }`;
 * anything else ⇒ `null`. ⚠️ Never `{ size_chart_id: 0 }` and never
 * `{ size_chart: '' }`: both are Shopee's DETACH sentinels, and the package
 * guard refuses them anyway — a chart set in Seller Centre must survive an
 * update where the ERP has nothing to say.
 */
export function sizeChartInfoParaPublicar(
  decisao: ResultadoTabelaDeMedidasShopee,
  imagem: string | null,
): ShopeeSizeChartInfoRequest | null {
  const fonte = decisao.fonte;
  if (fonte.tipo === FONTE_TABELA_MEDIDAS.modelo) return { size_chart_id: fonte.sizeChartId };
  if (fonte.tipo === FONTE_TABELA_MEDIDAS.foto && imagem !== null) return { size_chart: imagem };
  return null;
}

/* -------------------------------------------------------------------------- */
/*                           The native-kit predicate                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether this listing is a **NATIVE Shopee kit** — the only thing
 * `produto-e-kit` refuses.
 *
 * ONE definition, called by BOTH producers of that refusal: {@link
 * montarAnuncio} below and `recusarProdutoNaoPublicavel` in
 * `publicarAnuncio.ts`. They are two sites deciding one thing, which is exactly
 * the shape that drifts when it is written twice.
 *
 * ⚠️ **Since step 19 (#1527, PR 7) both producers are a DEFENSIVE assertion,
 * never an answer.** A native kit is published by the kit arms
 * (`add_kit_item` / `update_kit_item`, `../kits/`), and the dispatcher
 * (`escolherArmaDePublicacao`, `../kits/armaDePublicacao.ts`) routes every
 * native-kit link (`kitNativo === true`) and every `ehKitVirtual` first
 * publish (`ehKitVirtualEfetivo`, no live link) there before this item planner
 * runs. So reaching `produto-e-kit` here means a kit slipped past the
 * dispatcher — a defect of the ERP, which the refusal's own sentence says —
 * and the refusal keeps it from going out as an ORDINARY listing through
 * `add_item`.
 *
 * ⚠️ **`produto.ehKit` NEVER refuses.** It is the ERP's "assembled from
 * components" flag, and the ERP holds thousands of such produtos that the
 * legacy app published to Shopee as ORDINARY listings. Step 11 keyed the
 * refusal on it alone and so blocked the whole legacy kit catalogue from being
 * re-published; step 12 (#1520) narrows it to the two arms below.
 *
 * Which arm runs is {@link vinculoDecideKitNativo}'s answer, exported so that
 * `recusarProdutoNaoPublicavel` labels its `campo` from the SAME branch.
 *
 * - **A link that is not a draft — a republish.** `link.kitNativo` is what
 *   Shopee itself reported about the live listing (`tag.kit`, folded by
 *   `ehKitDe` in `../produtos/itemLido.ts`), so on an update it is the only statement about
 *   the listing that is not a guess, and it WINS over anything the produto
 *   says. `false` and an absent/`null` reading both publish: a native kit's
 *   link carries the LITERAL `true` from the link write that follows
 *   `add_kit_item` on (`../kits/vinculosKit.ts`), and no native kit existed in
 *   this catalogue before step 19 created the first ones — so an unstamped link
 *   is an ORDINARY listing (the legacy corpus, or one imported before the field
 *   existed) and must not be read as a kit.
 * - **No link, or a DRAFT link (#1911, D3) — a first publish.**
 *   `produto.ehKitVirtual` is the ERP's own statement that the MARKETPLACE
 *   resolves the composition (`produto/collection/produto.ts:105-110`), which
 *   on Shopee means `add_kit_item` — step 19's `kit-criar` arm. ⚠️ `ehKit ===
 *   false ⇒ ehKitVirtual === false` is NOT an invariant of the stored data: nothing in
 *   the schema stops a doc from carrying the flag beside `ehKit: false`
 *   (`onProdutoDeleted` clears the pair only when a kit's LAST component is
 *   deleted — `ehKitVirtualEfetivo`'s docblock, `@delfrance/schemas`). What
 *   keeps an ordinary produto out of this arm is `escolherArmaDePublicacao`,
 *   which refuses that mismatch (`kit-virtual-sem-kit`) before any plan exists,
 *   while the web switches the flag off on save from step 19 on.
 *   ⚠️ A DRAFT takes this arm because Shopee never answered for it: whatever
 *   its `kitNativo` holds is no reading of a listing, so on the kit question it
 *   is exactly a first publish. Read by the link arm, a draft on a kit-virtual
 *   produto would go out as an ORDINARY `add_item` with no refusal at all
 *   (#1911's spot-check row 6). The dispatcher refuses that pair first
 *   (`rascunho-em-kit-virtual`); this arm is the defence in depth for a caller
 *   that bypassed it, which hears `produto-e-kit` ("defeito do ERP").
 *
 * ⚠️ It is deliberately **not** the same predicate as the stock sweep's
 * (`../estoque/podeEnviarEstoque.ts`), which reads the link's field and nothing
 * else. That module only ever runs over rows that HAVE a link, so a create arm
 * there would be unreachable code — and worse, it would invite `ehKitVirtual`
 * into a decision where the link is already the authority. Two rules, each
 * total over the inputs it actually meets, each pinned by its own tests; not
 * one rule copied into two files.
 *
 * Both parameters are typed loosely because the values arrive from stored
 * documents and the comparison is `=== true`: a string `'true'`, a `1` and an
 * absent key all read as "not a native kit".
 */
export function kitNativoDoAnuncio(
  link: { readonly kitNativo?: unknown; readonly ehRascunho?: unknown } | null,
  produto: { readonly ehKitVirtual?: unknown },
): boolean {
  return link !== null && vinculoDecideKitNativo(link)
    ? link.kitNativo === true
    : produto.ehKitVirtual === true;
}

/**
 * Does the stored LINK answer {@link kitNativoDoAnuncio} (a republish), or the
 * PRODUTO (a first publish)? `false` for no link and for a DRAFT link
 * ({@link LinkListagemLido.ehRascunho} `=== true`, #1911): a draft is a listing
 * Shopee never answered for, so nothing on it is a reading of the listing.
 *
 * Exported for ONE reason: `recusarProdutoNaoPublicavel` names the field the
 * operator must look at (`kitNativo` vs `ehKitVirtual`) from the arm the
 * predicate took, and a second spelling of the branch there is the label
 * drifting from the decision. `ehRascunho` is read `=== true`, so an absent key
 * (a projection predating #1911) lets the link decide, as before.
 */
export function vinculoDecideKitNativo(link: { readonly ehRascunho?: unknown } | null): boolean {
  return link !== null && link.ehRascunho !== true;
}

/* -------------------------------------------------------------------------- */
/*                                 The mapper                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build both bodies and every refusal the produto graph can produce.
 *
 * Field sources, the stored link winning where it has one, are in the module
 * docblock; the refusal set is the nineteen members listed there. Nothing here
 * throws: a refusal is a `problemas[]` entry, and the caller decides.
 */
export function montarAnuncio(args: ArgsMontarAnuncio): ItemMontado {
  const { produto, link, limites, logistica } = args;
  const problemas: ProblemaPublicacao[] = [];
  const bandas = limites.limites;

  /* ---- the three refusals that are about the produto, not about a field ---- */

  if (produto.paiId !== null) {
    problemas.push(
      problema(
        null,
        MOTIVO_PUBLICACAO_BLOQUEADA.produtoEFilho,
        'o produto é uma variação (tem produto pai) — o anúncio é publicado a partir do pai',
      ),
    );
  }
  if (kitNativoDoAnuncio(link, produto)) {
    problemas.push(
      problema(
        null,
        MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
        'o anúncio é um kit NATIVO da Shopee e chegou ao montador de anúncio comum — kit nativo é ' +
          'publicado pelo caminho de kit (add_kit_item / update_kit_item), para onde o ERP o ' +
          'encaminha antes de montar qualquer anúncio; chegar aqui é defeito do ERP, nada foi enviado',
      ),
    );
  }
  if (link?.estadoAnuncio === ESTADO_ANUNCIO_SHOPEE.removido) {
    problemas.push(
      problema(
        null,
        MOTIVO_PUBLICACAO_BLOQUEADA.listagemRemovida,
        'o anúncio armazenado está removido na Shopee — publicar um novo é decisão do operador',
      ),
    );
  }

  /* --------------------------------- name --------------------------------- */

  // The resolved text is what the bodies carry (even on a refusal); the verdict
  // is what refuses — both from `@delfrance/schemas`, so a browser can share them.
  const nome = tituloDoAnuncioShopee(link?.item_name, produto.nome);
  const nomeNaFaixa = textoNaFaixaShopee(nome, bandas.itemNameLengthLimit);
  if (nomeNaFaixa.estado === 'ausente') {
    problemas.push(
      problema('item_name', MOTIVO_PUBLICACAO_BLOQUEADA.semNome, 'o produto não tem nome'),
    );
  } else if (nomeNaFaixa.estado === 'fora-da-faixa') {
    problemas.push(
      problema(
        'item_name',
        MOTIVO_PUBLICACAO_BLOQUEADA.nomeForaDaFaixa,
        `o nome tem ${String(nomeNaFaixa.comprimento)} caracteres, fora da faixa da categoria ` +
          `(${descreverFaixaShopee(bandas.itemNameLengthLimit)}) — nunca truncado`,
      ),
    );
  }

  /* ------------------------------ description ----------------------------- */

  const descricao = descricaoDoAnuncioShopee(link?.description, args.descricao);
  const descricaoNaFaixa = textoNaFaixaShopee(descricao, bandas.itemDescriptionLengthLimit);
  if (descricaoNaFaixa.estado === 'ausente') {
    problemas.push(
      problema(
        'description',
        MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
        'o produto não tem descrição',
      ),
    );
  } else if (descricaoNaFaixa.estado === 'fora-da-faixa') {
    problemas.push(
      problema(
        'description',
        MOTIVO_PUBLICACAO_BLOQUEADA.descricaoForaDaFaixa,
        `a descrição tem ${String(descricaoNaFaixa.comprimento)} caracteres, fora da faixa da categoria ` +
          `(${descreverFaixaShopee(bandas.itemDescriptionLengthLimit)})`,
      ),
    );
  }

  /* ------------------------------- category ------------------------------- */

  const categoryId = categoriaDoAnuncio(link, args.categoryId);
  if (categoryId === null || args.veredictoFolha !== 'folha') {
    problemas.push(
      problema(
        'category_id',
        MOTIVO_PUBLICACAO_BLOQUEADA.categoriaInvalida,
        categoryId === null
          ? 'nenhuma categoria Shopee resolvida para o produto'
          : `a categoria ${String(categoryId)} é ${args.veredictoFolha} — a Shopee só aceita folha`,
      ),
    );
  }

  /* --------------------------- size chart (step 18) ------------------------ */

  // ⚠️ On the RESOLVED category, right here — never on `args.categoryId`: a
  // stored link in another category than the operator's choice selects by the
  // LINK's, exactly as `category_id` above does. The decision never refuses.
  const tabelaDeMedidas = resolverTabelaDeMedidasDoAnuncio(
    args.tabelaDeMedidas,
    categoryId,
    bandas.sizeChartLimit,
  );
  const sizeChartInfo = sizeChartInfoParaPublicar(tabelaDeMedidas, args.imagemTabelaDeMedidas);

  /* -------------------------------- weight -------------------------------- */

  const peso = pesoParaPublicar(produto);
  if (peso === null) {
    problemas.push(
      problema(
        'weight',
        MOTIVO_PUBLICACAO_BLOQUEADA.semPeso,
        'o produto não tem peso bruto nem líquido utilizável',
      ),
    );
  }

  /* ------------------------------ dimension ------------------------------- */

  const dimensao = dimensaoParaPublicar(produto);
  if (dimensao === null) {
    problemas.push(
      problema(
        'dimension',
        MOTIVO_PUBLICACAO_BLOQUEADA.semDimensoes,
        'altura, largura e profundidade são todas obrigatórias no Brasil e alguma está ausente',
      ),
    );
  }

  /* -------------------------------- images -------------------------------- */

  const tetoDaBanda = bandas.itemImageCountLimit?.max;
  const teto =
    typeof tetoDaBanda === 'number' && Number.isFinite(tetoDaBanda)
      ? Math.min(SHOPEE_ITEM_IMAGE_MAX, tetoDaBanda)
      : SHOPEE_ITEM_IMAGE_MAX;
  const imagens = args.imagens.slice(0, Math.max(teto, 0));
  if (imagens.length === 0) {
    problemas.push(
      problema(
        'image',
        MOTIVO_PUBLICACAO_BLOQUEADA.semFotos,
        'nenhuma foto utilizável — a Shopee exige ao menos uma imagem no anúncio',
      ),
    );
  }

  /* --------------------------------- gtin --------------------------------- */

  const gtin = textoUtilizavelShopee(produto.gtin);
  const regraGtin = textoUtilizavelShopee(limites.gtinLimit?.gtinValidationRule);
  if (gtin === null && regraGtin === REGRA_GTIN_OBRIGATORIA) {
    problemas.push(
      problema(
        'gtin_code',
        MOTIVO_PUBLICACAO_BLOQUEADA.semGtin,
        'a categoria exige GTIN (gtin_validation_rule Mandatory) e o produto não tem',
      ),
    );
  }

  /* ------------------------------ attributes ------------------------------ */

  const atributos = atributosParaPublicar(link?.attributes ?? null, args.atributos);
  if (atributos.faltando.length > 0) {
    problemas.push(
      problema(
        'attribute_list',
        MOTIVO_PUBLICACAO_BLOQUEADA.atributoObrigatorio,
        `atributos obrigatórios da categoria sem valor: ${atributos.faltando.join(', ')}`,
      ),
    );
  }

  /* -------------------------------- brand --------------------------------- */

  const brandId = link?.brand_id ?? args.marca.brandId;
  const nomeDaMarca = textoUtilizavelShopee(args.marca.nome);
  let brand: ShopeeAddItemRequest['brand'];
  if (link?.marcaNaoEscolhida === true) {
    // ⚠️ FIRST, before the `0` arm: a draft's absent brand reaches here as the
    // cascade's `0`, and "No Brand" is a choice the operator makes («Sem
    // marca»), never one the ERP makes for them (#1911, D10). No `brand` block
    // and no `marca-sem-nome` — the refusal names the one missing decision.
    brand = undefined;
    problemas.push(
      problema(
        'brand',
        MOTIVO_PUBLICACAO_BLOQUEADA.marcaNaoEscolhida,
        'o rascunho não tem marca escolhida — escolha a marca do rascunho na aba Shopee ' +
          '(ou «Sem marca») antes de publicar',
      ),
    );
  } else if (brandId === 0) {
    // No lookup, no read, no cascade: `brand_id: 0` IS "No Brand".
    brand = { brand_id: 0, original_brand_name: NOME_SEM_MARCA };
  } else if (nomeDaMarca !== null) {
    brand = { brand_id: brandId, original_brand_name: nomeDaMarca };
  } else {
    brand = undefined;
    // Both children are REQUIRED on create and OPTIONAL on update, so an
    // unresolvable name refuses a create and merely omits the block on an
    // update — omitting destroys nothing, because `update_item` is field-wise.
    if (!args.ehAtualizacao) {
      problemas.push(
        problema(
          'brand',
          MOTIVO_PUBLICACAO_BLOQUEADA.marcaSemNome,
          `a marca ${String(brandId)} não teve o nome resolvido e original_brand_name é ` +
            'obrigatório no add_item',
        ),
      );
    }
  }

  /* -------------------------------- price --------------------------------- */

  // ⚠️ `precoDaTabela` (`@delfrance/schemas`) is the ONE reader of "the price of
  // this produto in that tabela" for every channel that SENDS one (step 13,
  // #1521): rounded to the centavo through `roundReais`, and positive AFTER
  // rounding — a stored `0.004` is no price at all, never a `0.004` on the wire.
  // The first child's price arrives already read through it
  // (`publicarAnuncio.ts`'s `filhoParaPublicar`), so the child arm only guards.
  const precoProprio = precoDaTabela(produto.precos, args.tabelaNormalId);
  const preco = args.temFilhos ? numeroPositivo(args.precoDoPrimeiroFilho) : precoProprio;
  // ⚠️ CREATE-only, all three — the same rule the `seller_stock` refusal below
  // already follows, and for the same reason: `original_price` is absent from
  // `update_item`'s table (point 1 of the module docblock) and `atualizar`
  // carries no such key, so an update sends no price and there is nothing to
  // refuse. Gating them on the create is what keeps a produto with no entry in
  // the conta's tabela normal — a step-9 import, an unset `tabelaNormalOuterRef`,
  // a price living in another lista — UPDATABLE at all: without it `montarAnuncio`
  // returned a blocking problema, `aplicarPublicacao` raised
  // `ShopeePublishBlockedError` before the first Shopee call, and an operator
  // fixing a description or refreshing photos got a 422 `sem-preco`.
  if (!args.ehAtualizacao) {
    if (preco === null) {
      // Under propagation (D-9) the first child's price IS the parent's, and the
      // web refuses a per-child price edit — so the text names the parent, the
      // field the operator can fix. Same motivo either way.
      problemas.push(
        args.temFilhos
          ? problema(
              'original_price',
              MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
              args.precoDoPrimeiroFilhoVemDoPai
                ? 'o produto pai propaga o preço para as variações e não tem preço na tabela ' +
                    'normal — defina o preço do pai ou desligue a propagação'
                : 'o primeiro filho não tem preço na tabela normal — é dele que sai o preço ' +
                    'descartável do item',
            )
          : problema(
              'original_price',
              MOTIVO_PUBLICACAO_BLOQUEADA.semPreco,
              'o produto não tem preço na tabela normal da conta',
            ),
      );
    } else if (!dentroDaFaixaShopee(preco, bandas.priceLimit)) {
      problemas.push(
        problema(
          'original_price',
          MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa,
          `o preço ${String(preco)} está fora da faixa da categoria ` +
            `(${descreverFaixaShopee(bandas.priceLimit)})`,
        ),
      );
    }
  }

  /* -------------------------------- stock ---------------------------------- */

  const banda = bandas.stockLimit;
  const minimo = minimoDaFaixa(banda);
  let estoque: number;
  if (args.temFilhos) {
    // O3's throwaway: the models replace it inside the create sequence and the
    // item is UNLIST meanwhile, but Shopee still validates it — a `0` was
    // refused on 2026-09-17 with `Stock should be within 2-1000000 for model`.
    estoque = Math.max(minimo, numeroPositivo(args.estoqueDoPrimeiroFilho) ?? minimo);
  } else {
    estoque = quantidadeParaPublicarShopee({
      ehKit: produto.ehKit,
      ehKitVirtual: produto.ehKitVirtual,
      componentesKit: produto.componentesKit,
      ownDisponivel: args.ownDisponivel,
      disponivelByProdutoId: args.disponivelByProdutoId,
      banda: banda ?? null,
    });
    // CREATE-only: `seller_stock` is absent from `update_item`'s table, so a
    // republish sends no stock and there is nothing to refuse.
    if (!args.ehAtualizacao && estoque < minimo) {
      problemas.push(
        problema(
          'seller_stock',
          MOTIVO_PUBLICACAO_BLOQUEADA.estoqueAbaixoDoMinimo,
          `o estoque disponível ${String(estoque)} está abaixo do mínimo da loja ` +
            `(${descreverFaixaShopee(banda)}) — a Shopee recusa a criação e o estoque nunca ` +
            'é arredondado para cima',
        ),
      );
    }
  }
  const sellerStock: readonly ShopeeSellerStockRequest[] = [{ stock: estoque }];

  /* ------------------------------ relayed --------------------------------- */

  problemas.push(...logistica.problemas);

  /* ------------------------------ the bodies ------------------------------ */

  const taxInfo = args.taxInfo?.taxInfo ?? null;
  const condition = condicaoDoProduto(produto);
  const sku = textoUtilizavelShopee(produto.sku);
  const image = { image_id_list: imagens };
  const atributoLista = atributos.lista;

  const criar: ShopeeAddItemRequest = {
    item_name: nome ?? '',
    description: descricao ?? '',
    description_type: 'normal',
    original_price: preco ?? 0,
    weight: peso ?? 0,
    category_id: categoryId ?? 0,
    image,
    logistic_info: logistica.logistic_info,
    item_status: args.statusPedido,
    condition,
    ...(dimensao !== null ? { dimension: dimensao } : {}),
    ...(atributoLista.length > 0 ? { attribute_list: atributoLista } : {}),
    ...(brand !== undefined ? { brand } : {}),
    // ⚠️ OMITTED when absent, never `''`: an empty string DELETES the seller's
    // own parent SKU (`guide 221 §5`).
    ...(sku !== null ? { item_sku: sku } : {}),
    // ⚠️ Same rule: a placeholder GTIN on an update would OVERWRITE one the
    // operator set in Seller Centre.
    ...(gtin !== null ? { gtin_code: gtin } : {}),
    // ⚠️ Never a `location_id` — the stock STRUCTURE is immutable per item
    // (`error_param: Can not update item with different stock structure`).
    seller_stock: sellerStock,
    pre_order: preOrderParaPublicar(produto.crossdocking, limites, logistica.canaisHabilitados),
    // ⚠️ The KEY is absent under the omit arm — never `null`, never partial.
    ...(taxInfo !== null ? { tax_info: taxInfo } : {}),
    // ⚠️ Absent when nothing matched — never a `0` / `''` detach sentinel.
    ...(sizeChartInfo !== null ? { size_chart_info: sizeChartInfo } : {}),
  };

  const itemId = numeroPositivo(link?.item_id);
  const atualizar: ShopeeUpdateItemRequest | null =
    itemId === null
      ? null
      : {
          item_id: itemId,
          // ⚠️ No `item_status` (a pause is the operator's), no `original_price`
          // and no `seller_stock` (steps 12/13), and no `pre_order` — the page
          // declares none.
          ...(nome !== null ? { item_name: nome } : {}),
          ...(descricao !== null ? { description: descricao, description_type: 'normal' } : {}),
          ...(categoryId !== null ? { category_id: categoryId } : {}),
          ...(peso !== null ? { weight: peso } : {}),
          ...(dimensao !== null ? { dimension: dimensao } : {}),
          // The three FULL lists — correct whether or not they replace wholesale.
          image,
          ...(atributoLista.length > 0 ? { attribute_list: atributoLista } : {}),
          logistic_info: logistica.logistic_info,
          ...(brand !== undefined ? { brand } : {}),
          condition,
          ...(sku !== null ? { item_sku: sku } : {}),
          ...(gtin !== null ? { gtin_code: gtin } : {}),
          ...(taxInfo !== null ? { tax_info: taxInfo } : {}),
          // The SAME pick as the create (Q3): an update re-sends the ERP's
          // chart, and an absent key keeps Seller Centre's.
          ...(sizeChartInfo !== null ? { size_chart_info: sizeChartInfo } : {}),
        };

  return { criar, atualizar, problemas, tabelaDeMedidas };
}
