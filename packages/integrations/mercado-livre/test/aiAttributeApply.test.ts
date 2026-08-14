import { describe, expect, it } from 'vitest';

import { applyAiAttributes, preCheckedSuggestionIds } from '../src/ai/attributeApply';
import type { AiAttributeSpec } from '../src/ai/attributeSchema';

function spec(over: Partial<AiAttributeSpec> & { id: string }): AiAttributeSpec {
  return {
    name: over.id,
    valueType: 'string',
    values: [],
    hint: null,
    valueMaxLength: null,
    defaultUnit: null,
    required: false,
    ...over,
  };
}

const ATTRS: AiAttributeSpec[] = [
  spec({ id: 'BRAND', name: 'Marca' }),
  spec({
    id: 'MATERIAL',
    valueType: 'list',
    values: [
      { id: 'M1', name: 'Algodão' },
      { id: 'M2', name: 'Poliéster' },
    ],
  }),
  spec({ id: 'LENGTH', valueType: 'number_unit', defaultUnit: 'cm' }),
];

describe('applyAiAttributes', () => {
  it('resolves a listed value to ML’s id, ignoring accents and case', () => {
    // The legacy compared raw strings, so "algodao" fell through to free text
    // and ML rejected the listing for an unknown value.
    expect(applyAiAttributes(ATTRS, { MATERIAL: 'algodao' })).toEqual([
      { id: 'MATERIAL', value_id: 'M1', value_name: 'Algodão', unit_id: null },
    ]);
  });

  it('attaches the unit to a bare number', () => {
    // ML wants the unit alongside the number; the legacy shipped "55" for a
    // length in centimetres.
    expect(applyAiAttributes(ATTRS, { LENGTH: 55 })).toEqual([
      { id: 'LENGTH', value_id: null, value_name: '55', unit_id: 'cm' },
    ]);
  });

  it('drops keys the category does not define', () => {
    // A stale answer for a category the operator has since changed.
    expect(applyAiAttributes(ATTRS, { NOT_A_REAL_ATTRIBUTE: 'x' })).toEqual([]);
  });

  it('carries "does not apply" through as ML’s sentinel, however it is spelled', () => {
    // Many attributes genuinely do not apply — voltage on a t-shirt, sole
    // material on a notebook. Dropping the answer forced the model to choose
    // between inventing a value and omitting an attribute it had judged right.
    for (const value of ['-1', 'N/A', 'n/a', 'não se aplica', 'nao se aplica', 'No aplica']) {
      expect(applyAiAttributes(ATTRS, { BRAND: value })).toEqual([
        { id: 'BRAND', value_id: '-1', value_name: 'N/A', unit_id: null },
      ]);
    }
  });

  it('does NOT read `null`/`none` as a claim that the attribute is inapplicable', () => {
    // ⚠️ These used to be treated as N/A. A model emitting `null` is expressing
    // ABSENCE, not inapplicability, and turning that into a positive "does not
    // apply" claim on a live listing is exactly the confident-wrong-answer the
    // prompt separates omission from. `null` is dropped by `coerceText`;
    // "none"/"nenhum" survive as free text ML can reject and name.
    expect(applyAiAttributes(ATTRS, { BRAND: null })).toEqual([]);
    expect(applyAiAttributes(ATTRS, { BRAND: 'none' })).toEqual([
      { id: 'BRAND', value_id: null, value_name: 'none', unit_id: null },
    ]);
  });

  it('normalises a sentinel matched by NAME to the same shape', () => {
    // ML localises the sentinel's name freely, so a spelling `NA_TEXTS` does
    // not know can still match a real option whose id is '-1'. It must land as
    // the canonical sentinel, not as ML's localised label masquerading as a
    // chosen value.
    const attrs = [
      spec({
        id: 'FIT',
        valueType: 'list',
        values: [
          { id: '-1', name: 'Sem especificar' },
          { id: 'F1', name: 'Slim' },
        ],
      }),
    ];
    expect(applyAiAttributes(attrs, { FIT: 'Sem especificar' })).toEqual([
      { id: 'FIT', value_id: '-1', value_name: 'N/A', unit_id: null },
    ]);
    // The real option beside it still resolves normally.
    expect(applyAiAttributes(attrs, { FIT: 'slim' })).toEqual([
      { id: 'FIT', value_id: 'F1', value_name: 'Slim', unit_id: null },
    ]);
  });

  it('drops blank and whitespace-only answers', () => {
    expect(applyAiAttributes(ATTRS, { BRAND: '', MATERIAL: '   ' })).toEqual([]);
  });

  it('keeps an unlisted value as free text so ML can say what is wrong', () => {
    // A silent omission tells the operator nothing; ML's rejection names the
    // attribute.
    expect(applyAiAttributes(ATTRS, { MATERIAL: 'Bambu' })).toEqual([
      { id: 'MATERIAL', value_id: null, value_name: 'Bambu', unit_id: null },
    ]);
  });

  it('coerces the types a model actually returns', () => {
    expect(applyAiAttributes(ATTRS, { BRAND: true })).toEqual([
      { id: 'BRAND', value_id: null, value_name: 'Sim', unit_id: null },
    ]);
    expect(applyAiAttributes(ATTRS, { BRAND: 12 })).toEqual([
      { id: 'BRAND', value_id: null, value_name: '12', unit_id: null },
    ]);
  });

  it('drops a composite value, which is the model ignoring the schema', () => {
    expect(applyAiAttributes(ATTRS, { BRAND: { nested: 'x' }, MATERIAL: ['a'] })).toEqual([]);
  });

  it('survives every non-object answer without throwing', () => {
    // The whole model response is untrusted input.
    for (const answer of [null, undefined, 'texto', 42, [], true]) {
      expect(applyAiAttributes(ATTRS, answer)).toEqual([]);
    }
  });

  it('drops NaN and Infinity rather than stringifying them', () => {
    expect(applyAiAttributes(ATTRS, { LENGTH: Number.NaN })).toEqual([]);
    expect(applyAiAttributes(ATTRS, { LENGTH: Number.POSITIVE_INFINITY })).toEqual([]);
  });

  // ⚠️ A REAL option beats the spelling heuristic. `NA_TEXTS` holds a fixed list
  // of ways to write "does not apply" and some of them are legitimate values —
  // an origin attribute really can offer an option named "NA". While a false hit
  // merely DROPPED the answer it was invisible and harmless; now it emits
  // `value_id: '-1'`, a positive claim, so a wrong hit publishes a false
  // disclaimer instead of the value the model actually picked.
  it('resolves a real option named "NA" to its own id, not to the sentinel', () => {
    const attrs = [
      spec({
        id: 'ORIGIN',
        valueType: 'list',
        values: [
          { id: 'V1', name: 'NA' },
          { id: 'V2', name: 'BR' },
        ],
      }),
    ];
    expect(applyAiAttributes(attrs, { ORIGIN: 'NA' })).toEqual([
      { id: 'ORIGIN', value_id: 'V1', value_name: 'NA', unit_id: null },
    ]);
  });

  it('reads -1 on a NUMBER attribute as the value, not as "does not apply"', () => {
    // Lens power, minimum operating temperature… `-1` is an ordinary reading.
    // The model was told to answer "N/A" in words, so a bare -1 here is far more
    // likely to be the measurement than the marker.
    expect(applyAiAttributes([spec({ id: 'GRAU', valueType: 'number' })], { GRAU: -1 })).toEqual([
      { id: 'GRAU', value_id: null, value_name: '-1', unit_id: null },
    ]);
    expect(
      applyAiAttributes([spec({ id: 'TEMP', valueType: 'number_unit', defaultUnit: 'C' })], {
        TEMP: '-1',
      }),
    ).toEqual([{ id: 'TEMP', value_id: null, value_name: '-1', unit_id: 'C' }]);
  });

  it('still reads -1 as the sentinel on a non-numeric attribute', () => {
    expect(applyAiAttributes(ATTRS, { BRAND: '-1' })).toEqual([
      { id: 'BRAND', value_id: '-1', value_name: 'N/A', unit_id: null },
    ]);
  });
});

describe('preCheckedSuggestionIds', () => {
  const suggestions = [
    { id: 'BRAND', value_id: null, value_name: 'Hering', unit_id: null },
    { id: 'MATERIAL', value_id: 'M1', value_name: 'Algodão', unit_id: null },
  ];

  it('pre-checks only the attributes that are currently empty', () => {
    // A suggestion that would overwrite what an operator typed stays visible
    // but unchecked — never applied by default.
    const current = [
      { id: 'BRAND', value_id: null, value_name: 'Marca do operador' },
      { id: 'MATERIAL', value_id: null, value_name: null },
    ];
    expect(preCheckedSuggestionIds(suggestions, current)).toEqual(['MATERIAL']);
  });

  it('treats a row holding only a value_id as filled', () => {
    const current = [{ id: 'MATERIAL', value_id: 'M2', value_name: null }];
    expect(preCheckedSuggestionIds(suggestions, current)).toEqual(['BRAND']);
  });

  it('treats whitespace as empty', () => {
    const current = [{ id: 'BRAND', value_id: '', value_name: '   ' }];
    expect(preCheckedSuggestionIds(suggestions, current)).toContain('BRAND');
  });

  it('pre-checks everything when the listing has no attributes yet', () => {
    expect(preCheckedSuggestionIds(suggestions, [])).toEqual(['BRAND', 'MATERIAL']);
  });

  // ⚠️ THE guard that makes "a human still confirms" true. The attribute an N/A
  // lands on is empty BY DEFINITION, so the empty-means-pre-check rule would
  // check every one of them. And `-1` satisfies ML's required check
  // (`apps/web/lib/mercado-livre/attributeForm.ts`), so the default path for a
  // required attribute the model judged inapplicable would be: checked → applied
  // on one bulk "Aplicar" → published as a positive disclaimer that also
  // silences the validation meant to catch the missing value.
  it('never pre-checks an N/A, even on an empty attribute', () => {
    const withNa = [
      { id: 'MODEL', value_id: '-1', value_name: 'N/A', unit_id: null },
      { id: 'BRAND', value_id: null, value_name: 'Hering', unit_id: null },
    ];
    expect(preCheckedSuggestionIds(withNa, [])).toEqual(['BRAND']);
  });

  it('still SHOWS the N/A — unchecked is not hidden', () => {
    // The operator has to be able to accept it deliberately; dropping it would
    // remove the answer instead of the automatic acceptance.
    const withNa = [{ id: 'MODEL', value_id: '-1', value_name: 'N/A', unit_id: null }];
    expect(preCheckedSuggestionIds(withNa, [])).toEqual([]);
    expect(withNa).toHaveLength(1);
  });
});
