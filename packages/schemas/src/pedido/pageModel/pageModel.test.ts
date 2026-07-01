import { describe, expect, it } from 'vitest';
import { pedidoPageBaseSchema, pedidoPageIssues } from './pageModel';

const paths = (input: Parameters<typeof pedidoPageIssues>[0]) =>
  pedidoPageIssues(input).map((i) => i.path);

describe('pedidoPageIssues', () => {
  it('flags an empty order with no integração', () => {
    const p = paths({});
    expect(p).toContain('itens');
    expect(p).toContain('integracaoPedidoOuterRef');
  });

  it('passes a minimal valid order', () => {
    expect(
      pedidoPageIssues({
        itens: { p1: [{ quantidade: 1 }] },
        integracaoPedidoOuterRef: 'documents/integracao/1',
      }),
    ).toEqual([]);
  });

  it('forbids flipping ehSaida on an existing order', () => {
    expect(
      paths({
        id: '1',
        ehSaida: false,
        ehSaidaOriginal: true,
        itens: { p1: [{ quantidade: 1 }] },
        integracaoPedidoOuterRef: 'x',
      }),
    ).toContain('ehSaida');
  });

  it('allows ehSaida unchanged on an existing order', () => {
    expect(
      paths({
        id: '1',
        ehSaida: true,
        ehSaidaOriginal: true,
        itens: { p1: [{ quantidade: 1 }] },
        integracaoPedidoOuterRef: 'x',
      }),
    ).not.toContain('ehSaida');
  });

  it('flags a referenced NF-e key that is not 44 digits', () => {
    const base = { itens: { p1: [{ quantidade: 1 }] }, integracaoPedidoOuterRef: 'x' };
    const valid = '1'.repeat(44);
    // 43 / 45 digits and a non-digit value all fail.
    expect(paths({ ...base, chNFeReferenciadas: ['1'.repeat(43)] })).toContain(
      'chNFeReferenciadas',
    );
    expect(paths({ ...base, chNFeReferenciadas: ['1'.repeat(45)] })).toContain(
      'chNFeReferenciadas',
    );
    expect(paths({ ...base, chNFeReferenciadas: [`${'1'.repeat(43)}A`] })).toContain(
      'chNFeReferenciadas',
    );
    // A valid 44-digit chave, plus empty/null entries, raise no issue.
    expect(paths({ ...base, chNFeReferenciadas: [valid, '', null] })).not.toContain(
      'chNFeReferenciadas',
    );
    expect(paths({ ...base, chNFeReferenciadas: null })).not.toContain('chNFeReferenciadas');
  });

  it('warns when a paid order is underpaid (only when pagamentos supplied)', () => {
    const base = {
      itens: { p1: [{ quantidade: 1 }] },
      integracaoPedidoOuterRef: 'x',
      estado: 'pago' as const,
      valorCobrado: 100,
    };
    expect(paths({ ...base, pagamentos: [{ status_pagamento: 4, valor: 50 }] })).toContain(
      'pagamentos',
    );
    expect(paths({ ...base, pagamentos: [{ status_pagamento: 4, valor: 100 }] })).not.toContain(
      'pagamentos',
    );
    // Without pagamentos in the aggregate the rule stays out of the way.
    expect(paths(base)).not.toContain('pagamentos');
  });
});

describe('pedidoPageBaseSchema', () => {
  it('parses a pedido with transient fields defaulting to null', () => {
    // `integracaoPedidoOuterRef` is `z.unknown()` — the key must be present (the
    // form always defaults it to null); only its value is opaque.
    const out = pedidoPageBaseSchema.parse({ estado: 'iniciado', integracaoPedidoOuterRef: null });
    expect(out.id).toBeNull();
    expect(out.ehSaidaOriginal).toBeNull();
    expect(out.pagamentos).toBeNull();
    expect(out.incidentes).toBeNull();
    expect(out.historicoEstado).toBeNull();
  });
});
