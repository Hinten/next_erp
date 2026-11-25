/**
 * The money of ONE Shopee order — what each line states, the order-level
 * discount, the freight, the NF-e total and what the pagamentos must sum to.
 *
 * PURE: no Firestore, no wire call, no clock (the `dinheiroAmazon.ts` shape).
 * `itens.ts` hands it the lines it read, `orderFreteMapping.ts` reads the
 * freight through {@link freteDoPedidoShopee}, `orderMapping.ts` and
 * `pagamentoMapping.ts` consume {@link DinheiroShopee}. One rule, one module.
 *
 * ## The rule (legacy parity — Lucas's decision of 2026-11-24)
 *
 * The NF-e states what the buyer paid: each line at its `discounted_price`
 * (÷ the escrow's own `quantity_purchased`), every buyer-side offset as an NF-e
 * discount, with a floor. The legacy importer did exactly this
 * (`.old/packages/canais_de_venda/shopee/lib/src/tasks.dart:583-603`, the floor
 * at `:464-511, :586-670`); the port had re-added the offsets to the price.
 * Provenance: `pedidos/README.md`, «The order's money».
 *
 * Verified on four real BR orders, to the centavo:
 *
 *     buyer_total_amount = Σ discounted_price
 *                        − Σ (discount_from_voucher_shopee + discount_from_voucher_seller + discount_from_coin)
 *                        + buyer_paid_shipping_fee
 *
 * so `discounted_price` is BEFORE vouchers and coins and AFTER `seller_discount`
 * / `shopee_discount` — those two are never added to the line discount.
 *
 * ## The order level, only when the escrow answers
 *
 * "Answers" ({@link totalDoCompradorShopee}) = `order_income` present with a
 * finite `buyer_paid_shipping_fee` and a POSITIVE `buyer_total_amount` — or a
 * ZERO one on a PAID order whose lines carry money (vouchers and coins covered
 * all of it). So an unpaid order's all-zero escrow never writes a zero
 * anywhere, and an absent freight figure never enters the residual.
 *
 *  - **freight paid** = `buyer_paid_shipping_fee` VERBATIM, `0` included (a free-
 *    shipping order is a real zero once the escrow answers). Without the escrow,
 *    `estimated_shipping_fee` (approximate; the paid re-import corrects it).
 *  - **residual** `r` = Σ line nets + freight paid − `buyer_total_amount`.
 *    `|r| ≤ 0.01` closes; `r > 0.01` is an un-itemized buyer offset (a PIX or
 *    payment promotion) and becomes `descontoTotal`, which the NF-e apportions;
 *    a negative `r` within one centavo PER UNIT is the lines' own per-unit
 *    rounding and closes too; below that it invents nothing: the pagamento
 *    states the NF-e total and the importer files `shp-pagamento-divergente`
 *    (Amazon's rule).
 *  - **floor**: the NF-e goods total never goes below
 *    `max(R$ 5,00, 50 % × Σ original_price, the shipping cost)`. When it binds
 *    the line discounts are scaled down (largest remainder, to the centavo),
 *    then `descontoTotal`, and the NF-e total beyond what the buyer paid toward
 *    it becomes a second pagamento, "Cupom de desconto Shopee" (forma
 *    `outros`), so Σ vPag = vNF. The floor never raises a line above its own
 *    `discounted_price`: when even the undiscounted lines sit below it, the NF-e
 *    states the undiscounted lines.
 *
 * ## Without the escrow (`sem-escrow`)
 *
 * The lines come from whatever the escrow rows (or the detail) gave, no
 * residual, no floor, and the buyer leg is the detail's `total_amount` — what
 * the order says the buyer paid (else the pedido's own total) — never `vNF`
 * itself. That is the pre-2026-11-24 anchor kept on purpose: when the lines are
 * not net of the vouchers, Σ vPag ≠ vNF and the NF-e refuses (cStat 865)
 * instead of stating a pre-voucher value. On a PAID order this money is PROVISIONAL
 * ({@link DinheiroShopee.provisorio}): an update of an existing pedido keeps
 * the stored money and pagamentos (`orderPedidoTx.ts`, `pagamentoTx.ts`).
 *
 * ## The two totals
 *
 *  - {@link totalDaNotaShopee} — what the NF-e states (`vNF`): the shared
 *    `derivePedidoFreteTotals` over the lines and `descontoTotal`, the freight
 *    member ONLY under CIF (the NF-e emits `vFrete` for that modalidade alone).
 *  - `valorDoPedido` — the pedido's `valorCobrado`, the same derive WITH the
 *    freight (what the web recomputes on an operator save, under any modalidade).
 *
 * Once the escrow answers, the pagamentos sum to the first: the buyer leg is
 * `buyer_total_amount` minus the freight it paid unless CIF, plus the cupom leg
 * when the floor binds.
 */
import { centavosDeReais, roundReais } from '@delfrance/core/money';
import {
  MODALIDADE_FRETE,
  derivePedidoFreteTotals,
  flattenPedidoItens,
  itemDoPedidoSchema,
  modalidadeFreteSchema,
  type ItemDoPedido,
  type ModalidadeFrete,
  type Pedido,
} from '@delfrance/schemas';
import type {
  ShopeeEscrowDetail,
  ShopeeEscrowItem,
  ShopeeOrderDetailRow,
} from '@delfrance/integrations-shopee';

import { positivoOuNull, segundosShopeeUtilizaveis } from './orderMapping';

/* -------------------------------------------------------------------------- */
/*                                  constants                                  */
/* -------------------------------------------------------------------------- */

/**
 * The floor's absolute minimum for the NF-e goods total, in reais.
 *
 * ⚠️ With {@link FRACAO_MINIMA_DO_ORIGINAL} and the shipping cost, these are the
 * LEGACY values (`tasks.dart:497-499`, `EXTREME_DISCOUNT_COEFFICIENT = 0.5`),
 * chosen in production after Shopee refused labels on very low NF-e values.
 * Tune them only with evidence.
 */
export const PISO_NFE_MINIMO_REAIS = 5;

/** The floor's share of Σ `original_price` (legacy `EXTREME_DISCOUNT_COEFFICIENT`). */
export const FRACAO_MINIMA_DO_ORIGINAL = 0.5;

/**
 * `|residual|` at or below this closes the order (one centavo of rounding).
 *
 * ⚠️ A NEGATIVE residual closes down to one centavo PER UNIT
 * ({@link toleranciaDeArredondamento}): `precoDeVenda` and `descontoUnitario`
 * are each rounded per unit and multiplied back by the quantity, so a line can
 * sit up to `quantidade` centavos off its own line totals with nothing wrong.
 */
export const TOLERANCIA_RESIDUAL_REAIS = 0.01;

/** `descricaoPagamento` of the cupom leg — the NF-e's `xPag` beside tPag 99. */
export const DESCRICAO_CUPOM_SHOPEE = 'Cupom de desconto Shopee';

/** How the residual closed. */
export type FechamentoDinheiroShopee =
  /** `|r| ≤ 0.01`, or a negative `r` within the per-unit rounding bound. */
  | 'fechado'
  /** `r > 0.01`: an un-itemized buyer offset, stated as `descontoTotal`. */
  | 'desconto-nao-detalhado'
  /** `r` below the rounding bound: the buyer paid MORE than the lines — nothing invented. */
  | 'pago-acima'
  /** The escrow did not answer ({@link totalDoCompradorShopee}): no residual, no floor. */
  | 'sem-escrow';

/** Named members of {@link FechamentoDinheiroShopee}. */
export const FECHAMENTO_DINHEIRO_SHOPEE = {
  fechado: 'fechado',
  descontoNaoDetalhado: 'desconto-nao-detalhado',
  pagoAcima: 'pago-acima',
  semEscrow: 'sem-escrow',
} as const satisfies Record<string, FechamentoDinheiroShopee>;

/** Which document answered the freight the buyer paid. */
export type FonteFreteShopee = 'escrow' | 'estimado' | 'ausente';

/** Named members of {@link FonteFreteShopee}. */
export const FONTE_FRETE_SHOPEE = {
  escrow: 'escrow',
  estimado: 'estimado',
  ausente: 'ausente',
} as const satisfies Record<string, FonteFreteShopee>;

/* -------------------------------------------------------------------------- */
/*                                 the readers                                 */
/* -------------------------------------------------------------------------- */

/**
 * `order_income.buyer_total_amount` when the escrow ANSWERS, else `null` — the
 * one gate of the order level. It answers when `order_income` carries:
 *
 *  - a finite, non-negative `buyer_paid_shipping_fee` — the residual needs the
 *    freight the buyer PAID, and an estimate in its place would become a
 *    fabricated `descontoTotal` (free shipping, estimate 9 ⇒ 9 "un-itemized");
 *  - and a POSITIVE `buyer_total_amount`, or a ZERO one on a PAID order
 *    (usable `pay_time`) whose escrow lines carry money: vouchers and coins
 *    covered all of it, which is exactly the order the floor exists for.
 *
 * ⚠️ So an UNPAID order's all-zero escrow reads as no escrow at all (no usable
 * `pay_time`), while a PAID order at 0 and its 1-centavo near-miss both reach
 * the residual and the floor.
 */
export function totalDoCompradorShopee(
  detalhe: ShopeeOrderDetailRow,
  escrow: ShopeeEscrowDetail | null,
): number | null {
  const renda = escrow?.order_income;
  if (renda == null) return null;
  const fretePago = renda.buyer_paid_shipping_fee;
  if (typeof fretePago !== 'number' || !Number.isFinite(fretePago) || fretePago < 0) return null;
  const total = positivoOuNull(renda.buyer_total_amount);
  if (total != null) return roundReais(total);
  if (renda.buyer_total_amount !== 0) return null;
  const pago = segundosShopeeUtilizaveis(detalhe.pay_time) != null;
  const linhasComDinheiro = (renda.items ?? []).some(
    (i) => positivoOuNull(i.discounted_price) != null,
  );
  return pago && linhasComDinheiro ? 0 : null;
}

export interface FreteDoDinheiroShopee {
  /** What the buyer paid for shipping — `0` is a real value once the escrow answers. */
  readonly valorCobrado: number | null;
  /** What the shipment costs. */
  readonly custoCalculado: number | null;
  readonly fonte: FonteFreteShopee;
}

/**
 * The freight figures of one order — the ONE reader, for the money model and
 * for `orderFreteMapping.ts` alike.
 *
 * ⚠️ `buyer_paid_shipping_fee` is read verbatim ONLY behind
 * {@link totalDoCompradorShopee} (which requires it): there a `0` is a
 * free-shipping order, while the detail's numerics are zero-filled (the SG
 * order sent `actual_shipping_fee: 0` with 1.99 paid), so everything else still
 * goes through `positivoOuNull`.
 */
export function freteDoPedidoShopee(
  detalhe: ShopeeOrderDetailRow,
  escrow: ShopeeEscrowDetail | null,
): FreteDoDinheiroShopee {
  const renda = escrow?.order_income ?? null;
  const estimado = positivoOuNull(detalhe.estimated_shipping_fee);
  const pago = renda?.buyer_paid_shipping_fee;
  const custo =
    positivoOuNull(renda?.actual_shipping_fee) ??
    positivoOuNull(detalhe.actual_shipping_fee) ??
    estimado;
  const custoCalculado = custo == null ? null : roundReais(custo);

  // The gate already requires a finite, non-negative figure; the `typeof` is
  // the type narrowing.
  if (totalDoCompradorShopee(detalhe, escrow) != null && typeof pago === 'number') {
    return { valorCobrado: roundReais(pago), custoCalculado, fonte: FONTE_FRETE_SHOPEE.escrow };
  }
  if (estimado != null) {
    return {
      valorCobrado: roundReais(estimado),
      custoCalculado,
      fonte: FONTE_FRETE_SHOPEE.estimado,
    };
  }
  return { valorCobrado: null, custoCalculado, fonte: FONTE_FRETE_SHOPEE.ausente };
}

export interface DescontoDaLinha {
  /** The three buyer-side offsets ÷ quantity, rounded and CLAMPED at 0. */
  readonly unitario: number;
  /** The same value before the clamp — logged when it was negative. */
  readonly bruto: number;
  /** True when the clamp actually absorbed a negative sum. */
  readonly travado: boolean;
}

/**
 * The per-unit discount for one line: `discount_from_coin +
 * discount_from_voucher_shopee + discount_from_voucher_seller`, divided by the
 * escrow's own `quantity_purchased` (legacy `tasks.dart:598-600`).
 *
 * ⚠️ `seller_discount` and `shopee_discount` are NOT added: `discounted_price`
 * is already net of them (the identity in the module header), so adding them
 * would state one offset twice.
 *
 * ⚠️ **The clamp at 0 is not cosmetic.** `itemDoPedidoSchema.descontoUnitario`
 * is `z.number().min(0)`, and escrow money floats are legally negative on this
 * page. A negative sum would throw a `ZodError` INSIDE the pedido write, which
 * parks the delivery. Clamped, with the raw sum logged by the caller.
 *
 * No escrow row ⇒ `0`. The detail carries no per-line discount at all.
 */
export function descontoUnitario(escrow: ShopeeEscrowItem | null): DescontoDaLinha {
  if (escrow == null) return { unitario: 0, bruto: 0, travado: false };
  const soma =
    (escrow.discount_from_coin ?? 0) +
    (escrow.discount_from_voucher_shopee ?? 0) +
    (escrow.discount_from_voucher_seller ?? 0);
  const quantidade = escrow.quantity_purchased ?? null;
  const bruto = roundReais(quantidade != null && quantidade > 0 ? soma / quantidade : soma);
  return { unitario: bruto < 0 ? 0 : bruto, bruto, travado: bruto < 0 };
}

/**
 * The line's Σ `original_price` (a LINE total), for the floor: the escrow row's
 * `original_price`, else the detail's `model_original_price × quantity`, else
 * `null` (the model then counts the line at its own price).
 */
export function originalDaLinhaShopee(
  modelOriginalPrice: number | null | undefined,
  quantidade: number,
  escrow: ShopeeEscrowItem | null,
): number | null {
  const doEscrow = positivoOuNull(escrow?.original_price);
  if (doEscrow != null) return roundReais(doEscrow);
  const unitario = positivoOuNull(modelOriginalPrice);
  return unitario == null ? null : roundReais(unitario * quantidade);
}

/* -------------------------------------------------------------------------- */
/*                                 the totals                                  */
/* -------------------------------------------------------------------------- */

export interface TotaisDaNotaShopee {
  readonly itens: readonly ItemDoPedido[];
  readonly descontoTotal: number;
  readonly modalidade: unknown;
  /** `freteInicial.valorCobrado`, or `null`. */
  readonly valorFrete: number | null;
}

/**
 * What the NF-e states as its total (`vNF`): the shared derive with the freight
 * member gated exactly as the NF-e gates `vFrete` (`generator-input.ts`: CIF
 * only). Never re-inlined — every reader of this number calls this.
 */
export function totalDaNotaShopee(t: TotaisDaNotaShopee): number {
  const cif = t.modalidade === MODALIDADE_FRETE.cif;
  return derivePedidoFreteTotals({
    itens: t.itens,
    descontoTotal: t.descontoTotal,
    freteInicial: { valorCobrado: cif ? t.valorFrete : null },
  }).valorCobrado;
}

/** {@link totalDaNotaShopee} read off a STORED pedido, or `null` when it cannot be. */
export interface TotalDaNotaArmazenada {
  readonly totalDaNota: number | null;
  /** Stored lines `itemDoPedidoSchema` refused — any ⇒ `totalDaNota: null`. */
  readonly linhasIlegiveis: number;
}

/**
 * The NF-e total of a STORED pedido document — the raw `itens` map, its
 * `descontoTotal` and `freteInicial` — through the SAME {@link totalDaNotaShopee}.
 * Defensive at every level: a line the item schema refuses makes the answer
 * `null` (a partial sum would read as a divergence that is not there).
 */
export function totalDaNotaDoPedidoArmazenado(
  doc: Readonly<Record<string, unknown>>,
): TotalDaNotaArmazenada {
  const mapa = objeto(doc.itens);
  const itens: ItemDoPedido[] = [];
  let linhasIlegiveis = 0;
  if (mapa !== null) {
    const agrupado: Pedido['itens'] = {};
    for (const [chave, lista] of Object.entries(mapa)) {
      if (!Array.isArray(lista)) {
        linhasIlegiveis += 1;
        continue;
      }
      const lidas: ItemDoPedido[] = [];
      for (const bruto of lista) {
        const lido = itemDoPedidoSchema.safeParse(bruto);
        if (lido.success) lidas.push(lido.data);
        else linhasIlegiveis += 1;
      }
      agrupado[chave] = lidas;
    }
    itens.push(...flattenPedidoItens(agrupado));
  }
  const desconto = doc.descontoTotal;
  const frete = objeto(doc.freteInicial);
  const valorFrete = frete?.valorCobrado;
  if (linhasIlegiveis > 0) return { totalDaNota: null, linhasIlegiveis };
  return {
    totalDaNota: totalDaNotaShopee({
      itens,
      descontoTotal: typeof desconto === 'number' && Number.isFinite(desconto) ? desconto : 0,
      modalidade: frete?.modalidade ?? null,
      valorFrete: typeof valorFrete === 'number' && Number.isFinite(valorFrete) ? valorFrete : null,
    }),
    linhasIlegiveis: 0,
  };
}

/**
 * The modalidade the money model prices with: the STORED block's (what the
 * NF-e will read) on an existing pedido, else the conta's
 * `modalidadeFreteImportacao`, else FOB — the seed ML, Amazon and Loja
 * Integrada use. The block is seeded once and a re-import never rewrites it.
 */
export function modalidadeDoPedidoShopee(
  armazenado: Readonly<Record<string, unknown>> | null,
  modalidadeDaConta: ModalidadeFrete | null | undefined,
): ModalidadeFrete {
  const guardada = modalidadeFreteSchema.safeParse(objeto(armazenado?.freteInicial)?.modalidade);
  if (guardada.success) return guardada.data;
  return modalidadeDaConta ?? MODALIDADE_FRETE.fob;
}

/* -------------------------------------------------------------------------- */
/*                                  the model                                  */
/* -------------------------------------------------------------------------- */

export interface FecharDinheiroShopeeArgs {
  /**
   * The lines as READ — `precoDeVenda` the unit `discounted_price`,
   * `descontoUnitario` the three offsets ({@link descontoUnitario}).
   */
  readonly itens: readonly ItemDoPedido[];
  /** Per line, {@link originalDaLinhaShopee} (same order as `itens`). */
  readonly originais: readonly (number | null)[];
  readonly detalhe: ShopeeOrderDetailRow;
  readonly escrow: ShopeeEscrowDetail | null;
  readonly modalidade: ModalidadeFrete;
}

export interface PisoDaNotaShopee {
  /** `max(5, 50 % × Σ original, shipping cost)`, reais. */
  readonly valor: number;
  /** The goods total was below it and the discounts were reduced. */
  readonly aplicado: boolean;
  /** Even the undiscounted lines sit below it — the NF-e states them as they are. */
  readonly inalcancavel: boolean;
}

export interface PagamentoDoDinheiroShopee {
  /**
   * The buyer leg — what the pagamento set states, minus the cupom leg. Without
   * the escrow, the detail's `total_amount` (see the module header).
   */
  readonly valorDoComprador: number;
  /** The cupom leg, `0` when the floor did not bind. */
  readonly cupomShopee: number;
  /**
   * `pago-acima` with no cupom leg: the buyer leg states the NF-e total, BELOW
   * what the buyer paid, and the importer files `shp-pagamento-divergente`.
   * When the floor binds the buyer leg is what the buyer paid and the cupom
   * takes the rest, so there is nothing to reconcile.
   */
  readonly divergente: boolean;
}

export interface DinheiroShopee {
  /** The lines as the pedido stores them — floor-adjusted discounts. */
  readonly itens: readonly ItemDoPedido[];
  readonly descontoTotal: number;
  readonly frete: FreteDoDinheiroShopee;
  readonly modalidade: ModalidadeFrete;
  /** `buyer_total_amount` when the escrow answers, else `null`. */
  readonly totalDoComprador: number | null;
  /** Σ nets + freight paid − buyer total, BEFORE the floor; `null` without escrow. */
  readonly residual: number | null;
  readonly fechamento: FechamentoDinheiroShopee;
  /**
   * A PAID order (usable `pay_time`) whose escrow did not answer: the money is
   * the provisional `sem-escrow` reading, so an UPDATE keeps the stored lines'
   * money, `valorCobrado`, `descontoTotal`, the freight figures and the
   * pagamentos' DATA. Without it a contained escrow failure on a later delivery
   * would overwrite money an earlier delivery had closed.
   */
  readonly provisorio: boolean;
  /** `null` without escrow. */
  readonly piso: PisoDaNotaShopee | null;
  /** Σ `itemSubtotal` of the final lines, rounded. */
  readonly somaDosItens: number;
  /** Σ final `descontoUnitario × quantidade`, rounded — already inside {@link somaDosItens}. */
  readonly descontoDasLinhas: number;
  /** {@link totalDaNotaShopee} over the final lines. */
  readonly totalDaNota: number;
  /** The pedido's `valorCobrado`: the derive WITH the freight. */
  readonly valorDoPedido: number;
  readonly pagamento: PagamentoDoDinheiroShopee;
  /**
   * DIAGNOSTICS for the conferência log, never summed into anything:
   * `order_income`'s own `coins + voucher_from_shopee + voucher_from_seller`
   * (the order-level twin of Σ line offsets) and `pix_discount +
   * payment_promotion` (the offsets no line carries — what a positive residual
   * usually is). `null` without an `order_income`.
   */
  readonly ofertasDaOrdem: number | null;
  readonly descontosDePagamento: number | null;
}

/**
 * Close one order's money — see the module header for every rule.
 */
export function fecharDinheiroShopee(args: FecharDinheiroShopeeArgs): DinheiroShopee {
  const { detalhe, escrow, modalidade } = args;
  const renda = escrow?.order_income;
  const frete = freteDoPedidoShopee(detalhe, escrow);
  const totalDoComprador = totalDoCompradorShopee(detalhe, escrow);

  // A line's discount never exceeds its own price (a negative net line is an
  // NF-e `det` no SEFAZ accepts). The excess, if any, is un-itemized money and
  // reaches `descontoTotal` through the residual below.
  let itens: ItemDoPedido[] = args.itens.map((i) =>
    (i.descontoUnitario ?? 0) > i.precoDeVenda ? { ...i, descontoUnitario: i.precoDeVenda } : i,
  );
  let descontoTotal = 0;
  let residual: number | null = null;
  let fechamento: FechamentoDinheiroShopee = FECHAMENTO_DINHEIRO_SHOPEE.semEscrow;
  let piso: PisoDaNotaShopee | null = null;

  if (totalDoComprador != null) {
    const fretePago = frete.valorCobrado ?? 0;
    // The derive itself, freight included, minus what the buyer paid.
    const comFrete = derivePedidoFreteTotals({
      itens,
      descontoTotal: 0,
      freteInicial: { valorCobrado: fretePago },
    }).valorCobrado;
    residual = roundReais(comFrete - totalDoComprador);
    if (Math.abs(residual) <= TOLERANCIA_RESIDUAL_REAIS) {
      fechamento = FECHAMENTO_DINHEIRO_SHOPEE.fechado;
    } else if (residual > 0) {
      fechamento = FECHAMENTO_DINHEIRO_SHOPEE.descontoNaoDetalhado;
      descontoTotal = residual;
    } else if (-centavosDeReais(residual) <= toleranciaDeArredondamento(itens)) {
      // The lines' own per-unit rounding, not money the buyer paid on top.
      fechamento = FECHAMENTO_DINHEIRO_SHOPEE.fechado;
    } else {
      fechamento = FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima;
    }

    const reduzido = aplicarPiso(itens, args.originais, descontoTotal, frete.custoCalculado);
    itens = reduzido.itens;
    descontoTotal = reduzido.descontoTotal;
    piso = reduzido.piso;
  }

  const totalDaNota = totalDaNotaShopee({
    itens,
    descontoTotal,
    modalidade,
    valorFrete: frete.valorCobrado,
  });
  const valorDoPedido = derivePedidoFreteTotals({
    itens,
    descontoTotal,
    freteInicial: { valorCobrado: frete.valorCobrado },
  }).valorCobrado;

  // The NF-e goods total (no freight under any modalidade).
  const bensDaNota = derivePedidoFreteTotals({
    itens,
    descontoTotal,
    freteInicial: null,
  }).valorCobrado;
  // The cupom leg: what the NF-e states beyond what the buyer paid toward it —
  // `vNF − (buyer total − freight unless CIF)`, which is the same number under
  // either modalidade: `goods + freight paid − buyer total`. On `pago-acima` too:
  // with the floor bound the buyer leg is then what the buyer really paid, and
  // without it the formula is ≤ 0.
  const cupomShopee =
    piso?.aplicado === true && totalDoComprador != null
      ? Math.max(0, roundReais(bensDaNota + (frete.valorCobrado ?? 0) - totalDoComprador))
      : 0;
  // Without the escrow: the detail's `total_amount` (what the order says the
  // buyer paid), else the pedido's own total (lines + freight) — the
  // pre-2026-11-24 anchor, never `vNF` itself, so a pre-voucher reading cannot
  // close Σ vPag = vNF by construction (module header).
  const valorDoComprador =
    totalDoComprador == null
      ? roundReais(positivoOuNull(detalhe.total_amount) ?? valorDoPedido)
      : Math.max(0, roundReais(totalDaNota - cupomShopee));

  const somaDosItens = derivePedidoFreteTotals({
    itens,
    descontoTotal: 0,
    freteInicial: null,
  }).valorCobrado;
  const descontoDasLinhas = roundReais(
    itens.reduce((s, i) => s + (i.descontoUnitario ?? 0) * i.quantidade, 0),
  );

  return {
    itens,
    descontoTotal,
    frete,
    modalidade,
    totalDoComprador,
    residual,
    fechamento,
    provisorio:
      fechamento === FECHAMENTO_DINHEIRO_SHOPEE.semEscrow &&
      segundosShopeeUtilizaveis(detalhe.pay_time) != null,
    piso,
    somaDosItens,
    descontoDasLinhas,
    totalDaNota,
    valorDoPedido,
    pagamento: {
      // ⚠️ Once the escrow answers, always `vNF − cupom`: equal to `buyer total −
      // freight unless CIF` when the order closes or the floor binds, and the
      // NF-e total itself on `pago-acima` — so Σ vPag = vNF on every such arm.
      valorDoComprador,
      cupomShopee,
      divergente: fechamento === FECHAMENTO_DINHEIRO_SHOPEE.pagoAcima && cupomShopee === 0,
    },
    ofertasDaOrdem: somaOuNull(renda, ['coins', 'voucher_from_shopee', 'voucher_from_seller']),
    descontosDePagamento: somaOuNull(renda, ['pix_discount', 'payment_promotion']),
  };
}

/** Σ of the named `order_income` fields (absent ⇒ 0), or `null` without one. */
function somaOuNull(
  renda: ShopeeEscrowDetail['order_income'] | undefined,
  campos: readonly (
    | 'coins'
    | 'voucher_from_shopee'
    | 'voucher_from_seller'
    | 'pix_discount'
    | 'payment_promotion'
  )[],
): number | null {
  if (renda == null) return null;
  return roundReais(campos.reduce((s, c) => s + (renda[c] ?? 0), 0));
}

/**
 * How far below the buyer total, in CENTAVOS, the lines may sum from rounding
 * alone: one centavo per unit (each unit's price and discount are rounded to
 * half a centavo), never less than {@link TOLERANCIA_RESIDUAL_REAIS}.
 * `pago-acima` — and its incidente — start only beyond it.
 */
export function toleranciaDeArredondamento(itens: readonly ItemDoPedido[]): number {
  const unidades = itens.reduce(
    (s, i) => s + (Number.isFinite(i.quantidade) && i.quantidade > 0 ? i.quantidade : 0),
    0,
  );
  return Math.max(centavosDeReais(TOLERANCIA_RESIDUAL_REAIS), Math.ceil(unidades));
}

/* -------------------------------------------------------------------------- */
/*                                  the floor                                  */
/* -------------------------------------------------------------------------- */

/**
 * Reduce the discounts until the NF-e goods total reaches the floor — line
 * discounts first (scaled, largest remainder, to the centavo), then
 * `descontoTotal`. Integer centavos throughout; the result's goods total is
 * never below the target and overshoots it only by what a quantity above 1
 * cannot split.
 */
function aplicarPiso(
  itens: readonly ItemDoPedido[],
  originais: readonly (number | null)[],
  descontoTotal: number,
  custoDoFrete: number | null,
): { itens: ItemDoPedido[]; descontoTotal: number; piso: PisoDaNotaShopee } {
  const precos = itens.map((i) => centavosDeReais(i.precoDeVenda));
  const descontos = itens.map((i) => centavosDeReais(i.descontoUnitario ?? 0));
  const qtds = itens.map((i) => i.quantidade);
  const bruto = itens.reduce((s, _i, k) => s + Math.round(precos[k]! * qtds[k]!), 0);
  const descontoLinhas = itens.reduce((s, _i, k) => s + Math.round(descontos[k]! * qtds[k]!), 0);
  const descontoPedido = centavosDeReais(descontoTotal);
  const bens = bruto - descontoLinhas - descontoPedido;

  const somaOriginal = itens.reduce(
    (s, i, k) => s + (originais[k] ?? roundReais(i.precoDeVenda * i.quantidade)),
    0,
  );
  const valorPiso = Math.max(
    PISO_NFE_MINIMO_REAIS,
    roundReais(FRACAO_MINIMA_DO_ORIGINAL * roundReais(somaOriginal)),
    custoDoFrete ?? 0,
  );
  const pisoCentavos = centavosDeReais(valorPiso);
  const alvo = Math.min(pisoCentavos, bruto);
  const inalcancavel = pisoCentavos > bruto;

  if (bens >= alvo) {
    return {
      itens: [...itens],
      descontoTotal,
      piso: { valor: valorPiso, aplicado: false, inalcancavel },
    };
  }

  // 1. The line discounts, scaled down by largest remainder.
  const reduzivel = itens.map(
    (_i, k) => descontos[k]! > 0 && Number.isInteger(qtds[k]!) && qtds[k]! > 0,
  );
  const descontoReduzivel = itens.reduce(
    (s, _i, k) => s + (reduzivel[k] ? descontos[k]! * qtds[k]! : 0),
    0,
  );
  const corte = Math.min(alvo - bens, descontoReduzivel);
  const novos = [...descontos];
  if (corte > 0) {
    const restante = descontoReduzivel - corte;
    const restos: { k: number; resto: number }[] = [];
    let alocado = 0;
    for (let k = 0; k < itens.length; k += 1) {
      if (!reduzivel[k]) continue;
      const exato = descontos[k]! * restante;
      novos[k] = Math.floor(exato / descontoReduzivel);
      alocado += novos[k]! * qtds[k]!;
      restos.push({ k, resto: exato % descontoReduzivel });
    }
    let sobra = restante - alocado;
    restos.sort((a, b) => b.resto - a.resto || a.k - b.k);
    for (const { k } of restos) {
      if (qtds[k]! <= sobra && novos[k]! < descontos[k]!) {
        novos[k] = novos[k]! + 1;
        sobra -= qtds[k]!;
      }
    }
  }
  const linhasDepois = itens.reduce((s, _i, k) => s + Math.round(novos[k]! * qtds[k]!), 0);

  // 2. Then the order-level discount.
  const falta = alvo - (bruto - linhasDepois - descontoPedido);
  const novoDescontoPedido =
    falta > 0 ? descontoPedido - Math.min(falta, descontoPedido) : descontoPedido;

  return {
    itens: itens.map((i, k) =>
      novos[k] === descontos[k] ? i : { ...i, descontoUnitario: novos[k]! / 100 },
    ),
    descontoTotal: novoDescontoPedido / 100,
    piso: { valor: valorPiso, aplicado: true, inalcancavel },
  };
}

/* -------------------------------------------------------------------------- */

function objeto(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
