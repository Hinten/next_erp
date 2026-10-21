import { describe, expect, it } from 'vitest';

import { lastSegment, naoDocId, parseItemIdFromResource, parsePmlOuterRef } from './linkRefs';

describe('parsePmlOuterRef', () => {
  it.each([
    'documents/produtos/p1/produtoMercadoLivre/l1',
    'produtos/p1/produtoMercadoLivre/l1',
    '/documents//produtos/p1//produtoMercadoLivre/l1/',
    'prefix/root/produtos/p1/produtoMercadoLivre/l1',
    'documents/produtos/p1/produtoMercadoLivre/l1/suffix/doc',
  ])('preserves the tolerated parent-link form %s', (ref) => {
    expect(parsePmlOuterRef(ref)).toEqual({ produtoId: 'p1', linkId: 'l1' });
  });

  it.each([
    '',
    'documents/produtos/p1',
    'documents/produtos/p1/produtoMercadoLivre',
    'documents/produtos/p1/variacaoMercadoLivre/l1',
    'documents/outros/p1/produtoMercadoLivre/l1',
    // The legacy parser uses the FIRST produtos segment, without searching again.
    'produtos/wrong/leaf/produtos/p1/produtoMercadoLivre/l1',
  ])('rejects a path without the required parent-link segments: %s', (ref) => {
    expect(parsePmlOuterRef(ref)).toBeNull();
  });

  it('keeps distinct produto and link ids distinct', () => {
    const base = parsePmlOuterRef('documents/produtos/p1/produtoMercadoLivre/l1');
    expect(parsePmlOuterRef('produtos/p2/produtoMercadoLivre/l1')).not.toEqual(base);
    expect(parsePmlOuterRef('produtos/p1/produtoMercadoLivre/l2')).not.toEqual(base);
  });
});

describe('notification resource parsing', () => {
  it('keeps bare numeric and hex ids usable without treating them as document refs', () => {
    expect(lastSegment('123')).toBe('123');
    expect(lastSegment('/orders/123')).toBe('123');
    expect(lastSegment('3f6da1e35ac84f70a24af7360d24c7bc')).toBe(
      '3f6da1e35ac84f70a24af7360d24c7bc',
    );
    expect(lastSegment('documents')).toBe('documents');
  });

  it('requires an item id after the resource collection', () => {
    expect(parseItemIdFromResource('/items/MLB123')).toBe('MLB123');
    expect(parseItemIdFromResource('/items')).toBeNull();
    expect(parseItemIdFromResource('')).toBeNull();
  });
});

/**
 * `naoDocId` is the guard two write routes put between a request body and
 * `.doc()`. `.doc()` validates the resulting PATH, and it does so outside any
 * `try` those handlers own — so anything it rejects escapes as a 500 for what is
 * plainly a client error.
 *
 * The cases below are the ones measured against a real `firebase-admin`
 * Firestore, not guessed:
 *
 * ```
 * ''      → throws  "Path must be a non-empty string"
 * 'a/b'   → throws  "must point to a document … not an even number of components"
 * 'a/b/c' → NO throw: resolves to produtos/<id>/produtoMercadoLivre/a/b/c
 * ```
 */
describe('naoDocId', () => {
  it('accepts the shapes a real link doc id takes', () => {
    // Firestore auto-ids, and the deterministic first-draft id (the integração
    // doc id) that `listingDraft.ts` mints in apps/web.
    for (const id of ['ML-DOC-1', 'aBc123XyZ', 'conta-1', 'e2e-123-w1-mlpub-001']) {
      expect(naoDocId(id), id).toBe(false);
    }
  });

  it('rejects a value that is not a string', () => {
    // The case a `!value` guard misses: truthy, so it sails past, and then it
    // throws deep inside Firestore instead.
    for (const v of [1, true, ['a'], { $ne: null }, null, undefined]) {
      expect(naoDocId(v), JSON.stringify(v) ?? String(v)).toBe(true);
    }
  });

  it('rejects the empty string, which can never name a document', () => {
    expect(naoDocId('')).toBe(true);
  });

  it('rejects a separator-bearing id — BOTH the throwing and the silent shape', () => {
    // ⚠️ The second one is why this tests for `/` rather than "does `.doc()`
    // throw". An odd number of extra segments builds a perfectly valid path to a
    // document two levels below the collection we meant: no error, and a 404
    // that tells the caller nothing about what they actually did wrong.
    for (const id of ['a/b', 'a/b/c', '/leading', 'trailing/', 'p/../outro']) {
      expect(naoDocId(id), id).toBe(true);
    }
  });
});
