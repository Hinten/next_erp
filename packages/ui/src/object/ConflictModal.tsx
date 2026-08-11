'use client';

import { Alert, Badge, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

import type { ConflictField } from './conflictFields';

export interface ConflictModalProps {
  opened: boolean;
  /** e.g. "Pedido alterado", "Produto alterado". */
  title: string;
  /** One line naming what changed underneath the operator. */
  description?: string;
  /** Fields that changed in Firestore since the editor opened. */
  fields: ConflictField[];
  /** A save is in flight. */
  saving: boolean;
  /** Re-apply the operator's edits over the version they just reviewed. */
  onForceSave: () => void;
  /**
   * Take the server's version and keep the edits that do NOT collide with it.
   * Omit to hide the button — some callers have no local state to re-seed.
   */
  onReloadFromServer?: () => void;
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
 * ADR 0011 **tier 3** — the record changed underneath the operator, so a human
 * decides. Lists what changed remotely (loaded vs server) and flags which of
 * those the pending save would overwrite, then offers three ways out:
 *
 *  - **Cancelar** — keep editing, write nothing.
 *  - **Recarregar do servidor** — take the server's version for the contested
 *    fields and keep every uncontested edit the operator already made. Their
 *    typing is not thrown away; only what actually collided is.
 *  - **Salvar mesmo assim** — re-apply over the version they just reviewed. It
 *    re-BASELINES rather than force-writing blind, so a third change landing
 *    between the modal opening and this click raises the modal again instead of
 *    being swallowed.
 *
 * Never a silent drop: "silently discarding what someone typed is never the
 * answer" (ADR 0011). Generalized out of `apps/web`'s `PedidoConflictModal`
 * for #824 so every conflicting save in the ERP looks and behaves the same.
 */
export function ConflictModal({
  opened,
  title,
  description,
  fields,
  saving,
  onForceSave,
  onReloadFromServer,
  onCancel,
}: ConflictModalProps) {
  const anyOverwritten = fields.some((f) => f.overwritten);

  return (
    <Modal opened={opened} onClose={onCancel} title={title} centered size="lg">
      <Stack>
        <Alert color={anyOverwritten ? 'red' : 'yellow'} icon={<IconAlertTriangle size={18} />}>
          {description ?? 'Este registro foi alterado desde que você o abriu.'}{' '}
          {anyOverwritten
            ? 'Salvar vai SOBRESCREVER as alterações marcadas abaixo.'
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
          {onReloadFromServer && (
            <Button variant="light" onClick={onReloadFromServer} disabled={saving}>
              Recarregar do servidor
            </Button>
          )}
          <Button color={anyOverwritten ? 'red' : 'orange'} onClick={onForceSave} loading={saving}>
            Salvar mesmo assim
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
