'use client';

import { useState } from 'react';
import { Alert, Button, Group, List, Modal, Stack, Switch, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

/** A kit that uses the produto being edited as one of its components. */
export interface ReferencingKit {
  id: string;
  nome: string;
}

export interface EhKitFieldProps {
  label: string;
  value: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  /**
   * Other kits that currently use THIS produto as a component (#246). Turning
   * this produto INTO a kit while it's still a component creates a kit-of-kit,
   * which can corrupt stock math — so the promotion is gated behind a warning.
   */
  referencedByKits: ReferencingKit[];
}

/**
 * The "É kit" toggle with a kit-of-kit safety warning (#246). The legacy Flutter
 * app (and the new picker) only guard the forward direction — a kit can't pick a
 * kit as a component — but neither catches **promoting** a produto that is
 * already a component into a kit. That silently creates a kit-of-kit. Here,
 * flipping the switch ON while the produto is referenced by other kits asks for
 * explicit confirmation (warning it can break stock); a persistent alert stays
 * visible while it remains a kit AND still referenced. Editar-only — a brand-new
 * produto (novo) can't be referenced yet.
 */
export function EhKitField({
  label,
  value,
  onChange,
  disabled,
  referencedByKits,
}: EhKitFieldProps) {
  const [confirming, setConfirming] = useState(false);
  const referenced = referencedByKits.length > 0;
  const isKit = value === true;

  const handleSwitch = (checked: boolean) => {
    // Only the promotion (off→on) while referenced needs confirmation; turning a
    // kit back off is always safe.
    if (checked && referenced) {
      setConfirming(true);
      return;
    }
    onChange(checked);
  };

  return (
    <Stack gap="xs">
      <Switch
        label={label}
        checked={isKit}
        onChange={(e) => handleSwitch(e.currentTarget.checked)}
        disabled={disabled}
      />

      {isKit && referenced && (
        <Alert
          color="red"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Este produto é componente de outros kits"
        >
          <Text size="sm">
            Mantê-lo como kit cria um <b>kit dentro de kit</b>, o que pode bugar o cálculo de
            estoque. Kits que usam este produto como componente:
          </Text>
          <List size="sm" mt={4}>
            {referencedByKits.map((k) => (
              <List.Item key={k.id}>{k.nome}</List.Item>
            ))}
          </List>
        </Alert>
      )}

      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Tornar este produto um kit?"
        centered
      >
        <Stack>
          <Text size="sm">
            Este produto é usado como componente em <b>{referencedByKits.length}</b> kit(s):
          </Text>
          <List size="sm">
            {referencedByKits.map((k) => (
              <List.Item key={k.id}>{k.nome}</List.Item>
            ))}
          </List>
          <Text size="sm" c="red">
            Transformá-lo em kit cria um <b>kit dentro de kit</b>, o que pode bugar o estoque.
            Prossiga apenas se tiver certeza do que está fazendo.
          </Text>
          <Group justify="flex-end">
            <Button type="button" variant="default" onClick={() => setConfirming(false)}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              onClick={() => {
                onChange(true);
                setConfirming(false);
              }}
            >
              Prosseguir mesmo assim
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
