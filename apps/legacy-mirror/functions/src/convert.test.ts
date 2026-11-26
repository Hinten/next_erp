import { initializeApp } from 'firebase-admin/app';
import { GeoPoint, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it } from 'vitest';

import { rebindReferences } from './convert';

// Offline: constructing a Firestore handle and a DocumentReference opens no
// connection, so these instances never reach any project.
const source = getFirestore(initializeApp({ projectId: 'demo-erp' }, 'convert-src'), '(default)');
const target = getFirestore(initializeApp({ projectId: 'demo-erp' }, 'convert-dst'), 'default');
const toTarget = (path: string) => target.doc(path);

describe('rebindReferences', () => {
  it('rebinds a top-level, nested and in-array reference to the target database', () => {
    const out = rebindReferences(
      {
        cliente: source.doc('clientes/c1'),
        itens: [{ produto: source.doc('produtos/p1') }],
        meta: { deposito: source.doc('depositos/d1') },
      },
      toTarget,
    ) as {
      cliente: FirebaseFirestore.DocumentReference;
      itens: Array<{ produto: FirebaseFirestore.DocumentReference }>;
      meta: { deposito: FirebaseFirestore.DocumentReference };
    };

    for (const [ref, path] of [
      [out.cliente, 'clientes/c1'],
      [out.itens[0]!.produto, 'produtos/p1'],
      [out.meta.deposito, 'depositos/d1'],
    ] as const) {
      expect(ref.path).toBe(path);
      expect(ref.firestore).toBe(target);
      expect(ref.firestore).not.toBe(source);
    }
  });

  it('passes database-agnostic values through as the SAME instances', () => {
    const ts = Timestamp.fromMillis(1_700_000_000_123);
    const geo = new GeoPoint(-23.5, -46.6);
    const bytes = Buffer.from([1, 2, 3]);
    const out = rebindReferences({ ts, geo, bytes, n: 5, s: 'x', b: false, z: null }, toTarget) as {
      ts: Timestamp;
      geo: GeoPoint;
      bytes: Buffer;
    };

    expect(out.ts).toBe(ts);
    expect(out.geo).toBe(geo);
    expect(out.bytes).toBe(bytes);
    expect(out).toMatchObject({ n: 5, s: 'x', b: false, z: null });
  });

  it('does not treat a string that looks like a path as a reference', () => {
    // Near-miss: the legacy corpus stores many outerRefs as BARE STRINGS
    // (`depositos/<id>`). Those are data and must stay strings.
    expect(rebindReferences({ outerRef: 'depositos/d1' }, toTarget)).toEqual({
      outerRef: 'depositos/d1',
    });
  });

  it('copies maps instead of mutating the source data', () => {
    const data = { a: { ref: source.doc('x/1') } };
    rebindReferences(data, toTarget);
    expect(data.a.ref.firestore).toBe(source);
  });
});
