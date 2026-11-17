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
} from './amazonLink';

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
