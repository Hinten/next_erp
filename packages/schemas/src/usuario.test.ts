import { describe, expect, it } from 'vitest';
import { aggregatePermissoes, usuarioMeta, usuarioSchema } from './usuario';

describe('usuarioSchema', () => {
  it('parses a minimal user and applies defaults', () => {
    const out = usuarioSchema.parse({
      nome: 'Ana',
      email: 'ana@example.com',
      grupoEconomico: 'ge_1',
    });
    expect(out).toMatchObject({
      nome: 'Ana',
      email: 'ana@example.com',
      grupoEconomico: 'ge_1',
      cargos: [],
      colaborador: false,
      ativo: true,
      isSuperUser: false,
      jaFoiColaborador: false,
      jaFoiSuperUser: false,
    });
  });

  it('rejects an invalid email', () => {
    expect(
      usuarioSchema.safeParse({
        nome: 'Ana',
        email: 'not-an-email',
        grupoEconomico: 'ge_1',
      }).success,
    ).toBe(false);
  });

  it('rejects empty nome', () => {
    expect(
      usuarioSchema.safeParse({
        nome: '',
        email: 'ana@example.com',
        grupoEconomico: 'ge_1',
      }).success,
    ).toBe(false);
  });
});

describe('aggregatePermissoes', () => {
  const cargos = new Map([
    ['admin', { permissoes: ((1n << 40n) | (1n << 41n)).toString() }],
    ['sales', { permissoes: ((1n << 0n) | (1n << 1n)).toString() }],
  ]);

  it('OR-merges bits from every assigned cargo', () => {
    const bits = aggregatePermissoes(
      { cargos: ['admin', 'sales'], isSuperUser: false },
      cargos,
    );
    expect(bits).toBe((1n << 0n) | (1n << 1n) | (1n << 40n) | (1n << 41n));
  });

  it('ignores cargo IDs that are not in the map (treats missing as 0n)', () => {
    const bits = aggregatePermissoes(
      { cargos: ['admin', 'ghost'], isSuperUser: false },
      cargos,
    );
    expect(bits).toBe((1n << 40n) | (1n << 41n));
  });

  it('returns the full mask for a superuser regardless of cargos', () => {
    const bits = aggregatePermissoes(
      { cargos: [], isSuperUser: true },
      new Map(),
    );
    expect(bits).toBe((1n << 64n) - 1n);
  });

  it('returns 0n when no cargos are assigned and not a superuser', () => {
    expect(
      aggregatePermissoes({ cargos: [], isSuperUser: false }, cargos),
    ).toBe(0n);
  });
});

describe('usuarioMeta', () => {
  it('targets the usuarios collection', () => {
    expect(usuarioMeta.collectionPath).toBe('usuarios');
  });
});
