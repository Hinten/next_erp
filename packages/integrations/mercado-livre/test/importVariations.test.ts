import { describe, expect, it } from 'vitest';

import { itemSchema } from '../src/types';
import { mapMlVariationsToImport } from '../src/mapping/importVariations';

/** A realistic variations-model MLB item, parsed through the schema. */
function variationsItem(over: Record<string, unknown> = {}) {
  return itemSchema.parse({
    id: 'MLB123',
    title: 'Camiseta',
    variations: [
      {
        id: 111,
        available_quantity: 5,
        seller_custom_field: 'SKU-CAM-P-AZUL',
        attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-CAM-P-AZUL' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '1', value_name: 'P' },
          { id: 'COLOR', name: 'Cor', value_id: '2', value_name: 'Azul' },
        ],
      },
      {
        id: 222,
        available_quantity: 3,
        attributes: [{ id: 'SELLER_SKU', value_name: 'SKU-CAM-M-VERDE' }],
        attribute_combinations: [
          { id: 'SIZE', name: 'Tamanho', value_id: '3', value_name: 'M' },
          { id: 'COLOR', name: 'Cor', value_id: '4', value_name: 'Verde' },
        ],
      },
    ],
    ...over,
  });
}

describe('mapMlVariationsToImport', () => {
  it('maps id, sku (from the variation attributes, not combos) and combos', () => {
    const mapped = mapMlVariationsToImport(variationsItem());
    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      variationId: '111',
      sku: 'SKU-CAM-P-AZUL',
      sellerCustomField: 'SKU-CAM-P-AZUL',
      availableQuantity: 5,
    });
    expect(mapped[0]!.combos.map((c) => c.id)).toEqual(['SIZE', 'COLOR']);
  });

  it('composes nome from title + attribute_combinations value_names joined by space', () => {
    const mapped = mapMlVariationsToImport(variationsItem());
    expect(mapped[0]!.nome).toBe('Camiseta P Azul');
    expect(mapped[1]!.nome).toBe('Camiseta M Verde');
  });

  it('defaults availableQuantity to 0 when absent', () => {
    const item = variationsItem({
      variations: [{ id: 1, attribute_combinations: [] }],
    });
    const mapped = mapMlVariationsToImport(item);
    expect(mapped[0]!.availableQuantity).toBe(0);
  });

  it('skips variations with a null id', () => {
    const item = variationsItem({
      variations: [
        { id: null, attribute_combinations: [] },
        { id: 999, attribute_combinations: [] },
      ],
    });
    const mapped = mapMlVariationsToImport(item);
    expect(mapped).toHaveLength(1);
    expect(mapped[0]!.variationId).toBe('999');
  });

  it('stringifies numeric ids and passes through string ids as-is', () => {
    const item = variationsItem({
      variations: [
        { id: 42, attribute_combinations: [] },
        { id: 'MLBV77', attribute_combinations: [] },
      ],
    });
    const mapped = mapMlVariationsToImport(item);
    expect(mapped.map((m) => m.variationId)).toEqual(['42', 'MLBV77']);
  });

  it('defaults combos to [] when attribute_combinations is absent', () => {
    const item = variationsItem({ variations: [{ id: 1 }] });
    const mapped = mapMlVariationsToImport(item);
    expect(mapped[0]!.combos).toEqual([]);
    expect(mapped[0]!.nome).toBe('Camiseta');
  });

  it('skips null value_name combos when composing nome', () => {
    const item = variationsItem({
      variations: [
        {
          id: 1,
          attribute_combinations: [
            { id: 'SIZE', value_name: 'G' },
            { id: 'COLOR', value_name: null },
          ],
        },
      ],
    });
    const mapped = mapMlVariationsToImport(item);
    expect(mapped[0]!.nome).toBe('Camiseta G');
  });

  it('returns [] when the item has no variations', () => {
    expect(mapMlVariationsToImport(itemSchema.parse({ id: 'MLB1' }))).toEqual([]);
  });
});
