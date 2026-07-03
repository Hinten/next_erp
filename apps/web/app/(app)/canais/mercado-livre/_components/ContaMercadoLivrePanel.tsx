'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Alert, Badge, Button, Card, Group, Loader, Stack, Text } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQuery } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';

import { usePermission } from '@/lib/auth';
import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';

/**
 * Mercado Livre account panel on /canais/mercado-livre/[id] — shows the
 * connection status (`/users/me`) and a Conectar / Reautenticar button that
 * kicks off the server-side OAuth flow on apps/mercado-livre. Mounted beside
 * the integracao editor. The browser never sees a Mercado Livre token.
 * Mirrors the Melhor Envio ContaPanel.
 */
export function ContaMercadoLivrePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();
  // The backend oauth/start route is PERM.integracao.write-gated — gate the
  // button by the same bit so a viewer isn't offered an action that will 403.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [connecting, setConnecting] = useState(false);
  const searchParams = useSearchParams();

  // Toast the OAuth callback outcome (?ml=connected|error&reason=…).
  useEffect(() => {
    const ml = searchParams.get('ml');
    if (ml === 'connected') {
      notifications.show({ color: 'green', message: 'Conta Mercado Livre conectada.' });
    } else if (ml === 'error') {
      notifications.show({
        color: 'red',
        message: `Falha ao conectar a conta Mercado Livre (${searchParams.get('reason') ?? 'erro'}).`,
      });
    }
  }, [searchParams]);

  const query = useQuery({
    queryKey: ['mercado-livre-conta', integracaoId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(integracaoId);
    },
    enabled: Boolean(client),
    retry: false,
  });

  async function handleConnect() {
    if (!client) return;
    setConnecting(true);
    try {
      const { authorizeUrl } = await client.oauthStart(integracaoId);
      window.location.assign(authorizeUrl);
    } catch (err) {
      setConnecting(false);
      if (err instanceof MercadoLivreClientHttpError) {
        notifications.show({ color: 'red', message: err.message });
        return;
      }
      if (err instanceof MercadoLivreClientNetworkError) {
        notifications.show({ color: 'red', message: 'Falha de rede ao iniciar a conexão.' });
        return;
      }
      throw err;
    }
  }

  const connected = query.data?.connected === true;
  const me = query.data?.me ?? null;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Conta Mercado Livre</Text>
          {query.isLoading ? (
            <Loader size="sm" />
          ) : connected ? (
            <Badge color="green">Conectada</Badge>
          ) : (
            <Badge color="gray">Não conectada</Badge>
          )}
        </Group>

        {query.error != null && <ContaError error={query.error} />}

        {connected && me && (
          <Text size="sm">
            {me.nickname ?? `Usuário ${me.id}`}
            {me.email ? ` · ${me.email}` : ''}
          </Text>
        )}

        <Group align="center" gap="sm">
          <Button
            type="button"
            variant={connected ? 'light' : 'filled'}
            onClick={handleConnect}
            loading={connecting}
            disabled={!client || !canWrite}
          >
            {connected ? 'Reautenticar' : 'Conectar conta'}
          </Button>
          {!canWrite && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Group>
      </Stack>
    </Card>
  );
}

/** Render a conta query error, keeping unknown failures generic. */
function ContaError({ error }: { error: unknown }) {
  const message =
    error instanceof MercadoLivreClientHttpError
      ? error.message
      : error instanceof MercadoLivreClientNetworkError
        ? 'Falha de rede ao consultar a conta.'
        : 'Não foi possível consultar a conta.';
  return (
    <Alert color="yellow" variant="light">
      {message}
    </Alert>
  );
}
