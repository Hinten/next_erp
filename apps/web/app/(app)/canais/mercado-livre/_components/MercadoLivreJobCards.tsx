'use client';

/**
 * The per-conta progress cards for the two Mercado Livre bulk jobs, lifted out
 * of `ContaMercadoLivrePanel` when #816 moved the actions to the channel
 * TableView. They now live in the table's right-hand action rail, so they are
 * built for ~300px: a conta heading, one counters line, the terminal alert —
 * and, for the price sync, its verbose skip/failure sample behind a
 * "Ver detalhes" modal instead of inline.
 *
 * Each card owns its own polling query. That is deliberate and not incidental:
 * the rail renders a DYNAMIC list of jobs and hooks cannot be looped, so one
 * component per job is the only shape that works. Polling stops on its own the
 * moment the job leaves `running`.
 */
import { useState } from 'react';
import { Alert, Anchor, Card, CloseButton, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import {
  type MercadoLivreMassImportStatus,
  type MercadoLivrePriceSyncSkip,
  type MercadoLivrePriceSyncStatus,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { mercadoLivreQueryErrorMessage } from './mercadoLivreJobErrors';
import type { ContaRef } from './startJobsForContas';

/** Poll cadence while a job is `running` (unchanged from the conta panel). */
const POLL_MS = 3000;

/** How many skip/failure sample entries the details modal lists before "+N mais". */
const PRICE_SYNC_LIST_LIMIT = 8;

/** Shared chrome: conta heading, flow label, running spinner, dismiss. */
function JobCardShell({
  conta,
  flowLabel,
  running,
  onDismiss,
  children,
}: {
  conta: ContaRef;
  flowLabel: string;
  running: boolean;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <Card withBorder padding="xs">
      <Stack gap={4}>
        <Group justify="space-between" wrap="nowrap" gap={4}>
          <Text size="sm" fw={600} lineClamp={1} title={conta.nome}>
            {conta.nome}
          </Text>
          <Group gap={4} wrap="nowrap">
            {running && <Loader size="xs" />}
            <CloseButton
              size="sm"
              aria-label={`Dispensar ${flowLabel} de ${conta.nome}`}
              onClick={onDismiss}
            />
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {flowLabel}
        </Text>
        {children}
      </Stack>
    </Card>
  );
}

/**
 * A conta whose job never started (409 already-running, a missing tabela
 * normal, a network failure). It sits in the same list as the progress cards
 * on purpose: with a multi-conta selection, "which account failed" is the
 * whole question, and a toast cannot answer it.
 */
export function ContaJobErrorCard({
  conta,
  flowLabel,
  color,
  message,
  onDismiss,
}: {
  conta: ContaRef;
  flowLabel: string;
  color: 'yellow' | 'red';
  message: string;
  onDismiss: () => void;
}) {
  return (
    <JobCardShell conta={conta} flowLabel={flowLabel} running={false} onDismiss={onDismiss}>
      <Alert color={color} variant="light" p="xs">
        <Text size="xs">{message}</Text>
      </Alert>
    </JobCardShell>
  );
}

export function MassImportJobCard({
  conta,
  jobId,
  initialStatus,
  onDismiss,
}: {
  conta: ContaRef;
  jobId: string;
  initialStatus?: MercadoLivreMassImportStatus;
  onDismiss: () => void;
}) {
  const client = useMercadoLivreClient();
  const query = useQuery({
    queryKey: ['ml-mass-import', conta.id, jobId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.massImportStatus({ integracaoId: conta.id, jobId });
    },
    enabled: Boolean(client),
    retry: false,
    initialData: initialStatus,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? POLL_MS : false),
  });

  const data = query.data;
  return (
    <JobCardShell
      conta={conta}
      flowLabel="Importação em massa"
      running={data?.status === 'running'}
      onDismiss={onDismiss}
    >
      {query.error != null ? (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">
            {mercadoLivreQueryErrorMessage(query.error, {
              network: 'Falha de rede ao consultar a importação.',
              unknown: 'Não foi possível consultar a importação.',
            })}
          </Text>
        </Alert>
      ) : !data ? (
        <Loader size="xs" />
      ) : (
        <>
          <Text size="xs">
            {data.scanned} encontrados · {data.imported} importados · {data.skipped} pulados ·{' '}
            {data.failureCount} falhas
          </Text>
          {data.status === 'completed' && (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">Importação concluída.</Text>
            </Alert>
          )}
          {data.status === 'failed' && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">Falha na importação{data.erro ? `: ${data.erro}` : '.'}</Text>
            </Alert>
          )}
        </>
      )}
    </JobCardShell>
  );
}

export function PriceSyncJobCard({
  conta,
  jobId,
  initialStatus,
  onDismiss,
}: {
  conta: ContaRef;
  jobId: string;
  initialStatus?: MercadoLivrePriceSyncStatus;
  onDismiss: () => void;
}) {
  const client = useMercadoLivreClient();
  const [detalhesOpened, setDetalhesOpened] = useState(false);
  const query = useQuery({
    queryKey: ['ml-price-sync', conta.id, jobId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.priceSyncStatus({ integracaoId: conta.id, jobId });
    },
    enabled: Boolean(client),
    retry: false,
    initialData: initialStatus,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? POLL_MS : false),
  });

  const data = query.data;
  const temAmostras = (data?.skips.length ?? 0) > 0 || (data?.failures.length ?? 0) > 0;

  return (
    <JobCardShell
      conta={conta}
      flowLabel="Envio de preços"
      running={data?.status === 'running'}
      onDismiss={onDismiss}
    >
      {query.error != null ? (
        <Alert color="yellow" variant="light" p="xs">
          <Text size="xs">
            {mercadoLivreQueryErrorMessage(query.error, {
              network: 'Falha de rede ao consultar o envio de preços.',
              unknown: 'Não foi possível consultar o envio de preços.',
            })}
          </Text>
        </Alert>
      ) : !data ? (
        <Loader size="xs" />
      ) : (
        <>
          <Text size="xs">
            {data.enviados} / {data.planejados} enviados · {data.pulados} pulados · {data.falhas}{' '}
            falhas
            {data.pausas > 0 ? ` · ${data.pausas} pausas` : ''}
          </Text>
          {data.status === 'completed' && (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">Envio de preços concluído.</Text>
            </Alert>
          )}
          {data.status === 'failed' && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">Falha no envio de preços{data.erro ? `: ${data.erro}` : '.'}</Text>
            </Alert>
          )}
          {temAmostras && (
            <>
              {/* The per-item samples are monospace ids: unreadable in a 300px
                  rail, so they live one click away instead of being clipped. */}
              <Anchor
                component="button"
                type="button"
                size="xs"
                onClick={() => setDetalhesOpened(true)}
              >
                Ver detalhes
              </Anchor>
              <Modal
                opened={detalhesOpened}
                onClose={() => setDetalhesOpened(false)}
                title={`Envio de preços — ${conta.nome}`}
                centered
              >
                <Stack gap="sm">
                  <PriceSyncEntryList label="Pulados" entries={data.skips} total={data.pulados} />
                  <PriceSyncEntryList label="Falhas" entries={data.failures} total={data.falhas} />
                </Stack>
              </Modal>
            </>
          )}
        </>
      )}
    </JobCardShell>
  );
}

/**
 * Compact dimmed-monospace list of a price-sync job's skip/failure sample.
 * `total` is the exact counter (`pulados`/`falhas`) — the entries themselves
 * are a server-capped sample, so the "+N mais" tail counts against it.
 */
function PriceSyncEntryList({
  label,
  entries,
  total,
}: {
  label: string;
  entries: Array<MercadoLivrePriceSyncSkip & { error?: string }>;
  total: number;
}) {
  if (entries.length === 0) return null;
  const shown = entries.slice(0, PRICE_SYNC_LIST_LIMIT);
  const rest = total - shown.length;
  return (
    <Stack gap={0}>
      <Text size="xs" c="dimmed" fw={500}>
        {label}
      </Text>
      {shown.map((entry, i) => (
        <Text key={`${entry.itemId ?? entry.produtoId}-${i}`} size="xs" c="dimmed" ff="monospace">
          {entry.itemId ?? entry.produtoId} · {entry.code}
          {entry.error ? ` · ${errorSnippet(entry.error)}` : ''}
        </Text>
      ))}
      {rest > 0 && (
        <Text size="xs" c="dimmed">
          +{rest} mais
        </Text>
      )}
    </Stack>
  );
}

/**
 * Keep a failure's error text a one-line snippet in the compact list —
 * whitespace (incl. newlines from stack-trace-shaped backend errors) collapses
 * to single spaces before the length cap.
 */
function errorSnippet(error: string): string {
  const oneLine = error.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}
