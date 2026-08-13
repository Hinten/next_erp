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

  it('gives each row its OWN column object, not a shared reference', () => {
    // The tree is handed to a provider that may mutate or serialise it; one
    // shared object across 75 rows makes any such edit apply to all of them.
    const { schema } = buildMedidasSchema(ROWS, COLUMNS);
    expect(schema.properties?.P?.properties).not.toBe(schema.properties?.M?.properties);
  });
});

describe('buildMedidasSchema — caps and collisions are reported, never silent', () => {
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
