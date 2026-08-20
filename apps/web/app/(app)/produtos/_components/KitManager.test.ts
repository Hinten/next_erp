import { describe, expect, it } from 'vitest';
import type { DimensoesKit } from '@delfrance/schemas';
import { kitDimensoesFormPatches, stripKitForSave } from './KitManager';

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

describe('kitDimensoesFormPatches', () => {
  const current = {
    pesoBrutoKg: 1,
    pesoLiquidoKg: 0.8,
    alturaCm: 5,
    larguraCm: 10,
    profundidadeCm: 10,
  };
  const rollup = (over: Partial<DimensoesKit> = {}): DimensoesKit => ({
    pesoBrutoKg: 1,
    pesoLiquidoKg: 0.8,
    alturaCm: 5,
    larguraCm: 10,
    profundidadeCm: 10,
    ...over,
  });

  it('returns no patches when syncPesoToForm is off (variation-child editor)', () => {
    expect(kitDimensoesFormPatches(false, true, rollup({ pesoBrutoKg: 2 }), current)).toEqual([]);
  });

  it('returns no patches when the produto is not a kit', () => {
    expect(kitDimensoesFormPatches(true, false, rollup({ pesoBrutoKg: 2 }), current)).toEqual([]);
  });

  it('returns no patches while the rollup has not resolved yet', () => {
    expect(kitDimensoesFormPatches(true, true, null, current)).toEqual([]);
  });

  it('returns no patches when the form already matches (no needless dirtying)', () => {
    expect(kitDimensoesFormPatches(true, true, rollup(), current)).toEqual([]);
  });

  it('patches only the fields that differ', () => {
    expect(
      kitDimensoesFormPatches(true, true, rollup({ pesoBrutoKg: 2, alturaCm: 7 }), current),
    ).toEqual([
      { field: 'pesoBrutoKg', value: 2 },
      { field: 'alturaCm', value: 7 },
    ]);
  });

  it('SKIPS a null field rather than writing it', () => {
    // `null` means either "reads still in flight" or "not derivable" — both must
    // leave the stored value alone. Writing the estimator's DIMENSOES_PADRAO
    // fallback would turn a guess into a stored measurement.
    expect(
      kitDimensoesFormPatches(
        true,
        true,
        rollup({ pesoBrutoKg: null, alturaCm: null, larguraCm: null, profundidadeCm: null }),
        { ...current, pesoLiquidoKg: 9 },
      ),
    ).toEqual([{ field: 'pesoLiquidoKg', value: 0.8 }]);
  });

  it('patches every derived field when the form is empty', () => {
    // Pins that all FIVE fields are covered — a field added to DimensoesKit but
    // forgotten in the patch builder shows up here as a missing entry.
    expect(kitDimensoesFormPatches(true, true, rollup(), {})).toEqual([
      { field: 'pesoBrutoKg', value: 1 },
      { field: 'pesoLiquidoKg', value: 0.8 },
      { field: 'alturaCm', value: 5 },
      { field: 'larguraCm', value: 10 },
      { field: 'profundidadeCm', value: 10 },
    ]);
  });
});
