'use client';

/**
 * The conta's PAST "Atualizar preços" runs (`GET atualizar-precos/historico`).
 *
 * Why it exists: the job docs were always durable and are never deleted, but
 * nothing could reach a FINISHED one. `jobs-em-andamento` — which repaints the
 * rail's cards after a reload or a navigation — is running-only by design, so a
 * run that completed while the operator was on another page left no trace in
 * the UI at all, and the operator had no way to tell that from "it never ran".
 *
 * It renders a finished run through the SAME `PriceSyncEntryList` the live card
 * uses, because the history endpoint returns the same entry shape.
 */
import { useState } from 'react';
import { Alert, Anchor, Badge, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';

import {
  type MercadoLivrePriceSyncHistoricoEntry,
  useMercadoLivreClient,
} from '@/lib/mercado-livre/client';
import { describeMercadoLivreFailure, mercadoLivreQueryRetry } from '@/lib/mercado-livre/errors';
import { queryRetry } from '@/lib/query/queryRetry';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import { PriceSyncEntryList } from './MercadoLivreJobCards';
import type { ContaRef } from './startJobsForContas';

/** Runs fetched per open. Matches the route's own default. */
const HISTORICO_LIMITE = 20;

const STATUS_LABEL = {
  running: { texto: 'Em andamento', cor: 'blue' },
  completed: { texto: 'Concluído', cor: 'green' },
  failed: { texto: 'Falhou', cor: 'red' },
} as const satisfies Record<
  MercadoLivrePriceSyncHistoricoEntry['status'],
  { texto: string; cor: string }
>;

export function PriceSyncHistoricoModal({
  conta,
  opened,
  onClose,
}: {
  conta: ContaRef;
  opened: boolean;
  onClose: () => void;
}) {
  const client = useMercadoLivreClient();
  const query = useQuery({
    queryKey: ['ml-price-sync-historico', conta.id],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.priceSyncHistorico({ integracaoId: conta.id, limite: HISTORICO_LIMITE });
    },
    // Fetched only while the modal is open — this is a cold read of terminal
    // rows, not a poller, so there is no interval and nothing to stop.
    enabled: Boolean(client) && opened,
    // A one-shot read: unlike the 3s job pollers there is no next tick to serve
    // as the retry, so one blip would otherwise render "no history" for a conta
    // that has plenty.
    retry: mercadoLivreQueryRetry,
  });

  const retry = queryRetry(query);
  // Bound rather than read through `query.isPending`: a query disabled while
  // the modal is closed is `pending` with no data, so the flag does not narrow.
  const data = query.data;
  const failure =
    query.error == null
      ? null
      : describeMercadoLivreFailure(query.error, {
          network: 'Falha de rede ao consultar o histórico de envios.',
          unknown: 'Não foi possível consultar o histórico de envios.',
        });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Histórico de envios de preços — ${conta.nome}`}
      size="lg"
      centered
    >
      {failure ? (
        <RetryAlert
          color="yellow"
          message={failure.message}
          onRetry={failure.retryable ? retry.retry : undefined}
          retrying={retry.retrying}
        />
      ) : !data ? (
        <Group gap="xs">
          <Loader size="sm" />
          <Text size="sm" c="dimmed">
            Carregando…
          </Text>
        </Group>
      ) : data.envios.length === 0 ? (
        <Alert color="gray" variant="light">
          <Text size="sm">Nenhum envio de preços foi executado nesta conta.</Text>
        </Alert>
      ) : (
        <Stack gap="md">
          {data.envios.map((envio) => (
            <EnvioRow key={envio.jobId} envio={envio} />
          ))}
          {data.envios.length === HISTORICO_LIMITE && (
            // The page is capped, and a list that just stops reads as complete.
            <Text size="xs" c="dimmed">
              Mostrando os {HISTORICO_LIMITE} envios mais recentes.
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function EnvioRow({ envio }: { envio: MercadoLivrePriceSyncHistoricoEntry }) {
  const [detalhesAbertos, setDetalhesAbertos] = useState(false);
  const rotulo = STATUS_LABEL[envio.status];
  const temAmostras = envio.skips.length > 0 || envio.failures.length > 0;

  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Badge size="sm" color={rotulo.cor} variant="light">
          {rotulo.texto}
        </Badge>
        <Text size="sm" fw={500}>
          {formatarData(envio.startedAt)}
        </Text>
        {envio.baixarPreco && (
          // Worth surfacing: it changes what the run was allowed to do, so two
          // runs with different skip counts are not otherwise comparable.
          <Badge size="xs" variant="outline" color="gray">
            com redução de preço
          </Badge>
        )}
      </Group>

      <Text size="xs" c="dimmed">
        {envio.enviados} / {envio.planejados} enviados · {envio.pulados} pulados · {envio.falhas}{' '}
        falhas
        {envio.pausas > 0 ? ` · ${envio.pausas} pausas` : ''}
      </Text>

      {envio.naoEnumerados > 0 && (
        <Text size="xs" c="yellow.8">
          {envio.naoEnumerados} anúncio{envio.naoEnumerados === 1 ? '' : 's'} não enumerado
          {envio.naoEnumerados === 1 ? '' : 's'} — o produto vinculado não entrou na busca.
        </Text>
      )}

      {envio.status === 'failed' && (
        <Text size="xs" c="red.7">
          {envio.erro ? `Erro: ${envio.erro}` : 'O envio terminou em falha.'}
        </Text>
      )}

      {temAmostras && (
        <>
          <Anchor
            component="button"
            type="button"
            size="xs"
            onClick={() => setDetalhesAbertos((v) => !v)}
          >
            {detalhesAbertos ? 'Ocultar detalhes' : 'Ver detalhes'}
          </Anchor>
          {detalhesAbertos && (
            <Stack gap="sm" pl="sm">
              <PriceSyncEntryList label="Pulados" entries={envio.skips} total={envio.pulados} />
              <PriceSyncEntryList label="Falhas" entries={envio.failures} total={envio.falhas} />
            </Stack>
          )}
        </>
      )}
    </Stack>
  );
}

/** ms-epoch → `dd/MM/yyyy HH:mm`. */
function formatarData(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()} ${hh}:${mi}`;
}
