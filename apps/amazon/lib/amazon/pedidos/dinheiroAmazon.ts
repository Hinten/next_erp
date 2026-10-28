/**
 * The app's ONE money reader (master plan step 5, PR 5-c; plan §3 decision 22).
 *
 * Amazon's `Money.amount` is a decimal STRING the package leaves unread
 * (`dinheiroWireAmazonSchema`), so a wrong-typed amount degrades one leaf to
 * "absent" instead of parking the whole order. It is read here, once:
 *
 * - only `currencyCode === 'BRL'` (exact) counts; another currency is absent;
 * - the amount through `parseWireDecimal`, which answers `null` — never 0 — for
 *   anything it cannot read (`''`, `'1e3'`, a JSON number, `null`);
 * - then `roundReais`.
 *
 * ⚠️ **0 and absent stay DISTINCT.** D17 decides what each means: a 0 is a value
 * Amazon sent, an absent one is no evidence at all.
 *
 * ## The order-money group (`dinheiroDoPedidoAmazon`)
 *
 * From each line's `proceeds.breakdowns` (the model aggregates the same
 * categories at the order level, but only the line level splits a DISCOUNT into
 * its `SHIPPING` part):
 *
 * - the freight money = Σ `SHIPPING` subtotals − Σ the `SHIPPING` detail of the
 *   `DISCOUNT` rows, or `null` when no line carries a `SHIPPING` row (never 0);
 * - `descontoTotal` = Σ `DISCOUNT` subtotals − that same shipping part, so
 *   Σ lines − `descontoTotal` + freight states the whole order once;
 * - discounts are read as ABSOLUTE values (the model states no sign; its example
 *   shows a positive amount that is subtracted — a C1 checkpoint);
 * - no line carrying a `breakdowns` array at all ⇒ both members absent;
 * - any unreadable member, or an inconsistent difference (below 0) ⇒ that
 *   member absent.
 *
 * `proceeds.grandTotal` is NEVER read: it is what the SELLER receives, net of
 * Amazon's deductions — not what the buyer paid, nor what the NF-e states.
 *
 * ## What the group cannot state (`ressalvasDoDinheiroAmazon`, PR 5-f)
 *
 * The group never guesses a split, so two shapes of the proceeds leave the
 * NF-e's numbers unverifiable — and the one cross-check, the pagamento `valor`
 * (`pagamentoAmazon.ts`), is blind to both. They are COUNTED here and never
 * folded into an amount; the pedido decision turns each count into a pedido
 * incidente (`pedidoMapeamento.ts`):
 *
 * - **a discount whose shipping part is not itemised**: a line with a
 *   `SHIPPING` row and a `DISCOUNT` row carrying no `SHIPPING` detail whose
 *   details do not account for it — none at all, a subtype the model does not
 *   document (which might be the shipping part), or documented non-shipping
 *   subtypes (such as `ITEM`) whose absolute sum is not the absolute subtotal
 *   to the centavo. Documented details that DO add up to the whole discount
 *   state its shipping part as 0, so the split is known and nothing counts.
 *   Otherwise the whole
 *   discount goes to `descontoTotal` while the freight stays gross. The
 *   payment check cannot see it: Σ executions − the gross freight equals Σ
 *   lines − the inflated discount for ANY split, so under FOB (the conta
 *   default) the note's total is understated in silence, and under CIF its
 *   discount and freight are each off by the shipping part;
 * - **a tax shown apart**: a line `TAX` row whose subtotal or any detail is
 *   not exactly 0 — or, when no line row counts, an order-level `TAX` row whose
 *   subtotal is not (the order level aggregates the line rows, so one tax is
 *   never counted twice). Amazon documents the ITEM proceeds as
 *   tax-EXCLUSIVE when it shows the tax separately, while this module reads the
 *   line price as `unitPrice` (provisionally tax-INCLUSIVE, C1 checkpoint CP4)
 *   and takes DISCOUNT and SHIPPING as sent: on a mixed basis the note's total
 *   and discount can be overstated with no mismatch against the payment. `TAX`
 *   is read for this count ONLY, never added to or subtracted from anything.
 *
 * "Not exactly 0" goes through the same reader: an amount that does not read
 * (absent, not BRL, not a decimal) COUNTS, because a signal a person reads costs
 * less than a silent wrong note; so does an unreadable detail, which never
 * accounts for a discount. A row that reads exactly 0 never counts, nor
 * does a DISCOUNT on a line without SHIPPING, nor one with a `SHIPPING` detail
 * of any value (an unreadable one already leaves both members absent, which the
 * payment check reports). The sign never matters: a discount and its details
 * are absolute here.
 *
 * ## The ONE money comparison (`mesmosCentavos`)
 *
 * Every "did this amount change" in the order mappers goes through it, so one
 * pair of tests pins the fold's scope for every site: two amounts are the same
 * when they round to the same CENTAVO (a legacy float `33.300000000000004`
 * equals `33.30`); one centavo apart they are distinct (whole reais never
 * fold); `null` equals only `null`, never 0.
 */
import { centavosDeReais, roundReais } from '@delfrance/core/money';
import { parseWireDecimal } from '@delfrance/core/wire';
import type { DinheiroWireAmazon, PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';

/** The one currency this ERP books. */
export const MOEDA_AMAZON_BR = 'BRL';

/**
 * Amazon's proceeds categories this module reads (exact tokens): `SHIPPING` and
 * `DISCOUNT` for the order-money group, `TAX` only for the ressalvas count
 * (module header) — never for an amount.
 */
export const TIPO_QUEBRA_AMAZON = {
  frete: 'SHIPPING',
  desconto: 'DISCOUNT',
  imposto: 'TAX',
} as const satisfies Record<string, string>;

/** A `Money` in reais, or `null` (module header): BRL only, never a guessed 0. */
export function reaisDeMoneyAmazon(m: DinheiroWireAmazon | null | undefined): number | null {
  if (m == null || m.currencyCode !== MOEDA_AMAZON_BR) return null;
  const valor = parseWireDecimal(m.amount);
  return valor === null ? null : roundReais(valor);
}

/** The same amount to the centavo; `null` equals only `null` (module header). */
export function mesmosCentavos(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return centavosDeReais(a) === centavosDeReais(b);
}

/** Σ in reais, or `null` when ANY part is `null`. An empty list sums to 0. */
export function somaReais(valores: readonly (number | null)[]): number | null {
  let soma = 0;
  for (const valor of valores) {
    if (valor === null) return null;
    soma += valor;
  }
  return roundReais(soma);
}

/** The order-money group as Amazon states it (module header). */
export interface DinheiroDoPedidoAmazon {
  /** Reais; `null` = absent. */
  readonly descontoTotal: number | null;
  /** `freteInicial.valorCobrado`, reais; `null` = absent (never a guessed 0). */
  readonly valorFrete: number | null;
}

function absoluto(valor: number | null): number | null {
  return valor === null ? null : Math.abs(valor);
}

/** A non-negative difference, or `null` (an unreadable side or a negative result). */
function diferenca(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const resultado = roundReais(a - b);
  return resultado < 0 ? null : resultado;
}

/** The order-money group (module header). */
export function dinheiroDoPedidoAmazon(order: PedidoWireAmazon): DinheiroDoPedidoAmazon {
  let temQuebras = false;
  const fretes: (number | null)[] = [];
  const descontos: (number | null)[] = [];
  const descontosDoFrete: (number | null)[] = [];
  for (const linha of order.orderItems ?? []) {
    const quebras = linha.proceeds?.breakdowns;
    if (!Array.isArray(quebras)) continue;
    temQuebras = true;
    for (const quebra of quebras) {
      if (quebra.type === TIPO_QUEBRA_AMAZON.frete) {
        fretes.push(reaisDeMoneyAmazon(quebra.subtotal));
      } else if (quebra.type === TIPO_QUEBRA_AMAZON.desconto) {
        descontos.push(absoluto(reaisDeMoneyAmazon(quebra.subtotal)));
        for (const detalhe of quebra.detailedBreakdowns ?? []) {
          if (detalhe.subtype === TIPO_QUEBRA_AMAZON.frete) {
            descontosDoFrete.push(absoluto(reaisDeMoneyAmazon(detalhe.value)));
          }
        }
      }
    }
  }
  if (!temQuebras) return { descontoTotal: null, valorFrete: null };
  const descontoDoFrete = somaReais(descontosDoFrete);
  const freteBruto = fretes.length === 0 ? null : somaReais(fretes);
  return {
    descontoTotal: diferenca(somaReais(descontos), descontoDoFrete),
    valorFrete: diferenca(freteBruto, descontoDoFrete),
  };
}

/** What the order-money group cannot state (module header, PR 5-f): COUNTS only, never an amount. */
export interface RessalvasDinheiroAmazon {
  /** Lines with a `SHIPPING` row and a `DISCOUNT` row whose shipping part is not stated, neither exactly 0. */
  readonly linhasDescontoNaoDetalhado: number;
  /** Line `TAX` rows not exactly 0; when none, the order-level ones (their aggregate). */
  readonly quebrasImposto: number;
}

/** Reads as exactly 0 (to the centavo); absent or unreadable is NOT zero (module header). */
function zeroLido(m: DinheiroWireAmazon | null | undefined): boolean {
  return reaisDeMoneyAmazon(m) === 0;
}

type QuebraAmazon = NonNullable<
  NonNullable<NonNullable<PedidoWireAmazon['orderItems']>[number]['proceeds']>['breakdowns']
>[number];

/**
 * The `detailedBreakdowns[].subtype` values the Orders v2026 model documents
 * besides `SHIPPING` (exact tokens): the details that may account for a
 * discount's goods side. An undocumented one (`shipping` in lower case, a new
 * token) might be the shipping part, so it never accounts for anything.
 */
const SUBTIPOS_SEM_FRETE_AMAZON: ReadonlySet<string> = new Set<string>([
  'ITEM',
  'GIFT_WRAP',
  'COD_FEE',
  'OTHER',
  'DISCOUNT',
]);

/**
 * A nonzero DISCOUNT whose shipping part Amazon did not state (module header):
 * no `SHIPPING` detail, and either no detail at all, a detail of an
 * undocumented subtype, or details whose absolute sum is not the absolute
 * subtotal to the centavo. Documented non-shipping details that account for
 * the whole subtotal (say `ITEM` 10 of a 10 discount) state the shipping part
 * as 0, so the split is known. An unreadable detail or subtotal never accounts
 * for anything: the line counts.
 */
function descontoSemParteDoFrete(q: QuebraAmazon): boolean {
  if (q.type !== TIPO_QUEBRA_AMAZON.desconto || zeroLido(q.subtotal)) return false;
  const detalhes = q.detailedBreakdowns ?? [];
  if (detalhes.some((d) => d.subtype === TIPO_QUEBRA_AMAZON.frete)) return false;
  const documentados = detalhes.every(
    (d) => typeof d.subtype === 'string' && SUBTIPOS_SEM_FRETE_AMAZON.has(d.subtype),
  );
  if (detalhes.length === 0 || !documentados) return true;
  const soma = somaReais(detalhes.map((d) => absoluto(reaisDeMoneyAmazon(d.value))));
  const subtotal = absoluto(reaisDeMoneyAmazon(q.subtotal));
  return soma === null || subtotal === null || !mesmosCentavos(soma, subtotal);
}

/** A `TAX` row whose subtotal or some detail does not read exactly 0 (module header). */
function impostoNaoZero(q: QuebraAmazon): boolean {
  return (
    q.type === TIPO_QUEBRA_AMAZON.imposto &&
    (!zeroLido(q.subtotal) || (q.detailedBreakdowns ?? []).some((d) => !zeroLido(d.value)))
  );
}

/** The ressalvas of one read (module header). */
export function ressalvasDoDinheiroAmazon(order: PedidoWireAmazon): RessalvasDinheiroAmazon {
  let linhasDescontoNaoDetalhado = 0;
  let quebrasImposto = 0;
  for (const linha of order.orderItems ?? []) {
    const quebras = linha.proceeds?.breakdowns;
    if (!Array.isArray(quebras)) continue;
    const comFrete = quebras.some(
      (q) => q.type === TIPO_QUEBRA_AMAZON.frete && !zeroLido(q.subtotal),
    );
    if (comFrete && quebras.some(descontoSemParteDoFrete)) linhasDescontoNaoDetalhado += 1;
    quebrasImposto += quebras.filter(impostoNaoZero).length;
  }
  // The order level aggregates the line rows (the model's own description), so
  // its TAX row is evidence only when no line TAX row counted: one tax is never
  // counted twice, and a tax stated only there still counts.
  if (quebrasImposto === 0) {
    quebrasImposto = (order.proceeds?.breakdowns ?? []).filter(
      (q) => q.type === TIPO_QUEBRA_AMAZON.imposto && !zeroLido(q.subtotal),
    ).length;
  }
  return { linhasDescontoNaoDetalhado, quebrasImposto };
}
