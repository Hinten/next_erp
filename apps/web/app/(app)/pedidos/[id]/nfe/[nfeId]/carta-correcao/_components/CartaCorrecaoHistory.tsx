'use client';

/**
 * Per-NF-e Carta de Correção history — every CC-e issued for this NF-e
 * (registrada or rejeitada), newest first. A thin wrapper over the shared
 * `EventRoundtripHistory`; only the badge + summary differ.
 */
import { useMemo } from 'react';
import { Badge, Text } from '@mantine/core';
import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';

import { EventRoundtripHistory } from '@/components/EventRoundtripHistory';
import { cartaCorrecaoCollection } from '@/lib/data/cartaCorrecaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export function CartaCorrecaoHistory({ pedidoId, nfeId }: { pedidoId: string; nfeId: string }) {
  const db = getFirebaseFirestore();
  const query = useMemo(
    () => cartaCorrecaoCollection.ref(db, { pedidoId, nfeId }),
    [db, pedidoId, nfeId],
  );

  return (
    <EventRoundtripHistory
      query={query}
      title="Cartas de correção desta NF-e"
      loadingLabel="Carregando cartas de correção…"
      emptyLabel="Nenhuma carta de correção registrada para esta NF-e."
      renderBadge={(m) => {
        const registrada = m.estado === ESTADO_ENVI_NFE_MSG.concluido;
        return (
          <Badge color={registrada ? 'teal' : 'red'} variant="light">
            {registrada
              ? `registrada${m.cStat ? ` ${m.cStat}` : ''}`
              : `erro${m.cStat ? ` ${m.cStat}` : ''}`}
          </Badge>
        );
      }}
      renderSummary={(m) => (
        <>
          <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
            nº seq {m.nSeqEvento}
          </Text>
          <Text size="sm" truncate style={{ minWidth: 0 }}>
            {m.xCorrecao}
          </Text>
        </>
      )}
    />
  );
}
