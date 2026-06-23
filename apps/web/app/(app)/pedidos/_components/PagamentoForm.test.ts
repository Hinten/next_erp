import { describe, expect, it } from 'vitest';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO, type Pagamento } from '@delfrance/schemas';
import {
  EMPTY_PAGAMENTO_FORM,
  formFromPagamento,
  pagamentoDataFromForm,
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
    const data = pagamentoDataFromForm(
      form({
        forma: String(FORMA_PAGAMENTO.pix),
        status: String(STATUS_PAGAMENTO.aprovado),
        valor: 99.9,
        parcelas: 2,
        descricao: '  sinal  ',
        nFat: '',
      }),
      null,
    );
    expect(data).toMatchObject({
      forma_de_pagamento: FORMA_PAGAMENTO.pix,
      status_pagamento: STATUS_PAGAMENTO.aprovado,
      valor: 99.9,
      parcelas: 2,
      descricaoPagamento: 'sinal',
      nFat: null,
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
