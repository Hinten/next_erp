import { describe, expect, it } from 'vitest';
import { produtoMagaluLinkSchema, statusProdutoMagaluSchema } from './magaluLink';

describe('produtoMagaluLinkSchema', () => {
  it('parses a legacy-shaped ProdutoMagalu fixture doc', () => {
    const fixture = {
      contaMagaluOuterRef: 'documents/integracao/int1',
      status: 'published',
      groupId: 'group-001',
      sku: 'SKU-001',
      title: 'Camiseta Básica Azul',
      type: 'product',
      description: 'Camiseta 100% algodão.',
      attributes: [{ name: 'color', value: 'blue' }],
      datasheet: [{ name: 'material', value: 'cotton' }],
      extra_data: [{ name: 'warranty', value: '90 days' }],
    };
    const parsed = produtoMagaluLinkSchema.parse(fixture);
    expect(parsed).toMatchObject({
      status: 'published',
      groupId: 'group-001',
      sku: 'SKU-001',
      title: 'Camiseta Básica Azul',
      type: 'product',
    });
  });

  it('defaults type to "product" and all other nullable fields to null when absent', () => {
    const parsed = produtoMagaluLinkSchema.parse({
      contaMagaluOuterRef: 'documents/integracao/int1',
      title: 'X',
    });
    expect(parsed.type).toBe('product');
    expect(parsed.status).toBeNull();
    expect(parsed.groupId).toBeNull();
    expect(parsed.sku).toBeNull();
    expect(parsed.description).toBeNull();
    expect(parsed.attributes).toBeNull();
    expect(parsed.datasheet).toBeNull();
    expect(parsed.extra_data).toBeNull();
  });

  it('requires a non-empty title — our consumers and the Magalu payload assume one', () => {
    expect(
      produtoMagaluLinkSchema.safeParse({
        contaMagaluOuterRef: 'documents/integracao/int1',
      }).success,
    ).toBe(false);
    expect(
      produtoMagaluLinkSchema.safeParse({
        contaMagaluOuterRef: 'documents/integracao/int1',
        title: '',
      }).success,
    ).toBe(false);
  });

  it('rejects when contaMagaluOuterRef is missing', () => {
    expect(produtoMagaluLinkSchema.safeParse({ title: 'X' }).success).toBe(false);
  });

  it('accepts all 13 StatusProdutoMagalu wire codes', () => {
    const codes = [
      'new',
      'policies_approved',
      'policies_blocked',
      'policies_blocked_price',
      'policies_info',
      'policies_warn',
      'promotion_finished',
      'promotion_started',
      'published',
      'publishing_error',
      'unpublished',
      'inactivated',
      'enviado_arakene',
    ];
    expect(codes).toHaveLength(13);
    for (const code of codes) {
      expect(statusProdutoMagaluSchema.safeParse(code).success).toBe(true);
    }
    expect(statusProdutoMagaluSchema.safeParse('unknown_status').success).toBe(false);
  });

  it('accepts a null status (portfolios_sku webhook falls back to published upstream, #363)', () => {
    expect(
      produtoMagaluLinkSchema.parse({
        contaMagaluOuterRef: 'documents/integracao/int1',
        title: 'X',
        status: null,
      }).status,
    ).toBeNull();
  });

  it('preserves unknown top-level fields and unknown keys inside attribute entries', () => {
    const parsed = produtoMagaluLinkSchema.parse({
      contaMagaluOuterRef: 'documents/integracao/int1',
      title: 'X',
      attributes: [{ name: 'color', value: 'blue', extraKey: 'x' }],
      _futureMagaluField: 'whatever',
    });
    expect(parsed.attributes?.[0]).toMatchObject({ name: 'color', extraKey: 'x' });
    expect((parsed as Record<string, unknown>)._futureMagaluField).toBe('whatever');
  });
});
