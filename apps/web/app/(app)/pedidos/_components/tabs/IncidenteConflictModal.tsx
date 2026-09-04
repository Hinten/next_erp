'use client';

import { Alert, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import {
  ORIGEM_INCIDENTE_LABELS,
  TIPO_INCIDENTE_LABELS,
  incidenteSchema,
  type Incidente,
} from '@delfrance/schemas';
import { parseZodDescription } from '@delfrance/ui';

import type { CampoAutoralIncidente } from './incidenteForm';

export interface IncidenteConflictModalProps {
  opened: boolean;
  /** Fields the save would overwrite — never empty when `opened`. */
  campos: CampoAutoralIncidente[];
  /** The incidente as the form was seeded from it. */
  baseline: Incidente | null;
  /** The incidente as it is in Firestore right now. */
  current: Incidente | null;
  /** The resolução lock armed while the form was open (#1250). */
  bloqueouAgora: boolean;
  saving: boolean;
  onForceSave: () => void;
  onCancel: () => void;
}

function labelDoCampo(campo: CampoAutoralIncidente): string {
  return parseZodDescription(incidenteSchema.shape[campo]).label ?? campo;
}

function formatValue(campo: CampoAutoralIncidente, doc: Incidente | null): string {
  // The two enum-coded fields render as their label — a raw `'returns'` or a
  // bare `2` in a diff the operator has to judge is worse than no diff at all.
  if (campo === 'tipo') {
    const tipo = doc?.tipo;
    return tipo == null ? '(vazio)' : (TIPO_INCIDENTE_LABELS[tipo] ?? tipo);
  }
  if (campo === 'origem') {
    const origem = doc?.origem;
    return origem == null ? '(vazio)' : (ORIGEM_INCIDENTE_LABELS[origem] ?? String(origem));
  }
  const value = doc?.[campo] ?? null;
  if (value === null) return '(vazio)';
  if (typeof value === 'string') return value.trim() === '' ? '(vazio)' : value;
  // `resolucao` is an object; showing it inline would be a wall of JSON.
  return 'alterado';
}

/**
 * Tier 3 of the lost-update ladder (`CLAUDE.md` rule 7 / ADR 0011): the browser
 * SDK has no `lastUpdateTime` precondition, so an interactive edit that loses a
 * race is raised to the operator instead of being silently dropped.
 *
 * Only fields this save would actually **overwrite** reach here. A remote write
 * that merely advanced `claimStatus`, `claimStage` or `entregue` is not a
 * conflict — the editor never writes those keys — and blocking on it would make
 * the tab unusable on any incidente Mercado Livre is actively syncing.
 *
 * "Salvar mesmo assim" re-baselines on the version shown here rather than
 * force-writing: if the doc moves again between reading this table and
 * clicking, the guard trips a second time and the newer diff is shown, so an
 * edit nobody has read is never clobbered.
 */
export function IncidenteConflictModal({
  opened,
  campos,
  baseline,
  current,
  bloqueouAgora,
  saving,
  onForceSave,
  onCancel,
}: IncidenteConflictModalProps) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Incidente alterado" centered size="lg">
      <Stack>
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          Este incidente foi alterado desde que você o abriu. Salvar vai{' '}
          <strong>sobrescrever</strong> os campos abaixo.
        </Alert>

        {bloqueouAgora && (
          <Alert color="orange" icon={<IconAlertTriangle size={18} />}>
            O frete da resolução avançou enquanto o formulário estava aberto, então a resolução
            ficou <strong>bloqueada</strong>. Suas alterações na resolução não serão salvas — os
            demais campos serão.
          </Alert>
        )}

        <Table withTableBorder withColumnBorders striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Campo</Table.Th>
              <Table.Th>Você carregou</Table.Th>
              <Table.Th>No servidor</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {campos.map((campo) => (
              <Table.Tr key={campo}>
                <Table.Td>{labelDoCampo(campo)}</Table.Td>
                <Table.Td>
                  <Text size="sm">{formatValue(campo, baseline)}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{formatValue(campo, current)}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>

        <Group justify="flex-end">
          <Button variant="default" onClick={onCancel} disabled={saving}>
            Cancelar
          </Button>
          <Button color="red" onClick={onForceSave} loading={saving}>
            Salvar mesmo assim
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
