import { describe, expect, it } from 'vitest';
import type { MlCategoryAttribute } from '@delfrance/integrations-mercado-livre';

import {
  ML_BLOCKED_ATTRIBUTE_IDS,
  attributeOmission,
  isAttributeRequired,
  isLeafCategory,
  projectCategoriaAtributos,
} from './categoriaAtributos';

function attr(over: Partial<MlCategoryAttribute> & { id: string }): MlCategoryAttribute {
  return { name: over.id, value_type: 'string', ...over } as MlCategoryAttribute;
}

describe('attributeOmission', () => {
  it('drops every ERP- or variation-owned id', () => {
    for (const id of ML_BLOCKED_ATTRIBUTE_IDS) {
      expect(attributeOmission(attr({ id }), 'item')).toBe('bloqueado');
    }
  });

  it('drops a hidden attribute', () => {
    expect(attributeOmission(attr({ id: 'X', tags: { hidden: true } }), 'item')).toBe('oculto');
  });

  it('identifies size-chart attributes by value_type, not by a tag', () => {
    // api_response.dart:292 — `ehTabelaDeMedidas` IS this test. Getting it wrong
    // renders SIZE_GRID_ID as an editable text field that then fights the chart
    // binding publish resolves.
    expect(attributeOmission(attr({ id: 'SIZE_GRID_ID', value_type: 'grid_id' }), 'item')).toBe(
      'tabela-de-medidas',
    );
    expect(
      attributeOmission(attr({ id: 'SIZE_GRID_ROW_ID', value_type: 'grid_row_id' }), 'item'),
    ).toBe('tabela-de-medidas');
  });

  it('splits item and variation scope', () => {
    const variationOnly = attr({ id: 'X', tags: { variation_attribute: true } });
    expect(attributeOmission(variationOnly, 'item')).toBe('somente-variacao');
    expect(attributeOmission(variationOnly, 'variacao')).toBeNull();

    const itemOnly = attr({ id: 'Y' });
    expect(attributeOmission(itemOnly, 'item')).toBeNull();
    expect(attributeOmission(itemOnly, 'variacao')).toBe('somente-item');

    // `allow_variations` makes an attribute legal in BOTH scopes.
    const both = attr({ id: 'Z', tags: { allow_variations: true } });
    expect(attributeOmission(both, 'item')).toBeNull();
    expect(attributeOmission(both, 'variacao')).toBeNull();
  });

  it('reads tags in both wire shapes ML uses', () => {
    // ML sends a map on some categories and an array of names on others
    // (`_tagsFromJson`, api_response.dart:225).
    expect(attributeOmission(attr({ id: 'X', tags: ['hidden'] }), 'item')).toBe('oculto');
    expect(attributeOmission(attr({ id: 'X', tags: { hidden: true } }), 'item')).toBe('oculto');
  });
});

describe('isAttributeRequired', () => {
  it('treats all four ML required flags alike', () => {
    for (const tag of ['required', 'new_required', 'conditional_required', 'catalog_required']) {
      expect(isAttributeRequired(attr({ id: 'X', tags: { [tag]: true } }))).toBe(true);
    }
    expect(isAttributeRequired(attr({ id: 'X' }))).toBe(false);
  });
});

describe('projectCategoriaAtributos', () => {
  it('normalises the fields the editor renders', () => {
    const { atributos } = projectCategoriaAtributos(
      [
        attr({
          id: 'BRAND',
          name: 'Marca',
          value_type: 'string',
          values: [{ id: 'v1', name: 'Acme' }],
          tooltip: 'A marca do produto',
          value_max_length: 60,
          attribute_group_id: 'MAIN',
          attribute_group_name: 'Principais',
          tags: { required: true },
        }),
      ],
      'item',
    );
    expect(atributos[0]).toEqual({
      id: 'BRAND',
      name: 'Marca',
      valueType: 'string',
      values: [{ id: 'v1', name: 'Acme' }],
      hint: 'A marca do produto',
      valueMaxLength: 60,
      defaultUnit: null,
      allowedUnits: [],
      groupId: 'MAIN',
      groupName: 'Principais',
      required: true,
      multivalued: false,
      readOnly: false,
      relevance: null,
    });
  });

  it('prefers hint over tooltip, and default_unit over default_unit_id', () => {
    const { atributos } = projectCategoriaAtributos(
      [
        attr({
          id: 'LENGTH',
          value_type: 'number_unit',
          hint: 'em centímetros',
          tooltip: 'ignorado',
          default_unit: 'cm',
          default_unit_id: 'unit-cm',
        }),
      ],
      'item',
    );
    expect(atributos[0]!.hint).toBe('em centímetros');
    expect(atributos[0]!.defaultUnit).toBe('cm');
  });

  it('hoists required attributes, then orders by ML relevance', () => {
    // The legacy screen wanted exactly this — it carries a commented-out
    // `getAtributosObrigatorio` (cadastroProdutoMLNew.dart:862) — and never
    // shipped it, so operators hunted for the field blocking their publish.
    const { atributos } = projectCategoriaAtributos(
      [
        attr({ id: 'OPCIONAL_A', name: 'Opcional A', relevance: 1 }),
        attr({
          id: 'OBRIGATORIO_B',
          name: 'Obrigatório B',
          relevance: 9,
          tags: { required: true },
        }),
        attr({ id: 'OPCIONAL_C', name: 'Opcional C', relevance: 2 }),
        attr({
          id: 'OBRIGATORIO_A',
          name: 'Obrigatório A',
          relevance: 3,
          tags: { catalog_required: true },
        }),
      ],
      'item',
    );
    expect(atributos.map((a) => a.id)).toEqual([
      'OBRIGATORIO_A',
      'OBRIGATORIO_B',
      'OPCIONAL_A',
      'OPCIONAL_C',
    ]);
  });

  it('sorts attributes without a relevance last, then by name', () => {
    const { atributos } = projectCategoriaAtributos(
      [
        attr({ id: 'SEM_B', name: 'Zebra' }),
        attr({ id: 'COM', name: 'Com', relevance: 5 }),
        attr({ id: 'SEM_A', name: 'Abacaxi' }),
      ],
      'item',
    );
    expect(atributos.map((a) => a.id)).toEqual(['COM', 'SEM_A', 'SEM_B']);
  });

  it('reports why each withheld attribute was withheld', () => {
    const { atributos, omitidos } = projectCategoriaAtributos(
      [
        attr({ id: 'SELLER_SKU' }),
        attr({ id: 'ESCONDIDO', tags: { hidden: true } }),
        attr({ id: 'SIZE_GRID_ID', value_type: 'grid_id' }),
        attr({ id: 'VISIVEL' }),
      ],
      'item',
    );
    expect(atributos.map((a) => a.id)).toEqual(['VISIVEL']);
    expect(omitidos).toEqual([
      { id: 'SELLER_SKU', motivo: 'bloqueado' },
      { id: 'ESCONDIDO', motivo: 'oculto' },
      { id: 'SIZE_GRID_ID', motivo: 'tabela-de-medidas' },
    ]);
  });
});

describe('isLeafCategory', () => {
  it('treats an absent or empty children array as a leaf', () => {
    expect(isLeafCategory(undefined)).toBe(true);
    expect(isLeafCategory(null)).toBe(true);
    expect(isLeafCategory([])).toBe(true);
    expect(isLeafCategory([{ id: 'MLB1' }])).toBe(false);
  });
});
