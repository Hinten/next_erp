import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  pagamentoSchema,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { mpPaymentSchema, type MpPayment } from '../src/types';
import { mpPaymentToPagamento } from '../src/mapping/payment';

const OUTER_REF = 'documents/metodo_pgto/acc-1';
const NOW_MICROS = 1_700_000_000_000_000;

/** Parse a raw payload through the API schema, exactly as the client would. */
function build(raw: Record<string, unknown>): MpPayment {
  return mpPaymentSchema.parse({ id: 987654321, ...raw });
}

function map(raw: Record<string, unknown>) {
  return mpPaymentToPagamento(build(raw), {
    metodoOuterRef: OUTER_REF,
    nowMicros: NOW_MICROS,
  });
}

describe('mpPaymentToPagamento — doc id + ref', () => {
  it('uses String(payment.id) for both the returned id and the doc field', () => {
    const { pagamentoId, pagamento } = map({ id: 42 });
    expect(pagamentoId).toBe('42');
    expect(pagamento.id).toBe('42');
  });

  it('stamps the metodoOuterRef verbatim', () => {
    const { pagamento } = map({});
    expect(pagamento.metodoPagamentoOuterRef).toBe(OUTER_REF);
  });
});

describe('mpPaymentToPagamento — payment_type_id → FORMA_PAGAMENTO', () => {
  const cases: Array<[string, FormaPagamento]> = [
    ['credit_card', FORMA_PAGAMENTO.cartao_credito],
    ['debit_card', FORMA_PAGAMENTO.cartao_debito],
    ['ticket', FORMA_PAGAMENTO.boleto_bancario],
    ['bank_transfer', FORMA_PAGAMENTO.deposito_bancario],
    ['account_money', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
    ['digital_currency', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
    ['digital_wallet', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
    ['atm', FORMA_PAGAMENTO.outros],
    ['prepaid_card', FORMA_PAGAMENTO.outros],
    ['voucher_card', FORMA_PAGAMENTO.outros],
    ['crypto_transfer', FORMA_PAGAMENTO.outros],
  ];

  it.each(cases)('%s → %d', (paymentType, expected) => {
    const { pagamento } = map({ payment_type_id: paymentType });
    expect(pagamento.forma_de_pagamento).toBe(expected);
  });

  it('unknown / absent payment_type_id → outros', () => {
    expect(map({ payment_type_id: 'some_future_type' }).pagamento.forma_de_pagamento).toBe(
      FORMA_PAGAMENTO.outros,
    );
    expect(map({}).pagamento.forma_de_pagamento).toBe(FORMA_PAGAMENTO.outros);
  });
});

describe('mpPaymentToPagamento — status → STATUS_PAGAMENTO', () => {
  // No refunds → base mapping (post-adjust only fires on approved+refund).
  const cases: Array<[string, StatusPagamento]> = [
    ['pending', STATUS_PAGAMENTO.pendente],
    ['in_process', STATUS_PAGAMENTO.em_revisao],
    ['authorized', STATUS_PAGAMENTO.em_processo_aprovacao],
    ['approved', STATUS_PAGAMENTO.aprovado],
    ['in_mediation', STATUS_PAGAMENTO.em_disputa],
    ['rejected', STATUS_PAGAMENTO.recusado],
    ['cancelled', STATUS_PAGAMENTO.cancelado],
    ['refunded', STATUS_PAGAMENTO.estornado],
    ['charged_back', STATUS_PAGAMENTO.devolvido],
  ];

  it.each(cases)('%s → %d', (status, expected) => {
    const { pagamento } = map({ status, transaction_amount: 10 });
    expect(pagamento.status_pagamento).toBe(expected);
  });

  it('unknown / absent status → pendente', () => {
    expect(map({ status: 'weird_new_status' }).pagamento.status_pagamento).toBe(
      STATUS_PAGAMENTO.pendente,
    );
    expect(map({}).pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.pendente);
  });
});

describe('mpPaymentToPagamento — approved + refund post-adjust', () => {
  it('partial refund (0 < Σrefunds < valorSemJuros) → estornado_parcialmente', () => {
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      refunds: [{ amount: 30 }],
    });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado_parcialmente);
    expect(pagamento.valor).toBe(70);
  });

  it('partial refund summed across multiple entries', () => {
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      refunds: [{ amount: 20 }, { amount: 10 }],
    });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado_parcialmente);
    expect(pagamento.valor).toBe(70);
  });

  it('full refund (Σrefunds >= valorSemJuros) → estornado, valor 0', () => {
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      refunds: [{ amount: 100 }],
    });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(pagamento.valor).toBe(0);
  });

  it('refund includes shipping in valorSemJuros', () => {
    // gross = 100 + 20 = 120; refund 120 → full → estornado.
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      shipping_cost: 20,
      refunds: [{ amount: 120 }],
    });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(pagamento.valor).toBe(0);
  });

  it('approved with no refunds stays aprovado', () => {
    const { pagamento } = map({ status: 'approved', transaction_amount: 100 });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(pagamento.valor).toBe(100);
  });

  it('post-adjust does not fire for non-approved statuses', () => {
    // refunded already maps to estornado; a refund array must not upgrade a
    // pending payment to a refund state.
    const { pagamento } = map({
      status: 'pending',
      transaction_amount: 100,
      refunds: [{ amount: 30 }],
    });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.pendente);
    expect(pagamento.valor).toBe(70);
  });
});

describe('mpPaymentToPagamento — amounts', () => {
  it('valorSemJuros = transaction_amount + shipping_cost, rounded', () => {
    const { pagamento } = map({ transaction_amount: 10.1, shipping_cost: 5.05 });
    expect(pagamento.valor).toBe(15.15);
  });

  it('missing shipping_cost defaults to 0', () => {
    const { pagamento } = map({ transaction_amount: 49.9 });
    expect(pagamento.valor).toBe(49.9);
  });

  it('cleans float-sum artifacts to 2 decimals', () => {
    const { pagamento } = map({ transaction_amount: 0.1, shipping_cost: 0.2 });
    expect(pagamento.valor).toBe(0.3);
  });
});

describe('mpPaymentToPagamento — tarifas composition', () => {
  it('sums marketplace_fee + fee_details + collector→mp charges, ignoring other pairs', () => {
    const { pagamento } = map({
      marketplace_fee: 1.5,
      fee_details: [{ amount: 2.25 }, { amount: 0.75 }],
      charges_details: [
        { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 3, refunded: 1 } },
        // ignored — wrong `to`
        { accounts: { from: 'collector', to: 'seller' }, amounts: { original: 50, refunded: 0 } },
        // ignored — wrong `from`
        { accounts: { from: 'payer', to: 'mp' }, amounts: { original: 99, refunded: 0 } },
      ],
    });
    // 1.5 + (2.25 + 0.75) + (3 - 1) = 6.5
    expect(pagamento.tarifas).toBeCloseTo(6.5, 8);
  });

  it('defaults every tarifa component to 0 when absent', () => {
    const { pagamento } = map({});
    expect(pagamento.tarifas).toBe(0);
  });

  it('tolerates a charge with missing amounts (treated as 0)', () => {
    const { pagamento } = map({
      marketplace_fee: 2,
      charges_details: [{ accounts: { from: 'collector', to: 'mp' } }],
    });
    expect(pagamento.tarifas).toBe(2);
  });
});

describe('mpPaymentToPagamento — parcelas / aVista', () => {
  it('installments > 1 → parcelas set, aVista false', () => {
    const { pagamento } = map({ installments: 3 });
    expect(pagamento.parcelas).toBe(3);
    expect(pagamento.aVista).toBe(false);
  });

  it('installments === 1 → parcelas 1, aVista true', () => {
    const { pagamento } = map({ installments: 1 });
    expect(pagamento.parcelas).toBe(1);
    expect(pagamento.aVista).toBe(true);
  });

  it('absent installments → parcelas 1, aVista true', () => {
    const { pagamento } = map({});
    expect(pagamento.parcelas).toBe(1);
    expect(pagamento.aVista).toBe(true);
  });
});

describe('mpPaymentToPagamento — cartao block', () => {
  it('credit_card carries the cartao block with last-four + auth code', () => {
    const { pagamento } = map({
      payment_type_id: 'credit_card',
      card: { last_four_digits: '1234' },
      authorization_code: 'AUTH99',
    });
    expect(pagamento.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect(pagamento.cartao).toEqual({
      tpIntegra: '2',
      cnpj_instituicao: null,
      numeroCartao: '1234',
      bandeira: null,
      cAut: 'AUTH99',
    });
  });

  it('debit_card carries the same cartao block shape', () => {
    const { pagamento } = map({
      payment_type_id: 'debit_card',
      card: { last_four_digits: '9876' },
    });
    expect(pagamento.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_debito);
    expect(pagamento.cartao).toEqual({
      tpIntegra: '2',
      cnpj_instituicao: null,
      numeroCartao: '9876',
      bandeira: null,
      cAut: null,
    });
  });

  it('card block tolerates a missing card / last_four_digits', () => {
    const { pagamento } = map({ payment_type_id: 'credit_card' });
    expect(pagamento.cartao).toEqual({
      tpIntegra: '2',
      cnpj_instituicao: null,
      numeroCartao: null,
      bandeira: null,
      cAut: null,
    });
  });

  it('non-card payment types leave cartao null', () => {
    expect(map({ payment_type_id: 'ticket' }).pagamento.cartao).toBeNull();
    expect(map({ payment_type_id: 'account_money' }).pagamento.cartao).toBeNull();
  });
});

describe('mpPaymentToPagamento — descricaoPagamento', () => {
  it('prefers description over reason', () => {
    expect(map({ description: 'desc', reason: 'reas' }).pagamento.descricaoPagamento).toBe('desc');
  });

  it('falls back to reason when description absent', () => {
    expect(map({ reason: 'reas' }).pagamento.descricaoPagamento).toBe('reas');
  });

  it('is null when both absent', () => {
    expect(map({}).pagamento.descricaoPagamento).toBeNull();
  });
});

describe('mpPaymentToPagamento — datetime → microseconds', () => {
  it('converts ISO strings to microseconds (×1000 of Date.parse ms)', () => {
    const { pagamento } = map({
      date_created: '2023-01-01T00:00:00.000Z',
      date_approved: '2023-01-02T00:00:00.000Z',
      date_last_updated: '2023-01-03T00:00:00.000Z',
    });
    expect(pagamento.dataCadastro).toBe(1_672_531_200_000_000);
    expect(pagamento.dataAprovacao).toBe(1_672_617_600_000_000);
    expect(pagamento.ultimaModificacao).toBe(1_672_704_000_000_000);
  });

  it('handles an offset ISO string', () => {
    const iso = '2023-02-22T13:03:47.000-04:00';
    const { pagamento } = map({ date_created: iso });
    expect(pagamento.dataCadastro).toBe(Date.parse(iso) * 1000);
  });

  it('ultimaModificacao falls back date_last_updated → date_created → now', () => {
    expect(map({ date_created: '2023-01-01T00:00:00.000Z' }).pagamento.ultimaModificacao).toBe(
      1_672_531_200_000_000,
    );
    expect(map({}).pagamento.ultimaModificacao).toBe(NOW_MICROS);
  });

  it('dataAprovacao / dataCadastro are null when absent', () => {
    const { pagamento } = map({});
    expect(pagamento.dataAprovacao).toBeNull();
    expect(pagamento.dataCadastro).toBeNull();
  });
});

describe('mpPaymentToPagamento — constant / defaulted fields', () => {
  it('sets cheque, juros, nFat, vencimento, dataCancelamento to null and duplicata false', () => {
    const { pagamento } = map({ payment_type_id: 'account_money' });
    expect(pagamento.cheque).toBeNull();
    expect(pagamento.juros).toBeNull();
    expect(pagamento.nFat).toBeNull();
    expect(pagamento.vencimento).toBeNull();
    expect(pagamento.dataCancelamento).toBeNull();
    expect(pagamento.duplicata).toBe(false);
  });
});

describe('mpPaymentToPagamento — minimal / missing-optional tolerance', () => {
  it('maps a payment carrying only an id', () => {
    const { pagamentoId, pagamento } = map({});
    expect(pagamentoId).toBe('987654321');
    expect(pagamento.forma_de_pagamento).toBe(FORMA_PAGAMENTO.outros);
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.pendente);
    expect(pagamento.valor).toBe(0);
    expect(pagamento.tarifas).toBe(0);
    expect(pagamento.parcelas).toBe(1);
    expect(pagamento.aVista).toBe(true);
    expect(pagamento.cartao).toBeNull();
    expect(pagamento.ultimaModificacao).toBe(NOW_MICROS);
  });
});

describe('mpPaymentToPagamento — every output is wire-valid', () => {
  const payloads: Array<Record<string, unknown>> = [
    {},
    { payment_type_id: 'credit_card', card: { last_four_digits: '1111' }, authorization_code: 'A' },
    { payment_type_id: 'debit_card', card: { last_four_digits: '2222' } },
    { payment_type_id: 'ticket', status: 'pending', transaction_amount: 12.34 },
    { payment_type_id: 'bank_transfer', status: 'approved', transaction_amount: 55.5 },
    { payment_type_id: 'account_money', status: 'in_process', installments: 6 },
    {
      payment_type_id: 'credit_card',
      status: 'approved',
      transaction_amount: 200,
      shipping_cost: 15.5,
      installments: 12,
      refunds: [{ amount: 50 }],
      marketplace_fee: 3.5,
      fee_details: [{ amount: 1.1 }],
      charges_details: [
        { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 2, refunded: 0 } },
      ],
      card: { last_four_digits: '4242' },
      authorization_code: 'AUTHX',
      description: 'Pedido 1',
      date_created: '2024-06-01T10:00:00.000Z',
      date_approved: '2024-06-01T10:05:00.000Z',
      date_last_updated: '2024-06-02T09:00:00.000Z',
    },
    { status: 'refunded', transaction_amount: 80, refunds: [{ amount: 80 }] },
    { status: 'charged_back', transaction_amount: 80 },
    { payment_type_id: 'crypto_transfer', status: 'cancelled' },
  ];

  it.each(payloads)('pagamentoSchema.parse succeeds (#%#)', (raw) => {
    const { pagamento } = map(raw);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });

  it('round-trips without mutating values (representative payload)', () => {
    const { pagamento } = map({
      payment_type_id: 'credit_card',
      status: 'approved',
      transaction_amount: 200,
      shipping_cost: 15.5,
      installments: 12,
      refunds: [{ amount: 50 }],
      card: { last_four_digits: '4242' },
      authorization_code: 'AUTHX',
      description: 'Pedido 1',
      date_created: '2024-06-01T10:00:00.000Z',
      date_approved: '2024-06-01T10:05:00.000Z',
      date_last_updated: '2024-06-02T09:00:00.000Z',
    });
    const parsed = pagamentoSchema.parse(pagamento);
    expect(parsed.valor).toBe(pagamento.valor);
    expect(parsed.status_pagamento).toBe(pagamento.status_pagamento);
    expect(parsed.ultimaModificacao).toBe(pagamento.ultimaModificacao);
    expect(parsed.dataAprovacao).toBe(pagamento.dataAprovacao);
    expect(parsed.metodoPagamentoOuterRef).toBe(OUTER_REF);
  });
});
