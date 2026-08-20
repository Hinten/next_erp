import { describe, expect, it } from 'vitest';
import { normalizeVolume, toVolumeInput } from '../../src/melhor-envio/calculate';

describe('toVolumeInput', () => {
  it('remaps the Flutter axis names onto the API ones', () => {
    // largura→width, altura→height, comprimento→length. Getting one wrong is
    // invisible: the payload still validates, the quote is just for a
    // differently-shaped box.
    expect(
      toVolumeInput({
        pesoBruto: 2,
        pesoLiquido: 1.8,
        dimensoes: { altura: 10, largura: 20, comprimento: 30 },
      }),
    ).toEqual({ height: 10, width: 20, length: 30, weight: 2 });
  });

  it('prefers gross weight and falls back to net', () => {
    expect(toVolumeInput({ pesoBruto: null, pesoLiquido: 1.5 }).weight).toBe(1.5);
    expect(toVolumeInput({ pesoBruto: 4, pesoLiquido: 1.5 }).weight).toBe(4);
  });

  it('emits null rather than a default, leaving normalizeVolume the one source of defaults', () => {
    expect(toVolumeInput({})).toEqual({
      width: null,
      height: null,
      length: null,
      weight: null,
    });
    expect(normalizeVolume(toVolumeInput({}))).toEqual({
      width: 20,
      height: 20,
      length: 20,
      weight: 1,
    });
  });

  it('treats a null dimensoes block like an absent one', () => {
    expect(toVolumeInput({ pesoBruto: 3, dimensoes: null })).toEqual({
      width: null,
      height: null,
      length: null,
      weight: 3,
    });
  });

  it('keeps a stored zero instead of coercing it away', () => {
    // `?? null` must not swallow 0 — a 0 dimension is bad data the operator
    // should see quoted as-is, not silently turned into the 20cm default.
    expect(
      toVolumeInput({ pesoBruto: 0, dimensoes: { altura: 0, largura: 0, comprimento: 0 } }),
    ).toEqual({ width: 0, height: 0, length: 0, weight: 0 });
  });
});
