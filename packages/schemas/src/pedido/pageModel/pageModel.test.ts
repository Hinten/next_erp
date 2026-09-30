import { describe, expect, it } from 'vitest';
import { FORMA_PAGAMENTO, STATUS_PAGAMENTO } from '../collection/pagamento';
import { ESTADO_PEDIDO } from '../collection/pedido';
import { pedidoPageBaseSchema, pedidoPageIssues } from './pageModel';
import { dvChaveAcesso } from '../../chaveAcesso';

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

  it('item-level reference (#330): blocks a bad chave or nItem, never a missing nItem', () => {
    const issues = (dfeReferenciado: { chaveAcesso?: string | null; nItem?: number | null }) =>
      pedidoPageIssues({
        integracaoPedidoOuterRef: 'x',
        itens: { p1: [{ quantidade: 1, dfeReferenciado }] },
      }).map((i) => i.message);
    const VALIDA = '35260514200166000187550010000000071000000011';

    expect(issues({ chaveAcesso: VALIDA, nItem: 3 })).toEqual([]);
    // Whether nItem is REQUIRED depends on the operação — not a save rule.
    expect(issues({ chaveAcesso: VALIDA, nItem: null })).toEqual([]);
    // Near-misses: one check digit off; a regex-valid chave is not enough.
    expect(issues({ chaveAcesso: `${VALIDA.slice(0, 43)}2`, nItem: 1 })).toEqual([
      expect.stringMatching(/chave de acesso inválida/),
    ]);
    expect(issues({ chaveAcesso: '', nItem: 1 })).toEqual([
      expect.stringMatching(/chave de acesso inválida/),
    ]);
    for (const nItem of [0, 991]) {
      expect(issues({ chaveAcesso: VALIDA, nItem })).toEqual([expect.stringMatching(/de 1 a 990/)]);
    }
  });

  it('pagamento antecipado (#331): NF-e 55 with a valid DV, no duplicate, at most 99', () => {
    const issues = (chNFePagamentoAntecipado: string[]) =>
      pedidoPageIssues({
        integracaoPedidoOuterRef: 'x',
        itens: { p1: [{ quantidade: 1 }] },
        chNFePagamentoAntecipado,
      }).map((i) => i.message);
    const NFE = '35260514200166000187550010000000071000000011';
    const NFE_B = '35200714200166000187550010000000071000000018';
    expect(issues([NFE, NFE_B, ''])).toEqual([]);
    // Near-misses: one check digit off, an NFC-e, the same chave twice, 100 chaves.
    expect(issues([`${NFE.slice(0, 43)}2`])).toEqual([expect.stringMatching(/modelo 55/)]);
    expect(issues([`${NFE.slice(0, 20)}65${NFE.slice(22)}`])).toEqual([
      expect.stringMatching(/modelo 55/),
    ]);
    expect(issues([NFE, NFE])).toEqual([expect.stringMatching(/mais de uma vez/)]);
    const cem = Array.from({ length: 100 }, (_, i) => {
      const c43 = `${NFE.slice(0, 25)}${String(i + 1).padStart(9, '0')}${NFE.slice(34, 43)}`;
      return `${c43}${dvChaveAcesso(c43)}`;
    });
    expect(issues(cem)).toEqual([expect.stringMatching(/no máximo 99/)]);
    expect(issues(cem.slice(0, 99))).toEqual([]);
  });

  it('adjustment amounts (#330): blocks a negative amount or a malformed competência only', () => {
    const issues = (ajusteRtc: { vIBS?: number; vCBS?: number; competApur?: string | null }) =>
      pedidoPageIssues({
        integracaoPedidoOuterRef: 'x',
        itens: { p1: [{ quantidade: 1, ajusteRtc }] },
      }).map((i) => i.message);

    expect(issues({ vIBS: 1.5, vCBS: 13.5, competApur: '2026-09' })).toEqual([]);
    // Zero amounts and a missing competência are the TIPO's to judge, at emission.
    expect(issues({ vIBS: 0, vCBS: 0, competApur: null })).toEqual([]);
    for (const bad of [{ vIBS: -0.01, vCBS: 1 }, { vIBS: 1, vCBS: Number.NaN }, { vIBS: 1 }]) {
      expect(issues({ ...bad, competApur: null })).toEqual([
        expect.stringMatching(/iguais ou maiores que zero/),
      ]);
    }
    for (const competApur of ['2026-13', '2026-9', '09/2026']) {
      expect(issues({ vIBS: 1, vCBS: 1, competApur })).toEqual([
        expect.stringMatching(/formato AAAA-MM/),
      ]);
    }
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
