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
  seedRows,
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
