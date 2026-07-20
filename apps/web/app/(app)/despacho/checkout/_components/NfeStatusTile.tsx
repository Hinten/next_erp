'use client';

import { useMemo } from 'react';
import { Badge, Group, Skeleton, Text } from '@mantine/core';
import type { MantineColor } from '@mantine/core';
import type { Firestore } from 'firebase/firestore';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot } from '@delfrance/data/hooks';
import { ESTADO_NFE, ESTADO_NFE_LABELS, type EstadoNFe } from '@delfrance/schemas';
import { nfeCollection } from '@/lib/data/nfeCollection';

/**
 * A compact, realtime NF-e status badge for the checkout sidebar — the port of
 * the legacy `StatusNFeWidget` tile (`.old/lib/despacho/pages/checkout.dart:2244`).
 * Subscribes to the pedido's latest `nfev4` doc (ordered by `ultima_modificacao`,
 * limit 1) exactly like the pedidos-list `NFCell`, so the operator sees emission
 * land live after Salvar without a manual refresh.
 */
const NFE_STATE_COLOR: Record<EstadoNFe, MantineColor> = {
  [ESTADO_NFE.gerado]: 'gray',
  [ESTADO_NFE.enviando]: 'yellow',
  [ESTADO_NFE.aguardandoResposta]: 'yellow',
  [ESTADO_NFE.processamentoCompleto]: 'blue',
  [ESTADO_NFE.processamentoCancelado]: 'gray',
  [ESTADO_NFE.aprovada]: 'green',
  [ESTADO_NFE.epecAprovado]: 'green',
  [ESTADO_NFE.rejeitada]: 'red',
  [ESTADO_NFE.cancelada]: 'gray',
  [ESTADO_NFE.numeracaoInutilizada]: 'gray',
  [ESTADO_NFE.error]: 'red',
};

export function NfeStatusTile({ db, pedidoId }: { db: Firestore; pedidoId: string }) {
  const q = useMemo(
    () =>
      buildQuery(nfeCollection.ref(db, { pedidoId }), [
        orderByField('ultima_modificacao', 'desc'),
        limit(1),
      ]),
    [db, pedidoId],
  );
  const { data, loading } = useSnapshot(q);
  const latest = data?.[0]?.data;

  return (
    <Group gap="xs" justify="space-between" wrap="nowrap">
      <Text size="sm" fw={500}>
        NF-e
      </Text>
      {loading ? (
        <Skeleton height={20} width={90} />
      ) : latest ? (
        <Badge
          // tpEmis !== 1 → a contingência variant; outline so it reads at a glance.
          variant={latest.tpEmis !== 1 ? 'outline' : 'light'}
          color={NFE_STATE_COLOR[latest.estado] ?? 'gray'}
        >
          {ESTADO_NFE_LABELS[latest.estado] ?? latest.estado}
        </Badge>
      ) : (
        <Text size="sm" c="dimmed">
          Sem NF-e
        </Text>
      )}
    </Group>
  );
}
