/**
 * The price RUN's claim, re-kick, cancel and status (step 13, PR 13-e), and the
 * producer of its pages. App-Hosting-safe: it reads and writes the run only
 * through the run's ONE write (`execucaoPrecoFirestore.ts`), reads the PRICE
 * lease raw by id, and enqueues page tasks only. It never reaches a page, the
 * feed core's lease I/O, Amazon or a write valve. The three run routes call it
 * through `envioManualPreco.ts` (step 13, PR 13-g).
 *
 * ## The claim ({@link iniciarExecucaoPrecoAmazon})
 *
 * 1. The queue valve FIRST (`AMAZON_TASKS_DISABLED=1`, as the root read it):
 *    closed ⇒ `fila-desligada` with ZERO Firestore operations, so a run is
 *    never claimed with no page that could walk it.
 * 2. The run, by id, masked ({@link CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON}),
 *    decided by {@link decidirInicioExecucaoPrecoAmazon} on the run's last
 *    progress (`progressoEmMs`, else `iniciadaEmMs`):
 *    - no run ⇒ CLAIMED with `create`;
 *    - an ended run (`concluida`, `cancelada`, `truncada`, `falhou`), or a live
 *      one more than {@link RECLAMACAO_EXECUCAO_PRECO_MS} (2 h) without
 *      progress ⇒ CLAIMED: the old run replaced whole, under the read's
 *      precondition, with a fresh `execucaoId`, so every task and batch of the
 *      old run stands down on that id;
 *    - a live run {@link RETOMADA_EXECUCAO_PRECO_MS} (15 min) or more without
 *      progress has lost its next task ⇒ page `proximaPagina` RE-KICKED, named
 *      by the stall (`nomeRetomadaPrecoAmazon`: a double click is one task),
 *      the SAME `execucaoId`, `retomada: true`, nothing written. ⚠️
 *      `ja-retomada` only says the stall's name is HELD: its re-kick is queued,
 *      or already ran and wrote nothing (the price valve `off`, a refused
 *      context), and Cloud Tasks refuses a used name for about an hour. Then
 *      no click re-kicks that stall until the name is free again or the 2-h
 *      reclaim;
 *    - any other live run ⇒ `AMAZON_PRECO_EXECUCAO_EM_CURSO`, with its id.
 *
 *    A lost precondition re-reads and re-decides (the run's one write).
 * 3. A claimed run: page 0 enqueued NAMED (`nomePaginaPrecoAmazon`). A NAMED
 *    enqueue failure (the valve's class, a transient, a missing or malformed
 *    region, a raw Cloud Tasks failure) ⇒ the run closed `falhou`
 *    (`enfileiramento-falhou`) on the claim's own precondition, re-derived
 *    while the run is still this one and live, and
 *    `AMAZON_PRECO_ENFILEIRAMENTO_FALHOU`: whether the page reached the queue
 *    is UNKNOWN, and a page that did land stops at its check of the run, the run
 *    no longer walking. A re-kick's failure writes nothing: the run stays
 *    stalled for the next click.
 *
 * Any other failure is a bug and crosses (rule 6); a run it leaves `paginando`
 * with no page is a stall, which the next click re-kicks after 15 minutes.
 *
 * ## The re-kick ({@link retomarExecucaoPrecoAmazon})
 *
 * The valve first, the same masked read and the same stall rule, with no
 * claim: a run that is not stalled is left alone. Its enqueue failures reach
 * its caller untouched.
 *
 * ## The cancel ({@link cancelarExecucaoPrecoAmazon})
 *
 * ONE patch, `fase: 'cancelada'`, through the run's one write, decided by
 * {@link cancelamentoExecucaoPrecoAmazon}: a live run; or a `concluida` one
 * whose work may still be in flight — a PENDING batch, or a `decisao` of
 * `tarefas` or `canario` taken less than {@link JANELA_TAREFAS_EXECUCAO_PRECO_MS}
 * (2 h) ago, whose tasks may still sit in the queue (retries, waits behind a
 * price feed). The run's pages stop at their check of the run, and its tasks
 * and batches stand down on the phase. Any other run is answered unchanged; no
 * run ⇒ `AMAZON_PRECO_EXECUCAO_NAO_ENCONTRADA`. A lost precondition re-derives
 * for the run the FIRST read found only: a run claimed in between is answered
 * unchanged, never cancelled (the run the operator saw already stands down on
 * the new id). A feed already submitted is not cancelled.
 *
 * ## The status ({@link resumoExecucaoPrecoAmazon})
 *
 * The run masked to what the summary shows, then — only when there is a run —
 * the PRICE lease by id, masked to its state and its last write. `null` for no
 * run. `parada` is exactly the stall a click would re-kick. A batch shows its
 * recorded end; with none, it is PENDING while `agora` is before the run's
 * `esperaLotesAteMs` (or no deadline is stored), else `sem-desfecho`. The price
 * feed in flight is the lease in any state but `livre`, with the age of its
 * holder's last write.
 *
 * ## The page producer ({@link criarProdutorExecucaoPrecoAmazon})
 *
 * A run's pages ride the JOBS queue (`processAmazonListingsJob`), with no
 * queue of their own: the listings flows' shared producer core
 * (`listings/produtorListing.ts`) bound to the jobs queue's valve class
 * ({@link AmazonLotesTarefasDesligadasError}) and delay cap, over a transport
 * a root binds to the jobs queue's path, resolved per enqueue and never with
 * the valve closed. A page is NAMED by (conta, run, page); a re-kick by the
 * stall; a throttled page's pause is UNNAMED,
 * {@link ATRASO_PAUSA_PAGINA_PRECO_S} later (a name would collide with the
 * dispatch still running under it). Each payload is checked against
 * `tarefaPaginaPrecoAmazonSchema` before its enqueue starts.
 *
 * Every answer is typed by the price routes' schemas (`CODIGO_ERRO_PRECO_AMAZON`,
 * `respostaInicioExecucaoPrecoAmazonSchema`,
 * `respostaCancelamentoExecucaoPrecoAmazonSchema`,
 * `resumoExecucaoPrecoAmazonSchema`), so a route only maps it to HTTP. ONE
 * `evento: 'preco'` line per claim, re-kick and cancel; none for the status.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import {
  CODIGO_ERRO_PRECO_AMAZON,
  CONTA_ID_AMAZON_REGEX,
  DECISAO_EXECUCAO_PRECO_AMAZON,
  ESTADO_LOTE_RESUMO_PRECO_AMAZON,
  ESTADO_VEZ_FEED_AMAZON,
  type EstadoLoteResumoPrecoAmazon,
  type ExecucaoPrecoAmazon,
  FASE_EXECUCAO_PRECO_AMAZON,
  FLUXO_FEED_AMAZON,
  ID_LOTE_FEED_AMAZON_REGEX,
  type LotePrecoAmazon,
  MOTIVO_FIM_EXECUCAO_PRECO_AMAZON,
  type RespostaCancelamentoExecucaoPrecoAmazon,
  type RespostaInicioExecucaoPrecoAmazon,
  type ResumoExecucaoPrecoAmazon,
  execucaoPrecoAmazonSchema,
  idVezFeedAmazon,
  respostaCancelamentoExecucaoPrecoAmazonSchema,
  respostaInicioExecucaoPrecoAmazonSchema,
  resumoExecucaoPrecoAmazonSchema,
  vezFeedAmazonSchema,
} from '@delfrance/schemas';

import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { FLUXO_AMAZON } from '../core/valvulas';
import {
  AmazonLotesRegiaoDaFilaInvalidaError,
  AmazonLotesTarefasDesligadasError,
  MAX_ATRASO_LOTE_S,
} from '../feeds/agendadorLotes';
import { VERSAO_TAREFA_LOTE_AMAZON } from '../feeds/tarefaLote';
import {
  type FilaListingAmazon,
  type LimiteDeAtrasoListingAmazon,
  type ResultadoEnfileiramentoListingAmazon,
  type VinculoFilaListingAmazon,
  atrasoDaFilaListingAmazon,
  enfileirarNaFilaListingAmazon,
  opcoesDaTarefaListingAmazon,
} from '../listings/produtorListing';
import {
  type LeituraExecucaoPrecoAmazon,
  escreverExecucaoPrecoAmazon,
  execucaoPrecoAmazonViva,
  lerExecucaoPrecoAmazon,
  mascaraExecucaoPrecoAmazon,
} from './execucaoPrecoFirestore';
import {
  TIPO_TAREFA_PRECO_AMAZON,
  type TarefaPaginaPrecoAmazon,
  nomePaginaPrecoAmazon,
  nomeRetomadaPrecoAmazon,
  tarefaPaginaPrecoAmazonSchema,
} from './tarefaPreco';

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

/** A live run this long (or longer) without progress has lost its next task: re-kicked (15 min). */
export const RETOMADA_EXECUCAO_PRECO_MS = 900_000;

/** A live run MORE than this without progress is reclaimed with a new id (2 h). */
export const RECLAMACAO_EXECUCAO_PRECO_MS = 7_200_000;

/** A `concluida` run's tasks may still be queued for this long after its decision (2 h). */
export const JANELA_TAREFAS_EXECUCAO_PRECO_MS = 7_200_000;

/** A throttled page's pause, in seconds, before the same page runs again. */
export const ATRASO_PAUSA_PAGINA_PRECO_S = 60;

/** The `fase` of every line this module writes. */
export const FASE_LOG_EXECUCAO_PRECO = 'execucao';

/** The run fields the claim and the re-kick decide from. */
export const CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON = [
  'execucaoId',
  'fase',
  'proximaPagina',
  'iniciadaEmMs',
  'progressoEmMs',
] as const;

/** The run fields the cancel decides from. */
export const CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON = [
  'execucaoId',
  'fase',
  'decisao',
  'lotes',
  'iniciadaEmMs',
  'progressoEmMs',
  'esperaLotesAteMs',
] as const;

/** The run fields the status shows. */
export const CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON = [
  'execucaoId',
  'fase',
  'motivo',
  'baixarPreco',
  'confirmarReducaoEmMassa',
  'decisao',
  'contagens',
  'amostraReducoes',
  'iniciadaEmMs',
  'progressoEmMs',
  'esperaLotesAteMs',
  'lotes',
] as const;

/** The PRICE lease fields the status shows. */
export const CAMPOS_VEZ_RESUMO_PRECO_AMAZON = ['estado', 'atualizadoEmMs'] as const;

const LEITURA_INICIO = mascaraExecucaoPrecoAmazon(CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON);
const LEITURA_CANCELAMENTO = mascaraExecucaoPrecoAmazon(CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON);
const LEITURA_RESUMO = mascaraExecucaoPrecoAmazon(CAMPOS_RESUMO_EXECUCAO_PRECO_AMAZON);

/** The run as the claim reads it. */
export type ExecucaoInicioPrecoAmazon = Pick<
  ExecucaoPrecoAmazon,
  (typeof CAMPOS_INICIO_EXECUCAO_PRECO_AMAZON)[number]
>;

/** The run as the cancel reads it. */
export type ExecucaoCancelamentoPrecoAmazon = Pick<
  ExecucaoPrecoAmazon,
  (typeof CAMPOS_CANCELAMENTO_EXECUCAO_PRECO_AMAZON)[number]
>;

/** The request a claim carries: the consent, the mass-decrease confirmation, the operator. */
const pedidoExecucaoPrecoAmazonSchema = execucaoPrecoAmazonSchema
  .pick({ baixarPreco: true, confirmarReducaoEmMassa: true, solicitadaPor: true })
  .strict();
export interface PedidoExecucaoPrecoAmazon {
  /** The consent to lower `our_price`. */
  readonly baixarPreco: boolean;
  /** Lifts the mass-decrease stop for THIS run. */
  readonly confirmarReducaoEmMassa: boolean;
  /** The operator's uid. */
  readonly solicitadaPor: string;
}

/** What a 503 says it knows (module header, "The claim", step 3). */
export const MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON = {
  /** The queue valve is closed: nothing was enqueued, nothing written. */
  filaDesligada: 'fila-desligada',
  /** The enqueue failed: whether the page reached the queue is unknown. */
  incerto: 'enfileiramento-incerto',
} as const;
export type MotivoEnfileiramentoExecucaoPrecoAmazon =
  (typeof MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON)[keyof typeof MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON];

/* -------------------------------------------------------------------------- */
/*                               The page producer                            */
/* -------------------------------------------------------------------------- */

/**
 * The transport, as a root binds it to the jobs queue's path — structurally,
 * the Admin SDK's `TaskQueue<TarefaPaginaPrecoAmazon>`.
 */
export type FilaExecucaoPrecoAmazon = FilaListingAmazon<TarefaPaginaPrecoAmazon>;

export interface OpcoesProdutorExecucaoPrecoAmazon {
  /** The jobs queue, resolved PER ENQUEUE and only when the valve is open. */
  readonly fila: () => FilaExecucaoPrecoAmazon;
  /** The queue valve, as the root read it (exactly `'1'` closes it). */
  readonly desligado: boolean;
}

/** The enqueue seam of a run's pages (module header, "The page producer"). */
export interface ProdutorExecucaoPrecoAmazon {
  /** Page `pagina` of the run, NAMED by (conta, run, page). */
  enfileirarPagina(
    contaId: string,
    execucaoId: string,
    pagina: number,
  ): Promise<ResultadoEnfileiramentoListingAmazon>;
  /** Page `pagina` of a stalled run, NAMED by the stall (`marcoMs`: the run's last progress). */
  enfileirarRetomada(
    contaId: string,
    execucaoId: string,
    pagina: number,
    marcoMs: number,
  ): Promise<ResultadoEnfileiramentoListingAmazon>;
  /** Page `pagina` again, UNNAMED, {@link ATRASO_PAUSA_PAGINA_PRECO_S} later (a throttled page). */
  enfileirarPausa(contaId: string, execucaoId: string, pagina: number): Promise<void>;
}

/** The jobs queue's delay bound, for the shared core's whole-second rule. */
const LIMITE_DE_ATRASO_PAGINA: LimiteDeAtrasoListingAmazon = {
  rotulo: 'inicioExecucaoPreco.ts',
  maximoS: MAX_ATRASO_LOTE_S,
  descricao: 'um dia',
};

/**
 * A page's payload, checked.
 *
 * @throws {ZodError} a conta, run or page outside the payload's grammar.
 */
function tarefaDaPagina(
  contaId: string,
  execucaoId: string,
  pagina: number,
): TarefaPaginaPrecoAmazon {
  return tarefaPaginaPrecoAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_PRECO_AMAZON.pagina,
    contaId,
    execucaoId,
    pagina,
  });
}

/**
 * The page producer (module header, "The page producer"): with the valve
 * closed, every enqueue rejects with {@link AmazonLotesTarefasDesligadasError}
 * and the queue is never resolved; otherwise each enqueue resolves the queue
 * and runs through the shared transient naming. A payload or a name outside
 * its grammar is refused before the enqueue starts.
 */
export function criarProdutorExecucaoPrecoAmazon(
  opcoes: OpcoesProdutorExecucaoPrecoAmazon,
): ProdutorExecucaoPrecoAmazon {
  const vinculo: VinculoFilaListingAmazon<TarefaPaginaPrecoAmazon> = {
    fila: () => opcoes.fila(),
    get desligado() {
      return opcoes.desligado;
    },
    desligada: () => new AmazonLotesTarefasDesligadasError(),
  };
  const enviar = (
    tarefa: TarefaPaginaPrecoAmazon,
    id: string | null,
    atrasoS: number | undefined,
  ): Promise<ResultadoEnfileiramentoListingAmazon> =>
    enfileirarNaFilaListingAmazon(
      vinculo,
      tarefa,
      id,
      opcoesDaTarefaListingAmazon(id, atrasoDaFilaListingAmazon(atrasoS, LIMITE_DE_ATRASO_PAGINA)),
    );
  return {
    async enfileirarPagina(contaId, execucaoId, pagina) {
      const tarefa = tarefaDaPagina(contaId, execucaoId, pagina);
      return enviar(tarefa, nomePaginaPrecoAmazon(contaId, execucaoId, pagina), undefined);
    },
    async enfileirarRetomada(contaId, execucaoId, pagina, marcoMs) {
      const tarefa = tarefaDaPagina(contaId, execucaoId, pagina);
      return enviar(
        tarefa,
        nomeRetomadaPrecoAmazon(contaId, execucaoId, pagina, marcoMs),
        undefined,
      );
    },
    async enfileirarPausa(contaId, execucaoId, pagina) {
      await enviar(tarefaDaPagina(contaId, execucaoId, pagina), null, ATRASO_PAUSA_PAGINA_PRECO_S);
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                              The pure decisions                             */
/* -------------------------------------------------------------------------- */

/** The run's last progress (ms): its page's, else its claim's. */
function marcoMs(run: Pick<ExecucaoPrecoAmazon, 'iniciadaEmMs' | 'progressoEmMs'>): number {
  return run.progressoEmMs ?? run.iniciadaEmMs;
}

/**
 * Whether a run has STALLED at `agoraMs` (module header): live, and
 * {@link RETOMADA_EXECUCAO_PRECO_MS} or more since its last progress — the
 * stall a click re-kicks, and the status's `parada`. Pure.
 */
export function paradaExecucaoPrecoAmazon(
  run: Pick<ExecucaoPrecoAmazon, 'fase' | 'iniciadaEmMs' | 'progressoEmMs'>,
  agoraMs: number,
): boolean {
  return execucaoPrecoAmazonViva(run.fase) && agoraMs - marcoMs(run) >= RETOMADA_EXECUCAO_PRECO_MS;
}

/** Where a stalled run resumes: its next page, and the stall's identity. */
export interface RetomadaExecucaoPrecoAmazon {
  readonly pagina: number;
  /** ms — the run's last progress: the stall's identity in the re-kick's name. */
  readonly marcoMs: number;
}

/** A stalled run's re-kick, or `null` when the run needs none. Pure. */
export function retomadaExecucaoPrecoAmazon(
  run: ExecucaoInicioPrecoAmazon | null,
  agoraMs: number,
): RetomadaExecucaoPrecoAmazon | null {
  if (run === null || !paradaExecucaoPrecoAmazon(run, agoraMs)) return null;
  return { pagina: run.proximaPagina, marcoMs: marcoMs(run) };
}

/** What the claim does with the run it read (module header, "The claim"). */
export type DecisaoInicioExecucaoPrecoAmazon =
  | { readonly tipo: 'criar' }
  | { readonly tipo: 'reclamar' }
  | ({ readonly tipo: 'retomar' } & RetomadaExecucaoPrecoAmazon)
  | { readonly tipo: 'em-curso' };

/** The claim's decision (module header, "The claim", step 2). Pure. */
export function decidirInicioExecucaoPrecoAmazon(
  run: ExecucaoInicioPrecoAmazon | null,
  agoraMs: number,
): DecisaoInicioExecucaoPrecoAmazon {
  if (run === null) return { tipo: 'criar' };
  if (!execucaoPrecoAmazonViva(run.fase)) return { tipo: 'reclamar' };
  if (agoraMs - marcoMs(run) > RECLAMACAO_EXECUCAO_PRECO_MS) return { tipo: 'reclamar' };
  const retomada = retomadaExecucaoPrecoAmazon(run, agoraMs);
  return retomada === null ? { tipo: 'em-curso' } : { tipo: 'retomar', ...retomada };
}

/**
 * Whether a batch is PENDING (module header, "The status"): no end recorded,
 * and the run's wait not over (no deadline stored counts as not over). Pure.
 */
export function lotePendentePrecoAmazon(
  lote: Pick<LotePrecoAmazon, 'desfecho'>,
  esperaLotesAteMs: number | null,
  agoraMs: number,
): boolean {
  return lote.desfecho === null && (esperaLotesAteMs === null || agoraMs < esperaLotesAteMs);
}

/** How the status shows a batch (module header, "The status"). Pure. */
export function estadoDoLotePrecoAmazon(
  lote: Pick<LotePrecoAmazon, 'desfecho'>,
  esperaLotesAteMs: number | null,
  agoraMs: number,
): EstadoLoteResumoPrecoAmazon {
  if (lote.desfecho !== null) return lote.desfecho;
  return lotePendentePrecoAmazon(lote, esperaLotesAteMs, agoraMs)
    ? ESTADO_LOTE_RESUMO_PRECO_AMAZON.pendente
    : ESTADO_LOTE_RESUMO_PRECO_AMAZON.semDesfecho;
}

/** Whether the cancel cancels this run (module header, "The cancel"). Pure. */
export function cancelamentoExecucaoPrecoAmazon(
  run: ExecucaoCancelamentoPrecoAmazon,
  agoraMs: number,
): boolean {
  if (execucaoPrecoAmazonViva(run.fase)) return true;
  if (run.fase !== FASE_EXECUCAO_PRECO_AMAZON.concluida) return false;
  const lotes: readonly LotePrecoAmazon[] = Object.values(run.lotes);
  if (lotes.some((lote) => lotePendentePrecoAmazon(lote, run.esperaLotesAteMs, agoraMs))) {
    return true;
  }
  const comTarefas =
    run.decisao === DECISAO_EXECUCAO_PRECO_AMAZON.tarefas ||
    run.decisao === DECISAO_EXECUCAO_PRECO_AMAZON.canario;
  return comTarefas && agoraMs - marcoMs(run) < JANELA_TAREFAS_EXECUCAO_PRECO_MS;
}

/* -------------------------------------------------------------------------- */
/*                                The answers                                  */
/* -------------------------------------------------------------------------- */

/** What the claim answers: a route maps `ok` to 202 and each `codigo` to its status. */
export type ResultadoInicioExecucaoPrecoAmazon =
  | {
      readonly ok: true;
      readonly acao: 'iniciada' | 'retomada' | 'ja-retomada';
      readonly corpo: RespostaInicioExecucaoPrecoAmazon;
    }
  | {
      readonly ok: false;
      readonly codigo: typeof CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO;
      readonly execucaoId: string;
      readonly motivo: null;
    }
  | {
      readonly ok: false;
      readonly codigo: typeof CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU;
      /** The run the failed enqueue was for; `null` when the valve refused before any read. */
      readonly execucaoId: string | null;
      readonly motivo: MotivoEnfileiramentoExecucaoPrecoAmazon;
    };

/** What the re-kick did. */
export type ResultadoRetomadaExecucaoPrecoAmazon =
  | { readonly acao: 'fila-desligada' | 'sem-execucao' }
  | { readonly acao: 'sem-retomada'; readonly execucaoId: string }
  | {
      readonly acao: 'retomada' | 'ja-retomada';
      readonly execucaoId: string;
      readonly pagina: number;
    };

/** What the cancel answers: `ok` is a 200, the `codigo` a 404. */
export type ResultadoCancelamentoExecucaoPrecoAmazon =
  | {
      readonly ok: true;
      readonly acao: 'cancelada' | 'inalterada';
      readonly corpo: RespostaCancelamentoExecucaoPrecoAmazon;
    }
  | {
      readonly ok: false;
      readonly codigo: typeof CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA;
    };

/** What the claim, the re-kick and the cancel need. */
export interface DepsExecucaoPrecoAmazon {
  /** The queue valve (`AMAZON_TASKS_DISABLED`), as the root read it: `true` exactly for `'1'`. */
  readonly filaDesligada: boolean;
  /** The page producer, built only at an enqueue, never with the valve closed. */
  readonly produtor: () => ProdutorExecucaoPrecoAmazon;
  /** Now, in ms. */
  readonly agora: () => number;
  /** A fresh run id, under the feed core's id grammar. */
  readonly gerarExecucaoId: () => string;
  readonly logger: LoggerAmazon;
}

/**
 * The PRICE lease does not parse: only a hand edit makes one (the feed core
 * writes it through its schema). The status never guesses a feed's state.
 */
export class VezPrecoInvalidaError extends Error {
  readonly contaId: string;
  /** The fields Zod blamed — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, campos: readonly string[]) {
    super(
      `A vez do feed de preço da conta ${contaId} não é válida (campos: ${campos.join(', ')}).`,
    );
    this.name = 'VezPrecoInvalidaError';
    this.contaId = contaId;
    this.campos = campos;
  }
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                    */
/* -------------------------------------------------------------------------- */

/** A conta id under its grammar, or a `RangeError` naming the rule (never the value). */
function exigirConta(contaId: string): void {
  if (typeof contaId !== 'string' || !CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('inicioExecucaoPreco.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
}

/** ONE line of this module (module header). */
function registrar(
  logger: LoggerAmazon,
  contaId: string,
  severidade: SeveridadeAmazon,
  etapa: 'inicio' | 'retomada' | 'cancelamento',
  acao: string,
  campos: CamposLogAmazon,
): void {
  registrarEventoAmazon(
    logger,
    'preco',
    severidade,
    `[amazon/preco] execução: ${etapa} (${acao})`,
    { fase: FASE_LOG_EXECUCAO_PRECO, etapa, acao, ...campos },
    { conta: contaId, fluxo: FLUXO_AMAZON.preco },
  );
}

/**
 * A rejection of the page producer this module answers, by CLASS (rule 6),
 * named as its line names it: the jobs queue's valve, a malformed or missing
 * region, a named transient, a raw Cloud Tasks failure. `null` for anything
 * else, which crosses.
 */
function falhaDeEnfileiramento(err: unknown): string | null {
  if (
    err instanceof AmazonLotesTarefasDesligadasError ||
    err instanceof AmazonLotesRegiaoDaFilaInvalidaError ||
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof MissingRegionError
  ) {
    return err.name;
  }
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  return null;
}

/** One enqueue whose NAMED failure is answered (module header, "The claim", step 3). */
type Enfileiramento =
  | { readonly ok: true; readonly resultado: ResultadoEnfileiramentoListingAmazon }
  | {
      readonly ok: false;
      readonly falha: string;
      readonly motivo: MotivoEnfileiramentoExecucaoPrecoAmazon;
    };

async function enfileirar(
  fn: () => Promise<ResultadoEnfileiramentoListingAmazon>,
): Promise<Enfileiramento> {
  try {
    return { ok: true, resultado: await fn() };
  } catch (err) {
    const falha = falhaDeEnfileiramento(err);
    if (falha === null) throw err;
    return {
      ok: false,
      falha,
      motivo:
        err instanceof AmazonLotesTarefasDesligadasError
          ? MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada
          : MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.incerto,
    };
  }
}

/* -------------------------------------------------------------------------- */
/*                                  The claim                                  */
/* -------------------------------------------------------------------------- */

/** What the claim's read decided (module header, "The claim", step 2). */
type ResultadoReivindicacao =
  | { readonly tipo: 'criar' | 'reclamar'; readonly execucaoId: string }
  | ({ readonly tipo: 'retomar'; readonly execucaoId: string } & RetomadaExecucaoPrecoAmazon)
  | { readonly tipo: 'em-curso'; readonly execucaoId: string };

/** One claim, its line's campos and severity. */
interface DesfechoInicio {
  readonly resultado: ResultadoInicioExecucaoPrecoAmazon;
  readonly acao: string;
  readonly severidade: SeveridadeAmazon;
  readonly campos: CamposLogAmazon;
}

/** A 503 of the claim. */
function falhaDeInicio(
  execucaoId: string | null,
  motivo: MotivoEnfileiramentoExecucaoPrecoAmazon,
): ResultadoInicioExecucaoPrecoAmazon {
  return { ok: false, codigo: CODIGO_ERRO_PRECO_AMAZON.ENFILEIRAMENTO_FALHOU, execucaoId, motivo };
}

/** A 202 of the claim. */
function aceitaNoInicio(
  acao: 'iniciada' | 'retomada' | 'ja-retomada',
  execucaoId: string,
): ResultadoInicioExecucaoPrecoAmazon {
  return {
    ok: true,
    acao,
    corpo: respostaInicioExecucaoPrecoAmazonSchema.parse({
      execucaoId,
      retomada: acao !== 'iniciada',
    }),
  };
}

/**
 * The claimed run closed `falhou` after its page 0 could not be enqueued
 * (module header, "The claim", step 3): on the claim's own precondition,
 * re-derived while the run is still `execucaoId` and live.
 */
async function fecharComoFalha(
  db: Firestore,
  contaId: string,
  execucaoId: string,
  inicial: LeituraExecucaoPrecoAmazon<ExecucaoInicioPrecoAmazon>,
): Promise<boolean> {
  const { resposta } = await escreverExecucaoPrecoAmazon(
    db,
    contaId,
    LEITURA_INICIO,
    (lida) => {
      const run = lida.estado;
      if (run === null || run.execucaoId !== execucaoId || !execucaoPrecoAmazonViva(run.fase)) {
        return { escrita: null, resposta: false };
      }
      return {
        escrita: {
          tipo: 'campos',
          campos: {
            fase: FASE_EXECUCAO_PRECO_AMAZON.falhou,
            motivo: MOTIVO_FIM_EXECUCAO_PRECO_AMAZON.enfileiramentoFalhou,
          },
        },
        resposta: true,
      };
    },
    inicial,
  );
  return resposta;
}

async function iniciar(
  db: Firestore,
  contaId: string,
  pedido: PedidoExecucaoPrecoAmazon,
  deps: DepsExecucaoPrecoAmazon,
): Promise<DesfechoInicio> {
  // 1. The queue valve, before ANY read: a closed valve claims nothing.
  if (deps.filaDesligada) {
    return {
      resultado: falhaDeInicio(null, MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada),
      acao: MOTIVO_ENFILEIRAMENTO_EXECUCAO_PRECO_AMAZON.filaDesligada,
      severidade: 'WARNING',
      campos: { execucaoId: null },
    };
  }

  // 2. The run, decided and (for a claim) written on the read's precondition.
  const reivindicacao = await escreverExecucaoPrecoAmazon<
    ExecucaoInicioPrecoAmazon,
    ResultadoReivindicacao
  >(db, contaId, LEITURA_INICIO, (lida) => {
    const agoraMs = deps.agora();
    const decisao = decidirInicioExecucaoPrecoAmazon(lida.estado, agoraMs);
    const run = lida.estado;
    if (run !== null && decisao.tipo === 'em-curso') {
      return { escrita: null, resposta: { tipo: 'em-curso', execucaoId: run.execucaoId } };
    }
    if (run !== null && decisao.tipo === 'retomar') {
      return { escrita: null, resposta: { ...decisao, execucaoId: run.execucaoId } };
    }
    const execucaoId = deps.gerarExecucaoId();
    if (!ID_LOTE_FEED_AMAZON_REGEX.test(execucaoId)) {
      throw new RangeError('inicioExecucaoPreco.ts: execucaoId gerado fora da gramática');
    }
    return {
      escrita: {
        tipo: 'execucao',
        execucao: {
          execucaoId,
          fase: FASE_EXECUCAO_PRECO_AMAZON.paginando,
          baixarPreco: pedido.baixarPreco,
          confirmarReducaoEmMassa: pedido.confirmarReducaoEmMassa,
          solicitadaPor: pedido.solicitadaPor,
          iniciadaEmMs: agoraMs,
        },
      },
      resposta: { tipo: decisao.tipo === 'criar' ? 'criar' : 'reclamar', execucaoId },
    };
  });
  const r = reivindicacao.resposta;

  if (r.tipo === 'em-curso') {
    return {
      resultado: {
        ok: false,
        codigo: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_EM_CURSO,
        execucaoId: r.execucaoId,
        motivo: null,
      },
      acao: 'em-curso',
      severidade: 'INFO',
      campos: { execucaoId: r.execucaoId },
    };
  }

  if (r.tipo === 'retomar') {
    // The stalled page, named by the stall; a failure writes nothing.
    const e = await enfileirar(() =>
      deps.produtor().enfileirarRetomada(contaId, r.execucaoId, r.pagina, r.marcoMs),
    );
    if (!e.ok) {
      return {
        resultado: falhaDeInicio(r.execucaoId, e.motivo),
        acao: 'enfileiramento-falhou',
        severidade: 'ERROR',
        campos: { execucaoId: r.execucaoId, pagina: r.pagina, falha: e.falha, motivo: e.motivo },
      };
    }
    const acao = e.resultado === 'ja-enfileirada' ? 'ja-retomada' : 'retomada';
    return {
      resultado: aceitaNoInicio(acao, r.execucaoId),
      acao,
      severidade: 'INFO',
      campos: { execucaoId: r.execucaoId, pagina: r.pagina },
    };
  }

  // 3. A claimed run: page 0, NAMED.
  const { writeTime, escrito } = reivindicacao;
  if (writeTime === null || escrito === null) {
    throw new TypeError('inicioExecucaoPreco.ts: uma reivindicação sempre grava a execução');
  }
  const e = await enfileirar(() => deps.produtor().enfileirarPagina(contaId, r.execucaoId, 0));
  if (e.ok) {
    return {
      resultado: aceitaNoInicio('iniciada', r.execucaoId),
      acao: 'iniciada',
      severidade: 'INFO',
      campos: { execucaoId: r.execucaoId, reivindicacao: r.tipo, pagina: 0 },
    };
  }
  const fechada = await fecharComoFalha(db, contaId, r.execucaoId, {
    estado: LEITURA_INICIO.schema.parse(escrito),
    updateTime: writeTime,
    readTime: writeTime,
  });
  return {
    resultado: falhaDeInicio(r.execucaoId, e.motivo),
    acao: 'enfileiramento-falhou',
    severidade: 'ERROR',
    campos: {
      execucaoId: r.execucaoId,
      reivindicacao: r.tipo,
      pagina: 0,
      falha: e.falha,
      motivo: e.motivo,
      fechadaComoFalha: fechada,
    },
  };
}

/**
 * The claim (module header, "The claim"): the queue valve first, then claim a
 * run, re-kick a stalled one, or answer a live one's id. Its caller checks the
 * read switch, the queue's region and the conta first.
 *
 * @throws {RangeError} a conta id outside its grammar, or a generated run id
 *   outside the feed core's (nothing written).
 * @throws a `ZodError` for a request outside its shape (nothing read).
 * @throws {ExecucaoPrecoInvalidaError} a stored run that no longer parses
 *   (nothing written).
 * @throws {ExecucaoPrecoEmConflitoError} every attempt of the claim lost its
 *   precondition.
 * @throws Firestore's own failures, and a producer failure no class names,
 *   untouched.
 */
export async function iniciarExecucaoPrecoAmazon(
  db: Firestore,
  contaId: string,
  pedido: PedidoExecucaoPrecoAmazon,
  deps: DepsExecucaoPrecoAmazon,
): Promise<ResultadoInicioExecucaoPrecoAmazon> {
  exigirConta(contaId);
  const p = pedidoExecucaoPrecoAmazonSchema.parse(pedido);
  const d = await iniciar(db, contaId, p, deps);
  registrar(deps.logger, contaId, d.severidade, 'inicio', d.acao, d.campos);
  return d.resultado;
}

/* -------------------------------------------------------------------------- */
/*                                 The re-kick                                 */
/* -------------------------------------------------------------------------- */

/**
 * The re-kick (module header, "The re-kick"): a stalled run's next page, named
 * by the stall; nothing for any other run.
 *
 * @throws {RangeError} a conta id outside its grammar.
 * @throws {ExecucaoPrecoInvalidaError} a stored run that no longer parses.
 * @throws the producer's and Firestore's own failures, untouched.
 */
export async function retomarExecucaoPrecoAmazon(
  db: Firestore,
  contaId: string,
  deps: Pick<DepsExecucaoPrecoAmazon, 'filaDesligada' | 'produtor' | 'agora' | 'logger'>,
): Promise<ResultadoRetomadaExecucaoPrecoAmazon> {
  exigirConta(contaId);
  const r = await retomar(db, contaId, deps);
  registrar(
    deps.logger,
    contaId,
    r.acao === 'fila-desligada' ? 'WARNING' : 'INFO',
    'retomada',
    r.acao,
    {
      execucaoId: 'execucaoId' in r ? r.execucaoId : null,
      pagina: 'pagina' in r ? r.pagina : null,
    },
  );
  return r;
}

async function retomar(
  db: Firestore,
  contaId: string,
  deps: Pick<DepsExecucaoPrecoAmazon, 'filaDesligada' | 'produtor' | 'agora'>,
): Promise<ResultadoRetomadaExecucaoPrecoAmazon> {
  if (deps.filaDesligada) return { acao: 'fila-desligada' };
  const run = (await lerExecucaoPrecoAmazon(db, contaId, LEITURA_INICIO)).estado;
  if (run === null) return { acao: 'sem-execucao' };
  const retomada = retomadaExecucaoPrecoAmazon(run, deps.agora());
  if (retomada === null) return { acao: 'sem-retomada', execucaoId: run.execucaoId };
  const r = await deps
    .produtor()
    .enfileirarRetomada(contaId, run.execucaoId, retomada.pagina, retomada.marcoMs);
  return {
    acao: r === 'ja-enfileirada' ? 'ja-retomada' : 'retomada',
    execucaoId: run.execucaoId,
    pagina: retomada.pagina,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 The cancel                                  */
/* -------------------------------------------------------------------------- */

/**
 * The cancel (module header, "The cancel"): ONE patch through the run's one
 * write, or the run answered unchanged.
 *
 * @throws {RangeError} a conta id outside its grammar.
 * @throws {ExecucaoPrecoInvalidaError} a stored run that no longer parses.
 * @throws {ExecucaoPrecoEmConflitoError} every attempt lost its precondition.
 * @throws Firestore's own failures, untouched.
 */
export async function cancelarExecucaoPrecoAmazon(
  db: Firestore,
  contaId: string,
  deps: Pick<DepsExecucaoPrecoAmazon, 'agora' | 'logger'>,
): Promise<ResultadoCancelamentoExecucaoPrecoAmazon> {
  exigirConta(contaId);
  // The run the FIRST read found: a re-derive cancels that run or nothing.
  let alvo: string | null = null;
  const { resposta } = await escreverExecucaoPrecoAmazon<
    ExecucaoCancelamentoPrecoAmazon,
    ResultadoCancelamentoExecucaoPrecoAmazon
  >(db, contaId, LEITURA_CANCELAMENTO, (lida) => {
    const run = lida.estado;
    if (run === null) {
      return {
        escrita: null,
        resposta: { ok: false, codigo: CODIGO_ERRO_PRECO_AMAZON.EXECUCAO_NAO_ENCONTRADA },
      };
    }
    alvo ??= run.execucaoId;
    if (run.execucaoId !== alvo || !cancelamentoExecucaoPrecoAmazon(run, deps.agora())) {
      return {
        escrita: null,
        resposta: {
          ok: true,
          acao: 'inalterada',
          corpo: respostaCancelamentoExecucaoPrecoAmazonSchema.parse({
            execucaoId: run.execucaoId,
            fase: run.fase,
          }),
        },
      };
    }
    return {
      escrita: { tipo: 'campos', campos: { fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada } },
      resposta: {
        ok: true,
        acao: 'cancelada',
        corpo: respostaCancelamentoExecucaoPrecoAmazonSchema.parse({
          execucaoId: run.execucaoId,
          fase: FASE_EXECUCAO_PRECO_AMAZON.cancelada,
        }),
      },
    };
  });
  registrar(
    deps.logger,
    contaId,
    'INFO',
    'cancelamento',
    resposta.ok ? resposta.acao : 'sem-execucao',
    resposta.ok
      ? { execucaoId: resposta.corpo.execucaoId, faseExecucao: resposta.corpo.fase }
      : { execucaoId: null },
  );
  return resposta;
}

/* -------------------------------------------------------------------------- */
/*                                 The status                                  */
/* -------------------------------------------------------------------------- */

/** The PRICE lease's feed in flight, or `null` (module header, "The status"). */
async function feedEmCurso(
  db: Firestore,
  contaId: string,
  agoraMs: number,
): Promise<ResumoExecucaoPrecoAmazon['feedEmCurso']> {
  const ref = vezFeedAmazonCollection.docRef(
    db,
    {},
    idVezFeedAmazon(FLUXO_FEED_AMAZON.preco, contaId),
  );
  const [snap] = await db.getAll(ref, { fieldMask: [...CAMPOS_VEZ_RESUMO_PRECO_AMAZON] });
  if (snap?.exists !== true) return null;
  const lida = vezFeedAmazonSchema
    .pick({ estado: true, atualizadoEmMs: true })
    .safeParse(snap.data());
  if (!lida.success) {
    const campos = new Set(lida.error.issues.map((i) => String(i.path[0] ?? '(raiz)')));
    throw new VezPrecoInvalidaError(contaId, [...campos].sort());
  }
  const { estado, atualizadoEmMs } = lida.data;
  if (estado === ESTADO_VEZ_FEED_AMAZON.livre) return null;
  return { estado, idadeMs: Math.max(0, agoraMs - atualizadoEmMs) };
}

/**
 * The status (module header, "The status"): the run's summary, or `null` when
 * the conta has no run.
 *
 * @throws {RangeError} a conta id outside its grammar.
 * @throws {ExecucaoPrecoInvalidaError} a stored run that no longer parses.
 * @throws {VezPrecoInvalidaError} a price lease that no longer parses.
 * @throws Firestore's own failures, untouched.
 */
export async function resumoExecucaoPrecoAmazon(
  db: Firestore,
  contaId: string,
  deps: Pick<DepsExecucaoPrecoAmazon, 'agora'>,
): Promise<ResumoExecucaoPrecoAmazon | null> {
  exigirConta(contaId);
  const run = (await lerExecucaoPrecoAmazon(db, contaId, LEITURA_RESUMO)).estado;
  if (run === null) return null;
  const agoraMs = deps.agora();
  const lotes = Object.entries(run.lotes)
    .map(([indice, lote]) => ({
      indice: Number(indice),
      execucaoIdLote: lote.execucaoIdLote,
      parteInicial: lote.parteInicial,
      partes: lote.partes,
      itens: lote.itens,
      estado: estadoDoLotePrecoAmazon(lote, run.esperaLotesAteMs, agoraMs),
      motivoSemEnvio: lote.motivoSemEnvio,
    }))
    .sort((a, b) => a.indice - b.indice);
  return resumoExecucaoPrecoAmazonSchema.parse({
    execucaoId: run.execucaoId,
    fase: run.fase,
    motivo: run.motivo,
    baixarPreco: run.baixarPreco,
    confirmarReducaoEmMassa: run.confirmarReducaoEmMassa,
    decisao: run.decisao,
    contagens: run.contagens,
    amostraReducoes: run.amostraReducoes,
    iniciadaEmMs: run.iniciadaEmMs,
    progressoEmMs: run.progressoEmMs,
    esperaLotesAteMs: run.esperaLotesAteMs,
    parada: paradaExecucaoPrecoAmazon(run, agoraMs),
    lotes,
    feedEmCurso: await feedEmCurso(db, contaId, agoraMs),
  });
}
