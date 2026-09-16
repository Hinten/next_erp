/**
 * **The pure mapper** of the Shopee listing import (#1517, step 9): one listing
 * (and one model of it) → the produto fields, the extraData fields, the price
 * and stock verdicts, and the two link documents.
 *
 * Pure by construction — no Firestore, no wire call, no ambient clock read
 * (`nowMs` is a parameter) and nothing from the Next runtime, so the Cloud
 * Functions bundle reaches it. Everything it needs about what the ERP already
 * holds arrives as an argument, so every rule below is testable with a literal.
 *
 * ## The fill rule, copied VERBATIM from Mercado Livre
 *
 * `apps/mercado-livre/lib/marketplace/importacao/importCore.ts:318-335`, three
 * clauses and no fourth:
 *
 *  1. a **blank** stored value always takes the incoming one;
 *  2. a **filled** stored value is replaced only under `sobrescrever`;
 *  3. a **`null` incoming** value never lands, on either branch — *Shopee not
 *     reporting a field is not an instruction to erase the ERP's copy of it.*
 *
 * `sobrescrever` is derived ONCE (`atualizarProdutoPai && sobrescreverDadosProduto`)
 * rather than `&&`-ed at each use: ML's two sites drifted, and the one that had
 * escaped the gate was the one that clobbered the field the publish path derives
 * from.
 *
 * ## The carve-out is a LIST, and the list is asserted
 *
 * {@link CAMPOS_SOBRESCREVER_DADOS_PRODUTO} is exactly ML's
 * (`importCore.ts:74-87`): `sku`, the five weight/dimension fields, and
 * `extraData.marca`. It deliberately does NOT cover `descricao` (the most
 * destructive thing to clobber, and nobody asked for it), `publicado` (never
 * re-expose a produto the operator hid), `categoriaProdutoOuterRef` (gated by
 * `importarCategorias` and fill-blank only), or `nome`/`ehKit`/`ehUsado`
 * (create-only).
 *
 * ⚠️ `gtin` is NOT in the carve-out and is NOT in ML's list — ML has no gtin
 * writer at all. Here it is **fill-blank only**. Said out loud so nobody
 * "completes" the list later; widening it is a decision about someone's typed
 * data, not a refactor, and `mapeamento.test.ts` pins the list with a `toEqual`.
 *
 * ## ⚠️ The promotional price table is NEVER written
 *
 * The Shopee legacy read BOTH tables off the conta and sent `current_price` to
 * the promotional one whenever it was lower than `original_price`. That arm is
 * **REJECTED** (Lucas's decision, 2026-09-16; Mercado Livre's owner decision
 * #803 took the identical stance on 2026-08-06): `tabelaPromocionalOuterRef`
 * belongs to promotions the operator authors in the ERP — `RecalcularPrecosCanalAction`
 * already offers it as a formula-recalculation target — so a Shopee deal must
 * not land in it. The import writes `original_price ?? current_price` to the
 * conta's NORMAL table and nothing else; there is no promotional branch in this
 * module and re-adding one is a decision, not a fix.
 *
 * ## ⚠️ Units and clocks
 *
 * `weight` is a STRING in KG, `dimension` is in CM, both `price_info` and
 * `stock_info_v2` are per-model when the listing has models, and Shopee's
 * `create_time`/`update_time` are wire SECONDS that this module never reads and
 * never stores. Every stamp written here is MILLISECONDS, from `nowMs`. No
 * microsecond helper appears anywhere under `produtos/`.
 */
import type {
  ShopeeItemBaseInfoRow,
  ShopeeModel,
  ShopeePriceInfo,
  ShopeeStockInfoV2,
  ShopeeTierVariation,
} from '@delfrance/integrations-shopee';
import {
  CONDICAO_PRODUTO,
  reservaEfetiva,
  makeEstoqueUid,
  SHOPEE_ITEM_STATUS,
  SHOPEE_MODEL_STATUS,
  idFromRef,
  toOuterRef,
  type ImportacaoShopeeOptions,
  type ShopeeItemStatus,
  type ShopeeModelStatus,
} from '@delfrance/schemas';

import { EIXOS_PACOTE_SHOPEE, type EixoDePacoteProduto } from './eixos';
import { descricaoDe, itemStatusDe, type ItemLido } from './itemLido';
import { idProdutoFilhoShopee, idProdutoPaiShopee } from './produtoIds';

/* -------------------------------------------------------------------------- */
/*  Caps and sentinels — every one matched to the SCHEMA that enforces it      */
/* -------------------------------------------------------------------------- */

/** `produtoSchema.nome` is `string().min(1).max(100)`. */
export const PRODUTO_NOME_MAX = 100;
/** `produtoSchema.sku` / `.gtin` are `string().max(255)`. */
export const PRODUTO_TEXTO_MAX = 255;
/** `produtoExtraDataSchema.descricao` is `string().max(3000)`. */
export const DESCRICAO_MAX = 3000;
/** `produtoExtraDataSchema.marca` is `string().max(255)`. */
export const MARCA_MAX = 255;
/** `precoSchema.valor` is `number().min(0.01)` — a smaller value THROWS at parse time. */
export const PRECO_MINIMO = 0.01;

/**
 * The only currency this import keeps a price for.
 *
 * ⚠️ Matched EXACTLY, uppercase. Shopee sends `"BRL"`; accepting `"brl"` would
 * mean accepting a spelling nobody has ever observed, and the sandbox shop
 * (SGD) is the live proof that a non-matching currency is a normal answer, not
 * an error.
 */
export const MOEDA_IMPORTADA = 'BRL';

/** Shopee's documented "item without GTIN" sentinel — a STRING, never a number. */
export const GTIN_SEM_CODIGO = '00';

/**
 * The exact two-member "no brand" set, after trim + lowercase.
 *
 * ⚠️ No space-stripping and no diacritic-stripping: `'No Brand Shoes'`,
 * `'Nobrandia'` and `'Nob Rand'` are real brands and must survive.
 */
export const MARCAS_SEM_MARCA: ReadonlySet<string> = new Set(['no brand', 'nobrand']);

/**
 * `condition` values that mean "used", after trim + lowercase.
 *
 * Shopee documents the fold itself: *"USED、Used and used will be mapped to
 * Used"*. Exact membership, never `includes` — `'USED-LIKE-NEW'` and
 * `'unused'` are NOT used.
 */
const CONDICAO_USADA = 'used';

/**
 * The fields `sobrescreverDadosProduto` may REPLACE on a re-import — exactly
 * Mercado Livre's list (`importCore.ts:74-87`), verbatim.
 *
 * ⚠️ `'extraData.marca'` is spelled with its document prefix because it lives on
 * the `produtos/{id}/extraData/singleton` doc, not on the produto: the list is
 * the operator-facing contract of one checkbox, and a bare `marca` would read as
 * a produto field that does not exist.
 *
 * Pinned by a `toEqual` so adding a field is a reviewed act.
 */
export const CAMPOS_SOBRESCREVER_DADOS_PRODUTO = [
  'sku',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
  'extraData.marca',
] as const;

/* -------------------------------------------------------------------------- */
/*  Field-level readers (the folds, each with an equal pair and a near-miss)   */
/* -------------------------------------------------------------------------- */

function textoOuNulo(bruto: string | null | undefined, max: number): string | null {
  const t = bruto?.trim() ?? '';
  return t.length > 0 ? t.slice(0, max) : null;
}

/**
 * `gtin_code` → `produto.gtin`.
 *
 * ⚠️ `'00'` is Shopee's documented "item without GTIN" and is the ONLY value
 * folded away. `'0'`, `'000'` and `'0012345678905'` are KEPT — a numeric read
 * (`Number(gtin) === 0`) would swallow all three, and the leading zeros of a
 * real GTIN are meaningful.
 */
export function gtinDe(bruto: string | null | undefined): string | null {
  const t = textoOuNulo(bruto, PRODUTO_TEXTO_MAX);
  return t === GTIN_SEM_CODIGO ? null : t;
}

/**
 * `weight` (a STRING in KG) → a number of kilograms.
 *
 * ⚠️ **No default.** A listing whose seller never set a weight has none, and
 * inventing one would publish a freight quote nobody measured. Non-finite,
 * zero and negative all answer `null`.
 *
 * ⚠️ A comma decimal (`'1,1'`) answers `null` and must never reach the ERP's
 * shared pt-BR decimal reader: this is a documented dot-decimal WIRE field, not
 * operator input, so a comma means the value is not what the page says it is —
 * and "guess the seller meant 1.1" is how an import invents a measurement.
 * (Naming that reader here, even in a comment, would also earn this module a
 * mandatory equivalence-fold inventory entry for a fold it does not perform —
 * the guard greps raw text.)
 */
export function pesoDe(bruto: string | null | undefined): number | null {
  const t = bruto?.trim() ?? '';
  if (t.length === 0) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The produto's three package-dimension fields, as the mapper writes them. */
export interface DimensoesDoPacote {
  readonly alturaCm: number | null;
  readonly larguraCm: number | null;
  readonly profundidadeCm: number | null;
}

/**
 * Shopee's `dimension` block → the produto's three axes, through the ONE map
 * {@link EIXOS_PACOTE_SHOPEE}.
 *
 * ⚠️ `0` is `null`, not zero: a package 0 cm tall is not the same statement as a
 * package whose height was never set, and `produtoSchema` has no minimum that
 * would catch the difference later.
 */
export function dimensaoDe(
  dimension: { readonly [chave: string]: unknown } | null | undefined,
): DimensoesDoPacote {
  const saida: Record<EixoDePacoteProduto, number | null> = {
    alturaCm: null,
    larguraCm: null,
    profundidadeCm: null,
  };
  // Built by walking the ONE axis map, never by naming the three pairs again:
  // a second hand-written table is exactly what transposed two dimensions in the
  // legacy round trip.
  for (const wire of Object.keys(EIXOS_PACOTE_SHOPEE) as (keyof typeof EIXOS_PACOTE_SHOPEE)[]) {
    const v = dimension?.[wire];
    saida[EIXOS_PACOTE_SHOPEE[wire]] =
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
  }
  return saida;
}

/**
 * `condition` → `produto.ehUsado`.
 *
 * Equal: `'USED'` ≡ `'Used'` ≡ `'used'` ≡ `' used '`. ⛔ Distinct: `'unused'`,
 * `'USED-LIKE-NEW'` and `'NEW'` are all `false` — exact membership after
 * trim+lowercase, never a prefix or an `includes`.
 */
export function ehUsadoDe(condition: string | null | undefined): boolean {
  return (condition?.trim().toLowerCase() ?? '') === CONDICAO_USADA;
}

/**
 * `brand` → `extraData.marca`.
 *
 * ⚠️ `brand_id === 0` is Shopee's documented "No brand" — an ANSWER, not an
 * absence — so it folds to `null` whatever name rides with it. The NAME is
 * folded too, against the exact two-member {@link MARCAS_SEM_MARCA} set, because
 * a shop may carry the sentinel in the name with a non-zero id.
 *
 * Equal: `'No brand'` ≡ `'NoBrand'` ≡ `' no brand '` ⇒ `null`.
 * ⛔ Distinct: `'No Brand Shoes'`, `'Nobrandia'`, `'Nob Rand'` — all real brands.
 */
export function marcaDe(brand: ShopeeItemBaseInfoRow['brand']): string | null {
  if (brand == null) return null;
  if (brand.brand_id === 0) return null;
  const nome = textoOuNulo(brand.original_brand_name, MARCA_MAX);
  if (nome == null) return null;
  return MARCAS_SEM_MARCA.has(nome.toLowerCase()) ? null : nome;
}

/** The listing's description, already capped at the produto's own limit. */
export function descricaoDoProduto(entrada: ItemLido): string | null {
  return textoOuNulo(descricaoDe(entrada), DESCRICAO_MAX);
}

/**
 * `item_status` as the LINK document stores it.
 *
 * ⚠️ An `item_status` Shopee invents tomorrow costs ONE field, never an item: a
 * value outside the six folds to `null` here rather than throwing, because a
 * strict read of a RESPONSE enum would fail a whole catalogue page.
 */
export function itemStatusDeLink(entrada: ItemLido): ShopeeItemStatus | null {
  const bruto = itemStatusDe(entrada);
  const conhecidos: readonly string[] = Object.values(SHOPEE_ITEM_STATUS);
  return bruto != null && conhecidos.includes(bruto) ? (bruto as ShopeeItemStatus) : null;
}

/** `model_status`, folded the same way and for the same reason. */
export function modelStatusDeLink(bruto: string | null | undefined): ShopeeModelStatus | null {
  const conhecidos: readonly string[] = Object.values(SHOPEE_MODEL_STATUS);
  return bruto != null && conhecidos.includes(bruto) ? (bruto as ShopeeModelStatus) : null;
}

/** Is this listing one Shopee has deleted? */
export function ehListagemDeletada(entrada: ItemLido): boolean {
  const s = itemStatusDe(entrada);
  return s === SHOPEE_ITEM_STATUS.sellerDelete || s === SHOPEE_ITEM_STATUS.shopeeDelete;
}

/* -------------------------------------------------------------------------- */
/*  Price and stock verdicts                                                   */
/* -------------------------------------------------------------------------- */

/** Why no price was planned. Persisted nowhere; printed by the CLI and the logs. */
export type MotivoPrecoIgnorado =
  /** The option is off (`importarPreco` on create / `sobrescreverPreco` on update). */
  | 'opcao-desligada'
  /** The conta has no `tabelaNormalOuterRef`; there is nowhere to write. */
  | 'sem-tabela'
  /** A parent that owns children does not sell — its children carry the prices. */
  | 'pai-com-filhos'
  /** `price_info` is absent or empty. */
  | 'sem-price-info'
  /** `price_info` has entries, none of them `BRL` (the SG sandbox's normal answer). */
  | 'moeda-nao-brl'
  /** The BRL entry's price is below `precoSchema`'s `min(0.01)` — writing it would throw. */
  | 'valor-abaixo-do-minimo';

/** Why no stock was planned. */
export type MotivoEstoqueIgnorado =
  | 'opcao-desligada'
  /** The row exists and `sobrescreverEstoque` is off (its default). */
  | 'sem-sobrescrever'
  /** The conta has no `depositoOuterRef`. */
  | 'sem-deposito'
  /** A parent that owns children never carries stock — see {@link ArgsMapearProdutoPai.temFilhos}. */
  | 'pai-com-filhos'
  /** `stock_info_v2` is absent: Shopee made no statement about this listing's stock. */
  | 'sem-stock-info';

/** The BRL price this import would write, or the reason it writes none. */
export interface VeredictoDePreco {
  readonly valor: number | null;
  readonly motivo: MotivoPrecoIgnorado | null;
}

/**
 * The FIRST `price_info[]` entry whose currency is exactly `BRL`, reduced to one
 * number.
 *
 * ⚠️ `original_price` is the shelf price and `current_price` the promotion, so
 * `original_price` WINS whenever it is a usable price — that is the whole point
 * of the rejected promotional arm (see the module header): a lower
 * `current_price` is a deal the operator did not author in the ERP, and it must
 * not become the produto's normal price.
 *
 * ⚠️ **Deviation from the literal `original_price ?? current_price`**, and it is
 * deliberate: Shopee zero-fills, so a listing with no promotion can answer
 * `original_price: 0`, and `??` keeps only `null`/`undefined`. Taken literally
 * the rule would then plan NO price for every un-promoted listing in the
 * catalogue — the exact silent failure this step exists to avoid. So a
 * non-positive `original_price` is treated as **not a price** and
 * `current_price` is read instead. It still cannot import a promotional price
 * over a shelf price, because a shop with a real `original_price` always has a
 * positive one.
 */
export function precoBrlDe(
  precos: readonly ShopeePriceInfo[] | null | undefined,
): VeredictoDePreco {
  if (precos == null || precos.length === 0) return { valor: null, motivo: 'sem-price-info' };
  const entrada = precos.find((p) => p.currency === MOEDA_IMPORTADA);
  if (entrada === undefined) return { valor: null, motivo: 'moeda-nao-brl' };
  const original = entrada.original_price;
  const usavel = typeof original === 'number' && Number.isFinite(original) && original > 0;
  const valor = usavel ? original : entrada.current_price;
  if (typeof valor !== 'number' || !Number.isFinite(valor) || valor < PRECO_MINIMO) {
    return { valor: null, motivo: 'valor-abaixo-do-minimo' };
  }
  return { valor, motivo: null };
}

/**
 * Σ `stock_info_v2.seller_stock[].stock` — the SELLER's own stock, and nothing
 * else.
 *
 * ⚠️ `shopee_stock[]` is never summed: it is what sits in a Shopee warehouse,
 * not what the store holds, and counting it would let the ERP advertise units it
 * cannot pick.
 *
 * An absent `stock_info_v2` answers `null` ("Shopee said nothing"), an empty
 * `seller_stock` answers `0` ("Shopee said none"). The two are different
 * statements and only the second is a quantity.
 */
export function estoqueDoVendedorDe(bloco: ShopeeStockInfoV2 | null | undefined): number | null {
  if (bloco == null) return null;
  const linhas = bloco.seller_stock;
  if (linhas == null) return null;
  let total = 0;
  for (const linha of linhas) {
    if (typeof linha.stock === 'number' && Number.isFinite(linha.stock)) total += linha.stock;
  }
  return total;
}

/* -------------------------------------------------------------------------- */
/*  The parent produto                                                         */
/* -------------------------------------------------------------------------- */

/** An estoque row this import already READ, in the shape the write reuses. */
export interface LinhaEstoqueLida {
  /**
   * ⚠️ The id of the row that was READ, which is NOT necessarily
   * `makeEstoqueUid(...)`: the Shopee legacy created estoque rows at Firestore
   * AUTO ids, so upserting at the canonical id beside a legacy row creates a
   * PHANTOM the operator then sees twice.
   */
  readonly docId: string;
  readonly quantidade: number;
  /** ⚠️ May be NEGATIVE at rest (#931) — always floored through `reservaEfetiva`. */
  readonly quantidadeReservada: number;
}

/** A produto this import already resolved, with the id it lives at. */
export interface ProdutoExistente {
  readonly id: string;
  readonly raw: Record<string, unknown>;
}

export interface ArgsMapearProdutoPai {
  readonly entrada: ItemLido;
  /** `null` ⇒ CREATE, at the deterministic id. */
  readonly existente: ProdutoExistente | null;
  readonly existenteExtraData: Record<string, unknown> | null;
  readonly options: ImportacaoShopeeOptions;
  /** MILLISECONDS, one read per dispatch, handed down. */
  readonly nowMs: number;
  readonly integracaoId: string;
  readonly tabelaNormalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  /** The chain leaf, already resolved and already gated by `importarCategorias`. */
  readonly categoriaOuterRef: string | null;
  /**
   * Does this produto own variation children?
   *
   * ⚠️ TWO inputs, never one: the payload's `has_model` **or** the ERP's own
   * child set. They part company when a seller consolidates a listing, the
   * divergence is permanent and does not self-heal, and a stock row written on a
   * parent that owns children is invisible to every reader while the badge, the
   * pedido line and the print all go stale.
   */
  readonly temFilhos: boolean;
  readonly estoqueExistente: LinhaEstoqueLida | null;
  /**
   * The kit arm's seam (C7): a kit listing's PARENT carries `ehKit: true`, so
   * an order line binds the document that owns the composition instead of
   * hopping to a sole member. Default `false`; `kitShopee.ts` (wave 6) is the
   * only caller that passes `true`, and the kit COMPOSITION itself is that
   * module's, never this one's.
   */
  readonly ehKit?: boolean;
}

/** The stock write this import plans, keyed to the row it read. */
export interface EscritaDeEstoquePlanejada {
  readonly docId: string;
  readonly criar: boolean;
  readonly quantidade: number;
}

export interface MapaProdutoShopee {
  readonly produtoId: string;
  readonly criar: boolean;
  /** The FULL document on create, a merge patch on update. Never empty. */
  readonly patchProduto: Record<string, unknown>;
  readonly patchExtraData: Record<string, unknown> | null;
  /**
   * The normal-table price, or `null`.
   *
   * ⚠️ On CREATE this value is ALSO folded into `patchProduto.precos` — there is
   * nothing to clear on a document that does not exist yet. On UPDATE it is the
   * input to the guarded dotted-path patch, which runs BEFORE the produto merge.
   */
  readonly precos: { readonly tabelaId: string; readonly valor: number } | null;
  readonly precoIgnorado: MotivoPrecoIgnorado | null;
  readonly estoque: EscritaDeEstoquePlanejada | null;
  readonly estoqueIgnorado: MotivoEstoqueIgnorado | null;
}

/** The shared produto-patch builder — the fill rule and nothing else. */
function criarFill(
  patch: Record<string, unknown>,
  existente: Record<string, unknown> | null,
  sobrescrever: boolean,
): (chave: string, valor: unknown) => void {
  return (chave, valor) => {
    const vazio = (existente?.[chave] ?? null) == null;
    if ((vazio || sobrescrever) && valor != null) patch[chave] = valor;
  };
}

/** Fill-blank-OR-EMPTY: a produto created before the taxonomy ran carries `[]`. */
function criarFillArray(
  patch: Record<string, unknown>,
  existente: Record<string, unknown> | null,
): (chave: string, valor: readonly string[] | null) => void {
  return (chave, valor) => {
    const atual = existente?.[chave];
    const vazio = atual == null || (Array.isArray(atual) && atual.length === 0);
    if (vazio && valor != null && valor.length > 0) patch[chave] = [...valor];
  };
}

function planejarPreco(args: {
  readonly criar: boolean;
  readonly options: ImportacaoShopeeOptions;
  readonly tabelaNormalOuterRef: string | null;
  readonly temFilhos: boolean;
  readonly precos: readonly ShopeePriceInfo[] | null | undefined;
}): {
  readonly precos: { readonly tabelaId: string; readonly valor: number } | null;
  readonly motivo: MotivoPrecoIgnorado | null;
} {
  const escrever = args.criar ? args.options.importarPreco : args.options.sobrescreverPreco;
  if (!escrever) return { precos: null, motivo: 'opcao-desligada' };
  // ⚠️ Checked BEFORE `price_info` is read, so the refusal names the real reason:
  // a has_model listing has no `price_info` at all, and reporting "sem-price-info"
  // for it would read as a Shopee gap instead of our own deliberate rule.
  if (args.temFilhos) return { precos: null, motivo: 'pai-com-filhos' };
  if (args.tabelaNormalOuterRef == null) return { precos: null, motivo: 'sem-tabela' };
  const veredicto = precoBrlDe(args.precos);
  if (veredicto.valor == null) return { precos: null, motivo: veredicto.motivo };
  return {
    precos: { tabelaId: idFromRef(args.tabelaNormalOuterRef), valor: veredicto.valor },
    motivo: null,
  };
}

function planejarEstoque(args: {
  readonly options: ImportacaoShopeeOptions;
  readonly depositoOuterRef: string | null;
  readonly temFilhos: boolean;
  readonly produtoId: string;
  readonly bloco: ShopeeStockInfoV2 | null | undefined;
  readonly existente: LinhaEstoqueLida | null;
}): {
  readonly estoque: EscritaDeEstoquePlanejada | null;
  readonly motivo: MotivoEstoqueIgnorado | null;
} {
  if (args.temFilhos) return { estoque: null, motivo: 'pai-com-filhos' };
  const existe = args.existente != null;
  const escrever = existe ? args.options.sobrescreverEstoque : args.options.importarEstoque;
  if (!escrever) return { estoque: null, motivo: existe ? 'sem-sobrescrever' : 'opcao-desligada' };
  if (args.depositoOuterRef == null) return { estoque: null, motivo: 'sem-deposito' };
  const quantidadeShopee = estoqueDoVendedorDe(args.bloco);
  if (quantidadeShopee == null) return { estoque: null, motivo: 'sem-stock-info' };
  // ⚠️ `reservaEfetiva` is load-bearing, not defensive (#931): Shopee reports the
  // BUYABLE count, the ERP stores the TOTAL, and `disponivel = quantidade −
  // reservada`. A stored negative reservation added here would shrink the ERP
  // count below Shopee's on every single re-import — and the value arrives from
  // a bare Admin-SDK read with no Zod and no floor.
  const reservada = args.existente != null ? reservaEfetiva(args.existente.quantidadeReservada) : 0;
  const depositoId = idFromRef(args.depositoOuterRef);
  return {
    estoque: {
      docId: args.existente?.docId ?? makeEstoqueUid(args.produtoId, depositoId),
      criar: !existe,
      quantidade: quantidadeShopee + reservada,
    },
    motivo: null,
  };
}

/**
 * One listing → the PARENT produto's write.
 *
 * ⚠️ Never writes `marketplace`, `marketplaceIds`, `statusProdutosMarketplace`
 * (all three DEAD WEIGHT with no query consumers and no index — `produto.ts`
 * says "Never add a reader"), `integracoesComProduto` (no Shopee link trigger
 * exists; the recorded cost is a missing badge in `/produtos` until steps
 * 11/12), `permiteVendaSemEstoque` (slated for removal),
 * `ofereceFreteGratis` (the legacy derived it from `logistic_info.every(is_free)`
 * and its own exporter rebuilt that block with `is_free: false`, so the value
 * round-trips to a lie) or `tabelaDeMedidasModaUid` (`size_chart` is a URL;
 * size charts are step 18).
 */
export function mapearProdutoPai(args: ArgsMapearProdutoPai): MapaProdutoShopee {
  const { entrada, existente, options, nowMs } = args;
  const base = entrada.base;
  const criar = existente == null;
  const produtoId = existente?.id ?? idProdutoPaiShopee(args.integracaoId, entrada.itemId);
  const existenteRaw = existente?.raw ?? null;

  const nome = textoOuNulo(base.item_name, PRODUTO_NOME_MAX);
  const sku = textoOuNulo(base.item_sku, PRODUTO_TEXTO_MAX);
  const gtin = gtinDe(base.gtin_code);
  const ehUsado = ehUsadoDe(base.condition);
  const peso = pesoDe(base.weight);
  const dims = dimensaoDe(base.dimension);
  const ehKit = args.ehKit ?? false;
  // `crossdocking` is the pre-order handling time and ONLY that: a
  // `days_to_ship` riding a listing that is not pre-order is the ordinary
  // dispatch window, and writing it would tell the ERP every listing is a
  // backorder. Not pre-order ⇒ `null` ⇒ the fill rule writes nothing.
  const crossdocking = base.pre_order?.is_pre_order === true ? base.pre_order.days_to_ship : null;

  const preco = planejarPreco({
    criar,
    options,
    tabelaNormalOuterRef: args.tabelaNormalOuterRef,
    temFilhos: args.temFilhos,
    precos: base.price_info,
  });
  const estoque = planejarEstoque({
    options,
    depositoOuterRef: args.depositoOuterRef,
    temFilhos: args.temFilhos,
    produtoId,
    bloco: base.stock_info_v2,
    existente: args.estoqueExistente,
  });

  let patchProduto: Record<string, unknown>;
  if (criar) {
    patchProduto = {
      nome,
      sku,
      paiId: null,
      publicado: true,
      ehKit,
      ehUsado,
      gtin,
      pesoLiquidoKg: peso,
      pesoBrutoKg: peso,
      alturaCm: dims.alturaCm,
      larguraCm: dims.larguraCm,
      profundidadeCm: dims.profundidadeCm,
      crossdocking,
      // Nothing to clear on a document that does not exist yet.
      precos: preco.precos ? { [preco.precos.tabelaId]: { valor: preco.precos.valor } } : null,
      categoriaProdutoOuterRef: args.categoriaOuterRef,
      timestamp: nowMs,
      ultimaModificacao: nowMs,
    };
  } else {
    const patch: Record<string, unknown> = { ultimaModificacao: nowMs };
    // ⚠️ Derived ONCE. `sobrescreverDadosProduto` is a STRONGER form of "update
    // the produto", so it cannot outlive `atualizarProdutoPai` being withdrawn —
    // and the ML site that drifted was the one that had escaped the gate.
    const sobrescrever = options.atualizarProdutoPai && options.sobrescreverDadosProduto;
    const fill = criarFill(patch, existenteRaw, sobrescrever);
    if (options.atualizarProdutoPai) {
      // The carve-out, in the order of CAMPOS_SOBRESCREVER_DADOS_PRODUTO.
      fill('sku', sku);
      fill('pesoLiquidoKg', peso);
      fill('pesoBrutoKg', peso);
      fill('alturaCm', dims.alturaCm);
      fill('larguraCm', dims.larguraCm);
      fill('profundidadeCm', dims.profundidadeCm);
      // NOT in the carve-out: fill-blank only, whatever `sobrescrever` says.
      const fillCego = criarFill(patch, existenteRaw, false);
      fillCego('gtin', gtin);
      fillCego('crossdocking', crossdocking);
    }
    // Its own gate is `importarCategorias`, applied upstream — never
    // `atualizarProdutoPai` — so it runs even when the produto-field update
    // above is skipped, and it never clobbers a category the operator set.
    criarFill(patch, existenteRaw, false)('categoriaProdutoOuterRef', args.categoriaOuterRef);
    patchProduto = patch;
  }

  // ---- extraData -----------------------------------------------------------
  const patchExtra: Record<string, unknown> = {};
  if (criar) patchExtra.condicao = ehUsado ? CONDICAO_PRODUTO.usado : CONDICAO_PRODUTO.novo;
  const descricao = descricaoDoProduto(entrada);
  if (descricao != null && (args.existenteExtraData?.descricao ?? null) == null) {
    patchExtra.descricao = descricao;
  }
  const marca = marcaDe(base.brand);
  const marcaExistente =
    typeof args.existenteExtraData?.marca === 'string' ? args.existenteExtraData.marca.trim() : '';
  const sobrescreverMarca = options.atualizarProdutoPai && options.sobrescreverDadosProduto;
  if (marca != null && (marcaExistente.length === 0 || sobrescreverMarca)) patchExtra.marca = marca;

  return {
    produtoId,
    criar,
    patchProduto,
    patchExtraData: Object.keys(patchExtra).length > 0 ? patchExtra : null,
    precos: preco.precos,
    precoIgnorado: preco.motivo,
    estoque: estoque.estoque,
    estoqueIgnorado: estoque.motivo,
  };
}

/* -------------------------------------------------------------------------- */
/*  Variation children                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The option names of one model, read from the tier tree BOUNDS-CHECKED.
 *
 * ⚠️ Every index is checked, and an out-of-range one contributes NOTHING rather
 * than throwing or inventing a label. The legacy dereferenced `tier_variation!`
 * unconditionally and asserted the index in a way release builds strip — so the
 * only two possible outcomes there were a correct name and a crash.
 */
export function nomesDasOpcoesDoModelo(
  tiers: readonly ShopeeTierVariation[],
  tierIndex: readonly number[] | null | undefined,
): readonly string[] {
  const nomes: string[] = [];
  for (const [i, idx] of (tierIndex ?? []).entries()) {
    const opcao = tiers[i]?.option_list?.[idx]?.option;
    const t = opcao?.trim() ?? '';
    if (t.length > 0) nomes.push(t);
  }
  return nomes;
}

/** What a child inherits from its parent, so the child mapper stays pure. */
export interface PaiDoFilhoShopee {
  readonly produtoId: string;
  readonly nome: string;
  readonly ehKit: boolean;
  readonly ehUsado: boolean;
  readonly categoriaOuterRef: string | null;
  readonly pesoLiquidoKg: number | null;
  readonly pesoBrutoKg: number | null;
  readonly alturaCm: number | null;
  readonly larguraCm: number | null;
  readonly profundidadeCm: number | null;
}

/** One model's resolved taxonomy, in the two produto wire shapes. */
export interface ComboDoModelo {
  readonly grupoDeVariacoesUid: readonly string[] | null;
  readonly variacoesUid: readonly string[] | null;
}

export interface ArgsMapearFilho {
  readonly entrada: ItemLido;
  readonly modelo: ShopeeModel;
  readonly pai: PaiDoFilhoShopee;
  readonly taxonomia: ComboDoModelo;
  readonly existente: ProdutoExistente | null;
  readonly options: ImportacaoShopeeOptions;
  readonly nowMs: number;
  readonly tabelaNormalOuterRef: string | null;
  readonly depositoOuterRef: string | null;
  readonly estoqueExistente: LinhaEstoqueLida | null;
}

/**
 * One model → one CHILD produto.
 *
 * ⚠️ The child's `sku` is `model_sku` **verbatim**, and a 1-model listing gets
 * NO `-UN` suffix. `SUFIXO_MEMBRO_UNICO` exists because a Mercado Livre
 * User-Products sole member has no sku of its own and copies the parent's; a
 * Shopee model carries its own `model_sku`, and when the seller left it blank
 * the child simply has none, which is honest. Applying the suffix would also
 * make step 11 publish `model_sku: "X-UN"` back to Shopee, silently renaming the
 * seller's own model sku — and `derivarFilhoUnico`/`ehFamiliaDeUm` key on
 * `filhoUnicoId`, never on a sku shape, so the family-of-one machinery works
 * without it.
 *
 * ⚠️ The two `-UN` sku helpers of
 * `packages/schemas/src/produto/pureLogic/familia.ts` must never be called from
 * anywhere under `produtos/` — and they are not spelled out here on purpose:
 * both names are in `equivalence-fold-inventory.test.js`'s word-bounded
 * pattern, which greps RAW TEXT, so even a comment naming them would earn this
 * module a mandatory inventory entry claiming a fold this design deliberately
 * does not perform.
 *
 * ⚠️ Shopee DOES carry per-model prices, unlike Mercado Livre — so a child takes
 * its OWN `price_info`, never a mirror of the parent's map. That is a real
 * divergence from `assembleVariationChildPlan`, not an oversight.
 */
export function mapearFilho(args: ArgsMapearFilho): MapaProdutoShopee {
  const { entrada, modelo, pai, options, nowMs } = args;
  const criar = args.existente == null;
  const produtoId = args.existente?.id ?? idProdutoFilhoShopee(pai.produtoId, modelo.model_id);
  const existenteRaw = args.existente?.raw ?? null;

  const opcoes = nomesDasOpcoesDoModelo(entrada.models?.tier_variation ?? [], modelo.tier_index);
  const sufixo =
    opcoes.length > 0
      ? opcoes.join(' ')
      : (textoOuNulo(modelo.model_sku, PRODUTO_NOME_MAX) ?? String(modelo.model_id));
  const nome = `${pai.nome} ${sufixo}`.slice(0, PRODUTO_NOME_MAX);

  const sku = textoOuNulo(modelo.model_sku, PRODUTO_TEXTO_MAX);
  const gtin = gtinDe(modelo.gtin_code);
  // "If don't set the weight of this model, will use the weight of item by
  // default" — so the ITEM's value is the documented fallback, not a guess.
  const peso = pesoDe(modelo.weight) ?? pai.pesoLiquidoKg;
  const dimsProprias = dimensaoDe(modelo.dimension);
  const dims: DimensoesDoPacote = {
    alturaCm: dimsProprias.alturaCm ?? pai.alturaCm,
    larguraCm: dimsProprias.larguraCm ?? pai.larguraCm,
    profundidadeCm: dimsProprias.profundidadeCm ?? pai.profundidadeCm,
  };

  const preco = planejarPreco({
    criar,
    options,
    tabelaNormalOuterRef: args.tabelaNormalOuterRef,
    temFilhos: false,
    precos: modelo.price_info,
  });
  const estoque = planejarEstoque({
    options,
    depositoOuterRef: args.depositoOuterRef,
    temFilhos: false,
    produtoId,
    bloco: modelo.stock_info_v2,
    existente: args.estoqueExistente,
  });

  let patchProduto: Record<string, unknown>;
  if (criar) {
    patchProduto = {
      nome,
      sku,
      paiId: pai.produtoId,
      publicado: true,
      ehKit: pai.ehKit,
      ehUsado: pai.ehUsado,
      gtin,
      precos: preco.precos ? { [preco.precos.tabelaId]: { valor: preco.precos.valor } } : null,
      grupoDeVariacoesUid: args.taxonomia.grupoDeVariacoesUid
        ? [...args.taxonomia.grupoDeVariacoesUid]
        : null,
      variacoesUid: args.taxonomia.variacoesUid ? [...args.taxonomia.variacoesUid] : null,
      ...(options.atualizarProdutoPai
        ? {
            pesoLiquidoKg: peso,
            pesoBrutoKg: peso,
            alturaCm: dims.alturaCm,
            larguraCm: dims.larguraCm,
            profundidadeCm: dims.profundidadeCm,
            categoriaProdutoOuterRef: pai.categoriaOuterRef,
          }
        : {}),
      timestamp: nowMs,
      ultimaModificacao: nowMs,
    };
  } else {
    const patch: Record<string, unknown> = { ultimaModificacao: nowMs };
    const sobrescrever = options.atualizarProdutoPai && options.sobrescreverDadosProduto;
    const fill = criarFill(patch, existenteRaw, sobrescrever);
    const fillCego = criarFill(patch, existenteRaw, false);
    const fillArray = criarFillArray(patch, existenteRaw);
    fill('sku', sku);
    fillCego('gtin', gtin);
    // Fill-blank-OR-EMPTY: a child created before the taxonomy resolved carries
    // `[]`, not `null`, and `[]` is not the operator's work.
    fillArray('grupoDeVariacoesUid', args.taxonomia.grupoDeVariacoesUid ?? null);
    fillArray('variacoesUid', args.taxonomia.variacoesUid ?? null);
    if (options.atualizarProdutoPai) {
      fill('pesoLiquidoKg', peso);
      fill('pesoBrutoKg', peso);
      fill('alturaCm', dims.alturaCm);
      fill('larguraCm', dims.larguraCm);
      fill('profundidadeCm', dims.profundidadeCm);
      fillCego('categoriaProdutoOuterRef', pai.categoriaOuterRef);
    }
    patchProduto = patch;
  }

  return {
    produtoId,
    criar,
    patchProduto,
    patchExtraData: null,
    precos: preco.precos,
    precoIgnorado: preco.motivo,
    estoque: estoque.estoque,
    estoqueIgnorado: estoque.motivo,
  };
}

/* -------------------------------------------------------------------------- */
/*  The two link documents                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `produtos/{paiId}/prodshopee/{autoId}` — the listing link document, built as a
 * SPREAD of what is stored followed by the stamp of what was just read.
 *
 * ⚠️ The stored corpus is in the **legacy Flutter WRITE shape**, so three
 * containers are renamed on the way in — `attribute_list → attributes`,
 * `wholesales → wholesale`, `brand.brand_id → brand_id` (unwrapped). ⚠️ There is
 * NO fourth rename: the inner wholesale field is `unit_price` on BOTH sides, and
 * re-applying the reported `unit → unit_price` would read the price off a field
 * that does not exist.
 *
 * ⚠️ `attributes` and `logistic_info` are stored **VERBATIM as read**, never
 * re-shaped into the `add_item` request shape: the legacy's re-shape silently
 * LOST every response value the request shape could not express.
 *
 * ⚠️ `contaProdutoShopeeOuterRef` is stamped UNCONDITIONALLY and **after** the
 * spread, so a re-import self-heals a row whose ref drifted. The group queries
 * compare it by exact string equality, so a drifted ref is a link nothing can
 * ever find again.
 *
 * ⚠️ Four fields are NEVER written: `violations` (the banned-item push owns it,
 * and `get_item_violation_info` has a different shape), `complaint_policy`
 * (PL-only, never requested), `sku` (neither schema in `shopeeLink.ts` declares
 * it — writing it would persist an untyped field through `.passthrough()`), and
 * `image`/`image_id_list` (the image ids land where they are useful,
 * `arquivos.externalIds`). A STORED value of any of them rides the spread
 * forward untouched; this builder simply never authors one.
 *
 * ⚠️ `tax_info` is the ONE field stamped conditionally, and the asymmetry is
 * deliberate: every other field here mirrors the listing ("last read wins"),
 * but an absent `tax_info` means the shop is not Brazilian or the block was not
 * requested — not that the listing lost its fiscal data — and `need_tax_info` is
 * always sent, so overwriting a stored block with `null` could only ever destroy
 * information. The values inside are STRINGS, all of them: `"00"` means absent
 * for `ncm`/`cest`, and the leading zeros of `origin`/`csosn`/`icms_cst` are
 * meaningful. A numeric coercion anywhere near this key is a defect.
 */
export function dadosLinkListagem(
  entrada: ItemLido,
  existenteRaw: Record<string, unknown> | null,
  integracaoId: string,
  nowMs: number,
): Record<string, unknown> {
  const base = entrada.base;
  const existente = existenteRaw ?? {};
  return {
    ...existente,
    // ⚠️ AFTER the spread — the self-heal, and the reason this is not a key in
    // the object literal above it.
    contaProdutoShopeeOuterRef: toOuterRef(`integracao/${integracaoId}`),
    item_name: base.item_name,
    item_id: base.item_id,
    category_id: base.category_id,
    // Raw and un-sliced: the produto's own capped copy lives on `extraData`.
    description: base.description,
    description_type: base.description_type,
    description_info: base.description_info,
    attributes: base.attribute_list,
    pre_order: base.pre_order,
    item_status: itemStatusDeLink(entrada),
    logistic_info: base.logistic_info,
    wholesale: base.wholesales,
    brand_id: base.brand?.brand_id ?? null,
    item_dangerous: base.item_dangerous,
    ...(entrada.taxInfo != null ? { tax_info: entrada.taxInfo } : {}),
    ultimaModificacao: nowMs,
    dataCadastro: (existente.dataCadastro as number | undefined) ?? nowMs,
  };
}

/**
 * `produtos/{filhoId}/variashopee/{autoId}` — one model's link document, or
 * `null` when the model cannot have one.
 *
 * ⚠️ **`model_id: 0` is never written**, and the refusal is this function's
 * whole reason to return `null`. `variacaoShopeeLinkSchema.model_id` is a
 * required non-nullable int, so the schema cannot express "absent" — and `0` is
 * Shopee's documented "no model item" sentinel, which the order resolver's
 * highest-priority rung would then match against ANY line of ANY listing. The
 * CHILD produto is still created (the sku and combination rungs can re-find it);
 * only the link is skipped, and the caller counts it in `variacoes.semLink`.
 *
 * ⚠️ `produtoShopeeOuterRef` is the full **LINK document** path
 * (`produtos/<paiId>/prodshopee/<linkId>`), not the parent produto's path. That
 * is why the parent link is written BEFORE the children.
 *
 * ⚠️ `caminhoDoLinkPai` is `null` when the parent link does not exist yet (it is
 * being ADDed at an auto id this very run, so its id is unknowable before the
 * write lands). The key is then **OMITTED**, deliberately: the caller must stamp
 * it from the id the `add` returned, and if it ever forgets,
 * `variacaoShopeeLinkSchema.produtoShopeeOuterRef` is a REQUIRED non-nullable
 * `outerRefSchema`, so the write THROWS. A placeholder path would have been the
 * silent alternative — a link pointing at a document that does not exist.
 *
 * ⚠️ `promotion_id` is NEVER stamped. It became a uint64 in 2026, so a value
 * above 2^53 cannot survive `JSON.parse` and `z.number().int()` would accept the
 * already-corrupted result; it is also volatile promotion state. A stored value
 * rides the spread forward; a fresh document takes the schema's `.default(null)`.
 */
export function dadosLinkVariacao(
  modelo: ShopeeModel,
  caminhoDoLinkPai: string | null,
  existenteRaw: Record<string, unknown> | null,
  integracaoId: string,
): Record<string, unknown> | null {
  if (typeof modelo.model_id !== 'number' || modelo.model_id === 0) return null;
  return {
    ...(existenteRaw ?? {}),
    contaVariacaoShopeeOuterRef: toOuterRef(`integracao/${integracaoId}`),
    ...(caminhoDoLinkPai !== null ? { produtoShopeeOuterRef: toOuterRef(caminhoDoLinkPai) } : {}),
    model_id: modelo.model_id,
    tier_index: [...(modelo.tier_index ?? [])],
    model_status: modelStatusDeLink(modelo.model_status),
  };
}

/** The `produtos/<paiId>/prodshopee/<linkId>` path a `variashopee` points AT. */
export function caminhoDoLinkDaListagem(produtoPaiId: string, linkDocId: string): string {
  return `produtos/${produtoPaiId}/prodshopee/${linkDocId}`;
}
