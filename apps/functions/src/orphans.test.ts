import { describe, expect, it } from 'vitest';
import {
  isOlderThanGrace,
  objectPathOf,
  referencedArquivoIds,
  refId,
  shouldDeleteObject,
} from './orphans';

describe('refId', () => {
  it('returns the last path segment', () => {
    expect(refId('arquivos/p1_h')).toBe('p1_h');
    expect(refId('bare')).toBe('bare');
  });
});

describe('referencedArquivoIds', () => {
  it('collects ids from fotos/videos/anexos refs and the flat list', () => {
    const produto = {
      fotos: [
        { arquivoOuterRef: 'arquivos/a', arquivo200pxOuterRef: 'arquivos/a_200' },
        { arquivoOuterRef: 'arquivos/b' },
      ],
      videos: [{ arquivoOuterRef: 'arquivos/v' }],
      anexos: [{ arquivoOuterRef: 'arquivos/x' }],
      fotosArquivosIds: ['a', 'a_200', 'flatonly'],
    };
    expect([...referencedArquivoIds(produto)].sort()).toEqual(
      ['a', 'a_200', 'b', 'flatonly', 'v', 'x'].sort(),
    );
  });

  it('tolerates missing / malformed media arrays', () => {
    expect(referencedArquivoIds({}).size).toBe(0);
    expect(referencedArquivoIds({ fotos: 'nope', videos: null }).size).toBe(0);
  });
});

describe('objectPathOf', () => {
  it('joins filepath + filename, handling a null dir', () => {
    expect(objectPathOf({ filepath: 'produtos/p1/originals', filename: 'h.png' })).toBe(
      'produtos/p1/originals/h.png',
    );
    expect(objectPathOf({ filepath: null, filename: 'h.png' })).toBe('h.png');
    expect(objectPathOf({ filepath: 'x', filename: null })).toBeNull();
  });
});

describe('shouldDeleteObject', () => {
  it('deletes only when no other arquivo references the path', () => {
    expect(shouldDeleteObject(0)).toBe(true);
    expect(shouldDeleteObject(1)).toBe(false);
  });
});

describe('isOlderThanGrace', () => {
  const now = Date.parse('2026-06-08T12:00:00.000Z');
  const grace = 24 * 60 * 60 * 1000;

  it('is true only for timestamps older than the grace window', () => {
    expect(isOlderThanGrace('2026-06-06T12:00:00.000Z', now, grace)).toBe(true);
    expect(isOlderThanGrace('2026-06-08T11:00:00.000Z', now, grace)).toBe(false);
  });

  it('spares docs without a (valid) timestamp', () => {
    expect(isOlderThanGrace(null, now, grace)).toBe(false);
    expect(isOlderThanGrace(undefined, now, grace)).toBe(false);
    expect(isOlderThanGrace('not-a-date', now, grace)).toBe(false);
  });
});
