import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { describe, expect, it, vi } from 'vitest';

import {
  InvalidDocumentPathError,
  type SourceDb,
  type SourceSnapshot,
  type TargetDb,
  WATERMARKS_COLLECTION,
  mirrorPath,
  relativeDocumentPath,
  watermarkId,
} from './mirror';
import type { Stamp } from './watermark';

const t = (seconds: number, nanoseconds = 0): Stamp => ({ seconds, nanoseconds });

type Version = { data: Record<string, unknown>; updateTime: Stamp } | { deletedAt: Stamp };

/** A source whose answer for each path is set by the test, read by read. */
function fakeSource(versions: Map<string, Version>): SourceDb {
  return {
    doc: (path) => ({
      get: () => {
        const v = versions.get(path);
        const snap: SourceSnapshot =
          v && 'data' in v
            ? { exists: true, updateTime: v.updateTime, readTime: v.updateTime, data: () => v.data }
            : { exists: false, readTime: v?.deletedAt ?? t(0), data: () => undefined };
        return Promise.resolve(snap);
      },
    }),
  };
}

interface Ref {
  readonly path: string;
}

/** An in-memory target. A transaction runs once: contention is not this test's subject. */
function fakeTarget(): TargetDb<Ref> & { store: Map<string, Record<string, unknown>> } {
  const store = new Map<string, Record<string, unknown>>();
  return {
    store,
    doc: (path) => ({ path }),
    runTransaction: (fn) =>
      fn({
        get: (ref) => Promise.resolve({ data: () => store.get(ref.path) }),
        set: (ref, data) => store.set(ref.path, structuredClone(data)),
        delete: (ref) => store.delete(ref.path),
      }),
  };
}

const wm = (path: string) => `${WATERMARKS_COLLECTION}/${watermarkId(path)}`;
const COPY = { credentials: 'copy' } as const;
const DENY = { credentials: 'deny' } as const;

describe('mirrorPath — credential policy', () => {
  const token = 'integracao/ml/tokenDuravel/t1';

  it('deny: never copies a credential document, and never reads it from the source', async () => {
    const read = vi.fn();
    const source: SourceDb = { doc: () => ({ get: read }) };
    const target = fakeTarget();

    await expect(mirrorPath(token, source, target, DENY)).resolves.toBe('denied');

    expect(read).not.toHaveBeenCalled();
    expect(target.store.has(token)).toBe(false);
    expect(target.store.has(wm(token))).toBe(false);
  });

  it('deny: deletes a credential the seed import already brought in', async () => {
    const target = fakeTarget();
    target.store.set(token, { refresh_token: 'TG-imported' });

    await mirrorPath(token, fakeSource(new Map()), target, DENY);

    expect(target.store.has(token)).toBe(false);
  });

  it('deny: copies an integracao document without its WhatsApp token and PIN', async () => {
    const versions = new Map<string, Version>([
      [
        'integracao/w',
        { data: { nome: 'w', permanent_token: 'EAAG', pin: '1' }, updateTime: t(3) },
      ],
    ]);
    const target = fakeTarget();

    await expect(mirrorPath('integracao/w', fakeSource(versions), target, DENY)).resolves.toBe(
      'applied',
    );
    expect(target.store.get('integracao/w')).toEqual({ nome: 'w' });
  });

  it('copy: copies credentials verbatim — the real migration needs them current', async () => {
    const versions = new Map<string, Version>([
      [token, { data: { refresh_token: 'TG-current' }, updateTime: t(9) }],
      ['integracao/w', { data: { permanent_token: 'EAAG' }, updateTime: t(9) }],
    ]);
    const target = fakeTarget();

    await expect(mirrorPath(token, fakeSource(versions), target, COPY)).resolves.toBe('applied');
    await mirrorPath('integracao/w', fakeSource(versions), target, COPY);

    expect(target.store.get(token)).toEqual({ refresh_token: 'TG-current' });
    expect(target.store.get('integracao/w')).toEqual({ permanent_token: 'EAAG' });
  });

  it('deny: an ordinary document is mirrored as usual (near-miss)', async () => {
    const versions = new Map<string, Version>([
      ['pedidos/p/token/t', { data: { a: 1 }, updateTime: t(2) }],
    ]);
    const target = fakeTarget();

    await expect(mirrorPath('pedidos/p/token/t', fakeSource(versions), target, DENY)).resolves.toBe(
      'applied',
    );
  });
});

describe('mirrorPath', () => {
  it('copies the current source document and stamps its watermark', async () => {
    const versions = new Map<string, Version>([
      ['pedidos/p1', { data: { estado: 'pago' }, updateTime: t(10) }],
    ]);
    const target = fakeTarget();

    await expect(mirrorPath('pedidos/p1', fakeSource(versions), target, COPY)).resolves.toBe(
      'applied',
    );

    expect(target.store.get('pedidos/p1')).toEqual({ estado: 'pago' });
    expect(target.store.get(wm('pedidos/p1'))).toEqual({
      path: 'pedidos/p1',
      exists: true,
      stamp: t(10),
    });
  });

  it('refuses a stale observation that commits after a newer one', async () => {
    // Two invocations: A read v1 (t=10), B read v2 (t=11); B's transaction lands first.
    const target = fakeTarget();
    const v2 = new Map<string, Version>([['p/1', { data: { v: 2 }, updateTime: t(11) }]]);
    const v1 = new Map<string, Version>([['p/1', { data: { v: 1 }, updateTime: t(10) }]]);

    await mirrorPath('p/1', fakeSource(v2), target, COPY);
    await expect(mirrorPath('p/1', fakeSource(v1), target, COPY)).resolves.toBe('skipped');

    expect(target.store.get('p/1')).toEqual({ v: 2 });
    expect(target.store.get(wm('p/1'))).toMatchObject({ stamp: t(11) });
  });

  it('propagates a delete, and a stale pre-delete version cannot resurrect it', async () => {
    const target = fakeTarget();
    await mirrorPath(
      'p/1',
      fakeSource(new Map([['p/1', { data: { v: 1 }, updateTime: t(10) }]])),
      target,
      COPY,
    );
    await expect(
      mirrorPath('p/1', fakeSource(new Map([['p/1', { deletedAt: t(12) }]])), target, COPY),
    ).resolves.toBe('applied');

    expect(target.store.has('p/1')).toBe(false);
    expect(target.store.get(wm('p/1'))).toMatchObject({ exists: false, stamp: t(12) });

    await expect(
      mirrorPath(
        'p/1',
        fakeSource(new Map([['p/1', { data: { v: 1 }, updateTime: t(10) }]])),
        target,
        COPY,
      ),
    ).resolves.toBe('skipped');
    expect(target.store.has('p/1')).toBe(false);
  });

  it('re-applies the same version, repairing a document the import overwrote', async () => {
    // The mirror stamped t=20 before the import finished; the import then wrote the
    // T0 version over the document and left the watermark alone. Replaying the
    // unchanged source must put t=20 back.
    const versions = new Map<string, Version>([
      ['p/1', { data: { v: 'after-T0' }, updateTime: t(20) }],
    ]);
    const target = fakeTarget();
    await mirrorPath('p/1', fakeSource(versions), target, COPY);
    target.store.set('p/1', { v: 'T0-from-import' });

    await expect(mirrorPath('p/1', fakeSource(versions), target, COPY)).resolves.toBe('applied');
    expect(target.store.get('p/1')).toEqual({ v: 'after-T0' });
  });

  it('keeps the watermark of a subcollection document separate from its parent', async () => {
    const versions = new Map<string, Version>([
      ['pedidos/p1', { data: { a: 1 }, updateTime: t(30) }],
      ['pedidos/p1/nfev4/n1', { data: { b: 2 }, updateTime: t(5) }],
    ]);
    const target = fakeTarget();
    await mirrorPath('pedidos/p1', fakeSource(versions), target, COPY);

    await expect(
      mirrorPath('pedidos/p1/nfev4/n1', fakeSource(versions), target, COPY),
    ).resolves.toBe('applied');
    expect(watermarkId('pedidos/p1')).not.toBe(watermarkId('pedidos/p1/nfev4/n1'));
  });

  it('rebinds references to the target before writing', async () => {
    const legacy = getFirestore(
      initializeApp({ projectId: 'demo-erp' }, 'mirror-src'),
      '(default)',
    );
    const versions = new Map<string, Version>([
      ['p/1', { data: { cliente: legacy.doc('clientes/c1') }, updateTime: t(1) }],
    ]);
    const target = fakeTarget();
    await mirrorPath('p/1', fakeSource(versions), target, COPY);

    expect(target.store.get('p/1')).toEqual({ cliente: { path: 'clientes/c1' } });
  });

  it('refuses a path that is not a document path', async () => {
    await expect(mirrorPath('pedidos', fakeSource(new Map()), fakeTarget(), COPY)).rejects.toThrow(
      InvalidDocumentPathError,
    );
  });
});

describe('relativeDocumentPath', () => {
  it('accepts a relative path at depths 1–3', () => {
    expect(relativeDocumentPath('a/1')).toBe('a/1');
    expect(relativeDocumentPath('a/1/b/2/c/3')).toBe('a/1/b/2/c/3');
  });

  it('strips a fully-qualified resource name', () => {
    expect(relativeDocumentPath('projects/x/databases/(default)/documents/pedidos/p1')).toBe(
      'pedidos/p1',
    );
  });

  it.each(['', 'a', 'a/1/b', 'a//1', '/a/1'])('rejects %j', (path) => {
    expect(() => relativeDocumentPath(path)).toThrow(InvalidDocumentPathError);
  });
});
