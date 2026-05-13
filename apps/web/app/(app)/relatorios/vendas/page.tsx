'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Group,
  Skeleton,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import { DonutChart } from '@mantine/charts';
import { PageHeader } from '@delfrance/ui';
import { format, money } from '@delfrance/core/money';
import { ESTADO_BUCKET_LABELS } from '@delfrance/schemas';
import { porBucket, porEstado } from '@/lib/reports/aggregations';
import { useRecentPedidos } from '../_components/useRecentPedidos';

const BUCKET_COLOR: Record<string, string> = {
  aberto: 'blue.6',
  processo: 'yellow.6',
  concluido: 'green.6',
  cancelado: 'red.6',
};

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

export default function VendasPorEstadoPage() {
  const { data, loading, error } = useRecentPedidos();

  const { byBucket, byEstado } = useMemo(() => {
    if (!data) return { byBucket: [], byEstado: [] };
    return { byBucket: porBucket(data), byEstado: porEstado(data) };
  }, [data]);

  const donut = byBucket
    .filter((b) => b.count > 0)
    .map((b) => ({
      name: ESTADO_BUCKET_LABELS[b.bucket],
      value: b.count,
      color: BUCKET_COLOR[b.bucket] ?? 'gray.5',
    }));

  return (
    <Stack>
      <PageHeader
        title="Vendas por estado"
        description="Distribuição dos últimos 500 pedidos por bucket de estado"
      />

      {error && <Alert color="red">{error.message}</Alert>}

      {loading ? (
        <Skeleton height={320} />
      ) : data && data.length === 0 ? (
        <Text c="dimmed">Nenhum pedido encontrado.</Text>
      ) : (
        <>
          <Group align="flex-start" wrap="nowrap">
            <DonutChart
              data={donut}
              size={240}
              thickness={36}
              withLabelsLine
              withLabels
              chartLabel={
                data ? `${data.length} pedidos` : undefined
              }
            />
            <Stack flex={1} gap="xs">
              {byBucket.map((b) => (
                <Group
                  key={b.bucket}
                  justify="space-between"
                  py={4}
                  px="xs"
                  style={{ borderBottom: '1px solid var(--mantine-color-gray-2)' }}
                >
                  <Text size="sm">{ESTADO_BUCKET_LABELS[b.bucket]}</Text>
                  <Group gap="md">
                    <Text size="sm" c="dimmed">
                      {b.count} pedido(s)
                    </Text>
                    <Text size="sm" fw={600}>
                      {brl(b.receita)}
                    </Text>
                  </Group>
                </Group>
              ))}
            </Stack>
          </Group>

          <Table>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Estado</Table.Th>
                <Table.Th>Bucket</Table.Th>
                <Table.Th align="right">Pedidos</Table.Th>
                <Table.Th align="right">Receita</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {byEstado.map((row) => (
                <Table.Tr key={row.estado}>
                  <Table.Td>{row.label}</Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {ESTADO_BUCKET_LABELS[row.bucket]}
                    </Text>
                  </Table.Td>
                  <Table.Td align="right">{row.count}</Table.Td>
                  <Table.Td align="right">{brl(row.receita)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </>
      )}

      <Anchor component={Link} href="/relatorios" size="sm">
        ← Voltar a Relatórios
      </Anchor>
    </Stack>
  );
}
