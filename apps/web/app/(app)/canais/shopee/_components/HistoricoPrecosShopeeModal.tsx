'use client';

/**
 * A Shopee conta's PAST price updates (`GET atualizar-precos/historico`, #1529
 * step 21-5) — the only way back to a run that finished while nobody watched,
 * and, for a run still going, the way to put its card back on the rail
 * ("Acompanhar") even when another operator started it.
 *
 * The history rows carry the counters but NO samples (the route drops them), so
 * "Ver detalhes" reads that ONE run's status when — and only when — it is opened.
 * Mercado Livre's modal is the reference (`PriceSyncHistoricoModal.tsx`).
 */
import { useState } from 'react';
import { Alert, Anchor, Badge, Button, Group, Loader, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { ENVIO_PRECO_SHOPEE_STATUS, type EnvioPrecoShopeeStatus } from '@delfrance/schemas';

import { RetryAlert } from '@/components/feedback/RetryAlert';
import { BaixarRelatorioButton } from '@/components/contaJobs/BaixarRelatorioButton';
import { PriceSyncEntryList } from '@/components/contaJobs/PriceSyncEntryList';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { queryRetry } from '@/lib/query/queryRetry';
import { useShopeeClient } from '@/lib/shopee/client';
import { descreverFalhaShopee, shopeeQueryRetry } from '@/lib/shopee/erros';
import type { PriceSyncHistoricoShopee } from '@/lib/shopee/wire';
import { formatarInstanteJob } from './cadenciaJobsShopee';
import { useBaixarRelatorioPrecoShopee } from './useBaixarRelatorioPrecoShopee';

/** Runs fetched per open — inside the route's 1..50. */
export const HISTORICO_PRECOS_SHOPEE_LIMITE = 20;

type EnvioDoHistorico = PriceSyncHistoricoShopee['envios'][number];

const ROTULO_STATUS = {
  running: { texto: 'Em andamento', cor: 'blue' },
  completed: { texto: 'Concluída', cor: 'green' },
  failed: { texto: 'Falhou', cor: 'red' },
  cancelled: { texto: 'Cancelada', cor: 'gray' },
} as const satisfies Record<EnvioPrecoShopeeStatus, { texto: string; cor: string }>;

export function HistoricoPrecosShopeeModal({
  conta,
  opened,
  onClose,
  onAcompanhar,
}: {
  conta: ContaRef;
  opened: boolean;
  onClose: () => void;
  /** Put a RUNNING run's card on the rail. */
  onAcompanhar: (jobId: string) => void;
}) {
  const client = useShopeeClient();
  // ONE download hook for the whole list (its in-flight guard is shared).
  const relatorio = useBaixarRelatorioPrecoShopee();
  const query = useQuery({
    queryKey: ['shopee-historico-precos', conta.id],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.priceSyncHistorico({
        integracaoId: conta.id,
        limite: HISTORICO_PRECOS_SHOPEE_LIMITE,
      });
    },
    // A cold read while open — no interval, so a blip may retry (never a 502).
    enabled: Boolean(client) && opened,
    retry: shopeeQueryRetry,
  });

  const retry = queryRetry(query);
  const data = query.data;
  const falha =
    query.error == null
      ? null
      : descreverFalhaShopee(query.error, {
          desconhecido: 'Não foi possível consultar o histórico de atualizações de preços.',
        });

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={`Histórico de atualizações de preços — ${conta.nome}`}
      size="lg"
      centered
    >
      {falha ? (
        <RetryAlert
          color="yellow"
          message={falha.mensagem}
          onRetry={falha.repetivel ? retry.retry : undefined}
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
        // "Never ran" must not look like "the read returned nothing".
        <Alert color="gray" variant="light">
          <Text size="sm">Nenhuma atualização de preços foi executada nesta conta.</Text>
        </Alert>
      ) : (
        <Stack gap="md">
          {data.envios.map((envio) => (
            <LinhaDoHistorico
              key={envio.jobId}
              envio={envio}
              conta={conta}
              relatorio={relatorio}
              onAcompanhar={() => {
                onAcompanhar(envio.jobId);
                onClose();
              }}
            />
          ))}
          {data.envios.length === HISTORICO_PRECOS_SHOPEE_LIMITE && (
            // A capped page that just stops reads as complete.
            <Text size="xs" c="dimmed">
              Mostrando as {HISTORICO_PRECOS_SHOPEE_LIMITE} atualizações mais recentes.
            </Text>
          )}
        </Stack>
      )}
    </Modal>
  );
}

function LinhaDoHistorico({
  envio,
  conta,
  relatorio,
  onAcompanhar,
}: {
  envio: EnvioDoHistorico;
  conta: ContaRef;
  relatorio: ReturnType<typeof useBaixarRelatorioPrecoShopee>;
  onAcompanhar: () => void;
}) {
  const [detalhesAbertos, setDetalhesAbertos] = useState(false);
  const rotulo = ROTULO_STATUS[envio.status];
  const rodando = envio.status === ENVIO_PRECO_SHOPEE_STATUS.running;
  // The history drops the samples, so the counters decide whether there is
  // anything behind "Ver detalhes".
  const temAmostras = envio.pulados > 0 || envio.falhas > 0;

  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <Badge size="sm" color={rotulo.cor} variant="light">
          {rotulo.texto}
        </Badge>
        <Text size="sm" fw={500}>
          {formatarInstanteJob(envio.startedAt, { comAno: true })}
        </Text>
        {envio.baixarPreco && (
          // It changes what the run was allowed to do, so two runs' skip
          // counts are not comparable without it.
          <Badge size="xs" variant="outline" color="gray">
            com redução de preço
          </Badge>
        )}
      </Group>

      <Text size="xs" c="dimmed">
        {envio.enviados} / {envio.planejados} enviados · {envio.pulados} pulados · {envio.falhas}{' '}
        falhas
        {envio.pausas > 0 ? ` · ${envio.pausas} pausas` : ''}
        {envio.parques > 0
          ? ` · ${envio.parques} ${envio.parques === 1 ? 'espera' : 'esperas'} pela cota diária`
          : ''}
      </Text>

      {rodando && envio.retomarEm !== null && (
        <Text size="xs" c="blue">
          Aguardando a cota diária da Shopee — retoma por volta de{' '}
          {formatarInstanteJob(envio.retomarEm)}.
        </Text>
      )}

      {envio.status === ENVIO_PRECO_SHOPEE_STATUS.failed && (
        <Text size="xs" c="red">
          {envio.erro ? `Erro: ${envio.erro}` : 'A atualização terminou em falha.'}
        </Text>
      )}

      {envio.status === ENVIO_PRECO_SHOPEE_STATUS.cancelled && (
        <Text size="xs" c="dimmed">
          A atualização foi cancelada.
        </Text>
      )}

      <Group gap="xs">
        {rodando ? (
          <Button size="compact-xs" variant="light" onClick={onAcompanhar}>
            Acompanhar
          </Button>
        ) : (
          <BaixarRelatorioButton
            jobId={envio.jobId}
            contaId={conta.id}
            contaNome={conta.nome}
            baixar={relatorio.baixar}
            baixando={relatorio.baixando === envio.jobId}
            pagina={relatorio.pagina}
          />
        )}
        {temAmostras && (
          <Anchor
            component="button"
            type="button"
            size="xs"
            onClick={() => setDetalhesAbertos((v) => !v)}
          >
            {detalhesAbertos ? 'Ocultar detalhes' : 'Ver detalhes'}
          </Anchor>
        )}
      </Group>

      {detalhesAbertos && <DetalhesDoEnvio conta={conta} envio={envio} />}
    </Stack>
  );
}

/** The run's skip/failure samples — ONE status read, made only once this is mounted (opened). */
function DetalhesDoEnvio({ conta, envio }: { conta: ContaRef; envio: EnvioDoHistorico }) {
  const client = useShopeeClient();
  const query = useQuery({
    queryKey: ['shopee-historico-precos-detalhe', conta.id, envio.jobId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.priceSyncStatus({ integracaoId: conta.id, jobId: envio.jobId });
    },
    enabled: Boolean(client),
    retry: shopeeQueryRetry,
  });
  const retry = queryRetry(query);
  const falha =
    query.error == null
      ? null
      : descreverFalhaShopee(query.error, {
          desconhecido: 'Não foi possível consultar os detalhes desta atualização.',
        });

  if (falha) {
    return (
      <RetryAlert
        variant="compact"
        color="yellow"
        message={falha.mensagem}
        onRetry={falha.repetivel ? retry.retry : undefined}
        retrying={retry.retrying}
      />
    );
  }
  if (!query.data) return <Loader size="xs" />;
  return (
    <Stack gap="sm" pl="sm">
      <PriceSyncEntryList label="Pulados" entries={query.data.skips} total={query.data.pulados} />
      <PriceSyncEntryList label="Falhas" entries={query.data.failures} total={query.data.falhas} />
    </Stack>
  );
}
