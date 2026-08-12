import { describe, expect, it } from 'vitest';
import {
  produtoShopeeLinkSchema,
  variacaoShopeeLinkSchema,
  shopeeItemStatusSchema,
  shopeeModelStatusSchema,
} from './shopeeLink';

describe('produtoShopeeLinkSchema', () => {
  it('parses a legacy-shaped ProdutoShopee fixture doc', () => {
    const fixture = {
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'Camiseta Básica Azul',
      item_id: 123456789,
      category_id: 100182,
      description: 'Camiseta 100% algodão.',
      description_type: 'normal',
      description_info: { field_list: [{ field_type: 'text', text: 'Camiseta 100% algodão.' }] },
      attributes: [{ attribute_id: 6, attribute_value_list: [{ value_id: 900000 }] }],
      complaint_policy: { warranty_time: 90, extended_consumer_protection: false },
      pre_order: { is_pre_order: false, days_to_ship: 2 },
      item_status: 'NORMAL',
      logistic_info: [{ logistic_id: 1, enabled: true }],
      wholesale: [{ min_count: 3, max_count: 10, unit_price: 19.9 }],
      brand_id: 0,
      item_dangerous: 0,
      violations: null,
    };
    const parsed = produtoShopeeLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      item_name: 'Camiseta Básica Azul',
      item_id: 123456789,
      category_id: 100182,
      item_status: 'NORMAL',
      brand_id: 0,
    });
  });

  it('requires a non-empty item_name', () => {
    expect(
      produtoShopeeLinkSchema.safeParse({
        contaProdutoShopeeOuterRef: 'documents/integracao/int1',
        item_name: '',
      }).success,
    ).toBe(false);
    expect(produtoShopeeLinkSchema.safeParse({}).success).toBe(false);
  });

  it('rejects when contaProdutoShopeeOuterRef is missing', () => {
    expect(produtoShopeeLinkSchema.safeParse({ item_name: 'X' }).success).toBe(false);
  });

  it('defaults nullable fields to null when absent', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
    });
    expect(parsed.item_id).toBeNull();
    expect(parsed.category_id).toBeNull();
    expect(parsed.item_status).toBeNull();
    expect(parsed.violations).toBeNull();
  });

  it('accepts only the two item_status wire codes', () => {
    expect(shopeeItemStatusSchema.safeParse('NORMAL').success).toBe(true);
    expect(shopeeItemStatusSchema.safeParse('UNLIST').success).toBe(true);
    expect(shopeeItemStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('ACTIVE').success).toBe(false);
  });

  it('parses the banned-item push violations shape and typed extra keys pass through', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
      item_status: 'UNLIST',
      violations: [
        {
          days_to_fix: 7,
          suggestion: 'Remove counterfeit claim',
          violation_reason: 'IP infringement',
          violation_type: 'listing',
          // unknown extra key on the nested violation object
          reference_id: 'abc-123',
        },
      ],
    });
    expect(parsed.violations?.[0]).toMatchObject({
      days_to_fix: 7,
      violation_type: 'listing',
    });
    expect((parsed.violations?.[0] as Record<string, unknown>).reference_id).toBe('abc-123');
  });

  it('preserves unknown top-level fields (pass-through)', () => {
    const parsed = produtoShopeeLinkSchema.parse({
      contaProdutoShopeeOuterRef: 'documents/integracao/int1',
      item_name: 'X',
      _futureShopeeField: 'whatever',
    });
    expect((parsed as Record<string, unknown>)._futureShopeeField).toBe('whatever');
  });
});

describe('variacaoShopeeLinkSchema', () => {
  it('parses a legacy-shaped VariacaoShopee fixture doc', () => {
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 987654,
      tier_index: [0, 1],
      promotion_id: 555,
      model_status: 'MODEL_NORMAL',
    });
    expect(parsed).toMatchObject({
      model_id: 987654,
      tier_index: [0, 1],
      promotion_id: 555,
      model_status: 'MODEL_NORMAL',
    });
  });

  it('requires model_id and defaults tier_index to an empty array', () => {
    expect(variacaoShopeeLinkSchema.safeParse({}).success).toBe(false);
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 1,
    });
    expect(parsed.tier_index).toEqual([]);
    expect(parsed.promotion_id).toBeNull();
    expect(parsed.model_status).toBeNull();
  });

  it('rejects when contaVariacaoShopeeOuterRef or produtoShopeeOuterRef is missing', () => {
    expect(variacaoShopeeLinkSchema.safeParse({ model_id: 1 }).success).toBe(false);
    expect(
      variacaoShopeeLinkSchema.safeParse({
        model_id: 1,
        contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      }).success,
    ).toBe(false);
    expect(
      variacaoShopeeLinkSchema.safeParse({
        model_id: 1,
        produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      }).success,
    ).toBe(false);
  });

  it('accepts only the two model_status wire codes', () => {
    expect(shopeeModelStatusSchema.safeParse('MODEL_NORMAL').success).toBe(true);
    expect(shopeeModelStatusSchema.safeParse('MODEL_UNAVAILABLE').success).toBe(true);
    expect(shopeeModelStatusSchema.safeParse('NORMAL').success).toBe(false);
  });

  it('preserves unknown extra keys (pass-through)', () => {
    const parsed = variacaoShopeeLinkSchema.parse({
      contaVariacaoShopeeOuterRef: 'documents/integracao/int1',
      produtoShopeeOuterRef: 'documents/produtos/p1/prodshopee/l1',
      model_id: 1,
      _customField: 'x',
    });
    expect((parsed as Record<string, unknown>)._customField).toBe('x');
  });
});
