import { describe, expect, it } from 'vitest';
import {
  ML_PRODUTO_DERIVED_ATTRIBUTE_IDS,
  ML_PRODUTO_HERDADO_ATTRIBUTE_IDS,
  type MlCategoryAttribute,
} from '@delfrance/integrations-mercado-livre';

import {
  ML_BLOCKED_ATTRIBUTE_IDS,
  attributeOmission,
  categoriaUsaGuiaDeTamanhos,
  isAttributeRequired,
  isLeafCategory,
  projectCategoriaAtributos,
} from './categoriaAtributos';

function attr(over: Partial<MlCategoryAttribute> & { id: string }): MlCategoryAttribute {
  return { name: over.id, value_type: 'string', ...over } as MlCategoryAttribute;
}

describe('attributeOmission', () => {
  it('drops every catalogue- or variation-owned id', () => {
    for (const id of ML_BLOCKED_ATTRIBUTE_IDS) {
      expect(attributeOmission(attr({ id }), 'item')).toBe('bloqueado');
    }
  });

  // ⚠️ Every fixture here is deliberately UNTAGGED. ML tags `SELLER_PACKAGE_*`
  // `hidden` in many categories — MLB457167 among them — so a fixture carrying
  // that tag would come back `oculto` and pass against the version of this code
  // that had no `derivado` rule at all. The whole point is the category that
  // omits the tag, which is where the duplicated attribute used to ship.
  it('withholds a produto-derived id even when ML does not tag it hidden', () => {
    for (const id of ML_PRODUTO_DERIVED_ATTRIBUTE_IDS) {
      expect(attributeOmission(attr({ id }), 'item')).toBe('derivado');
      expect(attributeOmission(attr({ id }), 'variacao')).toBe('derivado');
    }
    // Named explicitly too: iterating the constant under test cannot catch it
    // being emptied, and WEIGHT is the one an operator actually reported seeing.
    expect(attributeOmission(attr({ id: 'WEIGHT', value_type: 'number_unit' }), 'item')).toBe(
      'derivado',
    );
    expect(attributeOmission(attr({ id: 'SELLER_PACKAGE_HEIGHT' }), 'item')).toBe('derivado');
  });

  // ⚠️ Same untagged-fixture rule, and here it is not merely prudent: ML does
  // not tag BRAND `hidden` in ANY category — it is `required` in most of them —
  // so an omission leaning on that tag would never fire for this id at all.
  it('withholds BRAND as herdado, never as derivado', () => {
    expect(attributeOmission(attr({ id: 'BRAND' }), 'item')).toBe('herdado');
    expect(attributeOmission(attr({ id: 'BRAND' }), 'variacao')).toBe('herdado');
    // ⚠️ The verdicts must not converge. apps/web prunes a `derivado` id's
    // stored value on the next save, and for BRAND that stored value is exactly
    // what publish falls back to when the produto has no Marca.
    expect(attributeOmission(attr({ id: 'BRAND' }), 'item')).not.toBe('derivado');
    for (const id of ML_PRODUTO_HERDADO_ATTRIBUTE_IDS) {
      expect(attributeOmission(attr({ id }), 'item')).toBe('herdado');
    }
  });

  // Being ML-required is BRAND's normal state and changes nothing here: the
  // value is not missing, it just lives on the produto.
  it('withholds BRAND even where the category marks it required', () => {
    expect(attributeOmission(attr({ id: 'BRAND', tags: { required: true } }), 'item')).toBe(
      'herdado',
    );
  });

  // The two spellings are different ML attributes and must not converge:
  // `PACKAGE_*` is ML's read-only factory data, `SELLER_PACKAGE_*` is ours.
  it('separates the read-only PACKAGE_* group from the derived SELLER_PACKAGE_* one', () => {
    expect(attributeOmission(attr({ id: 'PACKAGE_HEIGHT' }), 'item')).toBe('bloqueado');
    expect(ML_PRODUTO_DERIVED_ATTRIBUTE_IDS).not.toContain('PACKAGE_HEIGHT');
    expect(ML_BLOCKED_ATTRIBUTE_IDS).not.toContain('SELLER_PACKAGE_HEIGHT');
  });

  it('leaves the ficha técnica editable — those are not the package dimensions', () => {
    // HEIGHT/WIDTH/LENGTH describe the PRODUCT, arrive untagged (verified against
    // MLB457167) and nothing derives them. Withholding them would blank four
    // fields operators fill by hand.
    for (const id of ['HEIGHT', 'WIDTH', 'LENGTH', 'DEPTH', 'DIAMETER']) {
      expect(attributeOmission(attr({ id, value_type: 'number_unit' }), 'item')).toBeNull();
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
  // ⚠️ The fixture must be an id the projection actually RENDERS. This was
  // `BRAND` — a fine stand-in for "an ordinary required attribute" until BRAND
  // became `herdado` and stopped reaching `atributos` at all, at which point the
  // assertion read `undefined` and told you nothing about the normalisation it
  // is here to check. `MODEL` is withheld by no rule.
  it('normalises the fields the editor renders', () => {
    const { atributos } = projectCategoriaAtributos(
      [
        attr({
          id: 'MODEL',
          name: 'Modelo',
          value_type: 'string',
          values: [{ id: 'v1', name: 'Acme' }],
          tooltip: 'O modelo do produto',
          value_max_length: 60,
          attribute_group_id: 'MAIN',
          attribute_group_name: 'Principais',
          tags: { required: true },
        }),
      ],
      'item',
    );
    expect(atributos[0]).toEqual({
      id: 'MODEL',
      name: 'Modelo',
      valueType: 'string',
      values: [{ id: 'v1', name: 'Acme' }],
      hint: 'O modelo do produto',
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
        attr({ id: 'WEIGHT', value_type: 'number_unit' }),
        attr({ id: 'PACKAGE_HEIGHT' }),
        attr({ id: 'ESCONDIDO', tags: { hidden: true } }),
        attr({ id: 'SIZE_GRID_ID', value_type: 'grid_id' }),
        attr({ id: 'VISIVEL' }),
      ],
      'item',
    );
    expect(atributos.map((a) => a.id)).toEqual(['VISIVEL']);
    expect(omitidos).toEqual([
      { id: 'SELLER_SKU', motivo: 'derivado' },
      { id: 'WEIGHT', motivo: 'derivado' },
      { id: 'PACKAGE_HEIGHT', motivo: 'bloqueado' },
      { id: 'ESCONDIDO', motivo: 'oculto' },
      { id: 'SIZE_GRID_ID', motivo: 'tabela-de-medidas' },
    ]);
  });

  // `omitidos` is what `attributesForSave` is allowed to prune from the link
  // doc, so a derived id landing there is what finally clears the stale copies
  // an earlier build stored (legacy's `deleteNonShownAttributes`).
  it('lists every derived id in omitidos so the stored copy can be pruned', () => {
    const { omitidos } = projectCategoriaAtributos(
      ML_PRODUTO_DERIVED_ATTRIBUTE_IDS.map((id) => attr({ id })),
      'item',
    );
    expect(omitidos.map((o) => o.id).sort()).toEqual([...ML_PRODUTO_DERIVED_ATTRIBUTE_IDS].sort());
  });

  // ⚠️ THE invariant the herdado design rests on, and it is an ABSENCE: `BRAND`
  // is reported in NEITHER array. `omitidos` is the list `attributesForSave` is
  // allowed to prune, so naming BRAND there is what would delete the brand — and
  // it would do so on ANY apps/web bundle, including one deployed before this
  // change. Saying nothing instead hands the id to the "unknown to this category
  // — preserve verbatim" branch, which every version of that function has had.
  it('reports BRAND in NEITHER atributos NOR omitidos', () => {
    const { atributos, omitidos } = projectCategoriaAtributos(
      [attr({ id: 'BRAND', tags: { required: true } }), attr({ id: 'VISIVEL' })],
      'item',
    );
    expect(atributos.map((a) => a.id)).toEqual(['VISIVEL']);
    expect(omitidos).toEqual([]);
  });

  // The control: every OTHER withheld id must still be reported, or the stale
  // copies #799 removed come straight back.
  it('still reports every non-herdado omission', () => {
    const { omitidos } = projectCategoriaAtributos(
      [attr({ id: 'BRAND' }), attr({ id: 'SELLER_SKU' }), attr({ id: 'GTIN' })],
      'item',
    );
    expect(omitidos).toEqual([
      { id: 'SELLER_SKU', motivo: 'derivado' },
      { id: 'GTIN', motivo: 'bloqueado' },
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

/**
 * The gate for publish's local size-chart refusal (#1087).
 *
 * ⚠️ Both controls matter here: a category that DOES use a guia must answer
 * true, and one that does not must answer false. A predicate stuck on either
 * value would break exactly one of them — the false direction lets the live bug
 * through, the true direction blocks publishes that work today.
 */
describe('categoriaUsaGuiaDeTamanhos', () => {
  it('true for a fashion category — ML lists SIZE_GRID_ID as value_type grid_id', () => {
    expect(
      categoriaUsaGuiaDeTamanhos([
        attr({ id: 'BRAND' }),
        attr({ id: 'SIZE_GRID_ID', value_type: 'grid_id' }),
      ]),
    ).toBe(true);
  });

  it('false for a category with no size-chart attribute at all', () => {
    expect(categoriaUsaGuiaDeTamanhos([attr({ id: 'BRAND' }), attr({ id: 'MODEL' })])).toBe(false);
    expect(categoriaUsaGuiaDeTamanhos([])).toBe(false);
  });

  it('the VARIATION half alone does not count', () => {
    // `grid_row_id` is SIZE_GRID_ROW_ID, which rides a variation's attributes.
    // It says nothing about whether the ITEM needs a chart, so reusing the
    // two-element SIZE_CHART_VALUE_TYPES here would over-refuse.
    expect(
      categoriaUsaGuiaDeTamanhos([attr({ id: 'SIZE_GRID_ROW_ID', value_type: 'grid_row_id' })]),
    ).toBe(false);
  });

  it('does NOT depend on ML calling the attribute required', () => {
    // ⚠️ The deliberate looseness. ML spells "required" four ways and sets none
    // of them reliably on SIZE_GRID_ID — MLB1398, the category this was
    // reported against, is the case that would slip through a required-only
    // gate and reach ML anyway.
    const semTag = attr({ id: 'SIZE_GRID_ID', value_type: 'grid_id', tags: {} });
    expect(isAttributeRequired(semTag)).toBe(false);
    expect(categoriaUsaGuiaDeTamanhos([semTag])).toBe(true);
  });
});
