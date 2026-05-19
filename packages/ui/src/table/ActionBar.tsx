'use client';

import { useState } from 'react';
import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import type { Route } from 'next';
import type { SnapshotRow } from '@delfrance/data/hooks';
import type { ActionConfig } from '../schema/types';

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
}

/**
 * Toolbar above the table. Disables bulk actions when nothing is selected.
 * Confirmation flows are routed through a Mantine Modal that this bar owns.
 */
export function ActionBar<T>({
  actions,
  selectedRows,
  newHref,
  renderNewButton,
  copyHref,
}: ActionBarProps<T>) {
  const [pending, setPending] = useState<ActionConfig<T> | null>(null);

  async function runAction(action: ActionConfig<T>) {
    if (action.confirm) {
      setPending(action);
      return;
    }
    await action.run(selectedRows);
  }

  const copyRow = selectedRows.length === 1 ? selectedRows[0] : null;

  return (
    <>
      <Group justify="flex-end" gap="xs">
        {renderNewButton ? renderNewButton() : newHref ? (
          <Button component="a" href={newHref}>Novo</Button>
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
        {actions.map((a) => {
          const disabled = !!a.requiresSelection && selectedRows.length === 0;
          return (
            <Button
              key={a.id}
              variant="default"
              color={a.color}
              disabled={disabled}
              onClick={() => runAction(a)}
            >
              {a.label}
            </Button>
          );
        })}
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
            <Button variant="default" onClick={() => setPending(null)}>Cancelar</Button>
            <Button
              color={pending?.color ?? 'red'}
              onClick={async () => {
                const action = pending!;
                setPending(null);
                await action.run(selectedRows);
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
