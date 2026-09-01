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
  precisaConsultarModeracao,
  acaoStatusAnuncio,
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
  it('every field defaults — the mapper, not the schema, decides what is worth storing', () => {
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
   * ⚠️ Two DIFFERENT nulls, and a reader must not collapse them. `remedio: null`
   * says a fix does not exist (a removed listing); `motivo: null` says ML
   * moderated the listing and supplied no text, with `nome` still naming the
   * filter that fired. Only the second leaves something to render from `nome`.
   */
  it('separates "no fix exists" from "no text supplied"', () => {
    const semTexto = mlModeracaoSchema.parse({ nome: 'POOR_QUALITY_THUMBNAIL' });
    expect(semTexto.motivo).toBeNull();
    expect(semTexto.nome).toBe('POOR_QUALITY_THUMBNAIL');

    const semConserto = mlModeracaoSchema.parse({ motivo: 'cancelado', nome: 'DENYLIST' });
    expect(semConserto.remedio).toBeNull();
    expect(semConserto.motivo).toBe('cancelado');
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

  it('does NOT reject a moderação with no motivo — dropping it would read as healthy', () => {
    // `moderacoes: []` is byte-identical to "not moderated" on disk. Storing the
    // filter name is the only way to tell those apart; `mapModeracoes` is the
    // gate that refuses an entry carrying neither text nor name.
    expect(mlModeracaoSchema.safeParse({ nome: 'DENYLIST' }).success).toBe(true);
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

/**
 * The gate the whole `moderacoes` three-value contract rests on. It moved here
 * from `apps/mercado-livre` when apps/web needed the same decision (#1239) —
 * being PURE is what lets both sides share it, so these tests must stay pure
 * too: no clock, no network, no Firestore.
 */
describe('precisaConsultarModeracao', () => {
  /**
   * The gate is the cost model. `items` fires for every change to every listing
   * the seller owns, so a healthy one must keep costing the single
   * `GET /items/{id}` it costs today.
   */
  it('never fires for a plainly healthy listing', () => {
    expect(precisaConsultarModeracao('active', null)).toBe(false);
    expect(precisaConsultarModeracao('active', [])).toBe(false);
    expect(precisaConsultarModeracao('paused', ['out_of_stock'])).toBe(false);
    expect(precisaConsultarModeracao('closed', ['deleted'])).toBe(false);
    expect(precisaConsultarModeracao(null, null)).toBe(false);
  });

  it('fires on under_review whatever the sub_status — every one is a moderation', () => {
    // Including one we have not catalogued: a listing under review with an
    // unfamiliar sub_status is exactly where the reason matters most.
    for (const sub of [null, [], ['waiting_for_patch'], ['algo_novo_do_ml']]) {
      expect(precisaConsultarModeracao('under_review', sub)).toBe(true);
    }
  });

  /**
   * ⚠️ The case that made `moderacoes` a separate field rather than a reuse of
   * `errors`: the listing is LIVE and sendable, so the #781 stock re-arm gate
   * would have wiped the diagnosis on the very write that produced it.
   */
  it('fires for an ACTIVE listing carrying an image moderation', () => {
    expect(precisaConsultarModeracao('active', ['poor_quality_thumbnail'])).toBe(true);
    expect(precisaConsultarModeracao('active', ['moderation_penalty'])).toBe(true);
  });

  it('fires for the preventive pause and the closed penalty', () => {
    expect(precisaConsultarModeracao('paused', ['moderation_penalty'])).toBe(true);
    expect(precisaConsultarModeracao('closed', ['moderation_penalty'])).toBe(true);
  });

  it('fires for BOTH of ML picture-pending spellings', () => {
    // Not a typo of one another — ML uses one per page, and normalising to a
    // single spelling would miss whichever page turns out to be right.
    expect(precisaConsultarModeracao('paused', ['picture_download_pending'])).toBe(true);
    expect(precisaConsultarModeracao('under_review', ['picture_downloading_pending'])).toBe(true);
  });

  it('fires when a moderation sub_status sits alongside ordinary ones', () => {
    expect(precisaConsultarModeracao('paused', ['out_of_stock', 'moderation_penalty'])).toBe(true);
  });
});

/* --------------------------- acaoStatusAnuncio ---------------------------- */

describe('acaoStatusAnuncio', () => {
  const PUBLICADO = { id: 'MLB1', estado: 'p', status: 'active' };

  it('offers Pausar on a live listing and Reativar on a paused one', () => {
    expect(acaoStatusAnuncio(PUBLICADO)).toBe('pausar');
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'pa', status: 'paused' })).toBe('reativar');
  });

  it('offers nothing on a listing that was never published', () => {
    expect(acaoStatusAnuncio({ id: null, estado: 'r', status: null })).toBeNull();
    // `''` is the migrated-corpus shape the backend also treats as unpublished.
    expect(acaoStatusAnuncio({ id: '', estado: 'r', status: null })).toBeNull();
    expect(acaoStatusAnuncio(null)).toBeNull();
    expect(acaoStatusAnuncio(undefined)).toBeNull();
  });

  it('offers nothing once the listing is cancelled — closed is terminal on ML', () => {
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'c', status: 'closed' })).toBeNull();
    // `estado` lagging behind the raw status must not reopen the control either.
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'p', status: 'closed' })).toBeNull();
    // ⚠️ The case that makes the `estado` rung load-bearing rather than
    // redundant with the raw-status one: a LEGACY cancelled row carries `estado
    // 'c'` and NO `status`, so without it the absent-status fallback below would
    // offer to pause a listing ML closed long ago. Deleting that rung passes
    // every other assertion in this block.
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'c' })).toBeNull();
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'c', status: null })).toBeNull();
  });

  it('offers nothing while ML is mid-decision', () => {
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'v', status: 'under_review' })).toBeNull();
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'a', status: 'payment_required' })).toBeNull();
  });

  it('offers NOTHING while ML is mid-UPtin-migration, even with a live status', () => {
    // ⚠️ THE rung the raw-status arm would otherwise override.
    // `stampAguardandoMigracao` writes `estado` + `ultimaModificacao` ALONE and
    // its three call sites return immediately, so `status` is left at its
    // previous value — `'active'` for a listing ML has just begun migrating.
    // ML 404s any change to a migrating source item, and `anuncioStatus.ts`'s
    // 404 branch records `closed`: the produto would leave BOTH ML sweeps for a
    // listing that was only migrating.
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'am', status: 'active' })).toBeNull();
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'am', status: 'paused' })).toBeNull();
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'am' })).toBeNull();
  });

  it('offers NOTHING for any estado ML has not settled — an allow-list, not a fallthrough', () => {
    // The near-miss for the corpus rung below: a DENY-list read every estado
    // other than `pausado` as live, so five more states answered `pausar`.
    for (const estado of ['r', 'a', 'ep', 'v', 'E']) {
      expect(acaoStatusAnuncio({ id: 'MLB1', estado })).toBeNull();
    }
  });

  it('treats a published link with NO status as live — the legacy corpus (#780)', () => {
    // The near-miss that keeps this rung honest: absent status reads as live,
    // but an absent status with `estado 'pa'` must still read as PAUSED, or the
    // button would offer to pause something already paused.
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'p' })).toBe('pausar');
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'pa' })).toBe('reativar');
    // ⚠️ `estado` ABSENT is not the corpus — the schema defaults it to `'r'` and
    // Flutter always wrote it, so a link with no estado at all is a shape nobody
    // produces. It answers null rather than guessing the listing is live.
    expect(acaoStatusAnuncio({ id: 'MLB1' })).toBeNull();
    // ...and an empty-string status is "absent", not an unknown ML value.
    expect(acaoStatusAnuncio({ id: 'MLB1', estado: 'pa', status: '' })).toBe('reativar');
  });
});
