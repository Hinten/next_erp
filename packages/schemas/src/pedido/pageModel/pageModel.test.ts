import { describe, expect, it } from 'vitest';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO } from '../collection/pagamento';
import { ESTADO_PEDIDO } from '../collection/pedido';
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

  it('flags a referenced NF-e key that does not match CHAVE_NFE_REGEX', () => {
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
    // A valid chave, plus empty/null entries, raise no issue.
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

  describe('a paid troca — the returned items count toward the payment coverage', () => {
    // a troca: total 150, R$ 100 of it comes back as returned items
    const devolvidos = {
      orig1: { p1: [{ precoDeVenda: 100, descontoUnitario: 0, quantidade: 1 }] },
    };
    const troca = {
      itens: { p1: [{ quantidade: 1 }] },
      integracaoPedidoOuterRef: 'x',
      estado: ESTADO_PEDIDO.pago,
      valorCobrado: 150,
      itensDevolvidos: devolvidos,
    };
    const aprovado = (valor: number) => ({ status_pagamento: STATUS_PAGAMENTO.aprovado, valor });

    it('passes when the credit plus the approved payments cover the total', () => {
      expect(paths({ ...troca, pagamentos: [aprovado(50)] })).not.toContain('pagamentos');
    });

    it('NEAR-MISS: fails one cent short', () => {
      expect(paths({ ...troca, pagamentos: [aprovado(49.99)] })).toContain('pagamentos');
    });

    it('NEAR-MISS: without the credit the same payment does not cover it', () => {
      expect(paths({ ...troca, itensDevolvidos: null, pagamentos: [aprovado(50)] })).toContain(
        'pagamentos',
      );
    });

    it('NEAR-MISS: an entrada (ehSaida false) earns no credit', () => {
      expect(paths({ ...troca, ehSaida: false, pagamentos: [aprovado(50)] })).toContain(
        'pagamentos',
      );
      expect(paths({ ...troca, ehSaida: true, pagamentos: [aprovado(50)] })).not.toContain(
        'pagamentos',
      );
    });

    it('keeps the aprovado-only payment filter (an em_disputa payment is not counted here)', () => {
      const emDisputa = { status_pagamento: STATUS_PAGAMENTO.em_disputa, valor: 50 };
      expect(paths({ ...troca, pagamentos: [emDisputa] })).toContain('pagamentos');
    });

    it('does not stack a crédito loja pagamento on top of the credit', () => {
      const creditoLoja = {
        status_pagamento: STATUS_PAGAMENTO.aprovado,
        valor: 100,
        forma_de_pagamento: FORMA_PAGAMENTO.credito_loja,
      };
      // crédito loja 100 replaces the credit: 100 + 50 = 150 covers it ...
      expect(paths({ ...troca, pagamentos: [creditoLoja, aprovado(50)] })).not.toContain(
        'pagamentos',
      );
      // ... but the crédito loja alone is 100 of 150, not 200
      expect(paths({ ...troca, pagamentos: [creditoLoja] })).toContain('pagamentos');
    });
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
