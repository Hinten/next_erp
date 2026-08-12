'use client';

import { Alert, List, Stack } from '@mantine/core';
import { IconAlertTriangle, IconInfoCircle, IconReceipt2 } from '@tabler/icons-react';
import { TIPO_INCIDENTE_LABELS, type Incidente } from '@delfrance/schemas';
import type { CheckoutData } from '@/lib/checkout/loadPedidoCheckout';

export interface CheckoutBannersProps {
  observacoesInternas: string | null;
  existingCheckout: CheckoutData['existingCheckout'];
  incidentes: readonly Incidente[];
}

function formatMs(ms: number | null): string {
  if (ms == null) return 'data desconhecida';
  return new Date(ms).toLocaleString('pt-BR');
}

/**
 * The warning banners shown above the scan area once a pedido loads (port of the
 * legacy `_init` warnings): the operator-facing internal observations, an
 * already-has-a-checkout notice, and any open incidentes. Each is best-effort
 * informational — none blocks scanning (the save gates do the blocking).
 */
export function CheckoutBanners({
  observacoesInternas,
  existingCheckout,
  incidentes,
}: CheckoutBannersProps) {
  const obs = observacoesInternas?.trim();
  const hasObs = !!obs;
  const hasIncidentes = incidentes.length > 0;
  if (!hasObs && !existingCheckout && !hasIncidentes) return null;

  return (
    <Stack gap="xs">
      {hasObs && (
        <Alert
          color="orange"
          variant="light"
          icon={<IconAlertTriangle size={18} />}
          title="Observações internas"
        >
          {obs}
        </Alert>
      )}
      {existingCheckout && (
        <Alert
          color="yellow"
          variant="light"
          icon={<IconReceipt2 size={18} />}
          title="Checkout já existente"
        >
          Este pedido já possui um checkout salvo em {formatMs(existingCheckout.timestampMs)}.
          Salvar novamente será bloqueado.
        </Alert>
      )}
      {hasIncidentes && (
        <Alert
          color="red"
          variant="light"
          icon={<IconInfoCircle size={18} />}
          title="Pedido com incidentes"
        >
          <List size="sm">
            {incidentes.map((inc, i) => (
              <List.Item key={i}>
                {TIPO_INCIDENTE_LABELS[inc.tipo]}
                {inc.motivoDoIncidente ? ` — ${inc.motivoDoIncidente}` : ''}
              </List.Item>
            ))}
          </List>
        </Alert>
      )}
    </Stack>
  );
}
