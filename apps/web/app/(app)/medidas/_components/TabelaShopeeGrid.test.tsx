import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  PROBLEMA_TABELA_SHOPEE,
  SHOPEE_SIZE_CHART_INPUT_TYPE,
  TIPO_CELULA_TABELA_SHOPEE,
  projetarTabelaShopee,
  type CelulaTabelaShopee,
  type ColunaTabelaShopee,
  type DetalheTabelaShopeeEntrada,
  type ProblemaTabelaShopee,
  type TabelaShopeeProjetada,
} from '@delfrance/schemas';

import { MantineTestProvider } from '@/lib/testing/mantine';
import { detalheTabelaMedidasDtoSchema } from '@/lib/shopee/wire';

import {
  TabelaShopeeGrid,
  cabecalhoDaColunaShopee,
  descreverProblemaTabelaShopee,
  textoDaCelulaShopee,
} from './TabelaShopeeGrid';

/**
 * Shopee's OWN `get_size_chart_detail` doc sample (`response` only), inline:
 * `apps/web` cannot reach `apps/shopee`'s `__wire__` fixtures. Same bytes as
 * `apps/shopee/lib/shopee/fixtures/__wire__/get_size_chart_detail.doc.json`.
 * ⚠️ It echoes 700024639 — projecting it for any other id adds one
 * `id-divergente` (reconcile A.3).
 */
const DOC_SAMPLE: DetalheTabelaShopeeEntrada = {
  size_chart_id: 700024639,
  size_chart_name: 'testtestt',
  size_chart_table: {
    column_list: [
      {
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
      },
      {
        measurement: {
          display_name: 'susu_input_range_number_with_special_unit_kg',
          input_type: 'Input Range Number',
          unit: 'kg',
        },
        measurement_value_list: [
          { max_value: 13, min_value: 12, option: null, value: null },
          { max_value: 14, min_value: 13, option: null, value: null },
          { max_value: 16, min_value: 14, option: null, value: null },
        ],
      },
      {
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
      },
    ],
  },
};

function show(tabela: TabelaShopeeProjetada) {
  return render(
    <MantineTestProvider>
      <TabelaShopeeGrid tabela={tabela} />
    </MantineTestProvider>,
  );
}

function coluna(over: Partial<ColunaTabelaShopee> = {}): ColunaTabelaShopee {
  return { displayName: 'Busto', inputType: null, unit: null, celulas: [], ...over };
}

function celula(over: Partial<CelulaTabelaShopee>): CelulaTabelaShopee {
  return {
    tipo: TIPO_CELULA_TABELA_SHOPEE.invalida,
    option: null,
    value: null,
    minValue: null,
    maxValue: null,
    ...over,
  };
}

function problema(over: Partial<ProblemaTabelaShopee>): ProblemaTabelaShopee {
  return {
    codigo: PROBLEMA_TABELA_SHOPEE.semColunas,
    coluna: null,
    linha: null,
    inputType: null,
    comprimentos: null,
    pedido: null,
    recebido: null,
    ...over,
  };
}

function corpoDaGrade(): HTMLElement[] {
  return Array.from(
    screen.getByTestId('shopee-tabela-grid').querySelectorAll<HTMLElement>('tbody tr'),
  );
}

function textos(linha: HTMLElement): string[] {
  return Array.from(linha.querySelectorAll('td')).map((td) => td.textContent ?? '');
}

describe('TabelaShopeeGrid — RT7: server projection → web wire schema → grid', () => {
  it('renders the doc sample the backend projected, through the SAME schema the client parses with: 3 rows × 3 columns, no alert', () => {
    // The real producer (the projector the detail route calls), a JSON hop like
    // the HTTP body, then the web's wire schema — never a hand-built table.
    const corpo: unknown = JSON.parse(
      JSON.stringify({ tabela: projetarTabelaShopee(700024639, DOC_SAMPLE) }),
    );
    const { tabela } = detalheTabelaMedidasDtoSchema.parse(corpo);
    show(tabela);

    const linhas = corpoDaGrade();
    expect(linhas).toHaveLength(3);
    expect(linhas.map(textos)).toEqual([
      ['1', '12–13', '01s'],
      ['2', '13–14', '01m'],
      ['3', '14–16', '01l'],
    ]);
    expect(screen.queryByTestId('shopee-tabela-grid-problemas')).toBeNull();
  });

  it('appends the unit on the two NUMERIC columns only — never on the dropdown, whose doc sample also says "cm"', () => {
    show(projetarTabelaShopee(700024639, DOC_SAMPLE));
    const cabecalhos = Array.from(
      screen.getByTestId('shopee-tabela-grid').querySelectorAll('thead th'),
    ).map((th) => th.textContent);
    expect(cabecalhos).toEqual([
      'test single input number (cm)',
      'susu_input_range_number_with_special_unit_kg (kg)',
      'regional 001 dropdowm',
    ]);
    // M64: a unit on a dropdown reads "01s cm" — no cell or header may carry it.
    expect(screen.queryByText(/01s cm/)).toBeNull();
    expect(screen.queryByText('regional 001 dropdowm (cm)')).toBeNull();
  });

  it('projected for ANOTHER id (the list sample’s 700024641), the same sample carries exactly one id-divergente line above the grid', () => {
    show(projetarTabelaShopee(700024641, DOC_SAMPLE));
    const alerta = screen.getByTestId('shopee-tabela-grid-problemas');
    expect(
      within(alerta)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['A Shopee devolveu a tabela #700024639 ao pedir a #700024641.']);
    expect(corpoDaGrade()).toHaveLength(3);
  });
});

describe('cabecalhoDaColunaShopee — the unit belongs to a NUMBER column only', () => {
  it.each([
    [SHOPEE_SIZE_CHART_INPUT_TYPE.numero, 'Busto (cm)'],
    [SHOPEE_SIZE_CHART_INPUT_TYPE.faixa, 'Busto (cm)'],
    [SHOPEE_SIZE_CHART_INPUT_TYPE.opcao, 'Busto'],
  ])('%s with unit "cm" → %s, no type line', (inputType, titulo) => {
    expect(cabecalhoDaColunaShopee(coluna({ inputType, unit: 'cm' }))).toEqual({
      titulo,
      detalhe: null,
    });
  });

  it('matches the input_type VERBATIM: a case near-miss is an unknown type, shown raw with its unit', () => {
    expect(
      cabecalhoDaColunaShopee(coluna({ inputType: 'Input single number', unit: 'cm' })),
    ).toEqual({ titulo: 'Busto (cm)', detalhe: 'tipo “Input single number”' });
    expect(cabecalhoDaColunaShopee(coluna({ inputType: 'Single dropdown', unit: 'cm' }))).toEqual({
      titulo: 'Busto (cm)',
      detalhe: 'tipo “Single dropdown”',
    });
  });

  it('a missing type says so; a blank unit and a missing name never print "()" or "null"', () => {
    expect(cabecalhoDaColunaShopee(coluna({ displayName: null }))).toEqual({
      titulo: '—',
      detalhe: 'tipo não informado',
    });
    expect(
      cabecalhoDaColunaShopee(
        coluna({ inputType: SHOPEE_SIZE_CHART_INPUT_TYPE.numero, unit: ' ' }),
      ),
    ).toEqual({ titulo: 'Busto', detalhe: null });
  });

  it('renders the unknown type line under the header', () => {
    show({
      sizeChartId: 1,
      sizeChartName: null,
      colunas: [
        coluna({
          inputType: 'Input Multi Number',
          unit: 'cm',
          celulas: [celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.numero, value: 90 })],
        }),
      ],
      linhas: [[celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.numero, value: 90 })]],
      problemas: [],
    });
    expect(screen.getByText('Busto (cm)')).toBeTruthy();
    expect(screen.getByText('tipo “Input Multi Number”')).toBeTruthy();
  });
});

describe('textoDaCelulaShopee', () => {
  it('numbers in pt-BR: a comma decimal, 0 is a value, never a blank', () => {
    const numero = (value: number | null) =>
      textoDaCelulaShopee(celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.numero, value }));
    expect(numero(90.5)).toBe('90,5');
    expect(numero(0)).toBe('0');
    expect(numero(0.125)).toBe('0,125');
    expect(numero(null)).toBe('—');
  });

  it('a range is min–max as stored — never reordered, never half-drawn', () => {
    const faixa = (minValue: number | null, maxValue: number | null) =>
      textoDaCelulaShopee(celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.faixa, minValue, maxValue }));
    expect(faixa(12, 13)).toBe('12–13');
    expect(faixa(14, 12)).toBe('14–12');
    expect(faixa(12, null)).toBe('—');
    expect(faixa(null, 13)).toBe('—');
  });

  it('an option is printed verbatim — edge spaces kept', () => {
    expect(
      textoDaCelulaShopee(celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.opcao, option: ' M' })),
    ).toBe(' M');
  });

  it('an invalida cell and a tipo this build does not know (deploy skew) render "—", whatever values ride along', () => {
    expect(textoDaCelulaShopee(celula({ option: 'M', value: 3 }))).toBe('—');
    expect(textoDaCelulaShopee(celula({ tipo: 'multiplo', option: 'M', value: 3 }))).toBe('—');
  });
});

describe('descreverProblemaTabelaShopee — every code a sentence, positions 1-based', () => {
  it.each([
    [problema({}), 'A tabela não tem nenhuma coluna legível.'],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.colunaIlegivel, coluna: 1 }),
      'A coluna 2 não pôde ser lida e foi omitida.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.colunaSemMedida, coluna: 0 }),
      'A coluna 1 veio sem a descrição da medida.',
    ],
    [
      problema({
        codigo: PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido,
        coluna: 2,
        inputType: 'Input Multi Number',
      }),
      'A coluna 3 tem um tipo de entrada desconhecido (“Input Multi Number”).',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.tipoDeEntradaDesconhecido, coluna: 2 }),
      'A coluna 3 veio sem tipo de entrada.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.celulaIlegivel, coluna: 0, linha: 4 }),
      'A célula da linha 5, coluna 1 não pôde ser lida.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.celulaSemValor, coluna: 1, linha: 0 }),
      'A célula da linha 1, coluna 2 está sem valor.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.celulaAmbigua, coluna: 1, linha: 1 }),
      'A célula da linha 2, coluna 2 tem mais de um valor; nenhum foi mostrado.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.faixaIncompleta, coluna: 0, linha: 2 }),
      'A faixa da linha 3, coluna 1 tem só um dos limites.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.tabelaIrregular, comprimentos: [3, 2] }),
      'As colunas têm quantidades diferentes de linhas (3, 2) — cada coluna é mostrada separada, sem alinhar as linhas.',
    ],
    [
      problema({ codigo: PROBLEMA_TABELA_SHOPEE.idDivergente, pedido: 10, recebido: 11 }),
      'A Shopee devolveu a tabela #11 ao pedir a #10.',
    ],
  ])('%o', (p, frase) => {
    expect(descreverProblemaTabelaShopee(p)).toBe(frase);
  });

  it('a code a NEWER backend sends is a generic line naming it — never dropped', () => {
    expect(descreverProblemaTabelaShopee(problema({ codigo: 'coluna-duplicada' }))).toBe(
      'A tabela tem um problema que esta tela não reconhece (coluna-duplicada).',
    );
  });
});

describe('TabelaShopeeGrid — problems and shapes the projector reports', () => {
  it('puts the problems ALERT above the table, one line each, an unknown code included', () => {
    const tabela = projetarTabelaShopee(700024639, {
      ...DOC_SAMPLE,
      size_chart_table: {
        column_list: [
          {
            measurement: { display_name: 'Busto', input_type: 'Input Single Number', unit: 'cm' },
            measurement_value_list: [
              { option: null, value: 90, min_value: null, max_value: null },
              { option: null, value: null, min_value: null, max_value: null },
            ],
          },
        ],
      },
    });
    show({ ...tabela, problemas: [...tabela.problemas, problema({ codigo: 'algo-novo' })] });

    const raiz = screen.getByTestId('shopee-tabela-grid');
    const alerta = screen.getByTestId('shopee-tabela-grid-problemas');
    const tabelaEl = raiz.querySelector('table');
    expect(tabelaEl).not.toBeNull();
    // DOCUMENT_POSITION_FOLLOWING: the table comes AFTER the alert.
    expect(
      alerta.compareDocumentPosition(tabelaEl as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(alerta)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual([
      'A célula da linha 2, coluna 1 está sem valor.',
      'A tabela tem um problema que esta tela não reconhece (algo-novo).',
    ]);
    expect(corpoDaGrade().map(textos)).toEqual([['90'], ['—']]);
  });

  it('a RAGGED chart is never zipped: no table, each column drawn alone with its own numbered cells', () => {
    const tabela = projetarTabelaShopee(700024639, {
      ...DOC_SAMPLE,
      size_chart_table: {
        column_list: [
          {
            measurement: { display_name: 'Tamanho', input_type: 'Single Dropdown', unit: null },
            measurement_value_list: [
              { option: 'P', value: null, min_value: null, max_value: null },
              { option: 'M', value: null, min_value: null, max_value: null },
              { option: 'G', value: null, min_value: null, max_value: null },
            ],
          },
          {
            measurement: { display_name: 'Busto', input_type: 'Input Single Number', unit: 'cm' },
            measurement_value_list: [
              { option: null, value: 88, min_value: null, max_value: null },
              { option: null, value: 92, min_value: null, max_value: null },
            ],
          },
        ],
      },
    });
    expect(tabela.linhas).toBeNull();
    show(tabela);

    const raiz = screen.getByTestId('shopee-tabela-grid');
    expect(raiz.querySelector('table')).toBeNull();
    const itens = (i: number) =>
      within(screen.getByTestId(`shopee-tabela-grid-coluna-${String(i)}`))
        .getAllByRole('listitem')
        .map((li) => li.textContent);
    expect(itens(0)).toEqual(['1. P', '2. M', '3. G']);
    expect(itens(1)).toEqual(['1. 88', '2. 92']);
    expect(
      within(screen.getByTestId('shopee-tabela-grid-coluna-1')).getByText('Busto (cm)'),
    ).toBeTruthy();
    expect(
      within(screen.getByTestId('shopee-tabela-grid-problemas')).getByRole('listitem').textContent,
    ).toBe(
      'As colunas têm quantidades diferentes de linhas (3, 2) — cada coluna é mostrada separada, sem alinhar as linhas.',
    );
  });

  it('a chart with no readable column renders the alert alone — no empty table', () => {
    const tabela = projetarTabelaShopee(700024639, { ...DOC_SAMPLE, size_chart_table: null });
    show(tabela);
    const raiz = screen.getByTestId('shopee-tabela-grid');
    expect(raiz.querySelector('table')).toBeNull();
    expect(within(raiz).getByText('A tabela não tem nenhuma coluna legível.')).toBeTruthy();
  });

  it('columns with zero cells: headers, and a line saying there are no rows', () => {
    show({
      sizeChartId: 1,
      sizeChartName: null,
      colunas: [coluna({ inputType: SHOPEE_SIZE_CHART_INPUT_TYPE.opcao })],
      linhas: [],
      problemas: [],
    });
    expect(corpoDaGrade()).toHaveLength(0);
    expect(screen.getByText('Nenhuma linha nesta tabela.')).toBeTruthy();
  });
});

describe('TabelaShopeeGrid — fine measurements and the frozen first column', () => {
  it('a fine measurement keeps its digits — never rounded to Intl’s default three', () => {
    const numero = (value: number) =>
      textoDaCelulaShopee(celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.numero, value }));
    expect(numero(0.0001)).toBe('0,0001');
    expect(
      textoDaCelulaShopee(
        celula({ tipo: TIPO_CELULA_TABELA_SHOPEE.faixa, minValue: 12.5025, maxValue: 13.0001 }),
      ),
    ).toBe('12,5025–13,0001');
  });

  it('the first column is frozen (sticky) in the header and every body row; the others are not', () => {
    show(projetarTabelaShopee(700024639, DOC_SAMPLE));
    const raiz = screen.getByTestId('shopee-tabela-grid');
    const cabecalhos = raiz.querySelectorAll<HTMLElement>('thead th');
    expect(cabecalhos[0]?.style.position).toBe('sticky');
    expect(cabecalhos[1]?.style.position).toBe('');
    for (const linha of corpoDaGrade()) {
      const celulas = linha.querySelectorAll<HTMLElement>('td');
      expect(celulas[0]?.style.position).toBe('sticky');
      expect(celulas[1]?.style.position).toBe('');
    }
  });
});
