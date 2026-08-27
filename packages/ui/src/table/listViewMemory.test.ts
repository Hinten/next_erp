import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearListViewMemory,
  listViewMemoryKey,
  readListViewMemory,
  writeListViewMemory,
} from './listViewMemory';

const KEY = listViewMemoryKey('/produtos', 'produtos');

afterEach(() => {
  sessionStorage.clear();
  vi.restoreAllMocks();
});

describe('listViewMemoryKey', () => {
  it('separates two screens sharing one collection', () => {
    // /canais/whatsapp and /canais/mercado-livre are different screens over the
    // same `integracao` collection — a collection-only key would merge them.
    expect(listViewMemoryKey('/canais/whatsapp', 'integracao')).not.toBe(
      listViewMemoryKey('/canais/mercado-livre', 'integracao'),
    );
  });

  it('separates two tables sharing one pathname', () => {
    // /clientes/<id> hosts the cliente editor AND an embedded endereços table.
    expect(listViewMemoryKey('/clientes/abc', 'clientes')).not.toBe(
      listViewMemoryKey('/clientes/abc', 'clientes/abc/enderecos'),
    );
  });
});

describe('readListViewMemory', () => {
  it('round-trips what was written', () => {
    writeListViewMemory(KEY, { qs: 'nome=contains%3Aab&sort=nome%3Aasc', pages: 3, scroll: 840 });
    expect(readListViewMemory(KEY)).toEqual({
      qs: 'nome=contains%3Aab&sort=nome%3Aasc',
      pages: 3,
      scroll: 840,
    });
  });

  it('answers null when nothing was ever stored', () => {
    expect(readListViewMemory(KEY)).toBeNull();
  });

  it('keeps an empty query string, which is how "the operator cleared everything" is stored', () => {
    // Distinct from "no memory": an empty qs must still suppress a stale
    // restore, otherwise clearing the filters would be undone on the next open.
    writeListViewMemory(KEY, { qs: '', pages: 1, scroll: 0 });
    expect(readListViewMemory(KEY)).toEqual({ qs: '', pages: 1, scroll: 0 });
  });

  it('rejects a truncated entry instead of throwing', () => {
    sessionStorage.setItem(KEY, '{"qs":"nome=contains');
    expect(readListViewMemory(KEY)).toBeNull();
  });

  it('rejects a partially-valid entry whole', () => {
    // Restoring the filters but not the page count would put the operator
    // somewhere they were never at — reject rather than half-apply.
    sessionStorage.setItem(KEY, JSON.stringify({ qs: 'nome=contains%3Aab', scroll: 10 }));
    expect(readListViewMemory(KEY)).toBeNull();
  });

  it.each([
    ['a non-object', '"just a string"'],
    ['null', 'null'],
    ['a non-string qs', JSON.stringify({ qs: 7, pages: 1, scroll: 0 })],
    ['a negative scroll', JSON.stringify({ qs: '', pages: 1, scroll: -5 })],
    ['a NaN page count', JSON.stringify({ qs: '', pages: Number.NaN, scroll: 0 })],
    ['a zero page count', JSON.stringify({ qs: '', pages: 0, scroll: 0 })],
  ])('rejects %s', (_label, raw) => {
    sessionStorage.setItem(KEY, raw);
    expect(readListViewMemory(KEY)).toBeNull();
  });

  it('answers null when sessionStorage itself throws', () => {
    // Private mode / disabled storage. This runs inside a render path, so it
    // must degrade rather than take the TableView subtree down.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(readListViewMemory(KEY)).toBeNull();
  });

  it('rethrows a non-DOMException from storage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new TypeError('something else entirely');
    });
    expect(() => readListViewMemory(KEY)).toThrow(TypeError);
  });
});

describe('writeListViewMemory', () => {
  it('swallows a quota / private-mode failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => writeListViewMemory(KEY, { qs: '', pages: 1, scroll: 0 })).not.toThrow();
  });

  it('rethrows a non-DOMException', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new TypeError('something else entirely');
    });
    expect(() => writeListViewMemory(KEY, { qs: '', pages: 1, scroll: 0 })).toThrow(TypeError);
  });
});

describe('clearListViewMemory', () => {
  it('removes the entry', () => {
    writeListViewMemory(KEY, { qs: 'nome=contains%3Aab', pages: 2, scroll: 5 });
    clearListViewMemory(KEY);
    expect(readListViewMemory(KEY)).toBeNull();
  });
});
