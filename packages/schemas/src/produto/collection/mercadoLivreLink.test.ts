import { describe, expect, it } from 'vitest';
import {
  produtoMercadoLivreLinkSchema,
  variacaoMercadoLivreLinkSchema,
  estadoPublicacaoMlSchema,
} from './mercadoLivreLink';

describe('produtoMercadoLivreLinkSchema', () => {
  it('parses a legacy-shaped ProdutoMercadoLivre fixture doc', () => {
    const fixture = {
      contaOuterRef: 'documents/integracao/conta-ml-1',
      channels: ['marketplace'],
      estado: 'p',
      status: 'active',
      sub_status: null,
      id: 'MLB123456789',
      sku: 'SKU-001',
      descricao: 'Camiseta 100% algodão.',
      site_id: 'MLB',
      title: 'Camiseta Básica Azul',
      category_id: 'MLB1234',
      condition: 'new',
      listing_type_id: 'gold_special',
      crossdocking: null,
      freteGratis: true,
      precoPublicado: 49.9,
      tarifaFrete: 5.5,
      comissao: 4.99,
      isUserProductModel: true,
      video_id: null,
      attributes: [{ id: 'BRAND', value_name: 'Genérica' }],
      errors: null,
      ultimaModificacao: 1_700_000_000_000,
      dataCadastro: 1_690_000_000_000,
    };
    const parsed = produtoMercadoLivreLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      contaOuterRef: 'documents/integracao/conta-ml-1',
      estado: 'p',
      id: 'MLB123456789',
      title: 'Camiseta Básica Azul',
      condition: 'new',
      isUserProductModel: true,
    });
  });

  it('requires contaOuterRef and a non-empty title', () => {
    expect(produtoMercadoLivreLinkSchema.safeParse({ title: 'X' }).success).toBe(false);
    expect(
      produtoMercadoLivreLinkSchema.safeParse({
        contaOuterRef: 'documents/integracao/conta-1',
        title: '',
      }).success,
    ).toBe(false);
  });

  it('applies the documented Flutter constructor defaults', () => {
    const parsed = produtoMercadoLivreLinkSchema.parse({
      contaOuterRef: 'documents/integracao/conta-1',
      title: 'X',
    });
    expect(parsed).toMatchObject({
      channels: ['marketplace'],
      estado: 'r',
      site_id: 'MLB',
      condition: 'new',
      freteGratis: false,
      isUserProductModel: false,
    });
    expect(parsed.id).toBeNull();
    expect(parsed.errors).toBeNull();
  });

  it('accepts every ESTADO_PUBLICACAO short code', () => {
    for (const code of ['r', 'a', 'ep', 'v', 'p', 'pa', 'c', 'E', 'am']) {
      expect(estadoPublicacaoMlSchema.safeParse(code).success).toBe(true);
    }
    expect(estadoPublicacaoMlSchema.safeParse('x').success).toBe(false);
  });

  it('preserves unknown top-level fields and unknown keys inside attribute entries', () => {
    const parsed = produtoMercadoLivreLinkSchema.parse({
      contaOuterRef: 'documents/integracao/conta-1',
      title: 'X',
      attributes: [{ id: 'BRAND', value_name: 'Genérica', extraKey: 'x' }],
      _futureMlField: 'whatever',
    });
    expect(parsed.attributes?.[0]).toMatchObject({ id: 'BRAND', extraKey: 'x' });
    expect((parsed as Record<string, unknown>)._futureMlField).toBe('whatever');
  });
});

describe('variacaoMercadoLivreLinkSchema', () => {
  it('parses a legacy-shaped VariacoesML fixture doc', () => {
    const fixture = {
      id: 111222333,
      itemId: 'MLB999888777',
      produtoVariacaoOuterRef: 'documents/produtos/variacao-1',
      produtoMercadoLivreOuterRef: 'documents/produtos/produto-1/produtoMercadoLivre/link-1',
      sku: 'SKU-001-AZUL-M',
      attributes: [{ id: 'COLOR', value_name: 'Azul' }],
    };
    const parsed = variacaoMercadoLivreLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      id: 111222333,
      itemId: 'MLB999888777',
      produtoVariacaoOuterRef: 'documents/produtos/variacao-1',
      sku: 'SKU-001-AZUL-M',
    });
  });

  it('requires both outer refs', () => {
    expect(
      variacaoMercadoLivreLinkSchema.safeParse({
        produtoMercadoLivreOuterRef: 'documents/produtos/produto-1/produtoMercadoLivre/link-1',
      }).success,
    ).toBe(false);
    expect(
      variacaoMercadoLivreLinkSchema.safeParse({
        produtoVariacaoOuterRef: 'documents/produtos/variacao-1',
      }).success,
    ).toBe(false);
  });

  it('defaults id, itemId, sku and attributes to null when absent', () => {
    const parsed = variacaoMercadoLivreLinkSchema.parse({
      produtoVariacaoOuterRef: 'documents/produtos/variacao-1',
      produtoMercadoLivreOuterRef: 'documents/produtos/produto-1/produtoMercadoLivre/link-1',
    });
    expect(parsed.id).toBeNull();
    expect(parsed.itemId).toBeNull();
    expect(parsed.sku).toBeNull();
    expect(parsed.attributes).toBeNull();
  });

  it('preserves unknown top-level fields (pass-through)', () => {
    const parsed = variacaoMercadoLivreLinkSchema.parse({
      produtoVariacaoOuterRef: 'documents/produtos/variacao-1',
      produtoMercadoLivreOuterRef: 'documents/produtos/produto-1/produtoMercadoLivre/link-1',
      _futureField: 'whatever',
    });
    expect((parsed as Record<string, unknown>)._futureField).toBe('whatever');
  });
});
