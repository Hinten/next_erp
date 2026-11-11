'use client';

import { Alert, Text } from '@mantine/core';

import { formatarInstanteJob } from '@/lib/marketplace/contaJobs/cadencia';

/**
 * A RUNNING job that stopped checkpointing: the card's "sem progresso" line.
 * Moved, name and copy unchanged, out of Shopee's cards
 * (`canais/shopee/_components/ShopeeJobCards.tsx`) when the Loja Integrada
 * product import needed the same sentence — WHEN to show it stays with each
 * channel, over the shared `silencioExcedido` (`lib/marketplace/contaJobs/cadencia.ts`).
 *
 * `desde` is the run's last sign of life, printed in São Paulo time.
 */
export function AvisoSemProgresso({ desde }: { desde: number }) {
  return (
    <Alert color="yellow" variant="light" p="xs">
      <Text size="xs">
        Sem progresso desde {formatarInstanteJob(desde)} — se continuar assim, cancele e inicie de
        novo.
      </Text>
    </Alert>
  );
}
