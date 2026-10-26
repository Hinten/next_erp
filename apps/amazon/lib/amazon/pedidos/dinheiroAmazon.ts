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

/** Amazon's proceeds categories this module reads (exact tokens). */
export const TIPO_QUEBRA_AMAZON = {
  frete: 'SHIPPING',
  desconto: 'DISCOUNT',
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
