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
 * the operator's Seller Centre choices. They WIN over the ERP produto, blank
 * meaning absent — the `publishCore.ts:1200-1209` rule for Mercado Livre,
 * adopted verbatim and for the same measured reason (#799 bug 4a: without it an
 * operator can never give a listing a marketplace-optimised name of its own).
 * The produto is the fallback, which is what a first publish uses.
 *
 * ## The vocabulary this file PRODUCES (eighteen of the twenty-two)
 *
 * `sem-nome`, `nome-fora-da-faixa`, `sem-descricao`, `descricao-fora-da-faixa`,
 * `sem-preco`, `filho-sem-preco`, `preco-fora-da-faixa`, `sem-peso`,
 * `sem-dimensoes`, `sem-fotos`, `sem-gtin`, `categoria-invalida`,
 * `atributo-obrigatorio`, `marca-sem-nome`, `estoque-abaixo-do-minimo`,
 * `listagem-removida`, `produto-e-filho`, `produto-e-kit`.
 *
 * The other four are produced ELSEWHERE and are listed here so a reader does not
 * hunt for them in this file: `variacao-sem-vinculo`, `combinacao-duplicada` and
 * `opcoes-demais` are `anuncios/tiersPublicacao.ts`'s; `logistica-sem-canal` is
 * `anuncios/logisticaPublicacao.ts`'s, and this module RELAYS that module's
 * `problemas[]` rather than re-deciding it. The three wire-rejection-only motivos
 * (`bloqueado-por-promocao`, `imposto-recusado`, `desconhecido`) are
 * `anuncios/problemasPublicacao.ts`'s and cannot be reached by reading a produto.
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
 */
import {
  type ShopeeAddItemRequest,
  type ShopeeAttributeRequest,
  type ShopeeAttributeValueRequest,
  type ShopeeCondition,
  type ShopeeDimensionRequest,
  type ShopeeItemStatusWritable,
  type ShopeeLogisticInfoRequest,
  type ShopeePreOrderRequest,
  type ShopeeSellerStockRequest,
  type ShopeeTaxInfoRequest,
  type ShopeeUpdateItemRequest,
  SHOPEE_CONDITION,
  SHOPEE_ITEM_IMAGE_MAX,
} from '@delfrance/integrations-shopee';
import {
  type ComponentesKit,
  type EstadoAnuncioShopee,
  type Foto,
  ESTADO_ANUNCIO_SHOPEE,
  kitEstoqueDisponivel,
} from '@delfrance/schemas';

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

/* -------------------------------------------------------------------------- */
/*                                   Inputs                                   */
/* -------------------------------------------------------------------------- */

/**
 * The produto graph, projected to exactly what the ITEM payload reads.
 *
 * ⚠️ `ehKit` and `ehKitVirtual` are NOT two spellings of one thing and this
 * module treats them oppositely. `ehKit` is a Shopee KIT (`add_kit_item`), which
 * is step 19 — refused here as `produto-e-kit` so a kit is never published as if
 * it were a plain produto. `ehKitVirtual` is an ERP produto whose stock DERIVES
 * from its components and which publishes as an ordinary listing; its only
 * consequence here is that {@link quantidadeParaPublicarShopee} takes the kit
 * branch. Keying the refusal on both would make every component-stocked produto
 * unpublishable.
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
  /** The throwaway item-level stock of a has-model CREATE (O3). */
  readonly estoqueDoPrimeiroFilho: number | null;
  /** This produto's own available stock at the conta's depósito. */
  readonly ownDisponivel: number;
  /** Component produto id → its available stock, for the kit branch. */
  readonly disponivelByProdutoId: Record<string, number | null | undefined>;
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

/** A usable text value: trimmed and non-empty. Blank means ABSENT everywhere here. */
function textoUtilizavel(valor: string | null | undefined): string | null {
  if (typeof valor !== 'string') return null;
  const limpo = valor.trim();
  return limpo.length > 0 ? limpo : null;
}

/** A usable positive number. `0`, a negative and a non-finite all read as absent. */
function numeroPositivo(valor: number | null | undefined): number | null {
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) return null;
  return valor;
}

/**
 * Whether `valor` sits inside `banda`.
 *
 * An absent band, or an absent end of one, is NO BOUND — Shopee's limit pages
 * leave ends `null` when the category states none, and treating that as `0`
 * would refuse every description on a category that declares no maximum.
 */
function dentroDaFaixa(valor: number, banda: FaixaDto | null | undefined): boolean {
  if (banda == null) return true;
  if (banda.min !== null && valor < banda.min) return false;
  if (banda.max !== null && valor > banda.max) return false;
  return true;
}

/** A band's lower bound as a number, `0` when the category states none. */
function minimoDaFaixa(banda: FaixaDto | null | undefined): number {
  if (banda == null || banda.min === null || !Number.isFinite(banda.min)) return 0;
  return banda.min;
}

/** A human description of a band, for a problema's `mensagem`. */
function descreverFaixa(banda: FaixaDto | null | undefined): string {
  if (banda == null) return 'sem faixa informada';
  const min = banda.min === null ? '—' : String(banda.min);
  const max = banda.max === null ? '—' : String(banda.max);
  return `${min}..${max}`;
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

/** One stored attribute entry, read tolerantly — the link stores them as `unknown`. */
function lerValorArmazenado(bruto: unknown): ShopeeAttributeValueRequest | null {
  if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) return null;
  const linha = bruto as Record<string, unknown>;
  const valueId = linha.value_id;
  if (typeof valueId !== 'number' || !Number.isInteger(valueId) || valueId < 0) return null;
  const nome = textoUtilizavel(linha.original_value_name as string | null | undefined);
  const unidade = textoUtilizavel(linha.value_unit as string | null | undefined);
  // `0` is the CUSTOM sentinel (`guide 211 §2.2`) and then the name is REQUIRED:
  // a custom value with no name is a value Shopee refuses, so it is dropped here
  // and the attribute may end up missing — which is how it reaches
  // `atributo-obrigatorio` instead of a wire rejection.
  if (valueId === 0 && nome === null) return null;
  return {
    value_id: valueId,
    ...(valueId === 0 && nome !== null ? { original_value_name: nome } : {}),
    ...(unidade !== null ? { value_unit: unidade } : {}),
  };
}

/**
 * `attribute_list` from the stored attributes, plus the mandatory set it misses.
 *
 * The ERP models no Shopee attribute of its own, so the stored list — the last
 * read-back of the live listing, or what the operator filled in Seller Centre —
 * is the ONLY source there is. Entries with no usable values are dropped rather
 * than sent empty: Shopee reads an empty `attribute_value_list` as a deletion.
 *
 * ⚠️ `variation_id != 0 ⇒ never send variation_name` is the TIER rule
 * (`announcement 873`) and has nothing to do with attributes. It lives in
 * `tiersPublicacao.ts`.
 */
export function atributosParaPublicar(
  armazenados: readonly unknown[] | null,
  projetados: AtributosProjetados,
): { readonly lista: readonly ShopeeAttributeRequest[]; readonly faltando: readonly string[] } {
  const lista: ShopeeAttributeRequest[] = [];
  const vistos = new Set<number>();
  for (const bruto of armazenados ?? []) {
    if (typeof bruto !== 'object' || bruto === null || Array.isArray(bruto)) continue;
    const linha = bruto as Record<string, unknown>;
    const id = linha.attribute_id;
    if (typeof id !== 'number' || !Number.isInteger(id)) continue;
    const brutos = Array.isArray(linha.attribute_value_list) ? linha.attribute_value_list : [];
    const valores: ShopeeAttributeValueRequest[] = [];
    for (const valor of brutos) {
      const lido = lerValorArmazenado(valor);
      if (lido !== null) valores.push(lido);
    }
    if (valores.length === 0) continue;
    if (vistos.has(id)) continue;
    vistos.add(id);
    lista.push({ attribute_id: id, attribute_value_list: valores });
  }

  const faltando: string[] = [];
  for (const atributo of projetados.atributos) {
    if (!atributo.mandatory) continue;
    if (vistos.has(atributo.attributeId)) continue;
    faltando.push(atributo.name ?? `#${String(atributo.attributeId)}`);
  }

  return { lista, faltando };
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
  if (!dentroDaFaixa(dias, dts?.daysToShipLimit)) return negado;
  return { is_pre_order: true, days_to_ship: dias };
}

/**
 * The kit-aware quantity, floored and clamped DOWN — never up.
 *
 * ```
 * disponivel = (ehKit || ehKitVirtual)
 *   ? (kitEstoqueDisponivel(componentesKit, disponivelByProdutoId) ?? ownDisponivel)
 *   : ownDisponivel
 * ```
 *
 * ⚠️ **It never raises a quantity to the band's minimum**, and that is the whole
 * point (O3). The shop's `stock_limit.min_limit` was measured at **2** on
 * 2026-09-17 and Shopee refused a create at `1` outright; clamping UP would
 * publish an availability the operator never authorised, and overselling across
 * channels is unrecoverable. Below the minimum, {@link montarAnuncio} raises
 * `estoque-abaixo-do-minimo` naming the band instead. The band's MAXIMUM is
 * clamped, because there the safe direction is down.
 *
 * ⚠️ Two deliberate divergences from Mercado Livre's `quantidadeParaEnvio`, both
 * because that function lives in an APP and reads ML-scoped environment this app
 * must not inherit: **no own-stock hook** (there is no
 * `MERCADO_LIVRE_STOCK_KIT_INCLUI_PROPRIO` here and step 11 adds no env var), and
 * **no virtual-kit skip** — `seller_stock` is REQUIRED per model on
 * `init_tier_variation` / `add_model`, so "do not send a quantity" is not
 * expressible on this wire.
 */
export function quantidadeParaPublicarShopee(args: {
  readonly ehKit: boolean;
  readonly ehKitVirtual: boolean;
  readonly componentesKit: ComponentesKit | null;
  readonly ownDisponivel: number;
  readonly disponivelByProdutoId: Record<string, number | null | undefined>;
  readonly banda: FaixaDto | null;
}): number {
  const proprio = Number.isFinite(args.ownDisponivel) ? args.ownDisponivel : 0;
  let disponivel: number;
  if (args.ehKit || args.ehKitVirtual) {
    const min = kitEstoqueDisponivel(args.componentesKit, args.disponivelByProdutoId);
    disponivel = min ?? proprio;
  } else {
    disponivel = proprio;
  }
  const inteiro = Math.max(Math.floor(disponivel), 0);
  const max = args.banda?.max;
  if (typeof max === 'number' && Number.isFinite(max)) return Math.min(inteiro, max);
  return inteiro;
}

/* -------------------------------------------------------------------------- */
/*                                 The mapper                                 */
/* -------------------------------------------------------------------------- */

/**
 * Build both bodies and every refusal the produto graph can produce.
 *
 * Field sources, the stored link winning where it has one, are in the module
 * docblock; the refusal set is the eighteen members listed there. Nothing here
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
  if (produto.ehKit) {
    problemas.push(
      problema(
        null,
        MOTIVO_PUBLICACAO_BLOQUEADA.produtoEKit,
        'o produto é um kit — publicar kit na Shopee é outro passo (add_kit_item)',
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

  const nome = textoUtilizavel(link?.item_name) ?? textoUtilizavel(produto.nome);
  if (nome === null) {
    problemas.push(
      problema('item_name', MOTIVO_PUBLICACAO_BLOQUEADA.semNome, 'o produto não tem nome'),
    );
  } else if (!dentroDaFaixa(nome.length, bandas.itemNameLengthLimit)) {
    problemas.push(
      problema(
        'item_name',
        MOTIVO_PUBLICACAO_BLOQUEADA.nomeForaDaFaixa,
        `o nome tem ${String(nome.length)} caracteres, fora da faixa da categoria ` +
          `(${descreverFaixa(bandas.itemNameLengthLimit)}) — nunca truncado`,
      ),
    );
  }

  /* ------------------------------ description ----------------------------- */

  const descricao = textoUtilizavel(link?.description) ?? textoUtilizavel(args.descricao);
  if (descricao === null) {
    problemas.push(
      problema(
        'description',
        MOTIVO_PUBLICACAO_BLOQUEADA.semDescricao,
        'o produto não tem descrição',
      ),
    );
  } else if (!dentroDaFaixa(descricao.length, bandas.itemDescriptionLengthLimit)) {
    problemas.push(
      problema(
        'description',
        MOTIVO_PUBLICACAO_BLOQUEADA.descricaoForaDaFaixa,
        `a descrição tem ${String(descricao.length)} caracteres, fora da faixa da categoria ` +
          `(${descreverFaixa(bandas.itemDescriptionLengthLimit)})`,
      ),
    );
  }

  /* ------------------------------- category ------------------------------- */

  const categoryId = link?.category_id ?? args.categoryId;
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

  const gtin = textoUtilizavel(produto.gtin);
  const regraGtin = textoUtilizavel(limites.gtinLimit?.gtinValidationRule);
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
  const nomeDaMarca = textoUtilizavel(args.marca.nome);
  let brand: ShopeeAddItemRequest['brand'];
  if (brandId === 0) {
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

  const tabela = args.tabelaNormalId;
  const precoProprio =
    tabela === null ? null : numeroPositivo(produto.precos?.[tabela]?.valor ?? null);
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
      problemas.push(
        args.temFilhos
          ? problema(
              'original_price',
              MOTIVO_PUBLICACAO_BLOQUEADA.filhoSemPreco,
              'o primeiro filho não tem preço na tabela normal — é dele que sai o preço ' +
                'descartável do item',
            )
          : problema(
              'original_price',
              MOTIVO_PUBLICACAO_BLOQUEADA.semPreco,
              'o produto não tem preço na tabela normal da conta',
            ),
      );
    } else if (!dentroDaFaixa(preco, bandas.priceLimit)) {
      problemas.push(
        problema(
          'original_price',
          MOTIVO_PUBLICACAO_BLOQUEADA.precoForaDaFaixa,
          `o preço ${String(preco)} está fora da faixa da categoria ` +
            `(${descreverFaixa(bandas.priceLimit)})`,
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
            `(${descreverFaixa(banda)}) — a Shopee recusa a criação e o estoque nunca ` +
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
  const sku = textoUtilizavel(produto.sku);
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
        };

  return { criar, atualizar, problemas };
}
