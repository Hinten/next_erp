'use client';

import { useState } from 'react';
import { Button, Group, Modal, Stack, Switch, Text } from '@mantine/core';

export interface PropagatePriceToChildrenFieldProps {
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /** Children whose current price map differs from the parent map. */
  divergentChildren: number;
}

/**
 * Parent price-propagation control. Turning propagation back on is destructive
 * only when a child currently carries its own map, so that is the one direction
 * that pauses for confirmation. The actual synchronization remains server-owned
 * and happens when the parent form is saved.
 */
export function PropagatePriceToChildrenField({
  value,
  onChange,
  disabled,
  divergentChildren,
}: PropagatePriceToChildrenFieldProps) {
  const [confirmOpen, setConfirmOpen] = useState(false);

  function requestChange(next: boolean) {
    if (!next) {
      onChange(false);
      return;
    }
    if (divergentChildren > 0) {
      setConfirmOpen(true);
      return;
    }
    onChange(true);
  }

  function confirmPropagation() {
    onChange(true);
    setConfirmOpen(false);
  }

  return (
    <>
      <Switch
        label="Propagar preço para as variações"
        description="Quando desligado, cada variação mantém o seu próprio preço."
        checked={value}
        onChange={(event) => requestChange(event.currentTarget.checked)}
        disabled={disabled}
      />

      <Modal
        opened={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Sincronizar preços das variações"
        centered
      >
        <Stack>
          <Text>
            {divergentChildren === 1
              ? 'Uma variação tem um preço diferente do produto pai.'
              : `${divergentChildren} variações têm preços diferentes do produto pai.`}
          </Text>
          <Text size="sm" c="dimmed">
            Ao salvar as alterações, o preço atual do produto pai substituirá os preços dessas
            variações.
          </Text>
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setConfirmOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={confirmPropagation}>Propagar e sincronizar</Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
