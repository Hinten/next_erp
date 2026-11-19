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
 *     reconcile can see them. The reconcile hand-off (below), then the cursor
 *     RESET to now with the new depósito: one WARNING line, once.
 * - **T4b** — ONE `getAll` of the conta's reconcile run
 *   (`reconciliacaoEstoqueAmazon/{contaId}`) and its stock feed lease
 *   (`feedsAmazonEmCurso/estoque-{contaId}`), both by id, whatever the depósito:
 *   - a LIVE run without progress for more than 15 minutes has lost its next
 *     task: its page is RE-KICKED (`retomarReconciliacaoEstoqueAmazon`, named by
 *     the stall), so a stall heals within minutes with no request;
 *   - the STRANDED START: an EXPIRED `montando` lease holding a pending start
 *     (a holder that died building releases nothing, and on a quiet stretch no
 *     batch comes to take it over) ⇒ the start's NAMED `vez` recovery FIRST,
 *     then the start cleared — both through the lease I/O
 *     (`consumirPendenteVezFeed`, which re-reads the lease and re-decides on
 *     that read, so a holder that moved meanwhile is never overwritten).
 *   A named failure of the jobs producer there ends the conta's run
 *   `enfileiramento-falhou` before any window read (T8 still runs). A run or a
 *   lease that no longer parses costs only its own step — the re-kick, or the
 *   stranded start — named in `manutencaoInvalida` (the line at WARNING): the
 *   delta path below still runs, so a broken maintenance document never halts
 *   the conta's five-minute sync.
 * - **T5** — `janelaDoTick` over the stored cursor. A `RangeError` from it (a
 *   cursor too far ahead of the clock to be a ms instant: a hand edit or a
 *   misplaced unit) is caught BY CLASS around that one call: no window can be
 *   planned from it, so the reconcile hand-off, then the cursor RESET to now
 *   (`janela-invalida`, WARNING) — the tick heals the cursor instead of
 *   repeating the refusal every five minutes. A `null` window (a cursor ahead
 *   of this clock by the overlap or more) reads nothing. The window reaches 5 minutes below the cursor and keeps a row
 *   stamped after `cursor − 20 s`, or stamped further back but COMMITTED after
 *   `cursor − 20 s`: the main estoque writer
 *   (`apps/functions/src/estoques/sincronizarEstoquePedido.ts`) takes its stamp
 *   before its transaction, so a row the previous tick's query could not see
 *   yet can carry a stamp below the overlap. A kept row never forces its SKU
 *   here. A commit lagging its stamp by more than about 5 minutes (as little as
 *   4 min 40 s when this clock runs the full 20-s skew ahead of Firestore's)
 *   across a tick boundary is still missed (the SKU's next movement or the
 *   daily reconcile corrects it), and the rows of the reach-back are read
 *   again and dropped unless committed late (`descobertaEstoque.ts`, "The
 *   residue and the cost"). Then `descobrirJanelaEstoqueAmazon`: the window, paged, at
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
 *   and the names dedupe what was already enqueued); 31–3,000 ⇒ the delta
 *   feed, as `decidirLote` reads the stock valve: under a canary LIST the
 *   canary's own SKUs as patch tasks per observation (the others counted
 *   `fora-do-canario`), otherwise the window `feed-enviar` (its send applies
 *   the valve again); more ⇒ a reconcile. A SKU the task payload cannot carry
 *   (more than 40 code points, which no write path can send) is counted and
 *   dropped; a contained enqueue failure (either queue's valve, a named
 *   transient, a region, a raw Cloud Tasks failure) keeps the cursor.
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
 *   none) or the window was durably handed off, never below the stored one but
 *   by the two RESETS (a depósito change, a cursor no window can be planned
 *   from) — with the depósito it was taken at. On
 *   FAILED_PRECONDITION (or NOT_FOUND) it re-reads
 *   ONCE: another tick's lease ⇒ nothing written (a WARNING); still ours ⇒
 *   RE-DERIVED from the re-read and retried once, never the captured patch
 *   re-applied.
 * - **T9** — ONE `evento: 'estoque'` line per conta run (`fase: 'tick'`): the
 *   outcome, the batch form, the hand-off, the rows, produtos, probes, SKUs and
 *   tasks, `truncada`, `orcamentoEsgotado`; never a SKU, a ref or a value. The
 *   rows (`linhas`) are every row the window query RETURNED, the reach-back's
 *   re-read rows the keep rule dropped included, never only the ones that moved.
 *
 * ## The hand-offs, durable
 *
 * A hand-off is durable before the cursor moves past its window, so a window
 * is never lost:
 *
 *  - the DELTA FEED (`feed-necessario`, 31–3,000 SKUs): ONE window
 *    `feed-enviar` onto the jobs queue — the window's bounds, its keep rule
 *    WHOLE (`manterDesdeMs`, `commitAposMs`, `forcarPorCommit: false`), no
 *    `esperaAteMs`, and the depósito, never its SKUs (the send re-derives the
 *    window under exactly the tick's keep rule, its late commits kept and
 *    unforced; the set may differ by what moved in between) — NAMED
 *    `nomeEnvioFeed(conta, execucaoIdDaJanelaFeed(conta, desdeMs, ateMs))`
 *    with the window's own `desdeMs` (cursor − 5 min: a clamped window is a
 *    reconcile, never a feed), so the same window
 *    twice is one batch; no delay. Turned away on `ocupada` or
 *    `incerta-recuperar`, the batch records its RANGE start as the pending
 *    one; behind a slow, uncertain, overdue or expired holder, or an open
 *    breaker, it goes per SKU (the table in `feeds/vezFeed.ts`);
 *  - the RECONCILE (`reconciliacao-necessaria`: more than 3,000 SKUs, a
 *    truncated window, a window not mapped in time, a depósito change, a
 *    cursor no window can be planned from): `solicitarReconciliacaoEstoqueAmazon`
 *    with `origem: 'tick'` — the request written on its own document, then
 *    Start (a live run leaves the request to its close). A tick's request is
 *    never refused: only an automatic one is loop-guarded.
 *
 * The line names the hand-off (`repasse`) and what it answered (`entrega`). A
 * named failure of the jobs producer keeps the cursor
 * (`enfileiramento-falhou`): the next tick re-reads the window and hands it
 * off again, the names deduping what landed.
 *
 * ## A conta that fails
 *
 * A Firestore status error, and a sync document, a reconcile run or request,
 * or a stock feed lease that no longer parses
 * ({@link SincronizacaoEstoqueDocumentoInvalidoError}, and the reconcile's and
 * the lease's own classes), are contained PER CONTA (one line; the lease, if
 * taken, expires before the next tick) and the other contas go on; a failed
 * aviso is such a Firestore error. So is a reconcile or lease write that kept
 * losing its precondition (`conflito`: the next tick re-derives). Anything
 * else — a bug — fails the tick loudly.
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
 * final write on the lease's own commit. The enqueues are named (tier 0): a
 * patch task per observation, the delta feed per window, the re-kick per stall
 * and the stranded start's recovery per (holder, start). The reconcile request
 * and the feed lease's start are written by their own modules, each tier 1 on
 * its own read. No multi-document atomic write.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
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
  type ReconciliacaoEstoqueAmazon,
  type SincronizacaoEstoqueAmazon,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
  sincronizacaoEstoqueAmazonSchema,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { type ContaAmazonResumo, idDeContaValido, listarContasAmazon } from '../core/contas';
import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  FLUXO_AMAZON,
  MODO_AMAZON,
  type ValvulaAmazon,
  decidirAlvo,
  decidirLote,
  lerChaveDeChamadasAmazon,
  lerValvula,
} from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type {
  AgendadorLotesAmazon,
  ResultadoEnfileiramentoLoteAmazon,
} from '../feeds/agendadorLotes';
import {
  TIPO_TAREFA_LOTE_AMAZON,
  VERSAO_TAREFA_LOTE_AMAZON,
  execucaoIdDaJanelaFeed,
  nomeEnvioFeed,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import { CONSUMO_DO_PENDENTE, consumirPendenteVez } from '../feeds/vezFeed';
import {
  type AlvoVezFeed,
  AmazonVezFeedEmConflitoError,
  AmazonVezFeedInvalidaError,
  consumirPendenteVezFeed,
  lerVezFeedDoSnapshot,
  refVezFeed,
} from '../feeds/vezFeedFirestore';
import {
  type JanelaEstoqueAmazon,
  type ObservacaoEstoqueAmazon,
  janelaDoTick,
} from './descobertaEstoque';
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
  ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON,
  ReconciliacaoEstoqueDocumentoInvalidoError,
  ReconciliacaoEstoqueEmConflitoError,
  type ResultadoRetomadaReconciliacaoEstoqueAmazon,
  falhaDeEnfileiramentoLoteContida,
  lerReconciliacaoDoSnapshot,
  refReconciliacaoEstoqueAmazon,
  retomarReconciliacaoEstoqueAmazon,
  solicitarReconciliacaoEstoqueAmazon,
} from './reconciliacaoEstoque';
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

/** The producer label of a tick's window `feed-enviar` (the record and the lines carry it). */
export const ORIGEM_LOTE_TICK_ESTOQUE_AMAZON = 'delta';

/* -------------------------------------------------------------------------- */
/*                                  Contract                                  */
/* -------------------------------------------------------------------------- */

/** A durable hand-off of the window (module header): the line names it. */
export const REPASSE_TICK_ESTOQUE_AMAZON = {
  /** 31–3,000 moved SKUs: one delta feed of the window. */
  feedNecessario: 'feed-necessario',
  /**
   * More than 3,000 SKUs, a truncated window, a window not mapped in time, a
   * depósito change or a cursor no window can be planned from: a reconcile run.
   */
  reconciliacaoNecessaria: 'reconciliacao-necessaria',
} as const;
export type RepasseTickEstoqueAmazon =
  (typeof REPASSE_TICK_ESTOQUE_AMAZON)[keyof typeof REPASSE_TICK_ESTOQUE_AMAZON];

/** What a hand-off answered (closed): the delta feed's enqueue, or the reconcile request. */
export type EntregaTickEstoqueAmazon = ResultadoEnfileiramentoLoteAmazon | 'pedido';

/** How one conta's run ended (closed). */
export const DESFECHO_TICK_ESTOQUE_AMAZON = {
  /** The window read, no SKU of the conta moved: the cursor advanced. */
  janelaVazia: 'janela-vazia',
  /** Every SKU of the window enqueued (or already enqueued): the cursor advanced. */
  enfileirado: 'enfileirado',
  /** The conta's first tick: the cursor stored at now, no window read. */
  primeiroTick: 'primeiro-tick',
  /** The cursor is ahead of this clock by the overlap or more: nothing to read. */
  cursorAdiantado: 'cursor-adiantado',
  /** A durable hand-off (`repasse` names it, `entrega` what it answered): the cursor advanced. */
  repassado: 'repassado',
  /** The deadline came before the window was read, or before every task was started: the cursor kept. */
  orcamentoEsgotado: 'orcamento-esgotado',
  /** Either queue refused an enqueue (a named class): the cursor kept. */
  enfileiramentoFalhou: 'enfileiramento-falhou',
  /**
   * The window planner refused the stored cursor (a `RangeError`): the
   * reconcile hand-off, then the cursor RESET to now.
   */
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
  /**
   * The sync document, the reconcile run or request, or the stock feed lease no
   * longer parses (a hand edit): nothing more written for this conta.
   */
  documentoInvalido: 'documento-invalido',
  /** A reconcile or feed-lease write kept losing its precondition: the next tick re-derives. */
  conflito: 'conflito',
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
  /**
   * The jobs queue's producer — built only when one is due: the delta feed's
   * `feed-enviar`, a reconcile page (a re-kick, a requested run's first page),
   * the stranded start's `vez` recovery.
   */
  readonly agendador: () => AgendadorLotesAmazon;
  /** Now, in MILLISECONDS — read at every decision (the budget, the lease, the window, the stamps). */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /**
   * A fresh id (the id grammar of the stock documents): each conta run's lease
   * holder, and the run a reconcile request starts.
   */
  readonly gerarExecucaoId: () => string;
}

/** What one conta's run did (logged ONCE, T9). */
export interface ResultadoContaTickEstoqueAmazon {
  readonly contaId: string;
  readonly desfecho: DesfechoTickEstoqueAmazon;
  /** The batch's form or the conta's state, in the stock sync's closed vocabulary. */
  readonly motivo: MotivoEstoqueAmazon | null;
  /** The hand-off this run made, if any. */
  readonly repasse: RepasseTickEstoqueAmazon | null;
  /** What that hand-off answered. */
  readonly entrega: EntregaTickEstoqueAmazon | null;
  /** T4b: the re-kick of a stalled reconcile run, when one was due. */
  readonly retomada: ResultadoRetomadaReconciliacaoEstoqueAmazon;
  /** T4b: a stranded start handed to its `vez` recovery and cleared. */
  readonly inicioRecuperado: boolean;
  /** T4b: a run or lease that no longer parses, `<class>:<fields>` joined with `;` (its step skipped). */
  readonly manutencaoInvalida: string | null;
  /** 31+ SKUs under a canary list: the SKUs the list does not name (not sent). */
  readonly foraDoCanario: number;
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
  DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado,
  DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
  DESFECHO_TICK_ESTOQUE_AMAZON.janelaInvalida,
  DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito,
  DESFECHO_TICK_ESTOQUE_AMAZON.leasePerdido,
  DESFECHO_TICK_ESTOQUE_AMAZON.idDeContaInvalido,
  DESFECHO_TICK_ESTOQUE_AMAZON.semTempo,
  DESFECHO_TICK_ESTOQUE_AMAZON.erroFirestore,
  DESFECHO_TICK_ESTOQUE_AMAZON.documentoInvalido,
  DESFECHO_TICK_ESTOQUE_AMAZON.conflito,
]);

/**
 * WARNING for a failed or refused run, and for a depósito change (an operator
 * moved the conta: its hand-off re-reads the whole catalogue); a durable
 * hand-off of a busy window is the everyday path, INFO.
 */
function severidadeDaConta(r: ResultadoContaTickEstoqueAmazon): SeveridadeAmazon {
  if (DESFECHOS_EM_WARNING.has(r.desfecho)) return 'WARNING';
  if (r.manutencaoInvalida !== null) return 'WARNING';
  return r.motivo === MOTIVO_ESTOQUE_AMAZON.depositoMudou ? 'WARNING' : 'INFO';
}

/** The ONE line per conta run (T9); an inactive conta, skipped every tick, writes none. */
function registrarConta(deps: DepsTickEstoqueAmazon, r: ResultadoContaTickEstoqueAmazon): void {
  registrarTick(
    deps,
    r.contaId,
    severidadeDaConta(r),
    `[amazon/estoque] tick da conta: ${r.desfecho}`,
    {
      desfecho: r.desfecho,
      motivo: r.motivo,
      repasse: r.repasse,
      entrega: r.entrega,
      retomada: r.retomada,
      inicioRecuperado: r.inicioRecuperado,
      manutencaoInvalida: r.manutencaoInvalida,
      foraDoCanario: r.foraDoCanario,
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
    entrega: null,
    retomada: null,
    inicioRecuperado: false,
    manutencaoInvalida: null,
    foraDoCanario: 0,
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
  /** Move the cursor here (never below the stored one, but by a reset); `null` keeps it. */
  readonly cursorAteMs: number | null;
  /**
   * A RESET (a depósito change, a cursor no window can be planned from): the
   * cursor written at `cursorAteMs` WHATEVER the stored one, its depósito
   * with it — only after the reconcile hand-off that covers what it skips.
   */
  readonly reiniciar: boolean;
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
 * the losing attempt decided (root rule 7): the cursor only moves forward, but
 * by a reset.
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
  if (
    p.cursorAteMs !== null &&
    (p.reiniciar || base.cursorMs === null || p.cursorAteMs > base.cursorMs)
  ) {
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

/** What T4b–T7 concluded, for the final write and the line. */
interface Conclusao {
  readonly desfecho: DesfechoTickEstoqueAmazon;
  readonly motivo: MotivoEstoqueAmazon | null;
  readonly repasse: RepasseTickEstoqueAmazon | null;
  readonly entrega: EntregaTickEstoqueAmazon | null;
  readonly cursorAteMs: number | null;
  /** The cursor RESET (`PlanoFinal.reiniciar`). */
  readonly reiniciar: boolean;
  readonly falhas: PlanoFinal['falhas'];
  readonly extra: Partial<ResultadoContaTickEstoqueAmazon>;
}

/** A conclusion that keeps the cursor and leaves the counter as it is. */
function semCursor(
  desfecho: DesfechoTickEstoqueAmazon,
  extra: Partial<ResultadoContaTickEstoqueAmazon> = {},
): Conclusao {
  return {
    desfecho,
    motivo: null,
    repasse: null,
    entrega: null,
    cursorAteMs: null,
    reiniciar: false,
    falhas: 'manter',
    extra,
  };
}

/**
 * A rejection of either producer the tick CONTAINS, by class (root rule 6), as
 * its line names it: the stock queue's own valve and region classes, then the
 * jobs producer's (`falhaDeEnfileiramentoLoteContida`: its valve and region,
 * and the named transient, the missing region and the raw Cloud Tasks
 * failure both producers share); `null` for anything else, which the caller
 * rethrows.
 */
function falhaDeEnfileiramentoContida(err: unknown): string | null {
  if (
    err instanceof AmazonEstoqueTarefasDesligadasError ||
    err instanceof AmazonEstoqueRegiaoDaFilaInvalidaError
  ) {
    return err.name;
  }
  return falhaDeEnfileiramentoLoteContida(err);
}

/** A contained enqueue failure: the cursor kept, the counter + 1 (module header). */
function enfileiramentoFalhou(
  erro: string,
  motivo: MotivoEstoqueAmazon | null,
  repasse: RepasseTickEstoqueAmazon | null,
  extra: Partial<ResultadoContaTickEstoqueAmazon>,
): Conclusao {
  return {
    desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileiramentoFalhou,
    motivo,
    repasse,
    entrega: null,
    cursorAteMs: null,
    reiniciar: false,
    falhas: 'somar',
    extra: { ...extra, erro },
  };
}

/** What one durable hand-off is: its kind, its motivo, and the cursor it lets move. */
interface Repasse {
  readonly repasse: RepasseTickEstoqueAmazon;
  readonly motivo: MotivoEstoqueAmazon;
  readonly desfecho: DesfechoTickEstoqueAmazon;
  readonly cursorAteMs: number;
  readonly reiniciar: boolean;
  /** The counter: a durable hand-off is a clean end; a cursor no window could be planned from is not. */
  readonly falhas: PlanoFinal['falhas'];
}

/**
 * ONE durable hand-off (module header, "The hand-offs, durable"): `fazer`
 * enqueues the delta feed or writes the reconcile request; only once it
 * answered may the cursor move. A named producer failure keeps the cursor.
 */
async function repassar(
  r: Repasse,
  fazer: () => Promise<EntregaTickEstoqueAmazon>,
  extra: Partial<ResultadoContaTickEstoqueAmazon>,
): Promise<Conclusao> {
  let entrega: EntregaTickEstoqueAmazon;
  try {
    entrega = await fazer();
  } catch (err) {
    const classe = falhaDeEnfileiramentoContida(err);
    if (classe === null) throw err;
    return enfileiramentoFalhou(classe, r.motivo, r.repasse, extra);
  }
  return {
    desfecho: r.desfecho,
    motivo: r.motivo,
    repasse: r.repasse,
    entrega,
    cursorAteMs: r.cursorAteMs,
    reiniciar: r.reiniciar,
    falhas: r.falhas,
    extra,
  };
}

/**
 * The reconcile hand-off (module header): the request, `origem: 'tick'`, then
 * Start. A tick's request is never refused (only an automatic one is guarded),
 * so its answer is the request itself.
 */
async function pedirReconciliacao(
  contaId: string,
  deps: DepsTickEstoqueAmazon,
): Promise<EntregaTickEstoqueAmazon> {
  await solicitarReconciliacaoEstoqueAmazon(
    deps.db,
    contaId,
    ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.tick,
    deps,
  );
  return 'pedido';
}

/**
 * The delta-feed hand-off (module header): ONE window `feed-enviar` carrying
 * the window's bounds, its keep rule WHOLE (`manterDesdeMs`, `commitAposMs`
 * and `forcarPorCommit`, which the tick's window always sets `false`) and the
 * depósito — never its SKUs — NAMED by (conta, window), no delay. A batch that
 * does not force waits on no lease (`esperaAteMs: null`): turned away on
 * `ocupada` or `incerta-recuperar`, its range start is recorded instead; behind
 * a slow, uncertain, overdue or expired holder, or an open breaker, it goes per
 * SKU (`feeds/vezFeed.ts`, `classeDoLote` and `destinoDoLoteRecusado`).
 */
function enfileirarFeedDoTick(
  contaId: string,
  depositoId: string,
  janela: JanelaEstoqueAmazon,
  deps: DepsTickEstoqueAmazon,
): Promise<EntregaTickEstoqueAmazon> {
  const execucaoId = execucaoIdDaJanelaFeed(contaId, janela.desdeMs, janela.ateMs);
  const tarefa = tarefaEnviarFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
    fluxo: FLUXO_AMAZON.estoque,
    contaId,
    execucaoId,
    origem: ORIGEM_LOTE_TICK_ESTOQUE_AMAZON,
    lote: {
      tipo: TIPO_LOTE_FEED_AMAZON.janela,
      desdeMs: janela.desdeMs,
      ateMs: janela.ateMs,
      manterDesdeMs: janela.manterDesdeMs,
      commitAposMs: janela.commitAposMs,
      forcarPorCommit: janela.forcarPorCommit,
      esperaAteMs: null,
      depositoId,
    },
  });
  return deps.agendador().enfileirarLote(tarefa, { nome: nomeEnvioFeed(contaId, execucaoId) });
}

/**
 * One NAMED delta patch task per observation, at most 16 in flight, the
 * deadline asked before STARTING each; a SKU no payload can carry counted. The
 * cursor moves to the window's end only when every task was started.
 */
async function enfileirarObservacoes(
  contaId: string,
  observacoes: readonly ObservacaoEstoqueAmazon[],
  cursorAteMs: number,
  prazoMs: number,
  deps: DepsTickEstoqueAmazon,
  extra: Partial<ResultadoContaTickEstoqueAmazon>,
): Promise<Conclusao> {
  const tarefas: TarefaEstoqueAmazon[] = [];
  let foraDaTarefa = 0;
  for (const o of observacoes) {
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
  const comTarefas = { ...extra, foraDaTarefa };
  let lote = { enfileiradas: 0, jaEnfileiradas: 0, naoTentadas: 0 };
  if (tarefas.length > 0) {
    try {
      lote = await deps
        .produtor()
        .enfileirarLote(tarefas, { continuar: () => deps.agora() < prazoMs });
    } catch (err) {
      const classe = falhaDeEnfileiramentoContida(err);
      if (classe === null) throw err;
      return enfileiramentoFalhou(classe, MOTIVO_ESTOQUE_AMAZON.emPatches, null, comTarefas);
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
      ...semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado, {
        ...contados,
        orcamentoEsgotado: true,
      }),
      motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
      falhas: 'somar',
    };
  }
  return {
    desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.enfileirado,
    motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
    repasse: null,
    entrega: null,
    cursorAteMs,
    reiniciar: false,
    falhas: 'zerar',
    extra: contados,
  };
}

/** What T5–T7 work with for one conta whose depósito is the cursor's. */
interface ContaDaJanela {
  readonly contaId: string;
  readonly depositoId: string;
  readonly cursorMs: number;
  readonly prazoMs: number;
  readonly valvula: ValvulaAmazon<typeof FLUXO_AMAZON.estoque>;
}

/** T5–T7 for one conta whose depósito is the cursor's (module header). */
async function lerEEnfileirar(c: ContaDaJanela, deps: DepsTickEstoqueAmazon): Promise<Conclusao> {
  const { contaId, depositoId, prazoMs } = c;
  // T5: the window. Its planner's RangeError is caught around that call alone:
  // no window can be planned from this cursor, so a reconcile covers whatever
  // it would have read, and the cursor is RESET (taken BEFORE the request).
  const agoraMs = deps.agora();
  let janela: ReturnType<typeof janelaDoTick>;
  try {
    janela = janelaDoTick({ cursorMs: c.cursorMs, agoraMs });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return repassar(
      {
        repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
        motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.janelaInvalida,
        cursorAteMs: agoraMs,
        reiniciar: true,
        falhas: 'somar',
      },
      () => pedirReconciliacao(contaId, deps),
      { erro: err.name },
    );
  }
  if (janela === null) return semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.cursorAdiantado);
  const ateMs = janela.ateMs;
  const reconciliacao = (extra: Partial<ResultadoContaTickEstoqueAmazon>) =>
    repassar(
      {
        repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
        motivo: MOTIVO_ESTOQUE_AMAZON.emReconciliacao,
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
        cursorAteMs: ateMs,
        reiniciar: false,
        falhas: 'zerar',
      },
      () => pedirReconciliacao(contaId, deps),
      extra,
    );

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
    return reconciliacao({ ...lidos, truncada: true });
  }
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo) {
    // T5's deadline (before or between window pages) says the reads were slow,
    // not how much moved: the cursor kept, the next tick re-reads the window.
    if (d.etapa === ETAPA_DESCOBERTA_ESTOQUE_AMAZON.janela) {
      return {
        ...semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.orcamentoEsgotado, {
          ...lidos,
          prazo: d.etapa,
          orcamentoEsgotado: true,
        }),
        motivo: MOTIVO_ESTOQUE_AMAZON.orcamentoEsgotado,
        falhas: 'somar',
      };
    }
    // T6's (the produtos, the link partitions): a window too slow to map.
    return reconciliacao({ ...lidos, prazo: d.etapa });
  }

  // T7: the batch's form, from its distinct SKUs as the tick sees them.
  const n = d.observacoes.length;
  const comSkus = { ...lidos, skus: n };
  switch (destinoDoLoteDelta(n)) {
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.nada:
      return {
        ...semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.janelaVazia, comSkus),
        cursorAteMs: ateMs,
        falhas: 'zerar',
      };
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.reconciliacao:
      return reconciliacao(comSkus);
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches:
      return enfileirarObservacoes(contaId, d.observacoes, ateMs, prazoMs, deps, comSkus);
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed:
      break;
  }

  // 31–3,000: the delta feed, in the form the stock valve gives a batch. Under
  // a canary LIST, only the canary's SKUs, as patch tasks per observation.
  if (decidirLote(c.valvula).modo === 'so-patches-do-canario') {
    const noCanario = d.observacoes.filter(
      (o) => decidirAlvo(c.valvula, contaId, o.sku).modo === MODO_AMAZON.on,
    );
    return enfileirarObservacoes(contaId, noCanario, ateMs, prazoMs, deps, {
      ...comSkus,
      foraDoCanario: n - noCanario.length,
    });
  }
  return repassar(
    {
      repasse: REPASSE_TICK_ESTOQUE_AMAZON.feedNecessario,
      motivo: MOTIVO_ESTOQUE_AMAZON.emFeed,
      desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
      cursorAteMs: ateMs,
      reiniciar: false,
      falhas: 'zerar',
    },
    () => enfileirarFeedDoTick(contaId, depositoId, janela, deps),
    comSkus,
  );
}

/* -------------------------------------------------------------------------- */
/*                   T4b: the reconcile run and the feed lease                  */
/* -------------------------------------------------------------------------- */

/** What T4b did. */
interface Manutencao {
  readonly retomada: ResultadoRetomadaReconciliacaoEstoqueAmazon;
  readonly inicioRecuperado: boolean;
  /** A contained enqueue failure's class: the conta's run ends here (T8 still runs). */
  readonly erro: string | null;
  /**
   * The maintenance documents that no longer parse, each as `<class>:<fields>`
   * (field NAMES only), joined with `;`: their step skipped.
   */
  readonly invalidos: string | null;
}

/**
 * T4b (module header): ONE `getAll` of the reconcile run and the stock feed
 * lease; the re-kick of a run that lost its next task; the stranded start's
 * `vez` recovery, then its clearing. A run or a lease that no longer parses
 * costs ONLY its own step (named in `invalidos`, the line at WARNING): the
 * delta path (T5–T8) still runs. A lease write that kept losing its
 * precondition propagates (contained per conta); a named producer failure is
 * answered in `erro`.
 */
async function manterReconciliacaoEVez(
  contaId: string,
  deps: DepsTickEstoqueAmazon,
): Promise<Manutencao> {
  const alvo: AlvoVezFeed = { fluxo: FLUXO_AMAZON.estoque, contaId };
  const [snapRun, snapVez] = await deps.db.getAll(
    refReconciliacaoEstoqueAmazon(deps.db, contaId),
    refVezFeed(deps.db, alvo),
  );
  if (snapRun === undefined || snapVez === undefined) {
    throw new TypeError('sincronizacaoEstoque.ts: o getAll não respondeu os dois documentos');
  }
  const invalidos: string[] = [];
  let run: ReconciliacaoEstoqueAmazon | null = null;
  try {
    run = lerReconciliacaoDoSnapshot(snapRun, contaId).estado;
  } catch (err) {
    if (!(err instanceof ReconciliacaoEstoqueDocumentoInvalidoError)) throw err;
    invalidos.push(`${err.name}:${err.campos.join(',')}`);
  }
  let vez: VezFeedAmazon | null = null;
  let vezLegivel = true;
  try {
    ({ vez } = lerVezFeedDoSnapshot(snapVez, alvo));
  } catch (err) {
    if (!(err instanceof AmazonVezFeedInvalidaError)) throw err;
    vezLegivel = false;
    invalidos.push(`${err.name}:${err.campos.join(',')}`);
  }
  const lidos = invalidos.length === 0 ? null : invalidos.join(';');
  let retomada: ResultadoRetomadaReconciliacaoEstoqueAmazon = null;
  let inicioRecuperado = false;
  try {
    retomada = await retomarReconciliacaoEstoqueAmazon(contaId, run, deps);
    // The stranded start, decided by the lease's own rule on THIS read; the
    // lease I/O then re-reads and re-decides before it writes anything.
    const montandoVencida = { tipo: CONSUMO_DO_PENDENTE.montandoVencida } as const;
    if (
      vezLegivel &&
      consumirPendenteVez(vez, montandoVencida, deps.agora()).tipo === 'atualizar'
    ) {
      const consumo = await consumirPendenteVezFeed(deps.db, alvo, montandoVencida, {
        agora: deps.agora,
        enfileirarVez: async (recuperacao) => {
          await deps.agendador().enfileirarLote(recuperacao.tarefa, { nome: recuperacao.nome });
        },
      });
      inicioRecuperado = consumo.tipo === 'escrito';
    }
  } catch (err) {
    const classe = falhaDeEnfileiramentoContida(err);
    if (classe === null) throw err;
    return { retomada, inicioRecuperado, erro: classe, invalidos: lidos };
  }
  return { retomada, inicioRecuperado, erro: null, invalidos: lidos };
}

/* -------------------------------------------------------------------------- */
/*                               One conta's run                               */
/* -------------------------------------------------------------------------- */

/**
 * One conta's run, T3–T9 (module header). A Firestore status error, a
 * document that no longer parses and a write that kept losing its
 * precondition propagate: the tick contains them per conta.
 */
async function executarConta(
  contaId: string,
  inicioDoTickMs: number,
  prazoMs: number,
  valvula: ValvulaAmazon<typeof FLUXO_AMAZON.estoque>,
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

  // T4b: the reconcile run and the stock feed lease.
  const manutencao = await manterReconciliacaoEVez(contaId, deps);

  const depositoDoCursor =
    depositoId === null ? null : formasRefDepositoEstoqueAmazon(depositoId)[0];
  let conclusao: Conclusao;
  if (manutencao.erro !== null) {
    // A queue that refused T4b's enqueue: no window read this tick.
    conclusao = enfileiramentoFalhou(manutencao.erro, null, null, {});
  } else if (depositoId === null) {
    conclusao = {
      ...semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.semDeposito),
      motivo: MOTIVO_ESTOQUE_AMAZON.contaSemDeposito,
    };
  } else if (estado.cursorMs === null) {
    conclusao = {
      ...semCursor(DESFECHO_TICK_ESTOQUE_AMAZON.primeiroTick),
      cursorAteMs: deps.agora(),
      falhas: 'zerar',
    };
  } else if (depositoIdDaContaEstoqueAmazon(estado.depositoDoCursor) !== depositoId) {
    // No window from a cursor taken at another depósito (module header, T4): a
    // reconcile at the new one, then the cursor RESET there (taken BEFORE the request).
    const agoraMs = deps.agora();
    conclusao = await repassar(
      {
        repasse: REPASSE_TICK_ESTOQUE_AMAZON.reconciliacaoNecessaria,
        motivo: MOTIVO_ESTOQUE_AMAZON.depositoMudou,
        desfecho: DESFECHO_TICK_ESTOQUE_AMAZON.repassado,
        cursorAteMs: agoraMs,
        reiniciar: true,
        falhas: 'zerar',
      },
      () => pedirReconciliacao(contaId, deps),
      {},
    );
  } else {
    conclusao = await lerEEnfileirar(
      { contaId, depositoId, cursorMs: estado.cursorMs, prazoMs, valvula },
      deps,
    );
  }

  // T8: the aviso FIRST — the flag it is gated on is stored after it. On a
  // transition, and after taking over a lease no run released: that run may
  // have landed its aviso and lost the flag, which no later transition would
  // ever correct.
  const semDeposito = depositoId === null;
  const retomadaDaVez = lido.estado.vez !== null;
  let aviso: ResultadoContaTickEstoqueAmazon['aviso'] = null;
  if (semDeposito !== estado.semDeposito || retomadaDaVez) {
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
    reiniciar: conclusao.reiniciar,
    depositoDoCursor,
    semDeposito,
    falhas: conclusao.falhas,
    agoraMs: deps.agora(),
  });
  const comum = {
    ...conclusao.extra,
    motivo: conclusao.motivo,
    repasse: conclusao.repasse,
    entrega: conclusao.entrega,
    retomada: manutencao.retomada,
    inicioRecuperado: manutencao.inicioRecuperado,
    manutencaoInvalida: manutencao.invalidos,
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
  valvula: ValvulaAmazon<typeof FLUXO_AMAZON.estoque>,
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
    return await executarConta(contaId, inicioDoTickMs, prazoMs, valvula, deps);
  } catch (err) {
    if (err instanceof SincronizacaoEstoqueDocumentoInvalidoError) {
      return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.documentoInvalido, {
        erro: err.name,
        campos: err.campos.join(','),
      });
    }
    if (
      err instanceof ReconciliacaoEstoqueDocumentoInvalidoError ||
      err instanceof AmazonVezFeedInvalidaError
    ) {
      return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.documentoInvalido, {
        erro: err.name,
        campos: err.campos.join(','),
      });
    }
    if (
      err instanceof ReconciliacaoEstoqueEmConflitoError ||
      err instanceof AmazonVezFeedEmConflitoError
    ) {
      return resultado(contaId, DESFECHO_TICK_ESTOQUE_AMAZON.conflito, { erro: err.name });
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
    const r = await contaNoTick(conta, inicioDoTickMs, valvula, deps);
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
