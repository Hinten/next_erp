import { describe, expect, it } from 'vitest';
import { roundReais } from '@delfrance/core/money';

import {
  buildPreviewRows,
  calcularPrecoEstrategia,
  ERRO_TAXAS_SOMA,
  passaDirecao,
  type CopiarOutraTabelaEstrategia,
  type DetalhadoEstrategia,
  type EstrategiaInput,
  type PrecoAtualEstrategia,
  type ProdutoParaPreview,
  type ValorFixoEstrategia,
} from './strategies';

const DEFAULT_BOUNDS = { valorMinimo: 0, valorMaximo: 99_999_999 };

function detalhado(overrides: Partial<DetalhadoEstrategia> = {}): DetalhadoEstrategia {
  return {
    tipo: 'detalhado',
    lucro: 0.6,
    tarifaFixa: 6,
    comissao: 0.2,
    imposto: 0.2,
    frete: 0.2,
    marketing: 0.2,
    margemSeguranca: 0.2,
    ...DEFAULT_BOUNDS,
    ...overrides,
  };
}

function valorFixo(overrides: Partial<ValorFixoEstrategia> = {}): ValorFixoEstrategia {
  return { tipo: 'valorFixo', novoPreco: 0, ...DEFAULT_BOUNDS, ...overrides };
}

function precoAtual(overrides: Partial<PrecoAtualEstrategia> = {}): PrecoAtualEstrategia {
  return {
    tipo: 'precoAtual',
    percentual: 0.6,
    valorFixo: 5,
    ...DEFAULT_BOUNDS,
    ...overrides,
  };
}

function copiarOutraTabela(
  overrides: Partial<CopiarOutraTabelaEstrategia> = {},
): CopiarOutraTabelaEstrategia {
  return { tipo: 'copiarOutraTabela', outraListaId: 'outraLista', ...DEFAULT_BOUNDS, ...overrides };
}

function input(overrides: Partial<EstrategiaInput> = {}): EstrategiaInput {
  return { custo: null, precoAtual: null, precoOutraTabela: null, ...overrides };
}

describe('calcularPrecoEstrategia — detalhado', () => {
  it('custo 10 with every legacy default → exactly 132', () => {
    // (10 + 0.6*10 + 6) / (1 - 0.8) * 1.2 = 22 / 0.2 * 1.2 = 132 (roundReais absorbs the fp noise).
    const out = calcularPrecoEstrategia(detalhado(), input({ custo: 10 }));
    expect(out).toEqual({ novo: 132, erro: null, foraDosLimites: false });
  });

  it('custo 0 is VALID — price comes entirely from tarifaFixa → 36', () => {
    // (0 + 0 + 6) / 0.2 * 1.2 = 36.
    const out = calcularPrecoEstrategia(detalhado(), input({ custo: 0 }));
    expect(out).toEqual({ novo: 36, erro: null, foraDosLimites: false });
  });

  it('custo null → exact legacy error, no price', () => {
    const out = calcularPrecoEstrategia(detalhado(), input({ custo: null }));
    expect(out).toEqual({
      novo: null,
      erro: 'Custo do produto não encontrado',
      foraDosLimites: false,
    });
  });

  it('margemSeguranca regression: two calls differing ONLY in margemSeguranca produce different prices', () => {
    const baixa = calcularPrecoEstrategia(
      detalhado({ margemSeguranca: 0.2 }),
      input({ custo: 10 }),
    );
    const alta = calcularPrecoEstrategia(detalhado({ margemSeguranca: 0.5 }), input({ custo: 10 }));
    expect(baixa.novo).toBe(132);
    expect(alta.novo).toBe(165);
    expect(baixa.novo).not.toBe(alta.novo);
  });

  it('taxas summing to exactly 1 → the NEW guard errors instead of producing Infinity', () => {
    const out = calcularPrecoEstrategia(
      detalhado({ comissao: 0.25, imposto: 0.25, frete: 0.25, marketing: 0.25 }),
      input({ custo: 10 }),
    );
    expect(out).toEqual({ novo: null, erro: ERRO_TAXAS_SOMA, foraDosLimites: false });
  });

  it('taxas summing above 1 also errors (not just the boundary)', () => {
    const out = calcularPrecoEstrategia(
      detalhado({ comissao: 0.4, imposto: 0.4, frete: 0.4, marketing: 0.4 }),
      input({ custo: 10 }),
    );
    expect(out.erro).toBe(ERRO_TAXAS_SOMA);
    expect(out.novo).toBeNull();
  });
});

describe('calcularPrecoEstrategia — valorFixo', () => {
  it('passes the input straight through, rounded', () => {
    // Number((10.005).toFixed(2)) === 10.01 for this exact double — verified against the real fn.
    expect(roundReais(10.005)).toBe(10.01);
    const out = calcularPrecoEstrategia(valorFixo({ novoPreco: 10.005 }), input());
    expect(out).toEqual({ novo: 10.01, erro: null, foraDosLimites: false });
  });
});

describe('calcularPrecoEstrategia — precoAtual', () => {
  it('20 with legacy defaults (percentual .6, valorFixo 5) → 20 + 12 + 5 = 37', () => {
    const out = calcularPrecoEstrategia(precoAtual(), input({ precoAtual: 20 }));
    expect(out).toEqual({ novo: 37, erro: null, foraDosLimites: false });
  });

  it('missing price under the target lista → exact legacy error', () => {
    const out = calcularPrecoEstrategia(precoAtual(), input({ precoAtual: null }));
    expect(out).toEqual({
      novo: null,
      erro: 'Este produto não possui preço cadastrado na tabela',
      foraDosLimites: false,
    });
  });
});

describe('calcularPrecoEstrategia — copiarOutraTabela', () => {
  it('copies the source lista price verbatim', () => {
    const out = calcularPrecoEstrategia(copiarOutraTabela(), input({ precoOutraTabela: 42.5 }));
    expect(out).toEqual({ novo: 42.5, erro: null, foraDosLimites: false });
  });

  it('missing price on the source lista → exact legacy error', () => {
    const out = calcularPrecoEstrategia(copiarOutraTabela(), input({ precoOutraTabela: null }));
    expect(out).toEqual({
      novo: null,
      erro: 'Este produto não possui preço na tabela selecionada para copiar',
      foraDosLimites: false,
    });
  });

  it('DEVIATION from legacy: bounds ARE applied to strategy 4 (legacy L680-705 never checked them)', () => {
    const out = calcularPrecoEstrategia(
      copiarOutraTabela({ valorMinimo: 0, valorMaximo: 500 }),
      input({ precoOutraTabela: 1000 }),
    );
    expect(out).toEqual({ novo: null, erro: null, foraDosLimites: true });
  });
});

describe('calcularPrecoEstrategia — bounds are strict on the ROUNDED result', () => {
  it('a result exactly AT valorMinimo passes', () => {
    const out = calcularPrecoEstrategia(
      valorFixo({ novoPreco: 50, valorMinimo: 50, valorMaximo: 100 }),
      input(),
    );
    expect(out).toEqual({ novo: 50, erro: null, foraDosLimites: false });
  });

  it('a result exactly AT valorMaximo passes', () => {
    const out = calcularPrecoEstrategia(
      valorFixo({ novoPreco: 100, valorMinimo: 50, valorMaximo: 100 }),
      input(),
    );
    expect(out).toEqual({ novo: 100, erro: null, foraDosLimites: false });
  });

  it('a result just below valorMinimo is foraDosLimites', () => {
    const out = calcularPrecoEstrategia(
      valorFixo({ novoPreco: 49.99, valorMinimo: 50, valorMaximo: 100 }),
      input(),
    );
    expect(out).toEqual({ novo: null, erro: null, foraDosLimites: true });
  });

  it('a result just above valorMaximo is foraDosLimites', () => {
    const out = calcularPrecoEstrategia(
      valorFixo({ novoPreco: 100.01, valorMinimo: 50, valorMaximo: 100 }),
      input(),
    );
    expect(out).toEqual({ novo: null, erro: null, foraDosLimites: true });
  });
});

describe('passaDirecao', () => {
  it('a produto with NO existing price ALWAYS passes, for every toggle combination', () => {
    const combos: Array<{ aumentar: boolean; baixar: boolean }> = [
      { aumentar: true, baixar: true },
      { aumentar: true, baixar: false },
      { aumentar: false, baixar: true },
      { aumentar: false, baixar: false },
    ];
    for (const dir of combos) {
      expect(passaDirecao(null, 10, dir)).toBe(true);
    }
  });

  // [precoAtual, novo, aumentar, baixar, expected]
  const table: Array<[number, number, boolean, boolean, boolean]> = [
    // Equal values: only "both off" blocks it — legacy's `!baixar && !aumentar`
    // check runs unconditionally, before either equality is ever considered.
    [10, 10, true, false, true],
    [10, 10, false, true, true],
    [10, 10, true, true, true],
    [10, 10, false, false, false],
    // Directional skips: raising blocked when baixar-only; lowering blocked
    // when aumentar-only.
    [15, 10, true, false, false], // decreasing, but baixar is off → skip
    [5, 10, false, true, false], // increasing, but aumentar is off → skip
    [5, 10, true, false, true], // increasing, aumentar on → passes
    [15, 10, false, true, true], // decreasing, baixar on → passes
  ];

  it.each(table)(
    'atual=%s novo=%s aumentar=%s baixar=%s → %s',
    (atual, novo, aumentar, baixar, expected) => {
      expect(passaDirecao(atual, novo, { aumentar, baixar })).toBe(expected);
    },
  );
});

describe('buildPreviewRows', () => {
  function produto(overrides: Partial<ProdutoParaPreview> = {}): ProdutoParaPreview {
    return { id: 'p1', sku: 'SKU1', nome: 'Produto 1', custo: 10, precos: null, ...overrides };
  }

  it('is null-safe when a produto has no precos map at all', () => {
    const rows = buildPreviewRows(
      [produto({ precos: null })],
      'lista1',
      valorFixo({ novoPreco: 20 }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.precoAtual).toBeNull();
    expect(rows[0]!.precoNovo).toBe(20);
    expect(rows[0]!.foraDosLimites).toBe(false);
  });

  it('resolves precoAtual from the target lista key, and precoOutraTabela only for copiarOutraTabela', () => {
    const p = produto({ precos: { lista1: { valor: 40 }, lista2: { valor: 999 } } });
    const rows = buildPreviewRows([p], 'lista1', precoAtual());
    expect(rows[0]!.precoAtual).toBe(40);
    // 40 + 40*0.6 + 5 = 69
    expect(rows[0]!.precoNovo).toBe(69);
  });

  it('sets foraDosLimites on a bounds-skipped row, leaving precoNovo null', () => {
    const p = produto({ custo: 10 });
    const rows = buildPreviewRows(
      [p],
      'lista1',
      detalhado({ valorMinimo: 0, valorMaximo: 10 }), // 132 computed, way above 10
    );
    expect(rows[0]!.foraDosLimites).toBe(true);
    expect(rows[0]!.precoNovo).toBeNull();
    expect(rows[0]!.erro).toBeNull();
  });

  it('carries the erro string through for a produto the strategy cannot compute', () => {
    const p = produto({ custo: null });
    const rows = buildPreviewRows([p], 'lista1', detalhado());
    expect(rows[0]!.erro).toBe('Custo do produto não encontrado');
    expect(rows[0]!.precoNovo).toBeNull();
    expect(rows[0]!.foraDosLimites).toBe(false);
  });

  it('carries produtoId/sku/nome/custo/precos through untouched', () => {
    const precos = { lista1: { valor: 5 } };
    const p = produto({ id: 'abc', sku: 'X1', nome: 'Nome X', custo: 7, precos });
    const rows = buildPreviewRows([p], 'lista1', valorFixo({ novoPreco: 1 }));
    expect(rows[0]).toMatchObject({
      produtoId: 'abc',
      sku: 'X1',
      nome: 'Nome X',
      custo: 7,
      precos,
    });
  });
});
