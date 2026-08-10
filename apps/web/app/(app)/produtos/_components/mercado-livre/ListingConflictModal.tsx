'use client';

import { Alert, Button, Group, Modal, Stack, Table, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { LISTING_FIELD_LABELS } from '@/lib/mercado-livre/listingFields';
import type { OperatorOwnedKey } from '@/lib/mercado-livre/listingPatch';

export interface ListingConflictModalProps {
  opened: boolean;
  /** Fields the save would overwrite — never empty when `opened`. */
  fields: OperatorOwnedKey[];
  /** The doc as the form was seeded from it. */
  baseline: ProdutoMercadoLivreLink | null;
  /** The doc as it is in Firestore right now. */
  current: ProdutoMercadoLivreLink | null;
  saving: boolean;
  onForceSave: () => void;
  onCancel: () => void;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '(vazio)';
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  if (typeof value === 'string') return value.trim() === '' ? '(vazio)' : value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '(vazio)' : value.join(', ');
  return 'alterado';
}

/**
 * Tier 3 of the lost-update ladder (`CLAUDE.md` rule 7 / ADR 0011): the browser
 * SDK has no `lastUpdateTime` precondition, so an interactive edit that loses a
 * race is raised to the operator instead of being silently dropped.
 *
 * Only fields this save would actually **overwrite** reach here. A remote write
 * that merely advanced `estado` or `precoPublicado` is not a conflict — the
 * editor never writes those keys — and blocking on it would make the screen
 * unusable on any listing ML is actively syncing.
 *
 * "Salvar mesmo assim" re-baselines on the version shown here rather than
 * force-writing: if the doc moves again between reading this table and clicking,
 * the guard trips a second time and the newer diff is shown, so an edit nobody
 * has read is never clobbered.
 */
export function ListingConflictModal({
  opened,
  fields,
  baseline,
  current,
  saving,
  onForceSave,
  onCancel,
}: ListingConflictModalProps) {
  return (
    <Modal opened={opened} onClose={onCancel} title="Anúncio alterado" centered size="lg">
      <Stack>
        <Alert color="red" icon={<IconAlertTriangle size={18} />}>
          Este anúncio foi alterado desde que você o abriu. Salvar vai <strong>sobrescrever</strong>{' '}
          os campos abaixo.
        </Alert>

        <Table withTableBorder withColumnBorders striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Campo</Table.Th>
              <Table.Th>Você carregou</Table.Th>
              <Table.Th>No servidor</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {fields.map((field) => (
              <Table.Tr key={field}>
                <Table.Td>{LISTING_FIELD_LABELS[field]}</Table.Td>
                <Table.Td>
                  <Text size="sm">{formatValue(baseline?.[field])}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="sm">{formatValue(current?.[field])}</Text>
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
