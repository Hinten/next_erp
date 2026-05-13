'use client';

import Link from 'next/link';
import { Card, Group, Stack, Text } from '@mantine/core';
import { type Pedido, pedidoTotal } from '@delfrance/schemas';
import { format, money } from '@delfrance/core/money';
import { StatusBadge } from './StatusBadge';

export function PedidoCard({ id, data }: { id: string; data: Pedido }) {
  const total = pedidoTotal(data);
  const itensCount = Object.values(data.itens).reduce(
    (n, list) => n + list.length,
    0,
  );
  return (
    <Card
      withBorder
      shadow="xs"
      padding="sm"
      component={Link}
      href={`/pedidos/${id}`}
      style={{ textDecoration: 'none' }}
    >
      <Stack gap={6}>
        <Group justify="space-between">
          <Text fw={600} size="sm">
            {data.numero || `#${id.slice(0, 6)}`}
          </Text>
          <StatusBadge estado={data.estado} />
        </Group>
        <Group justify="space-between">
          <Text size="xs" c="dimmed">
            {itensCount} item{itensCount === 1 ? '' : 'ns'}
          </Text>
          <Text size="sm" fw={600}>
            {format(money(Math.round(total * 100)))}
          </Text>
        </Group>
      </Stack>
    </Card>
  );
}
