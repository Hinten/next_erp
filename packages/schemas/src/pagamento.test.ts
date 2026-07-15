import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  metodoPagamentoSchema,
  pagamentoSchema,
  statusToEstadoPedido,
} from './pedido';

describe('pagamentoSchema', () => {
  it('parses a minimal Pagamento with defaults', () => {
    const out = pagamentoSchema.parse({ valor: 100 });
    expect(out.forma_de_pagamento).toBe(FORMA_PAGAMENTO.dinheiro);
    expect(out.parcelas).toBe(1);
    expect(out.aVista).toBe(true);
    expect(out.duplicata).toBe(false);
  });

  it('rejects negative valor', () => {
    expect(pagamentoSchema.safeParse({ valor: -1 }).success).toBe(false);
  });

  it('rejects parcelas < 1', () => {
    expect(pagamentoSchema.safeParse({ valor: 100, parcelas: 0 }).success).toBe(false);
  });

  it('rejects unknown forma_de_pagamento integers', () => {
    expect(pagamentoSchema.safeParse({ valor: 100, forma_de_pagamento: 7 }).success).toBe(false);
  });

  it('accepts every status from STATUS_PAGAMENTO', () => {
    for (const s of Object.values(STATUS_PAGAMENTO)) {
      expect(pagamentoSchema.safeParse({ valor: 100, status_pagamento: s }).success).toBe(true);
    }
  });

  it('passes cartao/cheque through unchanged (passthrough)', () => {
    const cartao = { last4: '1234', bandeira: 'visa' };
    const out = pagamentoSchema.parse({ valor: 50, cartao });
    expect(out.cartao).toEqual(cartao);
  });
});

describe('statusToEstadoPedido', () => {
  it('aprovado → pago', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.aprovado)).toBe('pago');
  });
  it('recusado → pagamentoNaoRealizado', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.recusado)).toBe('pagamentoNaoRealizado');
  });
  it('cancelado → cancelado', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.cancelado)).toBe('cancelado');
  });
  it('estornado_parcialmente → estornadoParcialmente', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.estornado_parcialmente)).toBe(
      'estornadoParcialmente',
    );
  });
  it('pendente → aguardandoConfirmacaoDePagamento', () => {
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.pendente)).toBe(
      'aguardandoConfirmacaoDePagamento',
    );
  });
});

describe('metodoPagamentoSchema', () => {
  it('parses a Mercado Pago entry', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja' });
    expect(out.tipo).toBe(1);
    expect(out.hasLinkPagamento).toBe(false);
  });
  it('rejects unknown tipo', () => {
    expect(metodoPagamentoSchema.safeParse({ tipo: 999, nome: 'X' }).success).toBe(false);
  });
  it('rejects empty nome', () => {
    expect(metodoPagamentoSchema.safeParse({ tipo: 1, nome: '' }).success).toBe(false);
  });
  it('defaults user_id to null when not OAuth-connected yet', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja' });
    expect(out.user_id).toBeNull();
  });
  it('accepts a denormalized Mercado Pago collector user_id', () => {
    const out = metodoPagamentoSchema.parse({ tipo: 1, nome: 'MP Loja', user_id: 123456789 });
    expect(out.user_id).toBe(123456789);
  });
});
