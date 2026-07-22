import { describe, expect, it } from 'vitest';
import type { MlPayment } from '@delfrance/integrations-mercado-livre';
import { BANDEIRA, FORMA_PAGAMENTO, STATUS_PAGAMENTO } from '@delfrance/schemas';
import { mlPaymentToPagamento } from './orderPaymentMapping';

const NOW_US = 1_753_200_000_000_000;

function payment(over: Partial<MlPayment> = {}): MlPayment {
  return {
    id: 900001,
    status: 'approved',
    date_created: '2026-07-20T10:00:00.000-03:00',
    date_approved: '2026-07-20T10:00:05.000-03:00',
    reason: 'Compra em MLB123',
    transaction_amount: 100,
    installments: 1,
    payment_type: 'credit_card',
    payment_method_id: 'master',
    ...over,
  };
}

describe('mlPaymentToPagamento — status + refund overrides', () => {
  it('maps a plain approved payment with no refunds', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ payment_type: 'account_money', payment_method_id: 'account_money' }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    expect(mapped.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(mapped.valor).toBe(100);
    expect(mapped.forma_de_pagamento).toBe(FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria);
    expect(mapped.cartao).toBeNull();
  });

  it('downgrades an approved payment to estornado_parcialmente on a partial refund', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ refunds: [{ amount: 30 }] }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    // net valor = 100 - 30 = 70; refunds(30) > 0 && refunds(30) < net(70) → parcial.
    expect(mapped.valor).toBe(70);
    expect(mapped.status_pagamento).toBe(STATUS_PAGAMENTO.estornado_parcialmente);
  });

  it('downgrades an approved payment to estornado on a full refund', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ transaction_amount: 100, refunds: [{ amount: 100 }] }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    // net valor = 100 - 100 = 0; refunds(100) >= net(0) → estornado.
    expect(mapped.valor).toBe(0);
    expect(mapped.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('downgrades on a refund total exceeding the paid amount (multiple refund entries)', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ transaction_amount: 50, refunds: [{ amount: 20 }, { amount: 40 }] }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    // net = roundReais(50 - 60) = -10; refunds(60) >= net(-10) → estornado. The
    // PERSISTED valor clamps at 0 (pagamentoSchema.valor is .min(0) — legacy
    // wrote the raw negative, our schema forbids it).
    expect(mapped.valor).toBe(0);
    expect(mapped.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
  });

  it('does NOT override a non-aprovado status even with a refund present', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ status: 'in_process', refunds: [{ amount: 30 }] }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    expect(mapped.status_pagamento).toBe(STATUS_PAGAMENTO.em_revisao);
  });

  it('maps every MERCADOLIVREPAYMENT_STATUS to its STATUS_PAGAMENTO (no refund present)', () => {
    const table: Array<[string, number]> = [
      ['pending', STATUS_PAGAMENTO.pendente],
      ['authorized', STATUS_PAGAMENTO.em_processo_aprovacao],
      ['in_process', STATUS_PAGAMENTO.em_revisao],
      ['in_mediation', STATUS_PAGAMENTO.em_disputa],
      ['rejected', STATUS_PAGAMENTO.recusado],
      ['cancelled', STATUS_PAGAMENTO.cancelado],
      ['refunded', STATUS_PAGAMENTO.estornado],
      ['charged_back', STATUS_PAGAMENTO.devolvido],
    ];
    for (const [status, expected] of table) {
      const mapped = mlPaymentToPagamento({
        payment: payment({ status }),
        contaCpfCnpj: null,
        nowUs: NOW_US,
      });
      expect(mapped.status_pagamento).toBe(expected);
    }
  });
});

describe('mlPaymentToPagamento — tarifas composition', () => {
  it('sums marketplace_fee + fee_details + loja charge_details (collector→mp only)', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        marketplace_fee: 1.5,
        fee_details: [{ amount: 0.5 }, { amount: 0.25 }],
        charge_details: [
          // counted: collector -> mp
          { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 2, refunded: 0.5 } },
          // NOT counted: different account pair
          { accounts: { from: 'collector', to: 'seller' }, amounts: { original: 99, refunded: 0 } },
        ],
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    // 1.5 + (0.5 + 0.25) + (2 - 0.5) = 3.75
    expect(mapped.tarifas).toBeCloseTo(3.75);
  });

  it('falls back to charges_details when charge_details is absent (not both summed)', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        marketplace_fee: 0,
        charges_details: [
          { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 5, refunded: 1 } },
        ],
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    expect(mapped.tarifas).toBe(4);
  });

  it('defaults tarifas to 0 when no fee/charge data is present', () => {
    const mapped = mlPaymentToPagamento({ payment: payment(), contaCpfCnpj: null, nowUs: NOW_US });
    expect(mapped.tarifas).toBe(0);
  });
});

describe('mlPaymentToPagamento — forma_de_pagamento + Cartao', () => {
  it('credit_card: builds Cartao with card_id, bandeira-by-name, and the last_four_digits fallback', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        payment_type: 'credit_card',
        payment_method_id: 'visa',
        card_id: null,
        card: { last_four_digits: '4242' },
        authorization_code: 'AUTH1',
        marketplace_fee: 3,
      }),
      contaCpfCnpj: '11.222.333/0001-44',
      nowUs: NOW_US,
    });

    expect(mapped.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_credito);
    expect(mapped.cartao).toEqual({
      tpIntegra: '2',
      cnpj_instituicao: '11.222.333/0001-44',
      numeroCartao: '4242', // no card_id → falls back to card.last_four_digits (credit_card only)
      tarifa: null,
      tarifaFixa: null, // credit_card never sets tarifaFixa (legacy line is commented out)
      prazoRecebimento: null,
      bandeira: BANDEIRA.visa,
      cAut: 'AUTH1',
    });
  });

  it('credit_card: prefers card_id over the last_four_digits fallback when both are present', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        payment_type: 'credit_card',
        card_id: 123456,
        card: { last_four_digits: '9999' },
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.cartao?.numeroCartao).toBe('123456');
  });

  it('debit_card: sets tarifaFixa from marketplace_fee and has NO last_four_digits fallback', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        payment_type: 'debit_card',
        payment_method_id: 'elo',
        card_id: null,
        card: { last_four_digits: '1111' },
        marketplace_fee: 2.2,
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });

    expect(mapped.forma_de_pagamento).toBe(FORMA_PAGAMENTO.cartao_debito);
    expect(mapped.cartao).toEqual({
      tpIntegra: '2',
      cnpj_instituicao: null,
      numeroCartao: null, // debit_card: no card_id → stays null, no fallback
      tarifa: null,
      tarifaFixa: 2.2,
      prazoRecebimento: null,
      bandeira: BANDEIRA.elo,
      cAut: null,
    });
  });

  it('bandeiraFromNome matches the enum MEMBER NAME, not the raw ML vocabulary — "master" falls to outros', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ payment_type: 'credit_card', payment_method_id: 'master' }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.cartao?.bandeira).toBe(BANDEIRA.outros);
  });

  it('maps every non-card mercadoLivrePaymentType to its FORMA_PAGAMENTO, with no Cartao', () => {
    const table: Array<[string, number]> = [
      ['account_money', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
      ['ticket', FORMA_PAGAMENTO.boleto_bancario],
      ['bank_transfer', FORMA_PAGAMENTO.deposito_bancario],
      ['atm', FORMA_PAGAMENTO.outros],
      ['prepaid_card', FORMA_PAGAMENTO.outros],
      ['digital_currency', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
      ['digital_wallet', FORMA_PAGAMENTO.carteira_digital_transferencia_bancaria],
      ['voucher_card', FORMA_PAGAMENTO.outros],
      ['crypto_transfer', FORMA_PAGAMENTO.outros],
      ['some_unknown_future_type', FORMA_PAGAMENTO.outros],
    ];
    for (const [type, expected] of table) {
      const mapped = mlPaymentToPagamento({
        payment: payment({ payment_type: type, payment_type_id: null }),
        contaCpfCnpj: null,
        nowUs: NOW_US,
      });
      expect(mapped.forma_de_pagamento).toBe(expected);
      expect(mapped.cartao).toBeNull();
    }
  });

  it('falls back to payment_type_id when payment_type is absent', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ payment_type: null, payment_type_id: 'bank_transfer' }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.forma_de_pagamento).toBe(FORMA_PAGAMENTO.deposito_bancario);
  });
});

describe('mlPaymentToPagamento — parcelas/aVista/timestamps', () => {
  it('defaults parcelas to 1 and aVista to true when installments is absent', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ installments: null }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.parcelas).toBe(1);
    expect(mapped.aVista).toBe(true);
  });

  it('aVista is false once installments > 1', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ installments: 3 }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.parcelas).toBe(3);
    expect(mapped.aVista).toBe(false);
  });

  it('installments == 1 stays aVista', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ installments: 1 }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.aVista).toBe(true);
  });

  it('ultimaModificacao prefers last_modified, then date_last_updated, then nowUs', () => {
    const withLastModified = mlPaymentToPagamento({
      payment: payment({
        last_modified: '2026-07-21T00:00:00.000Z',
        date_last_updated: '2026-07-20T00:00:00.000Z',
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(withLastModified.ultimaModificacao).toBe(Date.parse('2026-07-21T00:00:00.000Z') * 1000);

    const withDateLastUpdated = mlPaymentToPagamento({
      payment: payment({ last_modified: null, date_last_updated: '2026-07-20T00:00:00.000Z' }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(withDateLastUpdated.ultimaModificacao).toBe(
      Date.parse('2026-07-20T00:00:00.000Z') * 1000,
    );

    const withNeither = mlPaymentToPagamento({
      payment: payment({ last_modified: null, date_last_updated: null }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(withNeither.ultimaModificacao).toBe(NOW_US);
  });

  it('dataCadastro/dataAprovacao come from date_created/date_approved', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({
        date_created: '2026-07-20T10:00:00.000-03:00',
        date_approved: '2026-07-20T10:00:05.000-03:00',
      }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.dataCadastro).toBe(Date.parse('2026-07-20T10:00:00.000-03:00') * 1000);
    expect(mapped.dataAprovacao).toBe(Date.parse('2026-07-20T10:00:05.000-03:00') * 1000);
  });

  it('dataAprovacao is null when date_approved is absent (payment not yet approved)', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ date_approved: null }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.dataAprovacao).toBeNull();
  });

  it('id is stringified and duplicata is always false', () => {
    const mapped = mlPaymentToPagamento({
      payment: payment({ id: 777 }),
      contaCpfCnpj: null,
      nowUs: NOW_US,
    });
    expect(mapped.id).toBe('777');
    expect(mapped.duplicata).toBe(false);
  });
});
