'use client';

import { Alert, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ConflictField } from './conflictFields';

export interface PedidoConflictModalProps {
  opened: boolean;
  /** Fields the save would overwrite where the server differs (may be empty). */
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
 * Firestore since it was loaded). Lists the fields the user would overwrite —
 * server value vs theirs — and lets them re-run the save with `force: true`
 * ("salvar mesmo assim") after reviewing, or cancel and keep editing. The F3
 * follow-up to the F2 optimistic-concurrency guard.
 */
export function PedidoConflictModal({
  opened,
  fields,
  saving,
  onForceSave,
  onCancel,
}: PedidoConflictModalProps) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Pedido alterado" centered size="lg">
      <Stack>
        <Alert color="yellow" icon={<IconAlertTriangle size={18} />}>
          Este pedido foi alterado por outra pessoa desde que você o abriu.
        </Alert>

        {fields.length === 0 ? (
          <Text>Suas alterações não conflitam com as dela. Deseja salvar mesmo assim?</Text>
        ) : (
          <>
            <Text>
              Salvar vai <b>sobrescrever</b> os campos abaixo com os seus valores:
            </Text>
            <Table withTableBorder withColumnBorders striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Campo</Table.Th>
                  <Table.Th>No servidor</Table.Th>
                  <Table.Th>Seu valor</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {fields.map((f) => (
                  <Table.Tr key={f.field}>
                    <Table.Td>{f.label}</Table.Td>
                    <Table.Td>
                      {f.complex ? <Text c="dimmed">alterado</Text> : formatValue(f.server)}
                    </Table.Td>
                    <Table.Td>
                      {f.complex ? <Text c="dimmed">alterado</Text> : formatValue(f.mine)}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}

        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button color="orange" onClick={onForceSave} loading={saving}>
            Salvar mesmo assim
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
