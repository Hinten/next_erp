import { describe, expect, it } from 'vitest';

import { itemSchema } from '../src/types';
import { ML_ATTR_SKU_PAI_NOME } from '../src/mapping/attributes';
import { mapUpMemberToImport } from '../src/mapping/importUserProduct';

/** A realistic User-Products member item (family_name != null), parsed through the schema. */
function upMemberItem(over: Record<string, unknown> = {}) {
  return itemSchema.parse({
    id: 'MLB111',
    title: 'Camiseta P Azul',
    family_name: 'Camiseta',
    family_id: 'UPF123',
    user_product_id: 'UPtin1',
    available_quantity: 5,
    seller_custom_field: 'prod-var-1',
    attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-CAM-P-AZUL' }],
    attribute_combinations: [
      { id: 'SIZE', name: 'Tamanho', value_id: '1', value_name: 'P' },
      { id: 'COLOR', name: 'Cor', value_id: '2', value_name: 'Azul' },
    ],
    ...over,
  });
}

describe('mapUpMemberToImport', () => {
  it('maps familyId, canonicalId and the member shape (id/sku/quantity/combos)', () => {
    const mapped = mapUpMemberToImport(upMemberItem());
    expect(mapped.familyId).toBe('UPF123');
    expect(mapped.canonicalId).toBe('UPF123');
    expect(mapped.member).toMatchObject({
      variationId: 'MLB111',
      sku: 'SKU-CAM-P-AZUL',
      availableQuantity: 5,
      sellerCustomField: 'prod-var-1',
    });
    expect(mapped.member.combos.map((c) => c.id)).toEqual(['SIZE', 'COLOR']);
  });

  it('composes nome from family_name + root attribute_combinations value_names', () => {
    const mapped = mapUpMemberToImport(upMemberItem());
    expect(mapped.member.nome).toBe('Camiseta P Azul');
  });

  it('falls back nome to title when family_name is absent', () => {
    const mapped = mapUpMemberToImport(upMemberItem({ family_name: null, title: 'Camiseta Solo' }));
    expect(mapped.member.nome).toBe('Camiseta Solo P Azul');
  });

  it('stringifies a numeric family_id', () => {
    const mapped = mapUpMemberToImport(upMemberItem({ family_id: 987 }));
    expect(mapped.familyId).toBe('987');
    expect(mapped.canonicalId).toBe('987');
  });

  it('falls canonicalId back to the item id when family_id is absent', () => {
    const mapped = mapUpMemberToImport(upMemberItem({ family_id: null }));
    expect(mapped.familyId).toBeNull();
    expect(mapped.canonicalId).toBe('MLB111');
  });

  it('reads SKU from the item attributes, not attribute_combinations', () => {
    const mapped = mapUpMemberToImport(
      upMemberItem({ attributes: [{ id: 'OTHER', value_name: 'nope' }] }),
    );
    expect(mapped.member.sku).toBeNull();
  });

  it('defaults availableQuantity to 0 and sellerCustomField to null when absent', () => {
    const mapped = mapUpMemberToImport(
      upMemberItem({ available_quantity: null, seller_custom_field: null }),
    );
    expect(mapped.member.availableQuantity).toBe(0);
    expect(mapped.member.sellerCustomField).toBeNull();
  });

  it('defaults combos to [] when attribute_combinations is absent, nome trims cleanly', () => {
    const mapped = mapUpMemberToImport(upMemberItem({ attribute_combinations: null }));
    expect(mapped.member.combos).toEqual([]);
    expect(mapped.member.nome).toBe('Camiseta');
  });

  it('skips null value_name combos when composing nome', () => {
    const mapped = mapUpMemberToImport(
      upMemberItem({
        attribute_combinations: [
          { id: 'SIZE', value_name: 'G' },
          { id: 'COLOR', value_name: null },
        ],
      }),
    );
    expect(mapped.member.nome).toBe('Camiseta G');
  });

  describe('skuPai (#1400)', () => {
    it('is null when the item carries no parent-sku characteristic', () => {
      // Every família published before #1400, and every conta with the sender off.
      expect(mapUpMemberToImport(upMemberItem()).skuPai).toBeNull();
    });

    it('reads the characteristic, and keeps it DISTINCT from the member sku', () => {
      const mapped = mapUpMemberToImport(
        upMemberItem({
          attributes: [
            { id: 'SELLER_SKU', value_name: 'SKU-CAM-P-AZUL' },
            { name: ML_ATTR_SKU_PAI_NOME, value_name: 'SKU-CAM' },
          ],
        }),
      );
      // The whole point: two different skus on ONE item.
      expect(mapped.skuPai).toBe('SKU-CAM');
      expect(mapped.member.sku).toBe('SKU-CAM-P-AZUL');
      expect(mapped.skuPai).not.toBe(mapped.member.sku);
    });

    it('IGNORES an id-bearing attribute, however it is named', () => {
      // ⚠️ This test asserted the OPPOSITE while it was unknown whether ML
      // echoes an id back — so the match ignored `id` and accepted both shapes.
      // Measured 2026-09-03 (`GET /items/MLB5183026663`): ML returns the
      // characteristic `id: null`. Matching id-less only is what makes a name
      // collision with a real ML attribute harmless, so an id-bearing entry is
      // now deliberately NOT ours.
      const mapped = mapUpMemberToImport(
        upMemberItem({
          attributes: [
            { id: 'SELLER_SKU', value_name: 'SKU-CAM-P-AZUL' },
            { id: 'CUSTOM-9', name: ML_ATTR_SKU_PAI_NOME, value_name: 'SKU-CAM' },
          ],
        }),
      );
      expect(mapped.skuPai).toBeNull();
      // The member's own sku is unaffected.
      expect(mapped.member.sku).toBe('SKU-CAM-P-AZUL');
    });

    it('never mistakes another characteristic for it', () => {
      const mapped = mapUpMemberToImport(
        upMemberItem({
          attributes: [
            { id: 'SELLER_SKU', value_name: 'SKU-CAM-P-AZUL' },
            { name: 'SKU do fornecedor', value_name: 'FORN-9' },
            { name: 'SKU', value_name: 'X' },
          ],
        }),
      );
      expect(mapped.skuPai).toBeNull();
    });
  });
});
