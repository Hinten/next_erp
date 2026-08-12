'use client';

import { Anchor, Badge, Button, Group, Stack, Text } from '@mantine/core';
import Link from 'next/link';
import type { Route } from 'next';
import { IconExternalLink, IconReload } from '@tabler/icons-react';
import {
  ESTADO_FRETE,
  ESTADO_FRETE_LABELS,
  isFreteJaPostado,
  type FreteDoPedido,
} from '@delfrance/schemas';

/**
 * Read-only frete summary for the loaded pedido. Deliberately NOT an editor
 * (the legacy in-screen `showEditFreightDialog` is dropped, per the port plan):
 * the operator edits freight on the pedido and reloads. Shows the shipping
 * `estado`, whether a label has been bought / a tracking code exists, and the
 * two affordances — "Editar no pedido" (link-out, matching `PedidoHeader`) and
 * "Recarregar" (re-fetch the pedido after an external edit).
 */
export function FreteSummary({
  pedidoId,
  frete,
  onReload,
}: {
  pedidoId: string;
  frete: FreteDoPedido | null;
  onReload: () => void;
}) {
  const posted = frete !== null && isFreteJaPostado(frete.estado);

  return (
    <Stack gap={6}>
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Text size="sm" fw={500}>
          Frete
        </Text>
        {frete === null ? (
          <Text size="sm" c="dimmed">
            Sem frete
          </Text>
        ) : (
          <Badge
            variant="light"
            color={
              frete.estado === ESTADO_FRETE.checkFinalizado ? 'green' : posted ? 'blue' : 'gray'
            }
          >
            {ESTADO_FRETE_LABELS[frete.estado] ?? frete.estado}
          </Badge>
        )}
      </Group>

      {frete !== null && (
        <>
          {frete.printLabelId != null && (
            <Text size="xs" c="dimmed">
              Etiqueta comprada
            </Text>
          )}
          {frete.codRastreio != null && frete.codRastreio.length > 0 && (
            <Text size="xs" c="dimmed" style={{ wordBreak: 'break-all' }}>
              Rastreio: {frete.codRastreio}
            </Text>
          )}
        </>
      )}

      <Group gap="xs" wrap="nowrap">
        <Anchor
          component={Link}
          href={`/pedidos/${pedidoId}/editar` as Route}
          target="_blank"
          rel="noopener noreferrer"
          size="xs"
        >
          <Group gap={4} wrap="nowrap">
            Editar no pedido
            <IconExternalLink size={12} />
          </Group>
        </Anchor>
        <Button
          variant="subtle"
          size="compact-xs"
          leftSection={<IconReload size={12} />}
          onClick={onReload}
        >
          Recarregar
        </Button>
      </Group>
    </Stack>
  );
}
