import { describe, expect, it } from 'vitest';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';
import { actionDisabledReason, partitionActionRows, resolveActionRows } from './resolveActionRows';

type Row = { estado?: string };
const row = (id: string, estado?: string): SnapshotRow<Row> => ({
  id,
  path: `pedidos/${id}`,
  data: { estado },
});

/** Refuses anything cancelled, naming the row — the shape a real action uses. */
const guarded = (over: Partial<ActionConfig<Row>> = {}): ActionConfig<Row> => ({
  id: 'a',
  label: 'Emitir',
  requiresSelection: true,
  rowIneligibleReason: (r) => (r.data.estado === 'cancelado' ? `${r.id}: cancelado` : null),
  rowEligibilityFields: ['estado'],
  run: () => {},
  ...over,
});

describe('per-row action eligibility', () => {
  it('drops refused rows from what `run` receives, and names them', () => {
    const { eligible, refused } = partitionActionRows(guarded(), [
      row('1'),
      row('2', 'cancelado'),
      row('3'),
    ]);
    expect(eligible.map((r) => r.id)).toEqual(['1', '3']);
    expect(refused).toEqual([
      { row: expect.objectContaining({ id: '2' }), reason: '2: cancelado' },
    ]);
  });

  it('leaves an action without a predicate exactly as it was', () => {
    const plain: ActionConfig<Row> = { id: 'a', label: 'X', run: () => {} };
    expect(resolveActionRows(plain, [row('1'), row('2', 'cancelado')]).map((r) => r.id)).toEqual([
      '1',
      '2',
    ]);
  });

  it('checks maxSelection against the RAW selection, not the survivors', () => {
    // The trap: filtering first lets three selected rows — two refused — satisfy
    // a `maxSelection: 1` action that should have declined the SELECTION. The
    // operator asked for three; refusing two does not make that a single-row
    // request.
    const action = guarded({ maxSelection: 1 });
    const selected = [row('1'), row('2', 'cancelado'), row('3', 'cancelado')];
    expect(actionDisabledReason(action, selected)).toBe('Selecione apenas 1 registro');
  });

  it('explains a fully-refused selection instead of asking for one', () => {
    // "Selecione ao menos 1 registro" would be FALSE here — they did select —
    // and would hide the only thing that explains the disabled button.
    expect(actionDisabledReason(guarded(), [row('9', 'cancelado')])).toBe('9: cancelado');
    expect(actionDisabledReason(guarded(), [row('9', 'cancelado'), row('8', 'cancelado')])).toBe(
      'Nenhum dos 2 registros selecionados aceita esta ação',
    );
  });

  it('still asks for a selection when there is genuinely none', () => {
    expect(actionDisabledReason(guarded(), [])).toBe('Selecione ao menos 1 registro');
  });

  it('lets a fallback-to-single-visible row be refused, resolving to nothing', () => {
    // This perk previously ALWAYS returned one row. Every `run` opens with a
    // length guard so it degrades correctly, but it is a real change in what
    // the perk promises and is worth pinning.
    const action = guarded({ fallbackToSingleVisibleRow: true });
    expect(resolveActionRows(action, [], [row('1', 'cancelado')])).toEqual([]);
    expect(resolveActionRows(action, [], [row('1')]).map((r) => r.id)).toEqual(['1']);
  });
});
