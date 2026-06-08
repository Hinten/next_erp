'use client';

import { Badge, type MantineColor } from '@mantine/core';
import { ESTADO_PEDIDO_LABELS, type EstadoPedido, bucketOf } from '@delfrance/schemas';

const BUCKET_COLOR: Record<ReturnType<typeof bucketOf>, MantineColor> = {
  aberto: 'blue',
  processo: 'yellow',
  concluido: 'green',
  cancelado: 'red',
};

export function StatusBadge({ estado }: { estado: EstadoPedido }) {
  return (
    <Badge color={BUCKET_COLOR[bucketOf(estado)]} variant="light" radius="sm">
      {ESTADO_PEDIDO_LABELS[estado]}
    </Badge>
  );
}
