import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  linkPagamentoIdSchema,
  pagamentoSchema,
  type FormaPagamento,
  type StatusPagamento,
} from '@delfrance/schemas';
import { mpPaymentSchema, type MpPayment } from '../src/types';
import { mpPaymentToPagamento } from '../src/mapping/payment';

const OUTER_REF = 'documents/metodo_pgto/acc-1';
const NOW_MICROS = 1_700_000_000_000_000;
/** A link doc id in the shape `newDocId()` mints: 20 chars from [A-Za-z0-9]. */
const LINK_ID = 'aB3dE5gH7jK9mN1pQ3rS';

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

  // Copilot review (#567): over-refunds (chargeback fees / rounding across
  // partial refunds) can push Σrefunds past the gross — valor must clamp at 0,
  // never go negative (pagamentoSchema.valor is min(0)).
  it('over-refund (Σrefunds > valorSemJuros) → valor clamps to 0, still estornado', () => {
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      refunds: [{ amount: 60 }, { amount: 55 }],
    });
    expect(pagamento.valor).toBe(0);
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
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

  // #608: money rounding routes through the canonical `roundReais` (byte-parity
  // with Dart's `duasCasasDecimais` = `double.parse(toStringAsFixed(2))`), NOT
  // the previous local `round2` (`Math.round((v + EPSILON) * 100) / 100`). At an
  // x.xx5 tie the two diverge: the double under 6.555 / 1.005 / 2.675 sits a hair
  // BELOW the tie, so `roundReais` rounds it DOWN while the old `+ EPSILON` nudge
  // pushed it UP. These cases assert the Dart-faithful DOWN result and fail under
  // the removed helper.
  it('rounds valorSemJuros ties from the double, Dart-faithful (6.555 → 6.55, not 6.56)', () => {
    const { pagamento } = map({ transaction_amount: 6.555 });
    expect(pagamento.valor).toBe(6.55);
  });

  it('rounds a valorSemJuros tie down (1.005 → 1.00, not 1.01)', () => {
    const { pagamento } = map({ transaction_amount: 1.005 });
    expect(pagamento.valor).toBe(1);
  });

  it('rounds the refunds sum from the double before the net (refund 2.675 → 2.67, not 2.68)', () => {
    const { pagamento } = map({
      status: 'approved',
      transaction_amount: 100,
      refunds: [{ amount: 2.675 }],
    });
    // refunds 2.67 (Dart-faithful) → valor 100 − 2.67 = 97.33; the old +EPSILON
    // helper rounded the refund to 2.68 and yielded 97.32.
    expect(pagamento.valor).toBe(97.33);
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado_parcialmente);
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

  it('clamps a negative total at 0 — a refunded fee must not fail the write (#794)', () => {
    const { pagamento } = map({
      marketplace_fee: 0,
      fee_details: [{ amount: -2 }],
      // refunded > original: the raw sum is -5.5, which `pagamentoSchema.tarifas`
      // (.min(0)) rejects — a ZodError the pipeline retries until it parks.
      charges_details: [
        { accounts: { from: 'collector', to: 'mp' }, amounts: { original: 4, refunded: 7.5 } },
      ],
    });
    expect(pagamento.tarifas).toBe(0);
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

  // Copilot review (#567): installments arrives unvalidated from the wire —
  // pagamentoSchema.parcelas is int().min(1), so the mapper must normalize.
  it('installments 0 / negative → parcelas clamps to 1, aVista true', () => {
    for (const bad of [0, -2]) {
      const { pagamento } = map({ installments: bad });
      expect(pagamento.parcelas).toBe(1);
      expect(pagamento.aVista).toBe(true);
      expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
    }
  });

  it('fractional installments → truncated int, aVista from the normalized value', () => {
    const { pagamento } = map({ installments: 2.5 });
    expect(pagamento.parcelas).toBe(2);
    expect(pagamento.aVista).toBe(false);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
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
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
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
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
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
      tarifa: null,
      tarifaFixa: null,
      prazoRecebimento: null,
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
    expect(pagamento.ultimaModificacao).toBe(NOW_MICROS);
    expect(pagamento.lastProviderUpdate).toBe(1_672_704_000_000_000);
  });

  it('handles an offset ISO string', () => {
    const iso = '2023-02-22T13:03:47.000-04:00';
    const { pagamento } = map({ date_created: iso });
    expect(pagamento.dataCadastro).toBe(Date.parse(iso) * 1000);
  });

  // The freshness clock (`lastProviderUpdate`) exists to ORDER two deliveries of
  // the same payment. MP sends ISO strings that can carry microseconds; the old
  // `Date.parse(x) * 1000` truncated them to milliseconds and refilled zeros, so
  // two updates a microsecond apart landed on the SAME stamp and the guard could
  // not tell them apart (the lint rule `no-lossy-date-parse` documents the class).
  it('keeps the sub-millisecond digits the provider sent (µs are not zero-filled)', () => {
    const base = Date.UTC(2024, 5, 1, 10, 0, 0, 123) * 1000;
    const { pagamento } = map({ date_created: '2024-06-01T10:00:00.123456Z' });
    expect(pagamento.dataCadastro).toBe(base + 456);
    // Near-miss: a plain millisecond ISO string still scales EXACTLY ×1000.
    expect(map({ date_created: '2024-06-01T10:00:00.123Z' }).pagamento.dataCadastro).toBe(base);
  });

  it('two updates one microsecond apart get distinct lastProviderUpdate stamps', () => {
    const base = Date.UTC(2024, 5, 1, 10, 0, 0, 0) * 1000;
    const a = map({ date_last_updated: '2024-06-01T10:00:00.000001Z' }).pagamento;
    const b = map({ date_last_updated: '2024-06-01T10:00:00.000002Z' }).pagamento;
    expect(a.lastProviderUpdate).toBe(base + 1);
    expect(b.lastProviderUpdate).toBe(base + 2);
  });

  it('an unparseable ISO string is null, never NaN', () => {
    const { pagamento } = map({ date_created: 'not-a-date', date_approved: '' });
    expect(pagamento.dataCadastro).toBeNull();
    expect(pagamento.dataAprovacao).toBeNull();
    // and lastProviderUpdate falls through to `now` instead of a NaN stamp
    expect(pagamento.lastProviderUpdate).toBe(NOW_MICROS);
  });

  it('lastProviderUpdate falls back date_last_updated → date_created → now', () => {
    expect(map({ date_created: '2023-01-01T00:00:00.000Z' }).pagamento.lastProviderUpdate).toBe(
      1_672_531_200_000_000,
    );
    expect(map({}).pagamento.lastProviderUpdate).toBe(NOW_MICROS);
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
    // #367 attribution: both server-owned keys present, and both malformed.
    {
      payment_type_id: 'credit_card',
      status: 'approved',
      transaction_amount: 10,
      metadata: { link_id: LINK_ID },
      payer: { first_name: 'maria clara' },
      card: { last_four_digits: '4242', cardholder: { name: 'FULANO DA SILVA' } },
    },
    {
      payment_type_id: 'credit_card',
      metadata: { link_id: 'a/b' },
      payer: { first_name: 'x@y.com' },
      card: { cardholder: { name: '123.456.789-09' } },
    },
    { metadata: 'garbage', payer: { first_name: 42 } },
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
    expect(parsed.lastProviderUpdate).toBe(pagamento.lastProviderUpdate);
    expect(parsed.dataAprovacao).toBe(pagamento.dataAprovacao);
    expect(parsed.metodoPagamentoOuterRef).toBe(OUTER_REF);
  });
});

/**
 * Tolerance must not change ARITHMETIC.
 *
 * The money fields are not inert: `mpPaymentToPagamento` sums them into `valor`
 * and `tarifas`, `reconcilePedidoFromPagamento` writes the result to Firestore
 * inside a transaction, and it re-sums `valorPago` across the pedido to drive
 * the estado transition. Widening `types.ts` to accept a quoted number is only
 * safe if the number that comes out the other side is the same one (#1251).
 *
 * ⚠️ This suite is the one that matters, because it is the only place in the MP
 * workspaces that builds its fixtures THROUGH `mpPaymentSchema` — the app's own
 * tests cast (`... as MpPayment`) and so cannot see a schema change at all.
 */
describe('a fully-quoted payload maps identically to the numeric one', () => {
  /** Every numeric field, in the shapes a serializer actually emits. */
  const NUMERIC: Record<string, unknown> = {
    payment_type_id: 'credit_card',
    status: 'approved',
    transaction_amount: 1000.02,
    shipping_cost: 15.5,
    installments: 12,
    marketplace_fee: 8.35,
    refunds: [{ amount: 50 }, { amount: 0.5 }],
    fee_details: [{ amount: 4.5, type: 'mercadopago_fee' }, { amount: 1.25 }],
    charges_details: [
      {
        amounts: { original: 30.5, refunded: 10 },
        accounts: { from: 'collector', to: 'mp' },
      },
    ],
  };

  const QUOTED: Record<string, unknown> = {
    ...NUMERIC,
    transaction_amount: '1000.02',
    shipping_cost: '15.5',
    installments: '12',
    marketplace_fee: '8.35',
    refunds: [{ amount: '50' }, { amount: '0.500000' }], // C `%f` on the second
    fee_details: [{ amount: '4.50', type: 'mercadopago_fee' }, { amount: '+1.25' }],
    charges_details: [
      {
        amounts: { original: '30.50', refunded: '10' },
        accounts: { from: 'collector', to: 'mp' },
      },
    ],
  };

  it('produces a byte-identical pagamento', () => {
    expect(map(QUOTED)).toEqual(map(NUMERIC));
  });

  it('and the derived money is the value it always was, not a fresh 0', () => {
    // Spelled out rather than left to the deep-equal: a bug that zeroed BOTH
    // sides would satisfy the assertion above and nothing else.
    const { pagamento } = map(QUOTED);
    expect(pagamento.valor).toBe(965.02); // 1000.02 + 15.5 - 50.5
    expect(pagamento.tarifas).toBe(34.6); // 8.35 + 4.5 + 1.25 + (30.5 - 10)
    expect(pagamento.parcelas).toBe(12);
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.estornado_parcialmente);
  });

  it('⛔ a money field that is not a number still fails the parse, never becomes 0', () => {
    // The whole reason `z.coerce.number()` is banned: a payment recorded as
    // R$ 0,00 reconciles against nothing, and `valor: z.number().min(0)` on the
    // write validator would accept it without a murmur.
    for (const amount of ['', '   ', '1,50', '0x1F', '1e3', 'R$ 100,00', true]) {
      expect(mpPaymentSchema.safeParse({ id: 1, transaction_amount: amount }).success).toBe(false);
    }
  });
});

/**
 * Payment-link attribution (#367): which `linkPgtoMercadoPago` doc issued a
 * payment, and the payer's FIRST name.
 *
 * Both keys are server-owned enrichment on `pagamento`. The rule the whole block
 * pins: a value that is not usable costs the KEY — it is omitted, never written
 * as `undefined` (the Admin SDK rejects it) and never allowed to throw inside the
 * pedido transaction (a throw there reads as transient and parks a REAL payment,
 * the #1087 class). Absence is asserted with `in`, not `toBeUndefined`, because
 * `{ k: undefined }` is exactly the shape that must never reach Firestore.
 */
describe('mpPaymentToPagamento — link attribution (metadata.link_id)', () => {
  it('the fixture id is a well-formed link id (so the absent cases below mean something)', () => {
    expect(linkPagamentoIdSchema.safeParse(LINK_ID).success).toBe(true);
  });

  it('stamps linkPagamentoId from metadata.link_id, and the doc round-trips', () => {
    const { pagamento } = map({ metadata: { link_id: LINK_ID } });
    expect(pagamento.linkPagamentoId).toBe(LINK_ID);
    expect(pagamentoSchema.parse(pagamento).linkPagamentoId).toBe(LINK_ID);
  });

  it('adds ONLY the attribution key — every other field maps as it does without metadata', () => {
    const sem = map({ status: 'approved', transaction_amount: 42.5 }).pagamento;
    const com = map({
      status: 'approved',
      transaction_amount: 42.5,
      metadata: { link_id: LINK_ID, outra_chave: 'x' },
    }).pagamento;
    expect(com).toEqual({ ...sem, linkPagamentoId: LINK_ID });
  });

  // Snake_case ONLY. MP is believed to snake_case metadata keys; a live probe in
  // PR 2 confirms it. Accepting `linkId` too would hide a wrong guess behind a
  // lucky match, so every other spelling must attribute NOTHING.
  it.each<[string, Record<string, unknown>]>([
    ['linkId', { linkId: LINK_ID }],
    ['LinkId', { LinkId: LINK_ID }],
    ['link_Id', { link_Id: LINK_ID }],
    ['linkid', { linkid: LINK_ID }],
    ['link-id', { 'link-id': LINK_ID }],
    ['nested', { meta: { link_id: LINK_ID } }],
  ])('only the snake_case key attributes (%s → absent)', (_label, metadata) => {
    const { pagamento } = map({ metadata });
    expect('linkPagamentoId' in pagamento).toBe(false);
  });

  it.each<[string, unknown]>([
    ['a number', 5],
    ['a boolean', true],
    ['null', null],
    ['an empty string', ''],
    ['a 20-char id containing a slash', 'a/bcdefghijklmnopqrs'],
    ['a 20-char id containing a dash', 'aB3dE5gH7jK9mN1pQ3r-'],
    ['a 21-char id', `${LINK_ID}x`],
    ['a 19-char id', LINK_ID.slice(1)],
    ['an array holding the id', [LINK_ID]],
    ['an object', { id: LINK_ID }],
  ])('a link_id that is %s is not an attribution', (_label, linkId) => {
    const { pagamento } = map({ metadata: { link_id: linkId } });
    expect('linkPagamentoId' in pagamento).toBe(false);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });

  it('no metadata (absent, null or empty) attributes nothing', () => {
    expect('linkPagamentoId' in map({}).pagamento).toBe(false);
    expect('linkPagamentoId' in map({ metadata: null }).pagamento).toBe(false);
    expect('linkPagamentoId' in map({ metadata: {} }).pagamento).toBe(false);
  });

  // The #1087 lesson: `parseOk` validates the whole body, so a bad optional
  // field must be collapsed by the schema, not fail the payment.
  it.each<[string, unknown]>([
    ['a string', 'garbage'],
    ['a number', 5],
    ['a boolean', true],
    ['an array', [LINK_ID]],
  ])('%s metadata still parses (→ null) and the payment maps', (_label, metadata) => {
    expect(mpPaymentSchema.safeParse({ id: 1, metadata }).success).toBe(true);
    expect(build({ metadata }).metadata).toBeNull();
    const { pagamento } = map({ metadata, status: 'approved', transaction_amount: 10 });
    expect(pagamento.status_pagamento).toBe(STATUS_PAGAMENTO.aprovado);
    expect(pagamento.valor).toBe(10);
    expect('linkPagamentoId' in pagamento).toBe(false);
  });

  it('metadata keeps "absent" absent and "null" null on the parsed payment', () => {
    // The `.catch(null)` must not turn a missing key into a present one.
    expect('metadata' in build({})).toBe(false);
    expect(build({ metadata: null }).metadata).toBeNull();
    expect(build({ metadata: { link_id: LINK_ID } }).metadata).toEqual({ link_id: LINK_ID });
  });

  // Legacy stamped the PEDIDO id into `additional_info.items[0].id`; reading it
  // back would attribute every legacy payment to a "link" named after its pedido.
  it('additional_info.items[0].id is NOT a fallback for the link id', () => {
    const items = { additional_info: { items: [{ id: LINK_ID }] } };
    expect('linkPagamentoId' in map(items).pagamento).toBe(false);
    // the legacy shape: the item id IS the external_reference (the pedido id)
    const legacy = map({ external_reference: LINK_ID, ...items });
    expect('linkPagamentoId' in legacy.pagamento).toBe(false);
  });

  it('external_reference does not attribute either (it is the pedido id, verbatim)', () => {
    const { pagamento } = map({ external_reference: LINK_ID });
    expect('linkPagamentoId' in pagamento).toBe(false);
  });
});

describe('mpPaymentToPagamento — primeiroNomePagador (first name only)', () => {
  /** A card payment whose cardholder is `name`. */
  const comTitular = (name: unknown) => ({
    payment_type_id: 'credit_card',
    card: { last_four_digits: '4242', cardholder: { name } },
  });

  it.each([
    ['FULANO DA SILVA', 'Fulano'],
    ['JOSÉ', 'José'],
    ['Ana-Clara Souza', 'Ana-Clara'],
    ['  maria   clara ', 'Maria'],
  ])('cardholder %j → %j', (name, esperado) => {
    const { pagamento } = map(comTitular(name));
    expect(pagamento.primeiroNomePagador).toBe(esperado);
    expect(pagamentoSchema.parse(pagamento).primeiroNomePagador).toBe(esperado);
  });

  it('payer.first_name is used when present', () => {
    const { pagamento } = map({ payer: { first_name: 'maria clara' } });
    expect(pagamento.primeiroNomePagador).toBe('Maria');
  });

  it('payer.first_name WINS over a perfectly good cardholder (source order)', () => {
    const { pagamento } = map({
      payer: { first_name: 'maria clara' },
      ...comTitular('JOAO SILVA'),
    });
    expect(pagamento.primeiroNomePagador).toBe('Maria');
  });

  it('a payer.first_name that is no name falls THROUGH to the cardholder, not to nothing', () => {
    // A `??` on the raw value would stop at the email and drop the name.
    const { pagamento } = map({
      payer: { first_name: 'x@y.com' },
      ...comTitular('MARIA SILVA'),
    });
    expect(pagamento.primeiroNomePagador).toBe('Maria');
  });

  it('a usable first_name beside a junk cardholder still names the payer', () => {
    const { pagamento } = map({ payer: { first_name: 'maria clara' }, ...comTitular('X Y') });
    expect(pagamento.primeiroNomePagador).toBe('Maria');
  });

  it.each([
    ['a Mercado Pago test-card token', 'APRO'],
    ['the same token in lower case', 'apro'],
    ['an email', 'fulano@x.com'],
    ['a CPF', '123.456.789-09'],
    ['a name glued to a CPF', 'MARIA 12345678909'],
    ['a single letter', 'A'],
    ['blank', '  '],
    ['empty', ''],
  ])('%s is not a name → the key is absent', (_label, name) => {
    const { pagamento } = map(comTitular(name));
    expect('primeiroNomePagador' in pagamento).toBe(false);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });

  it('a payment with no payer and no card names nobody', () => {
    expect('primeiroNomePagador' in map({}).pagamento).toBe(false);
    expect('primeiroNomePagador' in map({ payer: null, card: null }).pagamento).toBe(false);
    expect('primeiroNomePagador' in map({ card: { cardholder: null } }).pagamento).toBe(false);
  });

  // For Pix, MP reports the payer's BANK ("long_name" of the bank_info payer),
  // which is a company — not a person, and not ours to put on a payment.
  it('a Pix payment carrying only the payer BANK name has no primeiroNomePagador', () => {
    const pix = {
      payment_type_id: 'bank_transfer',
      point_of_interaction: {
        transaction_data: { bank_info: { payer: { long_name: 'BANCO X' } } },
      },
    };
    expect('primeiroNomePagador' in map(pix).pagamento).toBe(false);
    // near-miss: the bank name is never READ, even beside a real first_name
    expect(map({ ...pix, payer: { first_name: 'ana' } }).pagamento.primeiroNomePagador).toBe('Ana');
  });

  // LGPD: the surname is never stored anywhere on the doc.
  it('never lets the surname reach the pagamento', () => {
    const { pagamento } = map({
      ...comTitular('FULANO DA SILVA'),
      payer: { first_name: 'Beltrano Quintanilha' },
    });
    const json = JSON.stringify(pagamento).toLowerCase();
    for (const sobrenome of ['silva', 'quintanilha']) {
      expect(json).not.toContain(sobrenome);
    }
    expect(pagamento.primeiroNomePagador).toBe('Beltrano');
    // and with only the cardholder, the surname of THAT source stays out too
    const soTitular = JSON.stringify(map(comTitular('FULANO DA SILVA')).pagamento).toLowerCase();
    expect(soTitular).not.toContain('silva');
    expect(soTitular).toContain('fulano');
  });

  // Hostile input: whatever arrives on the wire, the doc must stay writable and
  // a name that survives must be a plain title-cased word.
  const HOSTILE: string[] = [
    '',
    ' ',
    '\t\n',
    'A',
    '12345',
    '123.456.789-09',
    'MARIA 12345678909',
    'fulano@x.com',
    '<script>alert(1)</script>',
    "Robert'); DROP TABLE pagamentos;--",
    'a/b',
    '../../etc/passwd',
    '山田 太郎',
    '👩‍💻',
    '\u0000\u0000',
    'a'.repeat(200),
    'ANA-'.repeat(20),
    "'''",
    '---',
    'Joãó',
    "O'Connor",
    "D'ÁVILA",
    'FULANO  DA SILVA',
    'ÉLODIE',
    'jean-luc picard',
    '‮FULANO',
    'Ｍａｒｉａ',
  ];
  const NOME_LIMPO = /^\p{Lu}[\p{Ll}\p{M}']*(?:-\p{Lu}[\p{Ll}\p{M}']*)*$/u;

  /** A surviving name is a plain title-cased word of 2..20 chars — or the key is absent. */
  function expectLimpoOuAusente(pagamento: { primeiroNomePagador?: string | null }) {
    if (!('primeiroNomePagador' in pagamento)) return;
    const nome = pagamento.primeiroNomePagador ?? '';
    expect(nome).toMatch(NOME_LIMPO);
    expect(nome.length).toBeGreaterThanOrEqual(2);
    expect(nome.length).toBeLessThanOrEqual(20);
  }

  it.each(HOSTILE)('hostile cardholder %j → dropped or cleaned', (name) => {
    const { pagamento } = map(comTitular(name));
    expectLimpoOuAusente(pagamento);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });

  it.each(HOSTILE)('hostile payer.first_name %j → dropped or cleaned', (name) => {
    const { pagamento } = map({ payer: { first_name: name } });
    expectLimpoOuAusente(pagamento);
    expect(() => pagamentoSchema.parse(pagamento)).not.toThrow();
  });

  it('a payer.first_name of the wrong type costs the name, not the payment', () => {
    // `first_name` is enrichment: a number must not fail the whole payment parse.
    expect(mpPaymentSchema.safeParse({ id: 1, payer: { first_name: 42 } }).success).toBe(true);
    const { pagamento } = map({
      payer: { first_name: 42 },
      status: 'approved',
      transaction_amount: 10,
    });
    expect(pagamento.valor).toBe(10);
    expect('primeiroNomePagador' in pagamento).toBe(false);
  });
});
