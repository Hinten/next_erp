'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import {
  Alert,
  Anchor,
  Card,
  Group,
  Skeleton,
  Stack,
  Text,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { format, money } from '@delfrance/core/money';
import { ESTADO_BUCKET_LABELS } from '@delfrance/schemas';
import { useRecentPedidos } from './_components/useRecentPedidos';
import { overview, porBucket } from '@/lib/reports/aggregations';

function brl(value: number): string {
  return format(money(Math.round(value * 100)));
}

export default function RelatoriosIndexPage() {
  const { data, loading, error } = useRecentPedidos();

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      ov: overview(data),
      buckets: porBucket(data),
    };
  }, [data]);

  return (
    <Stack>
      <PageHeader
        title="Relatórios"
        description="Visão consolidada dos últimos 500 pedidos (atualiza em tempo real)"
      />

      {error && <Alert color="red">{error.message}</Alert>}

      {loading || !stats ? (
        <Group grow>
          <Skeleton height={88} />
          <Skeleton height={88} />
          <Skeleton height={88} />
          <Skeleton height={88} />
        </Group>
      ) : (
        <>
          <Group grow align="stretch">
            <SummaryCard label="Pedidos" value={String(stats.ov.pedidos)} />
            <SummaryCard label="Receita" value={brl(stats.ov.receita)} />
            <SummaryCard label="Ticket médio" value={brl(stats.ov.ticketMedio)} />
            <SummaryCard
              label="Itens vendidos"
              value={String(stats.ov.itensVendidos)}
            />
          </Group>

          <Group grow align="stretch">
            {stats.buckets.map((b) => (
              <SummaryCard
                key={b.bucket}
                label={ESTADO_BUCKET_LABELS[b.bucket]}
                value={`${b.count} · ${brl(b.receita)}`}
                tone={b.bucket === 'cancelado' ? 'red' : undefined}
              />
            ))}
          </Group>
        </>
      )}

      <Group>
        <Anchor component={Link} href="/relatorios/produtos">
          → Produtos mais vendidos
        </Anchor>
        <Anchor component={Link} href="/relatorios/vendas">
          → Vendas por estado
        </Anchor>
      </Group>
    </Stack>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'red';
}) {
  return (
    <Card withBorder padding="md" shadow="xs">
      <Stack gap={4}>
        <Text size="sm" c="dimmed">
          {label}
        </Text>
        <Text fw={700} size="xl" c={tone === 'red' ? 'red.7' : undefined}>
          {value}
        </Text>
      </Stack>
    </Card>
  );
}
