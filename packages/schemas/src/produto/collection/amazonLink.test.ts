import { describe, expect, it } from 'vitest';
import {
  CAMPOS_INDICE_VINCULO_AMAZON,
  MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  VIA_ENVIO_ESTOQUE_AMAZON,
  envioEstoqueAmazonSchema,
  produtoAmazonLinkSchema,
  amazonSubmitStatusSchema,
  amazonListingStatusSchema,
  resultadoEnvioEstoqueAmazonSchema,
  viaEnvioEstoqueAmazonSchema,
  amazonIssueWireSchema,
  envioGuardadoListingAmazonSchema,
  envioPrecoAmazonSchema,
} from './amazonLink';
import { z } from 'zod';
import { FEED_ID_REGISTRO_AMAZON_REGEX } from '../../feedAmazon';
import { faixaPrecoAmazonSchema } from '../../precoAmazon';

describe('produtoAmazonLinkSchema', () => {
  it('parses a legacy-shaped ProdutoAmazon fixture doc', () => {
    const fixture = {
      contaAmazonOuterRef: 'documents/integracao/int1',
      name: 'Camiseta Básica Azul',
      sku: 'SKU-001',
      asin: 'B0EXAMPLE1',
      marketplaceIds: ['A2Q3Y263D00KWC'],
      productType: 'SHIRT',
      productTypeVersion: '2.0',
      productDataJson: { color: 'blue', size: 'M' },
      productDataAllFields: ['color', 'size'],
      submitStatus: 'ACCEPTED',
      listingStatus: ['BUYABLE', 'DISCOVERABLE'],
      issues: [{ code: 'INVALID_ATTRIBUTE', message: 'bad value', severity: 'ERROR' }],
      retrySubmitDate: 1_700_000_000_000,
    };
    const parsed = produtoAmazonLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      name: 'Camiseta Básica Azul',
      sku: 'SKU-001',
      asin: 'B0EXAMPLE1',
      submitStatus: 'ACCEPTED',
      listingStatus: ['BUYABLE', 'DISCOVERABLE'],
      retrySubmitDate: 1_700_000_000_000,
    });
  });

  it('requires non-empty name and sku', () => {
    expect(
      produtoAmazonLinkSchema.safeParse({
        contaAmazonOuterRef: 'documents/integracao/int1',
        name: '',
        sku: 'X',
      }).success,
    ).toBe(false);
    expect(
      produtoAmazonLinkSchema.safeParse({
        contaAmazonOuterRef: 'documents/integracao/int1',
        name: 'X',
        sku: '',
      }).success,
    ).toBe(false);
  });

  it('rejects when contaAmazonOuterRef is missing', () => {
    expect(produtoAmazonLinkSchema.safeParse({ name: 'X', sku: 'Y' }).success).toBe(false);
  });

  it('defaults marketplaceIds to the Brazil marketplace id and nullable fields to null', () => {
    const parsed = produtoAmazonLinkSchema.parse({
      contaAmazonOuterRef: 'documents/integracao/int1',
      name: 'X',
      sku: 'Y',
    });
    expect(parsed.marketplaceIds).toEqual(['A2Q3Y263D00KWC']);
    expect(parsed.asin).toBeNull();
    expect(parsed.submitStatus).toBeNull();
    expect(parsed.listingStatus).toBeNull();
    expect(parsed.issues).toBeNull();
    expect(parsed.retrySubmitDate).toBeNull();
  });

  it('models the notification-processor 404 reset shape (#363)', () => {
    const parsed = produtoAmazonLinkSchema.parse({
      contaAmazonOuterRef: 'documents/integracao/int1',
      name: 'X',
      sku: 'Y',
      asin: null,
      retrySubmitDate: null,
      issues: null,
      submitStatus: null,
      listingStatus: [],
    });
    expect(parsed.asin).toBeNull();
    expect(parsed.listingStatus).toEqual([]);
  });

  it('accepts only the uppercase SUBMIT_STATUS / LISTING_STATUS wire codes', () => {
    expect(amazonSubmitStatusSchema.safeParse('ACCEPTED').success).toBe(true);
    expect(amazonSubmitStatusSchema.safeParse('INVALID').success).toBe(true);
    expect(amazonSubmitStatusSchema.safeParse('VALID').success).toBe(true);
    expect(amazonSubmitStatusSchema.safeParse('accepted').success).toBe(false);
    expect(amazonListingStatusSchema.safeParse('BUYABLE').success).toBe(true);
    expect(amazonListingStatusSchema.safeParse('DISCOVERABLE').success).toBe(true);
    expect(amazonListingStatusSchema.safeParse('buyable').success).toBe(false);
  });

  it('typed issue extra keys pass through', () => {
    const parsed = produtoAmazonLinkSchema.parse({
      contaAmazonOuterRef: 'documents/integracao/int1',
      name: 'X',
      sku: 'Y',
      issues: [
        {
          code: 'INVALID_ATTRIBUTE',
          message: 'bad value',
          severity: 'ERROR',
          attributeNames: ['color'],
          categories: ['DATA_QUALITY'],
          // unknown extra key SP-API might add
          enforcements: { actions: [] },
        },
      ],
    });
    expect(parsed.issues?.[0]).toMatchObject({ code: 'INVALID_ATTRIBUTE', severity: 'ERROR' });
    expect((parsed.issues?.[0] as Record<string, unknown>).enforcements).toEqual({ actions: [] });
  });

  it('preserves unknown top-level fields (pass-through)', () => {
    const parsed = produtoAmazonLinkSchema.parse({
      contaAmazonOuterRef: 'documents/integracao/int1',
      name: 'X',
      sku: 'Y',
      _futureAmazonField: 'whatever',
    });
    expect((parsed as Record<string, unknown>)._futureAmazonField).toBe('whatever');
  });
});

describe('envioEstoqueAmazon — the last stock outcome (Amazon step 12)', () => {
  const LINK = { contaAmazonOuterRef: 'documents/integracao/int1', name: 'X', sku: 'Y' };
  const EM = 1_800_000_000_000;
  const PATCH = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs: EM,
    quantidade: 4,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
    submissionId: 'f0e1d2c3',
  };
  const FEED = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
    emMs: EM,
    quantidade: null,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado,
    feedId: '3485934',
    problemas: [{ code: '90220', message: 'campo obrigatório', severity: 'ERROR' }],
  };
  const INCERTO = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs: EM,
    quantidade: 4,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
  };

  it('★ a legacy link doc (no such field) parses with envioEstoqueAmazon: null, its legacy issues untouched', () => {
    const issues = [{ code: 'INVALID_ATTRIBUTE', message: 'bad value', severity: 'ERROR' }];
    const parsed = produtoAmazonLinkSchema.parse({ ...LINK, issues });
    expect(parsed.envioEstoqueAmazon).toBeNull();
    expect(parsed.issues?.[0]).toMatchObject(issues[0] ?? {});
    expect(
      produtoAmazonLinkSchema.parse({ ...LINK, envioEstoqueAmazon: null }).envioEstoqueAmazon,
    ).toBeNull();
  });

  it('the stock outcome never touches the legacy `issues`: each field keeps its own value', () => {
    const parsed = produtoAmazonLinkSchema.parse({
      ...LINK,
      issues: null,
      envioEstoqueAmazon: FEED,
    });
    expect(parsed.issues).toBeNull();
    expect(parsed.envioEstoqueAmazon?.problemas).toHaveLength(1);
  });

  it('a patch outcome round-trips with its defaults (no feed, no problem)', () => {
    expect(envioEstoqueAmazonSchema.parse(PATCH)).toEqual({
      ...PATCH,
      feedId: null,
      problemas: [],
    });
    expect(
      produtoAmazonLinkSchema.parse({ ...LINK, envioEstoqueAmazon: PATCH }).envioEstoqueAmazon,
    ).toEqual({
      ...PATCH,
      feedId: null,
      problemas: [],
    });
  });

  it('a patch whose answer carried no submissionId is still a patch outcome', () => {
    const { submissionId: _s, ...semId } = PATCH;
    expect(envioEstoqueAmazonSchema.parse(semId).submissionId).toBeNull();
  });

  it('a feed outcome carries quantidade: null and its feedId', () => {
    const lido = envioEstoqueAmazonSchema.parse(FEED);
    expect(lido.quantidade).toBeNull();
    expect(lido.feedId).toBe('3485934');
    expect(lido.submissionId).toBeNull();
  });

  it('an incerto patch (its answer lost) keeps its quantity and names neither id', () => {
    expect(envioEstoqueAmazonSchema.parse(INCERTO)).toEqual({
      ...INCERTO,
      submissionId: null,
      feedId: null,
      problemas: [],
    });
  });

  it.each([
    ['a feed carrying a quantity', { ...FEED, quantidade: 5 }],
    ['a feed without its feedId', { ...FEED, feedId: null }],
    ['a feed with a submissionId', { ...FEED, submissionId: 'x' }],
    ['a feed left incerto (only a patch can be)', { ...FEED, resultado: 'incerto' }],
    ['a patch without its quantity', { ...PATCH, quantidade: null }],
    ['a patch naming a feed', { ...PATCH, feedId: '1' }],
    ['an incerto patch with a submissionId', { ...INCERTO, submissionId: 'x' }],
    ['an incerto patch with problems', { ...INCERTO, problemas: [{ code: 'X' }] }],
  ])('refuses an incoherent outcome: %s', (_nome, envio) => {
    expect(envioEstoqueAmazonSchema.safeParse(envio).success).toBe(false);
    expect(produtoAmazonLinkSchema.safeParse({ ...LINK, envioEstoqueAmazon: envio }).success).toBe(
      false,
    );
  });

  it.each([
    ['a via outside the closed set', { ...PATCH, via: 'PATCH' }],
    ['a resultado outside the closed set', { ...PATCH, resultado: 'ACCEPTED' }],
    ['a negative quantity', { ...PATCH, quantidade: -1 }],
    ['a fractional quantity', { ...PATCH, quantidade: 1.5 }],
    ['a fractional emMs (a µs value divided somewhere)', { ...PATCH, emMs: EM + 0.5 }],
    ['an emMs as a digit string (no coercion)', { ...PATCH, emMs: String(EM) }],
    ['a feedId outside the record grammar', { ...FEED, feedId: 'F1' }],
    ['an empty submissionId', { ...PATCH, submissionId: '' }],
  ])('refuses %s', (_nome, envio) => {
    expect(envioEstoqueAmazonSchema.safeParse(envio).success).toBe(false);
  });

  it('keeps at most 10 problems', () => {
    const problema = { code: 'X', message: 'm', severity: 'ERROR' };
    const dez = Array.from({ length: MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON }, () => problema);
    expect(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON).toBe(10);
    expect(envioEstoqueAmazonSchema.safeParse({ ...FEED, problemas: dez }).success).toBe(true);
    expect(
      envioEstoqueAmazonSchema.safeParse({ ...FEED, problemas: [...dez, problema] }).success,
    ).toBe(false);
  });

  it('a report issue (the feed shape: singular attributeName, a messageId) passes through', () => {
    const lido = envioEstoqueAmazonSchema.parse({
      ...FEED,
      problemas: [{ severity: 'WARNING', message: 'm', messageId: 3, attributeName: 'quantity' }],
    });
    expect(lido.problemas[0]).toMatchObject({ severity: 'WARNING', attributeName: 'quantity' });
  });

  it('the closed vocabularies, each with its prefer-schema-enum companion', () => {
    expect(viaEnvioEstoqueAmazonSchema.options).toEqual(['patch', 'feed']);
    expect(Object.values(VIA_ENVIO_ESTOQUE_AMAZON).sort()).toEqual(
      [...viaEnvioEstoqueAmazonSchema.options].sort(),
    );
    expect(resultadoEnvioEstoqueAmazonSchema.options).toEqual([
      'aceito',
      'recusado',
      'aceito-com-avisos',
      'incerto',
    ]);
    expect(Object.values(RESULTADO_ENVIO_ESTOQUE_AMAZON).sort()).toEqual(
      [...resultadoEnvioEstoqueAmazonSchema.options].sort(),
    );
  });

  it('a partial merge of the link doc still validates (the refinement sits on the nested field)', () => {
    expect(
      produtoAmazonLinkSchema.partial().parse({ envioEstoqueAmazon: INCERTO }).envioEstoqueAmazon
        ?.resultado,
    ).toBe('incerto');
    expect(
      produtoAmazonLinkSchema
        .partial()
        .safeParse({ envioEstoqueAmazon: { ...FEED, quantidade: 1 } }).success,
    ).toBe(false);
  });
});

describe('CAMPOS_INDICE_VINCULO_AMAZON (Amazon step 5)', () => {
  it('is the link query key in index order: the conta ref, then the SKU', () => {
    expect(CAMPOS_INDICE_VINCULO_AMAZON).toEqual(['contaAmazonOuterRef', 'sku']);
  });

  it('names fields the link schema really has, both REQUIRED (a doc without one is no link)', () => {
    const campos = Object.keys(produtoAmazonLinkSchema.shape);
    for (const campo of CAMPOS_INDICE_VINCULO_AMAZON) {
      expect(campos, campo).toContain(campo);
      const semCampo: Record<string, unknown> = {
        contaAmazonOuterRef: 'documents/integracao/int1',
        name: 'X',
        sku: 'Y',
      };
      delete semCampo[campo];
      expect(produtoAmazonLinkSchema.safeParse(semCampo).success, campo).toBe(false);
    }
  });
});

describe('★ step 13: the ONE outcome factory — the stock outcome, rebuilt on it, parses exactly as before', () => {
  const EM = 1_800_000_000_000;
  const inteiro = () => z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

  /**
   * The stock outcome schema as it stood before the factory, frozen here as the
   * parity ORACLE: every input must parse to the same data, or fail with the
   * same issues (paths and messages), under both.
   */
  const ORACULO_ESTOQUE = z
    .object({
      via: viaEnvioEstoqueAmazonSchema,
      emMs: inteiro(),
      quantidade: inteiro().nullable(),
      resultado: resultadoEnvioEstoqueAmazonSchema,
      submissionId: z.string().min(1).nullable().default(null),
      feedId: z.string().regex(FEED_ID_REGISTRO_AMAZON_REGEX).nullable().default(null),
      problemas: z
        .array(amazonIssueWireSchema)
        .max(MAX_PROBLEMAS_ENVIO_ESTOQUE_AMAZON)
        .default(() => []),
    })
    .superRefine((envio, ctx) => {
      const recusar = (path: string, message: string) => {
        ctx.addIssue({ code: 'custom', path: [path], message });
      };
      if (envio.via === VIA_ENVIO_ESTOQUE_AMAZON.feed) {
        if (envio.quantidade !== null) recusar('quantidade', 'um feed não guarda quantidade');
        if (envio.feedId === null) recusar('feedId', 'um resultado de feed precisa do feedId');
        if (envio.submissionId !== null) recusar('submissionId', 'um feed não tem submissionId');
        if (envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto) {
          recusar('resultado', 'só um patch pode ficar incerto');
        }
        return;
      }
      if (envio.quantidade === null) recusar('quantidade', 'um patch guarda a quantidade enviada');
      if (envio.feedId !== null) recusar('feedId', 'um patch não tem feedId');
      if (envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto) {
        if (envio.submissionId !== null) {
          recusar('submissionId', 'um patch incerto não tem resposta');
        }
        if (envio.problemas.length > 0) recusar('problemas', 'um patch incerto não tem resposta');
      }
    });

  const PROBLEMA = { code: '90220', message: 'campo obrigatório', severity: 'ERROR' };
  const AUSENTE = Symbol('ausente');
  /** Every combination of the fields the coherence reads, each with good and bad values. */
  const CORPUS: unknown[] = [];
  for (const via of ['patch', 'feed', 'PATCH', AUSENTE])
    for (const quantidade of [4, 0, null, -1, 1.5, '4', AUSENTE])
      for (const resultado of ['aceito', 'recusado', 'aceito-com-avisos', 'incerto', 'ACCEPTED'])
        for (const submissionId of ['f0e1d2c3', null, '', AUSENTE])
          for (const feedId of ['3485934', null, 'F1', AUSENTE])
            for (const problemas of [[], [PROBLEMA], AUSENTE]) {
              const doc: Record<string, unknown> = { emMs: EM };
              const campos = { via, quantidade, resultado, submissionId, feedId, problemas };
              for (const [chave, valor] of Object.entries(campos)) {
                if (valor !== AUSENTE) doc[chave] = valor;
              }
              CORPUS.push(doc);
            }
  // The fields the coherence does not read, each with good and bad values.
  const BASE = { via: 'patch', emMs: EM, quantidade: 4, resultado: 'aceito', submissionId: 'x' };
  for (const emMs of [EM, 0, EM + 0.5, String(EM), -1, Number.MAX_SAFE_INTEGER + 1, null]) {
    CORPUS.push({ ...BASE, emMs });
  }
  CORPUS.push(
    { ...BASE, problemas: Array.from({ length: 10 }, () => PROBLEMA) },
    { ...BASE, problemas: Array.from({ length: 11 }, () => PROBLEMA) },
    { ...BASE, problemas: [{ severity: 'WARNING', messageId: 3, attributeName: 'quantity' }] },
    { ...BASE, novidade: 'uma chave desconhecida' },
    { ...BASE, oferta: { base: 10, minimo: 9, maximo: 10 } },
    null,
    'patch',
    [],
  );

  it('the corpus is wide (anti-vacuity): it holds both accepted and refused inputs', () => {
    expect(CORPUS.length).toBeGreaterThan(5_000);
    const aceitos = CORPUS.filter((c) => ORACULO_ESTOQUE.safeParse(c).success).length;
    expect(aceitos).toBeGreaterThan(50);
    expect(CORPUS.length - aceitos).toBeGreaterThan(50);
  });

  it('★ every input parses to the SAME data (keys in the same order) or fails with the SAME issues', () => {
    for (const entrada of CORPUS) {
      const novo = envioEstoqueAmazonSchema.safeParse(entrada);
      const antigo = ORACULO_ESTOQUE.safeParse(entrada);
      const rotulo = JSON.stringify(entrada);
      expect(novo.success, rotulo).toBe(antigo.success);
      if (novo.success && antigo.success) {
        expect(novo.data, rotulo).toEqual(antigo.data);
        expect(Object.keys(novo.data), rotulo).toEqual(Object.keys(antigo.data));
      } else {
        expect(novo.error?.issues, rotulo).toEqual(antigo.error?.issues);
      }
    }
  });

  it('the stock outcome keeps its shape: the same fields, in the same order, the enums unrenamed', () => {
    expect(Object.keys(envioEstoqueAmazonSchema.shape)).toEqual([
      'via',
      'emMs',
      'quantidade',
      'resultado',
      'submissionId',
      'feedId',
      'problemas',
    ]);
    expect(envioEstoqueAmazonSchema.shape.via).toBe(viaEnvioEstoqueAmazonSchema);
    expect(envioEstoqueAmazonSchema.shape.resultado).toBe(resultadoEnvioEstoqueAmazonSchema);
  });

  it('the factory names each flow’s value field in its refusals (NEAR-MISS: another flow’s field name)', () => {
    const teste = envioGuardadoListingAmazonSchema({
      campo: 'marca',
      schema: z.string().min(1),
      mensagemNoFeed: 'feed sem marca',
      mensagemSemValorNoPatch: 'patch com marca',
    });
    expect(Object.keys(teste.shape)).toEqual([
      'via',
      'emMs',
      'marca',
      'resultado',
      'submissionId',
      'feedId',
      'problemas',
    ]);
    const feed = teste.safeParse({
      via: 'feed',
      emMs: EM,
      marca: 'x',
      resultado: 'aceito',
      feedId: '1',
    });
    expect(feed.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['marca'], 'feed sem marca'],
    ]);
    const patch = teste.safeParse({ via: 'patch', emMs: EM, marca: null, resultado: 'aceito' });
    expect(patch.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['marca'], 'patch com marca'],
    ]);
    expect(
      teste.safeParse({ via: 'patch', emMs: EM, marca: 'x', resultado: 'aceito' }).success,
    ).toBe(true);
    // NEAR-MISS: the stock field is not this flow's: `quantidade` is stripped, `marca` missing.
    expect(
      teste.safeParse({ via: 'patch', emMs: EM, quantidade: 4, resultado: 'aceito' }).success,
    ).toBe(false);
  });
});

describe('★ step 13: envioPrecoAmazon — the last price outcome, from the same factory', () => {
  const LINK = { contaAmazonOuterRef: 'documents/integracao/int1', name: 'X', sku: 'Y' };
  const EM = 1_800_000_000_000;
  const OFERTA = { base: 129.9, minimo: 119.9, maximo: 129.9 };
  const PATCH = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs: EM,
    oferta: OFERTA,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceito,
    submissionId: 'f0e1d2c3',
  };
  const FEED = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.feed,
    emMs: EM,
    oferta: null,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.aceitoComAvisos,
    feedId: '3485934',
    problemas: [{ code: '19037', severity: 'ERROR', categories: ['INVALID_PRICE'] }],
  };
  /** The record a price task writes BEFORE its PATCH. */
  const INCERTO = {
    via: VIA_ENVIO_ESTOQUE_AMAZON.patch,
    emMs: EM,
    oferta: OFERTA,
    resultado: RESULTADO_ENVIO_ESTOQUE_AMAZON.incerto,
  };

  it('a patch outcome carries the offer it sent, and round-trips with its defaults', () => {
    expect(envioPrecoAmazonSchema.parse(PATCH)).toEqual({ ...PATCH, feedId: null, problemas: [] });
  });

  it('a feed outcome has oferta: null and its feedId (its prices live only in the feed document)', () => {
    const lido = envioPrecoAmazonSchema.parse(FEED);
    expect(lido.oferta).toBeNull();
    expect(lido.feedId).toBe('3485934');
    expect(lido.submissionId).toBeNull();
  });

  it('an incerto patch (the write-ahead record) keeps its offer and names neither id nor problem', () => {
    expect(envioPrecoAmazonSchema.parse(INCERTO)).toEqual({
      ...INCERTO,
      submissionId: null,
      feedId: null,
      problemas: [],
    });
  });

  it.each([
    ['a feed carrying an offer', { ...FEED, oferta: OFERTA }],
    ['a feed without its feedId', { ...FEED, feedId: null }],
    ['a feed with a submissionId', { ...FEED, submissionId: 'x' }],
    ['a feed left incerto (only a patch can be)', { ...FEED, resultado: 'incerto' }],
    ['a patch without its offer', { ...PATCH, oferta: null }],
    ['a patch naming a feed', { ...PATCH, feedId: '1' }],
    ['an incerto patch with a submissionId', { ...INCERTO, submissionId: 'x' }],
    ['an incerto patch with problems', { ...INCERTO, problemas: [{ code: 'X' }] }],
    [
      'an inverted offer (floor above the price)',
      { ...PATCH, oferta: { ...OFERTA, minimo: 129.91 } },
    ],
    [
      'an offer whose ceiling is below the price',
      { ...PATCH, oferta: { ...OFERTA, maximo: 129.89 } },
    ],
    ['an offer price with three decimals', { ...PATCH, oferta: { ...OFERTA, base: 129.905 } }],
    ['an offer price of zero', { ...PATCH, oferta: { ...OFERTA, minimo: 0 } }],
    ['an offer missing its ceiling', { ...PATCH, oferta: { base: 10, minimo: 10 } }],
    ['a µs-looking fractional emMs', { ...PATCH, emMs: EM + 0.5 }],
    ['a feedId outside the record grammar', { ...FEED, feedId: 'F1' }],
  ])('refuses an incoherent price outcome: %s (and the link refuses it too)', (_nome, envio) => {
    expect(envioPrecoAmazonSchema.safeParse(envio).success).toBe(false);
    expect(produtoAmazonLinkSchema.safeParse({ ...LINK, envioPrecoAmazon: envio }).success).toBe(
      false,
    );
  });

  it('NEAR-MISS: a STOCK outcome is not a price outcome (no offer), and a price one is not stock', () => {
    const estoque = { ...PATCH, quantidade: 4 } as Record<string, unknown>;
    delete estoque.oferta;
    expect(envioEstoqueAmazonSchema.safeParse(estoque).success).toBe(true);
    expect(envioPrecoAmazonSchema.safeParse(estoque).success).toBe(false);
    expect(envioEstoqueAmazonSchema.safeParse(PATCH).success).toBe(false);
    // The refusal names the PRICE field: a patch without its offer.
    const semOferta = envioPrecoAmazonSchema.safeParse({ ...PATCH, oferta: null });
    expect(semOferta.error?.issues.map((i) => [i.path, i.message])).toEqual([
      [['oferta'], 'um patch guarda a oferta enviada'],
    ]);
  });

  it('the offer is the price faixa, and the outcome reuses the stock enums unrenamed', () => {
    expect(Object.keys(envioPrecoAmazonSchema.shape)).toEqual([
      'via',
      'emMs',
      'oferta',
      'resultado',
      'submissionId',
      'feedId',
      'problemas',
    ]);
    expect(envioPrecoAmazonSchema.shape.via).toBe(viaEnvioEstoqueAmazonSchema);
    expect(envioPrecoAmazonSchema.shape.resultado).toBe(resultadoEnvioEstoqueAmazonSchema);
    expect(envioPrecoAmazonSchema.shape.oferta.unwrap()).toBe(faixaPrecoAmazonSchema);
  });

  it('★ a legacy link doc (no such field) parses with envioPrecoAmazon: null; the two outcomes are separate fields', () => {
    expect(produtoAmazonLinkSchema.parse(LINK).envioPrecoAmazon).toBeNull();
    const ambos = produtoAmazonLinkSchema.parse({
      ...LINK,
      envioEstoqueAmazon: {
        via: 'patch',
        emMs: EM - 1,
        quantidade: 3,
        resultado: 'aceito',
      },
      envioPrecoAmazon: PATCH,
    });
    expect(ambos.envioEstoqueAmazon?.quantidade).toBe(3);
    expect(ambos.envioPrecoAmazon?.oferta).toEqual(OFERTA);
    // NEAR-MISS: a price outcome stored under the STOCK field is refused there.
    expect(produtoAmazonLinkSchema.safeParse({ ...LINK, envioEstoqueAmazon: PATCH }).success).toBe(
      false,
    );
  });

  it('a partial merge of the link doc still validates the price field (the refinement sits on it)', () => {
    expect(
      produtoAmazonLinkSchema.partial().parse({ envioPrecoAmazon: INCERTO }).envioPrecoAmazon
        ?.resultado,
    ).toBe('incerto');
    expect(
      produtoAmazonLinkSchema.partial().safeParse({ envioPrecoAmazon: { ...FEED, oferta: OFERTA } })
        .success,
    ).toBe(false);
  });
});
