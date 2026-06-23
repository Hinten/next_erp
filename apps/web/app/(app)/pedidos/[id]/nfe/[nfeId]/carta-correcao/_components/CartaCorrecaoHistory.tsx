'use client';

/**
 * Per-NF-e Carta de Correção history — every CC-e issued for this NF-e
 * (registrada or rejeitada), newest first. A thin wrapper over the shared
 * `EventRoundtripHistory`; the badge + summary differ, and registrada rows get a
 * "Baixar PDF" action.
 */
import { useMemo, useState } from 'react';
import { Badge, Button, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconFileText } from '@tabler/icons-react';
import { ESTADO_ENVI_NFE_MSG } from '@delfrance/schemas';
import { NFeHttpError, NFeNetworkError } from '@delfrance/integrations-nfe/http-provider';

import { EventRoundtripHistory } from '@/components/EventRoundtripHistory';
import { cartaCorrecaoCollection } from '@/lib/data/cartaCorrecaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useNFeClient } from '@/lib/nfe/client';
import { downloadCartaCorrecao } from '@/lib/nfe/downloadDanfe';

function DownloadCceButton({
  pedidoId,
  nfeId,
  cceId,
}: {
  pedidoId: string;
  nfeId: string;
  cceId: string;
}) {
  const client = useNFeClient();
  const [busy, setBusy] = useState(false);

  const run = async (): Promise<void> => {
    if (!client) return;
    setBusy(true);
    try {
      await downloadCartaCorrecao(client, pedidoId, nfeId, cceId);
    } catch (err) {
      // An HTTP-status error (incl. the 422 "indisponível") and a network
      // failure are expected, user-facing outcomes — surface a notification.
      // Only truly unexpected errors rethrow.
      if (err instanceof NFeHttpError || err instanceof NFeNetworkError) {
        notifications.show({
          color: 'red',
          title: 'Falha ao gerar o PDF da carta de correção',
          message: err.message,
        });
      } else {
        throw err;
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button
      size="xs"
      variant="light"
      leftSection={<IconFileText size={14} />}
      loading={busy}
      disabled={!client}
      onClick={() => void run()}
    >
      Baixar PDF
    </Button>
  );
}

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
        const suffix = m.cStat ? ` ${m.cStat}` : '';
        if (m.estado === ESTADO_ENVI_NFE_MSG.concluido) {
          return (
            <Badge color="teal" variant="light">
              registrada{suffix}
            </Badge>
          );
        }
        // cStat 136 — registered but not yet linked: pending, NOT an error (#81).
        if (m.estado === ESTADO_ENVI_NFE_MSG.aguardandoVinculo) {
          return (
            <Badge color="yellow" variant="light">
              aguardando vínculo{suffix}
            </Badge>
          );
        }
        return (
          <Badge color="red" variant="light">
            erro{suffix}
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
      renderActions={(m, id) =>
        m.estado === ESTADO_ENVI_NFE_MSG.concluido ? (
          <DownloadCceButton pedidoId={pedidoId} nfeId={nfeId} cceId={id} />
        ) : null
      }
    />
  );
}
