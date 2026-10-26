/**
 * Orders v2026 bodies for the step-5 mapper suites, composed in TEST code —
 * **for tests only**: nothing outside a `*.test.ts` imports this (plan §3
 * decision 34: no new committed fixture before C1).
 *
 * ⚠️ PLACEHOLDERS ONLY (the repository is public). The order id is the model's
 * own example id; line ids are short synthetic tokens (`L1`, `L2`, …), SKUs and
 * titles are `SKU-TESTE-*` / `Produto teste *`. No document, name or address
 * lives here: a suite that needs one builds it at run time (`documentos.ts`).
 *
 * Every body goes through the package's `pedidoWireAmazonSchema`, so a test
 * sees exactly what the importer will (`"2"` → 2, unread leaves passing through).
 */
import { parseIsoToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import {
  pedidoWireAmazonSchema,
  type PedidoWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';

/** The model's example order id (3-7-7). */
export const ORDER_ID_TESTE = '171-9876543-2109876';
/** The base order clock, and the same instant in µs. */
export const ATUALIZADO_EM = '2026-10-01T12:00:00Z';
export const ATUALIZADO_US = parseIsoToMicros(ATUALIZADO_EM) ?? 0;
export const CRIADO_EM = '2026-10-01T10:00:00Z';
export const CRIADO_US = parseIsoToMicros(CRIADO_EM) ?? 0;

/** An ISO instant `segundos` after {@link ATUALIZADO_EM}. */
export function depois(segundos: number): string {
  return new Date((ATUALIZADO_US + segundos * 1_000_000) / 1000)
    .toISOString()
    .replace('.000Z', 'Z');
}

/** A BRL `Money`. */
export function brl(amount: unknown): { amount: unknown; currencyCode: string } {
  return { amount, currencyCode: 'BRL' };
}

export interface OpcoesLinhaTeste {
  /** `undefined` ⇒ the key is ABSENT; `null` ⇒ present and null. */
  readonly qtd?: number | string | null;
  /** The unit price amount; `undefined` ⇒ no `price` at all. */
  readonly preco?: string | null;
  readonly sku?: string | null;
  readonly titulo?: string | null;
  /** `cancellation.cancellationExecution` present. */
  readonly execucao?: boolean;
  /** `cancellation.cancellationRequest` present. */
  readonly solicitacao?: boolean;
  readonly unidade?: string;
  /** The line's `proceeds.breakdowns`. */
  readonly quebras?: readonly unknown[];
  /** Drop `product` entirely. */
  readonly semProduto?: boolean;
}

/** One `orderItems[]` entry. */
export function linhaAmazon(id: string, opcoes: OpcoesLinhaTeste = {}): Record<string, unknown> {
  const linha: Record<string, unknown> = { orderItemId: id };
  if (opcoes.qtd !== undefined) linha.quantityOrdered = opcoes.qtd;
  if (opcoes.semProduto !== true) {
    const produto: Record<string, unknown> = {
      sellerSku: opcoes.sku === undefined ? `SKU-TESTE-${id}` : opcoes.sku,
      title: opcoes.titulo === undefined ? `Produto teste ${id}` : opcoes.titulo,
    };
    if (opcoes.preco !== undefined) {
      produto.price = { unitPrice: opcoes.preco === null ? null : brl(opcoes.preco) };
    }
    linha.product = produto;
  }
  if (opcoes.execucao === true || opcoes.solicitacao === true) {
    linha.cancellation = {
      ...(opcoes.solicitacao === true ? { cancellationRequest: { requester: 'BUYER' } } : {}),
      ...(opcoes.execucao === true ? { cancellationExecution: { cancelledBy: 'BUYER' } } : {}),
    };
  }
  if (opcoes.unidade !== undefined) linha.measurement = { unit: opcoes.unidade, value: 1 };
  if (opcoes.quebras !== undefined) linha.proceeds = { breakdowns: opcoes.quebras };
  return linha;
}

export interface OpcoesPedidoTeste {
  readonly status?: string | null;
  /** `fulfilledBy`; `null` ⇒ absent. */
  readonly por?: string | null;
  /** `undefined` ⇒ one line `L1` (qty 2 at 10.00); `null` ⇒ `orderItems` ABSENT. */
  readonly linhas?: readonly Record<string, unknown>[] | null;
  readonly atualizadoEm?: string;
  readonly pacotes?: readonly string[];
  readonly programs?: readonly string[] | null;
  readonly invoiceStatus?: string | null;
  /** Drop the whole `fulfillment` block. */
  readonly semFulfillment?: boolean;
  /**
   * `payment.paymentExecutions` (PR 6): `undefined` ⇒ ONE `CreditCard` leg paying
   * exactly what the lines, the shipping and the discounts state (so an order is
   * "clean" unless a test says otherwise); `null` ⇒ no `payment` block at all.
   */
  readonly pagamento?: readonly Record<string, unknown>[] | null;
  /** Extra top-level keys (`tax`, `buyer`, `recipient`, …), merged last. */
  readonly extra?: Record<string, unknown>;
}

/** A finite number read off a composed test value, else 0. */
function numeroDoTeste(valor: unknown): number {
  const n = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(n) ? n : 0;
}

/**
 * What the buyer paid for these composed lines, as a decimal amount: Σ
 * quantity × unit price, + every SHIPPING subtotal, − every DISCOUNT subtotal
 * (absolute). Test arithmetic only — the app reads money through
 * `dinheiroAmazon.ts`.
 */
export function totalPagoDasLinhas(linhas: readonly Record<string, unknown>[]): string {
  let total = 0;
  for (const linha of linhas) {
    const produto = linha.product as
      | { price?: { unitPrice?: { amount?: unknown } | null } }
      | undefined;
    total +=
      numeroDoTeste(linha.quantityOrdered) * numeroDoTeste(produto?.price?.unitPrice?.amount);
    const quebras = (linha.proceeds as { breakdowns?: unknown } | undefined)?.breakdowns;
    for (const q of Array.isArray(quebras) ? (quebras as Record<string, unknown>[]) : []) {
      const valor = numeroDoTeste((q.subtotal as { amount?: unknown } | undefined)?.amount);
      if (q.type === 'SHIPPING') total += valor;
      if (q.type === 'DISCOUNT') total -= Math.abs(valor);
    }
  }
  // A decimal text the wire reader parses ("25", "1599.9"): rounded by the canonical helper.
  return String(roundReais(total));
}

/** One `payment.paymentExecutions[]` leg. */
export function execucaoAmazon(
  metodo: string | null,
  valor: string | null,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const e: Record<string, unknown> = { ...extra };
  if (metodo !== null) e.paymentMethod = metodo;
  if (valor !== null) e.paymentAmount = brl(valor);
  return e;
}

/** A parsed getOrder `order` (module header). */
export function pedidoAmazon(opcoes: OpcoesPedidoTeste = {}): PedidoWireAmazon {
  const corpo: Record<string, unknown> = {
    orderId: ORDER_ID_TESTE,
    createdTime: CRIADO_EM,
    lastUpdatedTime: opcoes.atualizadoEm ?? ATUALIZADO_EM,
  };
  if (opcoes.programs !== null) corpo.programs = opcoes.programs ?? ['PRIME'];
  if (opcoes.semFulfillment !== true) {
    const fulfillment: Record<string, unknown> = {
      shipByWindow: { latestDateTime: '2026-10-03T23:59:59Z' },
      deliverByWindow: { latestDateTime: '2026-10-08T23:59:59Z' },
    };
    if (opcoes.status !== null) fulfillment.fulfillmentStatus = opcoes.status ?? 'UNSHIPPED';
    if (opcoes.por !== null) fulfillment.fulfilledBy = opcoes.por ?? 'MERCHANT';
    corpo.fulfillment = fulfillment;
  }
  if (opcoes.linhas !== null) {
    corpo.orderItems = opcoes.linhas ?? [linhaAmazon('L1', { qtd: 2, preco: '10.00' })];
  }
  if (opcoes.pagamento !== null) {
    const linhas = (corpo.orderItems ?? []) as Record<string, unknown>[];
    corpo.payment = {
      paymentExecutions: opcoes.pagamento ?? [
        execucaoAmazon('CreditCard', totalPagoDasLinhas(linhas)),
      ],
    };
  }
  if (opcoes.pacotes !== undefined) {
    corpo.packages = opcoes.pacotes.map((detalhe, i) => ({
      packageReferenceId: `PKG-${String(i + 1)}`,
      packageStatus: { status: 'IN_TRANSIT', detailedStatus: detalhe },
    }));
  }
  if (opcoes.invoiceStatus !== undefined && opcoes.invoiceStatus !== null) {
    corpo.tax = { taxInvoicing: { invoiceStatus: opcoes.invoiceStatus } };
  }
  return pedidoWireAmazonSchema.parse({ ...corpo, ...(opcoes.extra ?? {}) });
}
