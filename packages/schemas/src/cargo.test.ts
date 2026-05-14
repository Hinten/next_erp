import { describe, expect, it } from 'vitest';
import {
  cargoMeta,
  cargoSchema,
  decodePermissoes,
  encodePermissoes,
} from './cargo';

describe('cargoSchema', () => {
  it('accepts a minimal cargo with null descricao and applies permissoes default', () => {
    const out = cargoSchema.parse({ nome: 'Vendedor', descricao: null });
    expect(out).toEqual({
      nome: 'Vendedor',
      descricao: null,
      permissoes: '0',
    });
  });

  it('rejects empty nome', () => {
    expect(
      cargoSchema.safeParse({ nome: '', descricao: null }).success,
    ).toBe(false);
  });

  it('rejects nome longer than 255 chars', () => {
    expect(
      cargoSchema.safeParse({ nome: 'x'.repeat(256), descricao: null }).success,
    ).toBe(false);
  });

  it('rejects non-numeric permissoes', () => {
    expect(
      cargoSchema.safeParse({
        nome: 'X',
        descricao: null,
        permissoes: '0x1234',
      }).success,
    ).toBe(false);
  });

  it('accepts a very large decimal bitmask string', () => {
    const big = ((1n << 100n) - 1n).toString();
    const out = cargoSchema.parse({
      nome: 'Big',
      descricao: null,
      permissoes: big,
    });
    expect(out.permissoes).toBe(big);
  });

  // Regression: Firebase JS SDK v12 rejects `undefined` in addDoc/setDoc.
  // descricao must be `string | null`, never `undefined` — i.e. the schema
  // requires the field to be present (with null) rather than missing.
  it('rejects missing descricao (must be string | null, not undefined)', () => {
    expect(cargoSchema.safeParse({ nome: 'X' }).success).toBe(false);
  });

  it('accepts a non-empty descricao string', () => {
    const out = cargoSchema.parse({ nome: 'X', descricao: 'Gerente regional' });
    expect(out.descricao).toBe('Gerente regional');
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
