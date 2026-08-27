import { describe, expect, it } from 'vitest';
import { produtoMeta, produtoSchema } from './produto';

describe('produtoSchema', () => {
  it('parses a minimal Produto with defaults applied', () => {
    const out = produtoSchema.parse({ nome: 'Camiseta básica' });
    expect(out).toMatchObject({
      nome: 'Camiseta básica',
      ehKit: false,
      ehKitVirtual: false,
      // Flutter constructor default (`models.dart:1333`): a new produto is a DRAFT.
      publicado: false,
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

  it('parses componentesKit against kitSchema', () => {
    const parsed = produtoSchema.parse({
      nome: 'Kit',
      ehKit: true,
      componentesKit: { 'sku-a': { quantidade: 2 } },
    });
    // componentesKit is now typed: kitSchema fills its defaults.
    expect(parsed.componentesKit?.['sku-a']).toMatchObject({
      quantidade: 2,
      limitarEstoque: true,
      timestamp: null,
    });
  });

  // No `.passthrough()`: an unmodeled key is stripped on a lenient parse
  // (the read path, `parseSoftRead` in `@delfrance/data`) — this is what
  // keeps a legacy corpus doc carrying a since-retired field readable
  // (root `CLAUDE.md` rule 8) — but throws on the write path, which
  // re-parses strictly whenever the lenient parse dropped a caller-supplied
  // key (`parseForWrite`/`parseMergePatch`, `packages/data/src/zodParse.ts`).
  it('silently strips a genuinely unknown top-level key on a lenient (read) parse', () => {
    const parsed = produtoSchema.parse({ nome: 'X', someRetiredLegacyField: 'whatever' });
    expect(parsed).not.toHaveProperty('someRetiredLegacyField');
  });

  it('rejects a genuinely unknown top-level key on a strict (write) parse', () => {
    // Mirrors the `.strict()` re-parse `parseForWrite`/`parseMergePatch` run
    // internally once they notice the lenient parse above dropped a key.
    expect(() => produtoSchema.strict().parse({ nome: 'X', someUnknownField: 'whatever' })).toThrow(
      /nrecognized/,
    );
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
