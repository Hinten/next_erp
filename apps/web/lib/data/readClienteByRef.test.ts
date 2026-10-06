/**
 * `refDeClienteOuNull` is TOTAL (#1656): `ClienteCell` calls it during render
 * and the `/pedidos` row batch inside `TableView`'s `onRows` effect, where a
 * throw blanks the whole page. It reads `ref.parent.id` (`ehRefDeCliente`), so
 * it is total only while every ref `dereferenceOuterRef` hands back really has
 * a parent — including for a stored map that is merely SHAPED like a ref.
 *
 * Runs on the REAL, never-connected client SDK; nothing is read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeApp } from 'firebase/app';
// eslint-disable-next-line no-restricted-imports -- Native foreign/nested refs are fixtures for the collection gate.
import { doc, getFirestore, type DocumentReference } from 'firebase/firestore';

const { getDocMock } = vi.hoisted(() => ({ getDocMock: vi.fn() }));
vi.mock('firebase/firestore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase/firestore')>()),
  getDoc: getDocMock,
}));

import { ehRefDeCliente, readClienteByRef, refDeClienteOuNull } from './readClienteByRef';

const db = getFirestore(
  initializeApp({ projectId: 'demo-cliente-ref' }, 'cliente-ref-test'),
  'default',
);

describe('refDeClienteOuNull', () => {
  it.each([
    ['a Flutter-ODM string', 'documents/clientes/x'],
    ['a bare string', 'clientes/x'],
    ['a native reference', doc(db, 'clientes/x')],
    ['an opaque map', { path: 'documents/clientes/x' }],
    ['a ref-shaped map with no parent', { path: 'clientes/x', id: 'x', firestore: null }],
  ])('%s into clientes → clientes/x', (_label, outerRef) => {
    expect(refDeClienteOuNull(db, outerRef)?.path).toBe('clientes/x');
  });

  it.each([
    ['absent', null],
    ['odd segments', 'clientes'],
    ['a ref-shaped map with an odd path', { path: 'clientes', id: 'x', firestore: null }],
    // Near-miss: a well-formed ref, just into ANOTHER collection.
    ['foreign', 'documents/produtos/x'],
    ['nested string', 'a/b/clientes/x'],
    ['nested Flutter string', 'documents/a/b/clientes/x'],
    ['nested native reference', doc(db, 'a/b/clientes/x')],
    ['nested opaque map', { path: 'a/b/clientes/x' }],
    [
      'nested ref-shaped map',
      { path: 'a/b/clientes/x', id: 'x', firestore: db, parent: { id: 'clientes' } },
    ],
  ])('%s → null, never a throw', (_label, outerRef) => {
    expect(() => refDeClienteOuNull(db, outerRef)).not.toThrow();
    expect(refDeClienteOuNull(db, outerRef)).toBeNull();
  });
});

describe('ehRefDeCliente', () => {
  it('accepts the existing minimal test reference without parent.parent', () => {
    expect(
      ehRefDeCliente({
        id: 'x',
        path: 'clientes/x',
        parent: { id: 'clientes' },
      } as DocumentReference),
    ).toBe(true);
  });

  it('rejects a clientes subcollection and an inconsistent id', () => {
    expect(ehRefDeCliente(doc(db, 'a/b/clientes/x'))).toBe(false);
    expect(
      ehRefDeCliente({
        id: 'y',
        path: 'clientes/x',
        parent: { id: 'clientes' },
      } as DocumentReference),
    ).toBe(false);
  });
});

describe('readClienteByRef', () => {
  beforeEach(() => {
    getDocMock.mockReset();
    getDocMock.mockResolvedValue({ data: () => undefined });
  });

  it('reads a nested reference as given, never clientes/<same id>', async () => {
    const ref = doc(db, 'a/b/clientes/x');
    expect(await readClienteByRef(db, ref)).toBeNull();
    expect(getDocMock).toHaveBeenCalledWith(ref);
  });

  it('uses the cliente converter for a top-level reference', async () => {
    const ref = doc(db, 'clientes/x');
    await readClienteByRef(db, ref);
    const target = getDocMock.mock.calls[0]?.[0] as DocumentReference;
    expect(target.path).toBe('clientes/x');
    expect(target.converter).not.toBeNull();
  });
});
