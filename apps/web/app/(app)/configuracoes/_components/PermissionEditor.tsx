'use client';

import { Card, Checkbox, Group, Stack, Text, Title } from '@mantine/core';
import { PERM } from '@delfrance/auth';

const DOMAIN_LABELS: Record<keyof typeof PERM, string> = {
  cliente: 'Clientes',
  produto: 'Produtos',
  pedido: 'Pedidos',
  pagamento: 'Pagamentos',
  nfe: 'NF-e',
  configuracoes: 'Configurações',
  chat: 'Atendimento',
};

const ACTION_LABELS: Record<string, string> = {
  read: 'Ler',
  write: 'Editar',
  delete: 'Excluir',
};

export interface PermissionEditorProps {
  value: bigint;
  onChange?: (next: bigint) => void;
  readOnly?: boolean;
}

export function PermissionEditor({
  value,
  onChange,
  readOnly = false,
}: PermissionEditorProps) {
  function toggle(bit: bigint, checked: boolean) {
    if (readOnly || !onChange) return;
    const next = checked ? value | bit : value & ~bit;
    onChange(next);
  }

  return (
    <Stack gap="sm">
      {(Object.entries(PERM) as [keyof typeof PERM, Record<string, bigint>][]).map(
        ([domain, actions]) => (
          <Card withBorder key={domain} padding="sm">
            <Stack gap="xs">
              <Title order={5}>{DOMAIN_LABELS[domain]}</Title>
              <Group gap="lg">
                {Object.entries(actions).map(([action, bit]) => {
                  const granted = (value & bit) === bit;
                  return (
                    <Checkbox
                      key={action}
                      label={ACTION_LABELS[action] ?? action}
                      checked={granted}
                      readOnly={readOnly}
                      disabled={readOnly}
                      onChange={(e) => toggle(bit, e.currentTarget.checked)}
                    />
                  );
                })}
              </Group>
            </Stack>
          </Card>
        ),
      )}
      {readOnly && value === 0n && (
        <Text c="dimmed" size="sm">
          Nenhuma permissão atribuída.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Human-readable list of granted permission labels (e.g. "Clientes: Ler").
 * Used in detail views where a checkbox grid would be visually noisy.
 */
export function permissionLabels(value: bigint): string[] {
  const out: string[] = [];
  for (const [domain, actions] of Object.entries(PERM) as [
    keyof typeof PERM,
    Record<string, bigint>,
  ][]) {
    for (const [action, bit] of Object.entries(actions)) {
      if ((value & bit) === bit) {
        out.push(`${DOMAIN_LABELS[domain]}: ${ACTION_LABELS[action] ?? action}`);
      }
    }
  }
  return out;
}
