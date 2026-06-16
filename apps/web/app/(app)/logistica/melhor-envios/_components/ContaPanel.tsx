'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import {
  FreightHttpError,
  FreightNetworkError,
} from '@delfrance/integrations-freight-br/http-client';

import { useFreightClient } from '@/lib/freight/client';

/**
 * Melhor Envio account panel on /logistica/melhor-envios/[id] — shows the
 * connection status (`/me` + `/balance`) and a Conectar / Reautenticar
 * button that kicks off the server-side OAuth flow. Mounted beside the
 * int_frete editor. The freight client talks only to apps/integrations;
 * the browser never sees a ME token.
 */
export function ContaPanel({ intFreteId }: { intFreteId: string }) {
  const client = useFreightClient();
  const [connecting, setConnecting] = useState(false);
  const searchParams = useSearchParams();

  // Toast the OAuth callback outcome (?me=connected|error&reason=…).
  useEffect(() => {
    const me = searchParams.get('me');
    if (me === 'connected') {
      notifications.show({ color: 'green', message: 'Conta Melhor Envio conectada.' });
    } else if (me === 'error') {
      notifications.show({
        color: 'red',
        message: `Falha ao conectar a conta Melhor Envio (${searchParams.get('reason') ?? 'erro'}).`,
      });
    }
  }, [searchParams]);

  const query = useQuery({
    queryKey: ['melhor-envio-conta', intFreteId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(intFreteId);
    },
    enabled: Boolean(client),
    retry: false,
  });

  async function handleConnect() {
    if (!client) return;
    setConnecting(true);
    try {
      const { authorizeUrl } = await client.oauthStart(intFreteId);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setConnecting(false);
      if (err instanceof FreightHttpError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      if (err instanceof FreightNetworkError) {
        notifications.show({ color: 'red', message: 'Falha de rede ao iniciar a conexão.' });
        return;
      }
      throw err;
    }
  }

  const connected = query.data?.connected === true;
  const me = query.data?.me ?? null;
  const balance = query.data?.balance?.balance ?? null;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Conta Melhor Envio</Text>
          {query.isLoading ? (
            <Loader size="sm" />
          ) : connected ? (
            <Badge color="green">Conectada</Badge>
          ) : (
            <Badge color="gray">Não conectada</Badge>
          )}
        </Group>

        {query.error && <ContaError error={query.error} />}

        {connected && (
          <Stack gap={2}>
            {me && (
              <Text size="sm">
                {[me.firstname, me.lastname].filter(Boolean).join(' ')}
                {me.email ? ` · ${me.email}` : ''}
              </Text>
            )}
            {balance != null && (
              <Text size="sm" c="dimmed">
                Saldo: R$ {balance.toFixed(2)}
              </Text>
            )}
          </Stack>
        )}

        <Group>
          <Button
            type="button"
            variant={connected ? 'light' : 'filled'}
            onClick={handleConnect}
            loading={connecting}
            disabled={!client}
          >
            {connected ? 'Reautenticar' : 'Conectar conta'}
          </Button>
        </Group>
      </Stack>
    </Card>
  );
}

/** Render a freight-conta query error, naming the configuration case. */
function ContaError({ error }: { error: unknown }) {
  const message =
    error instanceof FreightHttpError
      ? error.message
      : error instanceof FreightNetworkError
        ? 'Falha de rede ao consultar a conta.'
        : 'Não foi possível consultar a conta.';
  return (
    <Alert color="yellow" variant="light">
      {message}
    </Alert>
  );
}
