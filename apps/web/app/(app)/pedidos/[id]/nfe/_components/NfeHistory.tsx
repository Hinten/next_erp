'use client';

/**
 * Communication history for one NF-e — every SEFAZ round-trip whose
 * `targetsChnfe` includes this NF-e's chave, newest first (emission, consult,
 * cancelamento). A thin wrapper over the shared `EventRoundtripHistory`; it has
 * no title (it sits inside an NF-e card) and shows its transport `error` in red.
 */
import { useMemo } from 'react';
import { Badge, Text } from '@mantine/core';
import { buildQuery, whereOp } from '@delfrance/data';

import { EventRoundtripHistory } from '@/components/EventRoundtripHistory';
import { enviNfeCollection } from '@/lib/data/enviNfeCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';

export function NfeHistory({ filialId, chave }: { filialId: string; chave: string }) {
  const db = getFirebaseFirestore();
  const query = useMemo(
    () =>
      buildQuery(enviNfeCollection.ref(db, { filialId }), [
        whereOp('targetsChnfe', 'array-contains', chave),
      ]),
    [db, filialId, chave],
  );

  return (
    <EventRoundtripHistory
      query={query}
      loadingLabel="Carregando comunicações…"
      emptyLabel="Nenhuma comunicação registrada para esta NF-e."
      renderBadge={(m) => {
        const failed = m.error != null;
        return (
          <Badge color={failed ? 'red' : 'blue'} variant="light">
            {m.cStat ?? (failed ? 'erro' : '—')}
          </Badge>
        );
      }}
      renderSummary={(m) => (
        <Text size="sm" truncate style={{ minWidth: 0 }}>
          {m.xMotivo ?? m.error ?? '—'}
        </Text>
      )}
      renderPanelDetail={(m) =>
        m.error ? (
          <Text size="sm" c="red">
            {m.error}
          </Text>
        ) : null
      }
    />
  );
}
