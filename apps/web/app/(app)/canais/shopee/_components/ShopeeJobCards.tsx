'use client';

/**
 * The per-conta progress cards of the two Shopee account-wide jobs (#1529, step
 * 21-5), rendered in `/canais/shopee`'s action rail through the shared
 * `components/contaJobs` chrome — Mercado Livre's cards are the reference
 * (`canais/mercado-livre/_components/MercadoLivreJobCards.tsx`), the copy and
 * the counters are Shopee's own.
 *
 * Each card owns its polling query (hooks cannot be looped over a dynamic list),
 * polls by `jobId`, and stops by itself once the job leaves `running`. The
 * cadence, the "sem progresso" hint and the printed instants all come from
 * `cadenciaJobsShopee.ts`.
 *
 * ⚠️ `retry: false` on both queries, on purpose: the next tick IS the retry, and
 * a backoff ladder against a 3 s interval stacks overlapping fetches on a backend
 * that is already down. The `RetryAlert` button is what revives a card whose
 * FIRST poll failed (no data ⇒ no interval) — query-core recomputes the interval
 * on the next successful refetch.
 *
 * Nothing here writes: the cards read the status routes and cancel through the
 * backend, which owns every job transition (root `CLAUDE.md` rule 7).
 */
import { useState } from 'react';
import { Alert, Anchor, Loader, Modal, Stack, Text } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import { ENVIO_PRECO_SHOPEE_STATUS, IMPORTACAO_SHOPEE_STATUS } from '@delfrance/schemas';

import { RetryAlert } from '@/components/feedback/RetryAlert';
import { BaixarRelatorioButton } from '@/components/contaJobs/BaixarRelatorioButton';
import { JobCardShell } from '@/components/contaJobs/JobCardShell';
import { type AmostraDeJob, PriceSyncEntryList } from '@/components/contaJobs/PriceSyncEntryList';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { queryRetry } from '@/lib/query/queryRetry';
import { useShopeeClient } from '@/lib/shopee/client';
import { descreverFalhaShopee } from '@/lib/shopee/erros';
import type { MassImportStatusShopee } from '@/lib/shopee/wire';
import {
  formatarInstanteJob,
  intervaloEnvioPreco,
  intervaloImportacao,
  semProgresso,
  ultimoSinalDeVida,
} from './cadenciaJobsShopee';
import {
  descreverFalhaAoCancelarAtualizacaoPrecos,
  descreverFalhaAoCancelarImportacao,
  ERROS_DO_CLIENTE_SHOPEE,
} from './shopeeJobErrors';
import { useBaixarRelatorioPrecoShopee } from './useBaixarRelatorioPrecoShopee';

/** The backend's own noun for each run — the flow label on the card and its X. */
export const ROTULO_IMPORTACAO_SHOPEE = 'Importação em massa';
export const ROTULO_ATUALIZACAO_PRECOS_SHOPEE = 'Atualização de preços';

/** Props both cards take. */
interface CartaoDeJobProps {
  conta: ContaRef;
  jobId: string;
  /** The job came from a busy start's 409 — the operator's choices were NOT applied to it. */
  reatado: boolean;
  onDismiss: () => void;
}

/** A RUNNING job that stopped checkpointing — shared by both cards. */
function AvisoSemProgresso({ desde }: { desde: number }) {
  return (
    <Alert color="yellow" variant="light" p="xs">
      <Text size="xs">
        Sem progresso desde {formatarInstanteJob(desde)} — se continuar assim, cancele e inicie de
        novo.
      </Text>
    </Alert>
  );
}

/**
 * A failed import's sample row, in the shared list's shape. Shopee's `itemId` is
 * a NUMBER on the wire; the stored sentence is shown whole (`mensagem`).
 */
function amostraDaFalhaDeImportacao(f: MassImportStatusShopee['failures'][number]): AmostraDeJob {
  return { itemId: String(f.itemId), code: f.motivo, mensagem: f.mensagem || undefined };
}

export function ImportacaoShopeeJobCard({ conta, jobId, reatado, onDismiss }: CartaoDeJobProps) {
  const client = useShopeeClient();
  const [falhasAbertas, setFalhasAbertas] = useState(false);
  const query = useQuery({
    queryKey: ['shopee-importacao', conta.id, jobId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.massImportStatus({ integracaoId: conta.id, jobId });
    },
    enabled: Boolean(client),
    retry: false,
    refetchInterval: (q) => intervaloImportacao(q.state.data),
  });

  const data = query.data;
  const retry = queryRetry(query);
  const falha =
    query.error == null
      ? null
      : descreverFalhaShopee(query.error, {
          desconhecido: 'Não foi possível consultar a importação.',
        });
  const rodando = data?.status === IMPORTACAO_SHOPEE_STATUS.running;

  return (
    <JobCardShell
      conta={conta}
      flowLabel={ROTULO_IMPORTACAO_SHOPEE}
      running={rodando}
      // Only a status we actually READ closes the confirm off: no data means
      // unknown, never "stopped".
      encerrado={data != null && !rodando}
      onDismiss={onDismiss}
      cancelLabel="Cancelar importação"
      describeCancelError={descreverFalhaAoCancelarImportacao}
      errosDoCliente={ERROS_DO_CLIENTE_SHOPEE}
      onCancel={async () => {
        if (!client) throw new Error('not ready');
        await client.cancelMassImport({ integracaoId: conta.id, jobId });
        // Show the terminal state now rather than waiting out the poll window.
        await query.refetch();
      }}
    >
      {reatado && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">
            Esta conta já tinha uma importação em andamento — o painel passou a acompanhá-la. As
            opções escolhidas agora não foram aplicadas.
          </Text>
        </Alert>
      )}
      {falha ? (
        <RetryAlert
          variant="compact"
          color="yellow"
          message={falha.mensagem}
          onRetry={falha.repetivel ? retry.retry : undefined}
          retrying={retry.retrying}
        />
      ) : !data ? (
        <Loader size="xs" />
      ) : (
        <>
          <Text size="xs">
            {data.scanned} encontrados · {data.imported} importados ({data.created} novos)
            {data.kits > 0 ? ` · ${data.kits} kits` : ''}
          </Text>
          <Text size="xs">
            {data.skipped} pulados · {data.failureCount} falhas
          </Text>
          {rodando && (
            <Text size="xs" c="dimmed">
              {data.restante} na fila{data.varreduraExaurida ? ' · varredura concluída' : ''}
            </Text>
          )}
          {semProgresso(data, query.dataUpdatedAt) && (
            <AvisoSemProgresso desde={ultimoSinalDeVida(data)} />
          )}
          {data.status === IMPORTACAO_SHOPEE_STATUS.completed && (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">Importação concluída.</Text>
            </Alert>
          )}
          {data.status === IMPORTACAO_SHOPEE_STATUS.failed && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">Falha na importação{data.erro ? `: ${data.erro}` : '.'}</Text>
            </Alert>
          )}
          {data.status === IMPORTACAO_SHOPEE_STATUS.cancelled && (
            <Alert color="gray" variant="light" p="xs">
              {/* A cancel keeps what it imported; the counters above say how much. */}
              <Text size="xs">Importação cancelada.</Text>
            </Alert>
          )}
          {data.failures.length > 0 && (
            <>
              {/* Grouping by `motivo` would need the vocabulary, which lives only
                  in apps/shopee — the stored sentence on each row says enough. */}
              <Anchor
                component="button"
                type="button"
                size="xs"
                onClick={() => setFalhasAbertas(true)}
              >
                Ver falhas
              </Anchor>
              <Modal
                opened={falhasAbertas}
                onClose={() => setFalhasAbertas(false)}
                title={`${ROTULO_IMPORTACAO_SHOPEE} — ${conta.nome}`}
                centered
              >
                <PriceSyncEntryList
                  label="Falhas"
                  entries={data.failures.map(amostraDaFalhaDeImportacao)}
                  total={data.failureCount}
                />
              </Modal>
            </>
          )}
        </>
      )}
    </JobCardShell>
  );
}

export function EnvioPrecoShopeeJobCard({ conta, jobId, reatado, onDismiss }: CartaoDeJobProps) {
  const client = useShopeeClient();
  const relatorio = useBaixarRelatorioPrecoShopee();
  const [detalhesAbertos, setDetalhesAbertos] = useState(false);
  const query = useQuery({
    queryKey: ['shopee-envio-preco', conta.id, jobId],
    queryFn: () => {
      if (!client) throw new Error('not ready');
      return client.priceSyncStatus({ integracaoId: conta.id, jobId });
    },
    enabled: Boolean(client),
    retry: false,
    refetchInterval: (q) => intervaloEnvioPreco(q.state.data, q.state.dataUpdatedAt),
  });

  const data = query.data;
  const retry = queryRetry(query);
  const falha =
    query.error == null
      ? null
      : descreverFalhaShopee(query.error, {
          desconhecido: 'Não foi possível consultar a atualização de preços.',
        });
  const rodando = data?.status === ENVIO_PRECO_SHOPEE_STATUS.running;
  const temAmostras = (data?.skips.length ?? 0) > 0 || (data?.failures.length ?? 0) > 0;

  return (
    <JobCardShell
      conta={conta}
      flowLabel={ROTULO_ATUALIZACAO_PRECOS_SHOPEE}
      running={rodando}
      encerrado={data != null && !rodando}
      onDismiss={onDismiss}
      cancelLabel="Cancelar atualização"
      describeCancelError={descreverFalhaAoCancelarAtualizacaoPrecos}
      errosDoCliente={ERROS_DO_CLIENTE_SHOPEE}
      onCancel={async () => {
        if (!client) throw new Error('not ready');
        await client.cancelPriceSync({ integracaoId: conta.id, jobId });
        await query.refetch();
      }}
    >
      {reatado && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">
            Esta conta já tinha uma atualização de preços em andamento — o painel passou a
            acompanhá-la. A opção escolhida agora não foi aplicada.
          </Text>
        </Alert>
      )}
      {falha ? (
        <RetryAlert
          variant="compact"
          color="yellow"
          message={falha.mensagem}
          onRetry={falha.repetivel ? retry.retry : undefined}
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
            {data.parques > 0
              ? ` · ${data.parques} ${data.parques === 1 ? 'espera' : 'esperas'} pela cota diária`
              : ''}
          </Text>
          {/* `filaRestante` is deliberately NOT shown live: it counts the current
              plan PAGE only. The CSV trailer prints it, where it is labelled. */}
          {rodando && data.retomarEm !== null && (
            <Alert color="blue" variant="light" p="xs">
              <Text size="xs">
                Aguardando a cota diária da Shopee — retoma por volta de{' '}
                {formatarInstanteJob(data.retomarEm)}.
              </Text>
            </Alert>
          )}
          {semProgresso(data, query.dataUpdatedAt) && (
            <AvisoSemProgresso desde={ultimoSinalDeVida(data)} />
          )}
          {data.status === ENVIO_PRECO_SHOPEE_STATUS.completed && (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">Atualização de preços concluída.</Text>
            </Alert>
          )}
          {data.status === ENVIO_PRECO_SHOPEE_STATUS.failed && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">
                Falha na atualização de preços{data.erro ? `: ${data.erro}` : '.'}
              </Text>
            </Alert>
          )}
          {/* Gray: the operator asked for it, and what went out before the stop
              stays out — the CSV below lists it. */}
          {data.status === ENVIO_PRECO_SHOPEE_STATUS.cancelled && (
            <Alert color="gray" variant="light" p="xs">
              <Text size="xs">Atualização de preços cancelada.</Text>
            </Alert>
          )}
          {temAmostras && (
            <>
              <Anchor
                component="button"
                type="button"
                size="xs"
                onClick={() => setDetalhesAbertos(true)}
              >
                Ver detalhes
              </Anchor>
              <Modal
                opened={detalhesAbertos}
                onClose={() => setDetalhesAbertos(false)}
                title={`${ROTULO_ATUALIZACAO_PRECOS_SHOPEE} — ${conta.nome}`}
                centered
              >
                <Stack gap="sm">
                  <PriceSyncEntryList label="Pulados" entries={data.skips} total={data.pulados} />
                  <PriceSyncEntryList label="Falhas" entries={data.failures} total={data.falhas} />
                </Stack>
              </Modal>
            </>
          )}
          {/* Gated on the run being OVER, never on it having samples: a run with
              no skip and no failure is the report an operator most wants. */}
          {!rodando && (
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
