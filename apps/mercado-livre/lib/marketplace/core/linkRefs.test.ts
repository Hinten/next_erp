import { describe, expect, it } from 'vitest';

import { naoDocId } from './linkRefs';

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
