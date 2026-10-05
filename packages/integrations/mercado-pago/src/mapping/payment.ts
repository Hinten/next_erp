import { parseIsoToMicros } from '@delfrance/core/datetime';
import { roundReais } from '@delfrance/core/money';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  extrairPrimeiroNome,
  linkPagamentoIdSchema,
  pagamentoSchema,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import type { MpPayment } from '../types';

/**
 * Pure MP-payment → `Pagamento` mapper. Ports the legacy
 * `MercadoLivrePayment.toPagamento`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:4455`):
 * amount/refund/tarifa arithmetic, the status → `STATUS_PAGAMENTO` table with
 * the approved+refund post-adjust, and the `payment_type_id` → `FORMA_PAGAMENTO`
 * switch (card types also emit the embedded cartao block).
 *
 * No Firestore, no I/O — the webhook layer owns the fetch, the pedido lookup and
 * the transactional upsert. The output is a wire-valid `pagamentoSchema` object
 * (the tests parse it to prove that) whose doc id is `String(payment.id)`, so a
 * redelivery upserts the same doc idempotently.
 *
 * It also stamps the two server-owned ATTRIBUTION keys of the payment-link tab
 * (#367): `linkPagamentoId` (which `linkPgtoMercadoPago` doc issued the payment)
 * and `primeiroNomePagador` (the payer's FIRST name only — LGPD). Both are
 * enrichment: they are OMITTED — never written as `undefined`, which the Admin
 * SDK rejects — whenever the payment does not carry a usable value.
 */

/**
 * ISO-8601 → microseconds since epoch (the pagamento datetime unit). MP returns
 * ISO strings; `parseIsoToMicros` keeps every digit the provider sent (a
 * `Date.parse` would truncate sub-millisecond digits and refill them with zeros
 * on the ×1000). Returns null for a null/absent/unparseable value.
 */
function isoToMicros(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  return parseIsoToMicros(iso);
}

/**
 * The `linkPgtoMercadoPago` doc id this payment came from: the
 * `metadata.link_id` the link route stamped on the Checkout Pro preference, or
 * `null`.
 *
 * ⚠️ The snake_case key ONLY — Mercado Pago is believed to snake_case metadata
 * keys, and a live probe (PR 2) confirms it; a `linkId` is deliberately NOT
 * accepted, so a wrong guess fails visibly (nothing attributed) instead of
 * matching by luck. The value goes through the same schema the link doc id is
 * minted against, then through `pagamentoSchema`'s own field (the FINAL gate):
 * an unparseable value written into the pedido transaction would throw there,
 * read as transient and park a REAL payment (the #1087 class), so a bad id costs
 * the attribution and nothing else.
 *
 * ⚠️ There is NO `additional_info.items[0].id` fallback: legacy stamped the
 * PEDIDO id there, so it would attribute legacy payments to a "link" named after
 * their pedido.
 */
function linkPagamentoIdDoPagamento(payment: MpPayment): string | null {
  const bruto = payment.metadata?.link_id;
  if (typeof bruto !== 'string') return null;
  const id = linkPagamentoIdSchema.safeParse(bruto);
  if (!id.success) return null;
  return pagamentoSchema.shape.linkPagamentoId.safeParse(id.data).success ? id.data : null;
}

/**
 * The payer's FIRST name (never a surname — LGPD minimisation), or `null`.
 *
 * Mercado Pago returns no payer personal data on Checkout Pro, so this is
 * optional enrichment: `payer.first_name` when present, else the card payment's
 * cardholder name. `extrairPrimeiroNome` returns the first source that yields a
 * usable name (so a rejected `first_name` falls through to the cardholder) and
 * `null` for emails, documents, test-card tokens and anything that is not a
 * name. A Pix payer's BANK name (`bank_info.payer.long_name`) is a company, not
 * a person — it is never read.
 *
 * The result then goes through `pagamentoSchema`'s own field (the FINAL gate),
 * for the reason `linkPagamentoIdDoPagamento` states.
 */
function primeiroNomeDoPagador(payment: MpPayment): string | null {
  const nome = extrairPrimeiroNome(payment.payer?.first_name, payment.card?.cardholder?.name);
  if (nome === null) return null;
  return pagamentoSchema.shape.primeiroNomePagador.safeParse(nome).success ? nome : null;
}

function sumAmounts(values: ReadonlyArray<number | null | undefined>): number {
  return values.reduce<number>((acc, v) => acc + (v ?? 0), 0);
}

/**
 * MP `status` → `STATUS_PAGAMENTO`. Mirrors legacy
 * `MERCADOLIVREPAYMENT_STATUS.toStatusPagamento()`. An unknown/absent status
 * degrades to `pendente`, matching legacy `fromString`'s fallback.
 */
const MP_STATUS_TO_PAGAMENTO: Record<string, StatusPagamento> = {
  pending: STATUS_PAGAMENTO.pendente,
  approved: STATUS_PAGAMENTO.aprovado,
  authorized: STATUS_PAGAMENTO.em_processo_aprovacao,
  in_process: STATUS_PAGAMENTO.em_revisao,
  in_mediation: STATUS_PAGAMENTO.em_disputa,
  rejected: STATUS_PAGAMENTO.recusado,
  cancelled: STATUS_PAGAMENTO.cancelado,
  refunded: STATUS_PAGAMENTO.estornado,
  charged_back: STATUS_PAGAMENTO.devolvido,
};

/**
 * MP `payment_type_id` → `FORMA_PAGAMENTO`. `credit_card` / `debit_card` also
 * carry the embedded cartao block (see the mapper). Anything unrecognized →
 * `outros`, matching the legacy switch default. (`bank_transfer` is where MP
 * Pix arrives.)
 */
const MP_PAYMENT_TYPE_TO_FORMA: Record<string, FormaPagamento> = {
  credit_card: FORMA_PAGAMENTO.cartao_credito,
  debit_card: FORMA_PAGAMENTO.cartao_debito,
  ticket: FORMA_PAGAMENTO.boleto_bancario,
  bank_transfer: FORMA_PAGAMENTO.deposito_bancario,
  account_money: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
  digital_currency: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
  digital_wallet: FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria,
  atm: FORMA_PAGAMENTO.outros,
  prepaid_card: FORMA_PAGAMENTO.outros,
  voucher_card: FORMA_PAGAMENTO.outros,
  crypto_transfer: FORMA_PAGAMENTO.outros,
};

const CARD_FORMAS: ReadonlySet<FormaPagamento> = new Set<FormaPagamento>([
  FORMA_PAGAMENTO.cartao_credito,
  FORMA_PAGAMENTO.cartao_debito,
]);

export interface MpPaymentToPagamentoOptions {
  /**
   * Canonical `documents/metodo_pgto/<id>` ref of the owning MP account. Stamped
   * verbatim onto `pagamento.metodoPagamentoOuterRef`.
   */
  readonly metodoOuterRef: string;
  /**
   * Current time in microseconds — the last-resort `ultimaModificacao` fallback
   * when the payment carries no usable `date_last_updated` / `date_created`.
   */
  readonly nowMicros: number;
}

export function mpPaymentToPagamento(
  payment: MpPayment,
  opts: MpPaymentToPagamentoOptions,
): { pagamentoId: string; pagamento: Pagamento } {
  const pagamentoId = String(payment.id);

  // valorSemJuros — gross paid amount (transaction + shipping), before refunds.
  const valorSemJuros = roundReais(
    (payment.transaction_amount ?? 0) + (payment.shipping_cost ?? 0),
  );

  // refunds — Σ refunds[].amount.
  const refunds = roundReais(sumAmounts((payment.refunds ?? []).map((r) => r.amount)));

  // valor — the net amount retained (gross − refunds), clamped at 0:
  // over-refunds (chargeback fees, rounding across multiple partial refunds)
  // can push Σrefunds past the gross, and `pagamentoSchema.valor` is min(0) —
  // a negative value would fail the parse and park the whole delivery.
  const valor = Math.max(0, roundReais(valorSemJuros - refunds));

  // tarifas — MP's take: marketplace fee + itemized fee_details + the
  // collector→mp charges (original − refunded); other account pairs are ignored.
  // Left unrounded to mirror legacy exactly, but clamped at 0 like `valor`: a
  // refunded fee (`refunded > original`) or a negative `fee_details[].amount`
  // makes the sum negative, and `pagamentoSchema.tarifas` is min(0) — the raw
  // negative would fail the parse and park the whole delivery (#794).
  const collectorToMpCharges = (payment.charges_details ?? []).filter(
    (c) => c.accounts?.from === 'collector' && c.accounts?.to === 'mp',
  );
  const tarifas = Math.max(
    0,
    (payment.marketplace_fee ?? 0) +
      sumAmounts((payment.fee_details ?? []).map((f) => f.amount)) +
      collectorToMpCharges.reduce<number>(
        (acc, c) => acc + ((c.amounts?.original ?? 0) - (c.amounts?.refunded ?? 0)),
        0,
      ),
  );

  // status — base table, then the approved+refund post-adjust. NOTE: the
  // partial/full split compares Σrefunds against valorSemJuros (the pre-refund
  // gross), per the task spec.
  let status: StatusPagamento =
    MP_STATUS_TO_PAGAMENTO[payment.status ?? ''] ?? STATUS_PAGAMENTO.pendente;
  if (status === STATUS_PAGAMENTO.aprovado && refunds > 0 && refunds < valorSemJuros) {
    status = STATUS_PAGAMENTO.estornado_parcialmente;
  } else if (status === STATUS_PAGAMENTO.aprovado && refunds >= valorSemJuros) {
    status = STATUS_PAGAMENTO.estornado;
  }

  const forma = MP_PAYMENT_TYPE_TO_FORMA[payment.payment_type_id ?? ''] ?? FORMA_PAGAMENTO.outros;

  // parcelas — MP sends `installments` as an unvalidated number; normalize to
  // an int ≥ 1 (`pagamentoSchema.parcelas` is int().min(1)) and derive aVista
  // from the NORMALIZED value so the two can never disagree.
  const rawInstallments = payment.installments;
  const parcelas =
    typeof rawInstallments === 'number' && Number.isFinite(rawInstallments)
      ? Math.max(1, Math.trunc(rawInstallments))
      : 1;
  const aVista = parcelas <= 1;

  // Cartao block for card payments. `bandeira` / `cnpj_instituicao` are left
  // null (no new-repo equivalent of the legacy bandeira/CPF-CNPJ mapping);
  // `numeroCartao` carries the last four digits.
  const cartao = CARD_FORMAS.has(forma)
    ? {
        tpIntegra: '2',
        cnpj_instituicao: null,
        numeroCartao: payment.card?.last_four_digits ?? null,
        bandeira: null,
        cAut: payment.authorization_code ?? null,
        tarifa: null,
        tarifaFixa: null,
        prazoRecebimento: null,
      }
    : null;

  const lastProviderUpdate =
    isoToMicros(payment.date_last_updated) ?? isoToMicros(payment.date_created) ?? opts.nowMicros;

  // Attribution (#367): conditional spreads below, never a key set to
  // `undefined` — the Admin SDK rejects it and nothing enables
  // `ignoreUndefinedProperties`.
  const linkPagamentoId = linkPagamentoIdDoPagamento(payment);
  const primeiroNomePagador = primeiroNomeDoPagador(payment);

  const pagamento: Pagamento = {
    id: pagamentoId,
    metodoPagamentoOuterRef: opts.metodoOuterRef,
    forma_de_pagamento: forma,
    status_pagamento: status,
    cartao,
    cheque: null,
    descricaoPagamento: payment.description ?? payment.reason ?? null,
    valor,
    parcelas,
    juros: null,
    tarifas,
    aVista,
    duplicata: false,
    nFat: null,
    vencimento: null,
    // Both blocks belong to a marketplace order's payment diary and its
    // settlement stamp (`pagamentoSchema`'s own docblock): the Shopee order
    // import writes `marketplace`, the weekly escrow sweep writes
    // `liquidacao`. A Mercado Pago gateway payment is written by neither, so
    // `null` is the value, not merely what compiles.
    marketplace: null,
    liquidacao: null,
    ultimaModificacao: opts.nowMicros,
    lastProviderUpdate,
    dataCancelamento: null,
    dataAprovacao: isoToMicros(payment.date_approved),
    dataCadastro: isoToMicros(payment.date_created),
    ...(linkPagamentoId !== null ? { linkPagamentoId } : {}),
    ...(primeiroNomePagador !== null ? { primeiroNomePagador } : {}),
  };

  return { pagamentoId, pagamento };
}
