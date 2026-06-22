'use client';

/**
 * Etiqueta actions inside the `/pedidos` FreteCell HoverCard — buy-or-reprint,
 * dispatched by carrier `tipo` (Melhor Envio only in v1). Resolves the tipo
 * from the int_frete doc (cached, shared across rows on the same integração);
 * the buy's heavier cart resolution stays lazy in `EtiquetaComprarModal`.
 */
import { useMemo, useState } from 'react';
import { Button, Stack, Text } from '@mantine/core';
import { IconPrinter, IconShoppingCart, IconTruckDelivery } from '@tabler/icons-react';
import { type DocumentReference, getDoc } from 'firebase/firestore';
import { useQuery } from '@tanstack/react-query';
import type { IntegracaoFrete, Pedido } from '@delfrance/schemas';

import { dereferenceOuterRef } from '@/lib/data/dereferenceOuterRef';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { useFreightClient } from '@/lib/freight/client';
import { freightErrorMessage } from '@/lib/freight/errorMessage';
import {
  showCopyableNotification,
  showErrorNotification,
} from '@/lib/notifications/showErrorNotification';
import { etiquetaRowState } from './etiquetaActions';
import { EtiquetaComprarModal } from './EtiquetaComprarModal';

export function EtiquetaRowAction({ pedido, pedidoId }: { pedido: Pedido; pedidoId: string }) {
  const db = getFirebaseFirestore();
  const client = useFreightClient();
  const frete = pedido.freteInicial;

  const intRef = useMemo(
    () => dereferenceOuterRef(db, frete?.integracaoFreteOuterRef) as DocumentReference | null,
    [db, frete?.integracaoFreteOuterRef],
  );
  const intFreteId = intRef?.id ?? null;
  const { data: tipo } = useQuery<IntegracaoFrete | null>({
    queryKey: ['intFreteTipo', intRef?.path ?? null],
    enabled: intRef != null,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const snap = await getDoc(intRef!);
      return snap.exists() ? ((snap.data() as { tipo?: IntegracaoFrete }).tipo ?? null) : null;
    },
  });

  const [busy, setBusy] = useState<null | 'imprimir' | 'rastrear'>(null);
  const [comprarOpen, setComprarOpen] = useState(false);
  const printLabelId = frete?.printLabelId ?? null;

  const { action, needsPostedConfirm } = etiquetaRowState({
    tipo: tipo ?? null,
    printLabelId,
    externalOptionId: frete?.externalOptionId ?? null,
    estado: frete?.estado,
  });

  async function run(kind: 'imprimir' | 'rastrear') {
    if (!client || !intFreteId || !printLabelId) return;
    setBusy(kind);
    try {
      if (kind === 'imprimir') {
        const { url } = await client.imprimir(intFreteId, printLabelId);
        window.open(url, '_blank', 'noopener,noreferrer');
      } else {
        const { tracking } = await client.rastrear(intFreteId, printLabelId);
        showCopyableNotification({
          color: 'blue',
          title: 'Rastreio Melhor Envio',
          message: JSON.stringify(tracking, null, 2),
        });
      }
    } catch (err) {
      const msg = freightErrorMessage(err);
      if (msg === null) throw err;
      showErrorNotification({
        title: kind === 'imprimir' ? 'Falha ao imprimir etiqueta' : 'Falha ao rastrear',
        message: msg,
      });
    } finally {
      setBusy(null);
    }
  }

  if (action === 'none') return null;
  if (action === 'unsupported') {
    return (
      <Text size="xs" c="dimmed">
        Emissão de etiqueta para esta transportadora ainda não suportada.
      </Text>
    );
  }
  if (action === 'quote-first') {
    return (
      <Text size="xs" c="dimmed">
        Cote e selecione um frete no pedido para comprar a etiqueta.
      </Text>
    );
  }

  if (action === 'comprar') {
    return (
      <>
        <Button
          size="xs"
          leftSection={<IconShoppingCart size={14} />}
          onClick={() => setComprarOpen(true)}
          disabled={!client}
        >
          Comprar etiqueta
        </Button>
        <EtiquetaComprarModal
          opened={comprarOpen}
          onClose={() => setComprarOpen(false)}
          pedido={pedido}
          pedidoId={pedidoId}
          needsPostedConfirm={needsPostedConfirm}
        />
      </>
    );
  }

  // action === 'imprimir' — a bought label: reprint + track.
  return (
    <Stack gap="xs">
      {needsPostedConfirm && (
        <Text size="xs" c="orange">
          Frete já postado — reimprimir pode duplicar a etiqueta.
        </Text>
      )}
      <Button
        size="xs"
        variant="light"
        leftSection={<IconPrinter size={14} />}
        onClick={() => run('imprimir')}
        loading={busy === 'imprimir'}
        disabled={!client || busy !== null}
      >
        Imprimir etiqueta
      </Button>
      <Button
        size="xs"
        variant="light"
        leftSection={<IconTruckDelivery size={14} />}
        onClick={() => run('rastrear')}
        loading={busy === 'rastrear'}
        disabled={!client || busy !== null}
      >
        Rastrear
      </Button>
    </Stack>
  );
}
