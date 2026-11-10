'use client';

/**
 * One conta's product import (master plan step 9) as a card in
 * `/canais/loja-integrada`'s action rail, through the shared
 * `components/contaJobs` chrome — Shopee's import card is the reference
 * (`canais/shopee/_components/ShopeeJobCards.tsx`); the copy and the counters
 * are this channel's own (`lib/loja-integrada/importacaoRotulos.ts`).
 *
 * What it shows: the status, the mode and the options the job ran with, the
 * phase while it runs (or that it waits for its start), the store list's rows
 * read so far while the listing runs, the counters, the store's count when the
 * listing read a different number, the 429 pauses, a run whose photos were
 * skipped, the failure's motivo, "sem progresso" after 45 minutes of silence, Cancelar while
 * it runs, and — for an ended job, when the page offers one — the way into its
 * result.
 *
 * ## When it reads
 *
 * `jobDaLista` is the conta's list copy of this job, when the list holds it.
 * An ENDED job in the list is final, so the card renders it and reads nothing
 * more; a running one — or a job the list does not hold yet (a start this
 * session) — is polled through `useImportacaoLi`, every 3 s, until it ends.
 * Each poll also lands in the list's cached copy, so the moment a job ends the
 * list says so and the polling stops.
 *
 * Nothing here writes: the backend owns every job transition, and Cancelar goes
 * through it (root `CLAUDE.md` rule 7).
 */
import { Alert, Badge, Button, Group, Loader, Text } from '@mantine/core';
import {
  ACAO_IMPORTACAO_LI,
  ALVO_IMPORTACAO_LI,
  FASE_IMPORTACAO_LI,
  MODO_IMPORTACAO_LI,
  type RespostaImportacaoLi,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  STATUS_IMPORTACAO_LI,
} from '@delfrance/schemas';

import { AvisoSemProgresso } from '@/components/contaJobs/AvisoSemProgresso';
import { type CancelaveisProps, JobCardShell } from '@/components/contaJobs/JobCardShell';
import { RetryAlert } from '@/components/feedback/RetryAlert';
import {
  ERROS_DO_CLIENTE_LI,
  descreverFalhaCancelamentoImportacaoLi,
  descreverFalhaLeituraImportacaoLi,
  semProgressoImportacaoLi,
  ultimoSinalDeVidaImportacaoLi,
  useAcoesImportacaoLi,
  useImportacaoLi,
} from '@/lib/loja-integrada/importacao';
import {
  COR_STATUS_IMPORTACAO_LI,
  ROTULO_ACAO_IMPORTACAO_LI,
  ROTULO_ALVO_IMPORTACAO_LI,
  ROTULO_CATEGORIAS_IMPORTACAO_LI,
  ROTULO_FOTOS_IMPORTACAO_LI,
  ROTULO_MODO_IMPORTACAO_LI,
  ROTULO_STATUS_IMPORTACAO_LI,
  lerMotivoFalhaImportacaoLi,
  textoDaFaseDoJobLi,
} from '@/lib/loja-integrada/importacaoRotulos';
import { formatarInstanteJob } from '@/lib/marketplace/contaJobs/cadencia';
import type { ContaRef } from '@/lib/marketplace/contaJobs/types';
import { queryRetry } from '@/lib/query/queryRetry';

/** The run's noun — the flow label on the card and its X. */
export const ROTULO_IMPORTACAO_PRODUTOS_LI = 'Importação de produtos';

/**
 * What the page's result view needs to open an ENDED job: the conta and the job
 * as last read. The seam the result view plugs into (`onAbrirResultado`).
 */
export interface AlvoResultadoImportacaoLi {
  readonly conta: ContaRef;
  readonly job: RespostaImportacaoLi;
  /** Open straight on the job's tax-review list (the result view's own way to the open list). */
  readonly naRevisaoFiscal?: boolean;
}

export interface CartaoImportacaoLiProps {
  readonly conta: ContaRef;
  readonly jobId: string;
  /** The conta list's copy of this job, or `null` when the list does not hold it (yet). */
  readonly jobDaLista: RespostaImportacaoLi | null;
  /** The job came from a busy start's 409 — the options picked now were NOT applied to it. */
  readonly reatado: boolean;
  /** The viewer may cancel (`PERM.integracao.write`); otherwise the X only hides the card. */
  readonly podeCancelar: boolean;
  readonly onDismiss: () => void;
  /** Opens an ended job's result. Absent ⇒ the card offers no way in. */
  readonly onAbrirResultado?: (alvo: AlvoResultadoImportacaoLi) => void;
}

/** The options a job ran with, in one line — the two Completar-only ones only under Completar. */
export function resumoDasOpcoesLi(
  job: Pick<RespostaImportacaoLi, 'alvo' | 'acao' | 'categorias' | 'fotos' | 'selecionados'>,
): string {
  const alvo =
    job.alvo === ALVO_IMPORTACAO_LI.selecionados
      ? `${ROTULO_ALVO_IMPORTACAO_LI[job.alvo]} (${String(job.selecionados)})`
      : ROTULO_ALVO_IMPORTACAO_LI[job.alvo];
  const partes = [alvo, ROTULO_ACAO_IMPORTACAO_LI[job.acao]];
  if (job.acao === ACAO_IMPORTACAO_LI.completar) {
    partes.push(
      `Categorias: ${ROTULO_CATEGORIAS_IMPORTACAO_LI[job.categorias]}`,
      `Fotos: ${ROTULO_FOTOS_IMPORTACAO_LI[job.fotos]}`,
    );
  }
  return partes.join(' · ');
}

/** `n` with its noun, singular or plural. */
function contar(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/**
 * The counters, worded as done or — for a Simular — as what an import would do.
 * Photos and failures only when there is something to say.
 *
 * The first one counts the store's products the run PROCESSED — a parent with
 * its variations, or a simple product, each once — never the rows the listing
 * read: those are {@link textoLeituraDaListaLi}'s and
 * {@link textoListagemDivergenteLi}'s, which say "linhas".
 */
export function linhasDosContadoresLi(
  job: Pick<RespostaImportacaoLi, 'modo' | 'contadores'>,
): string[] {
  const c = job.contadores;
  const simular = job.modo === MODO_IMPORTACAO_LI.simular;
  const linhas = [
    contar(c.familias, 'produto da loja processado', 'produtos da loja processados'),
    (simular
      ? [
          `${String(c.vinculados)} a vincular`,
          `${String(c.criados)} a criar`,
          `${String(c.completados)} a completar`,
        ]
      : [
          contar(c.vinculados, 'vinculado', 'vinculados'),
          contar(c.criados, 'criado', 'criados'),
          contar(c.completados, 'completado', 'completados'),
        ]
    )
      .concat(`${String(c.semMudanca)} sem mudança`)
      .join(' · '),
    `${contar(c.pendenciasAcionaveis, 'pendência a resolver', 'pendências a resolver')} · ${contar(c.pendenciasInformativas, 'informativa', 'informativas')}`,
  ];
  const extras = [
    ...(c.fotos > 0
      ? [
          simular
            ? contar(c.fotos, 'foto a copiar', 'fotos a copiar')
            : contar(c.fotos, 'foto copiada', 'fotos copiadas'),
        ]
      : []),
    ...(c.falhas > 0 ? [contar(c.falhas, 'falha', 'falhas')] : []),
  ];
  if (extras.length > 0) linhas.push(extras.join(' · '));
  return linhas;
}

/**
 * The store list's rows read so far, while the listing runs: the counters stay
 * at zero through the whole listing (products are processed only after it), so
 * this is the only progress a long listing shows. `null` in any other phase.
 */
export function textoLeituraDaListaLi(
  job: Pick<RespostaImportacaoLi, 'status' | 'fase' | 'listagem'>,
): string | null {
  if (!STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status)) return null;
  if (job.fase !== FASE_IMPORTACAO_LI.listagem) return null;
  const { linhas, totalLi } = job.listagem;
  const lidas = contar(linhas, 'linha lida', 'linhas lidas');
  return totalLi === null
    ? `Lista da loja: ${lidas}`
    : `Lista da loja: ${lidas} de ${String(totalLi)} (produtos e variações)`;
}

/**
 * The listing's own count against the store's, when they differ: offset paging
 * under concurrent edits can repeat or skip a row, so the operator is told
 * rather than shown a total that silently disagrees.
 */
export function textoListagemDivergenteLi(
  listagem: Pick<RespostaImportacaoLi['listagem'], 'linhas' | 'totalLi' | 'divergente'>,
): string | null {
  if (!listagem.divergente) return null;
  // Rows, never "produtos": the list counts every variation as its own row,
  // and the card's first counter counts processed products.
  const achou = contar(listagem.linhas, 'linha', 'linhas');
  const inicio =
    listagem.totalLi === null
      ? `A leitura da lista de produtos da loja achou ${achou}, um número diferente do que a loja informou`
      : `A lista de produtos da loja informou ${contar(listagem.totalLi, 'linha', 'linhas')} (produtos e variações) e a leitura achou ${achou}`;
  return (
    `${inicio}: produtos alterados na loja durante a leitura podem ter sido lidos duas vezes ou ` +
    'pulados. Rode a importação de novo para conferir.'
  );
}

export function CartaoImportacaoLi({
  conta,
  jobId,
  jobDaLista,
  reatado,
  podeCancelar,
  onDismiss,
  onAbrirResultado,
}: CartaoImportacaoLiProps) {
  const acoes = useAcoesImportacaoLi();
  // An ended job the list already holds is final: nothing to poll.
  const precisaLer = jobDaLista === null || STATUS_EM_CURSO_IMPORTACAO_LI.has(jobDaLista.status);
  const leitura = useImportacaoLi(conta.id, precisaLer ? jobId : null);
  const job = leitura.dados ?? jobDaLista;
  const emCurso = job !== null && STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status);
  const retry = queryRetry(leitura.consulta);
  const falha = leitura.erro == null ? null : descreverFalhaLeituraImportacaoLi(leitura.erro);
  const simular = job?.modo === MODO_IMPORTACAO_LI.simular;

  // The union keeps the four together: no client (logged out) or no write
  // permission ⇒ the X only hides the card.
  const cancelamento: CancelaveisProps =
    podeCancelar && acoes !== null
      ? {
          onCancel: async () => {
            await acoes.cancelar(conta.id, jobId);
          },
          cancelLabel: 'Cancelar importação',
          describeCancelError: descreverFalhaCancelamentoImportacaoLi,
          errosDoCliente: ERROS_DO_CLIENTE_LI,
        }
      : {};

  const divergente = job === null ? null : textoListagemDivergenteLi(job.listagem);
  const leituraDaLista = job === null ? null : textoLeituraDaListaLi(job);

  return (
    <JobCardShell
      conta={conta}
      flowLabel={ROTULO_IMPORTACAO_PRODUTOS_LI}
      running={emCurso}
      // Only a status we actually READ closes the confirm off: no data means
      // unknown, never "stopped".
      encerrado={job !== null && !emCurso}
      onDismiss={onDismiss}
      {...cancelamento}
    >
      {reatado && (
        <Alert color="gray" variant="light" p="xs">
          <Text size="xs">
            Esta conta já tinha uma importação em andamento — o painel passou a acompanhá-la. As
            opções escolhidas agora não foram aplicadas.
          </Text>
        </Alert>
      )}
      {falha && (
        <RetryAlert
          variant="compact"
          color="yellow"
          message={falha.mensagem}
          onRetry={falha.repetivel ? retry.retry : undefined}
          retrying={retry.retrying}
        />
      )}
      {job === null ? (
        falha ? null : (
          <Loader size="xs" />
        )
      ) : (
        <>
          <Group gap={4}>
            <Badge size="sm" variant="light" color={COR_STATUS_IMPORTACAO_LI[job.status]}>
              {ROTULO_STATUS_IMPORTACAO_LI[job.status]}
            </Badge>
            <Badge size="sm" variant="outline" color="gray">
              {ROTULO_MODO_IMPORTACAO_LI[job.modo]}
            </Badge>
          </Group>
          <Text size="xs" c="dimmed">
            Iniciada em {formatarInstanteJob(job.iniciadoEmMs)} · {resumoDasOpcoesLi(job)}
          </Text>
          {simular && (
            <Text size="xs" c="dimmed">
              Simulação: os números dizem o que uma importação faria; nada é gravado no ERP.
            </Text>
          )}
          {emCurso && <Text size="xs">{textoDaFaseDoJobLi(job)}</Text>}
          {leituraDaLista !== null && (
            <Text size="xs" c="dimmed">
              {leituraDaLista}
            </Text>
          )}
          {linhasDosContadoresLi(job).map((linha) => (
            <Text key={linha} size="xs">
              {linha}
            </Text>
          ))}
          {divergente !== null && (
            <Alert color="yellow" variant="light" p="xs">
              <Text size="xs">{divergente}</Text>
            </Alert>
          )}
          {job.pausas429 > 0 && (
            <Text size="xs" c="dimmed">
              A Loja Integrada limitou as chamadas {contar(job.pausas429, 'vez', 'vezes')}; a
              importação esperou um minuto a cada uma.
            </Text>
          )}
          {job.fotosIndisponiveis && (
            <Alert color="yellow" variant="light" p="xs">
              <Text size="xs">
                Fotos indisponíveis: o armazenamento de arquivos deste backend não estava
                disponível, e nenhuma foto foi copiada nesta importação. Avise o suporte.
              </Text>
            </Alert>
          )}
          {/* The clock is the poll's own answer time, never a clock read during
              render: an ended job, or one not polled yet, is never flagged. */}
          {semProgressoImportacaoLi(job, leitura.consulta.dataUpdatedAt) && (
            <AvisoSemProgresso desde={ultimoSinalDeVidaImportacaoLi(job)} />
          )}
          {job.status === STATUS_IMPORTACAO_LI.concluido && (
            <Alert color="green" variant="light" p="xs">
              <Text size="xs">
                {simular
                  ? 'Simulação concluída: nada foi gravado no ERP.'
                  : 'Importação concluída.'}
              </Text>
            </Alert>
          )}
          {job.status === STATUS_IMPORTACAO_LI.falhou && (
            <Alert color="red" variant="light" p="xs">
              <Text size="xs">{lerMotivoFalhaImportacaoLi(job.motivo).texto}</Text>
            </Alert>
          )}
          {job.status === STATUS_IMPORTACAO_LI.cancelado && (
            <Alert color="gray" variant="light" p="xs">
              <Text size="xs">
                {simular
                  ? 'Simulação cancelada.'
                  : 'Importação cancelada. O que ela já gravou no ERP permanece.'}
              </Text>
            </Alert>
          )}
          {!emCurso && onAbrirResultado && (
            <Button
              size="compact-xs"
              variant="light"
              onClick={() => onAbrirResultado({ conta, job })}
            >
              Ver resultado
            </Button>
          )}
        </>
      )}
    </JobCardShell>
  );
}
