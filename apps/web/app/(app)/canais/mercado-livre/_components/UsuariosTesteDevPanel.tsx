'use client';

import { useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PERM } from '@delfrance/auth';

import { usePermission } from '@/lib/auth';
import {
  MercadoLivreClientHttpError,
  type MercadoLivreUsuarioTeste,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';

/**
 * Build-time constant: Next inlines `process.env.NODE_ENV`, so the check in the
 * wrapper below folds to a constant rather than being evaluated per render.
 */
const IS_DEV = process.env.NODE_ENV !== 'production';

/**
 * Dev-only: mint the pair of Mercado Livre test users an end-to-end run needs.
 *
 * Mercado Livre has **no sandbox**. It hands out throwaway production accounts
 * through `POST /users/test_user`, capped at ten per real account, never listed
 * anywhere, and with the password shown exactly once. Doing that by hand means
 * pasting an access token into curl and not losing the response.
 *
 * ⚠️ **The mint is destructive to the conta it runs on.** On success the backend
 * deletes every OAuth credential of the account it used — deliberately, because
 * that account is a real seller account and must not stay wired to the ERP — so
 * pointed at the wrong conta it disconnects a live seller. Two guards live here
 * (a confirmation naming the account, and a checkbox that must be ticked); the
 * third and authoritative one is the backend's `MERCADO_LIVRE_TEST_USERS_ENABLED`.
 *
 * ⚠️ The `NODE_ENV` check is for DISCOVERABILITY ONLY and is not a security
 * guard: `apps/web` in local dev calls the DEPLOYED channel backend, so the
 * browser's notion of "dev" says nothing about which backend answers. It does
 * still have to be correct — see the wrapper below for why its POSITION matters.
 *
 * A backend without `MERCADO_LIVRE_TEST_USERS_ENABLED=1` answers 404. In
 * PRODUCTION that renders nothing (the wrapper returns first); in DEV it renders
 * {@link FlagDesligadaCard}, which names the variable — silence there cost a
 * debugging session, because an absent panel is indistinguishable from a feature
 * that was never built.
 *
 * ⚠️ **No hooks in this wrapper, deliberately.** The env check used to sit AFTER
 * the hooks, which does not do what it looks like it does: hooks run before any
 * early return, so a deployed `apps/web` (always `NODE_ENV=production`) still
 * fired `GET /usuarios-teste` at the channel backend on **every** Mercado Livre
 * conta page — a request that can only 404 and whose result can never be
 * rendered. Returning before the hooks exist is what makes "renders nothing in a
 * production build" actually true.
 */
export function UsuariosTesteDevPanel({ integracaoId }: { integracaoId: string }) {
  if (!IS_DEV) return null;
  return <UsuariosTestePanel integracaoId={integracaoId} />;
}

function UsuariosTestePanel({ integracaoId }: { integracaoId: string }) {
  const client = useMercadoLivreClient();
  const queryClient = useQueryClient();
  const { allowed: canWrite } = usePermission(PERM.integracao.write);
  const [confirming, setConfirming] = useState(false);
  const [entendido, setEntendido] = useState(false);

  const queryKey = ['mercado-livre-usuarios-teste', integracaoId];
  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.usuariosTeste(integracaoId);
    },
    enabled: Boolean(client),
    retry: mercadoLivreQueryRetry,
  });

  const mutation = useMutation({
    mutationFn: () => {
      if (!client) throw new Error('not ready');
      return client.criarUsuariosTeste(integracaoId);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(queryKey, { usuarios: result.usuarios });
      // The conta panel next door still shows "Conectada" from a cached read —
      // and it no longer is.
      void queryClient.invalidateQueries({ queryKey: ['mercado-livre-conta', integracaoId] });
      setConfirming(false);
      setEntendido(false);
      notifications.show({
        color: 'green',
        message:
          `${String(result.criados.length)} usuário(s) criado(s), ` +
          `${String(result.reaproveitados.length)} reaproveitado(s). ` +
          `A conta ${result.conta.nickname ?? String(result.conta.id)} foi desconectada ` +
          `(${String(result.credenciaisRemovidas)} credencial(is) removida(s)).`,
      });
    },
    onError: (err: unknown) => {
      notifications.show({
        color: 'red',
        message:
          err instanceof MercadoLivreClientHttpError
            ? err.message
            : 'Não foi possível criar os usuários de teste.',
      });
    },
  });

  // A backend without the flag answers 404 on both verbs. This branch only ever
  // runs in a dev build (the wrapper above returned already in production), so
  // it SAYS SO instead of rendering nothing: an off flag is indistinguishable
  // from a missing feature otherwise, and "no panel, no error" sends you reading
  // the component to find out why. Naming the variable is the whole point.
  if (query.error instanceof MercadoLivreClientHttpError && query.error.status === 404) {
    return <FlagDesligadaCard />;
  }

  const usuarios = query.data?.usuarios ?? [];
  // Anything that is NOT that 404 used to be swallowed: `usuarios` fell back to
  // `[]` and the panel said "Nenhum usuário de teste criado" — indistinguishable
  // from an unreachable backend, on the one screen whose whole job is to tell
  // you which users exist before you create more.
  const listaFailure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar os usuários de teste.',
          unknown: 'Não foi possível consultar os usuários de teste.',
        });
  const listaRetry = queryRetry(query);

  return (
    <Card withBorder padding="md" data-testid="ml-usuarios-teste-panel">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Usuários de teste (dev)</Text>
          <Badge color="orange" variant="light">
            Somente desenvolvimento
          </Badge>
        </Group>

        <Text size="sm" c="dimmed">
          O Mercado Livre não tem sandbox: os usuários de teste são contas reais de produção,
          limitadas a 10 por conta e sem recuperação de senha. Por isso as credenciais ficam
          guardadas aqui — é o único lugar onde elas existem depois da criação.
        </Text>

        {listaFailure && (
          <RetryAlert
            color="yellow"
            message={listaFailure.message}
            onRetry={listaFailure.retryable ? listaRetry.retry : undefined}
            retrying={listaRetry.retrying}
          />
        )}

        {usuarios.length > 0 ? (
          <Stack gap="xs" data-testid="ml-usuarios-teste-lista">
            {usuarios.map((u) => (
              <UsuarioTesteCard key={u.role} usuario={u} />
            ))}
          </Stack>
        ) : (
          // Suppressed while the read is failing: "nenhum criado" next to "não
          // foi possível consultar" is the exact contradiction the alert exists
          // to remove.
          !listaFailure && (
            <Text size="sm" c="dimmed">
              Nenhum usuário de teste criado para esta conta ainda.
            </Text>
          )
        )}

        <Group align="center" gap="sm">
          <Button
            type="button"
            color="orange"
            variant="light"
            onClick={() => {
              setConfirming(true);
            }}
            disabled={!client || !canWrite || usuarios.length >= 2}
            data-testid="ml-criar-usuarios-teste"
          >
            Criar usuários de teste
          </Button>
          {!canWrite && (
            <Text size="xs" c="dimmed">
              Requer permissão de escrita em integrações.
            </Text>
          )}
        </Group>
      </Stack>

      <Modal
        opened={confirming}
        onClose={() => {
          setConfirming(false);
          setEntendido(false);
        }}
        title="Criar usuários de teste e desconectar esta conta"
      >
        <Stack gap="sm" data-testid="ml-usuarios-teste-confirm">
          <Alert color="red" variant="light">
            Esta ação usa o token da conta conectada para criar um vendedor e um comprador de teste
            e, em seguida, <strong>apaga as credenciais OAuth desta conta</strong>. Ela ficará
            desconectada e precisará ser reconectada manualmente.
          </Alert>
          <Text size="sm">
            Cada usuário criado consome uma das <strong>10 vagas permanentes</strong> da conta real,
            e o Mercado Livre nunca mostra a senha de novo.
          </Text>
          <Checkbox
            checked={entendido}
            onChange={(e) => {
              setEntendido(e.currentTarget.checked);
            }}
            label="Entendi que esta conta será desconectada"
            data-testid="ml-usuarios-teste-entendido"
          />
          <Group justify="flex-end">
            <Button
              type="button"
              variant="default"
              onClick={() => {
                setConfirming(false);
                setEntendido(false);
              }}
            >
              Cancelar
            </Button>
            <Button
              type="button"
              color="red"
              disabled={!entendido}
              loading={mutation.isPending}
              onClick={() => {
                mutation.mutate();
              }}
              data-testid="ml-usuarios-teste-confirmar"
            >
              Criar e desconectar
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Card>
  );
}

/**
 * Shown in a DEV build when the backend 404s the route — i.e. it is running
 * without `MERCADO_LIVRE_TEST_USERS_ENABLED=1`.
 *
 * ⚠️ This exists because the previous behaviour was to render nothing, and an
 * absent panel with no error in the console reads as "the feature was never
 * built" rather than "one env var is unset". The 404 is deliberate on the
 * backend (the route must not admit it exists where the flag is off), so the
 * only place that can explain it is here.
 *
 * It deliberately does NOT assert the cause: a 404 also covers a backend
 * predating the route (a stale `pnpm dev`, or `NEXT_PUBLIC_MERCADO_LIVRE_URL`
 * still aimed at the deployed one). Both remedies are named.
 */
function FlagDesligadaCard() {
  return (
    <Card withBorder padding="md" data-testid="ml-usuarios-teste-flag-off">
      <Stack gap="xs">
        <Group justify="space-between">
          <Text fw={600}>Usuários de teste (dev)</Text>
          <Badge color="gray" variant="light">
            Desativado
          </Badge>
        </Group>
        <Alert color="yellow" variant="light">
          O backend do Mercado Livre respondeu <Code>404</Code> nesta rota, então a criação de
          usuários de teste está desligada aqui.
        </Alert>
        <Text size="sm">
          Para ligar: defina <Code>MERCADO_LIVRE_TEST_USERS_ENABLED=1</Code> no{' '}
          <Code>.env.local</Code> da raiz do repositório e <strong>reinicie</strong> o servidor de
          dev do <Code>@delfrance/mercado-livre-app</Code> — o Next lê o arquivo só na
          inicialização.
        </Text>
        <Text size="xs" c="dimmed">
          Se a variável já estiver definida, confira se <Code>NEXT_PUBLIC_MERCADO_LIVRE_URL</Code>{' '}
          aponta para o backend local (:3006) e não para o publicado, que não tem a flag.
        </Text>
      </Stack>
    </Card>
  );
}

/** One stored account, with everything needed to sign in as it on ML. */
function UsuarioTesteCard({ usuario }: { usuario: MercadoLivreUsuarioTeste }) {
  return (
    <Card withBorder padding="xs" radius="sm">
      <Stack gap={4}>
        <Group gap="xs">
          <Badge color={usuario.role === 'vendedor' ? 'blue' : 'grape'} variant="light">
            {usuario.role === 'vendedor' ? 'Vendedor' : 'Comprador'}
          </Badge>
          <Text size="sm" fw={600}>
            {usuario.nickname}
          </Text>
          <Text size="xs" c="dimmed">
            id {usuario.id} · {usuario.site_id}
            {usuario.site_status ? ` · ${usuario.site_status}` : ''}
          </Text>
        </Group>
        <Group gap="xs" align="center">
          <Text size="xs" c="dimmed">
            Senha:
          </Text>
          <Code>{usuario.password}</Code>
          <CopyButton value={usuario.password}>
            {({ copied, copy }) => (
              <Button size="compact-xs" variant="subtle" onClick={copy}>
                {copied ? 'Copiado' : 'Copiar'}
              </Button>
            )}
          </CopyButton>
        </Group>
        <Text size="xs" c="dimmed">
          {/* No inbox exists for these accounts — ML derives the code from the id. */}
          Código de verificação de e-mail: {usuario.codigosVerificacaoEmail.quatro} (4 dígitos) ou{' '}
          {usuario.codigosVerificacaoEmail.seis} (6 dígitos)
        </Text>
      </Stack>
    </Card>
  );
}
