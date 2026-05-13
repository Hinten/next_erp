'use client';

import { useMemo } from 'react';
import {
  Alert,
  Box,
  ScrollArea,
  Skeleton,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { PageHeader } from '@delfrance/ui';
import { buildQuery, limit, orderByField } from '@delfrance/data';
import { useSnapshot, type SnapshotRow } from '@delfrance/data/hooks';
import {
  ESTADO_BUCKET_LABELS,
  type EstadoBucket,
  type Pedido,
  bucketOf,
} from '@delfrance/schemas';
import { pedidoCollection } from '@/lib/data/pedidoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { PedidoCard } from './_components/PedidoCard';

const PAGE_SIZE = 200;
const LANES: EstadoBucket[] = ['aberto', 'processo', 'concluido', 'cancelado'];

export default function PedidosKanbanPage() {
  const q = useMemo(() => {
    const base = pedidoCollection.ref(getFirebaseFirestore(), {});
    // Newest first; the query itself stays simple — bucketing happens client-side.
    return buildQuery(base, [orderByField('numero', 'desc'), limit(PAGE_SIZE)]);
  }, []);

  const { data, loading, error } = useSnapshot(q);

  const grouped = useMemo(() => {
    const out: Record<EstadoBucket, SnapshotRow<Pedido>[]> = {
      aberto: [],
      processo: [],
      concluido: [],
      cancelado: [],
    };
    if (!data) return out;
    for (const row of data) {
      const bucket = bucketOf(row.data.estado);
      out[bucket].push(row);
    }
    return out;
  }, [data]);

  return (
    <Stack h="calc(100vh - 96px)">
      <PageHeader
        title="Pedidos"
        description="Quadro de pedidos em tempo real (últimos 200)"
      />

      {error && (
        <Alert color="red" title="Erro ao carregar pedidos">
          {error.message}
        </Alert>
      )}

      <ScrollArea offsetScrollbars style={{ flex: 1 }}>
        <Box style={{ display: 'flex', gap: 16, alignItems: 'flex-start', minWidth: 1024 }}>
          {LANES.map((lane) => (
            <Box key={lane} style={{ flex: 1, minWidth: 240 }}>
              <Stack gap="xs">
                <Title order={5} c={`${laneColor(lane)}.7`}>
                  {ESTADO_BUCKET_LABELS[lane]}
                </Title>
                <Text size="xs" c="dimmed">
                  {grouped[lane].length} pedido(s)
                </Text>
                {loading && (
                  <Stack>
                    <Skeleton height={64} />
                    <Skeleton height={64} />
                  </Stack>
                )}
                {!loading &&
                  grouped[lane].map(({ id, data }) => (
                    <PedidoCard key={id} id={id} data={data} />
                  ))}
                {!loading && grouped[lane].length === 0 && (
                  <Text size="xs" c="dimmed">
                    (vazio)
                  </Text>
                )}
              </Stack>
            </Box>
          ))}
        </Box>
      </ScrollArea>
    </Stack>
  );
}

function laneColor(lane: EstadoBucket): string {
  switch (lane) {
    case 'aberto':
      return 'blue';
    case 'processo':
      return 'yellow';
    case 'concluido':
      return 'green';
    case 'cancelado':
      return 'red';
  }
}
