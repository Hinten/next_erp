import { describe, expect, it } from 'vitest';
import {
  aggregatePermissoes,
  isSuperUserBits,
  SUPERUSER_MASK,
  usuarioMeta,
  usuarioSchema,
} from './usuario';

describe('usuarioSchema', () => {
  it('parses a minimal user and applies defaults', () => {
    const out = usuarioSchema.parse({
      nome: 'Ana',
      email: 'ana@example.com',
    });
    expect(out).toMatchObject({
      nome: 'Ana',
      email: 'ana@example.com',
      cargos: [],
      colaborador: false,
      ativo: true,
      isSuperUser: false,
      jaFoiColaborador: false,
      jaFoiSuperUser: false,
      externalId: null,
    });
  });

  it('rejects an invalid email', () => {
    expect(
      usuarioSchema.safeParse({
        nome: 'Ana',
        email: 'not-an-email',
      }).success,
    ).toBe(false);
  });

  it('rejects empty nome', () => {
    expect(
      usuarioSchema.safeParse({
        nome: '',
        email: 'ana@example.com',
      }).success,
    ).toBe(false);
  });

  it('defaults email to null when absent', () => {
    const out = usuarioSchema.parse({ nome: 'Sem Email' });
    expect(out.email).toBeNull();
  });

  it('parses a sem-auth external-channel contact: externalId set, email null', () => {
    // Mirrors the WhatsApp discover_user port (#527): a chat participant that
    // never authenticates via Firebase Auth, identified only by the
    // sha256('<canal>-<externalId>') hash.
    const out = usuarioSchema.parse({
      nome: 'Cliente WhatsApp',
      email: null,
      externalId: 'a3f8...deadbeef',
    });
    expect(out.email).toBeNull();
    expect(out.externalId).toBe('a3f8...deadbeef');
  });

  it('defaults apelido to null when absent', () => {
    const out = usuarioSchema.parse({ nome: 'Sem Apelido' });
    expect(out.apelido).toBeNull();
  });

  it('round-trips apelido — the ML buyer nickname on a sem-auth contact', () => {
    // The ML claims import (Step 14) stores the buyer's site nickname here.
    const out = usuarioSchema.parse({
      nome: 'Cliente Mercado Livre',
      apelido: 'COMPRADOR123',
      email: null,
      externalId: '92ba...5014',
    });
    expect(out.apelido).toBe('COMPRADOR123');
    expect(usuarioSchema.parse(out).apelido).toBe('COMPRADOR123');
  });
});

describe('isSuperUserBits', () => {
  it('is true for the SUPERUSER_MASK sentinel', () => {
    expect(isSuperUserBits(SUPERUSER_MASK)).toBe(true);
  });

  it('is false for an empty claim', () => {
    expect(isSuperUserBits(0n)).toBe(false);
  });

  it('is false for any defined PERM bit alone', () => {
    expect(isSuperUserBits(1n << 50n)).toBe(false);
    expect(isSuperUserBits((1n << 51n) - 1n)).toBe(false);
  });

  it('is false for domains above bit 60 (the old >= 2^60 heuristic misfired here)', () => {
    expect(isSuperUserBits(7n << 72n)).toBe(false); // fiscal
    expect(isSuperUserBits(7n << 88n)).toBe(false); // frete
    expect(isSuperUserBits((7n << 88n) | (7n << 72n) | (7n << 16n))).toBe(false);
  });

  it('is false for claims minted with the legacy 64-bit mask (re-mint required)', () => {
    expect(isSuperUserBits((1n << 64n) - 1n)).toBe(false);
  });
});

describe('aggregatePermissoes', () => {
  const cargos = new Map([
    ['admin', { permissoes: ((1n << 40n) | (1n << 41n)).toString() }],
    ['sales', { permissoes: ((1n << 0n) | (1n << 1n)).toString() }],
  ]);

  it('OR-merges bits from every assigned cargo', () => {
    const bits = aggregatePermissoes({ cargos: ['admin', 'sales'], isSuperUser: false }, cargos);
    expect(bits).toBe((1n << 0n) | (1n << 1n) | (1n << 40n) | (1n << 41n));
  });

  it('ignores cargo IDs that are not in the map (treats missing as 0n)', () => {
    const bits = aggregatePermissoes({ cargos: ['admin', 'ghost'], isSuperUser: false }, cargos);
    expect(bits).toBe((1n << 40n) | (1n << 41n));
  });

  it('returns the full mask for a superuser regardless of cargos', () => {
    const bits = aggregatePermissoes({ cargos: [], isSuperUser: true }, new Map());
    expect(bits).toBe(SUPERUSER_MASK);
    // The mask must cover every domain above bit 64 (estoque/fiscal/arquivo/frete).
    expect(bits & (7n << 88n)).toBe(7n << 88n);
  });

  it('returns 0n when no cargos are assigned and not a superuser', () => {
    expect(aggregatePermissoes({ cargos: [], isSuperUser: false }, cargos)).toBe(0n);
  });
});

describe('usuarioMeta', () => {
  it('targets the usuarios collection', () => {
    expect(usuarioMeta.collectionPath).toBe('usuarios');
  });
});
