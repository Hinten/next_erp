import { describe, expect, it } from 'vitest';
import {
  cargoMeta,
  cargoSchema,
  decodePermissoes,
  encodePermissoes,
} from './cargo';

describe('cargoSchema', () => {
  it('accepts a minimal cargo and applies the permissoes default', () => {
    const out = cargoSchema.parse({
      nome: 'Vendedor',
      grupoEconomico: 'ge_1',
    });
    expect(out).toEqual({
      nome: 'Vendedor',
      grupoEconomico: 'ge_1',
      permissoes: '0',
    });
  });

  it('rejects empty nome', () => {
    expect(
      cargoSchema.safeParse({ nome: '', grupoEconomico: 'ge_1' }).success,
    ).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      cargoSchema.safeParse({
        nome: 'x'.repeat(256),
        grupoEconomico: 'ge_1',
      }).success,
    ).toBe(false);
  });

  it('rejects non-numeric permissoes', () => {
    expect(
      cargoSchema.safeParse({
        nome: 'X',
        grupoEconomico: 'ge_1',
        permissoes: '0x1234',
      }).success,
    ).toBe(false);
  });

  it('accepts a very large decimal bitmask string', () => {
    const big = ((1n << 100n) - 1n).toString();
    const out = cargoSchema.parse({
      nome: 'Big',
      grupoEconomico: 'ge_1',
      permissoes: big,
    });
    expect(out.permissoes).toBe(big);
  });
});

describe('decodePermissoes / encodePermissoes', () => {
  it('round-trips arbitrary bigints', () => {
    const bits = (1n << 0n) | (1n << 33n) | (1n << 64n);
    expect(decodePermissoes({ permissoes: encodePermissoes(bits) })).toBe(bits);
  });

  it('returns 0n for missing or invalid input', () => {
    expect(decodePermissoes({ permissoes: '' })).toBe(0n);
    expect(decodePermissoes({ permissoes: 'not-a-number' })).toBe(0n);
  });
});

describe('cargoMeta', () => {
  it('targets the cargos collection', () => {
    expect(cargoMeta.collectionPath).toBe('cargos');
  });

  it('reuses the configuracoes BigInt permission bits', () => {
    expect(typeof cargoMeta.permissions.read).toBe('bigint');
    expect(cargoMeta.permissions.read).toBe(1n << 40n);
    expect(cargoMeta.permissions.write).toBe(1n << 41n);
  });
});
