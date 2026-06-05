'use client';

/**
 * Per-filial inutilização history — every burned número range (homologada or
 * rejeitada), newest first. A thin wrapper over the shared
 * `EventRoundtripHistory`; only the badge + summary differ. Mirrors the old
 * Flutter `InutNFeTable` (`filiais/{filialId}/inutilizacao`).
 */
import { useMemo } from 'react';
import { Badge, Text } from '@mantine/core';
import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';

import { EventRoundtripHistory } from '@/components/EventRoundtripHistory';
import { inutilizacaoCollection } from '@/lib/data/inutilizacaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export function InutilizacaoHistory({ filialId }: { filialId: string }) {
  const db = getFirebaseFirestore();
  const query = useMemo(() => inutilizacaoCollection.ref(db, { filialId }), [db, filialId]);

  return (
    <EventRoundtripHistory
      query={query}
      title="Inutilizações da filial"
      loadingLabel="Carregando inutilizações…"
      emptyLabel="Nenhuma inutilização registrada para esta filial."
      renderBadge={(m) => {
        const homologada = m.estado === ESTADO_ENVI_NFE_MSG.concluido;
        return (
          <Badge color={homologada ? 'teal' : 'red'} variant="light">
            {homologada
              ? `homologada${m.cStat ? ` ${m.cStat}` : ''}`
              : `erro${m.cStat ? ` ${m.cStat}` : ''}`}
          </Badge>
        );
      }}
      renderSummary={(m) => (
        <Text size="sm" truncate style={{ minWidth: 0 }}>
          Série {m.serie} · números {m.nNFIni}–{m.nNFFin}
        </Text>
      )}
    />
  );
}
