import { describe, expect, it } from 'vitest';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO, type Pagamento } from '@delfrance/schemas';
import {
  EMPTY_PAGAMENTO_FORM,
  formFromPagamento,
  pagamentoDataFromForm,
  pagamentoFieldVisibility,
  remainingToPay,
  validatePagamentoForm,
  type PagamentoFormState,
} from './PagamentoForm';

function form(overrides: Partial<PagamentoFormState> = {}): PagamentoFormState {
  return { ...EMPTY_PAGAMENTO_FORM, ...overrides };
}

describe('EMPTY_PAGAMENTO_FORM', () => {
  it('defaults a new payment to status "aprovado"', () => {
    expect(EMPTY_PAGAMENTO_FORM.status).toBe(String(STATUS_PAGAMENTO.aprovado));
    // …and the converter carries that default through to the wire field.
    expect(pagamentoDataFromForm(form({ valor: 10 }), null).status_pagamento).toBe(
      STATUS_PAGAMENTO.aprovado,
    );
  });
});

describe('validatePagamentoForm', () => {
  it('requires a numeric valor ≥ 0', () => {
    expect(validatePagamentoForm(form({ valor: null }))).toMatch(/valor/i);
    expect(validatePagamentoForm(form({ valor: -1 }))).toMatch(/valor/i);
    expect(validatePagamentoForm(form({ valor: 0 }))).toBeNull();
  });

  it('requires parcelas ≥ 1', () => {
    expect(validatePagamentoForm(form({ valor: 10, parcelas: 0 }))).toMatch(/parcela/i);
    expect(validatePagamentoForm(form({ valor: 10, parcelas: 3 }))).toBeNull();
  });
});

describe('pagamentoDataFromForm', () => {
  it('maps the edited fields and coerces the enum strings', () => {
    // cartão crédito shows parcelas, so the edited 2 is kept.
    const data = pagamentoDataFromForm(
      form({
        forma: String(FORMA_PAGAMENTO.cartao_credito),
        status: String(STATUS_PAGAMENTO.aprovado),
        valor: 99.9,
        parcelas: 2,
        descricao: '  sinal  ',
      }),
      null,
    );
    expect(data).toMatchObject({
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 99.9,
      parcelas: 2,
      descricaoPagamento: 'sinal',
    });
  });

  it('resets fields hidden for the chosen forma to their defaults', () => {
    // Dinheiro hides parcelas/vencimento/nFat/duplicata/aVista → defaults.
    const data = pagamentoDataFromForm(
      form({
        forma: String(FORMA_PAGAMENTO.dinheiro),
        parcelas: 3,
        vencimento: 99,
        nFat: 'NF-9',
        duplicata: true,
        aVista: false,
        valor: 10,
      }),
      null,
    );
    expect(data).toMatchObject({
      parcelas: 1,
      vencimento: null,
      nFat: null,
      duplicata: false,
      aVista: true,
      cartao: null,
      cheque: null,
    });
  });

  it('empty status → null', () => {
    expect(pagamentoDataFromForm(form({ valor: 1, status: '' }), null).status_pagamento).toBeNull();
  });

  it('preserves the passthrough metodoPagamentoOuterRef + dataCadastro from base, and nulls a stale card for a non-card forma', () => {
    const base = {
      cartao: { bandeira: 'visa' },
      cheque: null,
      metodoPagamentoOuterRef: 'documents/metodo_pgto/m1',
      dataCadastro: 42,
    } as unknown as Pagamento;
    // forma defaults to Dinheiro → the card map is reset (forma-managed), but the
    // out-of-band fields survive.
    const data = pagamentoDataFromForm(form({ valor: 5 }), base);
    expect(data).toMatchObject({
      cartao: null,
      metodoPagamentoOuterRef: 'documents/metodo_pgto/m1',
      dataCadastro: 42,
    });
  });
});

describe('pagamentoDataFromForm — card / cheque detail', () => {
  it('builds the embedded cartao map for a card forma and preserves catalog fields', () => {
    const base = { cartao: { tarifa: 2.5, cnpj_instituicao: '123' } } as unknown as Pagamento;
    const data = pagamentoDataFromForm(
      form({
        forma: String(FORMA_PAGAMENTO.cartao_credito),
        valor: 10,
        bandeira: '01',
        numeroCartao: ' 4111 ',
        cAut: 'AUT9',
      }),
      base,
    );
    expect(data.cartao).toEqual({
      tpIntegra: '2',
      tarifa: 2.5, // preserved from the bandeira catalog
      cnpj_instituicao: '123',
      bandeira: '01',
      numeroCartao: '4111',
      cAut: 'AUT9',
    });
    expect(data.cheque).toBeNull();
  });

  it('builds the embedded cheque map and coerces numero to an int', () => {
    const data = pagamentoDataFromForm(
      form({
        forma: String(FORMA_PAGAMENTO.cheque),
        valor: 10,
        banco: 'BB',
        agencia: '0001',
        conta: '123-4',
        numeroCheque: '789',
        titular: 'Fulano',
        cpfCnpj: '12345678900',
        telefone: '11999999999',
        bomPara: 1234,
      }),
      null,
    );
    expect(data.cheque).toEqual({
      banco: 'BB',
      agencia: '0001',
      conta: '123-4',
      numero: 789,
      titular: 'Fulano',
      cpf_cnpj: '12345678900',
      telefone: '11999999999',
      bomPara: 1234,
    });
    expect(data.cartao).toBeNull();
  });

  it('clears cartao/cheque when the forma is neither card nor cheque', () => {
    const data = pagamentoDataFromForm(
      form({ forma: String(FORMA_PAGAMENTO.pix), valor: 5 }),
      null,
    );
    expect(data.cartao).toBeNull();
    expect(data.cheque).toBeNull();
  });
});

describe('pagamentoFieldVisibility — card / cheque groups', () => {
  it('shows the card group for crédito and débito', () => {
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.cartao_credito)).cartao).toBe(true);
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.cartao_debito)).cartao).toBe(true);
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.dinheiro)).cartao).toBe(false);
  });

  it('shows the cheque group only for cheque (which has its own bom-para, not vencimento)', () => {
    const cheque = pagamentoFieldVisibility(String(FORMA_PAGAMENTO.cheque));
    expect(cheque.cheque).toBe(true);
    expect(cheque.vencimento).toBe(false);
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.dinheiro)).cheque).toBe(false);
  });
});

describe('formFromPagamento', () => {
  it('round-trips an existing doc into form state', () => {
    const p = {
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      status_pagamento: STATUS_PAGAMENTO.pendente,
      valor: 50,
      parcelas: 3,
      descricaoPagamento: 'entrada',
      vencimento: 99,
      aVista: false,
      duplicata: true,
      nFat: 'NF-1',
    } as unknown as Pagamento;
    expect(formFromPagamento(p)).toEqual({
      forma: String(FORMA_PAGAMENTO.cartao_credito),
      status: String(STATUS_PAGAMENTO.pendente),
      valor: 50,
      parcelas: 3,
      descricao: 'entrada',
      vencimento: 99,
      aVista: false,
      duplicata: true,
      nFat: 'NF-1',
      // no embedded cartao/cheque on the doc → empty detail fields
      bandeira: '',
      numeroCartao: '',
      cAut: '',
      banco: '',
      agencia: '',
      conta: '',
      numeroCheque: '',
      titular: '',
      cpfCnpj: '',
      telefone: '',
      bomPara: null,
    });
  });

  it('parses the embedded cartao + cheque maps into form fields', () => {
    const card = {
      forma_de_pagamento: FORMA_PAGAMENTO.cartao_credito,
      valor: 10,
      parcelas: 1,
      aVista: true,
      duplicata: false,
      cartao: { tpIntegra: '2', bandeira: '06', numeroCartao: '4111', cAut: 'AUT1', tarifa: 1.5 },
    } as unknown as Pagamento;
    expect(formFromPagamento(card)).toMatchObject({
      bandeira: '06',
      numeroCartao: '4111',
      cAut: 'AUT1',
    });

    const cheque = {
      forma_de_pagamento: FORMA_PAGAMENTO.cheque,
      valor: 10,
      parcelas: 1,
      aVista: true,
      duplicata: false,
      // Realistic µs epoch — microsSinceEpoch passes a µs-magnitude value through.
      cheque: { banco: 'BB', numero: 42, titular: 'Fulano', bomPara: 1_700_000_000_000_000 },
    } as unknown as Pagamento;
    expect(formFromPagamento(cheque)).toMatchObject({
      banco: 'BB',
      numeroCheque: '42',
      titular: 'Fulano',
      bomPara: 1_700_000_000_000_000,
    });
  });

  it('coerces a legacy ISO-8601 cheque.bomPara to µs instead of dropping it', () => {
    const legacy = {
      forma_de_pagamento: FORMA_PAGAMENTO.cheque,
      valor: 10,
      parcelas: 1,
      aVista: true,
      duplicata: false,
      cheque: { bomPara: '2024-01-01T00:00:00.000Z' },
    } as unknown as Pagamento;
    const parsed = formFromPagamento(legacy);
    expect(typeof parsed.bomPara).toBe('number');
    expect(parsed.bomPara).toBe(Date.UTC(2024, 0, 1) * 1000);
  });
});

describe('pagamentoFieldVisibility', () => {
  it('shows installments + à vista for credit card, none for cash', () => {
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.cartao_credito))).toMatchObject({
      parcelas: true,
      aVista: true,
      vencimento: false,
    });
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.dinheiro))).toEqual({
      parcelas: false,
      aVista: false,
      vencimento: false,
      nFat: false,
      duplicata: false,
      cartao: false,
      cheque: false,
    });
  });

  it('shows vencimento + nFat + duplicata for boleto', () => {
    expect(pagamentoFieldVisibility(String(FORMA_PAGAMENTO.boleto_bancario))).toMatchObject({
      vencimento: true,
      nFat: true,
      duplicata: true,
      parcelas: false,
    });
  });
});

describe('remainingToPay', () => {
  it('subtracts the other non-cancelled payments from the total', () => {
    const pagamentos = [
      { id: 'a', valor: 30, status_pagamento: STATUS_PAGAMENTO.aprovado },
      { id: 'b', valor: 20, status_pagamento: STATUS_PAGAMENTO.cancelado },
    ];
    // b is cancelled → not counted; remaining = 100 − 30 = 70.
    expect(remainingToPay(100, pagamentos, null)).toBe(70);
    // editing 'a' → exclude it; b still excluded → remaining = full 100.
    expect(remainingToPay(100, pagamentos, 'a')).toBe(100);
  });

  it('never goes negative', () => {
    expect(remainingToPay(50, [{ id: 'a', valor: 80, status_pagamento: 4 }], null)).toBe(0);
  });

  it('counts only null/aprovado toward coverage (pending does not count)', () => {
    // pendente is NOT aprovado/null → does not reduce the remaining.
    expect(
      remainingToPay(
        100,
        [{ id: 'a', valor: 40, status_pagamento: STATUS_PAGAMENTO.pendente }],
        null,
      ),
    ).toBe(100);
    // null (no status set) DOES count, matching the NFe bundle rule.
    expect(remainingToPay(100, [{ id: 'a', valor: 40, status_pagamento: null }], null)).toBe(60);
  });
});
