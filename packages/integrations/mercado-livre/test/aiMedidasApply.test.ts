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

/**
 * ML's size-equivalence column, as an apparel domain sends it: a CLOSED list
 * tagged `multivalued`, so one row maps onto several standard sizes.
 */
const EQUIV: MedidaColumnSpec = {
  attributeId: 'FILTRABLE_SIZE',
  label: 'Tamanho padrão',
  kind: 'multiselect',
  unitId: null,
  required: true,
  sizeEquivalence: true,
  values: [
    { id: '3189130', name: '34' },
    { id: '4608574', name: '36' },
    { id: '3259450', name: '38' },
    { id: '3259451', name: '40' },
  ],
};

const apply = (answer: unknown) => applyAiMedidas(ROWS, COLUMNS, answer);
const applyEquiv = (answer: unknown) => applyAiMedidas(ROWS, [...COLUMNS, EQUIV], answer);

/**
 * Two options ONE LETTER apart. The shared `COLUMNS` fixture has `Justa`/`Solta`,
 * which no plausible widening confuses; a near-miss needs neighbours.
 */
const FIT_PAIR: MedidaColumnSpec[] = [
  {
    attributeId: 'FIT',
    label: 'Modelagem',
    kind: 'select',
    unitId: null,
    required: false,
    values: [
      { id: 'F1', name: 'Justa' },
      { id: 'F2', name: 'Justo' },
    ],
  },
];

describe('applyAiMedidas — where the closed-list fold STOPS', () => {
  it('picks the option that matches, not the sibling one letter away', () => {
    // `normalizeLoose` folds case and accents and NOTHING else. Two real ML
    // options a letter apart have to stay two options, or a model answer lands
    // on the wrong `value_id` and ships to a live listing.
    expect(applyAiMedidas(ROWS, FIT_PAIR, { P: { FIT: 'justo' } })).toEqual([
      {
        rowKey: 'g/1/v/p',
        attributeId: 'FIT',
        value_id: 'F2',
        value_name: 'Justo',
        valueList: null,
      },
    ]);
  });

  it('refuses a bare PREFIX of an option, keeping it as free text', () => {
    // ⭐ The half a same-length pair cannot cover. `Justa`/`Justo` kill a
    // TRUNCATING fold; only a strict prefix kills a `.startsWith` one. On a
    // `select` an unmatched answer degrades to free text, so the tell is
    // `value_id: null` — ML then says what is wrong instead of us inventing an id.
    expect(applyAiMedidas(ROWS, FIT_PAIR, { P: { FIT: 'Just' } })).toEqual([
      {
        rowKey: 'g/1/v/p',
        attributeId: 'FIT',
        value_id: null,
        value_name: 'Just',
        valueList: null,
      },
    ]);
  });
});

describe('applyAiMedidas — the size-equivalence column', () => {
  it('resolves an ARRAY answer to every matching option', () => {
    // The whole point of the column: ML's own docs map one row ("Small") onto
    // 34/36/38/40, and that set is what the listing's size filter is built from.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['34', '36', '38'] } })).toEqual([
      {
        rowKey: 'g/1/v/p',
        attributeId: 'FILTRABLE_SIZE',
        value_id: '3189130',
        value_name: '34, 36, 38',
        valueList: [
          { id: '3189130', name: '34' },
          { id: '4608574', name: '36' },
          { id: '3259450', name: '38' },
        ],
      },
    ]);
  });

  it('reaches the array path at all — `coerceText` would have dropped it', () => {
    // ⚠️ The regression this guards: `coerceText` returns null for an array ("a
    // cell value is a scalar"), so an array checked AFTER it is silently thrown
    // away and the one column ML refuses the guia over comes back empty.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['38'] } })).toHaveLength(1);
  });

  it('dedupes repeated members', () => {
    // ML answers `duplicated_measure_value` on a repeat, and "38, 38, 40" is a
    // plausible read of a printed range.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['38', '38', '40'] } })[0]?.valueList).toEqual([
      { id: '3259450', name: '38' },
      { id: '3259451', name: '40' },
    ]);
  });

  it('never matches a PREFIX of a standard size', () => {
    // ⭐ THE NEAR-MISS for the ARRAY path's `normalizeLoose` fold. The cases
    // around it are FAR-misses — `'XG'` is nothing like `'38'` — so they prove
    // the fold APPLIES without pinning where it STOPS. `'3'` is one edit from
    // three real options; a fold that reached past exact equality would resolve
    // it to `34` and ship a size filter the guia never claimed.
    // Same failure `chartRows.test.ts` names for the same helper: `4` claiming
    // `40`. Mutation: `===` → `.startsWith(...)` at medidasApply.ts must red this.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['3'] } })).toEqual([]);
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['4'] } })).toEqual([]);
  });

  it('drops members outside the closed list, keeping the rest', () => {
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['38', 'XG', '40'] } })[0]?.valueList).toEqual([
      { id: '3259450', name: '38' },
      { id: '3259451', name: '40' },
    ]);
  });

  it('drops the whole cell when NO member matched', () => {
    // A multiselect renders its members by id. An unmatched value applied as
    // `{id: ''}` shows an EMPTY box and still ships to ML — the same failure
    // `aiApplicable` guards for `select`.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: ['XG', 'XGG'] } })).toEqual([]);
    expect(applyEquiv({ P: { FILTRABLE_SIZE: 'XG' } })).toEqual([]);
  });

  it('drops the `-1` sentinel by id inside a list, whatever ML calls it', () => {
    const withNa: MedidaColumnSpec = {
      ...EQUIV,
      values: [{ id: '-1', name: 'Sem especificar' }, ...EQUIV.values],
    };
    expect(
      applyAiMedidas(ROWS, [withNa], { P: { FILTRABLE_SIZE: ['Sem especificar', '38'] } })[0]
        ?.valueList,
    ).toEqual([{ id: '3259450', name: '38' }]);
  });

  it('wraps a SCALAR answer into a one-member list', () => {
    // A model answering "38" instead of ["38"] is still right; the cell's widget
    // only ever reads `valueList`, so the shape has to be normalised here.
    expect(applyEquiv({ P: { FILTRABLE_SIZE: '38' } })[0]).toMatchObject({
      value_id: '3259450',
      valueList: [{ id: '3259450', name: '38' }],
    });
  });

  it('leaves a scalar column with `valueList: null`', () => {
    expect(apply({ P: { CHEST: '52' } })[0]?.valueList).toBeNull();
  });
});

describe('applyAiMedidas — resolving the answer onto rows', () => {
  it('maps a size label back to the editor row key', () => {
    expect(apply({ P: { CHEST: '52' } })).toEqual([
      {
        rowKey: 'g/1/v/p',
        attributeId: 'CHEST',
        value_id: null,
        value_name: '52',
        valueList: null,
      },
    ]);
  });

  it('matches the size label case- and accent-insensitively', () => {
    // The model reads the label off a photo; casing there is not meaningful.
    expect(apply({ p: { CHEST: '52' } })[0]?.rowKey).toBe('g/1/v/p');
  });

  it('resolves a closed-list value to its id, matching accent-insensitively', () => {
    expect(apply({ P: { FIT: 'justa' } })).toEqual([
      {
        rowKey: 'g/1/v/p',
        attributeId: 'FIT',
        value_id: 'F1',
        value_name: 'Justa',
        valueList: null,
      },
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
  it('localizes a dot decimal so an AI cell looks like a typed one', () => {
    // The grid stores measurements as strings and a pt-BR operator types
    // `10,5`. This used to run the other way, on the false premise that
    // `measureStruct` needed a dot — it opens with `.replace(',', '.')`.
    expect(apply({ P: { CHEST: '10.5' } })[0]?.value_name).toBe('10,5');
  });

  it('leaves a value that already uses a comma alone', () => {
    expect(apply({ P: { CHEST: '10,5' } })[0]?.value_name).toBe('10,5');
  });

  it('leaves a whole number alone', () => {
    expect(apply({ P: { CHEST: '52' } })[0]?.value_name).toBe('52');
  });

  it('leaves an ambiguous thousands-separated string alone', () => {
    // No garment measurement reaches four digits, so this is not a measurement
    // and guessing at it would invent data.
    expect(apply({ P: { CHEST: '1.234,5' } })[0]?.value_name).toBe('1.234,5');
  });

  it('does NOT localize a dot in a non-numeric column', () => {
    // ANTI-VACUITY: the guard is `column.kind === 'number'`, and without this
    // case a rule applied to every column would pass every other case here.
    expect(apply({ P: { FIT: 'Justa 1.5' } })[0]?.value_name).toBe('Justa 1.5');
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
