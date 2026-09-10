/**
 * One Shopee order's lines → the pedido's `ItemDoPedido` rows (#1513, step 5,
 * plan R2).
 *
 * PURE: no Firestore, no wire call, no clock. The produto resolution
 * (`produtoResolve.ts`) and the single clock read are the importer's; this
 * module is handed both. That is what makes the price arithmetic — the part
 * that decides money — testable against a committed wire body instead of a
 * mock.
 *
 * ## The two money documents, and which one wins
 *
 * `get_order_detail` prices the line; `get_escrow_detail` accounts for it. They
 * disagree in three known ways and the escrow is the authority on all three:
 *
 *  - a BUNDLE-DEAL line comes back with `model_discounted_price: 0` on the
 *    detail ("as by design bundle deal discount will not be breakdown to
 *    item/model level"), so the detail prices a whole bundle at nothing;
 *  - only the escrow carries the five DISCOUNTS, per line;
 *  - only the escrow carries `is_kit` / `kit_items` (BR local).
 *
 * ⚠️ **The escrow divisor comes from the escrow.** Nine escrow fields carry the
 * sentence "It returns the subtotal of that specific item if quantity exceeds
 * 1", so `discounted_price` is a LINE TOTAL and has to be divided — by
 * `escrow.quantity_purchased`, never by the detail's
 * `model_quantity_purchased`. A partially-cancelled line makes the two differ,
 * and dividing one document's subtotal by the other's quantity is a silent
 * money error. When they disagree the reading still uses the escrow's and the
 * import logs both.
 */
import { roundReais } from '@delfrance/core/money';
import type { ItemDoPedido } from '@delfrance/schemas';
import type {
  ShopeeEscrowDetail,
  ShopeeEscrowItem,
  ShopeeEscrowKitItem,
  ShopeeOrderDetailRow,
  ShopeeOrderItem,
} from '@delfrance/integrations-shopee';

import { chaveDaLinhaShopee, makeItemEnsureUniqueId, mktplaceIdDe } from './orderIds';
import type { ResolvedShopeeLineProduto } from './produtoResolve';

/**
 * Is `get_order_detail`'s `model_discounted_price` the LINE TOTAL or the UNIT
 * price?
 *
 * ✅ **`false` — the detail price is PER UNIT**, and since 2026-09-09 that is a
 * WIRE FACT, not the safe guess it started as. Lucas's Singapore sandbox order
 * (`__wire__/get_order_detail.qty2-sg.json`) sells quantity 2 of one model:
 *
 *     model_discounted_price 15 × model_quantity_purchased 2
 *       + estimated_shipping_fee 1.99  =  total_amount 31.99
 *
 * A line-total reading would have to answer `15 + 1.99 = 16.99`, and the order
 * says otherwise. `itens.test.ts` drives BOTH readings off that fixture so the
 * pair stays pinned.
 *
 * ⚠️ The literal survives the answer on purpose: it is the named seam, and
 * quantity 1 cannot distinguish the two readings — which is exactly why the
 * sandbox order had to have quantity 2. Flipping it to `true` divides the
 * detail price by `model_quantity_purchased`; the switch value rides on the
 * per-import `console.info` so the first real BR orders re-prove it.
 *
 * ⚠️ Neither Shopee price field carries the "subtotal if quantity exceeds 1"
 * sentence, so do NOT resolve this by analogy with the escrow's nine fields
 * that do.
 */
export const DETALHE_PRECO_E_TOTAL_DA_LINHA = false;

/** Which document answered a line's unit price. */
export type FonteDePreco = 'escrow' | 'detalhe' | 'zero';

/** Named members of {@link FonteDePreco}. */
export const FONTE_DE_PRECO = {
  escrow: 'escrow',
  detalhe: 'detalhe',
  zero: 'zero',
} as const satisfies Record<string, FonteDePreco>;

export interface LeituraDePreco {
  /** The price actually used, per UNIT, rounded. */
  readonly unitario: number;
  /** Which source answered — logged, and carried onto the line diagnostic. */
  readonly fonte: FonteDePreco;
  /** Both readings, for the settle-live log. Never stored. */
  readonly precoDetalhe: number | null;
  readonly precoEscrowUnitario: number | null;
  readonly quantidadeEscrow: number | null;
  readonly quantidadeDetalhe: number | null;
  /** `model_discounted_price === 0` or `activity_type === 'bundle_deal'`. */
  readonly ehBundle: boolean;
}

export interface DescontoDaLinha {
  /** The five escrow discounts ÷ quantity, rounded and CLAMPED at 0. */
  readonly unitario: number;
  /** The same value before the clamp — logged when it was negative. */
  readonly bruto: number;
  /** True when the clamp actually absorbed a negative sum. */
  readonly travado: boolean;
}

export interface DiagnosticoDaLinha {
  readonly ordem: number;
  readonly mktplaceId: string;
  readonly itemId: number;
  readonly modelId: number | null;
  readonly fontePreco: FonteDePreco;
  /** `model_discounted_price === 0` or `activity_type === 'bundle_deal'`. */
  readonly ehBundle: boolean;
  readonly precoZerado: boolean;
  readonly descontoTravado: boolean;
  /**
   * `null` when Shopee sent NONE of the three partial counters — an unknown, not
   * a mismatch. See {@link conferirQuantidades}.
   */
  readonly completa: boolean | null;
  readonly somaQtd: number | null;
  readonly quantidadeComprada: number | null;
  /** The escrow's `quantity_purchased` differed from the detail's. */
  readonly quantidadeDivergenteDoEscrow: boolean;
  /** Two escrow rows shared this line's `(item_id, model_id)` pair. */
  readonly escrowAmbiguo: boolean;
  /** Escrow's `is_kit`. `false` also means "no escrow row", never "not a kit". */
  readonly ehKit: boolean;
  readonly componentesDoKit: number;
  /** Which rung of the cascade answered, or `null` when nothing resolved it. */
  readonly via: ResolvedShopeeLineProduto['via'] | null;
}

export interface ConferenciaDoPedido {
  readonly orderSn: string;
  /** Σ `unitario × quantidade`, rounded. */
  readonly somaDosItens: number;
  /**
   * Σ `descontoUnitario × quantidade`, rounded — a DIAGNOSTIC, and **never the
   * pedido's `descontoTotal`**.
   *
   * ⚠️ The renaming is the fix for a real double-count. Each line already
   * carries its own `descontoUnitario`, and `itemSubtotal`
   * (`packages/schemas/src/pedido/pureLogic/totals.ts`) nets it out of
   * `precoDeVenda` before summing — so this figure is ALREADY inside
   * `Σ itemSubtotal`. The pedido's `descontoTotal` is the ORDER-level slot (the
   * footer's "Desconto", which Mercado Livre fills with `Σ coupon_amount` while
   * writing `descontoUnitario: 0` per line), and
   * `derivePedidoFreteTotals` subtracts it a SECOND time. Writing this value
   * there made `valorCobrado` short by Σ discounts on the operator's first save.
   * See `totais.test.ts`.
   */
  readonly descontoDasLinhas: number;
  /** What the caller computed for freight (W7's `valorCobrado`). */
  readonly freteCobrado: number | null;
  /** `somaDosItens + freteCobrado`, or `null` when the freight is unknown. */
  readonly totalConferido: number | null;
  /** The order's own `total_amount` — `null` before payment. */
  readonly totalDoPedido: number | null;
  /** `totalConferido − totalDoPedido`, or `null` when either side is unknown. */
  readonly diferenca: number | null;
}

export interface ItensMapeadosShopee {
  readonly itens: readonly ItemDoPedido[];
  readonly diagnosticos: readonly DiagnosticoDaLinha[];
  readonly conferencia: ConferenciaDoPedido;
}

export interface MapearItensShopeeArgs {
  /** ONE row of `get_order_detail.response.order_list`. */
  readonly detalhe: ShopeeOrderDetailRow;
  /** The escrow payload, or `null` when the call failed or the order is unpaid. */
  readonly escrow: ShopeeEscrowDetail | null;
  /**
   * The produto resolution per line, keyed by {@link chaveDaLinhaShopee} — i.e.
   * exactly what `criarResolvedorDeLinhasShopee(...).resultados()` returns.
   */
  readonly resolucoes: ReadonlyMap<string, ResolvedShopeeLineProduto>;
  /**
   * The freight the buyer was charged, for the cross-check log only.
   *
   * ⚠️ Passed in rather than read off `detalhe`: Shopee ZERO-FILLS absent
   * numerics (`actual_shipping_fee: 0` on the SG order while the buyer paid
   * 1.99), so the one reader that knows a `0` from an absence lives in W7's
   * `orderFreteMapping.ts`. A second copy here would be the two-files-drifting
   * shape the root `CLAUDE.md` names.
   */
  readonly freteCobrado: number | null;
  /** The importer's ONE clock read, in µs. Never a clock read here. */
  readonly nowUs: number;
  /** Test seam for {@link DETALHE_PRECO_E_TOTAL_DA_LINHA}. Defaults to it. */
  readonly detalhePrecoEhTotalDaLinha?: boolean;
}

/* -------------------------------------------------------------------------- */
/*                                  the mapper                                */
/* -------------------------------------------------------------------------- */

/**
 * Map one order's `item_list` to `ItemDoPedido` rows, with a diagnostic beside
 * each one and a per-order reconciliation the caller logs.
 *
 * Nothing is ever DROPPED: a line whose quantities do not add up, whose price
 * could not be read, or whose produto did not resolve is still mapped and still
 * imported. A pedido that half-exists is worse than one that carries a flagged
 * line — the flags are what the operator and the incidente rows act on.
 *
 * ⚠️ The `itens` RECORD (`Record<produtoUid | 'NONE', ItemDoPedido[]>`) and its
 * `itensIds` projection are built by the write path INSIDE the transaction,
 * after the append-only merge with what is already stored — grouping here would
 * key a stored line under the produto this delivery resolved rather than the one
 * it was stored with. Mercado Livre's `orderPedidoTx.ts` does the same.
 */
export function mapearItensShopee(args: MapearItensShopeeArgs): ItensMapeadosShopee {
  const { detalhe, escrow, resolucoes, freteCobrado, nowUs } = args;
  const totalDaLinha = args.detalhePrecoEhTotalDaLinha ?? DETALHE_PRECO_E_TOTAL_DA_LINHA;
  const orderSn = detalhe.order_sn;

  const fila = filaDeEscrowPorPar(escrow);
  const itens: ItemDoPedido[] = [];
  const diagnosticos: DiagnosticoDaLinha[] = [];
  const linhasDoLog: Record<string, unknown>[] = [];
  let somaDosItens = 0;
  let descontoDasLinhas = 0;

  const linhas = detalhe.item_list ?? [];
  for (let index = 0; index < linhas.length; index += 1) {
    const linha = linhas[index]!;
    const { escrow: linhaEscrow, ambiguo } = tomarLinhaDeEscrow(fila, linha);

    const preco = precoUnitario(linha, linhaEscrow, totalDaLinha);
    const desconto = descontoUnitario(linhaEscrow);
    const quantidade = linha.model_quantity_purchased ?? 0;
    const mktplaceId = mktplaceIdDe(linha);
    const resolvido = resolucoes.get(chaveDaLinhaShopee(linha.item_id, linha.model_id)) ?? null;
    const conferencia = conferirQuantidades(linha);

    itens.push({
      produtoUid: resolvido?.produtoId ?? null,
      ordem: index,
      ensureUniqueId: makeItemEnsureUniqueId(orderSn, mktplaceId, index),
      mktplaceId,
      // ⛔ VERBATIM, and `naoVazio` deliberately does not trim: this field is a
      // denormalised snapshot that OUTLIVES the resolution — `generator-input.ts`
      // makes it the NF-e `cProd` and the picking sheet falls back to it. Mercado
      // Livre carries the same ⛔ for the same reason.
      sku: naoVazio(linha.model_sku) ?? naoVazio(linha.item_sku) ?? null,
      gtin: null,
      // ⚠️ Not `item_name + ' ' + model_name`: a non-variation item sends
      // `model_name: ''`, and the naive form stores a trailing space that then
      // reaches the NF-e `xProd` and the picking sheet.
      nomeDeVenda: [linha.item_name, linha.model_name].filter(naoVazioPredicado).join(' ') || null,
      precoDeVenda: roundReais(preco.unitario + desconto.unitario),
      descontoUnitario: desconto.unitario,
      // ⚠️ `model_quantity_purchased` VERBATIM — never the
      // `active + cancelled + returned` sum, which is the GUARD below, not the
      // value. It is also what the escrow's `quantity_purchased` divides by.
      quantidade,
      custo: null,
      timestamp: nowUs,
      imposto: null,
    });

    diagnosticos.push({
      ordem: index,
      mktplaceId,
      itemId: linha.item_id,
      modelId: linha.model_id ?? null,
      fontePreco: preco.fonte,
      ehBundle: preco.ehBundle,
      precoZerado: preco.fonte === FONTE_DE_PRECO.zero,
      descontoTravado: desconto.travado,
      completa: conferencia.completa,
      somaQtd: conferencia.somaQtd,
      quantidadeComprada: linha.model_quantity_purchased ?? null,
      quantidadeDivergenteDoEscrow:
        preco.quantidadeEscrow != null &&
        preco.quantidadeDetalhe != null &&
        preco.quantidadeEscrow !== preco.quantidadeDetalhe,
      escrowAmbiguo: ambiguo,
      ehKit: ehKitShopee(linhaEscrow),
      componentesDoKit: componentesDoKit(linhaEscrow).length,
      via: resolvido?.via ?? null,
    });

    linhasDoLog.push({
      mktplaceId,
      precoDetalhe: preco.precoDetalhe,
      precoEscrowUnitario: preco.precoEscrowUnitario,
      quantidadeDetalhe: preco.quantidadeDetalhe,
      quantidadeEscrow: preco.quantidadeEscrow,
      fonte: preco.fonte,
      // ⚠️ These three are the ONLY record these flags get. `diagnosticos` is
      // returned in memory and nothing stores it — `importarPedido.ts` reads
      // `itemId`/`modelId`/`via` and discards the rest — so without them here
      // the `kit_items` cardinality question §5 says the first real BR order
      // settles would be answered by nothing (both cardinalities parse
      // silently), and an ambiguous escrow match would be a money guess with no
      // trace at all. Booleans and a count: no PII.
      ehKit: ehKitShopee(linhaEscrow),
      componentesDoKit: componentesDoKit(linhaEscrow).length,
      escrowAmbiguo: ambiguo,
    });

    somaDosItens += preco.unitario * quantidade;
    descontoDasLinhas += desconto.unitario * quantidade;

    if (conferencia.completa === false) {
      console.warn(
        '[shopee/pedidos] linha com quantidades que não fecham — importada assim mesmo',
        {
          orderSn,
          mktplaceId,
          somaQtd: conferencia.somaQtd,
          quantidadeComprada: linha.model_quantity_purchased ?? null,
        },
      );
    }
    if (desconto.travado) {
      console.warn('[shopee/pedidos] desconto negativo travado em 0 — o schema recusaria a linha', {
        orderSn,
        mktplaceId,
        descontoBruto: desconto.bruto,
      });
    }
    if (ambiguo) {
      // ⚠️ `warn`, not `info`: an ambiguous match is a MONEY GUESS. Two escrow
      // rows shared this line's `(item_id, model_id)` with no `line_item_id` to
      // break the tie, so the first row's money was taken. When both lines have
      // the same quantity the order total still reconciles and `diferenca` stays
      // 0 — so the running cross-check cannot see the permutation, and this is
      // the only signal that the attribution was arbitrary.
      console.warn('[shopee/pedidos] linha do escrow AMBÍGUA — preço tomado da primeira', {
        orderSn,
        mktplaceId,
        itemId: linha.item_id,
        modelId: linha.model_id ?? null,
        precoEscrowUnitario: preco.precoEscrowUnitario,
      });
    }
  }

  const soma = roundReais(somaDosItens);
  const totalConferido = freteCobrado == null ? null : roundReais(soma + freteCobrado);
  const totalDoPedido = detalhe.total_amount ?? null;
  const conferencia: ConferenciaDoPedido = {
    orderSn,
    somaDosItens: soma,
    descontoDasLinhas: roundReais(descontoDasLinhas),
    freteCobrado,
    totalConferido,
    totalDoPedido,
    diferenca:
      totalConferido == null || totalDoPedido == null
        ? null
        : roundReais(totalConferido - totalDoPedido),
  };

  // ONE line per import — ids and numbers only, never a name, an address or a
  // document. It carries BOTH price readings per line plus the switch, so the
  // first real BR orders re-prove `DETALHE_PRECO_E_TOTAL_DA_LINHA` instead of
  // inheriting it, and the cross-check says whether the mapped money adds up to
  // what Shopee says the buyer paid.
  // ⚠️ `info`, not `warn`: this line is expected on EVERY healthy order, and a
  // warning nobody can act on is what makes the real ones invisible.
  // eslint-disable-next-line no-console -- see the note above
  console.info('[shopee/pedidos] leitura de preço — item unitário vs total da linha', {
    orderSn,
    interruptorTotalDaLinha: totalDaLinha,
    linhas: linhasDoLog,
    somaDosItens: conferencia.somaDosItens,
    freteCobrado: conferencia.freteCobrado,
    totalConferido: conferencia.totalConferido,
    totalDoPedido: conferencia.totalDoPedido,
    diferenca: conferencia.diferenca,
  });

  return { itens, diagnosticos, conferencia };
}

/* -------------------------------------------------------------------------- */
/*                                   prices                                   */
/* -------------------------------------------------------------------------- */

/** Shopee's `activity_type` for a bundle-deal line. */
const ATIVIDADE_BUNDLE = 'bundle_deal';

/**
 * The unit price for one line, escrow first.
 *
 *  1. **escrow** — `discounted_price ÷ quantity_purchased`, the divisor from the
 *     SAME document. A `quantity_purchased` of `0`/`null` means the escrow
 *     cannot answer, and the line falls through.
 *  2. **bundle with no escrow row** — `0`, flagged. `model_discounted_price` is
 *     `0` on a bundle-deal line by design, so the detail fallback would price
 *     the whole line at nothing while claiming the detail said so. A zero price
 *     is storable (`precoDeVenda: z.number().min(0)`, floor 0 deliberately,
 *     #794) and a parked delivery is not.
 *  3. **detail** — `model_discounted_price`, read per unit under
 *     {@link DETALHE_PRECO_E_TOTAL_DA_LINHA} `=== false`, divided by
 *     `model_quantity_purchased` when the literal is flipped.
 *  4. nothing at all — `0`, flagged.
 */
export function precoUnitario(
  item: ShopeeOrderItem,
  escrow: ShopeeEscrowItem | null,
  totalDaLinha: boolean = DETALHE_PRECO_E_TOTAL_DA_LINHA,
): LeituraDePreco {
  const precoDetalhe = item.model_discounted_price ?? null;
  const quantidadeDetalhe = item.model_quantity_purchased ?? null;
  const quantidadeEscrow = escrow?.quantity_purchased ?? null;
  const precoEscrowUnitario =
    escrow != null && escrow.discounted_price != null && quantidadeEscrow != null
      ? quantidadeEscrow > 0
        ? roundReais(escrow.discounted_price / quantidadeEscrow)
        : null
      : null;
  // ⚠️ `activity_type` is a free string (`'' | bundle_deal | add_on_deal`), so
  // it is compared to the documented literal and never truthiness-tested.
  const ehBundle = precoDetalhe === 0 || escrow?.activity_type === ATIVIDADE_BUNDLE;

  const base = { precoDetalhe, precoEscrowUnitario, quantidadeEscrow, quantidadeDetalhe, ehBundle };

  if (precoEscrowUnitario != null) {
    return { ...base, unitario: precoEscrowUnitario, fonte: FONTE_DE_PRECO.escrow };
  }
  if (ehBundle || precoDetalhe == null) {
    return { ...base, unitario: 0, fonte: FONTE_DE_PRECO.zero };
  }
  const unitario =
    totalDaLinha && quantidadeDetalhe != null && quantidadeDetalhe > 0
      ? roundReais(precoDetalhe / quantidadeDetalhe)
      : roundReais(precoDetalhe);
  return { ...base, unitario, fonte: FONTE_DE_PRECO.detalhe };
}

/**
 * The per-unit discount for one line: the FIVE escrow discounts summed and
 * divided by the escrow's own `quantity_purchased`.
 *
 * ⚠️ **The clamp at 0 is not cosmetic.** `itemDoPedidoSchema.descontoUnitario`
 * is `z.number().min(0)`, and escrow money floats are legally negative on this
 * page (its own sample sends `final_shipping_fee: -10`). A negative sum would
 * throw a `ZodError` INSIDE the pedido write, which the notification pipeline
 * reads as transient and retries until it parks — the whole order lost to one
 * sign. Clamped, with the raw sum logged by the caller.
 *
 * No escrow row ⇒ `0`. The detail carries no per-line discount at all, and the
 * legacy's "the fallback price was actually a discount amount" is the recorded
 * defect not to repeat.
 */
export function descontoUnitario(escrow: ShopeeEscrowItem | null): DescontoDaLinha {
  if (escrow == null) return { unitario: 0, bruto: 0, travado: false };
  const soma =
    (escrow.seller_discount ?? 0) +
    (escrow.shopee_discount ?? 0) +
    (escrow.discount_from_coin ?? 0) +
    (escrow.discount_from_voucher_shopee ?? 0) +
    (escrow.discount_from_voucher_seller ?? 0);
  const quantidade = escrow.quantity_purchased ?? null;
  const bruto = roundReais(quantidade != null && quantidade > 0 ? soma / quantidade : soma);
  return { unitario: bruto < 0 ? 0 : bruto, bruto, travado: bruto < 0 };
}

/* -------------------------------------------------------------------------- */
/*                           escrow ⇄ detail matching                          */
/* -------------------------------------------------------------------------- */

/**
 * The escrow's money rows, bucketed by the `(item_id, model_id)` PAIR.
 *
 * ⚠️ The pair, never `item_id` alone — the legacy matched on the item id and a
 * multi-model order gave every line the FIRST row's money. `model_id: 0` and
 * `model_id: null` stay distinct ({@link chaveDaLinhaShopee}).
 *
 * Rows are SHIFTED off their bucket as they are consumed, so one escrow row is
 * never spent twice: two lines of one order that genuinely share a pair (Shopee
 * splits a listing across lines when a promotion covers part of the quantity)
 * take the first and the second row, in order.
 */
function filaDeEscrowPorPar(escrow: ShopeeEscrowDetail | null): Map<string, ShopeeEscrowItem[]> {
  const fila = new Map<string, ShopeeEscrowItem[]>();
  for (const row of escrow?.order_income?.items ?? []) {
    if (row.item_id == null) continue;
    const chave = chaveDaLinhaShopee(row.item_id, row.model_id);
    const bucket = fila.get(chave);
    if (bucket) bucket.push(row);
    else fila.set(chave, [row]);
  }
  return fila;
}

/**
 * Take (and consume) the escrow row for one detail line.
 *
 * When a bucket holds more than one row, `line_item_id` is the tie-break — the
 * only per-line id both documents carry. If that does not decide either, the
 * first unconsumed row wins and the line is FLAGGED rather than silently
 * priced: two indistinguishable rows for one line is a shape nobody has seen,
 * and the flag is what turns a guess into a report.
 */
function tomarLinhaDeEscrow(
  fila: Map<string, ShopeeEscrowItem[]>,
  item: ShopeeOrderItem,
): { escrow: ShopeeEscrowItem | null; ambiguo: boolean } {
  const bucket = fila.get(chaveDaLinhaShopee(item.item_id, item.model_id));
  if (bucket == null || bucket.length === 0) return { escrow: null, ambiguo: false };
  const porLinha =
    item.line_item_id == null
      ? -1
      : bucket.findIndex((row) => row.line_item_id === item.line_item_id);
  const escolhido = porLinha >= 0 ? porLinha : 0;
  const ambiguo = bucket.length > 1 && porLinha < 0;
  const [row] = bucket.splice(escolhido, 1);
  return { escrow: row ?? null, ambiguo };
}

/* -------------------------------------------------------------------------- */
/*                         completeness + the kit arm                          */
/* -------------------------------------------------------------------------- */

/**
 * Does `active + cancelled + returned` add up to what the buyer bought?
 *
 * ⚠️ `cancel_requested_qty` and `return_requested_qty` are DELIBERATELY
 * excluded: "requested" is not "done", and whether `active_qty` already nets
 * them out is undocumented.
 *
 * ⚠️ When Shopee sends NONE of the three counters the answer is `null` —
 * UNKNOWN, not a mismatch. Summing three absences into `0` and comparing it to
 * a real quantity would flag every line of every order that omits them, which
 * is a guard that reports nothing by reporting everything.
 *
 * A mismatch WARNS and flags. It never drops the line and never adjusts the
 * quantity: the value written stays `model_quantity_purchased`, because that is
 * what the escrow's `quantity_purchased` divides by and what the buyer bought.
 */
export function conferirQuantidades(item: ShopeeOrderItem): {
  completa: boolean | null;
  somaQtd: number | null;
} {
  const comprada = item.model_quantity_purchased ?? null;
  const partes = [item.active_qty, item.cancelled_qty, item.returned_qty];
  if (comprada == null || partes.every((q) => q == null)) return { completa: null, somaQtd: null };
  const somaQtd = partes.reduce<number>((soma, q) => soma + (q ?? 0), 0);
  return { completa: somaQtd === comprada, somaQtd };
}

/**
 * The components of a BR-local kit line, normalised object → array.
 *
 * ⚠️ Shopee types `kit_items` as ONE object (singular) and a multi-component kit
 * has no documented shape, so both forms parse and this is the ONE reader. It is
 * a DIAGNOSTIC: nothing here explodes a kit into component lines — the
 * components belong to the ERP kit produto (`componentesKit`), which is the
 * document an operator edits and which `estoquePlan` expands. Exploding them
 * would double-count stock and produce lines with no `prodshopee` link at all.
 */
export function componentesDoKit(escrow: ShopeeEscrowItem | null): readonly ShopeeEscrowKitItem[] {
  const kit = escrow?.kit_items ?? null;
  if (kit == null) return [];
  return Array.isArray(kit) ? kit : [kit];
}

/**
 * Escrow's `is_kit`. `false` also means "no escrow row" — on an UNPAID order
 * there is no escrow at all, so this is never a reason to resolve a line
 * differently; it rides on the diagnostic and the per-import log, which is what
 * settles the `kit_items` cardinality question.
 *
 * ⚠️ `=== true` rather than truthiness is deliberate but NOT load-bearing here,
 * and the test says so: `shopeeEscrowItemSchema` declares `is_kit` as
 * `z.boolean().nullable()`, so a stored `'true'` never reaches this function —
 * it fails the parse. The guard lives in the schema; this spelling only keeps
 * the intent visible if the field is ever widened.
 */
export function ehKitShopee(escrow: ShopeeEscrowItem | null): boolean {
  return escrow?.is_kit === true;
}

/* -------------------------------------------------------------------------- */

/** The value when it is a non-empty string, else `null`. ⚠️ Never trims. */
function naoVazio(v: string | null | undefined): string | null {
  return v != null && v !== '' ? v : null;
}

function naoVazioPredicado(v: string | null | undefined): v is string {
  return naoVazio(v) != null;
}
