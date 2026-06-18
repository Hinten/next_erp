'use client';

import { Alert, Badge, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ConflictField } from './conflictFields';

export interface PedidoConflictModalProps {
  opened: boolean;
  /** Fields that changed in Firestore since the editor opened. */
  fields: ConflictField[];
  /** The "salvar mesmo assim" request is in flight. */
  saving: boolean;
  onForceSave: () => void;
  onCancel: () => void;
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '(vazio)';
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  if (typeof v === 'string') return v === '' ? '(vazio)' : v;
  if (typeof v === 'number') return String(v);
  return 'alterado';
}

/**
 * Shown when `savePedido` raises a `PedidoConflictError` (the pedido changed in
 * Firestore since it was loaded — by another user OR a raw backend edit). Lists
 * what changed remotely (loaded vs server) and flags which of those the save
 * would overwrite, then lets the user re-save overriding the version they just
 * reviewed ("salvar mesmo assim") or cancel. The F3 follow-up to the F2 guard.
 */
export function PedidoConflictModal({
  opened,
  fields,
  saving,
  onForceSave,
  onCancel,
}: PedidoConflictModalProps) {
  const anyOverwritten = fields.some((f) => f.overwritten);

  return (
    <Modal opened={opened} onClose={onCancel} title="Pedido alterado" centered size="lg">
      <Stack>
        <Alert color={anyOverwritten ? 'red' : 'yellow'} icon={<IconAlertTriangle size={18} />}>
          Este pedido foi alterado desde que você o abriu.{' '}
          {anyOverwritten
            ? 'Salvar vai SOBRESCREVER alterações marcadas abaixo.'
            : 'Suas alterações não sobrescrevem as mudanças abaixo.'}
        </Alert>

        {fields.length > 0 && (
          <Table withTableBorder withColumnBorders striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Campo</Table.Th>
                <Table.Th>Você carregou</Table.Th>
                <Table.Th>No servidor</Table.Th>
                <Table.Th>Sua gravação</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {fields.map((f) => (
                <Table.Tr key={f.field}>
                  <Table.Td>{f.label}</Table.Td>
                  <Table.Td>
                    {f.complex ? <Text c="dimmed">alterado</Text> : formatValue(f.loaded)}
                  </Table.Td>
                  <Table.Td>
                    {f.complex ? <Text c="dimmed">alterado</Text> : formatValue(f.server)}
                  </Table.Td>
                  <Table.Td>
                    {f.overwritten ? (
                      <Badge color="red" variant="light">
                        Sobrescreve
                      </Badge>
                    ) : (
                      <Text c="dimmed" size="sm">
                        mantém o servidor
                      </Text>
                    )}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button color={anyOverwritten ? 'red' : 'orange'} onClick={onForceSave} loading={saving}>
            Salvar mesmo assim
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
