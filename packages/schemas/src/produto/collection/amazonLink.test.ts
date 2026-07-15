import { describe, expect, it } from 'vitest';
import {
  produtoAmazonLinkSchema,
  amazonSubmitStatusSchema,
  amazonListingStatusSchema,
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
