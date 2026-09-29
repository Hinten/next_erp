/**
 * `refDeClienteOuNull` is TOTAL (#1656): `ClienteCell` calls it during render
 * and the `/pedidos` row batch inside `TableView`'s `onRows` effect, where a
 * throw blanks the whole page. It reads `ref.parent.id` (`ehRefDeCliente`), so
 * it is total only while every ref `dereferenceOuterRef` hands back really has
 * a parent — including for a stored map that is merely SHAPED like a ref.
 *
 * Runs on the REAL, never-connected client SDK; nothing is read.
 */
import { describe, expect, it } from 'vitest';
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';

import { refDeClienteOuNull } from './readClienteByRef';

const db = getFirestore(
  initializeApp({ projectId: 'demo-cliente-ref' }, 'cliente-ref-test'),
  'default',
);

describe('refDeClienteOuNull', () => {
  it.each([
    ['a Flutter-ODM string', 'documents/clientes/x'],
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
  ])('%s → null, never a throw', (_label, outerRef) => {
    expect(() => refDeClienteOuNull(db, outerRef)).not.toThrow();
    expect(refDeClienteOuNull(db, outerRef)).toBeNull();
  });
});
