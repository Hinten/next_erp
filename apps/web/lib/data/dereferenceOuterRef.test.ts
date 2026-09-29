/**
 * `dereferenceOuterRef` is TOTAL (#1656): every input returns a
 * `DocumentReference` or `null`, and none throws.
 *
 * Runs on the REAL, never-connected client SDK — `doc()` is never mocked here,
 * because what is under test is exactly which paths the real `doc()` would
 * reject (odd or empty segments throw a `FirebaseError` `invalid-argument`,
 * synchronously). Every other suite that touches this helper mocks it, so this
 * file is where its totality is proved. The normalisation rule itself
 * (`toOuterRefOrNull`) is pinned in `packages/schemas`' `outerRef.test.ts`;
 * this suite only proves the wiring.
 */
import { describe, expect, it } from 'vitest';
import { initializeApp } from 'firebase/app';
import { DocumentReference, getFirestore } from 'firebase/firestore';

import { dereferenceOuterRef } from './dereferenceOuterRef';

const db = getFirestore(initializeApp({ projectId: 'demo-deref' }, 'deref-test'), 'default');

/** Paths no document can have: an odd segment count, or nothing at all. */
const INDEREFERENCIAVEIS = [
  'clientes',
  'clientes/x/enderecos',
  'documents/clientes',
  'documents/x',
  'documents/a/b/c',
  'documents',
  '/',
  '//',
];

describe('dereferenceOuterRef', () => {
  describe('an opaque { path } ref', () => {
    it.each(['clientes', 'clientes/x/enderecos'])(
      '{ path: %j } (odd segments) → null, never a throw',
      (path) => {
        expect(dereferenceOuterRef(db, { path })).toBeNull();
      },
    );

    it('{ path: "documents/clientes/x" } drops the Flutter-ODM prefix → clientes/x', () => {
      const ref = dereferenceOuterRef(db, { path: 'documents/clientes/x' });
      expect(ref).toBeInstanceOf(DocumentReference);
      expect(ref?.path).toBe('clientes/x');
      expect(ref?.parent.id).toBe('clientes');
    });

    it.each(['documents/x', 'documents/a/b/c'])(
      '{ path: %j } names no document once the prefix is dropped → null',
      (path) => {
        // Before #1656 these resolved to the meaningless docs `documents/x` and
        // `documents/a/b/c` — the prefix was never stripped on this branch.
        expect(dereferenceOuterRef(db, { path })).toBeNull();
      },
    );

    it('near-miss: a bare even path still resolves, unchanged', () => {
      expect(dereferenceOuterRef(db, { path: 'clientes/x' })?.path).toBe('clientes/x');
    });

    it('collapses an empty segment exactly as the string branch always has', () => {
      // One rule for both branches: `a//b` is `a/b` whichever shape carries it.
      expect(dereferenceOuterRef(db, { path: 'a//b' })?.path).toBe('a/b');
      expect(dereferenceOuterRef(db, 'a//b')?.path).toBe('a/b');
    });
  });

  describe('a doc-path string (unchanged)', () => {
    it('drops the Flutter-ODM prefix', () => {
      expect(dereferenceOuterRef(db, 'documents/clientes/x')?.path).toBe('clientes/x');
    });

    it.each(['clientes', ''])('%j → null', (path) => {
      expect(dereferenceOuterRef(db, path)).toBeNull();
    });
  });

  it('passes a real DocumentReference through by identity', () => {
    const real = dereferenceOuterRef(db, 'clientes/x');
    expect(real).toBeInstanceOf(DocumentReference);
    expect(dereferenceOuterRef(db, real)).toBe(real);
  });

  describe('a stored map merely SHAPED like a DocumentReference', () => {
    // Firestore stores any map keys, so `{ path, id, firestore }` can come back
    // as a plain object. Passed through as a ref it has no `parent`, and
    // `ehRefDeCliente` reads `ref.parent.id` synchronously — in `ClienteCell`'s
    // render and in the `/pedidos` row-batch effect. So a map without a real
    // parent is read by the opaque `{ path }` rule instead.
    it.each([
      { path: 'clientes/x', id: 'x', firestore: null },
      { path: 'clientes/x', id: 'x', firestore: null, parent: null },
      // A real ref's `id` is always a string (the `/clientes/{id}` link reads it).
      { path: 'clientes/x', id: 42, firestore: null, parent: { id: 'clientes' } },
    ])('%j → a real ref to clientes/x', (map) => {
      const ref = dereferenceOuterRef(db, map);
      expect(ref).toBeInstanceOf(DocumentReference);
      expect(ref?.path).toBe('clientes/x');
      expect(ref?.parent.id).toBe('clientes');
    });

    it('with an odd path → null, never a throw', () => {
      expect(dereferenceOuterRef(db, { path: 'clientes', id: 'x', firestore: null })).toBeNull();
    });

    it('with a non-string path is no ref at all → null', () => {
      const map = { path: 42, id: 'x', firestore: null, parent: { id: 'clientes' } };
      expect(dereferenceOuterRef(db, map)).toBeNull();
    });
  });

  it.each([null, undefined, 42, {}, { path: 42 }, { path: '' }])(
    'a non-ref (%j) → null',
    (value) => {
      expect(dereferenceOuterRef(db, value)).toBeNull();
    },
  );

  it.each(INDEREFERENCIAVEIS)('never throws on %j, as an opaque ref or a string', (path) => {
    expect(() => dereferenceOuterRef(db, { path })).not.toThrow();
    expect(() => dereferenceOuterRef(db, path)).not.toThrow();
    expect(dereferenceOuterRef(db, { path })).toBeNull();
    expect(dereferenceOuterRef(db, path)).toBeNull();
  });
});
