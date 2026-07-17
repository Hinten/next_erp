'use client';

import {
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { IconCheck, IconCopy } from '@tabler/icons-react';
import type {
  NFeVerificarChaveStatus,
  NFeVerificarResult,
} from '@delfrance/integrations-nfe/http-provider';
import { ESTADO_NFE_LABELS, type EstadoNFe } from '@delfrance/schemas';

import { CopyIconButton } from '@/components/CopyIconButton';

const STATUS_META: Record<NFeVerificarChaveStatus, { label: string; color: string }> = {
  'skipped-final': { label: 'Estado final — pulada', color: 'gray' },
  atualizada: { label: 'Atualizada', color: 'teal' },
  'sem-mudanca': { label: 'Sem mudança', color: 'blue' },
  erro: { label: 'Erro', color: 'red' },
};

function estadoLabel(estado: EstadoNFe | null): string {
  return estado ? (ESTADO_NFE_LABELS[estado] ?? estado) : '—';
}

export interface VerificarResultadosModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
  readonly result: NFeVerificarResult | null;
}

/**
 * Per-chave outcome table of one "Verificar novamente" round-trip. Everything
 * relevant for diagnosis is copyable: each chave has its own CopyButton and
 * the header copies the full results array as JSON.
 */
export function VerificarResultadosModal({
  opened,
  onClose,
  result,
}: VerificarResultadosModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Verificação de comunicação NF-e" size="xl">
      {result && (
        <Stack>
          <Group justify="flex-end">
            <CopyButton value={JSON.stringify(result.results, null, 2)} timeout={1500}>
              {({ copied, copy }) => (
                <Button
                  variant="light"
                  size="xs"
                  onClick={copy}
                  leftSection={copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
                >
                  {copied ? 'Copiado!' : 'Copiar resultados'}
                </Button>
              )}
            </CopyButton>
          </Group>

          {result.msgsNaoEncontradas.length > 0 && (
            <Alert color="yellow" title="Comunicações não encontradas">
              {result.msgsNaoEncontradas.join(', ')}
            </Alert>
          )}

          <Table.ScrollContainer minWidth={720}>
            <Table striped highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Chave</Table.Th>
                  <Table.Th>Resultado</Table.Th>
                  <Table.Th>Estado</Table.Th>
                  <Table.Th>cStat</Table.Th>
                  <Table.Th>Detalhe</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {result.results.length === 0 && (
                  <Table.Tr>
                    <Table.Td colSpan={5} align="center">
                      Nenhuma chave verificada.
                    </Table.Td>
                  </Table.Tr>
                )}
                {result.results.map((r) => (
                  <Table.Tr key={r.chave}>
                    <Table.Td>
                      <Group gap={4} wrap="nowrap">
                        <Code fz={11}>{r.chave}</Code>
                        <CopyIconButton
                          value={r.chave}
                          label="Copiar chave"
                          ariaLabel={`Copiar chave ${r.chave}`}
                        />
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Badge color={STATUS_META[r.status].color} variant="light">
                        {STATUS_META[r.status].label}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">
                        {estadoLabel(r.estadoAnterior)}
                        {r.estadoNovo !== r.estadoAnterior && ` → ${estadoLabel(r.estadoNovo)}`}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.cStat ?? '—'}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" c={r.error ? 'red' : undefined}>
                        {r.error ?? r.xMotivo ?? '—'}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Stack>
      )}
    </Modal>
  );
}
