import { describe, expect, it } from 'vitest';

import type { MercadoLivreCategoriaAtributo } from './client';
import {
  NA_VALUE_ID,
  type AttrRow,
  applySuggestions,
  attributesForSave,
  isFilled,
  isNumericAttr,
  naRow,
  resolveTypedValue,
  rowFromSelect,
  seedRows,
  selectOptions,
  selectValueOf,
  validateAttr,
  variationColorSizeState,
  widgetKind,
} from './attributeForm';

function attr(over: Partial<MercadoLivreCategoriaAtributo> & { id: string }) {
  return {
    name: over.id,
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    allowedUnits: [],
    groupId: null,
    groupName: null,
    required: false,
    multivalued: false,
    readOnly: false,
    relevance: null,
    ...over,
  } satisfies MercadoLivreCategoriaAtributo;
}

describe('widgetKind', () => {
  it('maps each ML value_type to a control', () => {
    expect(widgetKind(attr({ id: 'A', valueType: 'string' }))).toBe('text');
    expect(widgetKind(attr({ id: 'A', valueType: 'number' }))).toBe('text');
    expect(widgetKind(attr({ id: 'A', valueType: 'number_unit' }))).toBe('text');
    expect(widgetKind(attr({ id: 'A', valueType: 'boolean' }))).toBe('select');
    expect(widgetKind(attr({ id: 'A', valueType: 'list' }))).toBe('select');
    expect(widgetKind(attr({ id: 'A', valueType: 'list', multivalued: true }))).toBe('multiselect');
  });

  it('degrades an unknown value_type instead of throwing', () => {
    // The legacy Dart parser THREW on an unrecognised type (api_response.dart:212).
    expect(widgetKind(attr({ id: 'A', valueType: 'quantum_flux' }))).toBe('unsupported');
    expect(widgetKind(attr({ id: 'A', valueType: null }))).toBe('unsupported');
  });

  it('flags the numeric types for digit-only input', () => {
    expect(isNumericAttr(attr({ id: 'A', valueType: 'number' }))).toBe(true);
    expect(isNumericAttr(attr({ id: 'A', valueType: 'number_unit' }))).toBe(true);
    expect(isNumericAttr(attr({ id: 'A', valueType: 'string' }))).toBe(false);
  });
});

describe('N/A sentinel', () => {
  it('round-trips and satisfies a required attribute', () => {
    const row = naRow('BRAND');
    expect(row).toEqual({ id: 'BRAND', value_id: NA_VALUE_ID, value_name: 'N/A', unit_id: null });
    expect(isFilled(row)).toBe(true);
    expect(validateAttr(attr({ id: 'BRAND', required: true }), row)).toBeNull();
  });

  it('re-arms from a stored -1', () => {
    const [row] = seedRows(
      [attr({ id: 'BRAND' })],
      [{ id: 'BRAND', value_id: '-1', value_name: 'N/A' }],
    );
    expect(row!.value_id).toBe(NA_VALUE_ID);
  });
});

describe('validateAttr', () => {
  it('blocks a blank required attribute and passes an optional one', () => {
    const required = attr({ id: 'BRAND', required: true });
    expect(validateAttr(required, undefined)).toBe('Este campo é obrigatório');
    expect(validateAttr(required, { value_id: null, value_name: '   ' })).toBe(
      'Este campo é obrigatório',
    );
    expect(validateAttr(required, { value_id: null, value_name: 'Acme' })).toBeNull();
    expect(validateAttr(attr({ id: 'X' }), undefined)).toBeNull();
  });
});

describe('resolveTypedValue', () => {
  it('matches a known option by name, case- and accent-insensitively', () => {
    // The legacy compared raw strings, so `Algodao` fell through to free text
    // where `Algodão` was a real option — and ML rejected the listing.
    const material = attr({
      id: 'MATERIAL',
      valueType: 'list',
      values: [{ id: 'v-alg', name: 'Algodão' }],
    });
    expect(resolveTypedValue(material, 'algodao')).toEqual({
      id: 'MATERIAL',
      value_id: 'v-alg',
      value_name: 'Algodão',
      unit_id: null,
    });
  });

  it('keeps unmatched text as a free value', () => {
    expect(resolveTypedValue(attr({ id: 'MODEL' }), '  XT-500 ')).toEqual({
      id: 'MODEL',
      value_id: null,
      value_name: 'XT-500',
      unit_id: null,
    });
  });

  it('attaches the default unit to a number_unit value', () => {
    // Without unit_id the wire transform sends a bare number where ML wants
    // "55 cm" — the legacy AI path never set it.
    expect(
      resolveTypedValue(attr({ id: 'LENGTH', valueType: 'number_unit', defaultUnit: 'cm' }), '55'),
    ).toEqual({ id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'cm' });
  });

  it('clears the row on empty input', () => {
    expect(resolveTypedValue(attr({ id: 'MODEL' }), '   ')).toEqual({
      id: 'MODEL',
      value_id: null,
      value_name: null,
      unit_id: null,
    });
  });
});

describe('attributesForSave', () => {
  const brand = attr({ id: 'BRAND' });

  it('PRESERVES a stored attribute the category metadata never mentions', () => {
    // ⚠️ The landmine. A "keep only what we rendered" implementation deletes
    // SIZE_GRID_ID, which resolveSizeChart reads on every publish — silently
    // breaking every size-chart binding Flutter or an earlier publish set up.
    const out = attributesForSave(
      [brand],
      [{ id: 'BRAND', value_id: null, value_name: 'Acme', unit_id: null }],
      [
        { id: 'SIZE_GRID_ID', value_id: 'CHART-9' },
        { id: 'BRAND', value_name: 'Antigo' },
      ],
    );
    expect(out).toContainEqual({ id: 'SIZE_GRID_ID', value_id: 'CHART-9' });
    expect(out).toContainEqual({ id: 'BRAND', value_name: 'Acme' });
  });

  it('prunes an attribute the metadata explicitly withheld', () => {
    // The server re-derives SELLER_SKU from the produto on every publish, so a
    // stale stored copy must not linger.
    const out = attributesForSave(
      [brand],
      [],
      [{ id: 'SELLER_SKU', value_name: 'SKU-1' }],
      [{ id: 'SELLER_SKU' }],
    );
    expect(out).toEqual([]);
  });

  it('drops a rendered-but-empty row instead of storing a blank', () => {
    const out = attributesForSave(
      [brand, attr({ id: 'MODEL' })],
      [
        { id: 'BRAND', value_id: null, value_name: 'Acme', unit_id: null },
        { id: 'MODEL', value_id: null, value_name: null, unit_id: null },
      ],
      null,
    );
    expect(out).toEqual([{ id: 'BRAND', value_name: 'Acme' }]);
  });

  it('omits null members rather than storing them', () => {
    const out = attributesForSave(
      [attr({ id: 'LENGTH', valueType: 'number_unit' })],
      [{ id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'cm' }],
      null,
    );
    expect(out).toEqual([{ id: 'LENGTH', value_name: '55', unit_id: 'cm' }]);
  });
});

describe('applySuggestions', () => {
  const attrs = [attr({ id: 'BRAND' }), attr({ id: 'MODEL' })];
  const rows: AttrRow[] = [
    { id: 'BRAND', value_id: null, value_name: null, unit_id: null },
    { id: 'MODEL', value_id: null, value_name: 'Existente', unit_id: null },
  ];

  it('applies only the accepted suggestions', () => {
    const next = applySuggestions(
      attrs,
      rows,
      [
        { id: 'BRAND', value_id: 'v1', value_name: 'Acme', unit_id: null },
        { id: 'MODEL', value_id: null, value_name: 'Sugerido', unit_id: null },
      ],
      (id) => id === 'BRAND',
    );
    expect(next[0]!.value_name).toBe('Acme');
    expect(next[1]!.value_name).toBe('Existente'); // rejected → untouched
  });

  it('ignores a suggestion for an attribute this category does not render', () => {
    const next = applySuggestions(attrs, rows, [
      { id: 'DESCONHECIDO', value_id: null, value_name: 'x', unit_id: null },
    ]);
    expect(next).toEqual(rows);
  });

  it('clears a stale N/A sentinel when a suggestion replaces it', () => {
    // The legacy left value_id '-1' next to the new value — a stored contradiction.
    const next = applySuggestions(
      attrs,
      [naRow('BRAND')],
      [{ id: 'BRAND', value_id: 'v1', value_name: 'Acme', unit_id: null }],
    );
    expect(next[0]).toEqual({ id: 'BRAND', value_id: 'v1', value_name: 'Acme', unit_id: null });
  });
});

describe('variationColorSizeState', () => {
  it('hides COLOR/SIZE when the produto grupo already supplies it', () => {
    expect(variationColorSizeState('COLOR', [{ tipo: 2 }])).toEqual({ kind: 'hide' });
    expect(variationColorSizeState('SIZE', [{ tipo: 1 }])).toEqual({ kind: 'hide' });
  });

  it('reports the exact legacy message when the grupo is missing', () => {
    expect(variationColorSizeState('COLOR', [{ tipo: 1 }])).toEqual({
      kind: 'error',
      message: 'Não foi encontrada nenhuma variação do tipo cor',
    });
    expect(variationColorSizeState('SIZE', [])).toEqual({
      kind: 'error',
      message: 'Não foi encontrada nenhuma variação do tipo tamanho',
    });
  });

  it('does not apply to any other attribute', () => {
    expect(variationColorSizeState('BRAND', [])).toBeNull();
  });
});

describe('enumerated attribute options', () => {
  const gender = attr({
    id: 'GENDER',
    valueType: 'list',
    values: [
      { id: 'G1', name: 'Masculino' },
      { id: 'G2', name: 'Feminino' },
    ],
  });

  it('keys options by ML’s value id', () => {
    expect(selectOptions(gender)).toEqual([
      { value: 'G1', label: 'Masculino' },
      { value: 'G2', label: 'Feminino' },
    ]);
  });

  it('falls back to the name for a value ML ships without an id', () => {
    // An option the operator can see but not choose is worse than one stored
    // by name.
    const byName = attr({ id: 'X', valueType: 'list', values: [{ id: null, name: 'Único' }] });
    expect(selectOptions(byName)).toEqual([{ value: 'Único', label: 'Único' }]);
  });

  it('drops a value with neither id nor name', () => {
    const junk = attr({ id: 'X', valueType: 'list', values: [{ id: null, name: null }] });
    expect(selectOptions(junk)).toEqual([]);
  });

  it('resolves a chosen option back to BOTH id and name', () => {
    // A Select reports the option VALUE; an Autocomplete reports the LABEL.
    // Swapping the two stores an id in `value_name`, which ML rejects.
    expect(rowFromSelect(gender, 'G2')).toEqual({
      id: 'GENDER',
      value_id: 'G2',
      value_name: 'Feminino',
      unit_id: null,
    });
  });

  it('clears the row when the Select is cleared', () => {
    expect(rowFromSelect(gender, null)).toEqual({
      id: 'GENDER',
      value_id: null,
      value_name: null,
      unit_id: null,
    });
  });

  it('keeps a stored value ML no longer lists', () => {
    // A category can drop a value the listing already carries; blanking it
    // silently would rewrite stored data on the next save.
    expect(rowFromSelect(gender, 'G9')).toEqual({
      id: 'GENDER',
      value_id: null,
      value_name: 'G9',
      unit_id: null,
    });
  });

  it('renders the stored row by id, and N/A as no selection', () => {
    expect(selectValueOf({ id: 'GENDER', value_id: 'G1', value_name: 'M', unit_id: null })).toBe(
      'G1',
    );
    expect(selectValueOf(naRow('GENDER'))).toBeNull();
    expect(selectValueOf(undefined)).toBeNull();
  });
});

describe('colliding option keys', () => {
  // The only way two entries claim the same key: one value's NAME equals
  // another value's real ML id. Unlikely with ML's numeric ids, and silent when
  // it happens — which is exactly why it is worth pinning.
  const colliding = attr({
    id: 'X',
    valueType: 'list',
    values: [
      { id: null, name: '2230284' }, // name-keyed, collides with the id below
      { id: '2230284', name: 'Algodão' }, // the real ML value
    ],
  });

  it('emits each Select key exactly once', () => {
    // A Mantine Select with duplicate values is ambiguous.
    const values = selectOptions(colliding).map((o) => o.value);
    expect(values).toEqual([...new Set(values)]);
  });

  it('lets the entry with a real ML id win the key', () => {
    expect(selectOptions(colliding)).toEqual([{ value: '2230284', label: 'Algodão' }]);
  });

  it('resolves the pick to the id-bearing value, not merely the first match', () => {
    // The one-pass `v.id ?? v.name` comparison returns the name-keyed entry
    // here, storing a value the operator never chose.
    expect(rowFromSelect(colliding, '2230284')).toEqual({
      id: 'X',
      value_id: '2230284',
      value_name: 'Algodão',
      unit_id: null,
    });
  });

  it('keeps ML’s own ordering when there is no collision', () => {
    // ML orders a category's values deliberately; deduplication must not
    // reshuffle every dropdown to fix a case that almost never happens.
    const ordered = attr({
      id: 'SIZE',
      valueType: 'list',
      values: [
        { id: 'S3', name: 'G' },
        { id: null, name: 'GG' },
        { id: 'S1', name: 'P' },
      ],
    });
    expect(selectOptions(ordered).map((o) => o.label)).toEqual(['G', 'GG', 'P']);
  });

  it('still resolves a name-keyed value when nothing collides', () => {
    const byName = attr({ id: 'X', valueType: 'list', values: [{ id: null, name: 'Único' }] });
    expect(rowFromSelect(byName, 'Único')).toEqual({
      id: 'X',
      value_id: null,
      value_name: 'Único',
      unit_id: null,
    });
  });

  it('drops a duplicate ML id rather than rendering it twice', () => {
    const dupe = attr({
      id: 'X',
      valueType: 'list',
      values: [
        { id: 'D1', name: 'Primeiro' },
        { id: 'D1', name: 'Repetido' },
      ],
    });
    expect(selectOptions(dupe)).toEqual([{ value: 'D1', label: 'Primeiro' }]);
  });
});
