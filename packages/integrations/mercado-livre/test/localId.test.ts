import { describe, expect, it } from 'vitest';

import { idLocalMercadoLivre } from '../src/mapping/localId';

/**
 * The legacy `generateLocalId` shape (`models.dart:1585-1587`).
 *
 * ⚠️ These assertions are about a **stored key**, not a format preference. The
 * migrated corpus is keyed on this string: a produto this app re-imports has to
 * land on the document the Flutter app wrote, not beside it. Change the output
 * and every legacy variation child forks into a second document, silently, on the
 * next import.
 */
describe('idLocalMercadoLivre', () => {
  it('is the legacy fixed-width form, byte for byte', () => {
    expect(idLocalMercadoLivre('ML-DOC-1', 'MLB777')).toBe('XMLB000000000000000ML-DOC-1vMLBMLB777');
  });

  it('carries EXACTLY fifteen zeros', () => {
    // Spelled out rather than counted from the output: an off-by-one here is
    // invisible on sight and forks every document keyed on the old value.
    expect(idLocalMercadoLivre('', '')).toBe(`XMLB${'0'.repeat(15)}vMLB`);
  });

  // ⚠️ Neither segment is trimmed, cased or validated. The value must be
  // byte-identical to whatever Flutter wrote, so "cleaning" an odd-looking id
  // would move this app off the corpus's own documents.
  it('does not normalise either segment', () => {
    expect(idLocalMercadoLivre(' a ', 'MlB1')).toBe('XMLB000000000000000 a vMLBMlB1');
  });

  // The separator is `vMLB`, and a segment ending in `v` must not be mistaken for
  // part of it — the parse direction does not exist here, but a future one would
  // read this test first.
  it('keeps the separator distinguishable from segment content', () => {
    expect(idLocalMercadoLivre('xv', 'y')).toBe('XMLB000000000000000xvvMLBy');
  });
});
