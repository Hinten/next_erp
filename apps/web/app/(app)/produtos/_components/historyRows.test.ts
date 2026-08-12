import { describe, expect, it } from 'vitest';
import { TRUNCATED_VALUE_KEY } from '@delfrance/core';
import { buildCustoHistoryRows, buildPrecoHistoryRows, type HistoryEntryRow } from './historyRows';

function entry(overrides: Partial<HistoryEntryRow> = {}): HistoryEntryRow {
  return {
    id: 'evt1',
    change: { old: null, new: null },
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

describe('buildPrecoHistoryRows', () => {
  it('produces one row for a lista whose value changed', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          change: {
            old: { l1: { valor: 10 }, l2: { valor: 20 } },
            new: { l1: { valor: 15 }, l2: { valor: 20 } },
          },
        }),
      ],
      'l1',
    );
    expect(rows).toEqual([
      {
        key: 'evt1:l1',
        timestamp: 1_700_000_000_000,
        original: { value: 10, truncated: false },
        final: { value: 15, truncated: false },
      },
    ]);
  });

  it('produces no row for a lista untouched by the entry', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          change: {
            old: { l1: { valor: 10 }, l2: { valor: 20 } },
            new: { l1: { valor: 15 }, l2: { valor: 20 } },
          },
        }),
      ],
      'l2',
    );
    expect(rows).toEqual([]);
  });

  it('an added lista (absent from old) renders original=null', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          change: {
            old: { l1: { valor: 10 } },
            new: { l1: { valor: 10 }, l2: { valor: 30 } },
          },
        }),
      ],
      'l2',
    );
    expect(rows).toEqual([
      {
        key: 'evt1:l2',
        timestamp: 1_700_000_000_000,
        original: { value: null, truncated: false },
        final: { value: 30, truncated: false },
      },
    ]);
  });

  it('a removed lista (absent from new) renders final=null', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          change: {
            old: { l1: { valor: 10 }, l2: { valor: 30 } },
            new: { l1: { valor: 10 } },
          },
        }),
      ],
      'l2',
    );
    expect(rows).toEqual([
      {
        key: 'evt1:l2',
        timestamp: 1_700_000_000_000,
        original: { value: 30, truncated: false },
        final: { value: null, truncated: false },
      },
    ]);
  });

  it('skips an entry whose change is undefined (field not projected)', () => {
    const rows = buildPrecoHistoryRows([entry({ change: undefined })], 'l1');
    expect(rows).toEqual([]);
  });

  it('tolerates a null timestamp', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          timestamp: null,
          change: { old: { l1: { valor: 1 } }, new: { l1: { valor: 2 } } },
        }),
      ],
      'l1',
    );
    expect(rows[0]?.timestamp).toBeNull();
  });

  it('a whole-map truncation sentinel renders that side as truncated, not silently dropped', () => {
    const rows = buildPrecoHistoryRows(
      [
        entry({
          change: {
            old: { [TRUNCATED_VALUE_KEY]: true, _bytes: 50_000 },
            new: { l1: { valor: 42 } },
          },
        }),
      ],
      'l1',
    );
    expect(rows).toEqual([
      {
        key: 'evt1',
        timestamp: 1_700_000_000_000,
        original: { value: null, truncated: true },
        final: { value: 42, truncated: false },
      },
    ]);
  });
});

describe('buildCustoHistoryRows', () => {
  it('produces one old -> new row per entry', () => {
    const rows = buildCustoHistoryRows([entry({ change: { old: 50, new: 60 } })]);
    expect(rows).toEqual([
      {
        key: 'evt1',
        timestamp: 1_700_000_000_000,
        original: { value: 50, truncated: false },
        final: { value: 60, truncated: false },
      },
    ]);
  });

  it('a create entry has no previous cost', () => {
    const rows = buildCustoHistoryRows([entry({ change: { old: null, new: 60 } })]);
    expect(rows).toEqual([
      {
        key: 'evt1',
        timestamp: 1_700_000_000_000,
        original: { value: null, truncated: false },
        final: { value: 60, truncated: false },
      },
    ]);
  });

  it('marks a truncated side without inventing a fake value', () => {
    const rows = buildCustoHistoryRows([
      entry({ change: { old: { [TRUNCATED_VALUE_KEY]: true, _bytes: 41_000 }, new: 60 } }),
    ]);
    expect(rows).toEqual([
      {
        key: 'evt1',
        timestamp: 1_700_000_000_000,
        original: { value: null, truncated: true },
        final: { value: 60, truncated: false },
      },
    ]);
  });

  it('skips an entry whose change is undefined', () => {
    const rows = buildCustoHistoryRows([entry({ change: undefined })]);
    expect(rows).toEqual([]);
  });

  it('tolerates a null timestamp', () => {
    const rows = buildCustoHistoryRows([entry({ timestamp: null, change: { old: 1, new: 2 } })]);
    expect(rows[0]?.timestamp).toBeNull();
  });
});
