import { afterEach, describe, expect, it } from 'vitest';
import type { ColumnFilterValue, FilterableField } from '../schema/types';
import {
  MAX_PAGES,
  MAX_RESTORED_PAGES,
  encodeFilterValue,
  encodeTableState,
  parseFiltersFromParams,
  parsePagesFromParams,
  parseSortFromParams,
  resolveInitialTableState,
  sameTableState,
  urlCarriesTableState,
} from './useTableUrlState';
import { listViewMemoryKey, writeListViewMemory } from './listViewMemory';

function field(key: string, kind: FilterableField['kind']): FilterableField {
  return { key, kind, label: key };
}

const FIELDS: FilterableField[] = [
  field('nome', 'string'),
  field('preco', 'currency'),
  field('ativo', 'boolean'),
  field('estado', 'enum'),
  field('timestamp', 'datetime'),
  field('nf', 'string'), // synthetic virtual-column (subcollection-lookup) field
  // Synthetic virtual-column field backing an ARRAY document field: its `kind`
  // describes the array, never its elements, which is why the list ops decode
  // by op rather than by kind.
  field('canais', 'string'),
];

function parse(qs: string) {
  return parseFiltersFromParams(new URLSearchParams(qs), FIELDS);
}

describe('parseFiltersFromParams', () => {
  it('coerces datetime bounds to numbers (micros/millis)', () => {
    expect(parse('timestamp=gte:1700000000000000')).toEqual({
      timestamp: { op: 'gte', value: 1700000000000000 },
    });
  });

  it('coerces numeric/currency filters to numbers', () => {
    expect(parse('preco=lte:150')).toEqual({ preco: { op: 'lte', value: 150 } });
  });

  it('keeps string/enum filters as strings', () => {
    expect(parse('nome=contains:ana&estado=eq:pago')).toEqual({
      nome: { op: 'contains', value: 'ana' },
      estado: { op: 'eq', value: 'pago' },
    });
  });

  it('parses booleans', () => {
    expect(parse('ativo=eq:true')).toEqual({ ativo: { op: 'eq', value: true } });
  });

  it('preserves a subfield-encoded subcollection-lookup value verbatim', () => {
    // The NF filter encodes `"<subfield>:<term>"`; the leading op is split off,
    // the rest (which itself contains a colon) stays intact as the value.
    expect(parse('nf=eq:numeracao:1234')).toEqual({
      nf: { op: 'eq', value: 'numeracao:1234' },
    });
  });

  it('decodes an array-contains-any candidate list', () => {
    expect(parse('canais=array-contains-any:abc,def')).toEqual({
      canais: { op: 'array-contains-any', value: ['abc', 'def'] },
    });
  });

  it('decodes a single-value array-contains', () => {
    expect(parse('canais=array-contains:abc')).toEqual({
      canais: { op: 'array-contains', value: 'abc' },
    });
  });

  it('drops a candidate list with a malformed percent escape instead of throwing', () => {
    // `URLSearchParams.get()` leaves a stray `%` verbatim, so it reaches
    // `decodeURIComponent`, which throws `URIError`. This function runs from a
    // `useState` initializer, so a throw here takes down the whole TableView
    // subtree during render — every other unparseable input drops its filter.
    expect(() => parse('canais=array-contains-any:abc%,def')).not.toThrow();
    expect(parse('canais=array-contains-any:abc%,def')).toEqual({});
  });

  it('drops an array-contains-any with an empty list', () => {
    // An empty candidate list means "no rows" — not a filter worth restoring
    // from a URL, and `buildPipeline` throws on it.
    expect(parse('canais=array-contains-any:')).toEqual({});
  });

  it('skips params without a known field or with a bad op', () => {
    expect(parse('desconhecido=eq:x&preco=bogus:1')).toEqual({});
  });

  it('drops a datetime value that is not a number', () => {
    expect(parse('timestamp=gte:notanumber')).toEqual({});
  });
});

describe('encodeFilterValue ⇄ parseFiltersFromParams round trip', () => {
  function roundTrip(field: string, v: ColumnFilterValue) {
    const params = new URLSearchParams();
    params.set(field, `${v.op}:${encodeFilterValue(v)}`);
    return parseFiltersFromParams(params, FIELDS)[field];
  }

  it('restores a candidate list unchanged', () => {
    const v: ColumnFilterValue = { op: 'array-contains-any', value: ['abc', 'def', 'ghi'] };
    expect(roundTrip('canais', v)).toEqual(v);
  });

  it('restores a candidate containing the list separator', () => {
    // The join would otherwise split `a,b` into two candidates and silently
    // widen the filter — hence the per-element percent-encoding.
    const v: ColumnFilterValue = { op: 'array-contains-any', value: ['a,b', 'c'] };
    expect(roundTrip('canais', v)).toEqual(v);
  });

  it('leaves scalar values untouched', () => {
    expect(roundTrip('preco', { op: 'lte', value: 150 })).toEqual({ op: 'lte', value: 150 });
    expect(roundTrip('ativo', { op: 'eq', value: true })).toEqual({ op: 'eq', value: true });
    expect(roundTrip('nome', { op: 'contains', value: 'ana' })).toEqual({
      op: 'contains',
      value: 'ana',
    });
  });
});

describe('parseSortFromParams', () => {
  it('parses a nested sort field + direction', () => {
    expect(
      parseSortFromParams(new URLSearchParams('sort=freteInicial.prazoDespacho:desc')),
    ).toEqual({ field: 'freteInicial.prazoDespacho', direction: 'desc' });
  });

  it('rejects a malformed direction', () => {
    expect(parseSortFromParams(new URLSearchParams('sort=numero:sideways'))).toBeUndefined();
  });
});

describe('reserved params', () => {
  it('never reads ?sort=, ?q= or ?pages= as a column filter', () => {
    // A schema field literally named `sort`, `q` or `pages` is shadowed by the
    // params this hook owns. Checked BEFORE the descriptor lookup, so adding a
    // descriptor for any of them cannot resurrect it as a filter.
    const shadowed = [field('sort', 'string'), field('q', 'string'), field('pages', 'string')];
    expect(
      parseFiltersFromParams(new URLSearchParams('sort=nome:asc&q=abc&pages=3'), shadowed),
    ).toEqual({});
  });
});

describe('parsePagesFromParams', () => {
  const pages = (qs: string, max = MAX_PAGES) => parsePagesFromParams(new URLSearchParams(qs), max);

  it('reads a whole page count', () => {
    expect(pages('pages=4')).toBe(4);
  });

  it('defaults to one page when the param is absent', () => {
    expect(pages('nome=contains%3Aab')).toBe(1);
  });

  it('clamps to the ceiling it was given', () => {
    // The value becomes a query LIMIT on a database that bills data scanned,
    // and anyone can type it into the address bar.
    expect(pages('pages=999')).toBe(MAX_PAGES);
    expect(pages('pages=999', MAX_RESTORED_PAGES)).toBe(MAX_RESTORED_PAGES);
  });

  it.each([
    ['a word', 'pages=abc'],
    ['zero', 'pages=0'],
    ['a negative count', 'pages=-3'],
    ['a fraction', 'pages=2.5'],
    ['a number with a suffix', 'pages=2abc'],
    ['an empty value', 'pages='],
  ])('degrades %s to one page', (_label, qs) => {
    expect(pages(qs)).toBe(1);
  });
});

describe('encodeTableState', () => {
  it('serialises filters, sort and the search term together', () => {
    expect(
      encodeTableState(
        { nome: { op: 'contains', value: 'ab' } },
        { field: 'nome', direction: 'desc' },
        'camiseta',
      ),
    ).toBe('nome=contains%3Aab&sort=nome%3Adesc&q=camiseta');
  });

  it('omits an empty search term rather than writing ?q=', () => {
    // `?q=` present-but-empty would look like state to `urlCarriesTableState`
    // and suppress the sticky restore forever.
    expect(encodeTableState({}, undefined, '')).toBe('');
  });

  it('omits a single page, so a link that was shareable before stays identical', () => {
    expect(encodeTableState({}, undefined, '')).toBe('');
    expect(encodeTableState({}, undefined, '', 1)).toBe('');
  });

  it('writes the window once it has been grown, and reads back exactly', () => {
    const qs = encodeTableState({}, { field: 'nome', direction: 'asc' }, '', 3);
    expect(qs).toBe('sort=nome%3Aasc&pages=3');
    expect(parsePagesFromParams(new URLSearchParams(qs), MAX_PAGES)).toBe(3);
  });

  it('round-trips through the parsers', () => {
    const filters: Record<string, ColumnFilterValue> = {
      nome: { op: 'contains', value: 'ab' },
      preco: { op: 'gte', value: 10.5 },
      ativo: { op: 'eq', value: true },
      canais: { op: 'array-contains-any', value: ['a,b', 'c'] },
    };
    const sort = { field: 'preco', direction: 'asc' } as const;
    const qs = encodeTableState(filters, sort, 'camiseta');
    const params = new URLSearchParams(qs);
    expect(parseFiltersFromParams(params, FIELDS)).toEqual(filters);
    expect(parseSortFromParams(params)).toEqual(sort);
    expect(params.get('q')).toBe('camiseta');
  });
});

describe('urlCarriesTableState', () => {
  it('is false for a bare URL, which is what lets the memory apply', () => {
    expect(urlCarriesTableState(new URLSearchParams(''), FIELDS, true)).toBe(false);
  });

  it('is false for foreign params alone', () => {
    // Arriving from "Copiar" carries ?copyFrom but says nothing about the list,
    // so the remembered filters should still be restored.
    expect(urlCarriesTableState(new URLSearchParams('copyFrom=abc'), FIELDS, true)).toBe(false);
  });

  it.each([
    ['a column filter', 'nome=contains%3Aab'],
    ['a sort', 'sort=nome%3Aasc'],
    ['a window', 'pages=3'],
  ])('is true for %s', (_label, qs) => {
    expect(urlCarriesTableState(new URLSearchParams(qs), FIELDS, true)).toBe(true);
  });

  it('counts ?q= only when the table owns the search box', () => {
    // The two screens that resolve their term asynchronously keep `q` for
    // themselves; a table that does not own it must not treat it as its state.
    expect(urlCarriesTableState(new URLSearchParams('q=abc'), FIELDS, true)).toBe(true);
    expect(urlCarriesTableState(new URLSearchParams('q=abc'), FIELDS, false)).toBe(false);
  });

  it('ignores an unparseable filter, matching what hydration would actually apply', () => {
    expect(urlCarriesTableState(new URLSearchParams('nome=bogusop%3Aab'), FIELDS, true)).toBe(
      false,
    );
  });
});

describe('sameTableState', () => {
  it('ignores param order, which is the only reason the scroll restore works', () => {
    // The sync effect merges its keys into whatever query string is already on
    // the page, so the URL routinely orders them differently from the string
    // the memory recorded. A byte comparison would answer "different view" for
    // two identical views and silently give back no scroll restore at all.
    expect(
      sameTableState('sort=nome%3Aasc&nome=contains%3Aab', 'nome=contains%3Aab&sort=nome%3Aasc'),
    ).toBe(true);
  });

  it.each([
    ['an extra param', 'nome=contains%3Aab&sort=nome%3Aasc', 'nome=contains%3Aab'],
    ['a different value', 'nome=contains%3Aab', 'nome=contains%3Acd'],
    ['a different window', 'pages=2', 'pages=3'],
    ['empty against filtered', '', 'nome=contains%3Aab'],
  ])('says %s is a different view', (_label, a, b) => {
    expect(sameTableState(a, b)).toBe(false);
  });
});

describe('resolveInitialTableState', () => {
  const MEMORY_KEY = listViewMemoryKey('/produtos', 'produtos');

  afterEach(() => sessionStorage.clear());

  function resolve(qs: string, memoryKey: string | null = MEMORY_KEY) {
    return resolveInitialTableState({
      searchParams: new URLSearchParams(qs),
      fields: FIELDS,
      initialSort: { field: 'nome', direction: 'asc' },
      ownsSearch: true,
      memoryKey,
    });
  }

  it('reopens the remembered view, window and offset, when the URL is bare', () => {
    writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana&pages=2', scroll: 840 });
    const state = resolve('');
    expect(state.filters).toEqual({ nome: { op: 'contains', value: 'ana' } });
    expect(state.pages).toBe(2);
    expect(state.restored).toEqual({ scroll: 840 });
  });

  it('caps a remembered window harder than a requested one', () => {
    // This tier applies without being asked, so a screen an operator once
    // clicked deep into must not stay expensive on every return to it.
    writeListViewMemory(MEMORY_KEY, { qs: 'pages=10', scroll: 0 });
    expect(resolve('').pages).toBe(MAX_RESTORED_PAGES);
  });

  it('gives the window back when the operator presses Back', () => {
    // The regression this exists for. The sync effect writes this table's own
    // state into the history entry for the list, so returning to it ALWAYS
    // carries table state — which used to be indistinguishable from a shared
    // link, so both the window and the offset were thrown away every time.
    writeListViewMemory(MEMORY_KEY, { qs: 'sort=nome%3Aasc&pages=4', scroll: 840 });
    const state = resolve('sort=nome%3Aasc&pages=4');
    expect(state.pages).toBe(4);
    expect(state.restored).toEqual({ scroll: 840 });
  });

  it('restores the offset even when the URL orders its params differently', () => {
    writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana&sort=nome%3Aasc', scroll: 640 });
    expect(resolve('sort=nome%3Aasc&nome=contains%3Aana').restored).toEqual({ scroll: 640 });
  });

  it('gives NO offset to a link that describes a different view', () => {
    // The near miss for the case above. A colleague's link, or a hand-edited
    // one, must not drop the reader 840px into a result set they never saw.
    writeListViewMemory(MEMORY_KEY, { qs: 'nome=contains%3Aana', scroll: 840 });
    const state = resolve('nome=contains%3Abob');
    expect(state.filters).toEqual({ nome: { op: 'contains', value: 'bob' } });
    expect(state.restored).toBeNull();
  });

  it('clamps a window that arrived in the URL', () => {
    expect(resolve('pages=999').pages).toBe(MAX_PAGES);
  });

  it('opens at one page and restores nothing without a memory key', () => {
    writeListViewMemory(MEMORY_KEY, { qs: 'pages=4', scroll: 840 });
    const state = resolve('', null);
    expect(state.pages).toBe(1);
    expect(state.restored).toBeNull();
  });
});
