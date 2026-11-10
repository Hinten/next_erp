/**
 * The body of the Easy Ship scheduling queue `processAmazonEasyShipSchedule`
 * (step 15, PR 15-c): ONE dispatch, A0–A9, in this exact order. The function
 * file (`functions/src/filaAgendamento.ts`) binds the deps and writes the ONE
 * `evento: 'agendamento'` dispatch line this module's result describes
 * ({@link registrarDespachoAgendamentoAmazon}).
 *
 * ## The ladder
 *
 * - **A0** — `tarefaAgendamentoAmazonSchema` (`.strict()`): an invalid payload
 *   is dropped with a WARNING.
 * - **A1** — the pure proof: the payload's pedido id must be
 *   `makePedidoIdAmazon(contaId, orderId)`, else the same WARNING and a drop,
 *   before any read. The payload carries the conta and the order precisely so
 *   that A2 needs no read.
 * - **A2** — the scheduling valve, read ONCE (`lerValvula`) and logged
 *   (`registrarValvulaAmazon`), then the target (`decidirAlvo`). `off` ⇒ the
 *   dispatch ends `agendamento-desligado` with ZERO Firestore reads and zero
 *   Amazon calls — every environment's state until the window (W8).
 * - **A3** — ONE raw pedido read and the stored gates
 *   (`gatesArmazenadosAgendamentoAmazon`: ownership, a cancelled or blocked
 *   sale, goods out; `nao-amazon` and `outra-integradora` at WARNING, the rest
 *   at INFO). Its `readTime` clocks EVERY aviso of the dispatch, and its stored
 *   watermark (`pisoDoPedidoAmazon`) floors the live read. Then ONE unfiltered
 *   `pedidos/{id}/nfev4` listing (a subcollection read by id: no index) through
 *   the NF-e gate (`gateNotasAgendamentoAmazon`, step-15 plan §3 decision 27),
 *   read at run time so an NF-e cancelled after the enqueue is seen.
 * - **A4** — the context (the read switch FIRST): the switch off, an inactive,
 *   unknown, unconnected or parked conta, or a credential refusal ⇒ ONE WARNING
 *   (`chamadas-desligadas` / `conta-indisponivel`), no aviso: the conta's own
 *   avisos exist, and the checkout print recovers.
 * - **A5** — the run (`executarAgendamentoAmazon`, `modo: 'tarefa'`): the live
 *   order through the one `getOrder` caller, floored by A3's watermark (a lagging
 *   read throws the retryable `AmazonLeituraDefasadaError`), the pure decision
 *   and plan with A3's NF-e gate applied.
 * - **A6** — a plan that writes nothing (`sem-escrita`, or a dry-run of one):
 *   `ja-agendado` resolves the two scheduling motivos; `aceite-pendente` from
 *   the acceptance re-reads after the next `espera` wait (an UNNAMED re-enqueue)
 *   and ends `aceite-nao-espelhado` at the bound, while from an import it is
 *   only logged (that read already showed the acceptance); an open cancellation
 *   request raises the EXISTING `aceitar-cancelamento`; the NF-e gate's
 *   refusals are a WARNING with no aviso (step 14 raised its own), and so is
 *   `nf-nao-requerida`; every other refusal is logged. A dry-run (or `on` outside
 *   the canary) of a plan that WOULD schedule is the engine's diff line only.
 * - **A7** — the write (`on` + canary + `agendar`): the token mint and the
 *   bulk, ONCE.
 * - **A8** — the outcome, narrowed by CLASS (root `CLAUDE.md` rule 6):
 *   - Amazon's 2xx answer for OUR order (`lerRespostaAgendamentoAmazon`):
 *     `agendado` / `ja-agendado` resolve both motivos; `transitorio` (a code of
 *     the closed retryable set) THROWS for the queue's retry, and on the LAST
 *     attempt the code decides (step-15 plan §3 decision 10): the outage
 *     (`InternalServerError`) is a WARNING, a SLOT code raises
 *     `agendamento-recusado`; `recusado` raises `dimensoes-ausentes` for
 *     `MissingPackageDimensions`, else `agendamento-recusado`; `sem-pedido` is
 *     a WARNING (the outcome is uncertain, the print recovers).
 *   - a failure is split by the run's PHASE first, because the engine lets a
 *     `getOrder` failure and a write failure out through the same throw:
 *     - `fase: 'leitura'` (nothing was sent) — the shared read ladder
 *       (`pedidos/falhaLeituraAmazon.ts`): a transient throws (the last attempt:
 *       a WARNING), a 429 pauses, the conta tokens are A4's WARNING, anything
 *       definite (`nao-encontrado`, `http-definitivo`, `esquema`, `ilegivel`,
 *       `auth-*`) is ONE ERROR line `leitura-falhou`, no aviso, no retry.
 *       NEVER a scheduling refusal.
 *     - `fase: 'escrita'` — only the BULK's own HTTP answer
 *       (`ehFalhaHttpDoBulkEasyShip`) can be Amazon refusing THIS order:
 *       `ScheduledPackageAlreadyExists` reads as scheduled; a retryable code
 *       reads as `transitorio`; a 429 pauses; a second 401/403 (the refresh
 *       spent) is ONE ERROR line `sem-permissao` (an app-wide grant, never a
 *       per-pedido aviso); a 5xx throws; any other 4xx raises
 *       `dimensoes-ausentes` when its codes name `MissingPackageDimensions`,
 *       else `agendamento-recusado`. The bulk's 2xx off its schema
 *       (`ehRespostaForaDoEsquemaDoBulkEasyShip`) may have scheduled: it throws
 *       for a retry that re-reads first. Every OTHER write-phase failure — the
 *       token mint's, an LWA exchange's, a credential the getter refused — reads
 *       through the shared ladder: a transient throws, a 429 pauses, an SP-API
 *       auth refusal is `sem-permissao`, an LWA one or a conta token is A4's
 *       WARNING, anything else is ONE ERROR line `escrita-falhou` — never a
 *       scheduling refusal.
 *   - A Firestore error at A3 or A4 throws for the queue's retry; on the last
 *     attempt a TRANSIENT one is a WARNING and a return.
 * - **A9** — the closed result, logged ONCE by the queue.
 *
 * ## The re-enqueues (the `espera` and `pausa` rungs)
 *
 * Both go through the producer's UNNAMED `enfileirar` (a name would refuse the
 * next rung for an hour), at most one per dispatch. A transient failure of the
 * re-enqueue itself THROWS for the queue's retry before the last attempt
 * (nothing was sent in this dispatch: a rung follows a write-free plan or a 429
 * that processed nothing, and the retry re-reads); on the last attempt, and for
 * the deterministic classes (the tasks valve, a missing or malformed region, a
 * raw SDK failure), ONE WARNING `agendamento-nao-reenfileirado` naming the class
 * and the rung — the chain ends there and the checkout print recovers. An
 * unnamed failure propagates (rule 6). After a re-enqueue succeeds nothing else
 * runs in the dispatch, so a retry never forks a chain.
 *
 * ## Rule 7
 *
 * The ONLY writes are avisos through `avisos/avisos.ts`'s seam, each clocked by
 * A3's `readTime` (the shared seam drops an equal or older clock), raised or
 * resolved BEFORE any re-enqueue. NO pedido write: the schedule's mirror is the
 * order import's (step-15 plan §3 decision 6). The ordering guard between one
 * order's own dispatches is the queue's `maxConcurrentDispatches: 1`. An aviso
 * write that fails propagates: a retry re-reads `getOrder` first, and a
 * sequential resubmit of the bulk is the provider-idempotent case.
 *
 * ## What never reaches a line, an aviso or a payload
 *
 * The label's pre-signed URL (read by the answer's reader and dropped here), the
 * Restricted Data Token, a tracking, package or slot id, Amazon's text, a seller
 * id. The dispatch line carries ids (`pedidoId`, the order id), closed codes and
 * counts only — the SP-API CALL lines the observer writes are step 2b's own.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { nfev4Collection, pedidoCollection } from '@delfrance/data/admin/collections';
import { isGrpcStatusError, isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonThrottleError,
  CODIGO_DIMENSOES_AUSENTES_EASY_SHIP,
  CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP,
  type RespostaAgendamentoEasyShip,
} from '@delfrance/integrations-amazon-sp-api';
import {
  MOTIVO_ETIQUETA_AMAZON,
  MOTIVO_PEDIDO_AMAZON,
  type MotivoPedidoAmazon,
} from '@delfrance/schemas';

import {
  type AvisoDepsAmazon,
  type CommitDoDocumento,
  type SincroniaAvisosAmazon,
  sincronizarAvisosDoPedidoAmazon,
} from '../avisos/avisos';
import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
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
import { CODIGO_OUTRO, codigoDeErroSeguro, passaPredicadoAmazon } from '../core/redacao';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  type MotivoDryRunAmazon,
  decidirAlvo,
  lerValvula,
  registrarValvulaAmazon,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { pisoDoPedidoAmazon } from '../nfe/pedidoNfe';
import { sanitizarFalhaDaTarefaAmazon } from '../notificacoes/notificacao';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import { makePedidoIdAmazon } from '../pedidos/orderIds';
import {
  type AgendadorAgendamentoAmazon,
  AmazonAgendamentoRegiaoDaFilaInvalidaError,
  AmazonAgendamentoTarefasDesligadasError,
} from './agendadorAgendamento';
import {
  ACAO_AGENDAMENTO_AMAZON,
  type AcaoAgendamentoAmazon,
  CODIGOS_NOVO_HORARIO_EASY_SHIP,
  CODIGOS_RETENTAVEIS_EASY_SHIP,
  type GateNotasAgendamentoAmazon,
  MODO_AGENDAMENTO_AMAZON,
  type MotivoGateArmazenadoAgendamentoAmazon,
  type MotivoPlanoAgendamentoAmazon,
  type PlanoAgendamentoAmazon,
  TIPO_RESPOSTA_AGENDAMENTO_AMAZON,
  gateNotasAgendamentoAmazon,
  gatesArmazenadosAgendamentoAmazon,
  lerRespostaAgendamentoAmazon,
} from './decisaoAgendamento';
import { ehFalhaHttpDoBulkEasyShip, ehRespostaForaDoEsquemaDoBulkEasyShip } from './easyShipAmazon';
import {
  FASE_FALHA_AGENDAMENTO_AMAZON,
  type ResultadoAgendamentoAmazon,
  executarAgendamentoAmazon,
} from './executarAgendamento';
import {
  ESPERA_ACEITE_AGENDAMENTO_AMAZON_S,
  FILA_AGENDAMENTO_AMAZON,
  ORIGEM_AGENDAMENTO_AMAZON,
  type OrigemAgendamentoAmazon,
  PAUSAS_AGENDAMENTO_AMAZON_S,
  TENTATIVAS_AGENDAMENTO_AMAZON,
  type TarefaAgendamentoAmazon,
  esperaAgendamentoAmazon,
  pausaAgendamentoAmazon,
  tarefaAgendamentoAmazonSchema,
} from './tarefaAgendamento';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The queue dispatch this run is: its 0-based attempt and its task id. */
export interface RegistroAgendamentoAmazon {
  readonly tentativa: number;
  readonly idTarefa: string | null;
}

/** Everything one dispatch needs — bound by `functions/src/filaAgendamento.ts`, doubles in the tests. */
export interface DepsProcessarAgendamentoAmazon {
  /** The process environment: the read switch, the LWA pair, the scheduling valve and canary. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS (read once per dispatch for the avisos; per call by the clients). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /**
   * The scheduling queue's producer, for the handler's OWN re-enqueues (the
   * `espera` and `pausa` rungs, UNNAMED) — built only when one is due.
   */
  readonly agendamento: () => AgendadorAgendamentoAmazon;
  readonly registro: RegistroAgendamentoAmazon;
  /** Test seams, forwarded to the context and the write engine as-is. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one dispatch did (closed). */
export type AcaoTarefaAgendamentoAmazon =
  /** A0/A1: the payload is not this queue's — dropped, WARNING. */
  | 'payload-invalido'
  /** A log-only end: the valve, a stored or live refusal, a log-only failure. */
  | 'descartado'
  /** A dry-run (or `on` outside the canary) of a plan that would schedule: the diff line only. */
  | 'simulado'
  /** An aviso was raised. */
  | 'avisado'
  /** Amazon scheduled the order in THIS dispatch: the two scheduling motivos resolved. */
  | 'agendado'
  /** The order was already scheduled (the live read, or Amazon's answer): the two motivos resolved. */
  | 'ja-agendado'
  /** `aceite-pendente` from the acceptance: the next `espera` wait was enqueued. */
  | 'aguardando'
  /** A 429: the same dispatch re-enqueued after a pause. */
  | 'pausado';

export const ACAO_TAREFA_AGENDAMENTO_AMAZON = {
  payloadInvalido: 'payload-invalido',
  descartado: 'descartado',
  simulado: 'simulado',
  avisado: 'avisado',
  agendado: 'agendado',
  jaAgendado: 'ja-agendado',
  aguardando: 'aguardando',
  pausado: 'pausado',
} as const satisfies Record<string, AcaoTarefaAgendamentoAmazon>;

/** The task's OWN motivos — the ends the decision tables do not name (module header). */
export type MotivoProprioAgendamentoAmazon =
  /** A2: the scheduling valve is off. */
  | 'agendamento-desligado'
  /** A4 (or mid-run): the read switch is off. */
  | 'chamadas-desligadas'
  /** A4 (or mid-run): the conta or its credential cannot be used. */
  | 'conta-indisponivel'
  /** A definite read-side failure (nothing was sent). */
  | 'leitura-falhou'
  /** A definite write-side failure that is not the bulk's (the token mint, an LWA exchange). */
  | 'escrita-falhou'
  /** A second SP-API 401/403 after the forced refresh: an app-wide grant. */
  | 'sem-permissao'
  /** An outage on the queue's LAST attempt (5xx, a cut connection, a lagging read, the per-order outage code). */
  | 'amazon-indisponivel'
  /** A transient Firestore error at A3/A4 on the queue's LAST attempt. */
  | 'firestore-indisponivel'
  /** A 429 at the pause bound. */
  | 'taxa-limitada'
  /** Amazon's 2xx answer names neither our order's schedule nor its rejection. */
  | 'resposta-sem-pedido'
  /** The order-level acceptance never mirrored inside the `espera` ladder. */
  | 'aceite-nao-espelhado'
  /** An `espera`/`pausa` re-enqueue was lost (the last attempt, or a deterministic class). */
  | 'agendamento-nao-reenfileirado';

export const MOTIVO_PROPRIO_AGENDAMENTO_AMAZON = {
  agendamentoDesligado: 'agendamento-desligado',
  chamadasDesligadas: 'chamadas-desligadas',
  contaIndisponivel: 'conta-indisponivel',
  leituraFalhou: 'leitura-falhou',
  escritaFalhou: 'escrita-falhou',
  semPermissao: 'sem-permissao',
  amazonIndisponivel: 'amazon-indisponivel',
  firestoreIndisponivel: 'firestore-indisponivel',
  taxaLimitada: 'taxa-limitada',
  respostaSemPedido: 'resposta-sem-pedido',
  aceiteNaoEspelhado: 'aceite-nao-espelhado',
  agendamentoNaoReenfileirado: 'agendamento-nao-reenfileirado',
} as const satisfies Record<string, MotivoProprioAgendamentoAmazon>;

/** Every motivo a dispatch can end on: the task's own, the stored gates', the plan's, and the two the task raises. */
export type MotivoTarefaAgendamentoAmazon =
  | MotivoProprioAgendamentoAmazon
  | MotivoGateArmazenadoAgendamentoAmazon
  | MotivoPlanoAgendamentoAmazon
  | typeof MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes
  | typeof MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado;

/** Which re-enqueue rung a dispatch took (or lost). */
export type ReenfileiramentoAgendamentoAmazon = 'espera' | 'pausa';

export const REENFILEIRAMENTO_AGENDAMENTO_AMAZON = {
  espera: 'espera',
  pausa: 'pausa',
} as const satisfies Record<string, ReenfileiramentoAgendamentoAmazon>;

/**
 * The two per-pedido motivos ONLY this task raises, and resolves once the order
 * is scheduled. The order import resolves the same pair once scheduling has
 * ended (`pedidos/importarPedido.ts`'s `MOTIVOS_AGENDAMENTO_PEDIDO_AMAZON`, the
 * same set — the task's test pins the two equal).
 */
export const MOTIVOS_AVISO_AGENDAMENTO_AMAZON: readonly MotivoPedidoAmazon[] = [
  MOTIVO_PEDIDO_AMAZON.dimensoesAusentes,
  MOTIVO_PEDIDO_AMAZON.agendamentoRecusado,
];

/** The chain step a dispatch enqueued. */
export interface ProximaTarefaAgendamentoAmazon {
  readonly espera: number;
  readonly pausas: number;
  /** The delay handed to the queue, in seconds. */
  readonly atrasoS: number;
}

/** The dispatch's result, logged ONCE by the queue ({@link registrarDespachoAgendamentoAmazon}). */
export interface ResultadoTarefaAgendamentoAmazon {
  readonly acao: AcaoTarefaAgendamentoAmazon;
  /** The closed reason of the outcome, when one applies. */
  readonly motivo: MotivoTarefaAgendamentoAmazon | null;
  readonly origem: OrigemAgendamentoAmazon | null;
  readonly espera: number | null;
  readonly pausas: number | null;
  readonly pedidoId: string | null;
  /** The conta, once the payload parsed. */
  readonly contaId: string | null;
  /** Amazon's order id, once the payload parsed. */
  readonly pedido: string | null;
  /** The live order's decision (before the NF-e gate), once the order was read. */
  readonly decisao: AcaoAgendamentoAmazon | null;
  /** Why a dry-run did not write (the valve, the canary). */
  readonly dryRun: MotivoDryRunAmazon | null;
  /** The shared ladder's token of a failure (`pedidos/falhaLeituraAmazon.ts`). */
  readonly falha: FalhaLeituraAmazon | null;
  /** A failure's CLASS (and gRPC/SDK code) — never its message. */
  readonly erro: string | null;
  /** Our order's rejection code in Amazon's 2xx answer, through the rejection grammar. */
  readonly codigoRejeicao: string | null;
  /** An HTTP failure's codes, raw (the line keeps only the closed ones). */
  readonly codigos: readonly string[];
  /** How many `scheduledPackages` entries name our order. */
  readonly pacotes: number | null;
  /** Our order's first scheduled package's `packageStatus`, through the `enumCamel` grammar. */
  readonly statusPacote: string | null;
  /** What the dispatch's aviso write did, counted. */
  readonly avisos: SincroniaAvisosAmazon | null;
  /** The re-enqueue rung taken (with {@link ResultadoTarefaAgendamentoAmazon.proxima}) or lost. */
  readonly reenfileiramento: ReenfileiramentoAgendamentoAmazon | null;
  readonly proxima: ProximaTarefaAgendamentoAmazon | null;
}

/* -------------------------------------------------------------------------- */
/*                               the dispatch line                            */
/* -------------------------------------------------------------------------- */

/** Ends a person must read the log for (no aviso carries them). */
const MOTIVOS_EM_WARNING: ReadonlySet<string> = new Set<string>([
  MOTIVO_ETIQUETA_AMAZON.naoAmazon,
  MOTIVO_ETIQUETA_AMAZON.outraIntegradora,
  MOTIVO_ETIQUETA_AMAZON.nfeAmbigua,
  MOTIVO_ETIQUETA_AMAZON.nfeSubstituta,
  MOTIVO_ETIQUETA_AMAZON.nfeCancelada,
  MOTIVO_ETIQUETA_AMAZON.nfNaoRequerida,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.chamadasDesligadas,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.contaIndisponivel,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.amazonIndisponivel,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.firestoreIndisponivel,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.taxaLimitada,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.respostaSemPedido,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.aceiteNaoEspelhado,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.agendamentoNaoReenfileirado,
]);

/** Ends that are a defect of the app or of a request, never of this order. */
const MOTIVOS_EM_ERROR: ReadonlySet<string> = new Set<string>([
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.leituraFalhou,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.escritaFalhou,
  MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.semPermissao,
]);

/** The dispatch line's severity: ERROR for a definite failure, WARNING whenever a person has to look. */
export function severidadeDoDespachoAgendamentoAmazon(
  r: ResultadoTarefaAgendamentoAmazon,
): SeveridadeAmazon {
  if (r.motivo !== null && MOTIVOS_EM_ERROR.has(r.motivo)) return 'ERROR';
  if (
    r.acao === ACAO_TAREFA_AGENDAMENTO_AMAZON.payloadInvalido ||
    r.acao === ACAO_TAREFA_AGENDAMENTO_AMAZON.avisado
  ) {
    return 'WARNING';
  }
  return r.motivo !== null && MOTIVOS_EM_WARNING.has(r.motivo) ? 'WARNING' : 'INFO';
}

/**
 * The ONE `evento: 'agendamento'` dispatch line (module header): ids, closed
 * codes and counts only.
 */
export function registrarDespachoAgendamentoAmazon(
  logger: LoggerAmazon,
  r: ResultadoTarefaAgendamentoAmazon,
  registro: RegistroAgendamentoAmazon,
): void {
  const campos: CamposLogAmazon = {
    fila: FILA_AGENDAMENTO_AMAZON,
    acao: r.acao,
    motivo: r.motivo,
    origem: r.origem,
    espera: r.espera,
    pausas: r.pausas,
    pedidoId: r.pedidoId,
    pedido: r.pedido,
    decisao: r.decisao,
    dryRun: r.dryRun,
    falha: r.falha,
    erro: r.erro,
    codigoRejeicao: r.codigoRejeicao,
    codigos: r.codigos.length === 0 ? null : r.codigos.map(codigoDeErroSeguro).join(','),
    pacotes: r.pacotes,
    statusPacote: r.statusPacote,
    avisosLevantados: r.avisos?.levantados ?? null,
    avisosResolvidos: r.avisos?.resolvidos ?? null,
    reenfileiramento: r.reenfileiramento,
    proximaEspera: r.proxima?.espera ?? null,
    proximasPausas: r.proxima?.pausas ?? null,
    atrasoS: r.proxima?.atrasoS ?? null,
  };
  registrarEventoAmazon(
    logger,
    'agendamento',
    severidadeDoDespachoAgendamentoAmazon(r),
    `[amazon] tarefa da fila de agendamento da coleta: ${r.acao}`,
    campos,
    {
      conta: r.contaId,
      fluxo: FLUXO_AMAZON.agendamento,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/* -------------------------------------------------------------------------- */
/*                           one dispatch's own state                         */
/* -------------------------------------------------------------------------- */

/** A dispatch in flight: its payload, its clock, and A3's aviso clock. */
interface Execucao {
  readonly db: Firestore;
  readonly deps: DepsProcessarAgendamentoAmazon;
  readonly t: TarefaAgendamentoAmazon;
  readonly agoraMs: number;
  /** A3's `readTime`: the clock of every aviso of the dispatch. */
  relogio: CommitDoDocumento | null;
  /** The live decision, once read. */
  decisao: AcaoAgendamentoAmazon | null;
}

/** A result for `e`, every field not given left null. */
function resultado(
  e: Execucao,
  r: Partial<Omit<ResultadoTarefaAgendamentoAmazon, 'acao'>> & {
    readonly acao: AcaoTarefaAgendamentoAmazon;
  },
): ResultadoTarefaAgendamentoAmazon {
  return {
    motivo: null,
    origem: e.t.origem,
    espera: e.t.espera,
    pausas: e.t.pausas,
    pedidoId: e.t.pedidoId,
    contaId: e.t.contaId,
    pedido: e.t.orderId,
    decisao: e.decisao,
    dryRun: null,
    falha: null,
    erro: null,
    codigoRejeicao: null,
    codigos: [],
    pacotes: null,
    statusPacote: null,
    avisos: null,
    reenfileiramento: null,
    proxima: null,
    ...r,
  };
}

/** A log-only end. */
function descartar(
  e: Execucao,
  motivo: MotivoTarefaAgendamentoAmazon,
  extra: Partial<ResultadoTarefaAgendamentoAmazon> = {},
): ResultadoTarefaAgendamentoAmazon {
  return resultado(e, { ...extra, acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.descartado, motivo });
}

/** Whether this dispatch is the queue's last attempt. */
function ultimaTentativa(e: Execucao): boolean {
  return e.deps.registro.tentativa + 1 >= TENTATIVAS_AGENDAMENTO_AMAZON;
}

function depsDoAviso(e: Execucao): AvisoDepsAmazon {
  return { increment: e.deps.increment, nowMs: e.agoraMs, logger: e.deps.logger };
}

function exigirRelogio(e: Execucao): CommitDoDocumento {
  if (e.relogio === null) {
    throw new TypeError('processarAgendamento.ts: aviso antes da leitura do pedido (A3)');
  }
  return e.relogio;
}

/* -------------------------------------------------------------------------- */
/*                                  the avisos                                */
/* -------------------------------------------------------------------------- */

/** Raise and resolve per-pedido motivos, clocked by A3's `readTime` (rule 7). */
function sincronizar(
  e: Execucao,
  levantar: readonly MotivoPedidoAmazon[],
  resolver: readonly MotivoPedidoAmazon[],
): Promise<SincroniaAvisosAmazon> {
  return sincronizarAvisosDoPedidoAmazon(e.db, depsDoAviso(e), {
    integracaoId: e.t.contaId,
    orderId: e.t.orderId,
    pedidoId: e.t.pedidoId,
    levantar,
    resolver,
    relogio: exigirRelogio(e),
  });
}

/** The order IS scheduled: resolve the two scheduling motivos (only rows that exist). */
async function agendado(
  e: Execucao,
  acao:
    | typeof ACAO_TAREFA_AGENDAMENTO_AMAZON.agendado
    | typeof ACAO_TAREFA_AGENDAMENTO_AMAZON.jaAgendado,
  extra: Partial<ResultadoTarefaAgendamentoAmazon> = {},
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const avisos = await sincronizar(e, [], MOTIVOS_AVISO_AGENDAMENTO_AMAZON);
  return resultado(e, { ...extra, acao, avisos });
}

/** Amazon refused THIS order: raise `dimensoes-ausentes` or `agendamento-recusado`. */
async function recusado(
  e: Execucao,
  dimensoes: boolean,
  extra: Partial<ResultadoTarefaAgendamentoAmazon> = {},
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const motivo = dimensoes
    ? MOTIVO_ETIQUETA_AMAZON.dimensoesAusentes
    : MOTIVO_ETIQUETA_AMAZON.agendamentoRecusado;
  const avisos = await sincronizar(
    e,
    [dimensoes ? MOTIVO_PEDIDO_AMAZON.dimensoesAusentes : MOTIVO_PEDIDO_AMAZON.agendamentoRecusado],
    [],
  );
  return resultado(e, { ...extra, acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.avisado, motivo, avisos });
}

/* -------------------------------------------------------------------------- */
/*                                the re-enqueues                             */
/* -------------------------------------------------------------------------- */

/**
 * A lost re-enqueue's CLASS (and SDK code) when this dispatch answers it with
 * the WARNING (module header), or `null` for an unnamed failure, which
 * propagates. A class and a code only — never a message.
 */
function classeDaPerda(err: unknown): string | null {
  if (err instanceof AmazonTarefasTransitoriasError) return err.name;
  if (err instanceof AmazonAgendamentoTarefasDesligadasError) return err.name;
  if (err instanceof MissingRegionError) return err.name;
  if (err instanceof AmazonAgendamentoRegiaoDaFilaInvalidaError) return err.name;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  return null;
}

/**
 * ONE unnamed re-enqueue (the `espera` or `pausa` rung) and its failure policy
 * (module header): enqueued ⇒ `acao`; a transient before the last attempt ⇒
 * THROWN for the queue's retry; the last attempt or a deterministic class ⇒ the
 * WARNING `agendamento-nao-reenfileirado`.
 */
async function reenfileirar(
  e: Execucao,
  rung: ReenfileiramentoAgendamentoAmazon,
  tarefa: TarefaAgendamentoAmazon,
  atrasoS: number,
  acao:
    | typeof ACAO_TAREFA_AGENDAMENTO_AMAZON.aguardando
    | typeof ACAO_TAREFA_AGENDAMENTO_AMAZON.pausado,
  extra: Partial<ResultadoTarefaAgendamentoAmazon>,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  try {
    await e.deps.agendamento().enfileirar(tarefa, atrasoS);
  } catch (err) {
    const classe = classeDaPerda(err);
    if (classe === null) throw err;
    if (err instanceof AmazonTarefasTransitoriasError && !ultimaTentativa(e)) throw err;
    // The rung's own motivo (an `espera`'s `nfe-em-processamento`) gives way:
    // the chain ENDS here, and that is what the line must say.
    return resultado(e, {
      ...extra,
      acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.descartado,
      motivo: MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.agendamentoNaoReenfileirado,
      erro: classe,
      reenfileiramento: rung,
    });
  }
  // The rung is durable: nothing else runs in this dispatch.
  return resultado(e, {
    ...extra,
    acao,
    reenfileiramento: rung,
    proxima: { espera: tarefa.espera, pausas: tarefa.pausas, atrasoS },
  });
}

/** A 429 (not processed): the next pause, or at the bound the WARNING `taxa-limitada`. */
function pausar(
  e: Execucao,
  extra: Partial<ResultadoTarefaAgendamentoAmazon>,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const proxima = pausaAgendamentoAmazon(e.t);
  if (proxima === null) {
    return Promise.resolve(descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.taxaLimitada, extra));
  }
  return reenfileirar(
    e,
    REENFILEIRAMENTO_AGENDAMENTO_AMAZON.pausa,
    proxima,
    PAUSAS_AGENDAMENTO_AMAZON_S[e.t.pausas] ?? 0,
    ACAO_TAREFA_AGENDAMENTO_AMAZON.pausado,
    extra,
  );
}

/* -------------------------------------------------------------------------- */
/*                            the outcome (A6, A8)                            */
/* -------------------------------------------------------------------------- */

/**
 * An outage (a transient, or the per-order outage code): THROWN for the queue's
 * retry, which re-reads `getOrder` first; on the LAST attempt the WARNING
 * `amazon-indisponivel`, and the checkout print recovers.
 */
function indisponivel(
  e: Execucao,
  lancar: () => unknown,
  extra: Partial<ResultadoTarefaAgendamentoAmazon>,
): ResultadoTarefaAgendamentoAmazon {
  if (!ultimaTentativa(e)) throw lancar();
  return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.amazonIndisponivel, extra);
}

/**
 * Amazon answered a code of the closed retryable set for OUR order (per order in
 * a 2xx, or top-level): THROWN for the retry; on the LAST attempt a SLOT code
 * raises `agendamento-recusado` (Amazon answered for this order on every
 * attempt: not an outage), the outage code is the WARNING (step-15 plan §3
 * decision 10).
 */
async function retentavel(
  e: Execucao,
  codigos: readonly string[],
  extra: Partial<ResultadoTarefaAgendamentoAmazon>,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const retentaveis = codigos.filter((c) => CODIGOS_RETENTAVEIS_EASY_SHIP.has(c));
  if (!ultimaTentativa(e)) throw new AmazonAgendamentoTransitorioError(retentaveis);
  if (retentaveis.some((c) => CODIGOS_NOVO_HORARIO_EASY_SHIP.has(c))) {
    return recusado(e, false, extra);
  }
  return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.amazonIndisponivel, extra);
}

/**
 * Amazon answered a code of the closed retryable set for this order: the queue
 * must try again. Its message names only those codes (a closed set) — never
 * Amazon's text.
 */
export class AmazonAgendamentoTransitorioError extends Error {
  readonly codigos: readonly string[];

  constructor(codigos: readonly string[]) {
    super(
      `[amazon/agendamento] a Amazon pediu nova tentativa do agendamento (${codigos
        .map(codigoDeErroSeguro)
        .join(',')})`,
    );
    this.name = 'AmazonAgendamentoTransitorioError';
    this.codigos = codigos;
  }
}

/** A6: a plan that writes nothing (module header). */
async function semEscrita(
  e: Execucao,
  plano: PlanoAgendamentoAmazon,
  dryRun: MotivoDryRunAmazon | null,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const extra: Partial<ResultadoTarefaAgendamentoAmazon> = { dryRun };
  switch (plano.acao) {
    case ACAO_AGENDAMENTO_AMAZON.jaAgendado:
      return agendado(e, ACAO_TAREFA_AGENDAMENTO_AMAZON.jaAgendado, extra);
    case ACAO_AGENDAMENTO_AMAZON.aceitePendente: {
      // Only the acceptance's chain waits for the order-level mirror: an import
      // was triggered by a read that already showed the acceptance.
      if (e.t.origem !== ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe) {
        return descartar(e, plano.motivo ?? MOTIVO_ETIQUETA_AMAZON.nfeEmProcessamento, extra);
      }
      const proxima = esperaAgendamentoAmazon(e.t);
      if (proxima === null) {
        return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.aceiteNaoEspelhado, extra);
      }
      return reenfileirar(
        e,
        REENFILEIRAMENTO_AGENDAMENTO_AMAZON.espera,
        proxima,
        ESPERA_ACEITE_AGENDAMENTO_AMAZON_S[e.t.espera] ?? 0,
        ACAO_TAREFA_AGENDAMENTO_AMAZON.aguardando,
        { ...extra, motivo: plano.motivo },
      );
    }
    case ACAO_AGENDAMENTO_AMAZON.recusar: {
      if (plano.motivo === MOTIVO_ETIQUETA_AMAZON.cancelamentoSolicitado) {
        // The EXISTING per-pedido row the importer and the NF-e task raise.
        const avisos = await sincronizar(e, [MOTIVO_PEDIDO_AMAZON.aceitarCancelamento], []);
        return resultado(e, {
          acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.avisado,
          motivo: plano.motivo,
          avisos,
          ...extra,
        });
      }
      return descartar(e, plano.motivo ?? MOTIVO_ETIQUETA_AMAZON.statusPedidoInesperado, extra);
    }
    case ACAO_AGENDAMENTO_AMAZON.agendar:
      // In `tarefa` mode an `agendar` plan always writes: reaching here is a
      // contract bug of the run (a dry-run of one is answered by the caller).
      throw new TypeError('processarAgendamento.ts: um plano de agendar que não escreve');
  }
}

/** A8: Amazon's 2xx answer for OUR order (module header). */
async function respostaDoBulk(
  e: Execucao,
  dados: RespostaAgendamentoEasyShip,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  const lida = lerRespostaAgendamentoAmazon(dados, e.t.orderId);
  // `lida.url` is the pre-signed label link: read, and dropped HERE — the task
  // prints nothing, and the link never reaches a line, an aviso or a payload.
  const extra: Partial<ResultadoTarefaAgendamentoAmazon> = {
    codigoRejeicao: lida.codigo,
    pacotes: lida.pacotes,
    statusPacote: statusDoPacote(dados, e.t.orderId),
  };
  switch (lida.tipo) {
    case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.agendado:
      return agendado(e, ACAO_TAREFA_AGENDAMENTO_AMAZON.agendado, extra);
    case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.jaAgendado:
      return agendado(e, ACAO_TAREFA_AGENDAMENTO_AMAZON.jaAgendado, extra);
    case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.transitorio:
      return retentavel(e, lida.codigo === null ? [] : [lida.codigo], extra);
    case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.recusado:
      return recusado(e, lida.codigo === CODIGO_DIMENSOES_AUSENTES_EASY_SHIP, extra);
    case TIPO_RESPOSTA_AGENDAMENTO_AMAZON.semPedido:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.respostaSemPedido, extra);
  }
}

/** Our order's first scheduled package's `packageStatus`, through the `enumCamel` grammar, else `null`. */
function statusDoPacote(dados: RespostaAgendamentoEasyShip, orderId: string): string | null {
  if (dados === null) return null;
  const pacote = (dados.scheduledPackages ?? []).find(
    (p) => p.scheduledPackageId?.amazonOrderId === orderId,
  );
  const status = pacote?.packageStatus;
  if (status === undefined || status === null) return null;
  return passaPredicadoAmazon('enumCamel', status) ? status : CODIGO_OUTRO;
}

/** A failure's CLASS — its `name`, a Firestore one with its gRPC code; never a message. */
function classeDoErro(err: unknown): string {
  if (isGrpcStatusError(err)) return `Firestore/${String(err.code)}`;
  const nome = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : null;
  return typeof nome === 'string' ? nome : 'desconhecido';
}

/**
 * A read-side failure (A4, or the run's `fase: 'leitura'`): nothing was sent
 * (module header). `null` when the queue must retry it (a transient before the
 * last attempt, a class the ladder does not name): the caller rethrows it
 * sanitized.
 */
async function falhaDeLeitura(
  e: Execucao,
  err: unknown,
): Promise<ResultadoTarefaAgendamentoAmazon | null> {
  const falha = classificarFalhaDeLeituraAmazon(err);
  const extra: Partial<ResultadoTarefaAgendamentoAmazon> = {
    falha,
    erro: classeDoErro(err),
    codigos: codigosDe(err),
  };
  switch (falha) {
    case FALHA_LEITURA_AMAZON.pausa:
      return pausar(e, extra);
    case FALHA_LEITURA_AMAZON.transitorio:
      return ultimaTentativa(e)
        ? descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.amazonIndisponivel, extra)
        : null;
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.chamadasDesligadas, extra);
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.contaIndisponivel, extra);
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
    case FALHA_LEITURA_AMAZON.authLwa:
    case FALHA_LEITURA_AMAZON.authSpApi:
      // Nothing was sent, and the print path re-reads: never a scheduling refusal.
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.leituraFalhou, extra);
    case FALHA_LEITURA_AMAZON.relancar:
      return null;
  }
}

/** An HTTP failure's codes, or none. */
function codigosDe(err: unknown): readonly string[] {
  return err instanceof AmazonHttpError ? err.codigosErro : [];
}

/**
 * A write-side failure (the run's `fase: 'escrita'`, module header). `null` when
 * the queue must retry it with the failure itself (a transient before the last
 * attempt, a class the ladder does not name): the caller rethrows it sanitized.
 */
async function falhaDeEscrita(
  e: Execucao,
  err: unknown,
): Promise<ResultadoTarefaAgendamentoAmazon | null> {
  const extra: Partial<ResultadoTarefaAgendamentoAmazon> = {
    erro: classeDoErro(err),
    codigos: codigosDe(err),
  };
  // Only the BULK's own HTTP answer speaks for the order.
  if (ehFalhaHttpDoBulkEasyShip(err)) {
    if (err instanceof AmazonThrottleError) return pausar(e, extra);
    // A second 401/403 after the forced refresh: a grant this app does not
    // hold, app-wide — never a per-pedido aviso whose copy names the wrong remedy.
    if (err instanceof AmazonAuthError) {
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.semPermissao, extra);
    }
    if (err.codigosErro.includes(CODIGO_PACOTE_JA_AGENDADO_EASY_SHIP)) {
      return agendado(e, ACAO_TAREFA_AGENDAMENTO_AMAZON.jaAgendado, extra);
    }
    if (err.codigosErro.some((c) => CODIGOS_RETENTAVEIS_EASY_SHIP.has(c))) {
      return retentavel(e, err.codigosErro, extra);
    }
    // A 5xx MAY HAVE LANDED: the retry re-reads getOrder first.
    if (err.transitorio) return indisponivel(e, () => sanitizarFalhaDaTarefaAmazon(err), extra);
    if (err.status >= 400 && err.status < 500) {
      return recusado(e, err.codigosErro.includes(CODIGO_DIMENSOES_AUSENTES_EASY_SHIP), extra);
    }
    // A 3xx: the redirect is never followed, so the bulk was not processed.
    return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.escritaFalhou, {
      ...extra,
      falha: FALHA_LEITURA_AMAZON.httpDefinitivo,
    });
  }
  // The bulk's 2xx off its schema: Amazon answered the bulk, so it MAY HAVE
  // scheduled — the retry re-reads getOrder first.
  if (ehRespostaForaDoEsquemaDoBulkEasyShip(err)) {
    return indisponivel(e, () => sanitizarFalhaDaTarefaAmazon(err), {
      ...extra,
      falha: FALHA_LEITURA_AMAZON.esquema,
    });
  }
  // Not the bulk's: the token mint's, an LWA exchange's, a credential getter's.
  const falha = classificarFalhaDeLeituraAmazon(err);
  const comFalha = { ...extra, falha };
  switch (falha) {
    case FALHA_LEITURA_AMAZON.pausa:
      return pausar(e, comFalha);
    case FALHA_LEITURA_AMAZON.transitorio:
      return ultimaTentativa(e)
        ? descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.amazonIndisponivel, comFalha)
        : null;
    case FALHA_LEITURA_AMAZON.authSpApi:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.semPermissao, comFalha);
    case FALHA_LEITURA_AMAZON.authLwa:
    case FALHA_LEITURA_AMAZON.contaInativa:
    case FALHA_LEITURA_AMAZON.contaIndisponivel:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.contaIndisponivel, comFalha);
    case FALHA_LEITURA_AMAZON.chamadasDesligadas:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.chamadasDesligadas, comFalha);
    case FALHA_LEITURA_AMAZON.naoEncontrado:
    case FALHA_LEITURA_AMAZON.httpDefinitivo:
    case FALHA_LEITURA_AMAZON.esquema:
    case FALHA_LEITURA_AMAZON.ilegivel:
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.escritaFalhou, comFalha);
    case FALHA_LEITURA_AMAZON.relancar:
      // An AmazonConfigError (nothing was sent: a bug).
      return null;
  }
}

/**
 * A Firestore failure at A3 or A4 (outside the run): THROWN for the queue's
 * retry; on the LAST attempt a TRANSIENT one is the WARNING
 * `firestore-indisponivel`. Anything else rethrows.
 */
function falhaDoFirestore(e: Execucao, err: unknown): ResultadoTarefaAgendamentoAmazon {
  if (isTransientGrpcError(err) && ultimaTentativa(e)) {
    return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.firestoreIndisponivel, {
      erro: classeDoErro(err),
    });
  }
  throw sanitizarFalhaDaTarefaAmazon(err);
}

/* -------------------------------------------------------------------------- */
/*                                the dispatch                                */
/* -------------------------------------------------------------------------- */

/** A0/A1's drop: the payload is not this queue's. */
function payloadInvalido(t: TarefaAgendamentoAmazon | null): ResultadoTarefaAgendamentoAmazon {
  return {
    acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.payloadInvalido,
    motivo: null,
    origem: t?.origem ?? null,
    espera: t?.espera ?? null,
    pausas: t?.pausas ?? null,
    pedidoId: t?.pedidoId ?? null,
    contaId: t?.contaId ?? null,
    pedido: t?.orderId ?? null,
    decisao: null,
    dryRun: null,
    falha: null,
    erro: null,
    codigoRejeicao: null,
    codigos: [],
    pacotes: null,
    statusPacote: null,
    avisos: null,
    reenfileiramento: null,
    proxima: null,
  };
}

/**
 * ONE dispatch, A0–A9 (module header). Returns the result the queue logs;
 * throws only what the queue must retry (a transient, a Firestore error, a bug),
 * sanitized.
 */
export async function processarAgendamentoAmazon(
  db: Firestore,
  dados: unknown,
  deps: DepsProcessarAgendamentoAmazon,
): Promise<ResultadoTarefaAgendamentoAmazon> {
  // ---- A0: the payload. ----
  const lido = tarefaAgendamentoAmazonSchema.safeParse(dados);
  if (!lido.success) return payloadInvalido(null);
  const t = lido.data;

  // ---- A1: the pure proof — before any read. ----
  if (makePedidoIdAmazon(t.contaId, t.orderId) !== t.pedidoId) return payloadInvalido(t);

  const e: Execucao = { db, deps, t, agoraMs: deps.agora(), relogio: null, decisao: null };
  const registro = {
    fluxo: FLUXO_AMAZON.agendamento,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  };

  // ---- A2: the valve, read ONCE, logged, then the target — before any read. ----
  const valvula = lerValvula(FLUXO_AMAZON.agendamento, deps.ambiente);
  registrarValvulaAmazon(deps.logger, valvula, {
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
  });
  if (decidirAlvo(valvula, t.contaId, t.orderId).modo === MODO_AMAZON.off) {
    return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.agendamentoDesligado);
  }

  // ---- A3: the stored pedido, then its NF-e documents. ----
  let raw: Record<string, unknown> | null;
  let notas: GateNotasAgendamentoAmazon;
  try {
    const pedidoSnap = await pedidoCollection.docRef(db, {}, t.pedidoId).get();
    raw = pedidoSnap.exists ? ((pedidoSnap.data() ?? {}) as Record<string, unknown>) : null;
    const gate = gatesArmazenadosAgendamentoAmazon(t.pedidoId, raw);
    if (!gate.segue) return descartar(e, gate.motivo);
    e.relogio = pedidoSnap.readTime;
    const lista = await nfev4Collection.ref(db, { pedidoId: t.pedidoId }).get();
    notas = gateNotasAgendamentoAmazon(
      lista.docs.map((d) => ({ raw: (d.data() ?? {}) as Record<string, unknown> })),
    );
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    return falhaDoFirestore(e, err);
  }

  // ---- A4: the context — the read switch first. ----
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, t.contaId, depsDoContexto);
  } catch (err) {
    if (isGrpcStatusError(err)) return falhaDoFirestore(e, err);
    const r = await falhaDeLeitura(e, err);
    if (r === null) throw sanitizarFalhaDaTarefaAmazon(err);
    return r;
  }

  // ---- A5–A7: the run — the live order, the plan, at most ONE mint + bulk. ----
  const execucao: ResultadoAgendamentoAmazon = await executarAgendamentoAmazon({
    valvula,
    alvo: { contaId: t.contaId, orderId: t.orderId, pisoUs: pisoDoPedidoAmazon(raw) },
    contexto,
    deps: depsDoContexto,
    registro,
    modo: MODO_AGENDAMENTO_AMAZON.tarefa,
    podeAgendar: true,
    notas,
  });

  // ---- A6 / A8: the outcome. ----
  switch (execucao.tipo) {
    case 'desligado':
      // A2 already answered `off` on the same snapshot; kept total.
      return descartar(e, MOTIVO_PROPRIO_AGENDAMENTO_AMAZON.agendamentoDesligado);
    case 'simulado':
      e.decisao = execucao.decisao.acao;
      // A plan that WOULD schedule: the engine's diff line is the whole effect.
      if (execucao.plano.escrever) {
        return resultado(e, {
          acao: ACAO_TAREFA_AGENDAMENTO_AMAZON.simulado,
          dryRun: execucao.motivo,
        });
      }
      return semEscrita(e, execucao.plano, execucao.motivo);
    case 'sem-escrita':
      e.decisao = execucao.decisao.acao;
      return semEscrita(e, execucao.plano, null);
    case 'escrito':
      e.decisao = execucao.decisao.acao;
      return respostaDoBulk(e, execucao.resposta);
    case 'falha': {
      if (execucao.fase === FASE_FALHA_AGENDAMENTO_AMAZON.escrita) {
        e.decisao = execucao.decisao.acao;
        const r = await falhaDeEscrita(e, execucao.erro);
        if (r === null) throw sanitizarFalhaDaTarefaAmazon(execucao.erro);
        return r;
      }
      const r = await falhaDeLeitura(e, execucao.erro);
      if (r === null) throw sanitizarFalhaDaTarefaAmazon(execucao.erro);
      return r;
    }
  }
}
