'use client';

import { Text } from '@mantine/core';
import { PERM } from '@delfrance/auth';

import { ConnectionPanel } from '@/components/oauth/ConnectionPanel';
import { type MercadoPagoConta, useMercadoPagoClient } from '@/lib/mercado-pago/client';
import {
  MERCADO_PAGO_OAUTH_TOAST,
  describeMercadoPagoConnectFailure,
  describeMercadoPagoContaFailure,
} from './mercadoPagoOAuthErrors';

/**
 * Mercado Pago account panel on /pagamentos/mercado-pago/[id] — shows the
 * connection status (`/users/me`) and a Conectar / Reautenticar button that
 * kicks off the server-side OAuth flow on the mercado-pago payments backend.
 * Mounted beside the metodo_pgto editor. The browser never sees a Mercado
 * Pago access/refresh token.
 *
 * The card itself is `ConnectionPanel` (#563), shared with Mercado Livre and
 * Melhor Envio; everything below is this channel's configuration. The
 * `oauth/start` route is `PERM.metodoPagamento.write`-gated, so the button is
 * gated by the same bit — a viewer is not offered an action that will 403.
 */
export function ContaMercadoPagoPanel({ metodoId }: { metodoId: string }) {
  const client = useMercadoPagoClient();

  return (
    <ConnectionPanel<MercadoPagoConta>
      title="Conta Mercado Pago"
      contaId={metodoId}
      client={client}
      queryKey={['mercado-pago-conta', metodoId]}
      toast={MERCADO_PAGO_OAUTH_TOAST}
      permission={{
        bit: PERM.metodoPagamento.write,
        hint: 'Requer permissão de escrita em meios de pagamento.',
      }}
      describeContaFailure={describeMercadoPagoContaFailure}
      describeConnectFailure={describeMercadoPagoConnectFailure}
      renderConnected={(conta) =>
        conta.me && (
          <Text size="sm">
            {conta.me.nickname ?? `Coletor ${conta.me.id}`}
            {conta.me.email ? ` · ${conta.me.email}` : ''}
          </Text>
        )
      }
    />
  );
}
