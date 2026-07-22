/**
 * Maps a Mercado Livre payment (`GET /collections/{paymentId}`) onto our
 * `pagamento` field set. Ports `MercadoLivrePayment.toPagamento`
 * (legacy `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:4455-4693`)
 * byte-for-byte, onto our field names (`packages/schemas/src/pedido/collection/pagamento.ts`).
 *
 * Pure — no IO, no `Date.now()`. `nowUs` is threaded in by the caller
 * (`ultimaModificacao`'s `DateTime.now()` fallback).
 */
import { roundReais } from '@delfrance/core/money';
import { coerceToMicros } from '@delfrance/core/datetime';
import type { MlPayment, MlPaymentChargeDetail } from '@delfrance/integrations-mercado-livre';
import {
  BANDEIRA,
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  type Bandeira,
  type Cartao,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { statusPagamentoFromMlPaymentStatus } from './orderStatusMaps';

/**
 * Fields `mlPaymentToPagamento` sets — spread onto a `pagamento` doc alongside
 * its schema defaults.
 */
export interface MappedPagamentoFields {
  id: string;
  forma_de_pagamento: FormaPagamento;
  status_pagamento: StatusPagamento;
  cartao: Cartao | null;
  descricaoPagamento: string | null;
  parcelas: number;
  valor: number;
  aVista: boolean;
  duplicata: boolean;
  tarifas: number;
  ultimaModificacao: number;
  dataCadastro: number | null;
  dataAprovacao: number | null;
}

/**
 * `bandeiraEnum.fromNome` (legacy `.old/packages/pedido/lib/src/models.dart:2155-2158`):
 * matches the ENUM MEMBER NAME (not the display label, not the raw ML
 * `payment_method_id` vocabulary — e.g. ML's `"master"` does NOT match
 * `"mastercard"` and falls through to `outros`), case-insensitively.
 * `BANDEIRA`'s keys already are those enum names, so this is a direct lookup.
 */
function bandeiraFromNome(paymentMethodId: string): Bandeira {
  const key = paymentMethodId.toLowerCase() as keyof typeof BANDEIRA;
  return BANDEIRA[key] ?? BANDEIRA.outros;
}

/** `payment.card` is typed down to `last_four_digits` only (see plugin `types.ts`). */
function lastFourDigits(card: MlPayment['card']): string | null {
  return card?.last_four_digits ?? null;
}

/**
 * FORMA_PAGAMENTO switch — legacy `mercadoLivrePaymentType` switch
 * (models.dart:4495-4692). `mercadoLivrePaymentType` is `payment_type ??
 * payment_type_id`.
 */
function formaPagamentoFromMlPaymentType(type: string | null): FormaPagamento {
  switch (type) {
    case 'account_money':
    case 'digital_currency':
    case 'digital_wallet':
      return FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria;
    case 'ticket':
      return FORMA_PAGAMENTO.boleto_bancario;
    case 'bank_transfer':
      return FORMA_PAGAMENTO.deposito_bancario;
    case 'credit_card':
      return FORMA_PAGAMENTO.cartao_credito;
    case 'debit_card':
      return FORMA_PAGAMENTO.cartao_debito;
    case 'atm':
    case 'prepaid_card':
    case 'voucher_card':
    case 'crypto_transfer':
    default:
      return FORMA_PAGAMENTO.outros;
  }
}

/**
 * The embedded `Cartao` block — only built for `credit_card`/`debit_card`
 * (models.dart:4556-4601). Two legacy asymmetries preserved on purpose:
 *  - `numeroCartao` falls back to `card['last_four_digits']` for
 *    `credit_card` ONLY — `debit_card` has no such fallback.
 *  - `tarifaFixa` is set to `marketplace_fee` for `debit_card` ONLY — the
 *    `credit_card` branch has it commented out in legacy
 *    (`// tarifaFixa: marketplace_fee,`).
 */
function buildCartao(
  mercadoLivrePaymentType: string | null,
  payment: MlPayment,
  contaCpfCnpj: string | null,
): Cartao | null {
  if (mercadoLivrePaymentType !== 'credit_card' && mercadoLivrePaymentType !== 'debit_card') {
    return null;
  }

  const bandeira = bandeiraFromNome(payment.payment_method_id ?? '');
  const cardIdStr = payment.card_id != null ? String(payment.card_id) : null;

  if (mercadoLivrePaymentType === 'credit_card') {
    return {
      tpIntegra: '2',
      cnpj_instituicao: contaCpfCnpj,
      numeroCartao: cardIdStr ?? lastFourDigits(payment.card),
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
      bandeira,
      cAut: payment.authorization_code ?? null,
    };
  }

  return {
    tpIntegra: '2',
    cnpj_instituicao: contaCpfCnpj,
    numeroCartao: cardIdStr,
    tarifa: null,
    tarifaFixa: payment.marketplace_fee ?? null,
    prazoRecebimento: null,
    bandeira,
    cAut: payment.authorization_code ?? null,
  };
}

/**
 * `charge_details`/`charges_details[].accounts.from == 'collector' && .to ==
 * 'mp'` filter (models.dart:4479-4480).
 */
function isLojaCharge(detail: MlPaymentChargeDetail): boolean {
  return detail.accounts?.from === 'collector' && detail.accounts?.to === 'mp';
}

/**
 * `tarifas` composition (models.dart:4482-4484):
 * `marketplace_fee + Σfee_details[].amount + Σ(lojaCharge.amounts.original −
 * lojaCharge.amounts.refunded)`, where `chagesDetaisLoja` reads
 * `charge_details` first, falling back to `charges_details` (ML has sent
 * either key across accounts) — NOT both summed.
 */
function computeTarifas(payment: MlPayment): number {
  const feeDetailsSum = (payment.fee_details ?? []).reduce((sum, f) => sum + (f.amount ?? 0), 0);

  const chargeDetails = payment.charge_details ?? payment.charges_details ?? [];
  const chargesLojaSum = chargeDetails
    .filter(isLojaCharge)
    .reduce((sum, cd) => sum + ((cd.amounts?.original ?? 0) - (cd.amounts?.refunded ?? 0)), 0);

  return (payment.marketplace_fee ?? 0) + feeDetailsSum + chargesLojaSum;
}

export function mlPaymentToPagamento(args: {
  payment: MlPayment;
  contaCpfCnpj: string | null;
  nowUs: number;
}): MappedPagamentoFields {
  const { payment, contaCpfCnpj, nowUs } = args;

  // totalPagoSemJuros starts as transaction_amount + shipping_cost, 2dp
  // rounded (models.dart:4460), then gets MUTATED to its net-of-refunds value
  // (models.dart:4473) BEFORE the status-override comparison below — the
  // comparison at 4489-4493 reads the ALREADY-NET value, not the gross one.
  const totalPagoBruto = roundReais(
    (payment.transaction_amount ?? 0) + (payment.shipping_cost ?? 0),
  );

  const refunds = roundReais((payment.refunds ?? []).reduce((sum, r) => sum + (r.amount ?? 0), 0));

  const valor = roundReais(totalPagoBruto - refunds);

  const mercadoLivrePaymentType = payment.payment_type ?? payment.payment_type_id ?? null;

  // last_modified ?? date_last_updated ?? DateTime.now() (models.dart:4477).
  const ultimaModificacao =
    coerceToMicros(payment.last_modified) ?? coerceToMicros(payment.date_last_updated) ?? nowUs;

  const tarifas = computeTarifas(payment);

  let statusPagamento: StatusPagamento = statusPagamentoFromMlPaymentStatus(payment.status ?? '');
  // Refund overrides applied AFTER the base status mapping (models.dart:4489-4493):
  // a partial refund (0 < refunds < net valor) downgrades an `aprovado` payment
  // to `estornado_parcialmente`; a full-or-over refund downgrades it to `estornado`.
  if (statusPagamento === STATUS_PAGAMENTO.aprovado && refunds > 0 && refunds < valor) {
    statusPagamento = STATUS_PAGAMENTO.estornado_parcialmente;
  } else if (statusPagamento === STATUS_PAGAMENTO.aprovado && refunds >= valor) {
    statusPagamento = STATUS_PAGAMENTO.estornado;
  }

  const installments = payment.installments ?? null;

  return {
    id: String(payment.id),
    forma_de_pagamento: formaPagamentoFromMlPaymentType(mercadoLivrePaymentType),
    status_pagamento: statusPagamento,
    cartao: buildCartao(mercadoLivrePaymentType, payment, contaCpfCnpj),
    descricaoPagamento: payment.reason ?? null,
    parcelas: installments ?? 1,
    valor,
    // installments != null && installments > 1 ? false : true (models.dart:4504).
    aVista: !(installments != null && installments > 1),
    duplicata: false,
    tarifas,
    ultimaModificacao,
    dataCadastro: coerceToMicros(payment.date_created),
    dataAprovacao: coerceToMicros(payment.date_approved),
  };
}
