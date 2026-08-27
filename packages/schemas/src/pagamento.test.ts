import { describe, expect, it } from 'vitest';
import {
  FORMA_PAGAMENTO,
  STATUS_PAGAMENTO,
  isPagamentoPagante,
  metodoPagamentoSchema,
  pagamentoSchema,
  statusToEstadoPedido,
  sumPagamentosPagos,
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
  it('em_disputa → pago — a mediation is a HOLD, not a reversal', () => {
    // Pinned because it is half of an invariant that spans two functions: this
    // one says a disputed payment keeps the pedido paid, and
    // `isPagamentoPagante` below has to agree. They disagreed until #1322.
    expect(statusToEstadoPedido(STATUS_PAGAMENTO.em_disputa)).toBe('pago');
  });
});

describe('isPagamentoPagante / sumPagamentosPagos', () => {
  it('counts null, aprovado and em_disputa — and nothing else', () => {
    // An explicit allow/deny split rather than a loop over the enum: a loop
    // would re-derive the rule from the implementation and could not catch a
    // member silently changing sides.
    const pagantes = [null, undefined, STATUS_PAGAMENTO.aprovado, STATUS_PAGAMENTO.em_disputa];
    for (const s of pagantes) {
      expect(isPagamentoPagante(s), `status ${String(s)} must count as paid`).toBe(true);
    }
    const naoPagantes = [
      STATUS_PAGAMENTO.pendente,
      STATUS_PAGAMENTO.em_revisao,
      STATUS_PAGAMENTO.pago_parcialmente,
      STATUS_PAGAMENTO.em_processo_aprovacao,
      STATUS_PAGAMENTO.recusado,
      STATUS_PAGAMENTO.cancelado,
      STATUS_PAGAMENTO.estornado,
      STATUS_PAGAMENTO.devolvido,
      STATUS_PAGAMENTO.estornado_parcialmente,
      STATUS_PAGAMENTO.estornado_totalmente,
    ];
    for (const s of naoPagantes) {
      expect(isPagamentoPagante(s), `status ${String(s)} must NOT count as paid`).toBe(false);
    }
    // Every member is accounted for on one side or the other — so a NEW status
    // added to the enum fails here instead of silently defaulting to unpaid.
    expect(pagantes.filter((s) => s != null).length + naoPagantes.length).toBe(
      Object.keys(STATUS_PAGAMENTO).length,
    );
  });

  it('a disputed payment still covers the pedido total', () => {
    // ⚠️ The regression. `em_disputa` used to sum to ZERO, so a mediation
    // dropped `valorPago` below the total and `nextPedidoEstado` downgraded a
    // fully-paid pedido to `aguardandoConfirmacaoDePagamento` — on the Mercado
    // Pago webhook path and on the operator's own "reconciliar" button. ML has
    // not moved the money at that point; it holds it as `retained`.
    expect(
      sumPagamentosPagos([{ valor: 100, status_pagamento: STATUS_PAGAMENTO.em_disputa }]),
    ).toBe(100);
    // A real refund is the one that stops covering it — and it arrives through
    // the payments topic, not the claims path.
    expect(sumPagamentosPagos([{ valor: 100, status_pagamento: STATUS_PAGAMENTO.estornado }])).toBe(
      0,
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
