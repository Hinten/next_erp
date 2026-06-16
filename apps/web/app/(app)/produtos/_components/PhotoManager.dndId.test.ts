import { describe, expect, it } from 'vitest';
import type { Foto } from '@delfrance/schemas';
import { sortableIdOf } from './PhotoManager';

/** Minimal foto — `sortableIdOf` only reads `arquivoOuterRef` + `variantePath`. */
const foto = (arquivoOuterRef: string, variantePath: string | null = null) =>
  ({ arquivoOuterRef, variantePath }) as Foto;

describe('sortableIdOf (#139)', () => {
  it('disambiguates a duplicated arquivoOuterRef in the same gallery by index', () => {
    // Two cards, same ref AND same (null) variantePath — the legacy-data edge
    // that used to collide React keys + dnd ids.
    const a = foto('documents/arquivos/dup');
    const b = foto('documents/arquivos/dup');
    expect(sortableIdOf(a, 0)).not.toBe(sortableIdOf(b, 1));
  });

  it('keeps the same arquivo distinct across galleries (parent vs variant)', () => {
    const parent = foto('documents/arquivos/x', null);
    const variant = foto('documents/arquivos/x', 'grupo|opt');
    expect(sortableIdOf(parent, 0)).not.toBe(sortableIdOf(variant, 0));
  });

  it('is stable for the same foto at the same index', () => {
    const f = foto('documents/arquivos/x', 'grupo|opt');
    expect(sortableIdOf(f, 2)).toBe(sortableIdOf(f, 2));
    expect(sortableIdOf(f, 2)).toBe('documents/arquivos/x|grupo|opt|2');
  });

  it('still distinguishes genuinely different refs', () => {
    expect(sortableIdOf(foto('documents/arquivos/a'), 0)).not.toBe(
      sortableIdOf(foto('documents/arquivos/b'), 0),
    );
  });
});
