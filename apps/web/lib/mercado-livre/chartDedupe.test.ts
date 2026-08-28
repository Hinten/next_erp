import { describe, expect, it } from 'vitest';

import { nudgeDuplicateMeasures } from './chartDedupe';
import type { ChartRowDraft } from './chartRows';
import type { ChartColumn } from './chartSpec';
import type { MercadoLivreMedidaSugestao } from './wire';

const PEITO: ChartColumn = {
  key: 'CHEST',
  label: 'Largura do peito da roupa',
  hint: null,
  required: true,
  mainCandidate: false,
  sizeEquivalence: false,
  unit: { default: 'cm', options: [] },
  connector: null,
  parts: [{ attributeId: 'CHEST', label: 'Peito', kind: 'number', values: [] }],
};

/** A `LINKED_BY_CONNECTOR_INPUT` column: two parts under one header. */
const CINTURA: ChartColumn = {
  key: 'WAIST_FROM',
  label: 'Cintura',
  hint: null,
  required: false,
  mainCandidate: false,
  sizeEquivalence: false,
  unit: { default: 'cm', options: [] },
  connector: 'a',
  parts: [
    { attributeId: 'WAIST_FROM', label: 'de', kind: 'number', values: [] },
    { attributeId: 'WAIST_TO', label: 'até', kind: 'number', values: [] },
  ],
};

const MODELAGEM: ChartColumn = {
  key: 'FIT',
  label: 'Modelagem',
  hint: null,
  required: false,
  mainCandidate: false,
  sizeEquivalence: false,
  unit: { default: null, options: [] },
  connector: null,
  parts: [{ attributeId: 'FIT', label: 'Modelagem', kind: 'text', values: [] }],
};

const EQUIV: ChartColumn = {
  key: 'FILTRABLE_SIZE',
  label: 'Tamanho padrão',
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
      values: [
        { id: 'S36', name: '36' },
        { id: 'S38', name: '38' },
        { id: 'S40', name: '40' },
      ],
    },
  ],
};

function row(key: string, cells: ChartRowDraft['cells'] = {}): ChartRowDraft {
  return { key, varianteUid: null, id: null, cells, deleted: false };
}

function texto(value_name: string) {
  return { value_id: null, value_name, valueList: null };
}

function sugestao(
  rowKey: string,
  attributeId: string,
  value_name: string,
  valueList: MercadoLivreMedidaSugestao['valueList'] = null,
): MercadoLivreMedidaSugestao {
  return { rowKey, attributeId, value_id: null, value_name, valueList };
}

const nomes = (out: ReadonlyArray<{ value_name: string }>) => out.map((s) => s.value_name);

describe('nudgeDuplicateMeasures — repeated measurements', () => {
  it('leaves distinct values exactly as the model gave them', () => {
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '50'), sugestao('m', 'CHEST', '52')],
      [row('p'), row('m')],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50', '52']);
    expect(out.map((s) => s.ajustadoDe)).toEqual([null, null]);
  });

  it('offsets a repeat by 0,01 and keeps the first row untouched', () => {
    // The reported bug: ML answered `duplicated_measure_value` on
    // "Largura do peito da roupa" because two sizes read the same width.
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '50'), sugestao('m', 'CHEST', '50')],
      [row('p'), row('m')],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50', '50,01']);
    expect(out[0]?.ajustadoDe).toBeNull();
    expect(out[1]?.ajustadoDe).toBe('50');
  });

  it('walks past a value a later row already holds instead of landing on it', () => {
    // ONE fixed `+0,01` step would move the second row onto the third's value.
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '50'), sugestao('m', 'CHEST', '50'), sugestao('g', 'CHEST', '50,01')],
      [row('p'), row('m'), row('g')],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50', '50,02', '50,01']);
  });

  it('counts a value already in an untouched cell of the grid', () => {
    // The whole reason this runs in the browser: the server never sees `g`.
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '50')],
      [row('p'), row('g', { CHEST: texto('50') })],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50,01']);
    expect(out[0]?.ajustadoDe).toBe('50');
  });

  it('ignores the stored value of a row it is about to overwrite', () => {
    // `p` holds 50 today and the model says 50: replacing a value with itself
    // is not a duplicate, and offsetting it would edit data for nothing.
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '50')],
      [row('p', { CHEST: texto('50') })],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50']);
    expect(out[0]?.ajustadoDe).toBeNull();
  });

  it('collides across separator spellings', () => {
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', '10,5')],
      [row('p'), row('g', { CHEST: texto('10.50') })],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['10,51']);
  });

  it('ignores a row staged for deletion', () => {
    // `toChartRows` drops it before the guia is built, so ML never sees it.
    const morta: ChartRowDraft = { ...row('x', { CHEST: texto('50') }), deleted: true };
    const out = nudgeDuplicateMeasures([sugestao('p', 'CHEST', '50')], [row('p'), morta], [PEITO]);

    expect(nomes(out)).toEqual(['50']);
  });

  it('offsets in grid order, not in the order the model answered', () => {
    // Determinism: the same grid must produce the same offsets on every run.
    const out = nudgeDuplicateMeasures(
      [sugestao('m', 'CHEST', '50'), sugestao('p', 'CHEST', '50')],
      [row('p'), row('m')],
      [PEITO],
    );

    // Output keeps the CALLER's order; `p` is the row that kept the value.
    expect(out.map((s) => [s.rowKey, s.value_name])).toEqual([
      ['m', '50,01'],
      ['p', '50'],
    ]);
  });

  it('offsets DOWN when stepping up would cross the row own upper bound', () => {
    // A degenerate range row (`de 88 a 88`) read off a table that printed one
    // number. Nudging FROM up would put it past its own TO.
    const out = nudgeDuplicateMeasures(
      [sugestao('m', 'WAIST_FROM', '88')],
      [row('p', { WAIST_FROM: texto('88') }), row('m', { WAIST_TO: texto('88') })],
      [CINTURA],
    );

    expect(nomes(out)).toEqual(['87,99']);
  });

  it('leaves a value it cannot read as a number alone', () => {
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'CHEST', 'aprox. 50'), sugestao('m', 'CHEST', 'aprox. 50')],
      [row('p'), row('m')],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['aprox. 50', 'aprox. 50']);
    expect(out.every((s) => s.ajustadoDe === null)).toBe(true);
  });

  it('does NOT offset a repeat in a free-text column', () => {
    // ANTI-VACUITY: the rule is scoped to `kind === 'number'`. Without this
    // case a rule applied to every column would pass everything above.
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'FIT', 'Justa'), sugestao('m', 'FIT', 'Justa')],
      [row('p'), row('m')],
      [MODELAGEM],
    );

    expect(nomes(out)).toEqual(['Justa', 'Justa']);
  });

  it('leaves a suggestion for a column the grid does not draw alone', () => {
    const out = nudgeDuplicateMeasures(
      [sugestao('p', 'SLEEVE', '50'), sugestao('m', 'SLEEVE', '50')],
      [row('p'), row('m')],
      [PEITO],
    );

    expect(nomes(out)).toEqual(['50', '50']);
  });
});

describe('nudgeDuplicateMeasures — repeated size equivalences', () => {
  it('removes a standard size an earlier row already claimed', () => {
    const out = nudgeDuplicateMeasures(
      [
        sugestao('p', 'FILTRABLE_SIZE', '36, 38', [
          { id: 'S36', name: '36' },
          { id: 'S38', name: '38' },
        ]),
        sugestao('m', 'FILTRABLE_SIZE', '38, 40', [
          { id: 'S38', name: '38' },
          { id: 'S40', name: '40' },
        ]),
      ],
      [row('p'), row('m')],
      [EQUIV],
    );

    expect(out[0]?.valueList?.map((v) => v.id)).toEqual(['S36', 'S38']);
    expect(out[0]?.ajustadoDe).toBeNull();
    expect(out[1]?.valueList?.map((v) => v.id)).toEqual(['S40']);
    expect(out[1]?.value_name).toBe('40');
    expect(out[1]?.value_id).toBe('S40');
    expect(out[1]?.ajustadoDe).toBe('38, 40');
  });

  it('respects a size already sitting in an untouched row', () => {
    const out = nudgeDuplicateMeasures(
      [
        sugestao('p', 'FILTRABLE_SIZE', '36, 38', [
          { id: 'S36', name: '36' },
          { id: 'S38', name: '38' },
        ]),
      ],
      [
        row('p'),
        row('g', {
          FILTRABLE_SIZE: {
            value_id: null,
            value_name: null,
            valueList: [{ id: 'S38', name: '38' }],
          },
        }),
      ],
      [EQUIV],
    );

    expect(out[0]?.valueList?.map((v) => v.id)).toEqual(['S36']);
  });

  it('drops a suggestion whose every member was already claimed', () => {
    // Applying it would write a visibly EMPTY cell that still ships to ML.
    const out = nudgeDuplicateMeasures(
      [
        sugestao('p', 'FILTRABLE_SIZE', '38', [{ id: 'S38', name: '38' }]),
        sugestao('m', 'FILTRABLE_SIZE', '38', [{ id: 'S38', name: '38' }]),
      ],
      [row('p'), row('m')],
      [EQUIV],
    );

    expect(out).toHaveLength(1);
    expect(out[0]?.rowKey).toBe('p');
  });
});
