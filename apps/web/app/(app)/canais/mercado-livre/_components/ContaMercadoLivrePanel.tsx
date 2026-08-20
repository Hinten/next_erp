'use client';

import { useState } from 'react';
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
import { describeMercadoLivreFailure, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { UsuariosTesteDevPanel } from './UsuariosTesteDevPanel';
import { useMercadoLivreCallbackToast } from './mercadoLivreOAuthErrors';

/**
 * Mercado Livre account panel on /canais/mercado-livre/[id] — shows the
 * connection status (`/users/me`) and a Conectar / Reautenticar button that
 * kicks off the server-side OAuth flow on apps/mercado-livre. Mounted beside
 * the integracao editor. The browser never sees a Mercado Livre token.
 * Mirrors the Melhor Envio ContaPanel.
 *
 * The two account-wide bulk jobs ("Importar todos os anúncios" #621 and
 * "Atualizar preços" Step 11 PR-D) used to live here; #816 moved them to the
 * channel list (`/canais/mercado-livre`), where they act on the table's
 * selection and can run for several contas at once. Their progress moved with
 * them, and deliberately does NOT get a read-only mirror here: the job docs
 * are admin-only/default-deny, so this page has no way to reach one — every
 * lookup is by conta, and the conta is exactly what the list already knows.
 */
export function ContaMercadoLivrePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();
  // The backend oauth/start route is PERM.integracao.write-gated — gate the
  // button by the same bit so a viewer isn't offered an action that will 403.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [connecting, setConnecting] = useState(false);

  // Toast the OAuth callback outcome (?ml=connected|error&reason=…). Shared with
  // the channel list, which the callback redirects to for the three failures that
  // happen before a trustworthy integração id exists.
  useMercadoLivreCallbackToast();

  const query = useQuery({
    queryKey: ['mercado-livre-conta', integracaoId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(integracaoId);
    },
    enabled: Boolean(client),
    retry: mercadoLivreQueryRetry,
  });

  const contaRetry = queryRetry(query);
  const contaFailure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar a conta.',
          unknown: 'Não foi possível consultar a conta.',
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

        {contaFailure && (
          <RetryAlert
            color="yellow"
            message={contaFailure.message}
            onRetry={contaFailure.retryable ? contaRetry.retry : undefined}
            retrying={contaRetry.retrying}
          />
        )}

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

        {/*
          Mounted inside the conta card because it acts ON this conta — and, on
          success, disconnects it. Renders nothing in a production build; in dev
          against a backend without MERCADO_LIVRE_TEST_USERS_ENABLED (which
          404s) it renders a card naming the variable, rather than vanishing.
        */}
        <UsuariosTesteDevPanel integracaoId={integracaoId} />
      </Stack>
    </Card>
  );
}
