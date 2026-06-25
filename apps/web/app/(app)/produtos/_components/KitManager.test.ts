import { describe, expect, it } from 'vitest';
import { kitWeightFormPatches, stripKitForSave } from './KitManager';

describe('stripKitForSave', () => {
  it('drops _delete entries and the transient marker, keeping a clean record', () => {
    const out = stripKitForSave({
      a: { quantidade: 2, limitarEstoque: true, timestamp: null },
      b: { quantidade: 1, limitarEstoque: false, timestamp: null, _delete: true },
    });
    expect(out).toEqual({ a: { quantidade: 2, limitarEstoque: true, timestamp: null } });
  });

  it('returns null for an empty or fully-deleted map', () => {
    expect(stripKitForSave(null)).toBeNull();
    expect(stripKitForSave({})).toBeNull();
    expect(
      stripKitForSave({
        a: { quantidade: 1, limitarEstoque: true, timestamp: null, _delete: true },
      }),
    ).toBeNull();
  });
});

describe('kitWeightFormPatches', () => {
  const current = { pesoBrutoKg: 1, pesoLiquidoKg: 0.8 };

  it('returns no patches when syncPesoToForm is off (variation-child editor)', () => {
    expect(kitWeightFormPatches(false, true, { bruto: 2, liquido: 1.5 }, current)).toEqual([]);
  });

  it('returns no patches when the produto is not a kit', () => {
    expect(kitWeightFormPatches(true, false, { bruto: 2, liquido: 1.5 }, current)).toEqual([]);
  });

  it('returns no patches while the weight has not resolved yet', () => {
    expect(kitWeightFormPatches(true, true, null, current)).toEqual([]);
  });

  it('returns no patches when the form already matches (no needless dirtying)', () => {
    expect(kitWeightFormPatches(true, true, { bruto: 1, liquido: 0.8 }, current)).toEqual([]);
  });

  it('patches only the fields that differ, skipping null computed weights', () => {
    expect(kitWeightFormPatches(true, true, { bruto: 2, liquido: 0.8 }, current)).toEqual([
      { field: 'pesoBrutoKg', value: 2 },
    ]);
    expect(kitWeightFormPatches(true, true, { bruto: null, liquido: 1.5 }, current)).toEqual([
      { field: 'pesoLiquidoKg', value: 1.5 },
    ]);
  });
});
