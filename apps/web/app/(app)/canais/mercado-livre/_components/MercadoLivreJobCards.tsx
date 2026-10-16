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
import { Alert, Anchor, Loader, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import {
  type MercadoLivreMassImportStatus,
  type MercadoLivrePriceSyncStatus,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { BaixarRelatorioButton } from '@/components/contaJobs/BaixarRelatorioButton';
import { JobCardShell } from '@/components/contaJobs/JobCardShell';
import { PriceSyncEntryList } from '@/components/contaJobs/PriceSyncEntryList';
import {
  describeMassImportCancelError,
  describePriceSyncCancelError,
  ERROS_DO_CLIENTE_ML,
} from './mercadoLivreJobErrors';
import { useBaixarRelatorioPreco } from './useBaixarRelatorioPreco';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';

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
      describeCancelError={describeMassImportCancelError}
      errosDoCliente={ERROS_DO_CLIENTE_ML}
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
  const relatorio = useBaixarRelatorioPreco();
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
  /**
   * ⚠️ The CSV is gated on the run being OVER, not on it having samples.
   * `temAmostras` is right for the skip/failure lists — there is nothing to show
   * without them — but it would be exactly wrong here: a run with zero skips and
   * zero failures is a run where every price moved, which is the report an
   * operator most wants. Gating the export on it would hide the best case.
   */
  const podeBaixar = data != null && data.status !== 'running';

  return (
    <JobCardShell
      conta={conta}
      flowLabel="Envio de preços"
      running={data?.status === 'running'}
      // Only a status we actually READ closes the confirm off. `data` is
      // undefined before the first poll lands, after a failed poll, and while
      // the client is null — none of which mean the job stopped.
      encerrado={data != null && data.status !== 'running'}
      onDismiss={onDismiss}
      cancelLabel="Cancelar envio"
      describeCancelError={describePriceSyncCancelError}
      errosDoCliente={ERROS_DO_CLIENTE_ML}
      onCancel={async () => {
        if (!client) throw new Error('not ready');
        await client.cancelPriceSync({ integracaoId: conta.id, jobId });
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
            {data.enviados} / {data.planejados} enviados · {data.pulados} pulados · {data.falhas}{' '}
            falhas
            {data.pausas > 0 ? ` · ${data.pausas} pausas` : ''}
          </Text>
          {/* #1072: anúncios the job could not have ENUMERATED — a different
              thing from a skip, and the reason "concluído" used to overstate
              itself. Rendered only when non-zero: the healthy case is silence. */}
          {data.naoEnumerados > 0 && (
            <Alert color="yellow" variant="light" p="xs">
              <Text size="xs">
                {data.naoEnumerados} anúncio{data.naoEnumerados === 1 ? '' : 's'} não enumerado
                {data.naoEnumerados === 1 ? '' : 's'} — o produto vinculado não entrou na busca.
                Veja os detalhes.
              </Text>
            </Alert>
          )}
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
          {/* Gray, not red: the operator asked for this. The counters above
              still show what did go out before the stop, and `podeBaixar`
              already lets them download the partial report. */}
          {data.status === 'cancelled' && (
            <Alert color="gray" variant="light" p="xs">
              <Text size="xs">Envio de preços cancelado.</Text>
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
          {podeBaixar && (
            <BaixarRelatorioButton
              jobId={jobId}
              contaId={conta.id}
              contaNome={conta.nome}
              baixar={relatorio.baixar}
              baixando={relatorio.baixando === jobId}
              pagina={relatorio.pagina}
            />
          )}
        </>
      )}
    </JobCardShell>
  );
}
