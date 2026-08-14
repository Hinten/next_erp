import { describe, expect, it } from 'vitest';

import { applyAiMedidas, medidaCellKey, preCheckedMedidaCells } from '../src/ai/medidasApply';
import type { MedidaColumnSpec, MedidaRowSpec } from '../src/ai/medidasSchema';

const ROWS: MedidaRowSpec[] = [
  { key: 'g/1/v/p', size: 'P' },
  { key: 'g/1/v/m', size: 'M' },
];

const COLUMNS: MedidaColumnSpec[] = [
  {
    attributeId: 'CHEST',
    label: 'Tórax',
    kind: 'number',
    values: [],
    unitId: 'cm',
    required: true,
  },
  {
    attributeId: 'FIT',
    label: 'Modelagem',
    kind: 'select',
    unitId: null,
    required: false,
    values: [
      { id: 'F1', name: 'Justa' },
      { id: 'F2', name: 'Solta' },
    ],
  },
];

const apply = (answer: unknown) => applyAiMedidas(ROWS, COLUMNS, answer);

describe('applyAiMedidas — resolving the answer onto rows', () => {
  it('maps a size label back to the editor row key', () => {
    expect(apply({ P: { CHEST: '52' } })).toEqual([
      { rowKey: 'g/1/v/p', attributeId: 'CHEST', value_id: null, value_name: '52' },
    ]);
  });

  it('matches the size label case- and accent-insensitively', () => {
    // The model reads the label off a photo; casing there is not meaningful.
    expect(apply({ p: { CHEST: '52' } })[0]?.rowKey).toBe('g/1/v/p');
  });

  it('resolves a closed-list value to its id, matching accent-insensitively', () => {
    expect(apply({ P: { FIT: 'justa' } })).toEqual([
      { rowKey: 'g/1/v/p', attributeId: 'FIT', value_id: 'F1', value_name: 'Justa' },
    ]);
  });

  it("drops a match on ML's `-1` sentinel, whatever ML localised it to", () => {
    // The `NA_TEXTS` list cannot be the only guard: ML spells the sentinel
    // differently per attribute and per site, so an unlisted spelling matches a
    // real option whose id is `-1` and would push it through as a staged
    // measurement. `-1` also satisfies ML's required check, so accepting one
    // would silence the validation meant to catch a missing measurement.
    const withNa: MedidaColumnSpec[] = [
      { ...COLUMNS[1]!, values: [{ id: '-1', name: 'Sem especificar' }] },
    ];
    expect(applyAiMedidas(ROWS, withNa, { P: { FIT: 'Sem especificar' } })).toEqual([]);
  });

  it('keeps an unmatched enum value as free text', () => {
    // ML rejects it and names the cell, which beats a silent omission.
    expect(apply({ P: { FIT: 'Oversized' } })[0]).toMatchObject({
      value_id: null,
      value_name: 'Oversized',
    });
  });

  it('coerces a number to a string', () => {
    expect(apply({ P: { CHEST: 52 } })[0]?.value_name).toBe('52');
  });
});

describe('applyAiMedidas — what it drops', () => {
  it('drops a size the grid does not have', () => {
    expect(apply({ GG: { CHEST: '60' } })).toEqual([]);
  });

  it('drops an attribute outside the requested columns', () => {
    expect(apply({ P: { WAIST: '70' } })).toEqual([]);
  });

  it('drops blanks and every "does not apply" spelling', () => {
    for (const value of ['', '   ', 'N/A', 'n/a', 'não se aplica', '-1', 'none', '-']) {
      expect(apply({ P: { CHEST: value } })).toEqual([]);
    }
  });

  it('drops a non-object row value and a non-scalar cell', () => {
    expect(apply({ P: '52' })).toEqual([]);
    expect(apply({ P: { CHEST: { de: 52 } } })).toEqual([]);
    expect(apply({ P: { CHEST: [52] } })).toEqual([]);
  });

  it('returns nothing for a non-object answer', () => {
    expect(apply(null)).toEqual([]);
    expect(apply('nope')).toEqual([]);
    expect(apply([{ P: { CHEST: '52' } }])).toEqual([]);
  });
});

describe('applyAiMedidas — the decimal separator', () => {
  it('rewrites a pt-BR comma decimal so measureStruct can parse it', () => {
    // Brazilian size tables print commas, so the model reading one back verbatim
    // is the expected case. `measureStruct` parses with a single comma→dot
    // replace; a value it cannot parse is rejected at send time, per cell.
    expect(apply({ P: { CHEST: '10,5' } })[0]?.value_name).toBe('10.5');
  });

  it('leaves a value that already uses a dot alone', () => {
    expect(apply({ P: { CHEST: '10.5' } })[0]?.value_name).toBe('10.5');
  });

  it('leaves an ambiguous thousands-separated string alone', () => {
    // No garment measurement reaches four digits, so this is not a measurement
    // and guessing at it would invent data.
    expect(apply({ P: { CHEST: '1.234,5' } })[0]?.value_name).toBe('1.234,5');
  });

  it('does NOT rewrite a comma in a non-numeric column', () => {
    expect(apply({ P: { FIT: 'Justa, solta' } })[0]?.value_name).toBe('Justa, solta');
  });
});

describe('preCheckedMedidaCells', () => {
  it('pre-checks only cells that are currently empty', () => {
    const suggestions = apply({ P: { CHEST: '52' }, M: { CHEST: '56' } });
    const filled = (rowKey: string) => rowKey === 'g/1/v/p';

    expect(preCheckedMedidaCells(suggestions, filled)).toEqual([medidaCellKey('g/1/v/m', 'CHEST')]);
  });

  it('leaves an operator-typed value visible but unchecked, never applied', () => {
    const suggestions = apply({ P: { CHEST: '52' } });
    expect(suggestions).toHaveLength(1);
    expect(preCheckedMedidaCells(suggestions, () => true)).toEqual([]);
  });
});
