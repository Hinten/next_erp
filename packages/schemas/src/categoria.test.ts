import { describe, expect, it } from 'vitest';

// Imported through the BARREL on purpose: proof that `src/index.ts` exports the moved helpers.
import { makeNomeCompleto, parentBreadcrumbFromDoc } from './index';

/**
 * The breadcrumb helpers moved here from `apps/web/lib/categorias/nomeCompleto.ts` (which
 * re-exports them; its own tests, unchanged, prove the move). This file pins the one composition
 * the server side adds: a categoria created under an ERP parent reads like a hand-made one.
 */
describe('the breadcrumb of a categoria created under an ERP parent', () => {
  it('EQUAL: "Z" under a parent whose nomeCompleto is "X > Y" ⇒ "X > Y > Z"', () => {
    expect(
      makeNomeCompleto('Z', parentBreadcrumbFromDoc({ nome: 'Y', nomeCompleto: 'X > Y' })),
    ).toBe('X > Y > Z');
  });

  it('⚠️ NEAR-MISS: the parent’s OWN breadcrumb wins over any other naming of its ancestors', () => {
    // The store may name the same branch "A > B": the ERP parent's breadcrumb is what is written.
    const nome = makeNomeCompleto(
      'Z',
      parentBreadcrumbFromDoc({ nome: 'B', nomeCompleto: 'X > Y' }),
    );
    expect(nome).not.toBe('A > B > Z');
    expect(nome).toBe('X > Y > Z');
  });

  it('a parent with no breadcrumb yet falls back to its nome; no parent ⇒ the nome alone', () => {
    expect(makeNomeCompleto('Z', parentBreadcrumbFromDoc({ nome: 'Y', nomeCompleto: null }))).toBe(
      'Y > Z',
    );
    expect(makeNomeCompleto('Z', parentBreadcrumbFromDoc(null))).toBe('Z');
  });
});
