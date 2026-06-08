'use client';

import { useState } from 'react';
import { ActionIcon, Button, Group, Menu, Modal, Stack, Text, Tooltip } from '@mantine/core';
import { IconDotsVertical } from '@tabler/icons-react';
import Link from 'next/link';
import type { Route } from 'next';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';

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
 * Confirmation flows are routed through a Mantine Modal that this bar owns.
 * Many actions can collapse into an overflow `Menu` via `actionsLayout`.
 */
export function ActionBar<T>({
  actions,
  selectedRows,
  newHref,
  renderNewButton,
  copyHref,
  onActionComplete,
  actionsLayout = 'auto',
  overflowThreshold = 3,
}: ActionBarProps<T>) {
  const [pending, setPending] = useState<ActionConfig<T> | null>(null);

  async function execute(action: ActionConfig<T>) {
    await action.run(selectedRows);
    if (action.refreshOnComplete) onActionComplete?.();
  }

  // Shared dispatcher: routes through the confirm modal when the action
  // declares one. Inline buttons and menu items both call this so the
  // confirm semantics stay identical across layouts.
  async function triggerAction(action: ActionConfig<T>) {
    if (action.confirm) {
      setPending(action);
      return;
    }
    await execute(action);
  }

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
                const disabled = !!a.requiresSelection && selectedRows.length === 0;
                return (
                  <Menu.Item
                    key={a.id}
                    leftSection={a.icon}
                    color={a.color}
                    disabled={disabled}
                    onClick={() => triggerAction(a)}
                  >
                    {a.label}
                  </Menu.Item>
                );
              })}
            </Menu.Dropdown>
          </Menu>
        ) : (
          actions.map((a) => {
            const disabled = !!a.requiresSelection && selectedRows.length === 0;
            return (
              <Button
                key={a.id}
                variant="default"
                color={a.color}
                disabled={disabled}
                onClick={() => triggerAction(a)}
              >
                {a.label}
              </Button>
            );
          })
        )}
      </Group>

      <Modal
        opened={!!pending}
        onClose={() => setPending(null)}
        title={pending?.confirm?.title ?? 'Confirmar'}
        centered
      >
        <Stack>
          <Text>{pending?.confirm?.message}</Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setPending(null)}>
              Cancelar
            </Button>
            <Button
              color={pending?.color ?? 'red'}
              onClick={async () => {
                const action = pending!;
                setPending(null);
                await execute(action);
              }}
            >
              Confirmar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
