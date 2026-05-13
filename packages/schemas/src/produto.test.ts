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
    expect(
      produtoSchema.safeParse({ nome: 'X', crossdocking: -1 }).success,
    ).toBe(false);
  });

  it('passes complex nested fields through unchanged (passthrough)', () => {
    const fotos = [{ src: 'a.jpg' }];
    const componentes = { 'sku-a': { qty: 2 } };
    const parsed = produtoSchema.parse({
      nome: 'Kit',
      ehKit: true,
      fotos,
      componentesKit: componentes,
      // unknown extra field — should be preserved by .passthrough()
      _customField: 'whatever',
    });
    expect(parsed.fotos).toEqual(fotos);
    expect(parsed.componentesKit).toEqual(componentes);
    expect((parsed as Record<string, unknown>)._customField).toBe('whatever');
  });

  it('keeps variation arrays as-is', () => {
    const parsed = produtoSchema.parse({
      nome: 'Pai',
      variacoesUid: ['cor:azul', 'tam:M'],
    });
    expect(parsed.variacoesUid).toEqual(['cor:azul', 'tam:M']);
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
