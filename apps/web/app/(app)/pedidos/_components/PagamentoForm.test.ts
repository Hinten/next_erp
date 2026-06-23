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
    });
  });

  it('empty status → null', () => {
    expect(pagamentoDataFromForm(form({ valor: 1, status: '' }), null).status_pagamento).toBeNull();
  });

  it('preserves the passthrough cartao/cheque/metodoPagamentoOuterRef + dataCadastro from base', () => {
    const base = {
      cartao: { bandeira: 'visa' },
      cheque: null,
      metodoPagamentoOuterRef: 'documents/metodo_pgto/m1',
      dataCadastro: 42,
    } as unknown as Pagamento;
    const data = pagamentoDataFromForm(form({ valor: 5 }), base);
    expect(data).toMatchObject({
      cartao: { bandeira: 'visa' },
      metodoPagamentoOuterRef: 'documents/metodo_pgto/m1',
      dataCadastro: 42,
    });
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
    });
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
});
