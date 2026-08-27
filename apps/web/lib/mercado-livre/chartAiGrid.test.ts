import { describe, expect, it } from 'vitest';

import { buildChartAiGrid, chartAiGridIsFillable } from './chartAiGrid';
import type { ChartColumn } from './chartSpec';
import type { ChartRowDraft } from './chartRows';

/* ------------------------------- fixtures -------------------------------- */

const sizeColumn: ChartColumn = {
  key: 'SIZE',
  label: 'Tamanho na etiqueta',
  hint: null,
  required: true,
  mainCandidate: true,
  sizeEquivalence: false,
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
  sizeEquivalence: false,
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

function row(size: string, over: Partial<ChartRowDraft> = {}): ChartRowDraft {
  return {
    key: `g/1/v/${size.toLowerCase()}`,
    varianteUid: `documents/variante/${size.toLowerCase()}`,
    id: null,
    cells: { SIZE: { value_id: null, value_name: size, valueList: null } },
    deleted: false,
    ...over,
  };
}

const base = { units: {}, mainAttributeId: 'SIZE' };

/* --------------------------------- tests --------------------------------- */

describe('buildChartAiGrid', () => {
  it('drops the main attribute from the columns and keeps it on the rows', () => {
    // The size label is the row's identity, supplied not asked for. A column for
    // it would burn one of the 15 schema slots AND let a "Marcar todas" rewrite
    // the label ML has frozen.
    const grid = buildChartAiGrid({
      ...base,
      rows: [row('P')],
      columns: [sizeColumn, chestColumn],
    });
    expect(grid.columns.map((c) => c.attributeId)).toEqual([
      'CHEST_CIRCUMFERENCE_FROM',
      'CHEST_CIRCUMFERENCE_TO',
    ]);
    expect(grid.rows).toEqual([{ key: 'g/1/v/p', size: 'P' }]);
  });

  it('carries the size-equivalence flag through to the request', () => {
    // ⚠️ Without it the model gets the column with a measurement description and
    // the "never invent, omit what you cannot read" rules apply verbatim — so it
    // correctly returns nothing for the one column ML refuses the guia over.
    const equivColumn: ChartColumn = {
      key: 'FILTRABLE_SIZE',
      label: 'Equivalências',
      hint: null,
      required: true,
      mainCandidate: false,
      sizeEquivalence: true,
      unit: { default: null, options: [] },
      connector: null,
      parts: [
        {
          attributeId: 'FILTRABLE_SIZE',
          label: 'Tamanho padrão',
          kind: 'multiselect',
          values: [{ id: '1', name: '38' }],
        },
      ],
    };
    const grid = buildChartAiGrid({ ...base, rows: [row('P')], columns: [equivColumn] });
    expect(grid.columns).toEqual([
      {
        attributeId: 'FILTRABLE_SIZE',
        label: 'Equivalências',
        kind: 'multiselect',
        values: [{ id: '1', name: '38' }],
        unitId: null,
        required: true,
        sizeEquivalence: true,
      },
    ]);
  });

  it('leaves an ordinary column unflagged', () => {
    const grid = buildChartAiGrid({ ...base, rows: [row('P')], columns: [chestColumn] });
    expect(grid.columns.every((c) => c.sizeEquivalence === false)).toBe(true);
  });

  it('drops rows staged for deletion', () => {
    const grid = buildChartAiGrid({
      ...base,
      rows: [row('P'), row('M', { deleted: true })],
      columns: [sizeColumn, chestColumn],
    });
    expect(grid.rows.map((r) => r.size)).toEqual(['P']);
  });

  it('honours the main attribute the CHART picked, not a hardcoded SIZE', () => {
    // A footwear guia's main attribute is EU_SIZE / M_US_SIZE. Assuming SIZE
    // labels every row blank on exactly the domains the picker exists for.
    const euColumn: ChartColumn = { ...sizeColumn, key: 'EU_SIZE' };
    euColumn.parts = [{ attributeId: 'EU_SIZE', label: 'Tamanho BR', kind: 'text', values: [] }];
    const grid = buildChartAiGrid({
      rows: [
        row('38', { cells: { EU_SIZE: { value_id: null, value_name: '38', valueList: null } } }),
      ],
      columns: [euColumn, chestColumn],
      units: {},
      mainAttributeId: 'EU_SIZE',
    });
    expect(grid.rows[0]!.size).toBe('38');
    expect(grid.columns.some((c) => c.attributeId === 'EU_SIZE')).toBe(false);
  });

  it('labels each half of a FROM/TO pair, and a lone part with the column name', () => {
    const grid = buildChartAiGrid({ ...base, rows: [row('P')], columns: [chestColumn] });
    expect(grid.columns.map((c) => c.label)).toEqual([
      'Contorno do peito — de',
      'Contorno do peito — até',
    ]);
  });

  it('sends the unit the operator chose, falling back to the column default', () => {
    const chosen = buildChartAiGrid({
      ...base,
      units: { CHEST_CIRCUMFERENCE_FROM: '"' },
      rows: [row('P')],
      columns: [chestColumn],
    });
    expect(chosen.columns.every((c) => c.unitId === '"')).toBe(true);

    const untouched = buildChartAiGrid({ ...base, rows: [row('P')], columns: [chestColumn] });
    expect(untouched.columns.every((c) => c.unitId === 'cm')).toBe(true);
  });

  it('leaves a row whose size cell is empty rather than dropping it', () => {
    // An unnamed row is still a row of the grid; the model gets an empty label
    // and simply has nothing to match it against.
    const grid = buildChartAiGrid({
      ...base,
      rows: [row('P', { cells: {} })],
      columns: [sizeColumn, chestColumn],
    });
    expect(grid.rows).toEqual([{ key: 'g/1/v/p', size: '' }]);
  });
});

describe('chartAiGridIsFillable — the button and the request agree', () => {
  // ⚠️ The bug this pins. The button used to enable on the RAW `rows`/`columns`
  // while the request sent this derivation, so both cases below rendered an
  // enabled button over a visibly populated grid and answered "Monte a grade da
  // guia antes de pedir sugestões".
  it('is false when every row is staged for deletion', () => {
    const rows = [row('P', { deleted: true }), row('M', { deleted: true })];
    expect(rows.length).toBeGreaterThan(0); // what the old guard counted
    expect(
      chartAiGridIsFillable(
        buildChartAiGrid({ ...base, rows, columns: [sizeColumn, chestColumn] }),
      ),
    ).toBe(false);
  });

  it('is false when only the size column is showing', () => {
    const columns = [sizeColumn];
    expect(columns.length).toBeGreaterThan(0); // what the old guard counted
    expect(chartAiGridIsFillable(buildChartAiGrid({ ...base, rows: [row('P')], columns }))).toBe(
      false,
    );
  });

  it('is true for a grid with rows and at least one fillable column', () => {
    expect(
      chartAiGridIsFillable(
        buildChartAiGrid({ ...base, rows: [row('P')], columns: [sizeColumn, chestColumn] }),
      ),
    ).toBe(true);
  });
});
