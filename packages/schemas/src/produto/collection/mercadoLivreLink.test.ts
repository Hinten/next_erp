import { describe, expect, it } from 'vitest';
import {
  ML_CAUSA_CAMPO,
  ML_CAUSA_TIPO,
  campoAtributo,
  mlCausaSchema,
  mlModeracaoSchema,
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

  it('leaves `causas` null on a Flutter-written doc, which never sets it', () => {
    // The whole reason it is additive+nullable: the migrated corpus is full of
    // docs whose legacy writer knew nothing about this field.
    const parsed = produtoMercadoLivreLinkSchema.parse({
      contaOuterRef: 'documents/integracao/conta-1',
      title: 'X',
      errors: null,
    });
    expect(parsed.causas).toBeNull();
  });

  it('round-trips the structured causes the publisher writes', () => {
    const parsed = produtoMercadoLivreLinkSchema.parse({
      contaOuterRef: 'documents/integracao/conta-1',
      title: 'X',
      errors: ['error · item.attributes.missing_required — falta BRAND [item.attributes]'],
      causas: [
        {
          code: 'item.attributes.missing_required',
          causaId: 147,
          tipo: ML_CAUSA_TIPO.erro,
          departamento: 'catalog',
          mensagem: 'The attributes [BRAND] are required for category MLB1234.',
          referencias: ['item.attributes'],
          campos: [campoAtributo('BRAND')],
        },
      ],
    });
    expect(parsed.causas).toEqual([
      expect.objectContaining({ causaId: 147, tipo: 'error', campos: ['attributes.BRAND'] }),
    ]);
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

describe('mlCausaSchema', () => {
  it('needs only a message — every other field defaults', () => {
    expect(mlCausaSchema.parse({ mensagem: 'algo deu errado' })).toEqual({
      code: null,
      causaId: null,
      tipo: null,
      departamento: null,
      mensagem: 'algo deu errado',
      referencias: [],
      campos: [],
    });
  });

  it('rejects a tipo outside the two ML documents', () => {
    expect(mlCausaSchema.safeParse({ mensagem: 'x', tipo: 'critical' }).success).toBe(false);
  });

  it('names the four fixed listing-form controls', () => {
    expect(Object.values(ML_CAUSA_CAMPO)).toEqual([
      'title',
      'descricao',
      'category_id',
      'listing_type_id',
    ]);
    expect(campoAtributo('GTIN')).toBe('attributes.GTIN');
  });
});

describe('mlModeracaoSchema', () => {
  it('needs only a motivo — every other field defaults', () => {
    expect(mlModeracaoSchema.parse({ motivo: 'infringe as políticas' })).toEqual({
      nome: null,
      dataCriacao: null,
      motivo: 'infringe as políticas',
      remedio: null,
      secoes: [],
      evidencias: [],
    });
  });

  /**
   * ⚠️ The load-bearing default. ML returns a REASON and NO REMEDY for a listing
   * it removed, "pois a moderação não tem um REMEDY" — the seller cannot modify
   * or recover it. A reader must be able to tell that apart from "we did not
   * store the remedy", which is why the field is nullable rather than
   * `.default('')`.
   */
  it('defaults remedio to NULL — the removed-listing case, never an empty string', () => {
    const removido = mlModeracaoSchema.parse({ motivo: 'cancelado por falsificação' });
    expect(removido.remedio).toBeNull();
    expect(removido.remedio).not.toBe('');
  });

  it('rejects a moderação with no motivo — an entry that explains nothing', () => {
    expect(mlModeracaoSchema.safeParse({ nome: 'DENYLIST' }).success).toBe(false);
  });

  /**
   * ⚠️ A STRING, deliberately. ML sends `2021-04-14T10:47:05.270-0400` on one
   * doc page and `2022-10-25 15:57:46.0` on another; the second carries no zone,
   * so parsing it answers differently on each of this repo's three server
   * timezones. Both must round-trip untouched.
   */
  it('keeps either date_created format verbatim', () => {
    for (const raw of ['2021-04-14T10:47:05.270-0400', '2022-10-25 15:57:46.0']) {
      expect(mlModeracaoSchema.parse({ motivo: 'x', dataCriacao: raw }).dataCriacao).toBe(raw);
    }
  });
});

describe('the moderacoes field on both link schemas', () => {
  /**
   * Additive and nullable, exactly like `status`/`sub_status`/`causas`: a
   * migrated Flutter row has no such key and must parse, not fail.
   */
  it('defaults to null on a link doc that predates it', () => {
    const parsed = produtoMercadoLivreLinkSchema.parse({
      contaOuterRef: 'documents/integracao/c1',
      title: 'Camiseta',
    });
    expect(parsed.moderacoes).toBeNull();
  });

  it('is carried by the MEMBER link too — moderation is per ML item', () => {
    // A User-Products family folds the winner's up to the parent, so every member
    // has to be able to hold its own.
    const parsed = variacaoMercadoLivreLinkSchema.parse({
      produtoVariacaoOuterRef: 'documents/produtos/child1',
      produtoMercadoLivreOuterRef: 'documents/produtos/p1/produtoMercadoLivre/link1',
      moderacoes: [{ motivo: 'foto de baixa qualidade' }],
    });
    expect(parsed.moderacoes?.[0]?.motivo).toBe('foto de baixa qualidade');
    expect(parsed.moderacoes?.[0]?.remedio).toBeNull();
  });
});
