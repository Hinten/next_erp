'use client';

import type { ReactNode } from 'react';
import { ActionIcon, Button, Divider, Group, Paper, Stack, Text, Tooltip } from '@mantine/core';
import { IconLayoutSidebarRightCollapse, IconLayoutSidebarRightExpand } from '@tabler/icons-react';
import Link from 'next/link';
import type { Route } from 'next';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';
import { actionDisabledReason } from './resolveActionRows';
import { useActionRunner } from './useActionRunner';

export interface ActionSidePanelProps<T> {
  actions: Array<ActionConfig<T>>;
  /** Rows currently checked in the table. */
  selectedRows: SnapshotRow<T>[];
  /**
   * Rows currently shown in the table (filtered page). Powers
   * `ActionConfig.fallbackToSingleVisibleRow`.
   */
  visibleRows?: SnapshotRow<T>[];
  /** Render a "Novo" button at the top when set. */
  newHref?: string;
  /** Custom render for "Novo" (e.g. a Next Link). */
  renderNewButton?: () => ReactNode;
  /** Same semantics as `ActionBar.copyHref`. */
  copyHref?: Route;
  /** Called after a `refreshOnComplete` action finishes (e.g. delete). */
  onActionComplete?: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** Expanded-rail width in px. Default 220. */
  width?: number;
  /**
   * Caller-owned content rendered below the buttons — e.g. live progress for
   * a job one of them started. Rendered in BOTH the expanded panel and the
   * collapsed rail: the caller decides what (if anything) survives the
   * collapse, so a running job is never silently hidden.
   */
  extra?: ReactNode;
}

/**
 * Persistent action panel docked to the right of the TableView — the
 * vertical counterpart of the ActionBar, enabled via the TableView's
 * `actionsPanel` prop (which then replaces the top bar). Same contracts:
 * `ActionConfig` actions on the current selection, "Novo"/"Copiar" buttons,
 * confirm flow through `useActionRunner`. Collapses to a slim rail; the
 * TableView owns (and persists) the collapsed state. Unlike the ActionBar it
 * can also host caller-owned content (`extra`) below the buttons — that is
 * what makes it, and not the toolbar, the home for a long-running job's
 * progress.
 */
export function ActionSidePanel<T>({
  actions,
  selectedRows,
  visibleRows = [],
  newHref,
  renderNewButton,
  copyHref,
  onActionComplete,
  collapsed,
  onToggleCollapsed,
  width = 220,
  extra,
}: ActionSidePanelProps<T>) {
  const { trigger, confirmModal } = useActionRunner({
    selectedRows,
    visibleRows,
    onActionComplete,
  });

  const copyRow = selectedRows.length === 1 ? selectedRows[0] : null;

  if (collapsed) {
    return (
      <Paper
        component="aside"
        aria-label="Ações"
        withBorder
        p={4}
        style={{ flexShrink: 0, alignSelf: 'stretch' }}
      >
        <Stack gap={4} align="center">
          <Tooltip label="Expandir ações" withinPortal>
            <ActionIcon
              variant="subtle"
              aria-label="Expandir ações"
              aria-expanded={false}
              onClick={onToggleCollapsed}
            >
              <IconLayoutSidebarRightExpand size={18} />
            </ActionIcon>
          </Tooltip>
          {extra}
        </Stack>
      </Paper>
    );
  }

  return (
    <Paper
      component="aside"
      aria-label="Ações"
      withBorder
      p="sm"
      w={width}
      style={{ flexShrink: 0, alignSelf: 'stretch' }}
    >
      <Stack gap="xs">
        <Group justify="space-between" wrap="nowrap">
          <Text fw={600}>Ações</Text>
          <Tooltip label="Recolher ações" withinPortal>
            <ActionIcon
              variant="subtle"
              aria-label="Recolher ações"
              aria-expanded
              onClick={onToggleCollapsed}
            >
              <IconLayoutSidebarRightCollapse size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>

        {renderNewButton ? (
          renderNewButton()
        ) : newHref ? (
          <Button fullWidth component="a" href={newHref}>
            Novo
          </Button>
        ) : null}
        {copyHref &&
          (copyRow ? (
            <Button
              fullWidth
              variant="default"
              component={Link}
              href={{ pathname: copyHref, query: { copyFrom: copyRow.id } }}
            >
              Copiar
            </Button>
          ) : (
            <Button fullWidth variant="default" disabled title="Selecione exatamente 1 registro">
              Copiar
            </Button>
          ))}

        {actions.length > 0 && (newHref || renderNewButton || copyHref) && <Divider />}

        {actions.map((a) => {
          const reason = actionDisabledReason(a, selectedRows, visibleRows);
          return (
            <Button
              key={a.id}
              fullWidth
              variant="default"
              color={a.color}
              // The vertical layout has room for icons (the inline ActionBar
              // renders label-only to keep the toolbar compact).
              leftSection={a.icon}
              disabled={reason !== null}
              // Same affordance as the "Copiar" button above: a disabled
              // action says on hover what would make it available.
              title={reason ?? undefined}
              onClick={() => trigger(a)}
            >
              {a.label}
            </Button>
          );
        })}

        <Text size="xs" c="dimmed">
          {selectedRows.length} selecionado(s)
        </Text>

        {extra && (
          <>
            <Divider />
            {extra}
          </>
        )}
      </Stack>

      {confirmModal}
    </Paper>
  );
}
