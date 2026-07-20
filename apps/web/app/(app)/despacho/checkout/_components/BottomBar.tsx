'use client';

import { Button, Group } from '@mantine/core';
import { IconDeviceFloppy, IconEraser, IconRefresh } from '@tabler/icons-react';

export interface BottomBarProps {
  onClear: () => void;
  onReload: () => void;
  onSave: () => void;
  saving: boolean;
  /** disable Salvar when logged out (no NF-e/freight client) — the clients gate write. */
  canSave: boolean;
}

/**
 * The action bar under the panes: Limpar (wipe scans, keep pedido), Reiniciar
 * (reload the same pedido fresh), Salvar (run the gate → transaction → post-save
 * sequence). Salvar is mutex'd by `saving` so a double-click can't double-commit.
 */
export function BottomBar({ onClear, onReload, onSave, saving, canSave }: BottomBarProps) {
  return (
    <Group>
      <Button
        variant="default"
        leftSection={<IconEraser size={18} />}
        onClick={onClear}
        disabled={saving}
      >
        Limpar
      </Button>
      <Button
        variant="default"
        leftSection={<IconRefresh size={18} />}
        onClick={onReload}
        disabled={saving}
      >
        Reiniciar
      </Button>
      <Button
        ml="auto"
        leftSection={<IconDeviceFloppy size={18} />}
        onClick={onSave}
        loading={saving}
        disabled={!canSave}
      >
        Salvar
      </Button>
    </Group>
  );
}
