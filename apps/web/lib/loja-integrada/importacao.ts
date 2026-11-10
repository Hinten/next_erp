'use client';

/**
 * The product import screen's reads and writes (master plan step 9), over the
 * backend client: React Query hooks for the conta's jobs, one job's progress,
 * its report and its tax-review list; the start and cancel with their cache
 * updates; and the copy for every way those calls fail.
 *
 * The copy for the CODES the answers carry is `importacaoRotulos.ts`; the
 * channel-neutral card clock (3 s, 45 minutes, the printed instant) is
 * `lib/marketplace/contaJobs/cadencia.ts`.
 *
 * ## The query keys
 *
 * Every key starts `['loja-integrada', 'importacao', contaId]`, so one
 * invalidation reaches a conta's whole import state. The job key is a prefix of
 * its report and tax-review keys.
 *
 * ## When a read happens
 *
 * - the list ({@link useImportacoesLi}): once per view, and again after a
 *   start or a cancel (both invalidate it);
 * - one job ({@link useImportacaoLi}): every {@link INTERVALO_JOB_MS} while it
 *   is `pendente` or `executando`, never after. Each answer is also written
 *   into the list's cached copy, so the list never shows a status older than
 *   the card's, at no extra request;
 * - the report and the tax-review list ({@link useItensImportacaoLi},
 *   {@link useRevisaoImportacaoLi}): ALL pages, once per view, never polled.
 *   An ENDED job's report and list are final, so they are read once and kept
 *   (`staleTime: Infinity`); a running job's are a snapshot, and the key
 *   changes when the job ends, so the final ones are read then. Each page costs
 *   the backend a scan (the routes' headers), so nothing here re-reads behind
 *   the operator.
 *
 * Nothing retries behind the operator either (`retry: false`): a poll's next
 * tick IS its retry, and every other read offers its own "Tentar de novo".
 *
 * ## Errors
 *
 * The start's failures are the fan-out port's (`lib/marketplace/contaJobs`):
 * {@link describeImportacaoLiStartError} narrows ONLY this channel's client
 * classes and returns `null` for anything else, which the fan rethrows after
 * committing the contas that did start (root `CLAUDE.md` rule 6). A busy start
 * is not a failure: {@link AcoesImportacaoLi.iniciar} turns the 409 into the
 * running job (`reatado: true`), the Shopee import's attach. The reads and the
 * cancel get TOTAL describers, since their callers render the copy and have
 * nowhere to rethrow to.
 */
import { useMemo } from 'react';
import {
  type QueryClient,
  skipToken,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { FirebaseError } from 'firebase/app';
import {
  CODIGO_ERRO_LI,
  ID_IMPORTACAO_LI_REGEX,
  type RespostaImportacaoLi,
  type RespostaImportacoesLi,
  type RespostaRevisaoFiscalLi,
  STATUS_EM_CURSO_IMPORTACAO_LI,
  type EntradaRespostaRevisaoFiscalLi,
  type ItemRespostaImportacaoLi,
} from '@delfrance/schemas';
import { resumirCampos } from '@delfrance/core/wire';

import type { ErrosDoCliente } from '@/components/contaJobs/JobCardShell';
import {
  INTERVALO_JOB_MS,
  silencioExcedido,
  ultimoSinalDeVida,
} from '@/lib/marketplace/contaJobs/cadencia';
import type { JobErrorDescription } from '@/lib/marketplace/contaJobs/types';

import {
  type EntradaOpcoesImportacaoLi,
  LojaIntegradaClientHttpError,
  LojaIntegradaClientNetworkError,
  LojaIntegradaClientRespostaInvalidaError,
  LojaIntegradaClientTempoEsgotadoError,
  type MotivoBackendLiIndisponivel,
  useBackendLojaIntegrada,
} from './client';

/* -------------------------------------------------------------------------- */
/*                                  The keys                                   */
/* -------------------------------------------------------------------------- */

/** Every import key of one conta starts with this. */
export function chaveImportacoesDaContaLi(contaId: string) {
  return ['loja-integrada', 'importacao', contaId] as const;
}

/** The conta's newest jobs. */
export function chaveListaImportacoesLi(contaId: string) {
  return [...chaveImportacoesDaContaLi(contaId), 'lista'] as const;
}

/** One job's status — a prefix of its report and tax-review keys. */
export function chaveImportacaoLi(contaId: string, jobId: string) {
  return [...chaveImportacoesDaContaLi(contaId), 'job', jobId] as const;
}

/** Whether a job's report is final (`final`) or a snapshot of a running job (`parcial`). */
type EstadoDoRelatorioLi = 'final' | 'parcial';

function estadoDoRelatorio(job: Pick<RespostaImportacaoLi, 'status'>): EstadoDoRelatorioLi {
  return STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status) ? 'parcial' : 'final';
}

/** A job's whole report, as final or as a running job's snapshot. */
export function chaveItensImportacaoLi(
  contaId: string,
  jobId: string,
  estado: EstadoDoRelatorioLi,
) {
  return [...chaveImportacaoLi(contaId, jobId), 'itens', estado] as const;
}

/** A job's whole tax-review list, as final or as a running job's snapshot. */
export function chaveRevisaoImportacaoLi(
  contaId: string,
  jobId: string,
  estado: EstadoDoRelatorioLi,
) {
  return [...chaveImportacaoLi(contaId, jobId), 'revisao', estado] as const;
}

/* -------------------------------------------------------------------------- */
/*                                 The cadence                                 */
/* -------------------------------------------------------------------------- */

/** The job query's `refetchInterval`: 3 s while `pendente` or `executando`, nothing after. */
export function intervaloImportacaoLi(
  job: Pick<RespostaImportacaoLi, 'status'> | undefined,
): number | false {
  return job !== undefined && STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status)
    ? INTERVALO_JOB_MS
    : false;
}

/** A job's last sign of life: its last checkpoint, or its creation before the first. */
export function ultimoSinalDeVidaImportacaoLi(
  job: Pick<RespostaImportacaoLi, 'iniciadoEmMs' | 'atualizadoEmMs'>,
): number {
  return ultimoSinalDeVida({ updatedAt: job.atualizadoEmMs ?? job.iniciadoEmMs });
}

/**
 * Whether a job still `pendente` or `executando` has gone 45 minutes
 * (`SEM_PROGRESSO_MS`) without a checkpoint: no worker is running it, and
 * Cancelar is the recovery. Every checkpoint stamps `atualizadoEmMs`, a dispatch
 * checkpoints at least every 100 s, and the reads queue's whole retry ladder
 * ends long before — so this is past anything a healthy run does. A `pendente`
 * job counts too: one 45 minutes old was never dispatched at all.
 *
 * `agora` is the job query's `dataUpdatedAt` (the shared module's header says
 * why), never a clock read during render.
 */
export function semProgressoImportacaoLi(
  job: Pick<RespostaImportacaoLi, 'status' | 'iniciadoEmMs' | 'atualizadoEmMs'> | undefined,
  agora: number,
): boolean {
  if (job === undefined || !STATUS_EM_CURSO_IMPORTACAO_LI.has(job.status)) return false;
  return silencioExcedido(ultimoSinalDeVidaImportacaoLi(job), agora);
}

/* -------------------------------------------------------------------------- */
/*                                  The reads                                  */
/* -------------------------------------------------------------------------- */

/** What a read hook hands its screen. */
export interface LeituraImportacaoLi<T> {
  /** The answer, or `undefined` while there is none. */
  readonly dados: T | undefined;
  /** A first read is in flight. */
  readonly carregando: boolean;
  /** Any read is in flight. */
  readonly lendo: boolean;
  /** The last read's failure, or `null`. Describe it with {@link descreverFalhaLeituraImportacaoLi}. */
  readonly erro: unknown;
  /** Why there is no client although someone is logged in, else `null`. */
  readonly indisponivel: MotivoBackendLiIndisponivel | null;
  /** The underlying query (its `dataUpdatedAt` is the card's clock; `refetch` its retry). */
  readonly consulta: UseQueryResult<T>;
}

function leitura<T>(
  consulta: UseQueryResult<T>,
  indisponivel: MotivoBackendLiIndisponivel | null,
): LeituraImportacaoLi<T> {
  return {
    dados: consulta.data,
    carregando: consulta.isLoading,
    lendo: consulta.isFetching,
    erro: consulta.error,
    indisponivel,
    consulta,
  };
}

/** Options of the read hooks. */
export interface OpcoesLeituraImportacaoHookLi {
  /** Whether the read may run (the panel is open). Default `true`. */
  readonly habilitado?: boolean;
}

/** The conta's newest jobs (at most 10, newest first). */
export function useImportacoesLi(
  contaId: string,
  opcoes: OpcoesLeituraImportacaoHookLi = {},
): LeituraImportacaoLi<RespostaImportacoesLi> {
  const { client, indisponivel } = useBackendLojaIntegrada();
  const consulta = useQuery({
    queryKey: chaveListaImportacoesLi(contaId),
    queryFn:
      client === null ? skipToken : ({ signal }) => client.importacoes(contaId, { sinal: signal }),
    enabled: opcoes.habilitado ?? true,
    retry: false,
    refetchOnReconnect: false,
  });
  return leitura(consulta, indisponivel);
}

/**
 * `job` put in place of its namesake in a cached list — or the list unchanged
 * when it does not hold that job (a job newer than the cached list is the
 * list's next read's to add, in the backend's order).
 */
export function substituirImportacaoNaLista(
  lista: RespostaImportacoesLi,
  job: RespostaImportacaoLi,
): RespostaImportacoesLi {
  if (!lista.importacoes.some((j) => j.jobId === job.jobId)) return lista;
  return { importacoes: lista.importacoes.map((j) => (j.jobId === job.jobId ? job : j)) };
}

/** Write one job's fresh answer into the conta's cached list, when there is one. */
function gravarNaLista(qc: QueryClient, contaId: string, job: RespostaImportacaoLi): void {
  qc.setQueryData<RespostaImportacoesLi>(chaveListaImportacoesLi(contaId), (lista) =>
    lista === undefined ? lista : substituirImportacaoNaLista(lista, job),
  );
}

/**
 * One job, polled every {@link INTERVALO_JOB_MS} while it runs and never once
 * it ended. `jobId: null` reads nothing.
 *
 * ⚠️ `retry: false` on purpose, as on the Shopee cards: the next tick IS the
 * retry, and a backoff ladder against a 3 s interval stacks overlapping fetches
 * on a backend that is already down. A FIRST read that failed has no data, so
 * no interval: the screen's "Tentar de novo" (`consulta.refetch`) revives it.
 */
export function useImportacaoLi(
  contaId: string,
  jobId: string | null,
): LeituraImportacaoLi<RespostaImportacaoLi> {
  const { client, indisponivel } = useBackendLojaIntegrada();
  const qc = useQueryClient();
  const consulta = useQuery({
    queryKey: chaveImportacaoLi(contaId, jobId ?? ''),
    queryFn:
      client === null || jobId === null
        ? skipToken
        : async ({ signal }) => {
            const job = await client.importacao(contaId, jobId, { sinal: signal });
            gravarNaLista(qc, contaId, job);
            return job;
          },
    retry: false,
    refetchOnReconnect: false,
    refetchInterval: (q) => intervaloImportacaoLi(q.state.data),
  });
  return leitura(consulta, indisponivel);
}

/**
 * The most pages one whole read follows: 100 pages of the report's 500 items is
 * 50 000 store products, several times any store this import serves.
 */
export const MAX_PAGINAS_IMPORTACAO_LI = 100;

/**
 * Every page of a paged import answer, in order, following `proximo` until it
 * is `null`.
 *
 * A cursor that comes back again (the first page's `''` included) would loop
 * forever, and a list past {@link MAX_PAGINAS_IMPORTACAO_LI} pages is far past
 * any store: both are a backend answer this app cannot use, so they reject as
 * {@link LojaIntegradaClientRespostaInvalidaError} — the class every describer
 * here already narrows — instead of reading on.
 */
export async function lerTodasAsPaginasLi<P extends { readonly proximo: string | null }, T>(
  lerPagina: (depois: string | null) => Promise<P>,
  linhasDa: (pagina: P) => readonly T[],
): Promise<T[]> {
  const todas: T[] = [];
  const vistos = new Set<string>(['']);
  let depois: string | null = null;
  for (let lidas = 0; lidas < MAX_PAGINAS_IMPORTACAO_LI; lidas++) {
    const pagina = await lerPagina(depois);
    todas.push(...linhasDa(pagina));
    if (pagina.proximo === null) return todas;
    if (vistos.has(pagina.proximo)) throw paginacaoQueNaoAvanca();
    vistos.add(pagina.proximo);
    depois = pagina.proximo;
  }
  throw paginacaoQueNaoAvanca();
}

function paginacaoQueNaoAvanca(): LojaIntegradaClientRespostaInvalidaError {
  return new LojaIntegradaClientRespostaInvalidaError(
    'O backend da Loja Integrada respondeu uma paginação que não avança (o mesmo cursor de novo, ' +
      'ou páginas demais). Recarregue a página; se continuar, avise o suporte.',
    200,
    ['proximo'],
  );
}

/** The job slice the report reads need: which job, and whether it ended. */
export type JobDoRelatorioLi = Pick<RespostaImportacaoLi, 'jobId' | 'status'>;

/**
 * A job's WHOLE report (every page), for the result table's filters and
 * selection. `job: null` reads nothing. See the header for when it is re-read.
 */
export function useItensImportacaoLi(
  contaId: string,
  job: JobDoRelatorioLi | null,
  opcoes: OpcoesLeituraImportacaoHookLi = {},
): LeituraImportacaoLi<ItemRespostaImportacaoLi[]> {
  const { client, indisponivel } = useBackendLojaIntegrada();
  const estado = job === null ? 'parcial' : estadoDoRelatorio(job);
  const consulta = useQuery({
    queryKey: chaveItensImportacaoLi(contaId, job?.jobId ?? '', estado),
    queryFn:
      client === null || job === null
        ? skipToken
        : ({ signal }) =>
            lerTodasAsPaginasLi(
              (depois) => client.itensImportacao(contaId, job.jobId, depois, { sinal: signal }),
              (pagina) => pagina.itens,
            ),
    enabled: opcoes.habilitado ?? true,
    retry: false,
    refetchOnReconnect: false,
    staleTime: estado === 'final' ? Infinity : 0,
  });
  return leitura(consulta, indisponivel);
}

/**
 * A job's WHOLE tax-review list (the list the `lojaIntegradaRevisaoFiscal`
 * aviso names by its newest job). Never polled. `job: null` reads nothing.
 */
export function useRevisaoImportacaoLi(
  contaId: string,
  job: JobDoRelatorioLi | null,
  opcoes: OpcoesLeituraImportacaoHookLi = {},
): LeituraImportacaoLi<EntradaRespostaRevisaoFiscalLi[]> {
  const { client, indisponivel } = useBackendLojaIntegrada();
  const estado = job === null ? 'parcial' : estadoDoRelatorio(job);
  const consulta = useQuery({
    queryKey: chaveRevisaoImportacaoLi(contaId, job?.jobId ?? '', estado),
    queryFn:
      client === null || job === null
        ? skipToken
        : ({ signal }) =>
            lerTodasAsPaginasLi(
              (depois): Promise<RespostaRevisaoFiscalLi> =>
                client.revisaoImportacao(contaId, job.jobId, depois, { sinal: signal }),
              (pagina) => pagina.entradas,
            ),
    enabled: opcoes.habilitado ?? true,
    retry: false,
    refetchOnReconnect: false,
    staleTime: estado === 'final' ? Infinity : 0,
  });
  return leitura(consulta, indisponivel);
}

/* -------------------------------------------------------------------------- */
/*                               Start and cancel                              */
/* -------------------------------------------------------------------------- */

/**
 * The running job a busy start named, or `null`.
 *
 * Only an HTTP error whose code is EXACTLY `LI_IMPORTACAO_EM_ANDAMENTO` — the
 * cancel's `LI_IMPORTACAO_EM_CONFLITO` also means "still running" and must
 * never attach a card — and only an id in the job-id grammar, the one the
 * routes accept back in their path. An older backend's 409 with no id answers
 * `null`, and the start is then described, not attached.
 */
export function jobIdDaImportacaoEmAndamentoLi(err: unknown): string | null {
  if (!(err instanceof LojaIntegradaClientHttpError)) return null;
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) return null;
  if (err.code !== CODIGO_ERRO_LI.importacaoEmAndamento) return null;
  return err.jobId !== null && ID_IMPORTACAO_LI_REGEX.test(err.jobId) ? err.jobId : null;
}

/**
 * Whether a failure says the backend has no import routes at all: a 404 WITHOUT
 * the envelope (a backend older than the import), as opposed to a 404 that
 * carries a code — `LI_IMPORTACAO_NAO_ENCONTRADA` or `LI_CONTA_NAO_ENCONTRADA`,
 * a real answer from a route that exists.
 */
export function ehBackendSemImportacaoLi(err: unknown): boolean {
  return (
    err instanceof LojaIntegradaClientHttpError &&
    !(err instanceof LojaIntegradaClientRespostaInvalidaError) &&
    err.status === 404 &&
    err.code === null
  );
}

/** A start: the job to follow, and whether it was already running (the options were NOT applied). */
export interface InicioImportacaoLi {
  readonly jobId: string;
  /** `true` = a busy start attached to the conta's running job. */
  readonly reatado: boolean;
}

export interface AcoesImportacaoLi {
  /**
   * Start an import for the conta, or ATTACH to the one it is running: a 409
   * `LI_IMPORTACAO_EM_ANDAMENTO` naming the job resolves as `reatado: true`.
   * Every other failure rejects as itself, for the fan-out's
   * {@link describeImportacaoLiStartError}. Either way the conta's list is
   * re-read.
   */
  readonly iniciar: (
    contaId: string,
    opcoes: EntradaOpcoesImportacaoLi,
  ) => Promise<InicioImportacaoLi>;
  /**
   * Cancel a job. The answer (the job as written) replaces the job's cached
   * status and its row in the list; a failure re-reads both, so the card shows
   * the real state (an ended job, a job still running). Rejects as the client
   * did — describe it with {@link descreverFalhaCancelamentoImportacaoLi}.
   */
  readonly cancelar: (contaId: string, jobId: string) => Promise<RespostaImportacaoLi>;
}

/** The start and the cancel with their cache updates, or `null` while there is no client. */
export function useAcoesImportacaoLi(): AcoesImportacaoLi | null {
  const { client } = useBackendLojaIntegrada();
  const qc = useQueryClient();

  return useMemo(() => {
    if (client === null) return null;
    return {
      iniciar: async (contaId, opcoes) => {
        try {
          const { jobId } = await client.iniciarImportacao(contaId, opcoes);
          return { jobId, reatado: false };
        } catch (err) {
          // Rule 6: only THIS flow's busy start is turned into a job; everything
          // else goes on to the fan-out's describer, or past it.
          const jobId = jobIdDaImportacaoEmAndamentoLi(err);
          if (jobId === null) throw err;
          return { jobId, reatado: true };
        } finally {
          void qc.invalidateQueries({ queryKey: chaveListaImportacoesLi(contaId) });
        }
      },
      cancelar: async (contaId, jobId) => {
        let gravado = false;
        try {
          const job = await client.cancelarImportacao(contaId, jobId);
          qc.setQueryData(chaveImportacaoLi(contaId, job.jobId), job);
          gravarNaLista(qc, contaId, job);
          gravado = true;
          return job;
        } finally {
          if (!gravado) {
            void qc.invalidateQueries({ queryKey: chaveImportacaoLi(contaId, jobId), exact: true });
            void qc.invalidateQueries({ queryKey: chaveListaImportacoesLi(contaId) });
          }
        }
      },
    } satisfies AcoesImportacaoLi;
  }, [client, qc]);
}

/* -------------------------------------------------------------------------- */
/*                                  The copy                                   */
/* -------------------------------------------------------------------------- */

/**
 * The client's own classes, handed to the shared `JobCardShell` with every
 * cancel: a cancel failing with one of them is already described by
 * {@link descreverFalhaCancelamentoImportacaoLi}; anything else also reaches
 * the console under `[loja-integrada]`. The two subclasses (an unreadable 2xx,
 * a deadline) are covered through their parents.
 */
export const ERROS_DO_CLIENTE_LI: ErrosDoCliente = {
  tagLog: '[loja-integrada]',
  classes: [LojaIntegradaClientHttpError, LojaIntegradaClientNetworkError],
};

/**
 * The read switch off — every environment until the migration, and after it a
 * switch turned off or mis-set: the same code, so the copy names both causes,
 * as the panel's and the variation linker's copy do.
 */
const CHAMADAS_DESLIGADAS =
  'A importação de produtos só funciona depois da migração para este sistema: até lá as ' +
  'chamadas à Loja Integrada ficam desligadas neste backend (ou estão desligadas por ' +
  'configuração; se a migração já ocorreu, avise o suporte). Nenhuma importação foi iniciada.';

/** A backend older than the import (a 404 with no code). */
export const MENSAGEM_BACKEND_SEM_IMPORTACAO_LI =
  'Este backend da Loja Integrada ainda não oferece a importação de produtos (ele é anterior a ' +
  'esta tela). Avise o suporte para atualizá-lo.';

const SESSAO_RECUSADA =
  'O backend da Loja Integrada não aceitou sua sessão (HTTP 401). Recarregue a página e entre de ' +
  'novo.';

/** The copy of a coded START refusal, or `null` when the code has none of its own. */
function inicioPorCodigo(err: LojaIntegradaClientHttpError): JobErrorDescription | null {
  if (err.code === null) return null;
  switch (err.code) {
    case CODIGO_ERRO_LI.importacaoEmAndamento:
      // Yellow: a state, not a fault. With a usable `jobId` the start attaches
      // and this arm is never reached; without one, say so.
      return {
        color: 'yellow',
        message:
          'Esta conta já tem uma importação de produtos em andamento.' +
          (jobIdDaImportacaoEmAndamentoLi(err) === null
            ? ' Não foi possível identificá-la para acompanhá-la daqui: recarregue a página.'
            : ''),
      };
    case CODIGO_ERRO_LI.chamadasDesligadas:
      return { color: 'yellow', message: CHAMADAS_DESLIGADAS };
    case CODIGO_ERRO_LI.contaNaoEncontrada:
      return {
        color: 'red',
        message:
          'O backend da Loja Integrada não encontrou esta conta (ou ela não é uma conta da Loja ' +
          'Integrada).',
      };
    case CODIGO_ERRO_LI.contaInativa:
      return {
        color: 'red',
        message: 'Esta conta da Loja Integrada está inativa: ative-a antes de importar.',
      };
    case CODIGO_ERRO_LI.credencialAusente:
      return {
        color: 'red',
        message:
          'Esta conta não tem um token salvo. Salve um Personal Token na tela da conta antes de ' +
          'importar.',
      };
    case CODIGO_ERRO_LI.credencialInvalida:
      return {
        color: 'red',
        message:
          'A credencial salva desta conta está ilegível. Remova o token e salve-o de novo na tela ' +
          'da conta.',
      };
    case CODIGO_ERRO_LI.reconexaoPendente:
      return {
        color: 'red',
        message:
          'A Loja Integrada recusou o token desta conta. Salve um token válido na tela da conta ' +
          'antes de importar.',
      };
    case CODIGO_ERRO_LI.credencialAlterada:
      return {
        color: 'yellow',
        message: 'O token desta conta acabou de mudar. Tente de novo.',
      };
    case CODIGO_ERRO_LI.estacionamentoEmConflito:
      return {
        color: 'yellow',
        message:
          'A conta está sendo atualizada por outra operação neste momento. Tente de novo em ' +
          'instantes.',
      };
    case CODIGO_ERRO_LI.corpoInvalido:
      return {
        color: 'red',
        message:
          'O backend recusou as opções da importação' +
          (err.campos.length === 0 ? '' : ` (campos: ${resumirCampos(err.campos)})`) +
          '. Atualize a página; se continuar, avise o suporte.',
      };
    case CODIGO_ERRO_LI.idInvalido:
      return { color: 'red', message: 'O id desta conta não é válido para a importação.' };
    default:
      return null;
  }
}

/**
 * The fan-out port for "Importar produtos da loja": the copy of a failed start,
 * or `null` for anything that is not this client's failure — the fan commits
 * the contas that did start, then rethrows it (root `CLAUDE.md` rule 6). A
 * `FirebaseError` (the session token) is not this client's class either.
 *
 * ⚠️ MOST-DERIVED FIRST: an unreadable 2xx is also an HTTP error, and a
 * deadline is also a network error. Both may hide a job that DID start, so
 * their copy says to look before trying again — and trying again is safe: a
 * second start meets the first's 409 and attaches to it.
 */
export function describeImportacaoLiStartError(err: unknown): JobErrorDescription | null {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return {
      color: 'red',
      message: `${err.message} A importação pode ter sido iniciada: recarregue a página antes de tentar de novo.`,
    };
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    const porCodigo = inicioPorCodigo(err);
    if (porCodigo !== null) return porCodigo;
    if (ehBackendSemImportacaoLi(err)) {
      return { color: 'yellow', message: MENSAGEM_BACKEND_SEM_IMPORTACAO_LI };
    }
    if (err.status === 401) return { color: 'red', message: SESSAO_RECUSADA };
    if (err.status === 403) {
      return {
        color: 'red',
        message:
          'Você está sem permissão para importar produtos: o seu cargo precisa da permissão de ' +
          'escrita de Integrações.',
      };
    }
    return { color: 'red', message: err.message };
  }
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) {
    return {
      color: 'yellow',
      message:
        'O backend da Loja Integrada não respondeu a tempo, e a importação pode ter começado. ' +
        'Tente de novo: se ela já estiver em andamento, esta tela passa a acompanhá-la.',
    };
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return {
      color: 'red',
      message:
        'Não foi possível contatar o backend da Loja Integrada (falha de rede). Tente de novo: se ' +
        'a importação já tiver começado, esta tela passa a acompanhá-la.',
    };
  }
  return null;
}

/**
 * The copy of a failed CANCEL. ALWAYS returns copy: `JobCardShell` renders it
 * from an async click handler that must never rethrow. An ended job and a
 * conflict are benign races — the card re-reads the job either way.
 */
export function descreverFalhaCancelamentoImportacaoLi(err: unknown): string {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return `${err.message} O cancelamento provavelmente foi gravado: confira o estado da importação.`;
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    if (err.code === CODIGO_ERRO_LI.importacaoEncerrada) {
      return 'Esta importação já terminou. Nada foi alterado.';
    }
    if (err.code === CODIGO_ERRO_LI.importacaoEmConflito) {
      return (
        'A importação gravou um avanço a cada tentativa de cancelar e continua em andamento. ' +
        'Nada foi gravado: tente cancelar de novo.'
      );
    }
    if (err.code === CODIGO_ERRO_LI.importacaoNaoEncontrada) {
      return 'Importação não encontrada (ou ela é de outra conta).';
    }
    if (ehBackendSemImportacaoLi(err)) return MENSAGEM_BACKEND_SEM_IMPORTACAO_LI;
    if (err.status === 401) return SESSAO_RECUSADA;
    if (err.status === 403) {
      return (
        'Você está sem permissão para cancelar a importação: o seu cargo precisa da permissão de ' +
        'escrita de Integrações.'
      );
    }
    return err.message;
  }
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) {
    return (
      'O backend da Loja Integrada não respondeu a tempo; o cancelamento pode ter sido gravado. ' +
      'Confira o estado da importação.'
    );
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return 'Falha de rede ao cancelar a importação. Tente de novo.';
  }
  return 'Não foi possível cancelar a importação.';
}

/** A failed READ's copy, plus whether reading again could plausibly help. */
export interface FalhaLeituraImportacaoLi {
  readonly mensagem: string;
  readonly repetivel: boolean;
}

/**
 * The copy of a failed READ (the list, a job, its report, its tax-review list).
 * TOTAL by contract: the screen renders it in a retry alert and has nowhere to
 * rethrow to, so every input produces copy.
 *
 * ⚠️ A 404 with NO code is a backend older than the import — what the screen
 * shows INSTEAD of the panel; a 404 carrying `LI_IMPORTACAO_NAO_ENCONTRADA` is a
 * job that is gone or another conta's.
 */
export function descreverFalhaLeituraImportacaoLi(err: unknown): FalhaLeituraImportacaoLi {
  if (err instanceof LojaIntegradaClientRespostaInvalidaError) {
    return { mensagem: err.message, repetivel: false };
  }
  if (err instanceof LojaIntegradaClientHttpError) {
    if (err.code === CODIGO_ERRO_LI.importacaoNaoEncontrada) {
      return { mensagem: 'Importação não encontrada (ou ela é de outra conta).', repetivel: false };
    }
    if (err.code === CODIGO_ERRO_LI.idInvalido) {
      return { mensagem: 'O id da conta ou da importação não é válido.', repetivel: false };
    }
    if (ehBackendSemImportacaoLi(err)) {
      return { mensagem: MENSAGEM_BACKEND_SEM_IMPORTACAO_LI, repetivel: false };
    }
    if (err.status === 401) return { mensagem: SESSAO_RECUSADA, repetivel: false };
    if (err.status === 403) {
      return {
        mensagem:
          'Você está sem permissão para ver as importações: o seu cargo precisa da permissão de ' +
          'leitura de Integrações.',
        repetivel: false,
      };
    }
    // A 4xx is a verdict about this request and will answer the same way again;
    // a 5xx may not. `501` is as permanent as a 4xx.
    return { mensagem: err.message, repetivel: err.status >= 500 && err.status !== 501 };
  }
  if (err instanceof LojaIntegradaClientTempoEsgotadoError) {
    return {
      mensagem: 'O backend da Loja Integrada não respondeu a tempo. Tente de novo.',
      repetivel: true,
    };
  }
  if (err instanceof LojaIntegradaClientNetworkError) {
    return {
      mensagem:
        'Não foi possível contatar o backend da Loja Integrada (falha de rede). Tente de novo.',
      repetivel: true,
    };
  }
  if (err instanceof FirebaseError) {
    return {
      mensagem: 'Não foi possível confirmar sua sessão. Recarregue a página e entre de novo.',
      repetivel: true,
    };
  }
  return { mensagem: 'Não foi possível ler as importações de produtos.', repetivel: false };
}

/**
 * A backend that HAS the import but not its tax-review list: its route came
 * later (`…/importacoes/[jobId]/revisao`), so a backend between the two answers
 * that route alone with a 404 and no code.
 */
export const MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI =
  'Este backend da Loja Integrada ainda não oferece a lista de revisão fiscal das importações ' +
  '(ele é anterior a esta tela). Avise o suporte para atualizá-lo.';

/**
 * The copy of a failed TAX-REVIEW read: {@link descreverFalhaLeituraImportacaoLi}'s,
 * but for the probe. A 404 with no code on THIS route says the list is missing,
 * never the import — the result view that asks for it was opened from a job the
 * same backend answered.
 */
export function descreverFalhaLeituraRevisaoFiscalLi(err: unknown): FalhaLeituraImportacaoLi {
  if (ehBackendSemImportacaoLi(err)) {
    return { mensagem: MENSAGEM_BACKEND_SEM_REVISAO_FISCAL_LI, repetivel: false };
  }
  return descreverFalhaLeituraImportacaoLi(err);
}
