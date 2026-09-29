import { describe, expect, it } from 'vitest';
import { impostoProdutoSchema } from '../../impostoProduto';
import { CRT, CSOSN, CST_PIS_COFINS, ORIGEM } from '../../imposto/tribute';
import { produtoPageBaseSchema, produtoPageIssues, produtoPageSchema } from './pageModel';

const baseProduto = { nome: 'Camiseta' };

describe('produtoPageIssues (cross-document rules)', () => {
  it('is empty for a plain non-kit produto', () => {
    expect(produtoPageIssues({ ehKit: false })).toEqual([]);
  });

  it('flags a kit with no components', () => {
    const issues = produtoPageIssues({ ehKit: true, componentesKit: {} });
    expect(issues).toEqual([
      { path: 'componentesKit', message: 'Um kit precisa de ao menos um componente.' },
    ]);
  });

  it('accepts a kit that has components', () => {
    expect(produtoPageIssues({ ehKit: true, componentesKit: { p1: { quantidade: 1 } } })).toEqual(
      [],
    );
  });

  it('flags a produto listed as a component of itself', () => {
    const issues = produtoPageIssues({
      id: 'self',
      ehKit: true,
      componentesKit: { self: { quantidade: 1 } },
    });
    expect(issues).toContainEqual({
      path: 'componentesKit',
      message: 'Um produto não pode ser componente de si mesmo.',
    });
  });

  it('flags a non-kit child whose parent is a kit (child-edit guard, #298)', () => {
    const issues = produtoPageIssues({ parentIsKit: true, ehKit: false });
    expect(issues).toContainEqual({
      path: 'ehKit',
      message: 'Esta variação pertence a um kit; ela também precisa ser um kit.',
    });
  });

  it('accepts a kit child whose parent is a kit', () => {
    expect(
      produtoPageIssues({
        parentIsKit: true,
        ehKit: true,
        componentesKit: { p1: { quantidade: 1 } },
      }),
    ).toEqual([]);
  });

  it('does not flag ehKit when the parent is not a kit', () => {
    expect(produtoPageIssues({ parentIsKit: false, ehKit: false })).toEqual([]);
  });

  it('flags a kit-of-kit when a component is itself a kit (#239, agent path)', () => {
    const issues = produtoPageIssues({
      ehKit: true,
      componentesKit: { p1: { quantidade: 1 }, p2: { quantidade: 1 } },
      componentKitIds: ['p2'],
    });
    expect(issues).toContainEqual({
      path: 'componentesKit',
      message: 'Um kit não pode conter outro kit como componente: p2.',
    });
  });

  it('does not flag kit-of-kit when no component is a kit (empty/absent componentKitIds)', () => {
    expect(
      produtoPageIssues({
        ehKit: true,
        componentesKit: { p1: { quantidade: 1 } },
        componentKitIds: [],
      }),
    ).toEqual([]);
  });

  it('does not flag kit-of-kit for a NON-kit with stale componentKitIds (gated on ehKit)', () => {
    // A non-kit's componentesKit is cleared on save, so its (stale) components
    // are not validated — mirror of the kit-needs-component rule's ehKit gate.
    expect(
      produtoPageIssues({
        ehKit: false,
        componentesKit: { p1: { quantidade: 1 }, p2: { quantidade: 1 } },
        componentKitIds: ['p2'],
      }),
    ).toEqual([]);
  });

  it('flags reserved stock greater than the quantity on hand, keyed by row index', () => {
    const issues = produtoPageIssues({
      estoques: [
        { quantidade: 5, quantidadeReservada: 2 },
        { quantidade: 1, quantidadeReservada: 4 },
      ],
    });
    expect(issues).toEqual([
      {
        path: 'estoques.1.quantidadeReservada',
        message: 'A quantidade reservada não pode ser maior que a quantidade em estoque.',
      },
    ]);
  });

  it('⚠️ flags a NEGATIVE reserved stock — the direction that invents stock (#931)', () => {
    // `disponivel = quantidade − quantidadeReservada`, so a negative reservation
    // *increases* availability: 8 − (−2) = 10. `reservaEfetiva` floors it at
    // every calculation, so it cannot oversell — but until this rule the only
    // trace of the defect was a console.warn nobody reads.
    const issues = produtoPageIssues({
      estoques: [
        { quantidade: 8, quantidadeReservada: 0 },
        { quantidade: 8, quantidadeReservada: -2 },
      ],
    });
    expect(issues).toEqual([
      {
        path: 'estoques.1.quantidadeReservada',
        message:
          'A quantidade reservada não pode ser negativa. Corrija com um balanço na aba Estoque.',
      },
    ]);
  });

  it('reports BOTH reservation problems when a row manages to have each', () => {
    // quantidade −5, reservada −2: negative, and still greater than the
    // quantity. Two independent statements, so neither shadows the other.
    const issues = produtoPageIssues({
      estoques: [{ quantidade: -5, quantidadeReservada: -2 }],
    });
    expect(issues.map((i) => i.path)).toEqual([
      'estoques.0.quantidadeReservada',
      'estoques.0.quantidadeReservada',
    ]);
    // The contract is that BOTH fire, not the order they fire in — swapping the
    // two `if`s upstream is a refactor, not a regression. `arrayContaining`
    // still catches the real failure (one message emitted twice), because each
    // pattern must match some element.
    expect(issues.map((i) => i.message)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/não pode ser negativa/),
        expect.stringMatching(/maior que a quantidade/),
      ]),
    );
  });

  it('does not flag a zero reservation', () => {
    expect(produtoPageIssues({ estoques: [{ quantidade: 0, quantidadeReservada: 0 }] })).toEqual(
      [],
    );
  });
});

describe('produtoPageIssues — a tax config the NF-e engine would reject (#1655)', () => {
  // The rows exactly as the Impostos tab holds them: one per active operação,
  // seeded through `impostoProdutoSchema` (`emptyImposto` / the stored docs).
  const linha = (over: Record<string, unknown> = {}) =>
    impostoProdutoSchema.parse({ impostoOpercaoOuterRef: 'operacao/op1', ...over });
  const emptyRow = linha();
  const icms500 = (csosn500: Record<string, unknown>) => ({
    crt: CRT.simplesNacional,
    csosn: CSOSN.icmsCobradoAnteriormente,
    csosn500,
  });
  const parcial500 = linha({
    origem: ORIGEM.nacional,
    configuracaoICMS: icms500({ pST: 20 }),
  });

  it('flags a reachable row with a half-filled ICMS-ST retido group, keyed by row and field', () => {
    expect(produtoPageIssues({ impostos: [emptyRow, parcial500] })).toContainEqual({
      path: 'impostos.1.configuracaoICMS.csosn500.vBCSTRet',
      message: expect.stringContaining('ICMS-ST retido'),
    });
  });

  it('flags a CST 49 PIS config carrying both rates', () => {
    const ambas = linha({
      origem: ORIGEM.nacional,
      configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0.65, vAliqProd: 0.1 },
    });
    expect(produtoPageIssues({ impostos: [ambas] })).toContainEqual({
      path: 'impostos.0.configuracaoPIS.pPIS',
      message: expect.stringContaining('não as duas'),
    });
  });

  it.each([
    // The e2e shape: a row with CFOP + NCM and no origem is never read by
    // the engine (it fails the impostoSchema tier gate), so it is not blocked.
    ['the same partial row with origem null', linha({ configuracaoICMS: icms500({ pST: 20 }) })],
    [
      'a complete ICMS-ST retido group',
      linha({
        origem: ORIGEM.nacional,
        configuracaoICMS: icms500({ vBCSTRet: 100, pST: 20, vICMSSTRet: 20 }),
      }),
    ],
    [
      'CST 49 with pPIS 0 and vAliqProd 0.5 (0 is "not configured")',
      linha({
        origem: ORIGEM.nacional,
        configuracaoPIS: { CST: CST_PIS_COFINS.outrasOperacoesSaida, pPIS: 0, vAliqProd: 0.5 },
      }),
    ],
  ])('does not flag %s', (_label, row) => {
    expect(produtoPageIssues({ impostos: [emptyRow, row] })).toEqual([]);
  });

  it('does not flag an unvisited Impostos tab (impostos null — seeded lazily)', () => {
    expect(produtoPageIssues({ impostos: null })).toEqual([]);
  });
});

describe('produtoPageSchema (refined aggregate)', () => {
  it('parses a valid aggregate', () => {
    const parsed = produtoPageSchema.parse({
      ...baseProduto,
      ehKit: true,
      componentesKit: { p1: { quantidade: 2 } },
    });
    expect(parsed.nome).toBe('Camiseta');
    expect(parsed.componentesKit?.p1?.limitarEstoque).toBe(true); // kitSchema default
  });

  it('rejects an empty kit and reports the issue on componentesKit', () => {
    const result = produtoPageSchema.safeParse({ ...baseProduto, ehKit: true, componentesKit: {} });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({
          path: ['componentesKit'],
          message: 'Um kit precisa de ao menos um componente.',
        }),
      );
    }
  });

  it('base schema carries the related-document fields with null defaults', () => {
    const parsed = produtoPageBaseSchema.parse(baseProduto);
    expect(parsed.extraData).toBeNull();
    expect(parsed.estoques).toBeNull();
    expect(parsed.impostos).toBeNull();
  });
});
