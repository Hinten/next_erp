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
import { type ReactNode, useState } from 'react';
import {
  Alert,
  Anchor,
  Button,
  Card,
  CloseButton,
  Group,
  Loader,
  Modal,
  Stack,
  Text,
} from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import {
  MercadoLivreClientHttpError,
  MercadoLivreClientNetworkError,
  type MercadoLivreMassImportStatus,
  type MercadoLivrePriceSyncSkip,
  type MercadoLivrePriceSyncStatus,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { describeMassImportCancelError } from './mercadoLivreJobErrors';
import type { ContaRef } from './startJobsForContas';

/** Poll cadence while a job is `running` (unchanged from the conta panel). */
const POLL_MS = 3000;

/*
  ⚠️ Both cards keep `retry: false` while every other Mercado Livre read moved to
  `mercadoLivreQueryRetry`. The next tick IS their retry, and 400ms→4s backoff
  against a 3s interval stacks overlapping fetches on a backend that is already
  down, multiplied by every card in the rail.

  What the pollers were missing is the manual button. A card started this session
  carries no `initialStatus`, so when the FIRST poll fails `data` is undefined,
  the interval evaluates to `false`, and polling never resumes — the operator
  loses the handle on a job still running server-side. The button revives it:
  query-core recomputes the interval on every query state change
  (`onQueryUpdate` → `#updateTimers` → `#computeRefetchInterval`, verified in
  5.100.10), so one successful refetch returning `running` restarts the timer.
*/

/** How many skip/failure sample entries the details modal lists before "+N mais". */
const PRICE_SYNC_LIST_LIMIT = 8;

/**
 * Shared chrome: conta heading, flow label, running spinner, dismiss.
 *
 * ⚠️ Dismissing is NOT cancelling, and the two used to be indistinguishable:
 * the X removed the card while the job kept running server-side, and the
 * `dismissedJobIds` blacklist then kept the running-job lookup from bringing it
 * back. A flow that can be stopped passes `onCancel`, and the X then asks which
 * one the operator meant instead of guessing — unless the job is KNOWN to have
 * finished, in which case there is nothing to ask about. See `encerrado`.
 */
function JobCardShell({
  conta,
  flowLabel,
  running,
  encerrado = false,
  onDismiss,
  onCancel,
  cancelLabel,
  children,
}: {
  conta: ContaRef;
  flowLabel: string;
  /** Drives the spinner only — a card with no data yet is not "running". */
  running: boolean;
  /**
   * The job is KNOWN to have reached a terminal state. Gates the confirm, and
   * deliberately not `!running`.
   *
   * ⚠️ `running` is false whenever the status query has no data — a card started
   * this session carries no `initialStatus` until its first poll lands, the poll
   * can fail (these queries keep `retry: false`), and the query does not run at
   * all while `client` is null. Gating on `running` therefore sent the X down
   * the silent-dismiss branch in exactly the states where the operator is most
   * likely to press it, blacklisting the `jobId` for the session — the failure
   * this confirm exists to remove. Unknown is treated as possibly-running: the
   * worst case is a cancel that answers 409 and says so.
   */
  encerrado?: boolean;
  onDismiss: () => void;
  /**
   * Stops the job server-side. Omitted = this flow has no cancel yet, and the X
   * keeps its original dismiss-only behaviour. A rejection is shown in the
   * confirm itself and never rethrown — see `handleCancel`.
   */
  onCancel?: () => Promise<void>;
  /** Copy for the destructive button, e.g. "Cancelar importação". */
  cancelLabel?: string;
  children: ReactNode;
}) {
  const [confirmOpened, setConfirmOpened] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelErro, setCancelErro] = useState<string | null>(null);
  const podeCancelar = onCancel != null && !encerrado;

  /**
   * Every close path goes through here. `cancelErro` is scoped to ONE attempt:
   * left standing it greets the operator the next time they open the confirm,
   * reading as a fresh failure of a click they have not made yet.
   */
  function fecharConfirm() {
    setConfirmOpened(false);
    setCancelErro(null);
  }

  async function handleCancel() {
    if (!onCancel) return;
    setCancelling(true);
    setCancelErro(null);
    try {
      await onCancel();
      setConfirmOpened(false);
      // Deliberately NOT dismissed: the card stays so its next poll shows
      // "Importação cancelada", which is the only confirmation the operator
      // gets that the click reached the server.
    } catch (err) {
      // ⚠️ Nothing may rethrow out of here. This is an ASYNC click handler, so a
      // throw becomes an unhandled promise rejection — React error boundaries do
      // not catch those — and the operator would see the spinner stop with the
      // modal still open and nothing said at all. The reachable case is
      // `onCancel` throwing a plain Error when the client is null.
      //
      // `describeMassImportCancelError` always returns copy, so the guard here
      // exists only to decide what reaches the console — and to satisfy rule 6's
      // lint rule, which reads the catch body rather than the helper it calls.
      if (
        !(err instanceof MercadoLivreClientHttpError) &&
        !(err instanceof MercadoLivreClientNetworkError)
      ) {
        // Not a client failure at all — keep the original where it can be read.
        console.error('[mercado-livre] cancelamento da importação falhou', err);
      }
      setCancelErro(describeMassImportCancelError(err));
    } finally {
      setCancelling(false);
    }
  }

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
              onClick={() => (podeCancelar ? setConfirmOpened(true) : onDismiss())}
            />
          </Group>
        </Group>
        <Text size="xs" c="dimmed">
          {flowLabel}
        </Text>
        {children}
      </Stack>
      {podeCancelar && (
        <Modal
          opened={confirmOpened}
          onClose={fecharConfirm}
          title={`${flowLabel} — ${conta.nome}`}
          centered
        >
          <Stack gap="sm">
            {/* Deliberately does not assert that it IS running: the confirm also
                shows while the status is still unknown (see `encerrado`). */}
            <Text size="sm">Fechar o cartão não interrompe o job — ele segue no servidor.</Text>
            {cancelErro != null && (
              <Alert color="red" variant="light" p="xs">
                <Text size="xs">{cancelErro}</Text>
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" size="xs" onClick={fecharConfirm}>
                Voltar
              </Button>
              <Button
                variant="default"
                size="xs"
                onClick={() => {
                  fecharConfirm();
                  onDismiss();
                }}
              >
                Apenas ocultar
              </Button>
              <Button color="red" size="xs" loading={cancelling} onClick={handleCancel}>
                {cancelLabel ?? 'Cancelar'}
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
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
  const retry = queryRetry(query);
  const failure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar a importação.',
          unknown: 'Não foi possível consultar a importação.',
        });
  return (
    <JobCardShell
      conta={conta}
      flowLabel="Importação em massa"
      running={data?.status === 'running'}
      // Only a status we actually READ closes the confirm off. `data` is
      // undefined before the first poll lands, after a failed poll, and while
      // the client is null — none of which mean the job stopped.
      encerrado={data != null && data.status !== 'running'}
      onDismiss={onDismiss}
      cancelLabel="Cancelar importação"
      onCancel={async () => {
        if (!client) throw new Error('not ready');
        await client.cancelMassImport({ integracaoId: conta.id, jobId });
        // Show the terminal state now rather than waiting out the poll window.
        await query.refetch();
      }}
    >
      {failure ? (
        <RetryAlert
          variant="compact"
          color="yellow"
          message={failure.message}
          onRetry={failure.retryable ? retry.retry : undefined}
          retrying={retry.retrying}
        />
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
          {data.status === 'cancelled' && (
            <Alert color="gray" variant="light" p="xs">
              {/* The counters above still show what it managed to import — a
                  cancel keeps its work, it does not roll anything back. */}
              <Text size="xs">Importação cancelada.</Text>
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
  const retry = queryRetry(query);
  const failure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar o envio de preços.',
          unknown: 'Não foi possível consultar o envio de preços.',
        });
  const temAmostras = (data?.skips.length ?? 0) > 0 || (data?.failures.length ?? 0) > 0;

  return (
    <JobCardShell
      conta={conta}
      flowLabel="Envio de preços"
      running={data?.status === 'running'}
      onDismiss={onDismiss}
    >
      {failure ? (
        <RetryAlert
          variant="compact"
          color="yellow"
          message={failure.message}
          onRetry={failure.retryable ? retry.retry : undefined}
          retrying={retry.retrying}
        />
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
