import { describe, expect, it } from 'vitest';

import {
  buildAttributeSchema,
  type AiAttributeSpec,
  type JsonSchemaNode,
} from '../src/ai/attributeSchema';

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

/** Every node in the tree, so the guards below cannot be dodged by nesting. */
function walk(node: unknown): unknown[] {
  if (node == null || typeof node !== 'object') return [];
  const self = [node];
  const children = Object.values(node as Record<string, unknown>).flatMap(walk);
  return [...self, ...children];
}

const CATEGORY: AiAttributeSpec[] = [
  spec({ id: 'BRAND', name: 'Marca', required: true }),
  spec({
    id: 'MATERIAL',
    name: 'Material',
    valueType: 'list',
    values: [
      { id: 'M1', name: 'Algodão' },
      { id: 'M2', name: 'Poliéster' },
    ],
  }),
  spec({ id: 'LENGTH', name: 'Comprimento', valueType: 'number_unit', defaultUnit: 'cm' }),
];

describe('buildAttributeSchema — the anti-hallucination guards', () => {
  // These three assertions ARE the reason this module exists. The legacy
  // generator marked every property required (Schema.object defaults, with
  // `optionalProperties` never passed) while making ML-REQUIRED attributes
  // nullable — so the model could skip what ML demands and had to invent what
  // ML treats as optional. A generator that forces an answer gets one.
  it('never emits a `required` array, at any depth', () => {
    for (const node of walk(buildAttributeSchema(CATEGORY))) {
      expect(node).not.toHaveProperty('required');
    }
  });

  it('never emits `nullable`', () => {
    for (const node of walk(buildAttributeSchema(CATEGORY))) {
      expect(node).not.toHaveProperty('nullable');
    }
  });

  it('never emits `anyOf`', () => {
    for (const node of walk(buildAttributeSchema(CATEGORY))) {
      expect(node).not.toHaveProperty('anyOf');
    }
  });

  it('holds even for a category where EVERY attribute is required', () => {
    const allRequired = CATEGORY.map((a) => ({ ...a, required: true }));
    for (const node of walk(buildAttributeSchema(allRequired))) {
      expect(node).not.toHaveProperty('required');
    }
  });
});

describe('buildAttributeSchema', () => {
  it('exposes one property per attribute, keyed by ML id', () => {
    const schema = buildAttributeSchema(CATEGORY);
    expect(Object.keys(schema.properties!)).toEqual(['BRAND', 'MATERIAL', 'LENGTH']);
  });

  it('refuses keys the category never defined', () => {
    expect(buildAttributeSchema(CATEGORY).additionalProperties).toBe(false);
  });

  it('offers a closed list by NAME, not by ML value id', () => {
    // The model reasons about "Algodão", not about "M1" — and the applier
    // resolves the name back to the id accent-insensitively.
    const material = buildAttributeSchema(CATEGORY).properties!.MATERIAL!;
    expect(material.enum).toEqual(['Algodão', 'Poliéster', 'N/A']);
  });

  it('offers "N/A" under ONE fixed spelling, not ML’s localised label', () => {
    // ⚠️ ML spells its own sentinel differently per attribute and per site
    // ("N/A", "Não se aplica", "No aplica"). Passing that through would put an
    // unpredictable string in the enum that the applier then has to guess at —
    // and a guess it gets wrong ships as free text ML rejects. So ML's own
    // sentinel value is dropped and one fixed label is appended instead.
    const withNa = [
      spec({
        id: 'X',
        valueType: 'list',
        values: [
          { id: '-1', name: 'Não se aplica' },
          { id: 'V', name: 'Valor' },
        ],
      }),
    ];
    expect(buildAttributeSchema(withNa).properties!.X!.enum).toEqual(['Valor', 'N/A']);
  });

  it('falls back to free text when the sentinel is the only listed value', () => {
    // Nothing real to choose from, so an enum of just "N/A" would be a closed
    // list that can only say "does not apply" — worse than free text.
    const onlyNa = [
      spec({ id: 'X', valueType: 'list', values: [{ id: '-1', name: 'Não se aplica' }] }),
    ];
    const prop = buildAttributeSchema(onlyNa).properties!.X!;
    expect(prop.enum).toBeUndefined();
    expect(prop.type).toBe('string');
  });

  it('counts the enum cap over the REAL values only', () => {
    // The cap is about how many genuine choices are worth inlining; ML's own
    // sentinel is dropped before counting and "N/A" is appended after, so
    // neither one pushes a usable list over the limit.
    const values = [
      { id: '-1', name: 'Não se aplica' },
      { id: 'A', name: 'Um' },
      { id: 'B', name: 'Dois' },
    ];
    const prop = buildAttributeSchema([spec({ id: 'X', valueType: 'list', values })], {
      maxEnumValues: 2,
    }).properties!.X!;
    expect(prop.enum).toEqual(['Um', 'Dois', 'N/A']);
  });

  it('falls back to free text when the list is too long to inline', () => {
    // The response schema, not the prompt, dominates the token bill.
    const many = spec({
      id: 'BIG',
      valueType: 'list',
      values: Array.from({ length: 200 }, (_, i) => ({ id: `v${i}`, name: `Valor ${i}` })),
    });
    const prop = buildAttributeSchema([many], { maxEnumValues: 60 }).properties!.BIG!;
    expect(prop.enum).toBeUndefined();
    expect(prop.type).toBe('string');
  });

  it('truncates from the TAIL, where the least important attributes are', () => {
    // The server sorts required-first, so dropping the tail drops the least
    // relevant attributes rather than an arbitrary set.
    const schema = buildAttributeSchema(CATEGORY, { maxProperties: 2 });
    expect(Object.keys(schema.properties!)).toEqual(['BRAND', 'MATERIAL']);
  });

  it('types every value as a string, whatever ML calls it', () => {
    // Models emit 55 and "55" interchangeably; normalising downstream beats
    // making the schema police it.
    const props = buildAttributeSchema(CATEGORY).properties!;
    expect(Object.values(props).map((p: JsonSchemaNode) => p.type)).toEqual([
      'string',
      'string',
      'string',
    ]);
  });

  it('tells the model the unit instead of asking it to write one', () => {
    const length = buildAttributeSchema(CATEGORY).properties!.LENGTH!;
    expect(length.description).toContain('a unidade é cm');
  });

  it('marks a required attribute in prose WITHOUT making it mandatory', () => {
    const schema = buildAttributeSchema(CATEGORY);
    expect(schema.properties!.BRAND!.description).toContain('obrigatório');
    expect(schema).not.toHaveProperty('required');
  });

  it('carries ML’s own hint into the description', () => {
    const withHint = [spec({ id: 'GTIN', name: 'GTIN', hint: 'Código de barras EAN' })];
    expect(buildAttributeSchema(withHint).properties!.GTIN!.description).toContain(
      'Código de barras EAN',
    );
  });

  it('caps free text at ML’s own limit', () => {
    const capped = [spec({ id: 'MODEL', valueMaxLength: 30 })];
    expect(buildAttributeSchema(capped).properties!.MODEL!.maxLength).toBe(30);
  });

  it('produces a valid empty schema for a category with no attributes', () => {
    const schema = buildAttributeSchema([]);
    expect(schema.properties).toEqual({});
    expect(schema).not.toHaveProperty('required');
  });
});
