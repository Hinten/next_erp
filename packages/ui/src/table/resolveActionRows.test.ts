import { describe, expect, it, vi } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';

import type { ActionConfig } from '../schema/types';
import { isActionDisabled, resolveActionRows } from './resolveActionRows';

type Row = { name: string };
const r = (id: string): SnapshotRow<Row> => ({ id, path: `x/${id}`, data: { name: id } });

function action(partial: Partial<ActionConfig<Row>> = {}): ActionConfig<Row> {
  return { id: 'a', label: 'A', run: vi.fn(), ...partial };
}

describe('resolveActionRows', () => {
  it('prefers the selection when non-empty', () => {
    const selected = [r('s1'), r('s2')];
    const visible = [r('v1')];
    expect(
      resolveActionRows(action({ fallbackToSingleVisibleRow: true }), selected, visible).map(
        (x) => x.id,
      ),
    ).toEqual(['s1', 's2']);
  });

  it('falls back to the single visible row when flagged and nothing selected', () => {
    expect(
      resolveActionRows(action({ fallbackToSingleVisibleRow: true }), [], [r('only')]).map(
        (x) => x.id,
      ),
    ).toEqual(['only']);
  });

  it('does not fall back when more than one row is visible', () => {
    expect(
      resolveActionRows(action({ fallbackToSingleVisibleRow: true }), [], [r('a'), r('b')]),
    ).toEqual([]);
  });

  it('does not fall back when the flag is off', () => {
    expect(resolveActionRows(action(), [], [r('only')])).toEqual([]);
  });
});

describe('isActionDisabled', () => {
  it('enables a requiresSelection action via single-row fallback', () => {
    expect(
      isActionDisabled(
        action({ requiresSelection: true, fallbackToSingleVisibleRow: true }),
        [],
        [r('only')],
      ),
    ).toBe(false);
  });

  it('keeps requiresSelection disabled with multiple visible rows and no selection', () => {
    expect(
      isActionDisabled(
        action({ requiresSelection: true, fallbackToSingleVisibleRow: true }),
        [],
        [r('a'), r('b')],
      ),
    ).toBe(true);
  });
});
