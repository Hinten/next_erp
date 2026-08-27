import { describe, expect, it } from 'vitest';

import {
  buildMedidasSchema,
  type MedidaColumnSpec,
  type MedidaRowSpec,
} from '../src/ai/medidasSchema';

function column(over: Partial<MedidaColumnSpec> & { attributeId: string }): MedidaColumnSpec {
  return {
    label: over.attributeId,
    kind: 'number',
    values: [],
    unitId: 'cm',
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

const ROWS: MedidaRowSpec[] = [
  { key: 'g/1/v/p', size: 'P' },
  { key: 'g/1/v/m', size: 'M' },
  { key: 'g/1/v/g', size: 'G' },
];

const COLUMNS: MedidaColumnSpec[] = [
  column({ attributeId: 'CHEST_CIRCUMFERENCE_FROM', label: 'Tórax de', required: true }),
  column({ attributeId: 'CHEST_CIRCUMFERENCE_TO', label: 'Tórax até' }),
  column({
    attributeId: 'FIT',
    label: 'Modelagem',
    kind: 'select',
    unitId: null,
    values: [
      { id: 'F1', name: 'Justa' },
      { id: 'F2', name: 'Solta' },
    ],
  }),
];

describe('buildMedidasSchema — the anti-hallucination guards', () => {
  // These three ARE the reason this module exists, and they matter more here
  // than for attributes: a hallucinated measurement is indistinguishable from a
  // measured one, ships to buyers, and comes back as a return.
  it('never emits a `required` array, at any depth', () => {
    for (const node of walk(buildMedidasSchema(ROWS, COLUMNS).schema)) {
      expect(node).not.toHaveProperty('required');
    }
  });

  it('never emits `nullable`', () => {
    for (const node of walk(buildMedidasSchema(ROWS, COLUMNS).schema)) {
      expect(node).not.toHaveProperty('nullable');
    }
  });

  it('never emits `anyOf`', () => {
    for (const node of walk(buildMedidasSchema(ROWS, COLUMNS).schema)) {
      expect(node).not.toHaveProperty('anyOf');
    }
  });

  it('holds even when every column is required in Mercado Livre', () => {
    const allRequired = COLUMNS.map((c) => ({ ...c, required: true }));
    for (const node of walk(buildMedidasSchema(ROWS, allRequired).schema)) {
      expect(node).not.toHaveProperty('required');
    }
  });
});

describe('buildMedidasSchema — shape', () => {
  it('keys rows by size label and columns by attribute id', () => {
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(Object.keys(schema.properties ?? {})).toEqual(['P', 'M', 'G']);
    expect(Object.keys(schema.properties?.P?.properties ?? {})).toEqual([
      'CHEST_CIRCUMFERENCE_FROM',
      'CHEST_CIRCUMFERENCE_TO',
      'FIT',
    ]);
  });

  it('closes both levels with additionalProperties: false', () => {
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.P?.additionalProperties).toBe(false);
  });

  it('types every leaf as string, even a numeric column', () => {
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(schema.properties?.P?.properties?.CHEST_CIRCUMFERENCE_FROM?.type).toBe('string');
  });

  it('names the unit and forbids conversion in a numeric description', () => {
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    const desc = schema.properties?.P?.properties?.CHEST_CIRCUMFERENCE_FROM?.description ?? '';
    expect(desc).toContain('cm');
    expect(desc).toContain('Não converta');
  });

  it('enumerates a closed list by NAME, not by value id', () => {
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(schema.properties?.P?.properties?.FIT?.enum).toEqual(['Justa', 'Solta']);
  });

  it('falls back to free text when the list is longer than the cap', () => {
    const many = column({
      attributeId: 'FIT',
      kind: 'select',
      values: Array.from({ length: 5 }, (_, i) => ({
        id: `F${String(i)}`,
        name: `Op${String(i)}`,
      })),
    });
    const { schema } = buildMedidasSchema(ROWS, [many], { maxEnumValues: 3 });
    expect(schema.properties?.P?.properties?.FIT?.enum).toBeUndefined();
  });

  it('gives each row its own CELL objects, not just its own record', () => {
    // ⚠️ The record identity is the weak assertion, and it passed under a shallow
    // spread that still shared every cell node across all 75 rows. What matters
    // is the leaf: a provider editing `properties.P.properties.FIT` must not be
    // editing row M's at the same time.
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(schema.properties?.P?.properties).not.toBe(schema.properties?.M?.properties);
    expect(schema.properties?.P?.properties?.FIT).not.toBe(schema.properties?.M?.properties?.FIT);
    expect(schema.properties?.P?.properties?.FIT?.enum).not.toBe(
      schema.properties?.M?.properties?.FIT?.enum,
    );

    // And prove it behaviourally, not just by reference.
    schema.properties!.P!.properties!.FIT!.description = 'MUTATED';
    expect(schema.properties?.M?.properties?.FIT?.description).not.toBe('MUTATED');
  });

  it("never offers ML's `-1` sentinel as an enum member", () => {
    // Identified by value ID: ML localises its NAME per attribute and per site,
    // so a name-based filter matches nothing and offers it as a legal choice.
    const withNa = column({
      attributeId: 'FIT',
      kind: 'select',
      unitId: null,
      values: [
        { id: 'F1', name: 'Justa' },
        { id: '-1', name: 'Nao aplicavel' },
      ],
    });
    const { schema } = buildMedidasSchema(ROWS, [withNa]);
    expect(schema.properties?.P?.properties?.FIT?.enum).toEqual(['Justa']);
  });

  it('falls back to free text when the sentinel was the ONLY value', () => {
    // Counting before the drop would emit `enum: []` — a schema no answer can
    // satisfy, turning "I cannot read this" into a hard validation failure.
    const onlyNa = column({
      attributeId: 'FIT',
      kind: 'select',
      unitId: null,
      values: [{ id: '-1', name: 'N/A' }],
    });
    const { schema } = buildMedidasSchema(ROWS, [onlyNa]);
    expect(schema.properties?.P?.properties?.FIT?.enum).toBeUndefined();
  });
});

describe('buildMedidasSchema — the size-equivalence column', () => {
  const EQUIV = column({
    attributeId: 'FILTRABLE_SIZE',
    label: 'Tamanho padrão',
    kind: 'multiselect',
    unitId: null,
    required: true,
    sizeEquivalence: true,
    values: [
      { id: '3189130', name: '34' },
      { id: '3259450', name: '38' },
    ],
  });

  it('asks for an ARRAY, with the closed list on the ITEMS', () => {
    // ML tags its equivalence attribute `multivalued` and means it: one row maps
    // onto several standard sizes, and that set is the listing's size filter.
    const cell = buildMedidasSchema(ROWS, [EQUIV]).schema.properties?.P?.properties?.FILTRABLE_SIZE;
    expect(cell?.type).toBe('array');
    expect(cell?.items?.type).toBe('string');
    expect(cell?.items?.enum).toEqual(['34', '38']);
    // The enum belongs to the member, not the array.
    expect(cell?.enum).toBeUndefined();
  });

  it('never emits `minItems` — omission stays the cheapest answer', () => {
    for (const node of walk(buildMedidasSchema(ROWS, [EQUIV]).schema)) {
      expect(node).not.toHaveProperty('minItems');
      expect(node).not.toHaveProperty('required');
    }
  });

  it('gives each row its own ITEMS node and its own enum array', () => {
    // Same sharing hazard as the scalar cells, one level deeper: a provider that
    // edits `properties.P.properties.FILTRABLE_SIZE.items` must not be editing
    // every other row's at once.
    const { schema } = buildMedidasSchema(ROWS, [EQUIV]);
    const p = schema.properties?.P?.properties?.FILTRABLE_SIZE;
    const m = schema.properties?.M?.properties?.FILTRABLE_SIZE;
    expect(p?.items).not.toBe(m?.items);
    expect(p?.items?.enum).not.toBe(m?.items?.enum);
  });

  it('describes it as a correspondence, NOT as a measurement', () => {
    // ⚠️ The load-bearing half, and it lives in the schema rather than only in
    // the system instruction because the instruction is overridable per-install:
    // a custom one saved in the settings doc would never see the new rule. Under
    // the transcription rules alone ("omita o que não conseguir determinar",
    // "nunca invente") a model correctly leaves this column empty — and ML
    // refuses the whole guia over it.
    const desc =
      buildMedidasSchema(ROWS, [EQUIV]).schema.properties?.P?.properties?.FILTRABLE_SIZE
        ?.description ?? '';
    expect(desc).toContain('Equivalência de tamanho');
    expect(desc).toContain('NÃO é uma medida');
    expect(desc).toContain('deduza');
  });

  it('does not inherit the unit wording even when a unit is set', () => {
    const united = { ...EQUIV, unitId: 'cm' };
    const desc =
      buildMedidasSchema(ROWS, [united]).schema.properties?.P?.properties?.FILTRABLE_SIZE
        ?.description ?? '';
    expect(desc).not.toContain('Não converta');
  });

  it('leaves an ordinary multiselect as an array without the equivalence wording', () => {
    // The array shape follows `kind`; the wording follows `sizeEquivalence`.
    const plain = { ...EQUIV, attributeId: 'TAGS', sizeEquivalence: false };
    const cell = buildMedidasSchema(ROWS, [plain]).schema.properties?.P?.properties?.TAGS;
    expect(cell?.type).toBe('array');
    expect(cell?.description).not.toContain('Equivalência de tamanho');
  });
});

describe('buildMedidasSchema — caps and collisions are reported, never silent', () => {
  it('dedupes on the SAME key the answer is resolved with — case and accents', () => {
    // ⚠️ The bug this pins: the dedupe key used to be `trim()` while
    // `applyAiMedidas` resolves with `normalizeLoose`. `Único` and `unico`
    // survived as two schema properties, both answers landed on the FIRST row,
    // the second row got nothing, and `truncated` stayed false — silent
    // mis-attribution, the one outcome the dedupe exists to rule out.
    const nearDup: MedidaRowSpec[] = [
      { key: 'g/1/v/a', size: 'Único' },
      { key: 'g/1/v/b', size: 'unico' },
    ];
    const built = buildMedidasSchema(nearDup, COLUMNS);
    expect(built.rows).toHaveLength(1);
    expect(Object.keys(built.schema.properties ?? {})).toEqual(['Único']);
    expect(built.truncated).toBe(true);
  });

  it('keeps the ORIGINAL spelling as the property name', () => {
    // The key is normalised; the label the model sees is not — it has to match
    // what is printed on the photo.
    const built = buildMedidasSchema([{ key: 'g/1/v/a', size: 'Único' }], COLUMNS);
    expect(Object.keys(built.schema.properties ?? {})).toEqual(['Único']);
  });

  it('drops a duplicate size label rather than let it collide', () => {
    // Two rows on one schema property could not be attributed to either, and
    // writing a measurement to the wrong row is worse than not writing it.
    const dup: MedidaRowSpec[] = [
      { key: 'g/1/v/a', size: 'P' },
      { key: 'g/1/v/b', size: 'P' },
    ];
    const built = buildMedidasSchema(dup, COLUMNS);
    expect(built.rows).toHaveLength(1);
    expect(built.rows[0]?.key).toBe('g/1/v/a');
    expect(built.truncated).toBe(true);
  });

  it('drops a blank size label', () => {
    const built = buildMedidasSchema([{ key: 'g/1/v/a', size: '  ' }], COLUMNS);
    expect(built.rows).toHaveLength(0);
    expect(built.truncated).toBe(true);
  });

  it('caps rows and columns and says so', () => {
    const capped = buildMedidasSchema(ROWS, COLUMNS, { maxRows: 2, maxColumns: 1 });
    expect(capped.rows).toHaveLength(2);
    expect(capped.columns).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });

  it('reports truncated: false when nothing was dropped', () => {
    // Guards the flag itself: a `truncated` that is always true tells the
    // operator nothing, and one always false hides real losses.
    expect(buildMedidasSchema(ROWS, COLUMNS).truncated).toBe(false);
  });

  it('returns the surviving rows/columns so the prompt can name only those', () => {
    const capped = buildMedidasSchema(ROWS, COLUMNS, { maxRows: 1 });
    expect(Object.keys(capped.schema.properties ?? {})).toEqual(capped.rows.map((r) => r.size));
  });
});
