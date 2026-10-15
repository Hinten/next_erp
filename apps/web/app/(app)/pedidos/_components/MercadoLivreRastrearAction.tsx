'use client';

import { useRef, useState } from 'react';
import { Anchor, Button, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { IconTruckDelivery } from '@tabler/icons-react';
import { PERM } from '@delfrance/auth';
import { usePermission } from '@/lib/auth/usePermission';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { mercadoLivreErrorMessage } from '@/lib/mercado-livre/errors';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import type { EtiquetaAcaoContextValue } from './EtiquetaAcaoHost';

export function MercadoLivreRastrearAction({
  pedidoId,
  shipmentId,
  acoes,
  size = 'sm',
}: {
  pedidoId?: string;
  shipmentId?: string | null;
  /** The table's page-level host outlives its freight HoverCard. */
  acoes?: EtiquetaAcaoContextValue;
  size?: 'xs' | 'sm';
}) {
  const client = useMercadoLivreClient();
  const permission = usePermission(PERM.frete.read);
  const emVoo = useRef(false);
  const [busy, setBusy] = useState(false);
  const acaoAtual = pedidoId == null ? null : acoes?.emAndamento(pedidoId);
  const loading = acoes ? acaoAtual === 'rastrear' : busy;
  const disabled =
    !permission.allowed ||
    permission.loading ||
    !client ||
    !pedidoId ||
    !shipmentId?.trim() ||
    busy ||
    acaoAtual != null;

  async function rastrear() {
    if (!client || !pedidoId || disabled || emVoo.current) return;
    emVoo.current = true;
    setBusy(true);
    // Opening after an await loses the click's user activation. Do not pass
    // `noopener` here: it returns null instead of the handle needed to navigate.
    const aba = window.open('', '_blank');
    if (aba) aba.opener = null;
    try {
      const { url, name } = await client.rastrear(pedidoId);
      if (aba && !aba.closed) {
        aba.location.replace(url);
      } else {
        // Global notification survives the row unmounting, unlike a local link.
        notifications.show({
          title: 'Rastreio Mercado Livre',
          color: 'blue',
          autoClose: false,
          message: (
            <Stack gap={4}>
              <Text size="sm">Abra o rastreamento pelo link abaixo.</Text>
              <Anchor href={url} target="_blank" rel="noopener noreferrer">
                {name ? `Rastrear com ${name}` : 'Abrir rastreamento'}
              </Anchor>
            </Stack>
          ),
        });
      }
    } catch (err) {
      if (aba && !aba.closed) aba.close();
      if (err instanceof MercadoLivreClientHttpError && err.code === 'ML_RASTREIO_INDISPONIVEL') {
        notifications.show({ color: 'blue', message: 'Rastreamento ainda indisponível.' });
        return;
      }
      if (
        err instanceof MercadoLivreClientHttpError ||
        err instanceof MercadoLivreClientNetworkError
      ) {
        showErrorNotification({
          title: 'Falha ao rastrear',
          message: mercadoLivreErrorMessage(err, {
            unknown: 'Não foi possível obter o rastreamento.',
          }),
        });
        return;
      }
      throw err;
    } finally {
      emVoo.current = false;
      setBusy(false);
    }
  }

  function iniciar() {
    if (disabled || emVoo.current || !pedidoId) return;
    if (acoes) void acoes.executar(pedidoId, 'rastrear', rastrear);
    else void rastrear();
  }

  return (
    <Button
      type="button"
      size={size}
      variant="light"
      leftSection={<IconTruckDelivery size={16} />}
      onClick={iniciar}
      loading={loading}
      disabled={disabled}
    >
      Rastrear
    </Button>
  );
}
