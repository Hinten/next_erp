import { describe, expect, it } from 'vitest';
import type { Foto } from '@delfrance/schemas';
import { buildSortableIds } from './PhotoManager';

/** Minimal foto — `buildSortableIds` only reads `arquivoOuterRef` + `variantePath`. */
const foto = (arquivoOuterRef: string, variantePath: string | null = null) =>
  ({ arquivoOuterRef, variantePath }) as Foto;

describe('buildSortableIds (#139)', () => {
  it('disambiguates a duplicated arquivoOuterRef in the same gallery', () => {
    // Two cards, same ref AND same (null) variantePath — the legacy-data edge
    // that used to collide React keys + dnd ids.
    const ids = buildSortableIds([foto('arquivos/dup'), foto('arquivos/dup')]);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids).toEqual(['arquivos/dup|#0', 'arquivos/dup|#1']);
  });

  it('keeps the same arquivo distinct across galleries (parent vs variant)', () => {
    const [parent, variant] = buildSortableIds([
      foto('arquivos/x', null),
      foto('arquivos/x', 'documents/grupoDeVariacoes/g/variacoes/v'),
    ]);
    expect(parent).not.toBe(variant);
  });

  it('gives a unique foto a position-independent id (occurrence 0)', () => {
    // The id tracks identity, not array position: a unique (ref, gallery) pair
    // always gets occurrence 0, so reordering it past others does NOT change it.
    const before = buildSortableIds([foto('arquivos/a'), foto('arquivos/b'), foto('arquivos/c')]);
    const reordered = buildSortableIds([
      foto('arquivos/c'),
      foto('arquivos/a'),
      foto('arquivos/b'),
    ]);
    expect(before).toEqual(['arquivos/a|#0', 'arquivos/b|#0', 'arquivos/c|#0']);
    // 'arquivos/a' keeps '...|#0' regardless of where it sits in the array.
    expect(reordered[1]).toBe(before[0]);
  });

  it('still distinguishes genuinely different refs', () => {
    const ids = buildSortableIds([foto('arquivos/a'), foto('arquivos/b')]);
    expect(ids[0]).not.toBe(ids[1]);
  });
});
