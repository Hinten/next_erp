import { describe, expect, it } from 'vitest';
import {
  PROBLEMA_TABELA_SHOPEE,
  SHOPEE_SIZE_CHART_INPUT_TYPE,
  TIPO_CELULA_TABELA_SHOPEE,
  ecoDivergenteTabelaShopee,
  projetarTabelaShopee,
  tabelaShopeeProjetadaSchema,
  type CelulaTabelaShopee,
  type CelulaTabelaShopeeEntrada,
  type ColunaTabelaShopeeEntrada,
  type DetalheTabelaShopeeEntrada,
  type ProblemaTabelaShopee,
  type TabelaShopeeProjetada,
} from './tabelaDeMedidasShopeeProjecao';

/**
 * The size-chart projector (Shopee step 18, #1526). The happy path is Shopee's
 * OWN documented response sample for `v2.product.get_size_chart_detail`
 * (`testtestt`, 3 × 3 — the page's sample, not survey-c's). Every other chart
 * below is a hand-made variant of it — NOT evidence of what Shopee sends, only
 * of what the projector does when it does.
 */

/** Shopee's doc-sample id — a published sample, never a real shop's template. */
const ID_DO_EXEMPLO = 700024639;

// `get_size_chart_detail`'s documented `response`, verbatim (the envelope and `request_id` dropped),
// one constant per column so a hand-made variant can reuse them.
const COLUNA_NUMERO_DA_DOC: ColunaTabelaShopeeEntrada = {
  measurement: {
    display_name: 'test single input number',
    input_type: 'Input Single Number',
    unit: 'cm',
  },
  measurement_value_list: [
    { max_value: null, min_value: null, option: null, value: 1 },
    { max_value: null, min_value: null, option: null, value: 2 },
    { max_value: null, min_value: null, option: null, value: 3 },
  ],
};
const VALORES_FAIXA_DA_DOC: readonly CelulaTabelaShopeeEntrada[] = [
  { max_value: 13, min_value: 12, option: null, value: null },
  { max_value: 14, min_value: 13, option: null, value: null },
  { max_value: 16, min_value: 14, option: null, value: null },
];
const COLUNA_FAIXA_DA_DOC: ColunaTabelaShopeeEntrada = {
  measurement: {
    display_name: 'susu_input_range_number_with_special_unit_kg',
    input_type: 'Input Range Number',
    unit: 'kg',
  },
  measurement_value_list: VALORES_FAIXA_DA_DOC,
};
const COLUNA_DROPDOWN_DA_DOC: ColunaTabelaShopeeEntrada = {
  measurement: {
    display_name: 'regional 001 dropdowm',
    input_type: 'Single Dropdown',
    unit: 'cm',
  },
  measurement_value_list: [
    { max_value: null, min_value: null, option: '01s', value: null },
    { max_value: null, min_value: null, option: '01m', value: null },
    { max_value: null, min_value: null, option: '01l', value: null },
  ],
};
const EXEMPLO_DA_DOC: DetalheTabelaShopeeEntrada = {
  size_chart_id: 700024639,
  size_chart_name: 'testtestt',
  size_chart_table: {
    column_list: [COLUNA_NUMERO_DA_DOC, COLUNA_FAIXA_DA_DOC, COLUNA_DROPDOWN_DA_DOC],
  },
};

const CHAVES_DO_PROBLEMA = [
  'codigo',
  'coluna',
  'comprimentos',
  'inputType',
  'linha',
  'pedido',
  'recebido',
];
const CHAVES_DA_CELULA = ['maxValue', 'minValue', 'option', 'tipo', 'value'];

/**
 * Projects and checks the two invariants every answer owes its readers: the
 * shared output schema reads it back UNCHANGED (no key it would strip, none it
 * lacks — the route test and `apps/web` parse with that schema), and every
 * problem / cell carries exactly its keys.
 */
function projetar(id: number, detalhe: DetalheTabelaShopeeEntrada): TabelaShopeeProjetada {
  const tabela = projetarTabelaShopee(id, detalhe);
  expect(tabelaShopeeProjetadaSchema.parse(tabela)).toEqual(tabela);
  for (const p of tabela.problemas) expect(Object.keys(p).sort()).toEqual(CHAVES_DO_PROBLEMA);
  for (const c of tabela.colunas.flatMap((coluna) => coluna.celulas)) {
    expect(Object.keys(c).sort()).toEqual(CHAVES_DA_CELULA);
  }
  return tabela;
}

// --- hand-made building blocks -------------------------------------------------

/** A wire cell with the four keys Shopee sends, `null` unless named. */
function cel(v: Partial<CelulaTabelaShopeeEntrada> = {}): CelulaTabelaShopeeEntrada {
  return { option: null, value: null, min_value: null, max_value: null, ...v };
}

function col(
  input_type: string | null,
  celulas: readonly (CelulaTabelaShopeeEntrada | null)[] | null,
  medida: { display_name?: string | null; unit?: string | null } = {},
): ColunaTabelaShopeeEntrada {
  return {
    measurement: {
      display_name: medida.display_name ?? 'medida',
      input_type,
      unit: medida.unit ?? 'cm',
    },
    measurement_value_list: celulas,
  };
}

function tabela(
  column_list: readonly (ColunaTabelaShopeeEntrada | null)[] | null,
): DetalheTabelaShopeeEntrada {
  return {
    size_chart_id: ID_DO_EXEMPLO,
    size_chart_name: 'variante',
    size_chart_table: { column_list },
  };
}

const { opcao: DROPDOWN, numero: NUMERO, faixa: FAIXA } = SHOPEE_SIZE_CHART_INPUT_TYPE;

function opcao(option: string): CelulaTabelaShopee {
  return {
    tipo: TIPO_CELULA_TABELA_SHOPEE.opcao,
    option,
    value: null,
    minValue: null,
    maxValue: null,
  };
}
function numero(value: number): CelulaTabelaShopee {
  return {
    tipo: TIPO_CELULA_TABELA_SHOPEE.numero,
    option: null,
    value,
    minValue: null,
    maxValue: null,
  };
}
function faixa(minValue: number, maxValue: number): CelulaTabelaShopee {
  return { tipo: TIPO_CELULA_TABELA_SHOPEE.faixa, option: null, value: null, minValue, maxValue };
}
const INVALIDA: CelulaTabelaShopee = {
  tipo: TIPO_CELULA_TABELA_SHOPEE.invalida,
  option: null,
  value: null,
  minValue: null,
  maxValue: null,
};

function prob(
  codigo: string,
  campos: Partial<Omit<ProblemaTabelaShopee, 'codigo'>> = {},
): ProblemaTabelaShopee {
  return {
    codigo,
    coluna: null,
    linha: null,
    inputType: null,
    comprimentos: null,
    pedido: null,
    recebido: null,
    ...campos,
  };
}

/** The single cell of a one-column, one-row chart, and its problems. */
function umaCelula(inputType: string | null, c: CelulaTabelaShopeeEntrada | null) {
  const t = projetar(ID_DO_EXEMPLO, tabela([col(inputType, [c])]));
  return { celula: t.colunas[0]?.celulas[0], problemas: t.problemas };
}

// ------------------------------------------------------------------------------

describe('the wire contract of the constants', () => {
  it('pins the three input_type spellings Shopee documents — human strings WITH spaces', () => {
    expect(SHOPEE_SIZE_CHART_INPUT_TYPE).toEqual({
      opcao: 'Single Dropdown',
      numero: 'Input Single Number',
      faixa: 'Input Range Number',
    });
  });

  it('pins the tipo and codigo spellings apps/web reads (a rename is a deploy-skew break)', () => {
    expect(TIPO_CELULA_TABELA_SHOPEE).toEqual({
      opcao: 'opcao',
      numero: 'numero',
      faixa: 'faixa',
      invalida: 'invalida',
    });
    expect(PROBLEMA_TABELA_SHOPEE).toEqual({
      semColunas: 'sem-colunas',
      colunaIlegivel: 'coluna-ilegivel',
      colunaSemMedida: 'coluna-sem-medida',
      tipoDeEntradaDesconhecido: 'tipo-de-entrada-desconhecido',
      celulaIlegivel: 'celula-ilegivel',
      celulaSemValor: 'celula-sem-valor',
      celulaAmbigua: 'celula-ambigua',
      faixaIncompleta: 'faixa-incompleta',
      tabelaIrregular: 'tabela-irregular',
      idDivergente: 'id-divergente',
    });
  });
});

describe("projetarTabelaShopee — Shopee's own doc sample (testtestt, 3 × 3)", () => {
  it('projects three columns, three rows and no problem', () => {
    const t = projetar(ID_DO_EXEMPLO, EXEMPLO_DA_DOC);

    expect(t.sizeChartId).toBe(ID_DO_EXEMPLO);
    expect(t.sizeChartName).toBe('testtestt');
    expect(t.problemas).toEqual([]);
    expect(t.colunas).toEqual([
      {
        displayName: 'test single input number',
        inputType: 'Input Single Number',
        unit: 'cm',
        celulas: [numero(1), numero(2), numero(3)],
      },
      {
        displayName: 'susu_input_range_number_with_special_unit_kg',
        inputType: 'Input Range Number',
        unit: 'kg',
        celulas: [faixa(12, 13), faixa(13, 14), faixa(14, 16)],
      },
      {
        displayName: 'regional 001 dropdowm',
        inputType: 'Single Dropdown',
        // ⚠️ Shopee sends a unit on the DROPDOWN column too — kept on the column, never on the cell.
        unit: 'cm',
        celulas: [opcao('01s'), opcao('01m'), opcao('01l')],
      },
    ]);
  });

  it('builds row i from the i-th cell of every column, column order kept', () => {
    const t = projetar(ID_DO_EXEMPLO, EXEMPLO_DA_DOC);

    expect(t.linhas).toEqual([
      [numero(1), faixa(12, 13), opcao('01s')],
      [numero(2), faixa(13, 14), opcao('01m')],
      [numero(3), faixa(14, 16), opcao('01l')],
    ]);
  });

  it('survives the HTTP boundary unchanged — JSON out, the shared schema back in', () => {
    const t = projetar(ID_DO_EXEMPLO, EXEMPLO_DA_DOC);
    const lida = tabelaShopeeProjetadaSchema.parse(
      JSON.parse(JSON.stringify({ tabela: t })).tabela,
    );
    expect(lida).toEqual(t);
  });

  it('keeps a fractional number as sent (the page types the values float)', () => {
    expect(umaCelula(NUMERO, cel({ value: 50.5 })).celula).toEqual(numero(50.5));
    expect(umaCelula(FAIXA, cel({ min_value: 52.5, max_value: 54.25 })).celula).toEqual(
      faixa(52.5, 54.25),
    );
  });

  it('copies display_name, unit and size_chart_name verbatim — no trim', () => {
    const t = projetar(ID_DO_EXEMPLO, {
      size_chart_id: ID_DO_EXEMPLO,
      size_chart_name: ' Camiseta Básica ',
      size_chart_table: {
        column_list: [col(NUMERO, [cel({ value: 1 })], { display_name: ' Busto ', unit: ' cm ' })],
      },
    });
    expect(t.sizeChartName).toBe(' Camiseta Básica ');
    expect(t.colunas[0]).toMatchObject({ displayName: ' Busto ', unit: ' cm ' });
  });
});

describe('rectangularity — rows are never zipped, padded or truncated', () => {
  it('a SHORT column makes the table irregular: linhas null, every column keeps its own cells', () => {
    // Hand-made: the doc sample with the range column's last cell dropped.
    const curta = {
      ...COLUNA_FAIXA_DA_DOC,
      measurement_value_list: VALORES_FAIXA_DA_DOC.slice(0, 2),
    };
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([COLUNA_NUMERO_DA_DOC, curta, COLUNA_DROPDOWN_DA_DOC]),
    );

    expect(t.linhas).toBeNull();
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tabelaIrregular, { comprimentos: [3, 2, 3] }),
    ]);
    // Neither padded with blanks nor the others truncated to the shortest.
    expect(t.colunas.map((c) => c.celulas)).toEqual([
      [numero(1), numero(2), numero(3)],
      [faixa(12, 13), faixa(13, 14)],
      [opcao('01s'), opcao('01m'), opcao('01l')],
    ]);
  });

  it('a LONG column is irregular too — the extra cell is not dropped to make rows', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        col(NUMERO, [cel({ value: 1 }), cel({ value: 2 })]),
        col(DROPDOWN, [cel({ option: 'P' }), cel({ option: 'M' }), cel({ option: 'G' })]),
      ]),
    );
    expect(t.linhas).toBeNull();
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tabelaIrregular, { comprimentos: [2, 3] }),
    ]);
    expect(t.colunas[1]?.celulas).toEqual([opcao('P'), opcao('M'), opcao('G')]);
  });

  it('a column whose measurement_value_list is null reads as EMPTY, so beside full columns it is irregular', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([col(NUMERO, null), col(DROPDOWN, [cel({ option: 'P' })])]),
    );
    expect(t.colunas[0]?.celulas).toEqual([]);
    expect(t.linhas).toBeNull();
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tabelaIrregular, { comprimentos: [0, 1] }),
    ]);
  });

  it('columns that are all empty make a table with headers and no row — not sem-colunas', () => {
    const t = projetar(ID_DO_EXEMPLO, tabela([col(NUMERO, []), col(DROPDOWN, null)]));
    expect(t.colunas).toHaveLength(2);
    expect(t.linhas).toEqual([]);
    expect(t.problemas).toEqual([]);
  });

  it('one readable column is rectangular by itself', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([col(DROPDOWN, [cel({ option: 'P' }), cel({ option: 'M' })])]),
    );
    expect(t.linhas).toEqual([[opcao('P')], [opcao('M')]]);
  });
});

describe('type-first cells — the column type names the ONE key a cell is read from', () => {
  it('reads a zero-filled dropdown cell as its option, with no problem (Shopee zero-fills absent numerics)', () => {
    // Under a shape-first rule this cell has three shapes and would be ambiguous — every cell of a live chart.
    const r = umaCelula(DROPDOWN, cel({ option: 'M', value: 0, min_value: 0, max_value: 0 }));
    expect(r.celula).toEqual(opcao('M'));
    expect(r.problemas).toEqual([]);
  });

  it('reads 0 as a VALUE on a number or range column, never as absent', () => {
    expect(umaCelula(NUMERO, cel({ option: '', value: 0, min_value: 0, max_value: 0 }))).toEqual({
      celula: numero(0),
      problemas: [],
    });
    expect(umaCelula(FAIXA, cel({ value: 0, min_value: 0, max_value: 0 }))).toEqual({
      celula: faixa(0, 0),
      problemas: [],
    });
  });

  it('never reads a key the dropdown type does not name: option null + value 3 is NOT "3"', () => {
    for (const c of [cel({ value: 3 }), cel({ min_value: 1, max_value: 2 })]) {
      expect(umaCelula(DROPDOWN, c)).toEqual({
        celula: INVALIDA,
        problemas: [prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 0 })],
      });
    }
  });

  it('never reads a key the single-number type does not name', () => {
    for (const c of [
      cel({ option: 'M' }),
      cel({ min_value: 1, max_value: 2 }),
      cel({ min_value: 4 }),
    ]) {
      expect(umaCelula(NUMERO, c)).toEqual({
        celula: INVALIDA,
        problemas: [prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 0 })],
      });
    }
  });

  it('never reads a key the range type does not name', () => {
    for (const c of [cel({ value: 5 }), cel({ option: 'M' })]) {
      expect(umaCelula(FAIXA, c)).toEqual({
        celula: INVALIDA,
        problemas: [prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 0 })],
      });
    }
  });

  it('an empty or blank option is no value; an option with edge spaces is kept VERBATIM', () => {
    for (const vazia of ['', '  ', '\t']) {
      expect(umaCelula(DROPDOWN, cel({ option: vazia }))).toEqual({
        celula: INVALIDA,
        problemas: [prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 0 })],
      });
    }
    expect(umaCelula(DROPDOWN, cel({ option: ' M' })).celula).toEqual(opcao(' M'));
    expect(umaCelula(DROPDOWN, cel({ option: 'M ' })).celula).toEqual(opcao('M '));
  });

  it('a range with one bound is incomplete and carries NEITHER bound', () => {
    for (const c of [cel({ min_value: 14 }), cel({ max_value: 16 })]) {
      expect(umaCelula(FAIXA, c)).toEqual({
        celula: INVALIDA,
        problemas: [prob(PROBLEMA_TABELA_SHOPEE.faixaIncompleta, { coluna: 0, linha: 0 })],
      });
    }
  });

  it('a range with no bound has no value', () => {
    expect(umaCelula(FAIXA, cel())).toEqual({
      celula: INVALIDA,
      problemas: [prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 0 })],
    });
  });

  it('never reorders a range: min 14 / max 12 stays 14–12', () => {
    expect(umaCelula(FAIXA, cel({ min_value: 14, max_value: 12 }))).toEqual({
      celula: faixa(14, 12),
      problemas: [],
    });
  });

  it('reports a cell problem at its (coluna, linha), wire positions', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        col(NUMERO, [cel({ value: 1 }), cel({ value: 2 })]),
        col(DROPDOWN, [cel({ option: 'P' }), cel({ value: 9 })]),
      ]),
    );
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 1, linha: 1 }),
    ]);
    expect(t.linhas).toEqual([
      [numero(1), opcao('P')],
      [numero(2), INVALIDA],
    ]);
  });
});

describe('the input_type match is verbatim — the fold applies to the exact spelling and stops there', () => {
  it('EQUAL: each documented spelling selects its type-first reader (zero-fill renders, no problem)', () => {
    const zeroFill = { value: 0, min_value: 0, max_value: 0 };
    expect(umaCelula('Single Dropdown', cel({ ...zeroFill, option: 'M' }))).toEqual({
      celula: opcao('M'),
      problemas: [],
    });
    expect(umaCelula('Input Single Number', cel({ ...zeroFill, value: 7 })).celula).toEqual(
      numero(7),
    );
    expect(
      umaCelula('Input Range Number', cel({ ...zeroFill, min_value: 1, max_value: 2 })).celula,
    ).toEqual(faixa(1, 2));
  });

  it('DISTINCT: a case or space variant is an UNKNOWN type — one column problem, shape-first cells', () => {
    for (const variante of [
      'single dropdown',
      'Single dropdown',
      'Single Dropdown ',
      ' Single Dropdown',
      'SingleDropdown',
    ]) {
      const r = umaCelula(variante, cel({ option: 'M' }));
      expect(r.celula, variante).toEqual(opcao('M'));
      expect(r.problemas, variante).toEqual([
        prob(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, { coluna: 0, inputType: variante }),
      ]);
    }
  });
});

describe('unknown or absent input_type — ONE column problem, shape-first cells', () => {
  it('renders single-shape cells and flags several / none / a lone bound', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        col('Input Multi Number', [
          cel({ value: 1 }),
          cel({ option: 'M' }),
          cel({ min_value: 1, max_value: 2 }),
          cel({ option: 'M', value: 1 }),
          cel(),
          cel({ min_value: 1 }),
        ]),
      ]),
    );
    expect(t.colunas[0]?.celulas).toEqual([
      numero(1),
      opcao('M'),
      faixa(1, 2),
      INVALIDA,
      INVALIDA,
      INVALIDA,
    ]);
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, {
        coluna: 0,
        inputType: 'Input Multi Number',
      }),
      prob(PROBLEMA_TABELA_SHOPEE.celulaAmbigua, { coluna: 0, linha: 3 }),
      prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 0, linha: 4 }),
      prob(PROBLEMA_TABELA_SHOPEE.faixaIncompleta, { coluna: 0, linha: 5 }),
    ]);
  });

  it('raises the type problem ONCE per column, not once per cell', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        col('Input Multi Number', [cel({ value: 1 }), cel({ value: 2 }), cel({ value: 3 })]),
      ]),
    );
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, {
        coluna: 0,
        inputType: 'Input Multi Number',
      }),
    ]);
  });

  it('cannot guess a zero-filled cell without a type: it is ambiguous (why known types read type-first)', () => {
    const r = umaCelula(
      'Input Multi Number',
      cel({ option: 'M', value: 0, min_value: 0, max_value: 0 }),
    );
    expect(r.celula).toEqual(INVALIDA);
    expect(r.problemas[1]).toEqual(
      prob(PROBLEMA_TABELA_SHOPEE.celulaAmbigua, { coluna: 0, linha: 0 }),
    );
  });

  it('a lone bound beside a value is ambiguous, not a half range', () => {
    const r = umaCelula('Input Multi Number', cel({ value: 3, max_value: 4 }));
    expect(r.celula).toEqual(INVALIDA);
    expect(r.problemas[1]).toEqual(
      prob(PROBLEMA_TABELA_SHOPEE.celulaAmbigua, { coluna: 0, linha: 0 }),
    );
  });

  it('a blank option is no shape — beside a value the cell is that value', () => {
    expect(umaCelula('Input Multi Number', cel({ option: ' ', value: 3 })).celula).toEqual(
      numero(3),
    );
  });

  it('input_type null with a measurement present: the problem carries inputType null, header verbatim', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([col(null, [cel({ value: 1 })], { display_name: 'Busto', unit: 'cm' })]),
    );
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, { coluna: 0, inputType: null }),
    ]);
    expect(t.colunas).toEqual([
      { displayName: 'Busto', inputType: null, unit: 'cm', celulas: [numero(1)] },
    ]);
  });

  it('measurement null: coluna-sem-medida only (no type problem), the column KEPT and counted, cells shape-first', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        { measurement: null, measurement_value_list: [cel({ option: 'P' }), cel({ value: 2 })] },
        col(NUMERO, [cel({ value: 1 }), cel({ value: 2 })]),
      ]),
    );
    expect(t.problemas).toEqual([prob(PROBLEMA_TABELA_SHOPEE.colunaSemMedida, { coluna: 0 })]);
    expect(t.colunas[0]).toEqual({
      displayName: null,
      inputType: null,
      unit: null,
      celulas: [opcao('P'), numero(2)],
    });
    expect(t.linhas).toEqual([
      [opcao('P'), numero(1)],
      [numero(2), numero(2)],
    ]);
  });
});

describe('unreadable sentinels — positions are kept', () => {
  it('a null cell is invalida + celula-ilegivel at its own row; the cells after it keep theirs', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        col(NUMERO, [cel({ value: 1 }), null, cel({ value: 3 })]),
        col(DROPDOWN, [cel({ option: 'P' }), cel({ option: 'M' }), cel({ option: 'G' })]),
      ]),
    );
    expect(t.colunas[0]?.celulas).toEqual([numero(1), INVALIDA, numero(3)]);
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.celulaIlegivel, { coluna: 0, linha: 1 }),
    ]);
    expect(t.linhas).toEqual([
      [numero(1), opcao('P')],
      [INVALIDA, opcao('M')],
      [numero(3), opcao('G')],
    ]);
  });

  it('a null column is coluna-ilegivel, EXCLUDED from colunas and from the rectangularity count', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([
        null,
        col(NUMERO, [cel({ value: 1 }), cel({ value: 2 })]),
        col(DROPDOWN, [cel({ option: 'P' }), cel({ option: 'M' })]),
      ]),
    );
    expect(t.problemas).toEqual([prob(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna: 0 })]);
    expect(t.colunas.map((c) => c.inputType)).toEqual([NUMERO, DROPDOWN]);
    // Counted as a column of 0 cells it would have made the table irregular.
    expect(t.linhas).toEqual([
      [numero(1), opcao('P')],
      [numero(2), opcao('M')],
    ]);
  });

  it('after a skipped column, problems still name the WIRE column position', () => {
    const t = projetar(
      ID_DO_EXEMPLO,
      tabela([null, col(NUMERO, [cel({ value: 1 })]), col(DROPDOWN, [cel()])]),
    );
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna: 0 }),
      prob(PROBLEMA_TABELA_SHOPEE.celulaSemValor, { coluna: 2, linha: 0 }),
    ]);
  });
});

describe('no readable column — sem-colunas, linhas []', () => {
  it.each([
    ['size_chart_table null', null],
    ['column_list null', { column_list: null }],
    ['column_list []', { column_list: [] }],
  ] as const)('%s', (_nome, size_chart_table) => {
    const t = projetar(ID_DO_EXEMPLO, {
      size_chart_id: ID_DO_EXEMPLO,
      size_chart_name: 'testtestt',
      size_chart_table,
    });
    expect(t).toEqual({
      sizeChartId: ID_DO_EXEMPLO,
      sizeChartName: 'testtestt',
      colunas: [],
      linhas: [],
      problemas: [prob(PROBLEMA_TABELA_SHOPEE.semColunas)],
    });
  });

  it('only unreadable columns: each one reported, then sem-colunas', () => {
    const t = projetar(ID_DO_EXEMPLO, tabela([null, null]));
    expect(t.colunas).toEqual([]);
    expect(t.linhas).toEqual([]);
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna: 0 }),
      prob(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna: 1 }),
      prob(PROBLEMA_TABELA_SHOPEE.semColunas),
    ]);
  });
});

describe('sizeChartId is the REQUESTED id — the echo only feeds id-divergente', () => {
  it.each([ID_DO_EXEMPLO + 1, ID_DO_EXEMPLO - 1])(
    'echo %i for request 700024639 → id-divergente',
    (eco) => {
      const t = projetar(ID_DO_EXEMPLO, { ...EXEMPLO_DA_DOC, size_chart_id: eco });
      expect(t.sizeChartId).toBe(ID_DO_EXEMPLO);
      expect(t.problemas).toEqual([
        prob(PROBLEMA_TABELA_SHOPEE.idDivergente, { pedido: ID_DO_EXEMPLO, recebido: eco }),
      ]);
      // The chart itself is still projected — a divergent echo is a diagnostic, not a failure.
      expect(t.linhas).toHaveLength(3);
    },
  );

  it('an equal echo or a null echo raises nothing', () => {
    expect(projetar(ID_DO_EXEMPLO, EXEMPLO_DA_DOC).problemas).toEqual([]);
    expect(projetar(ID_DO_EXEMPLO, { ...EXEMPLO_DA_DOC, size_chart_id: null }).problemas).toEqual(
      [],
    );
  });

  it('with a null echo the id is still the requested one', () => {
    expect(projetar(700024641, { ...EXEMPLO_DA_DOC, size_chart_id: null }).sizeChartId).toBe(
      700024641,
    );
  });
});

describe('ecoDivergenteTabelaShopee — THE echo rule (the projector and the apps/shopee list walk share it)', () => {
  // EQUAL pair and the ±1 near-misses, plus the absent echo, for one request.
  it.each<[number | null, number | null]>([
    [ID_DO_EXEMPLO, null],
    [null, null],
    [ID_DO_EXEMPLO + 1, ID_DO_EXEMPLO + 1],
    [ID_DO_EXEMPLO - 1, ID_DO_EXEMPLO - 1],
    [0, 0],
  ])('echo %j for request 700024639 → %j', (eco, esperado) => {
    expect(ecoDivergenteTabelaShopee(ID_DO_EXEMPLO, { size_chart_id: eco })).toBe(esperado);
  });

  it('projetarTabelaShopee raises id-divergente EXACTLY when the rule answers non-null — one rule, not two', () => {
    for (const eco of [ID_DO_EXEMPLO, null, ID_DO_EXEMPLO + 1, ID_DO_EXEMPLO - 1, 0, 1]) {
      const recebido = ecoDivergenteTabelaShopee(ID_DO_EXEMPLO, { size_chart_id: eco });
      const divergencias = projetar(ID_DO_EXEMPLO, {
        ...EXEMPLO_DA_DOC,
        size_chart_id: eco,
      }).problemas.filter((p) => p.codigo === PROBLEMA_TABELA_SHOPEE.idDivergente);
      expect(divergencias, String(eco)).toEqual(
        recebido === null
          ? []
          : [prob(PROBLEMA_TABELA_SHOPEE.idDivergente, { pedido: ID_DO_EXEMPLO, recebido })],
      );
    }
  });
});

describe('problem order — echo, then each column in wire order (its own, then its cells), then the table', () => {
  it('lists every problem in discovery order', () => {
    const t = projetar(ID_DO_EXEMPLO, {
      size_chart_id: ID_DO_EXEMPLO + 1,
      size_chart_name: null,
      size_chart_table: {
        column_list: [
          null,
          col('Input Multi Number', [cel({ option: 'M', value: 1 }), cel({ value: 2 })]),
          col(FAIXA, [cel({ min_value: 1 })]),
        ],
      },
    });
    expect(t.problemas).toEqual([
      prob(PROBLEMA_TABELA_SHOPEE.idDivergente, {
        pedido: ID_DO_EXEMPLO,
        recebido: ID_DO_EXEMPLO + 1,
      }),
      prob(PROBLEMA_TABELA_SHOPEE.colunaIlegivel, { coluna: 0 }),
      prob(PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, {
        coluna: 1,
        inputType: 'Input Multi Number',
      }),
      prob(PROBLEMA_TABELA_SHOPEE.celulaAmbigua, { coluna: 1, linha: 0 }),
      prob(PROBLEMA_TABELA_SHOPEE.faixaIncompleta, { coluna: 2, linha: 0 }),
      prob(PROBLEMA_TABELA_SHOPEE.tabelaIrregular, { comprimentos: [2, 1] }),
    ]);
  });
});

describe('totality — never throws', () => {
  it.each([
    ['an all-null payload', { size_chart_id: null, size_chart_name: null, size_chart_table: null }],
    [
      'a column with no measurement and no list',
      tabela([{ measurement: null, measurement_value_list: null }]),
    ],
    ['an all-null cell', tabela([col(DROPDOWN, [cel()])])],
    [
      'a null cell in a null-measurement column',
      tabela([{ measurement: null, measurement_value_list: [null] }]),
    ],
  ] satisfies [string, DetalheTabelaShopeeEntrada][])('%s', (_nome, detalhe) => {
    expect(() => projetar(ID_DO_EXEMPLO, detalhe)).not.toThrow();
  });

  it('a hand-built input with MISSING keys (not what the package produces) still projects', () => {
    // `undefined` where the package would put `null`: read as `null`, never `.trim()` on undefined.
    const semChaves = {
      size_chart_table: { column_list: [{ measurement: {}, measurement_value_list: [{}] }] },
    } as unknown as DetalheTabelaShopeeEntrada;
    const t = projetar(ID_DO_EXEMPLO, semChaves);
    expect(t.sizeChartName).toBeNull();
    expect(t.colunas[0]?.celulas).toEqual([INVALIDA]);
    expect(t.problemas.map((p) => p.codigo)).toEqual([
      PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido,
      PROBLEMA_TABELA_SHOPEE.celulaSemValor,
    ]);
    expect(() =>
      projetarTabelaShopee(ID_DO_EXEMPLO, {} as unknown as DetalheTabelaShopeeEntrada),
    ).not.toThrow();
  });
});

describe('tabelaShopeeProjetadaSchema — flat and tolerant (apps/web and apps/shopee deploy separately)', () => {
  const doFuturo = {
    sizeChartId: ID_DO_EXEMPLO,
    sizeChartName: null,
    colunas: [
      {
        displayName: 'x',
        inputType: 'Input Multi Number',
        unit: null,
        celulas: [
          {
            tipo: 'tipo-do-futuro',
            option: null,
            value: null,
            minValue: null,
            maxValue: null,
            novo: 1,
          },
        ],
        novo: true,
      },
    ],
    linhas: null,
    problemas: [
      {
        codigo: 'codigo-do-futuro',
        coluna: null,
        linha: null,
        inputType: null,
        comprimentos: null,
        pedido: null,
        recebido: null,
        novo: 'x',
      },
    ],
    novo: 1,
  };

  it("parses a NEWER server's unknown tipo and codigo, and strips its unknown keys", () => {
    const lida = tabelaShopeeProjetadaSchema.parse(doFuturo);
    expect(lida.colunas[0]?.celulas[0]?.tipo).toBe('tipo-do-futuro');
    expect(lida.problemas[0]?.codigo).toBe('codigo-do-futuro');
    expect(lida).not.toHaveProperty('novo');
    expect(lida.colunas[0]).not.toHaveProperty('novo');
    expect(lida.colunas[0]?.celulas[0]).not.toHaveProperty('novo');
    expect(lida.problemas[0]).not.toHaveProperty('novo');
  });

  it('still requires all seven problem keys — a problem missing one is refused, not defaulted', () => {
    const semPedido = {
      codigo: PROBLEMA_TABELA_SHOPEE.idDivergente,
      coluna: null,
      linha: null,
      inputType: null,
      comprimentos: null,
      recebido: 1,
    };
    expect(
      tabelaShopeeProjetadaSchema.safeParse({
        ...doFuturo,
        problemas: [{ ...semPedido, pedido: null }],
      }).success,
    ).toBe(true);
    expect(
      tabelaShopeeProjetadaSchema.safeParse({ ...doFuturo, problemas: [semPedido] }).success,
    ).toBe(false);
  });
});
