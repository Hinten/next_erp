'use client';

/**
 * WhatsApp account panel on /canais/whatsapp/[id] — shows the connection
 * status (the Cloud API phone-number identity) and a permanent-token form.
 * Mounted beside the integracao editor, mirroring `ContaMercadoPagoPanel` —
 * but WhatsApp Cloud API has no OAuth flow, so instead of a "Conectar"
 * redirect this panel POSTs a pasted token straight to the backend
 * (`/api/whatsapp/token`), which stores it in the admin-only
 * `credenciaisWhatsapp` subcollection. The token is cleared from the input
 * the moment the request settles — it is never re-displayed, logged, or kept
 * in any state beyond the transient controlled input.
 */
import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  PasswordInput,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';

import { usePermission } from '@/lib/auth';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import {
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
  useWhatsappClient,
} from '@/lib/whatsapp/client';

export function ContaWhatsappPanel({ integracaoId }: { integracaoId: string }) {
  const client = useWhatsappClient();
  const queryClient = useQueryClient();
  // The backend token route is PERM.integracao.write-gated — gate the form
  // by the same bit so a viewer isn't offered an action that will 403.
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [token, setToken] = useState('');

  const contaQueryKey = ['whatsapp-conta', integracaoId];

  const query = useQuery({
    queryKey: contaQueryKey,
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.conta(integracaoId);
    },
    enabled: Boolean(client),
    retry: false,
  });

  const saveToken = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.setToken(integracaoId, token);
    },
    onSuccess: () => {
      setToken('');
      notifications.show({ color: 'green', message: 'Token salvo com sucesso.' });
      void queryClient.invalidateQueries({ queryKey: contaQueryKey });
    },
    onError: (err) => {
      // Clear the input on failure too — never leave a permanent token
      // sitting in a form field longer than the request needs it.
      setToken('');
      if (err instanceof WhatsappClientHttpError) {
        showErrorNotification({ title: 'Falha ao salvar o token', message: err.message });
        return;
      }
      if (err instanceof WhatsappClientNetworkError) {
        showErrorNotification({
          title: 'Falha ao salvar o token',
          message: 'Falha de rede ao salvar o token.',
        });
        return;
      }
      throw err;
    },
  });

  const revoke = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.revokeToken(integracaoId);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Token revogado.' });
      void queryClient.invalidateQueries({ queryKey: contaQueryKey });
    },
    onError: (err) => {
      if (err instanceof WhatsappClientHttpError) {
        showErrorNotification({ title: 'Falha ao revogar o token', message: err.message });
        return;
      }
      if (err instanceof WhatsappClientNetworkError) {
        showErrorNotification({
          title: 'Falha ao revogar o token',
          message: 'Falha de rede ao revogar o token.',
        });
        return;
      }
      throw err;
    },
  });

  const connected = query.data?.connected === true;
  const hasToken = query.data?.hasToken === true;
  const phone = query.data?.phone ?? null;
  // A stored-but-not-live credential whose only gap is the número — an
  // informative (not scary) nudge to fill in the fields below, not an error.
  const numeroPending = hasToken && !connected && query.data?.reason === 'numero_nao_configurado';

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Conta WhatsApp</Text>
          {query.isLoading ? (
            <Loader size="sm" />
          ) : connected ? (
            <Badge color="green">Conectada</Badge>
          ) : (
            <Badge color="gray">Não conectada</Badge>
          )}
        </Group>

        {query.error != null && <ContaError error={query.error} />}

        {connected && phone && (
          <Text size="sm">
            {phone.verified_name ?? 'Número verificado'}
            {phone.display_phone_number ? ` · ${phone.display_phone_number}` : ''}
          </Text>
        )}

        {numeroPending && (
          <Alert color="blue" variant="light">
            Token salvo. Falta preencher o número (campos abaixo) para concluir a conexão.
          </Alert>
        )}

        <Stack gap={4}>
          <PasswordInput
            label="Token permanente"
            description="Gerado no painel de apps do Meta para a API do WhatsApp Business Cloud. Nunca é reexibido depois de salvo."
            placeholder="EAAG..."
            value={token}
            onChange={(e) => setToken(e.currentTarget.value)}
            disabled={!canWrite || !client}
          />
          <Group gap="sm">
            <Button
              type="button"
              onClick={() => saveToken.mutate()}
              loading={saveToken.isPending}
              disabled={!canWrite || !client || token.length === 0}
            >
              Salvar token
            </Button>
            <Button
              type="button"
              color="red"
              variant="light"
              onClick={() => revoke.mutate()}
              loading={revoke.isPending}
              // Gate on hasToken, NOT connected: a dead/expired (or número-less)
              // credential is not "connected" yet must still be clearable.
              disabled={!canWrite || !client || !hasToken}
            >
              Revogar
            </Button>
          </Group>
          {!canWrite && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

/** Render a conta query error, keeping unknown failures generic. */
function ContaError({ error }: { error: unknown }) {
  const message =
    error instanceof WhatsappClientHttpError
      ? error.message
      : error instanceof WhatsappClientNetworkError
        ? 'Falha de rede ao consultar a conta.'
        : 'Não foi possível consultar a conta.';
  return (
    <Alert color="yellow" variant="light">
      {message}
    </Alert>
  );
}
