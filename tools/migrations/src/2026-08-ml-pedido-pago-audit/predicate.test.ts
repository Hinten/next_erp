import { describe, expect, it } from 'vitest';
import { STATUS_PAGAMENTO } from '@delfrance/schemas';
import { auditPedidoPago, type PagamentoResumo } from './predicate';

const PATH = 'pedidos/ped-1';

function pag(over: Partial<PagamentoResumo> = {}): PagamentoResumo {
  return {
    id: 'p1',
    valor: 100,
    status_pagamento: STATUS_PAGAMENTO.aprovado,
    fonte: 'pagamentos',
    ...over,
  };
}

function pedido(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { estado: 'pago', valorCobrado: 100, ...over };
}

describe('auditPedidoPago — not a finding', () => {
  it('ignores a pedido that is not at pago', () => {
    expect(auditPedidoPago(PATH, pedido({ estado: 'emProcessamento' }), [])).toBeNull();
  });

  it('ignores a pedido whose approved sum covers valorCobrado', () => {
    expect(auditPedidoPago(PATH, pedido(), [pag()])).toBeNull();
  });

  it('treats exact equality as covered (>=, not >)', () => {
    expect(auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [pag({ valor: 100 })])).toBeNull();
  });

  it('ignores a null valorCobrado — there is no threshold to fall short of', () => {
    expect(auditPedidoPago(PATH, pedido({ valorCobrado: null }), [])).toBeNull();
  });

  it('sums across multiple approved pagamentos before deciding', () => {
    expect(
      auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
        pag({ id: 'a', valor: 60 }),
        pag({ id: 'b', valor: 40 }),
      ]),
    ).toBeNull();
  });

  it('covers at the cent boundary (roundReais, not float drift)', () => {
    expect(
      auditPedidoPago(PATH, pedido({ valorCobrado: 0.3 }), [
        pag({ id: 'a', valor: 0.1 }),
        pag({ id: 'b', valor: 0.2 }),
      ]),
    ).toBeNull();
  });
});

describe('auditPedidoPago — kinds', () => {
  it('never-covered: even summing EVERY status falls short', () => {
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ valor: 40, status_pagamento: STATUS_PAGAMENTO.recusado }),
    ]);
    expect(row).toMatchObject({
      kind: 'never-covered',
      valorCobrado: 100,
      somaAprovada: 0,
      somaTodos: 40,
      deficit: 100,
    });
  });

  it('refunded-after-pago: sum-of-all covers it, approved-only does not', () => {
    // The exact shape the `sumAllValores` advance produced, then a refund.
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ id: 'a', valor: 100, status_pagamento: STATUS_PAGAMENTO.recusado }),
    ]);
    expect(row).toMatchObject({ kind: 'refunded-after-pago', somaAprovada: 0, somaTodos: 100 });
  });

  it('does not count a null status_pagamento as approved', () => {
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ valor: 100, status_pagamento: null }),
    ]);
    expect(row?.somaAprovada).toBe(0);
  });

  it('does not count estornado_parcialmente as approved', () => {
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ valor: 100, status_pagamento: STATUS_PAGAMENTO.estornado_parcialmente }),
    ]);
    expect(row?.somaAprovada).toBe(0);
  });
});

describe('auditPedidoPago — legacy-shape reporting', () => {
  it('marks a row whose payments came only from the legacy singular path', () => {
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ valor: 10, status_pagamento: STATUS_PAGAMENTO.recusado, fonte: 'pagamento' }),
    ]);
    // Not a defect on its own — reading only `pagamentos` would have reported
    // this pedido as having NO payments at all.
    expect(row?.fonte).toBe('pagamento');
  });

  it('marks a row that drew from both paths', () => {
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100 }), [
      pag({ id: 'a', valor: 10, status_pagamento: STATUS_PAGAMENTO.recusado, fonte: 'pagamento' }),
      pag({ id: 'b', valor: 10, status_pagamento: STATUS_PAGAMENTO.recusado, fonte: 'pagamentos' }),
    ]);
    expect(row?.fonte).toBe('ambos');
  });

  it('reads a legacy MILLISECOND stamp as the same instant', () => {
    const ms = Date.parse('2026-08-06T11:24:58.000Z');
    const row = auditPedidoPago(
      PATH,
      pedido({ valorCobrado: 100, lastMarketplaceUpdate: ms, ultimaModificacao: ms }),
      [pag({ valor: 1 })],
    );
    expect(row?.lastMarketplaceUpdate).toBe(ms * 1000);
    expect(row?.ultimaModificacao).toBe(ms * 1000);
  });

  it('reads an already-microsecond stamp unchanged', () => {
    const us = Date.parse('2026-08-06T11:24:58.000Z') * 1000;
    const row = auditPedidoPago(PATH, pedido({ valorCobrado: 100, lastMarketplaceUpdate: us }), [
      pag({ valor: 1 }),
    ]);
    expect(row?.lastMarketplaceUpdate).toBe(us);
  });
});
