import { describe, expect, it } from 'vitest';
import {
  produtoShopeeLinkSchema,
  variacaoShopeeLinkSchema,
  shopeeItemStatusSchema,
  shopeeModelStatusSchema,
  SHOPEE_ITEM_STATUS,
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

  it('aceita os seis valores de wire de item_status', () => {
    for (const valor of [
      'NORMAL',
      'BANNED',
      'UNLIST',
      'REVIEWING',
      'SELLER_DELETE',
      'SHOPEE_DELETE',
    ]) {
      expect(shopeeItemStatusSchema.safeParse(valor).success).toBe(true);
    }
    // e o link doc aceita cada um deles no campo
    for (const valor of Object.values(SHOPEE_ITEM_STATUS)) {
      const parsed = produtoShopeeLinkSchema.parse({
        contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
        item_name: 'X',
        item_status: valor,
      });
      expect(parsed.item_status).toBe(valor);
    }
  });

  it('⛔ NEAR-MISS: recusa DELETED (a grafia pré-2024)', () => {
    // `announcement 769`/`841`: até 2024-01-18 o conjunto era
    // NORMAL|BANNED|UNLIST|DELETED. A grafia antiga fica de fora de propósito.
    expect(shopeeItemStatusSchema.safeParse('DELETED').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('SELLER_DELETE').success).toBe(true);
  });

  it('⛔ NEAR-MISS: recusa normal minúsculo e um código que não é de wire', () => {
    expect(shopeeItemStatusSchema.safeParse('normal').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('Normal').success).toBe(false);
    expect(shopeeItemStatusSchema.safeParse('ACTIVE').success).toBe(false);
  });

  it('SHOPEE_ITEM_STATUS cobre exatamente os seis membros', () => {
    expect([...Object.values(SHOPEE_ITEM_STATUS)].sort()).toEqual([
      'BANNED',
      'NORMAL',
      'REVIEWING',
      'SELLER_DELETE',
      'SHOPEE_DELETE',
      'UNLIST',
    ]);
    expect([...shopeeItemStatusSchema.options].sort()).toEqual(
      [...Object.values(SHOPEE_ITEM_STATUS)].sort(),
    );
  });

  it('um item_status DELETED armazenado reprova no safeParse do documento inteiro', () => {
    // Registro do comportamento observado (register item 61). `parseSoftRead`
    // (`packages/data/src/zodParse.ts:123-133`) é `safeParse` + `console.warn` +
    // devolver o RAW: com um valor pré-2024 guardado ele NÃO derruba a leitura e
    // NÃO apaga a chave — devolve o documento cru, com o `DELETED` intacto e sem
    // nenhum `.default()` aplicado. Nada do caminho de importação chega aqui (o
    // raw existente é espalhado, nunca reparseado), e a primeira reimportação
    // substitui o valor por um vivo.
    const armazenado = {
      contaProdutoShopeeOuterRef: 'documents/integracao/int-1',
      item_name: 'X',
      item_status: 'DELETED',
    };
    const resultado = produtoShopeeLinkSchema.safeParse(armazenado);
    expect(resultado.success).toBe(false);
    if (resultado.success) throw new Error('esperava falha');
    expect(resultado.error.issues.some((i) => i.path.join('.') === 'item_status')).toBe(true);
    // o que `parseSoftRead` devolveria: o raw, sem tocar na chave
    expect(armazenado.item_status).toBe('DELETED');
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
