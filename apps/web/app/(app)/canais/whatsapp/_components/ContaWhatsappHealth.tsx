'use client';

/**
 * "Saúde da conta" card on /canais/whatsapp/[id] — the account-health surface.
 * Queries `GET /api/whatsapp/health` (apps/whatsapp) and renders the aggregated
 * check rows plus the `canSend` / `canReceive` verdicts. Like `ContaWhatsappPanel`
 * it degrades gracefully when the backend is offline (query error → a yellow
 * alert), never breaking the page.
 */
import { ActionIcon, Alert, Badge, Card, Group, Loader, Stack, Text, Tooltip } from '@mantine/core';
import {
  IconAlertTriangle,
  IconCircleCheck,
  IconCircleX,
  IconMinus,
  IconRefresh,
} from '@tabler/icons-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  WhatsappClientHttpError,
  WhatsappClientNetworkError,
  useWhatsappClient,
  type WhatsappHealthCheck,
} from '@/lib/whatsapp/client';

function StatusIcon({ status }: { status: WhatsappHealthCheck['status'] }) {
  switch (status) {
    case 'ok':
      return <IconCircleCheck size={18} color="var(--mantine-color-green-6)" />;
    case 'warn':
      return <IconAlertTriangle size={18} color="var(--mantine-color-yellow-6)" />;
    case 'fail':
      return <IconCircleX size={18} color="var(--mantine-color-red-6)" />;
    case 'skip':
    default:
      return <IconMinus size={18} color="var(--mantine-color-gray-5)" />;
  }
}

function CheckRow({ check }: { check: WhatsappHealthCheck }) {
  return (
    <Group align="flex-start" gap="xs" wrap="nowrap">
      <div style={{ paddingTop: 2 }}>
        <StatusIcon status={check.status} />
      </div>
      <Stack gap={0}>
        <Text size="sm" fw={500}>
          {check.label}
        </Text>
        {check.detail && (
          <Text size="xs" c="dimmed">
            {check.detail}
          </Text>
        )}
        {check.hint && (
          <Text size="xs" c="dimmed" fs="italic">
            {check.hint}
          </Text>
        )}
      </Stack>
    </Group>
  );
}

/** `canReceive` is tri-state (true / false / null-indeterminate). */
function receiveBadge(canReceive: boolean | null) {
  if (canReceive === true) return <Badge color="green">Pode receber</Badge>;
  if (canReceive === false) return <Badge color="gray">Não pode receber</Badge>;
  return <Badge color="gray">Recebimento indeterminado</Badge>;
}

export function ContaWhatsappHealth({ integracaoId }: { integracaoId: string }) {
  const client = useWhatsappClient();
  const queryClient = useQueryClient();
  const queryKey = ['whatsapp-health', integracaoId];

  const query = useQuery({
    queryKey,
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.health(integracaoId);
    },
    enabled: Boolean(client),
    retry: false,
  });

  const health = query.data;

  return (
    <Card withBorder padding="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Text fw={600}>Saúde da conta</Text>
          <Group gap="xs">
            {query.isLoading && <Loader size="sm" />}
            {health && (
              <>
                <Badge color={health.canSend ? 'green' : 'gray'}>
                  {health.canSend ? 'Pode enviar' : 'Não pode enviar'}
                </Badge>
                {receiveBadge(health.canReceive)}
              </>
            )}
            <Tooltip label="Atualizar">
              <ActionIcon
                variant="subtle"
                aria-label="Atualizar saúde da conta"
                onClick={() => void queryClient.invalidateQueries({ queryKey })}
                loading={query.isFetching}
                disabled={!client}
              >
                <IconRefresh size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>

        {query.error != null && <HealthError error={query.error} />}

        {health && (
          <Stack gap="sm">
            {health.checks.map((check) => (
              <CheckRow key={check.id} check={check} />
            ))}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

/** Render a health query error as a degraded (yellow) alert. */
function HealthError({ error }: { error: unknown }) {
  const message =
    error instanceof WhatsappClientHttpError
      ? error.message
      : error instanceof WhatsappClientNetworkError
        ? 'Falha de rede ao consultar a saúde da conta.'
        : 'Não foi possível consultar a saúde da conta.';
  return (
    <Alert color="yellow" variant="light">
      {message}
    </Alert>
  );
}
