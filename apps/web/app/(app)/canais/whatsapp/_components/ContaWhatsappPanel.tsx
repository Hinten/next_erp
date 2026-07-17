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
import { useMemo, useState } from 'react';
import {
  Alert,
  Anchor,
  Badge,
  Button,
  Card,
  Divider,
  Group,
  Loader,
  Modal,
  PasswordInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';
import type { Integracao } from '@delfrance/schemas';
import { useDocSnapshot } from '@delfrance/data/hooks';

import { usePermission } from '@/lib/auth';
import { integracaoCollection } from '@/lib/data/integracaoCollection';
import { getFirebaseFirestore } from '@/lib/firebase/client';
import { showErrorNotification } from '@/lib/notifications/showErrorNotification';
import {
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
  useWhatsappClient,
} from '@/lib/whatsapp/client';

/** Shared mutation error → toast, keeping the Http/Network split of the token flow. */
function notifyMutationError(err: unknown, title: string, networkMessage: string): void {
  if (err instanceof WhatsappClientHttpError) {
    showErrorNotification({ title, message: err.message });
    return;
  }
  if (err instanceof WhatsappClientNetworkError) {
    showErrorNotification({ title, message: networkMessage });
    return;
  }
  throw err;
}

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

  // Read `verificado` live off the account doc (the client holds
  // PERM.integracao.read). The confirmar route flips it server-side, so this
  // onSnapshot updates on its own once the code checks out.
  const db = getFirebaseFirestore();
  const docRef = useMemo(
    () => integracaoCollection.docRef(db, {}, integracaoId),
    [db, integracaoId],
  );
  const contaDoc = useDocSnapshot<Integracao>(docRef);
  const verificado = contaDoc.data?.data.verificado === true;

  const [metodo, setMetodo] = useState<'SMS' | 'VOICE'>('SMS');
  const [codigoSolicitado, setCodigoSolicitado] = useState(false);
  const [codigo, setCodigo] = useState('');
  const [reverify, setReverify] = useState(false);
  const [pin, setPin] = useState('');
  const [deregisterOpen, deregisterModal] = useDisclosure(false);

  const healthQueryKey = ['whatsapp-health', integracaoId];

  const requestCode = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.requestCode(integracaoId, metodo);
    },
    onSuccess: () => {
      setCodigoSolicitado(true);
      notifications.show({ color: 'green', message: `Código enviado via ${metodo}.` });
    },
    onError: (err) => notifyMutationError(err, 'Falha ao solicitar o código', 'Falha de rede.'),
  });

  const confirmCode = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.verifyCode(integracaoId, codigo);
    },
    onSuccess: () => {
      setCodigo('');
      setCodigoSolicitado(false);
      setReverify(false);
      notifications.show({ color: 'green', message: 'Número verificado.' });
      void queryClient.invalidateQueries({ queryKey: healthQueryKey });
    },
    onError: (err) => notifyMutationError(err, 'Falha ao confirmar o código', 'Falha de rede.'),
  });

  const registerNumber = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.registerNumber(integracaoId, pin);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Número registrado.' });
      void queryClient.invalidateQueries({ queryKey: healthQueryKey });
    },
    onError: (err) => notifyMutationError(err, 'Falha ao registrar o número', 'Falha de rede.'),
    // Never leave a pin sitting in a form field longer than the request needs.
    onSettled: () => setPin(''),
  });

  const deregisterNumber = useMutation({
    mutationFn: async () => {
      if (!client) return;
      await client.deregisterNumber(integracaoId);
    },
    onSuccess: () => {
      notifications.show({ color: 'green', message: 'Número desregistrado.' });
      void queryClient.invalidateQueries({ queryKey: healthQueryKey });
    },
    onError: (err) => notifyMutationError(err, 'Falha ao desregistrar o número', 'Falha de rede.'),
    onSettled: () => deregisterModal.close(),
  });

  const connected = query.data?.connected === true;
  const hasToken = query.data?.hasToken === true;
  const phone = query.data?.phone ?? null;
  // A stored-but-not-live credential whose only gap is the número — an
  // informative (not scary) nudge to fill in the fields below, not an error.
  const numeroPending = hasToken && !connected && query.data?.reason === 'numero_nao_configurado';
  // The verification + PIN registration sub-flows only make sense once a token
  // exists and the número is in place.
  const showRegistration = hasToken && !numeroPending;

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

        {showRegistration && (
          <>
            <Divider label="Verificação do número" labelPosition="left" />
            {verificado && !reverify ? (
              <Group gap="sm">
                <Badge color="green">Número verificado</Badge>
                <Anchor
                  component="button"
                  type="button"
                  size="xs"
                  c="dimmed"
                  onClick={() => setReverify(true)}
                >
                  Verificar novamente
                </Anchor>
              </Group>
            ) : (
              <Stack gap="xs">
                <SegmentedControl
                  value={metodo}
                  onChange={(v) => setMetodo(v === 'VOICE' ? 'VOICE' : 'SMS')}
                  data={[
                    { label: 'SMS', value: 'SMS' },
                    { label: 'Chamada', value: 'VOICE' },
                  ]}
                  disabled={!canWrite || !client}
                />
                <Group gap="sm">
                  <Button
                    type="button"
                    variant="light"
                    onClick={() => requestCode.mutate()}
                    loading={requestCode.isPending}
                    disabled={!canWrite || !client}
                  >
                    Solicitar código
                  </Button>
                </Group>
                {codigoSolicitado && (
                  <Stack gap="xs">
                    <TextInput
                      label="Código de verificação"
                      placeholder="6 dígitos"
                      value={codigo}
                      onChange={(e) =>
                        setCodigo(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))
                      }
                      disabled={!canWrite || !client}
                    />
                    <Group gap="sm">
                      <Button
                        type="button"
                        onClick={() => confirmCode.mutate()}
                        loading={confirmCode.isPending}
                        disabled={!canWrite || !client || codigo.length !== 6}
                      >
                        Confirmar
                      </Button>
                      <Button
                        type="button"
                        variant="subtle"
                        onClick={() => requestCode.mutate()}
                        loading={requestCode.isPending}
                        disabled={!canWrite || !client}
                      >
                        Reenviar
                      </Button>
                    </Group>
                  </Stack>
                )}
              </Stack>
            )}

            <Divider label="Registro (PIN)" labelPosition="left" />
            <Stack gap="xs">
              <PasswordInput
                label="PIN de verificação em duas etapas"
                description="6 dígitos. Usado para registrar o número na API do WhatsApp Cloud."
                placeholder="••••••"
                value={pin}
                onChange={(e) => setPin(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                disabled={!canWrite || !client}
              />
              <Group gap="sm">
                <Button
                  type="button"
                  onClick={() => registerNumber.mutate()}
                  loading={registerNumber.isPending}
                  disabled={!canWrite || !client || pin.length !== 6}
                >
                  Registrar número
                </Button>
                <Button
                  type="button"
                  color="red"
                  variant="light"
                  onClick={deregisterModal.open}
                  disabled={!canWrite || !client}
                >
                  Desregistrar
                </Button>
              </Group>
            </Stack>
          </>
        )}
      </Stack>

      <Modal
        opened={deregisterOpen}
        onClose={deregisterModal.close}
        title="Desregistrar número"
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            Isso desregistra o número na API do WhatsApp Cloud. O PIN salvo é mantido para um
            eventual novo registro. Deseja continuar?
          </Text>
          <Group justify="flex-end" gap="sm">
            <Button type="button" variant="default" onClick={deregisterModal.close}>
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              onClick={() => deregisterNumber.mutate()}
              loading={deregisterNumber.isPending}
            >
              Desregistrar
            </Button>
          </Group>
        </Stack>
      </Modal>
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
