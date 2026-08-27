import { describe, expect, it } from 'vitest';
import type { Foto, Produto } from '@delfrance/schemas';

import {
  arquivoIdFromRef,
  coverArquivoId,
  coverArquivoIds,
  fotoArquivoIdCandidates,
} from './fotoRefs';

/** A foto as a MODERN upload writes it — every derivative ref optimistically filled. */
function fotoOtimista(): Foto {
  return {
    arquivoOuterRef: 'arquivos/prod1_hash',
    arquivo200pxOuterRef: 'arquivos/prod1_hash_200',
    arquivo400pxOuterRef: 'arquivos/prod1_hash_400',
    arquivoJpegOuterRef: 'arquivos/prod1_hash_jpeg',
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  } as unknown as Foto;
}

/** A LEGACY foto (`buildOriginalFotoRef`) — derivative refs are null. */
function fotoLegada(): Foto {
  return {
    arquivoOuterRef: 'arquivos/legado',
    arquivo200pxOuterRef: null,
    arquivo400pxOuterRef: null,
    arquivoJpegOuterRef: null,
    grupoDeVariacoesOuterRef: null,
    variantePath: null,
  } as unknown as Foto;
}

describe('arquivoIdFromRef', () => {
  it('strips the arquivos/ prefix', () => {
    expect(arquivoIdFromRef('arquivos/abc123')).toBe('abc123');
  });
  it('takes the last segment of the canonical documents/ outer-ref form', () => {
    expect(arquivoIdFromRef('documents/arquivos/abc123')).toBe('abc123');
  });
  it('accepts a bare id', () => {
    expect(arquivoIdFromRef('abc123')).toBe('abc123');
  });
  it('returns null for empty/absent', () => {
    expect(arquivoIdFromRef(null)).toBeNull();
    expect(arquivoIdFromRef(undefined)).toBeNull();
    expect(arquivoIdFromRef('')).toBeNull();
  });

  it('takes the last NON-EMPTY segment, so a bare prefix yields the prefix', () => {
    // Pinning existing behaviour, not endorsing it: `.filter(Boolean)` drops the
    // trailing empty segment, so `'arquivos/'` resolves to the id `'arquivos'`.
    // Degenerate input no upload path produces — worth recording so a future
    // change to this function is a deliberate one.
    expect(arquivoIdFromRef('arquivos/')).toBe('arquivos');
  });
});

describe('fotoArquivoIdCandidates', () => {
  it('returns every rung of the ladder, best first', () => {
    // ⚠️ THE point of this module. A `??` over the ref STRINGS would stop at
    // `arquivo200pxOuterRef` — which `buildFotoRefs` always fills, whether or
    // not `resizeProductImage` ever created the document it names. Callers need
    // the whole list so they can fall through on document EXISTENCE.
    expect(fotoArquivoIdCandidates(fotoOtimista())).toEqual([
      'prod1_hash_200',
      'prod1_hash_400',
      'prod1_hash',
    ]);
  });

  it('yields only the original for a legacy foto with null derivative refs', () => {
    expect(fotoArquivoIdCandidates(fotoLegada())).toEqual(['legado']);
  });

  it('honours a caller preference order', () => {
    expect(fotoArquivoIdCandidates(fotoOtimista(), ['400', '200', 'original'])).toEqual([
      'prod1_hash_400',
      'prod1_hash_200',
      'prod1_hash',
    ]);
  });

  it('exposes the jpeg variant only when asked for', () => {
    expect(fotoArquivoIdCandidates(fotoOtimista())).not.toContain('prod1_hash_jpeg');
    expect(fotoArquivoIdCandidates(fotoOtimista(), ['jpeg', 'original'])).toEqual([
      'prod1_hash_jpeg',
      'prod1_hash',
    ]);
  });

  it('dedupes ids that repeat across variants', () => {
    // A corpus foto whose derivative ref was (wrongly) pointed at the original
    // must not make the caller read the same document twice.
    const duplicada = {
      arquivoOuterRef: 'arquivos/mesmo',
      arquivo200pxOuterRef: 'arquivos/mesmo',
      arquivo400pxOuterRef: 'documents/arquivos/mesmo',
      arquivoJpegOuterRef: null,
    } as unknown as Foto;
    expect(fotoArquivoIdCandidates(duplicada)).toEqual(['mesmo']);
  });

  it('returns nothing for an absent foto', () => {
    expect(fotoArquivoIdCandidates(null)).toEqual([]);
    expect(fotoArquivoIdCandidates(undefined)).toEqual([]);
  });
});

describe('coverArquivoIds', () => {
  it('reads the FIRST foto of the produto', () => {
    const produto = { fotos: [fotoLegada(), fotoOtimista()] } as unknown as Produto;
    expect(coverArquivoIds(produto)).toEqual(['legado']);
  });
  it('returns nothing when the produto has no photo', () => {
    expect(coverArquivoIds({ fotos: null })).toEqual([]);
    expect(coverArquivoIds({ fotos: [] })).toEqual([]);
    expect(coverArquivoIds(null)).toEqual([]);
    expect(coverArquivoIds(undefined)).toEqual([]);
  });
});

describe('coverArquivoId', () => {
  it('is the first candidate — a "has a photo?" probe, not a read target', () => {
    const produto = { fotos: [fotoOtimista()] } as unknown as Produto;
    expect(coverArquivoId(produto)).toBe('prod1_hash_200');
  });
  it('is null exactly when there are no candidates', () => {
    expect(coverArquivoId({ fotos: null })).toBeNull();
    expect(coverArquivoId(null)).toBeNull();
  });
});
