/**
 * Amazon's binding of the shared quantity core: the three pinned options.
 */
import { describe, expect, it } from 'vitest';

import { opcoesEstoqueAmazon } from './opcoesEstoque';

describe('opcoesEstoqueAmazon', () => {
  it('★ is exactly component-min, no virtual-kit skip and no ceiling', () => {
    expect(opcoesEstoqueAmazon()).toEqual({
      incluirEstoqueProprioDoKit: false,
      pularKitVirtual: false,
      estoqueMax: Number.POSITIVE_INFINITY,
    });
  });

  it('★ the ceiling is infinite — never 0, which would zero every listing', () => {
    const { estoqueMax } = opcoesEstoqueAmazon();
    expect(estoqueMax).toBe(Number.POSITIVE_INFINITY);
    expect(estoqueMax).not.toBe(0);
  });

  it('every call hands out a fresh object, so a caller cannot change the next one', () => {
    const a = opcoesEstoqueAmazon();
    const b = opcoesEstoqueAmazon();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });
});
