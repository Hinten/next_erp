'use client';

import { ActionIcon, Button, Group, Menu, Tooltip } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import Link from 'next/link';
import type { Route } from 'next';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';
import { isActionDisabled } from './resolveActionRows';
import { useActionRunner } from './useActionRunner';

/**
 * How the ActionBar lays out its bulk actions.
 *  - `inline`: every action renders as a `Button` in the toolbar.
 *  - `menu`:   actions collapse into a single overflow `Menu` triggered by
 *              an `IconDotsVertical` button. Useful when the page has many
 *              bulk actions (emit NF-e, cancel NF-e, mark paid, ...).
 *  - `auto`:   inline up to `overflowThreshold` actions, then menu.
 */
export type ActionsLayout = 'inline' | 'menu' | 'auto';

export interface ActionBarProps<T> {
  actions: Array<ActionConfig<T>>;
  /** Rows currently checked in the table. */
  selectedRows: SnapshotRow<T>[];
  /**
   * Rows currently shown in the table (filtered page). Powers
   * `ActionConfig.fallbackToSingleVisibleRow`.
   */
  visibleRows?: SnapshotRow<T>[];
  /** Render a "Novo" button at the start when set. */
  newHref?: string;
  /** Custom render for "Novo" (e.g. a Next Link). */
  renderNewButton?: () => React.ReactNode;
  /**
   * Create-page route for the "Copiar" button. When set, the bar renders a
   * `<Link>`-based copy button enabled only with exactly one selected row;
   * clicking it opens `${copyHref}?copyFrom=<id>`.
   */
  copyHref?: Route;
  /** Called after a `refreshOnComplete` action finishes (e.g. delete). */
  onActionComplete?: () => void;
  /** Layout strategy. Defaults to `'auto'`. */
  actionsLayout?: ActionsLayout;
  /**
   * Threshold for `'auto'` layout — once the action count exceeds this,
   * actions collapse into the overflow menu. Defaults to `3`.
   */
  overflowThreshold?: number;
}

/**
 * Toolbar above the table. Disables bulk actions when nothing is selected.
 * Confirmation flows are routed through `useActionRunner`'s shared Modal.
 * Many actions can collapse into an overflow `Menu` via `actionsLayout`.
 */
export function ActionBar<T>({
  actions,
  selectedRows,
  visibleRows = [],
  newHref,
  renderNewButton,
  copyHref,
  onActionComplete,
  actionsLayout = 'auto',
  overflowThreshold = 3,
}: ActionBarProps<T>) {
  const { trigger, confirmModal } = useActionRunner({
    selectedRows,
    visibleRows,
    onActionComplete,
  });

  const copyRow = selectedRows.length === 1 ? selectedRows[0] : null;

  // Resolve the effective layout: `'auto'` collapses once the action count
  // exceeds the threshold.
  const useMenu =
    actionsLayout === 'menu' || (actionsLayout === 'auto' && actions.length > overflowThreshold);

  return (
    <>
      <Group justify="flex-end" gap="xs">
        {renderNewButton ? (
          renderNewButton()
        ) : newHref ? (
          <Button component="a" href={newHref}>
            Novo
          </Button>
        ) : null}
        {copyHref &&
          (copyRow ? (
            <Button
              variant="default"
              component={Link}
              href={{ pathname: copyHref, query: { copyFrom: copyRow.id } }}
            >
              Copiar
            </Button>
          ) : (
            <Button variant="default" disabled title="Selecione exatamente 1 registro">
              Copiar
            </Button>
          ))}
        {useMenu ? (
          <Menu shadow="md" position="bottom-end" withinPortal>
            <Menu.Target>
              <Tooltip label="Mais ações" withinPortal>
                <ActionIcon
                  variant="default"
                  size="lg"
                  aria-label="Mais ações"
                  disabled={actions.length === 0}
                >
                  <IconDotsVertical size={18} />
                </ActionIcon>
              </Tooltip>
            </Menu.Target>
            <Menu.Dropdown>
              {actions.map((a) => {
                const disabled = isActionDisabled(a, selectedRows, visibleRows);
                return (
                  <Menu.Item
                    key={a.id}
                    leftSection={a.icon}
                    color={a.color}
                    disabled={disabled}
                    onClick={() => trigger(a)}
                  >
                    {a.label}
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
        ) : (
          actions.map((a) => {
            const disabled = isActionDisabled(a, selectedRows, visibleRows);
            return (
              <Button
                key={a.id}
                variant="default"
                color={a.color}
                disabled={disabled}
                onClick={() => trigger(a)}
              >
                {a.label}
              </Button>
            );
          })
        )}
      </Group>

      {confirmModal}
    </>
  );
}
