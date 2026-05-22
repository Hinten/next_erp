import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import type { SnapshotRow } from '@delfrance/data/hooks';

import { ActionBar } from './ActionBar';
import type { ActionConfig } from '../schema/types';

function wrap(node: React.ReactNode) {
  // `env="test"` disables Mantine transitions / portals so the Menu.Dropdown
  // renders synchronously after the trigger click — assertions stay sync.
  return render(<MantineProvider env="test">{node}</MantineProvider>);
}

type Row = { name: string };
const ROW: SnapshotRow<Row> = { id: '1', path: 'x/1', data: { name: 'a' } };

function makeAction(id: string, run = vi.fn()): ActionConfig<Row> {
  return { id, label: `Ação ${id}`, run };
}

describe('ActionBar', () => {
  it('renders actions inline when count is at or below the threshold', () => {
    wrap(
      <ActionBar
        actions={[makeAction('1'), makeAction('2'), makeAction('3')]}
        selectedRows={[ROW]}
      />,
    );
    // All three actions are visible buttons, no overflow trigger.
    expect(screen.getByRole('button', { name: 'Ação 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ação 2' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ação 3' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mais ações' })).toBeNull();
  });

  it('collapses actions into a menu when the count exceeds the threshold', () => {
    wrap(
      <ActionBar
        actions={[
          makeAction('1'),
          makeAction('2'),
          makeAction('3'),
          makeAction('4'),
        ]}
        selectedRows={[ROW]}
      />,
    );
    // With 4 actions (default overflowThreshold=3) the bar should show an
    // overflow trigger, not 4 inline buttons.
    expect(screen.queryByRole('button', { name: 'Ação 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mais ações' })).toBeTruthy();
  });

  it('clicking a menu item runs the action', () => {
    const run = vi.fn();
    wrap(
      <ActionBar
        actions={[
          makeAction('1'),
          makeAction('2'),
          makeAction('3'),
          { ...makeAction('4', run) },
        ]}
        selectedRows={[ROW]}
      />,
    );
    // Open the overflow menu, then click "Ação 4".
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ação 4' }));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([ROW]);
  });

  it('respects an explicit `actionsLayout="menu"` even with few actions', () => {
    wrap(
      <ActionBar
        actions={[makeAction('1'), makeAction('2')]}
        selectedRows={[ROW]}
        actionsLayout="menu"
      />,
    );
    expect(screen.queryByRole('button', { name: 'Ação 1' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mais ações' })).toBeTruthy();
  });

  it('respects an explicit `actionsLayout="inline"` even past the threshold', () => {
    wrap(
      <ActionBar
        actions={[
          makeAction('1'),
          makeAction('2'),
          makeAction('3'),
          makeAction('4'),
          makeAction('5'),
        ]}
        selectedRows={[ROW]}
        actionsLayout="inline"
      />,
    );
    expect(screen.getByRole('button', { name: 'Ação 5' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mais ações' })).toBeNull();
  });

  it('disables menu items that require selection when nothing is selected', () => {
    wrap(
      <ActionBar
        actions={[
          makeAction('1'),
          makeAction('2'),
          makeAction('3'),
          {
            ...makeAction('4'),
            requiresSelection: true,
          },
        ]}
        selectedRows={[]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Mais ações' }));
    const item = screen.getByRole('menuitem', { name: 'Ação 4' });
    // Mantine renders disabled Menu.Item with `data-disabled` and removes
    // the click-through. Assert the attribute is set.
    expect(item.hasAttribute('data-disabled')).toBe(true);
  });
});
