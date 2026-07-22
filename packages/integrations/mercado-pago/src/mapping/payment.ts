import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  type FormaPagamento,
  type Pagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { roundReais } from '@delfrance/core/money';
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
 */

/**
 * ISO-8601 → microseconds since epoch (the pagamento datetime unit). MP returns
 * ISO strings; `Date.parse` yields **milliseconds**, so scale by 1000. Returns
 * null for a null/absent/unparseable value.
 */
function isoToMicros(iso: string | null | undefined): number | null {
  if (iso == null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms * 1000;
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
  // Left unrounded to mirror legacy exactly.
  const collectorToMpCharges = (payment.charges_details ?? []).filter(
    (c) => c.accounts?.from === 'collector' && c.accounts?.to === 'mp',
  );
  const tarifas =
    (payment.marketplace_fee ?? 0) +
    sumAmounts((payment.fee_details ?? []).map((f) => f.amount)) +
    collectorToMpCharges.reduce<number>(
      (acc, c) => acc + ((c.amounts?.original ?? 0) - (c.amounts?.refunded ?? 0)),
      0,
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
      }
    : null;

  const ultimaModificacao =
    isoToMicros(payment.date_last_updated) ?? isoToMicros(payment.date_created) ?? opts.nowMicros;

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
    ultimaModificacao,
    dataCancelamento: null,
    dataAprovacao: isoToMicros(payment.date_approved),
    dataCadastro: isoToMicros(payment.date_created),
  };

  return { pagamentoId, pagamento };
}
