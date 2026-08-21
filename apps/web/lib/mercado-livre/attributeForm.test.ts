import { describe, expect, it } from 'vitest';

import type { MercadoLivreCategoriaAtributo } from './client';
import {
  NA_VALUE_ID,
  type AttrRow,
  applySuggestions,
  attributesForSave,
  draftTypedValue,
  effectiveUnit,
  isFilled,
  isNumericAttr,
  naRow,
  numberUnitOptions,
  resolveTypedValue,
  rowFromSelect,
  emptyRow,
  seedRow,
  seedRows,
  selectOptions,
  selectValueOf,
  splitNumberUnit,
  unitOptions,
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
    expect(widgetKind(attr({ id: 'A', valueType: 'number_unit' }))).toBe('number_unit');
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

/** A length attribute the way ML ships one: several units, one of them default. */
function lengthAttr(over: Partial<MercadoLivreCategoriaAtributo> = {}) {
  return attr({
    id: 'LENGTH',
    valueType: 'number_unit',
    defaultUnit: 'cm',
    allowedUnits: [
      { id: 'cm', name: 'cm' },
      { id: 'mm', name: 'mm' },
      { id: 'm', name: 'm' },
    ],
    ...over,
  });
}

describe('unitOptions', () => {
  it("preserves ML's order and labels by id", () => {
    expect(unitOptions(lengthAttr())).toEqual([
      { value: 'cm', label: 'cm' },
      { value: 'mm', label: 'mm' },
      { value: 'm', label: 'm' },
    ]);
  });

  it('spells out the inch unit, whose id is a bare double quote', () => {
    const a = lengthAttr({
      allowedUnits: [
        { id: 'cm', name: 'cm' },
        { id: '"', name: '"' },
      ],
    });
    // The VALUE stays `"` — that is what ML expects in `unit_id`.
    expect(unitOptions(a)).toEqual([
      { value: 'cm', label: 'cm' },
      { value: '"', label: 'pol. (")' },
    ]);
  });

  it('adds a defaultUnit ML left out of allowed_units', () => {
    const a = lengthAttr({ defaultUnit: 'in', allowedUnits: [{ id: 'cm', name: 'cm' }] });
    expect(unitOptions(a).map((u) => u.value)).toEqual(['cm', 'in']);
  });

  it('KEEPS a stored unit the category no longer allows', () => {
    // Dropping it would leave the Select rendering a value it cannot offer,
    // which reads as the unit having changed by itself.
    expect(unitOptions(lengthAttr(), 'pol').map((u) => u.value)).toEqual(['cm', 'mm', 'm', 'pol']);
  });

  it('never repeats a unit, and ignores blank ids', () => {
    const a = lengthAttr({
      allowedUnits: [
        { id: 'cm', name: 'cm' },
        { id: '', name: '' },
        { id: null, name: 'x' },
      ],
    });
    expect(unitOptions(a, 'cm').map((u) => u.value)).toEqual(['cm']);
  });

  it('is empty for an attribute with no units at all', () => {
    expect(unitOptions(attr({ id: 'BRAND' }))).toEqual([]);
  });
});

describe('effectiveUnit', () => {
  it('prefers what the row stores', () => {
    expect(effectiveUnit(lengthAttr(), { unit_id: 'mm' })).toBe('mm');
  });

  it('falls back to the category default', () => {
    expect(effectiveUnit(lengthAttr(), { unit_id: null })).toBe('cm');
    expect(effectiveUnit(lengthAttr(), undefined)).toBe('cm');
  });

  it('falls back to the only unit on offer when there is no default', () => {
    const a = lengthAttr({ defaultUnit: null });
    expect(effectiveUnit(a, { unit_id: null })).toBe('cm');
  });

  it('is null when ML gave the attribute no unit', () => {
    expect(effectiveUnit(attr({ id: 'BRAND' }), { unit_id: null })).toBeNull();
  });
});

describe('splitNumberUnit', () => {
  it("recovers the unit ML bakes into an item's value_name", () => {
    // `GET /items` answers `'355 mL'` with NO unit_id — the pair lives in
    // `value_struct`. This is the parse that keeps the seller's own unit.
    const a = lengthAttr({
      allowedUnits: [
        { id: 'mL', name: 'mL' },
        { id: 'L', name: 'L' },
      ],
    });
    expect(splitNumberUnit(a, '355 mL')).toEqual({ value: '355', unit: 'mL' });
  });

  it("returns ML's casing, not the operator's", () => {
    const a = lengthAttr({ allowedUnits: [{ id: 'mL', name: 'mL' }] });
    expect(splitNumberUnit(a, '355 ml').unit).toBe('mL');
  });

  it('matches the LONGEST unit first', () => {
    // `m` would otherwise win on `'55 mm'` and turn 55 millimetres into 55 m.
    expect(splitNumberUnit(lengthAttr(), '55 mm')).toEqual({ value: '55', unit: 'mm' });
    expect(splitNumberUnit(lengthAttr(), '55 m')).toEqual({ value: '55', unit: 'm' });
  });

  it('needs no separator, and accepts either decimal convention', () => {
    expect(splitNumberUnit(lengthAttr(), '62.5cm')).toEqual({ value: '62.5', unit: 'cm' });
    expect(splitNumberUnit(lengthAttr(), '62,5 cm')).toEqual({ value: '62,5', unit: 'cm' });
  });

  it('handles the inch unit', () => {
    const a = lengthAttr({ allowedUnits: [{ id: '"', name: '"' }] });
    expect(splitNumberUnit(a, '36 "')).toEqual({ value: '36', unit: '"' });
  });

  it('leaves a bare number alone', () => {
    expect(splitNumberUnit(lengthAttr(), '55')).toEqual({ value: '55', unit: null });
  });

  it('NEVER guesses: a non-numeric head is not a measurement', () => {
    // `'10 - 20 cm'` is a range, not a number plus a unit; splitting it would
    // be exactly the silent rewrite this function exists to prevent.
    expect(splitNumberUnit(lengthAttr(), '10 - 20 cm')).toEqual({
      value: '10 - 20 cm',
      unit: null,
    });
    // A unit with nothing in front of it is whatever was typed.
    expect(splitNumberUnit(lengthAttr(), 'cm')).toEqual({ value: 'cm', unit: null });
  });

  it('ignores a unit the category does not know', () => {
    expect(splitNumberUnit(lengthAttr(), '55 ft')).toEqual({ value: '55 ft', unit: null });
  });

  it('tolerates an empty value', () => {
    expect(splitNumberUnit(lengthAttr(), null)).toEqual({ value: '', unit: null });
  });
});

describe('numberUnitOptions', () => {
  const bottle = attr({
    id: 'VOLUME',
    valueType: 'number_unit',
    defaultUnit: 'mL',
    allowedUnits: [
      { id: 'mL', name: 'mL' },
      { id: 'L', name: 'L' },
    ],
    values: [
      { id: 'v1', name: '355 mL' },
      { id: 'v2', name: '473 mL' },
      { id: 'v3', name: '1 L' },
    ],
  });

  it('offers the NUMBER, not the number-plus-unit the box no longer holds', () => {
    expect(numberUnitOptions(bottle, 'mL')).toEqual(['355', '473']);
  });

  it('hides values measured in another unit', () => {
    // Offering the `1` from `'1 L'` while the box reads millilitres would put a
    // 1000x error one click away.
    expect(numberUnitOptions(bottle, 'L')).toEqual(['1']);
  });

  it('is empty for the attributes ML ships with no values at all', () => {
    expect(numberUnitOptions(lengthAttr(), 'cm')).toEqual([]);
  });
});

describe('seedRow', () => {
  it('splits a value whose unit is baked in, keeping the SELLER unit', () => {
    // The tab-through bug: left whole, the first blur ran this through
    // `digitsOnly` and stamped `defaultUnit` over it, silently restating the
    // measurement in centimetres.
    const a = lengthAttr({ defaultUnit: 'cm' });
    expect(seedRow(a, { id: 'LENGTH', value_name: '55 mm' })).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'mm',
    });
  });

  it('leaves a row that already stores its unit apart', () => {
    const a = lengthAttr();
    expect(seedRow(a, { id: 'LENGTH', value_name: '55', unit_id: 'mm' })).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'mm',
    });
  });

  it('does not touch the N/A sentinel', () => {
    const a = lengthAttr();
    expect(seedRow(a, { id: 'LENGTH', value_id: NA_VALUE_ID, value_name: 'N/A' })).toEqual({
      id: 'LENGTH',
      value_id: NA_VALUE_ID,
      value_name: 'N/A',
      unit_id: null,
    });
  });

  it('fills in the unit the picker shows, even with nothing to split', () => {
    // ⚠️ The row must agree with what is on screen. A legacy Flutter row stores
    // a bare `'55'` with no unit; left null, the field still RENDERS `cm` (the
    // effective unit) and the next blur resolved to it and reported a change —
    // unsaved changes on a listing nobody touched, from a tab keypress.
    expect(seedRow(lengthAttr(), { id: 'LENGTH', value_name: '55' })).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'cm',
    });
  });

  it('drops the pair id when it splits', () => {
    // ML's value_id names the PAIR — 3681798 IS '355 mL' — and nothing can
    // rebuild it from the '355' left behind, so a row that kept it would lose it
    // on the first blur and report a phantom edit.
    const volume = attr({
      id: 'VOLUME',
      valueType: 'number_unit',
      defaultUnit: 'ml',
      allowedUnits: [{ id: 'ml', name: 'ml' }],
    });
    expect(seedRow(volume, { id: 'VOLUME', value_id: '3681798', value_name: '355 ml' })).toEqual({
      id: 'VOLUME',
      value_id: null,
      value_name: '355',
      unit_id: 'ml',
    });
  });

  it('keeps a value_id it did NOT split', () => {
    const volume = attr({
      id: 'VOLUME',
      valueType: 'number_unit',
      defaultUnit: 'ml',
      allowedUnits: [{ id: 'ml', name: 'ml' }],
    });
    expect(
      seedRow(volume, { id: 'VOLUME', value_id: 'v1', value_name: '355', unit_id: 'ml' }).value_id,
    ).toBe('v1');
  });

  it('heals a row the OLD code double-unitised', () => {
    // ⚠️ The shape `main` itself persists. An imported `'55 cm'` (unit_id null)
    // survives one save of any other attribute: `resolveTypedValue` finds no
    // enumerated value named `'55 cm'` — LENGTH-style measurements ship none —
    // so it keeps the name WHOLE and stamps `defaultUnit` beside it. The wire
    // transform then appends the unit again: `'55 cm cm'`.
    expect(seedRow(lengthAttr(), { id: 'LENGTH', value_name: '55 cm', unit_id: 'cm' })).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'cm',
    });
  });

  it('prefers the unit INSIDE the value when the stored one disagrees', () => {
    // `digitsOnly` makes a unit untypeable, so one sitting inside `value_name`
    // can only have come from ML or the legacy corpus — it is what the seller
    // actually saw. A contradicting `unit_id` is the spurious `defaultUnit`
    // stamp described above.
    expect(seedRow(lengthAttr(), { id: 'LENGTH', value_name: '55 cm', unit_id: 'mm' })).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'cm',
    });
  });

  it('does not split a plain string attribute', () => {
    // `'Nike Air'` on a BRAND must survive intact even if `m` were a unit.
    expect(seedRow(attr({ id: 'BRAND' }), { id: 'BRAND', value_name: 'Nike Air' })).toEqual({
      id: 'BRAND',
      value_id: null,
      value_name: 'Nike Air',
      unit_id: null,
    });
  });
});

describe('draftTypedValue', () => {
  // The reported bug: an operator could not type a space into an attribute.
  // `resolveTypedValue` on the change path trimmed the text the input renders
  // back, so the space vanished before the caret moved.
  it('KEEPS a trailing space, so a multi-word value is typeable', () => {
    expect(draftTypedValue(attr({ id: 'BRAND' }), 'Nike ', null)).toEqual({
      id: 'BRAND',
      value_id: null,
      value_name: 'Nike ',
      unit_id: null,
    });
  });

  it('does NOT snap to a known option while typing', () => {
    // The second stripper: on a category shipping `Nike`, resolving on change
    // matched `Nike ` back to `Nike` and ate the space again — `Nike Air` was
    // unreachable however slowly you typed it.
    const brand = attr({ id: 'BRAND', values: [{ id: 'B1', name: 'Nike' }] });
    expect(draftTypedValue(brand, 'Nike ', null)).toEqual({
      id: 'BRAND',
      value_id: null,
      value_name: 'Nike ',
      unit_id: null,
    });
  });

  it('keeps a blank draft so a LEADING space is typeable too', () => {
    // Harmless: `isFilled` tests the trimmed name, so the row still reads as
    // empty everywhere it matters.
    const row = draftTypedValue(attr({ id: 'MODEL' }), '  ', null);
    expect(row.value_name).toBe('  ');
    expect(isFilled(row)).toBe(false);
  });

  it('clears the row only when the field is truly empty', () => {
    expect(draftTypedValue(attr({ id: 'MODEL' }), '', null)).toEqual({
      id: 'MODEL',
      value_id: null,
      value_name: null,
      unit_id: null,
    });
  });

  it('attaches the unit it was GIVEN to a number_unit draft', () => {
    const length = attr({ id: 'LENGTH', valueType: 'number_unit', defaultUnit: 'cm' });
    expect(draftTypedValue(length, '55', 'cm')).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'cm',
    });
  });

  it('does NOT fall back to defaultUnit when another unit is passed', () => {
    // The unpickable-unit bug: this used to read `attr.defaultUnit`, so the
    // operator's choice was overwritten on the very next keystroke.
    const length = attr({
      id: 'LENGTH',
      valueType: 'number_unit',
      defaultUnit: 'cm',
      allowedUnits: [
        { id: 'cm', name: 'cm' },
        { id: 'mm', name: 'mm' },
      ],
    });
    expect(draftTypedValue(length, '55', 'mm').unit_id).toBe('mm');
  });

  it('never attaches a unit to an attribute that has none', () => {
    expect(draftTypedValue(attr({ id: 'MODEL' }), '55', 'cm').unit_id).toBeNull();
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
    expect(resolveTypedValue(material, 'algodao', null)).toEqual({
      id: 'MATERIAL',
      value_id: 'v-alg',
      value_name: 'Algodão',
      unit_id: null,
    });
  });

  it('keeps unmatched text as a free value', () => {
    expect(resolveTypedValue(attr({ id: 'MODEL' }), '  XT-500 ', null)).toEqual({
      id: 'MODEL',
      value_id: null,
      value_name: 'XT-500',
      unit_id: null,
    });
  });

  it('attaches the unit it was GIVEN to a number_unit value', () => {
    // Without unit_id the wire transform sends a bare number where ML wants
    // "55 cm" — the legacy AI path never set it.
    const length = attr({ id: 'LENGTH', valueType: 'number_unit', defaultUnit: 'cm' });
    expect(resolveTypedValue(length, '55', 'cm')).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: '55',
      unit_id: 'cm',
    });
  });

  it('keeps the operator unit rather than re-deriving the default', () => {
    const length = attr({
      id: 'LENGTH',
      valueType: 'number_unit',
      defaultUnit: 'cm',
      allowedUnits: [
        { id: 'cm', name: 'cm' },
        { id: 'mm', name: 'mm' },
      ],
    });
    expect(resolveTypedValue(length, '55', 'mm').unit_id).toBe('mm');
  });

  it('clears the row on empty input', () => {
    expect(resolveTypedValue(attr({ id: 'MODEL' }), '   ', null)).toEqual({
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

  it('TRIMS a free-text draft, so a save without a blur stores clean text', () => {
    // The field holds the raw draft so a space is typeable; blur normally
    // resolves it, but Enter on the form saves without one. This is the boundary
    // that makes correctness independent of a focus event.
    const out = attributesForSave(
      [brand],
      [{ id: 'BRAND', value_id: null, value_name: '  Nike Air ', unit_id: null }],
      null,
    );
    expect(out).toEqual([{ id: 'BRAND', value_name: 'Nike Air' }]);
  });

  it('resolves an unblurred draft to ML’s value id when it names a known value', () => {
    const material = attr({ id: 'MATERIAL', values: [{ id: 'M1', name: 'Algodão' }] });
    const out = attributesForSave(
      [material],
      [{ id: 'MATERIAL', value_id: null, value_name: 'algodao ', unit_id: null }],
      null,
    );
    expect(out).toEqual([{ id: 'MATERIAL', value_id: 'M1', value_name: 'Algodão' }]);
  });

  it('leaves an id-bearing row alone rather than re-matching it', () => {
    // A `rowFromSelect` pick and the N/A sentinel already carry ML's own value;
    // re-resolving by name could only move them.
    const out = attributesForSave(
      [attr({ id: 'BRAND', values: [{ id: 'B1', name: 'Nike' }] })],
      [naRow('BRAND')],
      null,
    );
    expect(out).toEqual([{ id: 'BRAND', value_id: NA_VALUE_ID, value_name: 'N/A' }]);
  });

  it('drops a whitespace-only draft instead of storing a blank', () => {
    const out = attributesForSave(
      [brand],
      [{ id: 'BRAND', value_id: null, value_name: '   ', unit_id: null }],
      null,
    );
    expect(out).toEqual([]);
  });
});

describe('emptyRow', () => {
  it('starts a number_unit on the unit its picker will show', () => {
    expect(emptyRow(lengthAttr())).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: null,
      unit_id: 'cm',
    });
  });

  it('reads as empty, so an untouched field is still never saved', () => {
    expect(isFilled(emptyRow(lengthAttr()))).toBe(false);
  });

  it('gives an attribute with no units a plain blank row', () => {
    expect(emptyRow(attr({ id: 'BRAND' }))).toEqual({
      id: 'BRAND',
      value_id: null,
      value_name: null,
      unit_id: null,
    });
  });
});

describe('clearing a number_unit box', () => {
  it('KEEPS the unit — emptying the number says nothing about it', () => {
    // Dropping it snapped the picker back to `defaultUnit` behind the operator.
    const length = lengthAttr();
    expect(draftTypedValue(length, '', 'mm')).toEqual({
      id: 'LENGTH',
      value_id: null,
      value_name: null,
      unit_id: 'mm',
    });
    expect(resolveTypedValue(length, '  ', 'mm').unit_id).toBe('mm');
  });

  it('still counts as empty, so it is never written', () => {
    const row = draftTypedValue(lengthAttr(), '', 'mm');
    expect(isFilled(row)).toBe(false);
    expect(attributesForSave([lengthAttr()], [row], null)).toEqual([]);
  });
});

describe('attributesForSave — units', () => {
  const length = lengthAttr();

  it('stores the number and the unit APART, as the wire transform expects', () => {
    const out = attributesForSave(
      [length],
      [{ id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'mm' }],
      null,
    );
    expect(out).toEqual([{ id: 'LENGTH', value_name: '55', unit_id: 'mm' }]);
  });

  it("keeps the operator's unit instead of re-deriving defaultUnit", () => {
    // The whole point of the picker: `defaultUnit` is `cm` here, and `mm` has
    // to survive the resolution that runs on every save.
    const out = attributesForSave(
      [length],
      [{ id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'mm' }],
      [{ id: 'LENGTH', value_name: '55', unit_id: 'mm' }],
    );
    expect(out[0]!.unit_id).toBe('mm');
  });

  it('never lets a double-unitised row reach the wire twice', () => {
    const length = lengthAttr();
    const stored = [{ id: 'LENGTH', value_name: '55 cm', unit_id: 'cm' }];
    const out = attributesForSave([length], seedRows([length], stored), stored);
    // `attributeToMercadoLivre` joins name + unit, so a whole `'55 cm'` here
    // would ship as `'55 cm cm'`.
    expect(out).toEqual([{ id: 'LENGTH', value_name: '55', unit_id: 'cm' }]);
  });

  it('round-trips an imported value through seedRow without changing it', () => {
    // `'55 mm'` imported from ML, seeded, saved untouched: still 55 mm.
    const seeded = seedRow(length, { id: 'LENGTH', value_name: '55 mm' });
    const out = attributesForSave([length], [seeded], [{ id: 'LENGTH', value_name: '55 mm' }]);
    expect(out).toEqual([{ id: 'LENGTH', value_name: '55', unit_id: 'mm' }]);
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

  it('splits a model answer that spelled the unit out', () => {
    // Left whole this reaches ML as `'55 mm mm'`, because the wire transform
    // appends unit_id to the value name.
    const length = lengthAttr();
    const next = applySuggestions(
      [length],
      [{ id: 'LENGTH', value_id: null, value_name: null, unit_id: null }],
      [{ id: 'LENGTH', value_id: null, value_name: '55 mm', unit_id: 'cm' }],
    );
    expect(next[0]).toEqual({ id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'mm' });
  });

  it('falls back to the row unit when the suggestion carries none', () => {
    const length = lengthAttr();
    const next = applySuggestions(
      [length],
      [{ id: 'LENGTH', value_id: null, value_name: null, unit_id: 'mm' }],
      [{ id: 'LENGTH', value_id: null, value_name: '55', unit_id: null }],
    );
    expect(next[0]!.unit_id).toBe('mm');
  });

  it('leaves an N/A suggestion on a number_unit alone', () => {
    const length = lengthAttr();
    const next = applySuggestions(
      [length],
      [{ id: 'LENGTH', value_id: null, value_name: null, unit_id: null }],
      [{ id: 'LENGTH', value_id: NA_VALUE_ID, value_name: 'N/A', unit_id: null }],
    );
    expect(next[0]).toEqual({
      id: 'LENGTH',
      value_id: NA_VALUE_ID,
      value_name: 'N/A',
      unit_id: null,
    });
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
