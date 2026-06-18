import { describe, expect, it } from 'vitest';
import { produtoMeta, produtoSchema } from './produto';

describe('produtoSchema', () => {
  it('parses a minimal Produto with defaults applied', () => {
    const out = produtoSchema.parse({ nome: 'Camiseta básica' });
    expect(out).toMatchObject({
      nome: 'Camiseta básica',
      ehKit: false,
      ehKitVirtual: false,
      publicado: true,
      ofereceFreteGratis: false,
      permiteVendaSemEstoque: false,
      integracoesComProduto: [],
      marketplace: [],
    });
  });

  it('rejects empty nome', () => {
    expect(produtoSchema.safeParse({ nome: '' }).success).toBe(false);
  });

  it('rejects nome longer than 100 chars', () => {
    expect(produtoSchema.safeParse({ nome: 'x'.repeat(101) }).success).toBe(false);
  });

  it('rejects negative crossdocking', () => {
    expect(produtoSchema.safeParse({ nome: 'X', crossdocking: -1 }).success).toBe(false);
  });

  it('ehUsado defaults to false and accepts only booleans', () => {
    expect(produtoSchema.parse({ nome: 'X' }).ehUsado).toBe(false);
    expect(produtoSchema.parse({ nome: 'X', ehUsado: true }).ehUsado).toBe(true);
    expect(produtoSchema.safeParse({ nome: 'X', ehUsado: 'sim' }).success).toBe(false);
  });

  it('categoriaProdutoOuterRef is a nullable doc-path string', () => {
    const ref = 'documents/categorias/cat-1';
    expect(
      produtoSchema.parse({ nome: 'X', categoriaProdutoOuterRef: ref }).categoriaProdutoOuterRef,
    ).toBe(ref);
    expect(produtoSchema.parse({ nome: 'X' }).categoriaProdutoOuterRef).toBeNull();
    // A non-string (e.g. a raw object) is rejected — the wire shape is a string.
    expect(
      produtoSchema.safeParse({ nome: 'X', categoriaProdutoOuterRef: { id: 'cat-1' } }).success,
    ).toBe(false);
  });

  it('parses componentesKit against kitSchema and preserves unknown top-level fields', () => {
    const parsed = produtoSchema.parse({
      nome: 'Kit',
      ehKit: true,
      componentesKit: { 'sku-a': { quantidade: 2 } },
      // unknown extra field — should be preserved by .passthrough()
      _customField: 'whatever',
    });
    // componentesKit is now typed: kitSchema fills its defaults.
    expect(parsed.componentesKit?.['sku-a']).toMatchObject({
      quantidade: 2,
      limitarEstoque: true,
      timestamp: null,
    });
    expect((parsed as Record<string, unknown>)._customField).toBe('whatever');
  });

  it('parses the fotos array against fotoSchema (typed, not pass-through)', () => {
    const parsed = produtoSchema.parse({
      nome: 'Com foto',
      fotos: [{ arquivoOuterRef: 'arquivos/p1_h' }],
    });
    expect(parsed.fotos?.[0]?.arquivoOuterRef).toBe('arquivos/p1_h');
    expect(parsed.fotos?.[0]?.arquivo200pxOuterRef).toBeNull();
  });

  it('keeps variation arrays as-is', () => {
    const parsed = produtoSchema.parse({
      nome: 'Pai',
      variacoesUid: ['cor:azul', 'tam:M'],
    });
    expect(parsed.variacoesUid).toEqual(['cor:azul', 'tam:M']);
  });

  it('accepts a precos entry at or above R$ 0,01', () => {
    const parsed = produtoSchema.parse({ nome: 'X', precos: { listaA: { valor: 0.01 } } });
    expect(parsed.precos).toEqual({ listaA: { valor: 0.01 } });
  });

  it('rejects a precos entry of 0 or below R$ 0,01 (min price)', () => {
    expect(produtoSchema.safeParse({ nome: 'X', precos: { listaA: { valor: 0 } } }).success).toBe(
      false,
    );
    expect(
      produtoSchema.safeParse({ nome: 'X', precos: { listaA: { valor: 0.009 } } }).success,
    ).toBe(false);
  });
});

describe('produtoMeta', () => {
  it('points at the legacy Flutter collection path', () => {
    expect(produtoMeta.collectionPath).toBe('produtos');
  });

  it('exposes BigInt permission bits', () => {
    expect(typeof produtoMeta.permissions.read).toBe('bigint');
    expect(produtoMeta.permissions.read).not.toBe(produtoMeta.permissions.write);
  });
});
