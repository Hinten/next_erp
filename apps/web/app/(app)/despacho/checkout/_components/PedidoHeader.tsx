'use client';

import { Anchor, Badge, Group, Text } from '@mantine/core';
import { IconExternalLink } from '@tabler/icons-react';
import Link from 'next/link';
import type { Route } from 'next';
import { ESTADO_PEDIDO_LABELS, type Pedido } from '@delfrance/schemas';

export interface PedidoHeaderProps {
  pedido: Pedido;
  pedidoId: string;
}

/**
 * The loaded-pedido header. Legacy opened the pedido editor in an in-page dialog;
 * here it's a LINK-OUT to `/pedidos/{id}/editar` in a new tab (decision: no
 * inline editor on the checkout screen — the operator edits, then reloads).
 */
export function PedidoHeader({ pedido, pedidoId }: PedidoHeaderProps) {
  return (
    <Group gap="sm" wrap="nowrap">
      <Anchor
        component={Link}
        href={`/pedidos/${pedidoId}/editar` as Route}
        target="_blank"
        rel="noopener noreferrer"
        fw={600}
        size="lg"
      >
        <Group gap={4} wrap="nowrap">
          <Text span inherit>
            Pedido Nº {pedido.numero ?? pedidoId}
          </Text>
          <IconExternalLink size={16} />
        </Group>
      </Anchor>
      <Badge variant="light" color="blue">
        {ESTADO_PEDIDO_LABELS[pedido.estado]}
      </Badge>
    </Group>
  );
}
