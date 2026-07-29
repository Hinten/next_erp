import { describe, expect, it } from 'vitest';
import {
  deriveNomeCompletoOnSave,
  makeNomeCompleto,
  outerRefForCategoriaId,
  parentBreadcrumbFromDoc,
} from './nomeCompleto';

describe('makeNomeCompleto', () => {
  it('returns nome alone for a root (no parent breadcrumb)', () => {
    expect(makeNomeCompleto('Camisetas', null)).toBe('Camisetas');
    expect(makeNomeCompleto('Camisetas', undefined)).toBe('Camisetas');
    expect(makeNomeCompleto('Camisetas', '')).toBe('Camisetas');
    expect(makeNomeCompleto('Camisetas', '   ')).toBe('Camisetas');
  });

  it('joins parent breadcrumb with ` > ` (ML import format)', () => {
    expect(makeNomeCompleto('Camisetas', 'Roupas')).toBe('Roupas > Camisetas');
    expect(makeNomeCompleto('P', 'A > B')).toBe('A > B > P');
  });

  it('trims the parent breadcrumb before joining', () => {
    expect(makeNomeCompleto('Filho', '  Pai  ')).toBe('Pai > Filho');
  });
});

describe('parentBreadcrumbFromDoc', () => {
  it('prefers nomeCompleto over nome', () => {
    expect(parentBreadcrumbFromDoc({ nome: 'X', nomeCompleto: 'A > B' })).toBe('A > B');
  });

  it('falls back to nome when nomeCompleto is null/empty', () => {
    expect(parentBreadcrumbFromDoc({ nome: 'Roupas', nomeCompleto: null })).toBe('Roupas');
    expect(parentBreadcrumbFromDoc({ nome: 'Roupas', nomeCompleto: '  ' })).toBe('Roupas');
  });

  it('returns null when parent is missing or has no usable label', () => {
    expect(parentBreadcrumbFromDoc(null)).toBeNull();
    expect(parentBreadcrumbFromDoc(undefined)).toBeNull();
    expect(parentBreadcrumbFromDoc({ nome: null, nomeCompleto: null })).toBeNull();
    expect(parentBreadcrumbFromDoc({ nome: '  ', nomeCompleto: null })).toBeNull();
  });
});

describe('outerRefForCategoriaId', () => {
  it('builds the canonical documents/ outer-ref', () => {
    expect(outerRefForCategoriaId('abc')).toBe('documents/categorias/abc');
  });
});

describe('deriveNomeCompletoOnSave', () => {
  it('roots when there is no parent', () => {
    expect(
      deriveNomeCompletoOnSave({
        nome: 'X',
        hasParent: false,
        parentBreadcrumb: 'ignored',
        existingNomeCompleto: 'A > X',
      }),
    ).toBe('X');
  });

  it('uses the parent breadcrumb handle when present', () => {
    expect(
      deriveNomeCompletoOnSave({
        nome: 'Filho',
        hasParent: true,
        parentBreadcrumb: 'Pai',
        existingNomeCompleto: null,
      }),
    ).toBe('Pai > Filho');
  });

  it('recovers parent prefix from existing breadcrumb on load race', () => {
    expect(
      deriveNomeCompletoOnSave({
        nome: 'Filho2',
        hasParent: true,
        parentBreadcrumb: null,
        existingNomeCompleto: 'A > B > Filho',
      }),
    ).toBe('A > B > Filho2');
  });
});
