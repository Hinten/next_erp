'use client';

import { Stack, Text } from '@mantine/core';
import { formatReais } from '@delfrance/core/money';
import type { FreightContaResult } from '@delfrance/integrations-freight-br/http-client';

import { ConnectionPanel } from '@/components/oauth/ConnectionPanel';
import { useFreightClient } from '@/lib/freight/client';
import {
  MELHOR_ENVIO_OAUTH_TOAST,
  describeMelhorEnvioConnectFailure,
  describeMelhorEnvioContaFailure,
} from './melhorEnvioOAuthErrors';

/**
 * Melhor Envio account panel on /logistica/melhor-envios/[id] — shows the
 * connection status (`/me` + `/balance`) and a Conectar / Reautenticar
 * button that kicks off the server-side OAuth flow. Mounted beside the
 * int_frete editor. The freight client talks only to apps/melhor-envio;
 * the browser never sees a ME token.
 *
 * The card itself is `ConnectionPanel` (#563), shared with Mercado Livre and
 * Mercado Pago; everything below is this channel's configuration.
 *
 * ⚠️ No `permission` prop, deliberately: this screen has never gated the button
 * on a bit — it disables it only while the client is `null` (logged out). That
 * is the behaviour, not an oversight to fix here; `ConnectionPanel`'s test pins
 * the no-gate case so it cannot drift into a silent gate.
 */
export function ContaPanel({ intFreteId }: { intFreteId: string }) {
  const client = useFreightClient();

  return (
    <ConnectionPanel<FreightContaResult>
      title="Conta Melhor Envio"
      contaId={intFreteId}
      client={client}
      queryKey={['melhor-envio-conta', intFreteId]}
      toast={MELHOR_ENVIO_OAUTH_TOAST}
      describeContaFailure={describeMelhorEnvioContaFailure}
      describeConnectFailure={describeMelhorEnvioConnectFailure}
      renderConnected={(conta) => (
        <Stack gap={2}>
          {conta.me && (
            <Text size="sm">
              {[conta.me.firstname, conta.me.lastname].filter(Boolean).join(' ')}
              {conta.me.email ? ` · ${conta.me.email}` : ''}
            </Text>
          )}
          {conta.balance?.balance != null && (
            <Text size="sm" c="dimmed">
              Saldo: {formatReais(conta.balance.balance)}
            </Text>
          )}
        </Stack>
      )}
    />
  );
}
