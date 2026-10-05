import { describe, expect, it } from 'vitest';
import { expandColumnFilter } from '../schema/types';
import { encodeFilterValue, parseFiltersFromParams } from './useTableUrlState';
import { describeFilter } from './describeFilter';
import { applyColumnFilters } from './filterRows';
import type { FilterableField } from '../schema/types';

/**
 * The `isNull` op is UI-only: it never reaches `buildPipeline`, and it is the
 * only op that carries NO operand. Both make it exactly the kind of addition
 * that half-lands — the filter applies, the URL writes, and the link reopens
 * meaning something else because one layer never learned the op.
 *
 * These pin every layer it has to cross, and — for the URL — they pin the
 * NEAR-MISS too: the string `'null'` is what the naive encoding produces, and it
 * must stay a different filter from the null one, or the distinction the op
 * exists for is gone.
 */
const cliente: FilterableField = {
  key: 'clientePedidoOuterRef',
  kind: 'string',
  label: 'Cliente',
};
const criacao: FilterableField = {
  key: 'criacao',
  kind: 'datetime',
  label: 'Criação',
  dateUnit: 'us',
};
const ativo: FilterableField = { key: 'ativo', kind: 'boolean', label: 'Ativo' };

describe('isNull — query expansion', () => {
  it('expands to a single eq against null', () => {
    // Firestore answers `equal(field, null)` from the index like any other
    // equality — live in `produto.paiId` and `aviso.resolvidoEm` — so no new
    // index is owed beyond the one the column filter already needs.
    expect(expandColumnFilter('clientePedidoOuterRef', { op: 'isNull', value: null })).toEqual([
      { field: 'clientePedidoOuterRef', op: 'eq', value: null },
    ]);
  });

  it('leaves every other op exactly as it was', () => {
    expect(
      expandColumnFilter('clientePedidoOuterRef', {
        op: 'eq',
        value: 'documents/clientes/abc',
      }),
    ).toEqual([{ field: 'clientePedidoOuterRef', op: 'eq', value: 'documents/clientes/abc' }]);
  });
});

describe('isNull — URL round trip', () => {
  const roundTrip = (v: Parameters<typeof encodeFilterValue>[0], field: FilterableField) => {
    const params = new URLSearchParams();
    params.set(field.key, `${v.op}:${encodeFilterValue(v)}`);
    return parseFiltersFromParams(params, [field])[field.key];
  };
  const decode = (field: FilterableField, raw: string) =>
    parseFiltersFromParams(new URLSearchParams(`${field.key}=${raw}`), [field])[field.key];

  it('survives encode → decode', () => {
    // The bug this rules out: an op absent from FILTER_OPS writes to the URL and
    // is dropped on hydration, so a reload or a shared link silently reopens
    // UNFILTERED — every pedido back on screen with nothing saying why.
    expect(roundTrip({ op: 'isNull', value: null }, cliente)).toEqual({
      op: 'isNull',
      value: null,
    });
  });

  it('stays DISTINCT from a filter on the literal string "null"', () => {
    // ⚠️ The near-miss, and the whole reason this op exists. `String(null)` is
    // the four characters `null`, which is what an `{op:'eq', value:null}`
    // encoding would have written; decoding it back by the field's `kind` yields
    // a STRING filter that matches nothing and looks active. The two must never
    // fold together.
    expect(decode(cliente, 'eq:null')).toEqual({ op: 'eq', value: 'null' });
    expect(decode(cliente, 'isNull:')).toEqual({ op: 'isNull', value: null });
    expect(decode(cliente, 'eq:null')).not.toEqual(decode(cliente, 'isNull:'));
  });

  it('is decoded by the OP, never coerced by the field kind', () => {
    // ⚠️ `Number('')` is 0, not NaN, so an empty payload falling through the
    // numeric ladder survives the `Number.isNaN` guard and becomes a silent
    // `eq 0` — a datetime filter on the epoch. And a boolean column would fold
    // it to `false`.
    expect(decode(criacao, 'isNull:')).toEqual({ op: 'isNull', value: null });
    expect(decode(ativo, 'isNull:')).toEqual({ op: 'isNull', value: null });
  });

  it('drops the filter when the trailing colon is missing', () => {
    // The colon is load-bearing: `parseFiltersFromParams` bails on `sep < 0`.
    // Anyone "simplifying" `encodeFilterValue` to emit a bare `isNull` fails
    // here rather than in production.
    expect(decode(cliente, 'isNull')).toBeUndefined();
  });

  it('does not throw on a hand-mangled link', () => {
    // Runs from a useState initializer, so a throw here takes down the whole
    // TableView subtree during render.
    const params = new URLSearchParams('clientePedidoOuterRef=isNull:garbage');
    expect(() => parseFiltersFromParams(params, [cliente])).not.toThrow();
    // A payload on an op that carries none is ignored, not honoured.
    expect(parseFiltersFromParams(params, [cliente]).clientePedidoOuterRef).toEqual({
      op: 'isNull',
      value: null,
    });
  });
});

describe('isNull — chip and client-side mirror', () => {
  it('reads as an empty-value phrase, not as null / Não / a raw value', () => {
    // Three wrong answers the branches below it would each give confidently:
    // `Cliente: null` (the String fallthrough), `Cliente: Não` (the boolean
    // branch, since `null !== true`), and the enum branch's raw key.
    expect(describeFilter('Cliente', { op: 'isNull', value: null }, cliente)).toBe(
      'Cliente: (vazio)',
    );
    expect(describeFilter('Ativo', { op: 'isNull', value: null }, ativo)).toBe('Ativo: (vazio)');
  });

  it('lets a column name the empty state in its own vocabulary', () => {
    // What /pedidos does: the Cliente column's cell renders "Anônimo" for a null
    // ref, so its chip has to say the same word.
    expect(
      describeFilter('Cliente', { op: 'isNull', value: null }, cliente, {
        formatValue: (v) => (v === null ? 'Anônimo' : String(v)),
      }),
    ).toBe('Cliente: Anônimo');
  });

  it('keeps only the rows whose field is null, and no near-misses', () => {
    // ⚠️ The near-miss half: `''`, `0` and the string `'null'` are all falsy or
    // null-looking and must NOT match. An absent field does — knowingly, and
    // only on this transport; see the case below.
    const rows: Array<{ id: string; path: string; data: { ref: string | number | null } }> = [
      { id: '1', path: 'p/1', data: { ref: 'documents/clientes/a' } },
      { id: '2', path: 'p/2', data: { ref: null } },
      { id: '3', path: 'p/3', data: { ref: '' } },
      { id: '4', path: 'p/4', data: { ref: 'null' } },
      { id: '5', path: 'p/5', data: { ref: 0 } },
    ];
    const kept = applyColumnFilters(rows, { ref: { op: 'isNull', value: null } });
    expect(kept.map((r) => r.id)).toEqual(['2']);
  });

  it('also matches an ABSENT field — a knowing divergence from the server', () => {
    // Inherited from the `eq null` case it expands to, so the two agree with
    // each other. Firestore's `equal(f, null)` does NOT match a missing field
    // (no index entry), so this path is slightly wider than the Pipelines one.
    // It is reachable only on the classic / `queryOverride` transports, where
    // the whole page window is already in memory. Recorded here rather than
    // inherited silently.
    const rows: Array<{ id: string; path: string; data: { ref?: string | null } }> = [
      { id: '1', path: 'p/1', data: {} },
      { id: '2', path: 'p/2', data: { ref: 'documents/clientes/a' } },
    ];
    const kept = applyColumnFilters(rows, { ref: { op: 'isNull', value: null } });
    expect(kept.map((r) => r.id)).toEqual(['1']);
  });
});
