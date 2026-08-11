import { describe, expect, it, vi } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';

import type { ActionConfig } from '../schema/types';
import { actionDisabledReason, isActionDisabled, resolveActionRows } from './resolveActionRows';

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

  it('disables a maxSelection action once the selection exceeds the cap', () => {
    const capped = action({ requiresSelection: true, maxSelection: 1 });
    expect(isActionDisabled(capped, [r('a')])).toBe(false);
    expect(isActionDisabled(capped, [r('a'), r('b')])).toBe(true);
  });

  it('applies the cap even without requiresSelection', () => {
    // The cap is about what the action ACCEPTS, so it holds independently of
    // whether the action also demands a selection.
    expect(isActionDisabled(action({ maxSelection: 1 }), [r('a'), r('b')])).toBe(true);
  });

  it('ignores the cap when it is not exceeded', () => {
    expect(isActionDisabled(action({ maxSelection: 2 }), [r('a'), r('b')])).toBe(false);
  });
});

describe('actionDisabledReason', () => {
  it('explains an empty selection', () => {
    expect(actionDisabledReason(action({ requiresSelection: true }), [])).toBe(
      'Selecione ao menos 1 registro',
    );
  });

  it('explains a cap of 1 in the singular', () => {
    expect(actionDisabledReason(action({ maxSelection: 1 }), [r('a'), r('b')])).toBe(
      'Selecione apenas 1 registro',
    );
  });

  it('explains a cap above 1 with the number', () => {
    expect(actionDisabledReason(action({ maxSelection: 2 }), [r('a'), r('b'), r('c')])).toBe(
      'Selecione no máximo 2 registros',
    );
  });

  it('reports the cap ahead of the empty-selection reason', () => {
    // Both could be "wrong" only in contrived configs, but the cap is the one
    // the operator can see they violated — pin the precedence.
    expect(
      actionDisabledReason(action({ requiresSelection: true, maxSelection: 1 }), [r('a'), r('b')]),
    ).toBe('Selecione apenas 1 registro');
  });

  it('returns null when the action is available', () => {
    expect(
      actionDisabledReason(action({ requiresSelection: true, maxSelection: 1 }), [r('a')]),
    ).toBe(null);
  });
});
