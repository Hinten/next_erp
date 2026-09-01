import { describe, expect, it } from 'vitest';

import type { WireValue } from './redact';
import {
  hasPathOrDescendants,
  isPopulated,
  mergeShapes,
  renderShape,
  typesAt,
  wireDigest,
  wireShape,
} from './wireDigest';

const CORPO: WireValue = {
  id: 2000018143664980,
  status: 'paid',
  buyer: { id: 3644236740, nickname: 'REDACTED' },
  payments: [
    {
      id: 1,
      date_approved: '2026-08-27T10:00:00.000-04:00',
      date_last_modified: '2026-08-27T10:05:00.000-04:00',
    },
    { id: 2, date_approved: null, date_last_modified: '2026-08-28T11:00:00.000-04:00' },
  ],
  variations: [],
  taxes: {},
  paid_amount: 49.9,
  fulfilled: true,
};

describe('wireDigest', () => {
  it('CONTROL A (known-good) — renders the shape as sorted path:type lines', () => {
    expect(wireDigest(CORPO)).toBe(
      [
        'buyer.id: number',
        'buyer.nickname: string',
        'fulfilled: boolean',
        'id: number',
        'paid_amount: number',
        'payments[].date_approved: null|string',
        'payments[].date_last_modified: string',
        'payments[].id: number',
        'status: string',
        'taxes: {}',
        'variations: []',
      ].join('\n'),
    );
  });

  it('CONTROL B (known-bad) — every single-leaf mutation changes the digest', () => {
    // ⚠️ Without this control a `wireDigest` that returned a constant would pass
    // CONTROL A's shape check as long as the constant matched, and would pass
    // every corpus comparison for ever after. Each mutation below is a drift ML
    // could really ship.
    const base = wireDigest(CORPO);

    const mutacoes: { readonly nome: string; readonly corpo: WireValue }[] = [
      {
        nome: 'ML renames a key (the date_last_updated class of bug)',
        corpo: {
          ...CORPO,
          payments: [{ id: 1, date_approved: null, date_last_updated: 'x' }],
        },
      },
      {
        nome: 'ML changes a type (number -> string)',
        corpo: { ...CORPO, paid_amount: '49.90' },
      },
      {
        nome: 'ML drops a key entirely',
        corpo: { ...CORPO, status: undefined as unknown as WireValue },
      },
      {
        nome: 'ML sends null where it used to send a value',
        corpo: { ...CORPO, paid_amount: null },
      },
      {
        nome: 'an empty array becomes populated (the UP variations signal)',
        corpo: { ...CORPO, variations: [{ id: 1 }] },
      },
      {
        nome: 'ML adds a key',
        corpo: { ...CORPO, novo_campo: 'surpresa' },
      },
    ];

    for (const { nome, corpo } of mutacoes) {
      expect(wireDigest(corpo), `mutation invisible to the digest: ${nome}`).not.toBe(base);
    }
  });

  it('treats null as its OWN type, never folded into the value type', () => {
    // "ML sent null" vs "ML omitted the key" is the distinction the raw capture
    // exists to preserve, so the digest has to carry it too.
    expect(wireDigest({ a: null })).toBe('a: null');
    expect(wireDigest({})).toBe('<root>: {}');
    expect(wireDigest({ a: null })).not.toBe(wireDigest({}));
  });

  it('unions element shapes across an array rather than sampling the first', () => {
    const shape = wireShape({ xs: [{ a: 1 }, { a: null }, { b: 'z' }] });
    expect([...typesAt(shape, 'xs[].a')].sort()).toEqual(['null', 'number']);
    expect([...typesAt(shape, 'xs[].b')]).toEqual(['string']);
  });

  it('distinguishes an EMPTY array from a missing key and from a populated one', () => {
    expect(wireDigest({ variations: [] })).toBe('variations: []');
    expect(wireDigest({})).not.toContain('variations');
    expect(wireDigest({ variations: [{ id: 1 }] })).toBe('variations[].id: number');
  });
});

describe('mergeShapes', () => {
  it('unions across fixtures, which is what makes a corpus census meaningful', () => {
    const merged = mergeShapes([
      wireShape({ a: 1 }),
      wireShape({ a: null }),
      wireShape({ b: 'x' }),
    ]);
    expect([...typesAt(merged, 'a')].sort()).toEqual(['null', 'number']);
    expect([...typesAt(merged, 'b')]).toEqual(['string']);
  });
});

describe('isPopulated', () => {
  it('is false for a path ML only ever sends as null', () => {
    // A permanently-null field is PRESENT but carries no type evidence. Counting
    // it as covered is how a contract assertion goes quietly vacuous.
    const shape = wireShape({ tracking_number: null, status: 'paid' });
    expect(isPopulated(shape, 'tracking_number')).toBe(false);
    expect(isPopulated(shape, 'status')).toBe(true);
  });

  it('is false for a path that never appears at all', () => {
    expect(isPopulated(wireShape({ a: 1 }), 'nao.existe')).toBe(false);
  });
});

describe('hasPathOrDescendants', () => {
  it('finds a populated ARRAY, which has no line of its own', () => {
    // The shape is leaf-only: a populated `payments` contributes `payments[].id`
    // and nothing at `payments`. Written as a lookup, a presence check reports
    // the money map's central field as missing on an order that plainly has it.
    const shape = wireShape({ payments: [{ id: 1 }] });
    expect(typesAt(shape, 'payments').size).toBe(0);
    expect(hasPathOrDescendants(shape, 'payments')).toBe(true);
  });

  it('finds a populated OBJECT the same way', () => {
    expect(hasPathOrDescendants(wireShape({ seller: { id: 1 } }), 'seller')).toBe(true);
  });

  it('still sees an EMPTY container, which does get its own line', () => {
    expect(hasPathOrDescendants(wireShape({ variations: [] }), 'variations')).toBe(true);
  });

  it('is false for an absent path, and does not match a sibling by prefix', () => {
    const shape = wireShape({ payments_summary: { total: 1 } });
    expect(hasPathOrDescendants(shape, 'payments')).toBe(false);
  });
});

describe('renderShape', () => {
  it('is deterministic regardless of key order — otherwise every diff is noise', () => {
    const a = renderShape(wireShape({ z: 1, a: 2, m: { y: 3, b: 4 } }));
    const b = renderShape(wireShape({ a: 2, m: { b: 4, y: 3 }, z: 1 }));
    expect(a).toBe(b);
  });
});
