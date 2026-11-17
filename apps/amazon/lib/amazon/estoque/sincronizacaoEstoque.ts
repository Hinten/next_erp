/**
 * The five-minute stock TICK (step 12, PR 12-e2): per active Amazon conta, the
 * estoque rows that MOVED at the conta's depósito since a durable cursor, turned
 * into the conta's SKUs, and those SKUs handed to the stock queue as one named
 * patch task per observation. Nothing here reaches Amazon: the tick binds no
 * secret and makes no call; the patch task computes every quantity when it runs.
 *
 * The functions root (`functions/src/sweepEstoque.ts`) binds the dependencies
 * ({@link DepsTickEstoqueAmazon}) ONCE per tick: nothing under `lib/amazon`
 * reads the process environment (`estrutura.test.ts`).
 *
 * ## One tick ({@link executarTickEstoqueAmazon}), T1–T9
 *
 * - **T1** — the read switch not exactly `on`, or the stock valve `off` ⇒ ONE
 *   INFO line and ZERO Firestore operations, so no sync document can exist
 *   before the window.
 * - **T2** — the Amazon contas, listed UNCACHED; inactive ones skipped in code.
 *   The contas run one after another, the order ROTATED by the tick's
 *   five-minute slot ({@link ordemDoTickEstoqueAmazon}), each with min(the
 *   conta's {@link ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS}, what the tick's
 *   {@link ORCAMENTO_TICK_ESTOQUE_AMAZON_MS} has left); one the tick can no
 *   longer give {@link ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS} is `sem-tempo`
 *   (nothing read). Its DEADLINE is that budget minus
 *   {@link FOLGA_CONTA_ESTOQUE_AMAZON_MS}, kept for the final write: it is
 *   checked before every window page, every produto read, every batch of link
 *   listings (`descobertaFirestore.ts`) and before STARTING every enqueue.
 * - **T3** — the conta document, read RAW and uncached: gone, not an Amazon
 *   conta, or inactive ⇒ nothing written. Its depósito comes from the ONE parse
 *   of a conta's depósito ref, kept only inside the id grammar the stock
 *   documents store (`depositoIdGravavelDaContaEstoqueAmazon`, either stored
 *   form, `familiaEstoque.ts`); a ref naming no depósito, or a depósito id
 *   outside that grammar, counts as NO depósito.
 * - **T4** — the conta's sync document (`sincronizacaoEstoqueAmazon/{contaId}`)
 *   and its LEASE: `create` when absent, else — only once the stored lease
 *   EXPIRED — `update({ vez }, { lastUpdateTime })`. Every lease a tick takes
 *   runs to {@link LEASE_TICK_ESTOQUE_AMAZON_MS} after the TICK's start, never
 *   the conta's, so whichever conta it was taken for, it outlives the run and
 *   is free by the next tick. ALREADY_EXISTS or FAILED_PRECONDITION ⇒ another
 *   tick holds it: next conta, nothing more written. Then, in order:
 *   - no depósito ⇒ straight to T8 with `semDeposito: true`;
 *   - no stored cursor (the conta's first tick) ⇒ T8 stores the cursor at now
 *     and the depósito it was taken at, and reads no window;
 *   - a depósito that is not the stored `depositoDoCursor` (both compared as
 *     ids, through the same parse) ⇒ NO window is read: the new depósito's
 *     earlier stamps sit below a cursor taken at the old one, so only a
 *     reconcile can see them. ONE WARNING `deposito-do-cursor-mudou`, the
 *     cursor and `depositoDoCursor` KEPT (the hand-off below).
 * - **T5** — `janelaDoTick` over the stored cursor. A `RangeError` from it (a
 *   cursor too far ahead of the clock to be a ms instant) ends THIS conta with
 *   its line naming the class, the cursor untouched; the other contas go on. A
 *   `null` window (a cursor ahead of this clock by more than the overlap) reads
 *   nothing. Otherwise `descobrirJanelaEstoqueAmazon`: the window, paged, at
 *   most ten pages over both ref forms. Truncated (the page cap or the 24-hour
 *   clamp) ⇒ T6 is skipped and the window goes to a reconcile. The deadline
 *   reached before or between WINDOW pages says only that the reads were slow,
 *   not how much moved: `orcamento-esgotado`, the cursor kept (the next tick
 *   re-reads the window).
 * - **T6** — inside the same call: produtos → deduplicated probes → partition
 *   listings → the conta's SKUs with their observations. The deadline reached
 *   here ⇒ the window goes to a reconcile (a window too slow to map is a mass
 *   movement).
 * - **T7** — `destinoDoLoteDelta` over the window's n distinct SKUs: none ⇒
 *   nothing to send; 1–30 ⇒ one NAMED patch task per observation (`origem:
 *   'delta'`, the reference the observation's commit `updateTime`), at most 16
 *   in flight; the deadline reached before every one started ⇒
 *   `orcamento-esgotado`, the cursor kept (the next tick re-reads the window,
 *   and the names dedupe what was already enqueued); 31–3,000 ⇒ the delta feed;
 *   more ⇒ a reconcile. A SKU the task payload cannot carry (more than 40 code
 *   points, which no write path can send) is counted and dropped; a contained
 *   enqueue failure (the stock queue's valve, a named transient, a region, a
 *   raw Cloud Tasks failure) keeps the cursor.
 * - **T8** — the conta aviso `estoque-sem-deposito` FIRST, clocked by T4's read
 *   time: on a `semDeposito` TRANSITION (raised on `false → true`, resolved on
 *   `true → false`), and whenever this run took over a lease no run released
 *   (`vez` still set at T4: a run that crashed, failed, or lost its final write
 *   may have landed its aviso without the flag), synced to the CURRENT
 *   condition — the newer clock wins over whatever the earlier run wrote, even
 *   when that run lands it late. A failed aviso throws, so the stored flag stays
 *   and the next tick retries; the steady state (a released lease, the flag
 *   unchanged) makes no aviso call. Then the FINAL write, `update(…, {
 *   lastUpdateTime: <the lease's writeTime> })`: the lease released,
 *   `ultimoTickMs`, `semDeposito`, and the cursor — moved to the window's end
 *   ONLY when every SKU the task payload can carry was enqueued (or there was
 *   none), never below the stored one — with the depósito it was taken at. On
 *   FAILED_PRECONDITION (or NOT_FOUND) it re-reads
 *   ONCE: another tick's lease ⇒ nothing written (a WARNING); still ours ⇒
 *   RE-DERIVED from the re-read and retried once, never the captured patch
 *   re-applied.
 * - **T9** — ONE `evento: 'estoque'` line per conta run (`fase: 'tick'`): the
 *   outcome, the batch form, the hand-off, the rows, produtos, probes, SKUs and
 *   tasks, `truncada`, `orcamentoEsgotado`; never a SKU, a ref or a value.
 *
 * ## The hand-offs are not durable yet
 *
 * A window of 31–3,000 SKUs is a delta feed, and a larger, truncated or unmapped
 * window — or a depósito change — is a reconcile run. Neither consumer exists
 * yet, so each is a WARNING placeholder (`feed-necessario`,
 * `reconciliacao-necessaria`, `deposito-do-cursor-mudou`) and the cursor is
 * KEPT: a hand-off that is not durable never moves it, so the window stays
 * readable until a durable hand-off replaces the line.
 *
 * ## A conta that fails
 *
 * A Firestore status error and a sync document that no longer parses
 * ({@link SincronizacaoEstoqueDocumentoInvalidoError}) are contained PER CONTA
 * (one line; the lease, if taken, expires before the next tick) and the other
 * contas go on; a failed aviso is such a Firestore error. Anything else — a
 * bug — fails the tick loudly.
 *
 * ## Units
 *
 * `cursorMs`, the window's bounds, the lease's expiry and `ultimoTickMs` are
 * MILLISECONDS since epoch. An observation is a Firestore commit `Timestamp`,
 * rendered as the task's reference and never converted here; the aviso clock
 * is T4's read time, converted only in `avisos/avisos.ts`.
 *
 * ## Rule 7
 *
 * Every write is a native precondition on ONE document: the lease, then the
 * final write on the lease's own commit. The enqueues are named per
 * observation (tier 0). No multi-document atomic write.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import {
  integracaoCollection,
  sincronizacaoEstoqueAmazonCollection,
} from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isGrpcStatusError,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  INTEGRACAO_TIPO,
  MOTIVO_CONTA_AMAZON,
  type SincronizacaoEstoqueAmazon,
  sincronizacaoEstoqueAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { type ContaAmazonResumo, idDeContaValido, listarContasAmazon } from '../core/contas';
import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { FLUXO_AMAZON, MODO_AMAZON, lerChaveDeChamadasAmazon, lerValvula } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { janelaDoTick } from './descobertaEstoque';
import {
  DESFECHO_DESCOBERTA_ESTOQUE_AMAZON,
  ETAPA_DESCOBERTA_ESTOQUE_AMAZON,
  type EtapaDescobertaEstoqueAmazon,
  descobrirJanelaEstoqueAmazon,
} from './descobertaFirestore';
import {
  depositoIdDaContaEstoqueAmazon,
  depositoIdGravavelDaContaEstoqueAmazon,
  formasRefDepositoEstoqueAmazon,
} from './familiaEstoque';
import { MOTIVO_ESTOQUE_AMAZON, type MotivoEstoqueAmazon } from './motivosEstoque';
import { DESTINO_LOTE_DELTA_ESTOQUE_AMAZON, destinoDoLoteDelta } from './planoEstoque';
import {
  AmazonEstoqueRegiaoDaFilaInvalidaError,
  AmazonEstoqueTarefasDesligadasError,
  type ProdutorEstoqueAmazon,
} from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
  referenciaDaObservacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

/* -------------------------------------------------------------------------- */
/*                                 The numbers                                */
/* -------------------------------------------------------------------------- */

/** The schedule's interval, in ms (the cron itself is the functions root's). */
export const INTERVALO_TICK_ESTOQUE_AMAZON_MS = 300_000;

/** The tick root's `timeoutSeconds` (the root binds it; its `index.test.ts` pins the deployed value). */
export const TEMPO_LIMITE_TICK_ESTOQUE_AMAZON_S = 240;

/** One tick's budget, in ms: inside the function timeout, with room for the last conta's final write. */
export const ORCAMENTO_TICK_ESTOQUE_AMAZON_MS = 200_000;

/** One conta's budget, in ms, when the tick still has that much left. */
export const ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS = 200_000;

/** The part of a conta's budget kept for the aviso and the final write: the deadline is budget − this. */
export const FOLGA_CONTA_ESTOQUE_AMAZON_MS = 20_000;

/** The least budget a conta is STARTED with, in ms. */
export const ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS = 30_000;

/**
 * How long a tick's lease holds the sync document, in ms, counted from the
 * TICK's start (whichever conta it is taken for): longer than the function
 * timeout, so a live tick's lease never expires under it, and shorter than the
 * interval, so a crashed tick's leases are all free by the next one.
 */
export const LEASE_TICK_ESTOQUE_AMAZON_MS = 270_000;

/** The `fase` every line of the tick carries. */
export const FASE_TICK_ESTOQUE_AMAZON = 'tick';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

/**
 * A hand-off the tick cannot make durable yet (module header): logged as a
 * WARNING, the cursor KEPT.
 */
export const REPASSE_TICK_ESTOQUE_AMAZON = {
  /** 31–3,000 moved SKUs: one delta feed of the window. */
  feedNecessario: 'feed-necessario',
  /** More than 3,000, a truncated window, or a window not mapped in time: a reconcile run. */
  reconciliacaoNecessaria: 'reconciliacao-necessaria',
  /** The conta's depósito is not the one the cursor was taken at: a reconcile at the new one. */
  depositoDoCursorMudou: 'deposito-do-cursor-mudou',
} as const;
export type RepasseTickEstoqueAmazon =
  (typeof REPASSE_TICK_ESTOQUE_AMAZON)[keyof typeof REPASSE_TICK_ESTOQUE_AMAZON];

/** How one conta's run ended (closed). */
export const DESFECHO_TICK_ESTOQUE_AMAZON = {
  /** The window read, no SKU of the conta moved: the cursor advanced. */
  janelaVazia: 'janela-vazia',
  /** Every SKU of the window enqueued (or already enqueued): the cursor advanced. */
  enfileirado: 'enfileirado',
  /** The conta's first tick: the cursor stored at now, no window read. */
  primeiroTick: 'primeiro-tick',
  /** The cursor is ahead of this clock by more than the overlap: nothing to read. */
  cursorAdiantado: 'cursor-adiantado',
  /** A hand-off placeholder (`repasse` names it): the cursor kept. */
  repassado: 'repassado',
  /** The deadline came before the window was read, or before every task was started: the cursor kept. */
  orcamentoEsgotado: 'orcamento-esgotado',
  /** The stock queue refused the enqueue (a named class): the cursor kept. */
  enfileiramentoFalhou: 'enfileiramento-falhou',
  /** The window planner refused the stored cursor (a `RangeError`): the cursor kept. */
  janelaInvalida: 'janela-invalida',
  /** The conta has no depósito the stock sync can read. */
  semDeposito: 'sem-deposito',
  /** Another tick holds the lease: nothing written. */
  leaseOcupado: 'lease-ocupado',
  /** Another tick took the lease before the final write: nothing written by it. */
  leasePerdido: 'lease-perdido',
  /** The listed conta is gone, or no longer an Amazon conta: nothing written. */
  contaInexistente: 'conta-inexistente',
  /** The conta is inactive: nothing read past the conta, no line. */
  inativa: 'inativa',
  /** The conta id is outside the conta id grammar: nothing read. */
  idDeContaInvalido: 'id-de-conta-invalido',
  /** The tick could not give this conta its minimum budget: nothing read. */
  semTempo: 'sem-tempo',
  /** A Firestore status error, contained for this conta. */
  erroFirestore: 'erro-firestore',
  /** The sync document no longer parses (a hand edit): nothing written for this conta. */
  documentoInvalido: 'documento-invalido',
} as const;
export type DesfechoTickEstoqueAmazon =
  (typeof DESFECHO_TICK_ESTOQUE_AMAZON)[keyof typeof DESFECHO_TICK_ESTOQUE_AMAZON];

/** Why a whole tick did nothing: the read switch, or the stock valve. */
export const PORTAO_TICK_ESTOQUE_AMAZON = {
  chamadasDesligadas: 'chamadas-desligadas',
  valvulaDesligada: 'valvula-desligada',
} as const;
export type PortaoTickEstoqueAmazon =
  (typeof PORTAO_TICK_ESTOQUE_AMAZON)[keyof typeof PORTAO_TICK_ESTOQUE_AMAZON];

/**
 * A stored sync document no longer parses — only a hand edit can make one
 * (every write here goes through the schema). Contained PER CONTA
 * (`documento-invalido`, its line naming the broken top-level fields, never a
 * value); nothing is written for that conta until a person fixes it.
 */
export class SincronizacaoEstoqueDocumentoInvalidoError extends Error {
  readonly contaId: string;
  /** The top-level field names Zod blamed — never a value. */
  readonly campos: readonly string[];

  constructor(contaId: string, campos: readonly string[]) {
    super(
      `O documento sincronizacaoEstoqueAmazon/${contaId} não é válido (campos: ${campos.join(', ')}).`,
    );
    this.name = 'SincronizacaoEstoqueDocumentoInvalidoError';
    this.contaId = contaId;
    this.campos = campos;
  }
}

/** How the tick reads the contas: the uncached list, and one conta's document RAW. */
export interface LeitorDeContasEstoqueAmazon {
  /** Every Amazon conta, active or not (T2). */
  listar(db: Firestore): Promise<readonly ContaAmazonResumo[]>;
  /** One conta's document as stored, uncached; `null` when it does not exist (T3). */
  ler(db: Firestore, contaId: string): Promise<Readonly<Record<string, unknown>> | null>;
}

/** The production readers: the conta enumeration, and ONE uncached by-id read through the handle. */
export const LEITOR_DE_CONTAS_ESTOQUE_AMAZON: LeitorDeContasEstoqueAmazon = {
  async listar(db) {
    return (await listarContasAmazon(db)).contas;
  },
  async ler(db, contaId) {
    const snap = await integracaoCollection.docRef(db, {}, contaId).get();
    if (!snap.exists) return null;
    return (snap.data() ?? {}) as Record<string, unknown>;
  },
};

/** Everything one tick needs — bound by `functions/src/sweepEstoque.ts`, doubles in the tests. */
export interface DepsTickEstoqueAmazon {
  readonly db: Firestore;
  /** The process environment: the read switch and the stock valve (T1). */
  readonly ambiente: AmbienteAmazon;
  readonly contas: LeitorDeContasEstoqueAmazon;
  /** The stock queue's producer — built only when a batch is due. */
  readonly produtor: () => ProdutorEstoqueAmazon;
  /** Now, in MILLISECONDS — read at every decision (the budget, the lease, the window, the stamps). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** A fresh id per conta run: the lease's holder (the id grammar of the stock documents). */
  readonly gerarExecucaoId: () => string;
}

/** What one conta's run did (logged ONCE, T9). */
export interface ResultadoContaTickEstoqueAmazon {
  readonly contaId: string;
  readonly desfecho: DesfechoTickEstoqueAmazon;
  /** The batch's form or the conta's state, in the stock sync's closed vocabulary. */
  readonly motivo: MotivoEstoqueAmazon | null;
  /** The hand-off placeholder this run logged, if any. */
  readonly repasse: RepasseTickEstoqueAmazon | null;
  /** Window queries run, rows returned, produtos read, link partitions listed. */
  readonly paginas: number;
  readonly linhas: number;
  readonly produtos: number;
  readonly sondas: number;
  /** The conta's distinct SKUs the window mapped to. */
  readonly skus: number;
  /** Tasks enqueued, already held by Cloud Tasks, and never started (the deadline). */
  readonly tarefas: number;
  readonly jaEnfileiradas: number;
  readonly naoTentadas: number;
  /** SKUs the task payload cannot carry (more than 40 code points, which no write path sends): counted and dropped. */
  readonly foraDaTarefa: number;
  readonly truncada: boolean;
  readonly orcamentoEsgotado: boolean;
  /** The read the discovery's deadline stopped before, if it did. */
  readonly prazo: EtapaDescobertaEstoqueAmazon | null;
  readonly cursorAvancou: boolean;
  /** The flag the final write stored; `null` when none was written. */
  readonly semDeposito: boolean | null;
  /** The `estoque-sem-deposito` aviso this run raised or resolved. */
  readonly aviso: 'levantado' | 'resolvido' | null;
  /** A contained failure's CLASS — never its message. */
  readonly erro: string | null;
  readonly codigoGrpc: number | null;
  /** The broken top-level fields of an invalid sync document. */
  readonly campos: string | null;
}

export interface ResultadoTickEstoqueAmazon {
  /** Why the tick did nothing at all; `null` when it walked the contas. */
  readonly portao: PortaoTickEstoqueAmazon | null;
  readonly contas: readonly ResultadoContaTickEstoqueAmazon[];
}

/* -------------------------------------------------------------------------- */
/*                                   Logging                                  */
/* -------------------------------------------------------------------------- */

/** One `evento: 'estoque'` tick line. */
function registrarTick(
  deps: DepsTickEstoqueAmazon,
  conta: string | null,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: Readonly<Record<string, CampoLogAmazon>>,
): void {
  registrarEventoAmazon(
    deps.logger,
    'estoque',
    severidade,
    mensagem,
    { fase: FASE_TICK_ESTOQUE_AMAZON, ...campos },
    { conta, fluxo: FLUXO_AMAZON.estoque },
  );
}

const DESFECHOS_EM_WARNING: ReadonlySet<DesfechoTickEstoqueAmazon> = new Set([
  DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
  DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
  DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
  DESFECHO_TICK_ESTOQUE_AMAZON.janelaInvalida,
  DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito,
  DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido,
  DESFECHO_TICK_ESTOQUE_AMAZON.idDeContaInvalido,
  DESFECHO_TICK_ESTOQUE_AMAZON.semTempo,
  DESFECHO_TICK_ESTOQUE_AMAZON.erroFirestore,
  DESFECHO_TICK_ESTOQUE_AMAZON.documentoInvalido,
]);

/** The ONE line per conta run (T9); an inactive conta, skipped every tick, writes none. */
function registrarConta(deps: DepsTickEstoqueAmazon, r: ResultadoContaTickEstoqueAmazon): void {
  registrarTick(
    deps,
    r.contaId,
    DESFECHOS_EM_WARNING.has(r.desfecho) ? 'WARNING' : 'INFO',
    `[amazon/estoque] tick da conta: ${r.desfecho}`,
    {
      desfecho: r.desfecho,
      motivo: r.motivo,
      repasse: r.repasse,
      paginas: r.paginas,
      linhas: r.linhas,
      produtos: r.produtos,
      sondas: r.sondas,
      skus: r.skus,
      tarefas: r.tarefas,
      jaEnfileiradas: r.jaEnfileiradas,
      naoTentadas: r.naoTentadas,
      foraDaTarefa: r.foraDaTarefa,
      truncada: r.truncada,
      orcamentoEsgotado: r.orcamentoEsgotado,
      prazo: r.prazo,
      cursorAvancou: r.cursorAvancou,
      semDeposito: r.semDeposito,
      aviso: r.aviso,
      erro: r.erro,
      codigoGrpc: r.codigoGrpc,
      campos: r.campos,
    },
  );
}

function resultado(
  contaId: string,
  desfecho: DesfechoTickEstoqueAmazon,
  extra: Partial<Omit<ResultadoContaTickEstoqueAmazon, 'contaId' | 'desfecho'>> = {},
): ResultadoContaTickEstoqueAmazon {
  return {
    contaId,
    desfecho,
    motivo: null,
    repasse: null,
    paginas: 0,
    linhas: 0,
    produtos: 0,
    sondas: 0,
    skus: 0,
    tarefas: 0,
    jaEnfileiradas: 0,
    naoTentadas: 0,
    foraDaTarefa: 0,
    truncada: false,
    orcamentoEsgotado: false,
    prazo: null,
    cursorAvancou: false,
    semDeposito: null,
    aviso: null,
    erro: null,
    codigoGrpc: null,
    campos: null,
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                               The tick's order                             */
/* -------------------------------------------------------------------------- */

/**
 * The order one tick walks `contas` in: the same order, ROTATED to start at the
 * tick's five-minute slot modulo the count, so no conta starves behind the same
 * ones forever. Stateless; returns a new array.
 */
export function ordemDoTickEstoqueAmazon<T>(contas: readonly T[], inicioDoTickMs: number): T[] {
  if (contas.length === 0) return [];
  const inicio = Math.floor(inicioDoTickMs / INTERVALO_TICK_ESTOQUE_AMAZON_MS) % contas.length;
  return [...contas.slice(inicio), ...contas.slice(0, inicio)];
}

/**
 * The budget of the conta about to run, in ms: min({@link ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS},
 * what is left of the tick that started at `inicioDoTickMs`), never below 0.
 */
export function orcamentoDaContaEstoqueAmazonMs(inicioDoTickMs: number, agoraMs: number): number {
  const restante = ORCAMENTO_TICK_ESTOQUE_AMAZON_MS - (agoraMs - inicioDoTickMs);
  return Math.max(0, Math.min(ORCAMENTO_CONTA_ESTOQUE_AMAZON_MS, restante));
}

/* -------------------------------------------------------------------------- */
/*                              The sync document                              */
/* -------------------------------------------------------------------------- */

/** The sync document as read: its state, strictly parsed, its commit stamp and the read's time. */
interface SincronizacaoLida {
  readonly estado: SincronizacaoEstoqueAmazon;
  /** `null` when the document does not exist. */
  readonly updateTime: Timestamp | null;
  /** The read's own time: the `estoque-sem-deposito` aviso's clock. */
  readonly readTime: Timestamp;
}

/**
 * The sync document, strictly parsed (an absent one reads as the schema's
 * defaults). One that no longer parses throws
 * {@link SincronizacaoEstoqueDocumentoInvalidoError}, contained per conta.
 */
function lerSincronizacao(snap: DocumentSnapshot): SincronizacaoLida {
  if (!snap.exists) {
    return {
      estado: sincronizacaoEstoqueAmazonSchema.parse({}),
      updateTime: null,
      readTime: snap.readTime,
    };
  }
  const { updateTime } = snap;
  if (updateTime === undefined) {
    throw new TypeError('sincronizacaoEstoqueAmazon: documento existente sem updateTime');
  }
  const lido = sincronizacaoEstoqueAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    const campos = new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')));
    throw new SincronizacaoEstoqueDocumentoInvalidoError(snap.id, [...campos]);
  }
  return { estado: lido.data, updateTime, readTime: snap.readTime };
}

/** A lease this run took. */
interface LeaseTick {
  readonly execucaoId: string;
  /** The lease's commit — the final write's precondition. */
  readonly writeTime: Timestamp;
  /** The document as it stands after the lease. */
  readonly estado: SincronizacaoEstoqueAmazon;
}

/**
 * Take the lease (module header, T4), or `null` when another tick holds it.
 * Its expiry counts from the TICK's start, so it is free by the next tick
 * whichever conta of this one took it.
 */
async function tomarLease(
  ref: DocumentReference,
  lido: SincronizacaoLida,
  inicioDoTickMs: number,
  deps: DepsTickEstoqueAmazon,
): Promise<LeaseTick | null> {
  const agoraMs = deps.agora();
  // Held while its expiry is still ahead; at the very instant it expires, it is free.
  if (lido.updateTime !== null && lido.estado.vez !== null && lido.estado.vez.ateMs > agoraMs) {
    return null;
  }
  const vez = {
    execucaoId: deps.gerarExecucaoId(),
    ateMs: inicioDoTickMs + LEASE_TICK_ESTOQUE_AMAZON_MS,
  };
  if (lido.updateTime === null) {
    const estado = sincronizacaoEstoqueAmazonCollection.parse({ vez });
    try {
      const { writeTime } = await ref.create(estado);
      return { execucaoId: vez.execucaoId, writeTime, estado };
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return null;
    }
  }
  try {
    const { writeTime } = await ref.update(
      sincronizacaoEstoqueAmazonCollection.parseMerge({ vez }),
      {
        lastUpdateTime: lido.updateTime,
      },
    );
    return { execucaoId: vez.execucaoId, writeTime, estado: { ...lido.estado, vez } };
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    return null;
  }
}

/** What the final write applies, on whatever document state it is derived from. */
interface PlanoFinal {
  /** Move the cursor here (never below the stored one); `null` keeps it. */
  readonly cursorAteMs: number | null;
  /** The canonical depósito ref the cursor is taken at, written with the cursor. */
  readonly depositoDoCursor: string | null;
  readonly semDeposito: boolean;
  /** What this run does to the failure counter. */
  readonly falhas: 'zerar' | 'somar' | 'manter';
  readonly agoraMs: number;
}

/**
 * The final write's patch, DERIVED from `base` — the state at the lease on the
 * first attempt, the re-read on the retry — so a retry never re-applies what
 * the losing attempt decided (root rule 7): the cursor only moves forward.
 */
function patchFinal(
  base: SincronizacaoEstoqueAmazon,
  p: PlanoFinal,
): { readonly patch: Partial<SincronizacaoEstoqueAmazon>; readonly cursorAvancou: boolean } {
  const patch: Record<string, unknown> = {
    vez: null,
    ultimoTickMs: p.agoraMs,
    semDeposito: p.semDeposito,
  };
  let cursorAvancou = false;
  if (p.cursorAteMs !== null && (base.cursorMs === null || p.cursorAteMs > base.cursorMs)) {
    patch.cursorMs = p.cursorAteMs;
    cursorAvancou = true;
    if (p.depositoDoCursor !== null && p.depositoDoCursor !== base.depositoDoCursor) {
      patch.depositoDoCursor = p.depositoDoCursor;
    }
  }
  if (p.falhas === 'zerar' && base.falhasSeguidas !== 0) patch.falhasSeguidas = 0;
  if (p.falhas === 'somar') patch.falhasSeguidas = base.falhasSeguidas + 1;
  return { patch: sincronizacaoEstoqueAmazonCollection.parseMerge(patch), cursorAvancou };
}

/** One attempt of the final write, derived from `base` under `lastUpdateTime`. */
async function aplicarFinal(
  ref: DocumentReference,
  base: SincronizacaoEstoqueAmazon,
  lastUpdateTime: Timestamp,
  plano: PlanoFinal,
): Promise<{ readonly cursorAvancou: boolean }> {
  const { patch, cursorAvancou } = patchFinal(base, plano);
  await ref.update(patch, { lastUpdateTime });
  return { cursorAvancou };
}

/**
 * The final write under the lease's precondition, with ONE re-read and ONE
 * retry (module header, T8). `null` when another tick took the lease (or the
 * document is gone): nothing written.
 */
async function escreverFinal(
  ref: DocumentReference,
  lease: LeaseTick,
  plano: PlanoFinal,
): Promise<{ readonly cursorAvancou: boolean } | null> {
  try {
    return await aplicarFinal(ref, lease.estado, lease.writeTime, plano);
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
  }
  const atual = lerSincronizacao(await ref.get());
  if (atual.updateTime === null || atual.estado.vez?.execucaoId !== lease.execucaoId) return null;
  try {
    return await aplicarFinal(ref, atual.estado, atual.updateTime, plano);
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*                                 The window                                  */
/* -------------------------------------------------------------------------- */

/** What T5–T7 concluded, for the final write and the line. */
interface Conclusao {
  readonly desfecho: DesfechoTickEstoqueAmazon;
  readonly motivo: MotivoEstoqueAmazon | null;
  readonly repasse: RepasseTickEstoqueAmazon | null;
  readonly cursorAteMs: number | null;
  readonly falhas: PlanoFinal['falhas'];
  readonly extra: Partial<ResultadoContaTickEstoqueAmazon>;
}

/** A hand-off placeholder (module header): WARNING, the cursor kept, the counter untouched. */
function repassar(
  repasse: RepasseTickEstoqueAmazon,
  motivo: MotivoEstoqueAmazon,
  extra: Partial<ResultadoContaTickEstoqueAmazon>,
): Conclusao {
  return {
    desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
    motivo,
    repasse,
    cursorAteMs: null,
    falhas: 'manter',
    extra,
  };
}

/**
 * A rejection of the stock producer the tick CONTAINS, by class (root rule 6),
 * as its line names it; `null` for anything else, which the caller rethrows.
 */
function falhaDeEnfileiramentoContida(err: unknown): string | null {
  if (
    err instanceof AmazonEstoqueTarefasDesligadasError ||
    err instanceof AmazonTarefasTransitoriasError ||
    err instanceof AmazonEstoqueRegiaoDaFilaInvalidaError ||
    err instanceof MissingRegionError
  ) {
    return err.name;
  }
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  return null;
}

/** T5–T7 for one conta whose depósito is the cursor's (module header). */
async function lerEEnfileirar(
  contaId: string,
  depositoId: string,
  cursorMs: number,
  prazoMs: number,
  deps: DepsTickEstoqueAmazon,
): Promise<Conclusao> {
  // T5: the window. Its planner's RangeError ends this conta only (a stamp, never the tick).
  let janela: ReturnType<typeof janelaDoTick>;
  try {
    janela = janelaDoTick({ cursorMs, agoraMs: deps.agora() });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return {
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaInvalida,
      motivo: null,
      repasse: null,
      cursorAteMs: null,
      falhas: 'somar',
      extra: { erro: err.name },
    };
  }
  if (janela === null) {
    return {
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.cursorAdiantado,
      motivo: null,
      repasse: null,
      cursorAteMs: null,
      falhas: 'manter',
      extra: {},
    };
  }

  // T5–T6: the rows, the produtos, the probes, the conta's SKUs.
  const d = await descobrirJanelaEstoqueAmazon(
    { db: deps.db, contaId, depositoId, agora: deps.agora },
    janela,
    { prazoMs },
  );
  const lidos: Partial<ResultadoContaTickEstoqueAmazon> = {
    paginas: d.contagem.paginas,
    linhas: d.contagem.linhas,
    produtos: d.contagem.produtos,
    sondas: d.contagem.sondas,
  };
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada) {
    return repassar(
      REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      { ...lidos, truncada: true },
    );
  }
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo) {
    // T5's deadline (before or between window pages) says the reads were slow,
    // not how much moved: the cursor kept, the next tick re-reads the window.
    if (d.etapa === ETAPA_DESCOBERTA_ESTOQUE_AMAZON.janela) {
      return {
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
        motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
        repasse: null,
        cursorAteMs: null,
        falhas: 'somar',
        extra: { ...lidos, prazo: d.etapa, orcamentoEsgotado: true },
      };
    }
    // T6's (the produtos, the link partitions): a window too slow to map.
    return repassar(
      REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
      MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
      { ...lidos, prazo: d.etapa },
    );
  }

  // T7: the batch's form, from its distinct SKUs as the tick sees them.
  const n = d.observacoes.length;
  const comSkus = { ...lidos, skus: n };
  switch (destinoDoLoteDelta(n)) {
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.nada:
      return {
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia,
        motivo: null,
        repasse: null,
        cursorAteMs: janela.ateMs,
        falhas: 'zerar',
        extra: comSkus,
      };
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed:
      return repassar(
        REPASSE_TICK_ESTOQUE_AMAZON.feedNecessario,
        MOTIVO_ESTOQUE_AMAZON.emFeed,
        comSkus,
      );
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.reconciliacao:
      return repassar(
        REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
        MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
        comSkus,
      );
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches:
      break;
  }

  // 1–30: one named patch task per observation; a SKU no payload can carry is counted.
  const tarefas: TarefaEstoqueAmazon[] = [];
  let foraDaTarefa = 0;
  for (const o of d.observacoes) {
    const t = tarefaEstoqueAmazonSchema.safeParse({
      v: VERSAO_TAREFA_ESTOQUE_AMAZON,
      contaId,
      sku: o.sku,
      origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
      referencia: referenciaDaObservacao(o.updateTime),
      depositoId: null,
    });
    if (t.success) tarefas.push(t.data);
    else foraDaTarefa += 1;
  }
  const comTarefas = { ...comSkus, foraDaTarefa };
  let lote = { enfileiradas: 0, jaEnfileiradas: 0, naoTentadas: 0 };
  if (tarefas.length > 0) {
    try {
      lote = await deps
        .produtor()
        .enfileirarLote(tarefas, { continuar: () => deps.agora() < prazoMs });
    } catch (err) {
      const classe = falhaDeEnfileiramentoContida(err);
      if (classe === null) throw err;
      return {
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
        motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
        repasse: null,
        cursorAteMs: null,
        falhas: 'somar',
        extra: { ...comTarefas, erro: classe },
      };
    }
  }
  const contados = {
    ...comTarefas,
    tarefas: lote.enfileiradas,
    jaEnfileiradas: lote.jaEnfileiradas,
    naoTentadas: lote.naoTentadas,
  };
  if (lote.naoTentadas > 0) {
    return {
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
      motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
      repasse: null,
      cursorAteMs: null,
      falhas: 'somar',
      extra: { ...contados, orcamentoEsgotado: true },
    };
  }
  return {
    desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
    motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
    repasse: null,
    cursorAteMs: janela.ateMs,
    falhas: 'zerar',
    extra: contados,
  };
}

/* -------------------------------------------------------------------------- */
/*                               One conta's run                               */
/* -------------------------------------------------------------------------- */

/**
 * One conta's run, T3–T9 (module header). A Firestore status error and
 * {@link SincronizacaoEstoqueDocumentoInvalidoError} propagate: the tick
 * contains them per conta.
 */
async function executarConta(
  contaId: string,
  inicioDoTickMs: number,
  prazoMs: number,
  deps: DepsTickEstoqueAmazon,
): Promise<ResultadoContaTickEstoqueAmazon> {
  // T3: the conta, raw and uncached; its depósito as the stock documents store it.
  const raw = await deps.contas.ler(deps.db, contaId);
  if (raw?.tipo !== INTEGRACAO_TIPO.amazon) {
    return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.contaInexistente);
  }
  if (raw.ativo === false) return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.inativa);
  const depositoId = depositoIdGravavelDaContaEstoqueAmazon(raw.depositoOuterRef);

  // T4: the sync document and its lease.
  const ref = sincronizacaoEstoqueAmazonCollection.docRef(deps.db, {}, contaId);
  const lido = lerSincronizacao(await ref.get());
  const lease = await tomarLease(ref, lido, inicioDoTickMs, deps);
  if (lease === null) return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.leaseOcupado);
  const estado = lease.estado;

  let conclusao: Conclusao;
  let depositoDoCursor: string | null = null;
  if (depositoId === null) {
    conclusao = {
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito,
      motivo: MOTIVO_ESTOQUE_AMAZON.contaSemDeposito,
      repasse: null,
      cursorAteMs: null,
      falhas: 'manter',
      extra: {},
    };
  } else {
    depositoDoCursor = formasRefDepositoEstoqueAmazon(depositoId)[0];
    if (estado.cursorMs === null) {
      conclusao = {
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.primeiroTick,
        motivo: null,
        repasse: null,
        cursorAteMs: deps.agora(),
        falhas: 'zerar',
        extra: {},
      };
    } else if (depositoIdDaContaEstoqueAmazon(estado.depositoDoCursor) !== depositoId) {
      // No window from a cursor taken at another depósito (module header, T4).
      conclusao = repassar(
        REPASSE_TICK_ESTOQUE_AMAZON.depositoDoCursorMudou,
        MOTIVO_ESTOQUE_AMAZON.depositoMudou,
        {},
      );
    } else {
      conclusao = await lerEEnfileirar(contaId, depositoId, estado.cursorMs, prazoMs, deps);
    }
  }

  // T8: the aviso FIRST — the flag it is gated on is stored after it. On a
  // transition, and after taking over a lease no run released: that run may
  // have landed its aviso and lost the flag, which no later transition would
  // ever correct.
  const semDeposito = depositoId === null;
  const retomada = lido.estado.vez !== null;
  let aviso: ResultadoContaTickEstoqueAmazon['aviso'] = null;
  if (semDeposito !== estado.semDeposito || retomada) {
    await sincronizarAvisoContaEstoqueAmazon(
      deps.db,
      { increment: deps.increment, nowMs: deps.agora(), logger: deps.logger },
      {
        integracaoId: contaId,
        motivo: MOTIVO_CONTA_AMAZON.estoqueSemDeposito,
        acao: semDeposito
          ? ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar
          : ACAO_AVISO_CONTA_ESTOQUE_AMAZON.resolver,
        relogio: lido.readTime,
      },
    );
    aviso = semDeposito ? 'levantado' : 'resolvido';
  }

  // T8: the final write.
  const escrito = await escreverFinal(ref, lease, {
    cursorAteMs: conclusao.cursorAteMs,
    depositoDoCursor,
    semDeposito,
    falhas: conclusao.falhas,
    agoraMs: deps.agora(),
  });
  const comum = {
    ...conclusao.extra,
    motivo: conclusao.motivo,
    repasse: conclusao.repasse,
    aviso,
  };
  if (escrito === null) {
    return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido, comum);
  }
  return resultado(contaId, conclusao.desfecho, {
    ...comum,
    semDeposito,
    cursorAvancou: escrito.cursorAvancou,
  });
}

/** One conta inside the tick: the budget, the skip rules and the containment. */
async function contaNoTick(
  conta: ContaAmazonResumo,
  inicioDoTickMs: number,
  deps: DepsTickEstoqueAmazon,
): Promise<ResultadoContaTickEstoqueAmazon> {
  const contaId = conta.integracaoId;
  if (!conta.ativo) return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.inativa);
  if (!idDeContaValido(contaId)) {
    return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.idDeContaInvalido);
  }
  const agoraMs = deps.agora();
  const orcamentoMs = orcamentoDaContaEstoqueAmazonMs(inicioDoTickMs, agoraMs);
  if (orcamentoMs < ORCAMENTO_MINIMO_CONTA_ESTOQUE_AMAZON_MS) {
    return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.semTempo);
  }
  const prazoMs = agoraMs + orcamentoMs - FOLGA_CONTA_ESTOQUE_AMAZON_MS;
  try {
    return await executarConta(contaId, inicioDoTickMs, prazoMs, deps);
  } catch (err) {
    if (err instanceof SincronizacaoEstoqueDocumentoInvalidoError) {
      return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.documentoInvalido, {
        erro: err.name,
        campos: err.campos.join(','),
      });
    }
    if (!isGrpcStatusError(err)) throw err;
    return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.erroFirestore, {
      erro: err.name,
      codigoGrpc: err.code,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  One tick                                  */
/* -------------------------------------------------------------------------- */

/**
 * One tick of the five-minute schedule (module header). The contas run one
 * after another, never in parallel.
 */
export async function executarTickEstoqueAmazon(
  deps: DepsTickEstoqueAmazon,
): Promise<ResultadoTickEstoqueAmazon> {
  // T1: the read switch, then the stock valve — before any Firestore read.
  const chamadas = lerChaveDeChamadasAmazon(deps.ambiente);
  const valvula = lerValvula(FLUXO_AMAZON.estoque, deps.ambiente);
  const portao = !chamadas
    ? PORTAO_TICK_ESTOQUE_AMAZON.chamadasDesligadas
    : valvula.modo === MODO_AMAZON.off
      ? PORTAO_TICK_ESTOQUE_AMAZON.valvulaDesligada
      : null;
  if (portao !== null) {
    registrarTick(deps, null, 'INFO', `[amazon/estoque] tick: ${portao} — nada lido`, {
      portao,
      valvula: valvula.modo,
    });
    return { portao, contas: [] };
  }

  // T2: the contas, uncached; each active one, rotated.
  const inicioDoTickMs = deps.agora();
  const contas = await deps.contas.listar(deps.db);
  const resultados: ResultadoContaTickEstoqueAmazon[] = [];
  for (const conta of ordemDoTickEstoqueAmazon(contas, inicioDoTickMs)) {
    const r = await contaNoTick(conta, inicioDoTickMs, deps);
    resultados.push(r);
    if (r.desfecho !== DESFECHO_TICK_ESTOQUE_AMAZON.inativa) registrarConta(deps, r);
  }
  return { portao: null, contas: resultados };
}

/**
 * The tick's counters, FLAT, for the root's summary line: how many contas
 * ended each way (`desfecho_<nome>`), and the tasks enqueued.
 */
export function resumirTickEstoqueAmazon(
  r: ResultadoTickEstoqueAmazon,
): Readonly<Record<string, CampoLogAmazon>> {
  const saida: Record<string, CampoLogAmazon> = {
    fase: FASE_TICK_ESTOQUE_AMAZON,
    portao: r.portao,
    contas: r.contas.length,
  };
  let tarefas = 0;
  for (const c of r.contas) {
    const chave = `desfecho_${c.desfecho}`;
    const atual = saida[chave];
    saida[chave] = (typeof atual === 'number' ? atual : 0) + 1;
    tarefas += c.tarefas;
  }
  saida.tarefas = tarefas;
  return saida;
}
