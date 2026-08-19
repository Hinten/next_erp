import { describe, expect, it } from 'vitest';
import type { MlSizeChart, Variante } from '@delfrance/schemas';

import type { ChartColumn } from './chartSpec';
import {
  type ChartRowDraft,
  cellErrorKey,
  duplicateChart,
  describeChartValidationError,
  indexCellErrors,
  isFilled,
  rowsFromVariantes,
  sameChart,
  seedRows,
  seedUnits,
  toChartRows,
  toWireAttributes,
  validateChartName,
} from './chartRows';

/* ------------------------------- fixtures -------------------------------- */

const sizeColumn: ChartColumn = {
  key: 'SIZE',
  label: 'Tamanho na etiqueta',
  hint: null,
  required: true,
  mainCandidate: true,
  unit: { default: null, options: [] },
  connector: null,
  parts: [{ attributeId: 'SIZE', label: 'Tamanho', kind: 'text', values: [] }],
};

const chestColumn: ChartColumn = {
  key: 'CHEST_CIRCUMFERENCE_FROM',
  label: 'Contorno do peito',
  hint: 'De - Até',
  required: false,
  mainCandidate: false,
  unit: {
    default: 'cm',
    options: [
      { id: 'cm', name: 'cm' },
      { id: '"', name: '"' },
    ],
  },
  connector: 'a',
  parts: [
    { attributeId: 'CHEST_CIRCUMFERENCE_FROM', label: 'de', kind: 'number', values: [] },
    { attributeId: 'CHEST_CIRCUMFERENCE_TO', label: 'até', kind: 'number', values: [] },
  ],
};

const equivColumn: ChartColumn = {
  key: 'EQUIV',
  label: 'Equivalências',
  hint: null,
  required: false,
  mainCandidate: false,
  unit: { default: null, options: [] },
  connector: null,
  parts: [
    {
      attributeId: 'EQUIV',
      label: 'Equivalências',
      kind: 'multiselect',
      values: [
        { id: '1', name: '38' },
        { id: '2', name: '40' },
      ],
    },
  ],
};

const columns = [sizeColumn, chestColumn, equivColumn];

const storedChart: MlSizeChart = {
  id: '1594439',
  nome: 'Camisetas femininas',
  domain_id: 'MLB-T_SHIRTS',
  tipo: 'BODY_MEASURE',
  main_attribute_id: 'SIZE',
  attributes: [{ id: 'GENDER', value_id: '339665', value_name: 'Feminino' }],
  main_attribute: [],
  rows: [
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
      id: '1594439:1',
      attributes: [
        { id: 'SIZE', value_name: 'M' },
        { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '90', unit_id: 'cm' },
        { id: 'CHEST_CIRCUMFERENCE_TO', value_name: '94', unit_id: 'cm' },
        // An attribute the current ficha técnica no longer mentions.
        { id: 'RETIRADO_PELO_ML', value_name: 'x' },
      ],
      sizeCalculado: { id: 'SIZE', value_name: 'M' },
    },
    {
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-g',
      id: '1594439:2',
      attributes: [{ id: 'SIZE', value_name: 'G' }],
    },
  ],
};

/* -------------------------------- seeding -------------------------------- */

describe('seedRows', () => {
  it('keys cells by attribute id and keeps the ML row id', () => {
    const rows = seedRows(storedChart, columns);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: '1594439:1', deleted: false });
    expect(rows[0]!.cells.SIZE).toEqual({ value_id: null, value_name: 'M', valueList: null });
    expect(rows[0]!.cells.CHEST_CIRCUMFERENCE_TO?.value_name).toBe('94');
  });

  it('drops an attribute the current ficha técnica no longer mentions', () => {
    // Re-sending one earns an `invalid_row_attribute` from ML.
    expect(seedRows(storedChart, columns)[0]!.cells).not.toHaveProperty('RETIRADO_PELO_ML');
  });

  it('reads a multivalued list back into valueList', () => {
    const chart: MlSizeChart = {
      ...storedChart,
      rows: [
        {
          varianteUid: null,
          id: 'x:1',
          attributes: [
            {
              id: 'EQUIV',
              valueList: [{ value_id: '1', value_name: '38' }],
            } as never,
          ],
        },
      ],
    };
    expect(seedRows(chart, columns)[0]!.cells.EQUIV?.valueList).toEqual([{ id: '1', name: '38' }]);
  });

  it('is empty for a chart with no rows', () => {
    expect(seedRows(null, columns)).toEqual([]);
  });
});

describe('rowsFromVariantes', () => {
  const variantes: Variante[] = [
    { id: 'v-m', nome: 'M' },
    { id: 'v-g', nome: 'G' },
  ];

  it('seeds one row per variante with the MAIN attribute, not a hardcoded SIZE', () => {
    const rows = rowsFromVariantes('g1', variantes, 'EU_SIZE');
    expect(rows.map((r) => r.cells.EU_SIZE?.value_name)).toEqual(['M', 'G']);
    expect(rows[0]!.varianteUid).toBe('documents/grupoDeVariacoes/g1/variacoes/v-m');
    expect(rows[0]!.id).toBeNull();
  });

  it('binds every row to its variante — the publish-time join', () => {
    expect(rowsFromVariantes('g1', variantes, 'SIZE').every((r) => r.varianteUid != null)).toBe(
      true,
    );
  });
});

describe('seedUnits', () => {
  it('prefers the unit already stored on the chart', () => {
    expect(seedUnits(columns, storedChart).CHEST_CIRCUMFERENCE_FROM).toBe('cm');
  });

  it("falls back to the column's default when nothing is stored", () => {
    expect(seedUnits(columns, null)).toEqual({
      SIZE: null,
      CHEST_CIRCUMFERENCE_FROM: 'cm',
      EQUIV: null,
    });
  });
});

/* -------------------------------- writing -------------------------------- */

describe('toWireAttributes', () => {
  const row = seedRows(storedChart, columns)[0]!;

  it('emits unit_id only on numeric parts of a column that has a unit', () => {
    const attrs = toWireAttributes(row, columns, { CHEST_CIRCUMFERENCE_FROM: 'cm' });
    expect(attrs).toEqual([
      { id: 'SIZE', value_name: 'M' },
      { id: 'CHEST_CIRCUMFERENCE_FROM', value_name: '90', unit_id: 'cm' },
      { id: 'CHEST_CIRCUMFERENCE_TO', value_name: '94', unit_id: 'cm' },
    ]);
  });

  it('honours a switched column unit for every part of the pair', () => {
    const attrs = toWireAttributes(row, columns, { CHEST_CIRCUMFERENCE_FROM: '"' });
    expect(attrs.filter((a) => a.unit_id != null).map((a) => a.unit_id)).toEqual(['"', '"']);
  });

  it('omits empty cells entirely', () => {
    const empty: ChartRowDraft = { ...row, cells: { SIZE: row.cells.SIZE! } };
    expect(toWireAttributes(empty, columns, {}).map((a) => a.id)).toEqual(['SIZE']);
  });

  it('writes a multivalued list back in the legacy valueList shape', () => {
    const withList: ChartRowDraft = {
      ...row,
      cells: { EQUIV: { value_id: null, value_name: null, valueList: [{ id: '1', name: '38' }] } },
    };
    expect(toWireAttributes(withList, columns, {})).toEqual([
      { id: 'EQUIV', valueList: [{ value_id: '1', value_name: '38' }] },
    ]);
  });
});

describe('toChartRows', () => {
  it('drops rows staged for deletion', () => {
    const rows = seedRows(storedChart, columns).map((r, i) => ({ ...r, deleted: i === 1 }));
    expect(toChartRows(rows, columns, {}, storedChart)).toHaveLength(1);
  });

  it("carries ML's cached sizeCalculado through untouched", () => {
    const rows = seedRows(storedChart, columns);
    const out = toChartRows(rows, columns, { CHEST_CIRCUMFERENCE_FROM: 'cm' }, storedChart);
    expect(out[0]!.sizeCalculado).toEqual({ id: 'SIZE', value_name: 'M' });
    expect(out[1]!.sizeCalculado).toBeUndefined();
  });

  it('keeps varianteUid and the ML row id', () => {
    const out = toChartRows(seedRows(storedChart, columns), columns, {}, storedChart);
    expect(out[0]).toMatchObject({
      id: '1594439:1',
      varianteUid: 'documents/grupoDeVariacoes/g/variacoes/v-m',
    });
  });
});

/* ------------------------------ duplication ------------------------------ */

describe('duplicateChart', () => {
  it('clears every ML identity so the copy CREATES instead of patching', () => {
    const copy = duplicateChart(storedChart);
    expect(copy.id).toBeNull();
    expect(copy.rows!.every((r) => r.id === null)).toBe(true);
    expect(copy.rows!.every((r) => r.sizeCalculado === null)).toBe(true);
    expect(copy.exclusaoSolicitadaEm).toBeNull();
  });

  it('keeps the measurements, the domain and the gender — the point of copying', () => {
    const copy = duplicateChart(storedChart);
    expect(copy.domain_id).toBe('MLB-T_SHIRTS');
    expect(copy.tipo).toBe('BODY_MEASURE');
    expect(copy.attributes).toEqual(storedChart.attributes);
    expect(copy.rows![0]!.attributes).toEqual(storedChart.rows![0]!.attributes);
  });

  it('KEEPS main_attribute_id — the operator’s column choice, not an ML identity', () => {
    expect(duplicateChart(storedChart).main_attribute_id).toBe('SIZE');
  });

  it('prefixes the name and never exceeds ML’s 60-character limit', () => {
    expect(duplicateChart(storedChart).nome).toBe('(Cópia) Camisetas femininas');
    const longName = duplicateChart({ ...storedChart, nome: 'a'.repeat(60) }).nome!;
    expect(longName.length).toBeLessThanOrEqual(60);
  });
});

describe('sameChart', () => {
  it('keys a sent guia by its ML id, ignoring an edited name', () => {
    // The editor compares the STORED slot against the chart it opened with, so
    // a rename must not read as "a different guia".
    expect(sameChart({ ...storedChart, nome: 'Renomeada' }, storedChart)).toBe(true);
  });

  it('rejects a different guia sitting at the same index', () => {
    // A concurrent insert/reorder is exactly this: position N, other chart.
    expect(sameChart({ ...storedChart, id: '999' }, storedChart)).toBe(false);
    expect(sameChart(undefined, storedChart)).toBe(false);
  });

  it('falls back to nome + domain for a draft, which has no id', () => {
    const draft: MlSizeChart = { ...storedChart, id: null };
    expect(sameChart({ ...draft }, draft)).toBe(true);
    expect(sameChart({ ...draft, nome: 'Outra' }, draft)).toBe(false);
    expect(sameChart({ ...draft, domain_id: 'MLB-PANTS' }, draft)).toBe(false);
  });

  it('never matches a draft against a sent guia', () => {
    expect(sameChart({ ...storedChart, id: null }, storedChart)).toBe(false);
  });
});

/* -------------------------------- errors --------------------------------- */

describe('indexCellErrors', () => {
  const base = { chartIndex: 0, rowMainValue: null as string | null };

  it('places a row error on EVERY attribute of a combined column', () => {
    const idx = indexCellErrors(
      [
        {
          ...base,
          code: 'duplicated_measure_value',
          message: 'Duplicated measure in attribute CHEST_CIRCUMFERENCE_FROM was found.',
          rowIndex: 1,
          attributeIds: ['CHEST_CIRCUMFERENCE_FROM', 'CHEST_CIRCUMFERENCE_TO'],
        },
      ],
      0,
    );
    const from = idx.byCell.get(cellErrorKey(1, 'CHEST_CIRCUMFERENCE_FROM'));
    expect(from).toEqual(idx.byCell.get(cellErrorKey(1, 'CHEST_CIRCUMFERENCE_TO')));
    expect(from).toHaveLength(1);
    expect(from?.[0]).toContain('Outra linha da guia já usa');
    expect(idx.chartLevel).toEqual([]);
  });

  it('routes a name rejection to the name input, not to a cell', () => {
    const idx = indexCellErrors(
      [
        {
          ...base,
          code: 'chart_name_unavailable',
          message: 'Chart name is unavailable.',
          rowIndex: null,
          attributeIds: [],
        },
      ],
      0,
    );
    expect(idx.nameRejected).toBe(true);
    expect(idx.chartLevel).toEqual([
      'Já existe uma guia com esse nome nesta conta. Escolha outro nome.',
    ]);
    expect(idx.byCell.size).toBe(0);
  });

  it('an unresolvable row goes to chart level, prefixed with the size ML named', () => {
    // Guessing a cell here would light up the WRONG row after a size rename.
    const idx = indexCellErrors(
      [
        {
          chartIndex: 0,
          code: 'value_out_of_range',
          message:
            'The value 200 of the WAIST attribute is out of range. The value must be within the range: 40 - 120',
          rowIndex: null,
          attributeIds: ['WAIST'],
          rowMainValue: 'GG',
        },
      ],
      0,
    );
    expect(idx.byCell.size).toBe(0);
    expect(idx.chartLevel).toEqual([
      'GG: O valor de WAIST está fora do intervalo aceito pelo Mercado Livre (40 - 120).',
    ]);
  });

  it('ignores problems belonging to another chart in the same sync', () => {
    const idx = indexCellErrors(
      [{ ...base, code: 'x', message: 'y', rowIndex: 0, attributeIds: ['SIZE'], chartIndex: 3 }],
      0,
    );
    expect(idx.byCell.size).toBe(0);
    expect(idx.chartLevel).toEqual([]);
  });

  it('collects several messages on one cell', () => {
    const idx = indexCellErrors(
      [
        { ...base, code: 'a', message: 'um', rowIndex: 0, attributeIds: ['SIZE'] },
        { ...base, code: 'b', message: 'dois', rowIndex: 0, attributeIds: ['SIZE'] },
      ],
      0,
    );
    expect(idx.byCell.get(cellErrorKey(0, 'SIZE'))).toEqual(['um', 'dois']);
  });
});

describe('describeChartValidationError', () => {
  const problem = (over: Partial<Parameters<typeof describeChartValidationError>[0]> = {}) => ({
    code: null as string | null,
    message: null as string | null,
    attributeIds: [] as string[],
    ...over,
  });

  it('names the offending attribute of a general-attributes rejection', () => {
    // ⚠️ Matched on the MESSAGE: this rejection is absent from ML's docs, so
    // its code is unverified. The literal is ML's, copied from a real 400.
    expect(
      describeChartValidationError(
        problem({
          code: 'invalid_chart_attribute',
          message:
            "Attribute MODEL found in chart's attributes is not valid and should not be present in the chart's general attributes.",
        }),
      ),
    ).toBe(
      'O Mercado Livre não aceita o atributo MODEL nos atributos gerais desta guia. Apague esse valor no formulário (se ele ainda aparecer) e envie a guia novamente.',
    );
  });

  it('does not depend on the code for that one', () => {
    // Same message, code absent — ML has changed error codes before.
    expect(
      describeChartValidationError(
        problem({ message: "Attribute LINE found in chart's attributes is not valid." }),
      ),
    ).toContain('LINE');
  });

  it('interpolates the attribute ids ML pinned the problem to', () => {
    expect(
      describeChartValidationError(
        problem({
          code: 'required_row_attribute_not_found',
          message: 'Required attribute CHEST_CIRCUMFERENCE_FROM was not found in row SIZE M.',
          attributeIds: ['CHEST_CIRCUMFERENCE_FROM', 'CHEST_CIRCUMFERENCE_TO'],
        }),
      ),
    ).toBe('Preencha CHEST_CIRCUMFERENCE_FROM e CHEST_CIRCUMFERENCE_TO nesta linha.');
  });

  it('degrades to a code-only phrasing when ML pinned no attribute', () => {
    expect(describeChartValidationError(problem({ code: 'main_attribute_missing_error' }))).toBe(
      'Escolha o tamanho principal da guia.',
    );
  });

  it('keeps ML’s text VERBATIM for a code it has never sent before', () => {
    // ML adds validations unilaterally; an English message beats a swallowed one.
    expect(
      describeChartValidationError(
        problem({ code: 'brand_new_thing', message: 'Something ML invented yesterday.' }),
      ),
    ).toBe('Something ML invented yesterday.');
  });

  it('falls back to the code, then to a generic phrase, when there is no message', () => {
    expect(describeChartValidationError(problem({ code: 'mystery' }))).toBe('mystery');
    expect(describeChartValidationError(problem())).toBe('Erro de validação');
  });
});

/* --------------------------------- misc ---------------------------------- */

describe('isFilled', () => {
  it('any value form counts, whitespace does not', () => {
    expect(isFilled({ value_id: '1', value_name: null, valueList: null })).toBe(true);
    expect(isFilled({ value_id: null, value_name: 'M', valueList: null })).toBe(true);
    expect(
      isFilled({ value_id: null, value_name: null, valueList: [{ id: '1', name: 'a' }] }),
    ).toBe(true);
    expect(isFilled({ value_id: null, value_name: '  ', valueList: null })).toBe(false);
    expect(isFilled(undefined)).toBe(false);
  });
});

describe('validateChartName', () => {
  it('accepts letters, digits, accents and spaces', () => {
    expect(validateChartName('Camisetas femininas 2026')).toBeNull();
  });

  it('rejects the characters ML documents as unsupported', () => {
    // Which is why a "(Cópia) …" name has to be cleaned up before sending.
    expect(validateChartName('(Cópia) Camisetas')).toMatch(/apenas letras/);
    expect(validateChartName('Camisetas - femininas')).toMatch(/apenas letras/);
  });

  it('rejects an empty name and one over 60 characters', () => {
    expect(validateChartName('   ')).toMatch(/Informe/);
    expect(validateChartName('a'.repeat(61))).toMatch(/60/);
  });
});
