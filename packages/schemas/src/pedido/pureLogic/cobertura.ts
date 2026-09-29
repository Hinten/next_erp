import { roundReais } from '@delfrance/core/money';
import { FORMA_PAGAMENTO, isPagamentoPagante } from '../collection/pagamento';
import { somaBrutaItensDevolvidos } from './totals';

/** A finite number, or 0 — the fail-safe read of a value that may be a raw snapshot field. */
function numeroOuZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** What {@link coberturaDoPedido} needs to know about the pedido itself. */
export interface PedidoCoberturaInput {
  /** The GROSS charged total (legacy `Pedido.total`); the stored `valorCobrado`. */
  valorCobrado: number | null | undefined;
  /** Only an explicit `false` is an entrada (schema default `true`); `null` / absent = saída. */
  ehSaida?: boolean | null;
  /** The typed `itensDevolvidos` map OR a raw snapshot value — read tolerantly. */
  itensDevolvidos?: unknown;
}

/** One pagamento, as far as the coverage sum is concerned. */
export interface PagamentoCoberturaRow {
  valor?: number | null;
  status_pagamento?: number | null;
  forma_de_pagamento?: number | null;
}

/** Σ `valor` of the rows, each read as "finite or 0". */
function somarValores(rows: ReadonlyArray<PagamentoCoberturaRow>): number {
  return rows.reduce((soma, r) => soma + numeroOuZero(r.valor), 0);
}

/** The figures derived by {@link coberturaDoPedido}. All are 2-decimal-rounded. */
export interface CoberturaPedido {
  /** `roundReais(valorCobrado ?? 0)` — GROSS. */
  valorCobrado: number;
  /** The returned items' value (0 for an entrada) — the footer's "Devoluções". */
  valorDevolvido: number;
  /** Paying 'crédito loja' pagamentos — the returned value already registered as a payment. */
  creditoLojaPago: number;
  /** The credit counted on the paid side: `max(0, valorDevolvido − creditoLojaPago)`. */
  creditoDevolucao: number;
  /** Paying pagamentos only (`== sumPagamentosPagos`) — the footer's "Vlr. Pago". */
  valorPago: number;
  /** What settles the pedido: `creditoDevolucao + valorPago`. Feeds `nextPedidoEstado`. */
  valorQuitado: number;
  /** `valorCobrado − creditoDevolucao` — the legacy footer's NET "Total"; may be negative. */
  saldo: number;
  /** Still to pay: `max(0, valorCobrado − valorQuitado)` — the "Valor restante" autofill. */
  restante: number;
  /** Overpaid: `max(0, valorQuitado − valorCobrado)` — the footer's "Troco". */
  troco: number;
}

/**
 * The value of the items a saída pedido takes back (a *troca*): `roundReais` of
 * {@link somaBrutaItensDevolvidos}, or 0 for an entrada (`ehSaida === false`).
 * The figure the footer shows as "Devoluções", the same one
 * `derivePedidoTotals().valorDevolucao` computes, and the ONE rounding of the raw
 * sum that every consumer downstream reuses (see {@link coberturaDoPedido}, OD3).
 *
 * Gated on `ehSaida !== false` because only a saída carries a devolução: the
 * legacy form loaded it for saídas alone (`cadastroPedidoProvider.dart:208-210`),
 * the Devolução tab is saída-only, and the entrada / integral-devolução seeds
 * null the map (`packages/data/src/pedido/devolucao.ts`). Absent / `null`
 * `ehSaida` counts as saída — the schema default.
 */
export function valorDevolvido(
  p: Pick<PedidoCoberturaInput, 'ehSaida' | 'itensDevolvidos'>,
): number {
  return p.ehSaida === false ? 0 : roundReais(somaBrutaItensDevolvidos(p.itensDevolvidos));
}

/**
 * How much of a pedido is covered: payments PLUS the value of the items the
 * customer returns. The ONE place that decides it — the server estado reconcile
 * (`nextPedidoEstado`), the pedido footer, the "valor restante" autofill and the
 * page-model validation all read this instead of comparing `Σ pagamentos`
 * against the total on their own.
 *
 * ## Why (a troca)
 *
 * A troca is a saída whose `itensDevolvidos` are taken back in the same
 * transaction. Legacy counted those returned items as PAID and compared the sum
 * against the GROSS total: `.old/packages/pagamento/mercado_pago/lib/src/tasks.dart:64-68`
 * (and `:266-270`) adds every `getAllItensDeovlvidosAsList` item's `totalItem`
 * to `totalPago` before the payments; the form did the same when it saved a
 * devolução (`cadastroPedidoProvider.dart:1015-1053`, `valorPago += item.subtotal`,
 * then `:1119` pago / `:1137` partial / `:1153` downgrade against the gross
 * total). This repo did not, so a troca paid "the difference" never reached
 * `pago`: the returned goods covered nothing.
 *
 * ## Why the credit sits on the PAID side
 *
 * `valorCobrado` stays GROSS — it backs the indexed `/pedidos` sort and currency
 * filter and the migrated legacy corpus holds gross values. And netting it
 * instead would break the estado rule: `nextPedidoEstado` returns `null` when
 * `total <= 0` (an even swap would be stranded in `iniciado` forever) and gates
 * its partial branch on `valorPago > 0` (a credit-only partial would never reach
 * `aguardandoConfirmacaoDePagamento`). Adding the credit to what is paid
 * reproduces legacy on both.
 *
 * ## Deliberate deviations from legacy (both fail SAFE — never over-count a credit)
 *
 * - **OD1 — the credit is the returned value MINUS the paying 'crédito loja'
 *   pagamentos** (`FORMA_PAGAMENTO.credito_loja`), floored at 0. To emit the
 *   troca's NF-e an operator registers a crédito-loja pagamento for the returned
 *   value (the NF-e pre-send guard checks Σ vPag against vNF); counted on top
 *   of the credit it would cover the same returned goods twice, and the pedido
 *   would reach `pago` (and freight `despachoAutorizado`) before the difference
 *   is paid. ⚠️ The subtraction is by forma, not by link to the devolução, so it
 *   can UNDER-count when an unrelated crédito loja exists (the customer paid part
 *   of the difference with store credit): the pedido then waits for the
 *   difference to be registered instead of closing early. Waiting is the safe
 *   direction.
 * - **OD3 — the credit is ROUNDED before the payments are added** (legacy
 *   summed the raw float and rounded once, `tasks.dart:80`). Everything that
 *   shows a number rounds the credit first (footer "Devoluções", `restante`), so
 *   a raw-credit `valorQuitado` could land ONE CENT SHORT of the very
 *   `restante` it just displayed: a return of 0.5 × R$ 1,01 is 0.505 raw, the
 *   footer says 0,51, the operator pays the remaining 16,84 on 17,35 and the raw
 *   sum rounds to 17,34 — stuck in `aguardandoConfirmacaoDePagamento`. With one
 *   rounded credit, paying exactly `restante` always closes the pedido.
 *
 * ## Not wired (deliberately)
 *
 * No marketplace importer (Mercado Livre `orderPaymentImport` / `orderImport`,
 * Shopee `pagamentoTx`) writes or reads `itensDevolvidos`, and legacy never netted
 * there; the only live legacy readers were the Mercado Pago link webhook
 * (`tasks.dart`) and the pedido form. NF-e emission, the DANFE / print
 * templates and the `/pedidos` list columns do not read this either: they keep
 * the gross total.
 *
 * ## Side effects to know about
 *
 * A troca whose credit covers the whole total (an even swap) is `pago` from the
 * moment it is created (`aplicarQuitacaoNaCriacao`) — legacy parity — so the
 * `onPedidoChanged` consequences of `pago` (stock reservation / movement,
 * `freteInicial` → `despachoAutorizado`, NF-e eligibility) now start at
 * creation for it.
 *
 * ## Inputs
 *
 * Pure and total (no clock, no network, no Firestore): it is called from the
 * browser AND from a transaction over raw snapshot values, so every number is
 * read as "finite or 0" and it never throws or returns NaN. `pagamentos` are
 * counted with {@link isPagamentoPagante} (`null` / `aprovado` / `em_disputa`) —
 * the deliberate #1322 deviation from legacy's aprovado-only — and
 * `valorPago` equals `sumPagamentosPagos` for the same rows.
 */
export function coberturaDoPedido(
  p: PedidoCoberturaInput,
  pagamentos: ReadonlyArray<PagamentoCoberturaRow>,
): CoberturaPedido {
  const valorCobrado = roundReais(numeroOuZero(p.valorCobrado));
  const pagantes = pagamentos.filter((r) => isPagamentoPagante(r.status_pagamento));
  const valorPago = roundReais(somarValores(pagantes));
  const creditoLojaPago = roundReais(
    somarValores(pagantes.filter((r) => r.forma_de_pagamento === FORMA_PAGAMENTO.credito_loja)),
  );
  const devolvido = valorDevolvido(p);
  const creditoDevolucao = Math.max(0, roundReais(devolvido - creditoLojaPago));
  const valorQuitado = roundReais(creditoDevolucao + valorPago);
  return {
    valorCobrado,
    valorDevolvido: devolvido,
    creditoLojaPago,
    creditoDevolucao,
    valorPago,
    valorQuitado,
    saldo: roundReais(valorCobrado - creditoDevolucao),
    restante: Math.max(0, roundReais(valorCobrado - valorQuitado)),
    troco: Math.max(0, roundReais(valorQuitado - valorCobrado)),
  };
}
