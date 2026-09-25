/**
 * "Atualizar preços" — the Shopee ACCOUNT-WIDE price job (#1521, step 13, the
 * second PR). A `running` job document (`enviosPrecoShopee`) is the single
 * checkpoint of a Cloud Tasks-driven loop that pages through every anchor
 * produto of one conta, plans its listings, and sends each one's tabela price
 * through the SAME per-item sender the manual push uses — re-enqueuing itself
 * until the walk is exhausted and the queue drained. The start route creates the
 * job and enqueues the first dispatch; `processShopeePriceSync` (the functions
 * codebase) runs {@link processarEnvioPrecoShopee} once per dispatch.
 *
 * Ported in shape from Mercado Livre's `precoSync.ts` and step 9's
 * `produtos/importacaoMassa.ts` (EVIDENCE, never imported). Every place it
 * differs is a decision of the step's reconcile, named below.
 *
 * ## One dispatch
 *
 * 1. Read the job; anything but `running` answers `'noop'`.
 * 2. Load the conta context — Firestore and the environment only: a conta of
 *    the wrong `tipo` fails the job on the FIRST attempt, before any Shopee call.
 * 3. PLAN one page, only while `fila` is empty and the walk is not done: the
 *    anchors come from the CLASSIC keyset query of `lerPaginaDeFamiliasDePreco`,
 *    each family goes through the pure planner, the listings join `fila` as
 *    IDENTITIES and the planner's skips become report rows. The plan checkpoint
 *    is GUARDED (see "a cancel" below).
 * 4. DRAIN at most {@link itensPorDespachoPreco} listings, only while `fila`
 *    holds any. A job PARKED until a later instant re-enqueues itself for the
 *    rest of the wait and stops there. Then the status is re-read, and the rest
 *    is lazy: the stock sync's quota pause is READ first (never written), then
 *    the conta verdict — the only place a Shopee client is built and the shop
 *    read spent — then ONE batched base reader for the whole lote. Per listing:
 *    re-read the status, read its `precos` NOW, price it, send it, checkpoint.
 * 5. Continue (re-enqueue) or finish (the `completed` flip, through the ONE
 *    transaction).
 *
 * ## ⚠️ A cancel stops the lote after the listing in flight
 *
 * The job's `status` is re-read — ONE masked read of that one field — after the
 * plan checkpoint (before the drain), before EACH listing of the lote, before a
 * pause or a park is stamped, and before the continuation is enqueued. Anything
 * but `running` answers `'noop'`: the listing being sent when the cancel landed
 * finishes (its checkpoint writes no `status`, so it records the row without
 * burying the stamp), and nothing after it is sent. The rest stays in `fila`,
 * counted by `filaRestante`; the `job-cancelado` row is the cancel's own.
 *
 * The PLAN checkpoint goes further, because nothing was sent before it: it
 * writes with the job read's `updateTime` as a precondition (root `CLAUDE.md`
 * rule 7, tier 1). Any write since that read — a terminal stamp, or another
 * delivery of this same task — fails it whole, the page and its skip rows
 * included, and the dispatch answers `'noop'`; a cancelled job never receives a
 * freshly planned `fila`.
 *
 * ## ⚠️ The price is read at DRAIN time, never at plan time (reconcile C-d)
 *
 * Mercado Livre freezes the price into its queue at plan time. This job may PARK
 * a planned page across a daily-quota rollover (up to a day), and a frozen price
 * would then send a day-old tabela value. So `fila` holds identities only, and
 * each drained listing's `precos` are read through `lerPrecosDosProdutos` — the
 * manual push's own send-time read, over exactly `produtosQuePrecificam` — the
 * moment before `precificarItem` and the sender run.
 *
 * ## ⚠️ The checkpoint is PER ITEM, and it is ONE batch (reconcile C-p)
 *
 * After every drained listing the job patch (the consumed `fila`, the counters,
 * the samples, the cursor) and that listing's report rows commit in ONE
 * `db.batch()`. Written apart there are two windows and both lose: row-then-
 * consume duplicates the listing on a retry, consume-then-row drops its rows.
 * Per item rather than per dispatch, because a crash then replays AT MOST ONE
 * landed send — and the sender's skip-if-equal turns that replay into
 * `pulado preco-igual` (contract S4), so the price is right and the report
 * under-reports by one row set per crash (register 147).
 *
 * The batch is not a transaction, deliberately, and it writes no `status`, so it
 * cannot clobber a terminal stamp. Its two report counters are TIER 0 (root
 * `CLAUDE.md` rule 7): `relatorioLinhas` is `FieldValue.increment(<rows this
 * checkpoint adds>)` and `relatorioShards` is `FieldValue.maximum(<shards they
 * reach>)`, never an absolute value computed from this dispatch's copy. A
 * terminal stamp that lands while a listing is in flight writes its synthetic
 * row and its own `+1` in the transaction; the in-flight listing's checkpoint
 * then ADDS its rows instead of writing back a count that predates that row. The
 * shard a row lands in still derives from the dispatch's local cursor (a retry
 * recomputes the same one); after such a race it can trail the stored count by
 * the one synthetic row, so a shard may hold one row past
 * {@link RELATORIO_ENVIO_PRECO_SHARD_SIZE} — never a row outside the declared
 * shard count, since `maximum` only ever raises it. `updatedAt` is
 * `FieldValue.maximum(nowMs)` for the same race: the in-flight listing's
 * checkpoint carries a clock older than the cancel's, and must not move the
 * stamp behind `finishedAt`.
 *
 * ## ⚠️ The report row SET is a function of the queue entry, never of the outcome
 *
 * One row per planned MODEL (a no-model listing: one row), keyed by the shared
 * `relatorioEnvioPrecoRowKey` — identity only. A listing skipped whole still
 * writes one row per model, so a replay overwrites the SAME keys instead of
 * leaving two truths for one listing. The sender guarantees one line per alvo
 * (contract S1) and the surface checks it again before anything is written.
 *
 * ## Pauses: READ the stock pause, never write it (reconcile C-l)
 *
 * The per-APPLICATION rate limit is one limiter for both syncs, so a stock
 * quota pause is honoured here — and only the two QUOTA motives (a holiday or a
 * blocked shop is a stock refusal, not a price pause). A BURST (ours or the
 * stock sync's) checkpoints WITHOUT consuming the head and re-enqueues itself
 * with a delay — `Retry-After`, else the stock sync's own `ratePauseMin()` — so
 * no Cloud Tasks attempt is spent; past {@link ENVIO_PRECO_MAX_PAUSAS} the job
 * fails. The DAILY quota PARKS the job until the next 00:00 (UTC+8): `retomarEm`
 * is stamped, `status` stays `running`, and past {@link ENVIO_PRECO_MAX_PARQUES}
 * parks the job fails. The resumed dispatch clears `retomarEm` in its first
 * checkpoint, and every terminal stamp clears it too. A dispatch delivered
 * BEFORE `retomarEm` — a Cloud Tasks duplicate, or the queue's retry of a park
 * whose enqueue threw after its checkpoint — re-enqueues itself for the rest of
 * the wait and answers `'pausado'`: no park spent, no verdict, no send, no
 * write.
 *
 * ## ⚠️ The start race is ACCEPTED, by decision (reconcile C-q)
 *
 * {@link iniciarEnvioPrecoShopee}'s one-active guard is a query and then a
 * write, NOT a transaction — two concurrent starts both pass and produce two
 * `running` jobs for one conta. Named reason: (1) the loser's outcome is a
 * DUPLICATE job sending the SAME tabela values — prices are read at drain time
 * — never a wrong price; (2) the queue runs one dispatch at a time
 * (`maxConcurrentDispatches: 1`) and the second job's skip-if-equal turns the
 * first's landed writes into `preco-igual`, so the cost is duplicate spend
 * bounded by one catalogue pass; (3) closing it transactionally would rest on
 * query-range locking inside a server transaction, UNVERIFIED on Enterprise — a
 * guard of unknown strength. A unit test PINS the race (two interleaved starts
 * ⇒ two documents), so closing it later is a deliberate edit and not a drift.
 *
 * ## ⚠️ The ONE transaction (class B)
 *
 * {@link finalizarEnvioPrecoShopee} is the sole writer of a terminal `status`,
 * and the only place in `precos/` that runs a transaction. `status` has SIX
 * writers that do not coordinate — the orphan reclaim in the start, the
 * dispatch's terminal failure, the `completed` flip, the final-attempt stamp,
 * the start route's enqueue-failure fallback and the operator's cancel — and all
 * six funnel through it. The guard re-derives `status` (still `running`?) and,
 * on the cancel, `integracaoId` from the `tx.get` snapshot, and derives the
 * synthetic row's shard index and `filaRestante` INSIDE the callback, so an OCC
 * retry recomputes them rather than re-applying a captured count. It also
 * clears `retomarEm`: a stopped job is parked on nothing. Inventoried in
 * `packages/config-eslint/rules/firestore-transaction-inventory.test.js`.
 *
 * ## ⚠️ A stamped `erro` never carries provider text
 *
 * A failure the dispatch stamps names its CAUSE, never Shopee's prose: a
 * verdict refusal or a conta-wide fatal stamps the motivo and its pt-BR
 * sentence; an exception stamps a sentence naming its CLASS, plus Shopee's own
 * `error` CODE (a token, verbatim) for the `ShopeeApiError` family or the gRPC
 * status for a Firestore/Tasks failure. The message goes to the log. The one
 * exception is the closed set of this app's OWN conta classes, whose message the
 * app composes from its own ids and field paths — see `erroDaFalha`.
 *
 * ## ⚠️ Clocks and units
 *
 * No clock is read in this module: the instant is `deps.nowMs` / `args.nowMs`,
 * the functions entry's (or the route's) ONE read, reused for every stamp of the
 * dispatch. Every stamp is MILLISECONDS; the TTL stamps are `Date`s derived from
 * `startedAt` (never from a clock), so a replayed shard write re-stamps the SAME
 * instant.
 */
import {
  FieldValue,
  type DocumentData,
  type Firestore,
  type Timestamp,
} from 'firebase-admin/firestore';
import { z } from 'zod';
import {
  SHOPEE_ERROR_KIND,
  ShopeeApiError,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
} from '@delfrance/integrations-shopee';
import {
  ENVIO_PRECO_FASE,
  ENVIO_PRECO_RESULTADO,
  ENVIO_PRECO_SHOPEE_STATUS,
  RELATORIO_ENVIO_PRECO_ERRO_MAX,
  RELATORIO_ENVIO_PRECO_SHARD_SIZE,
  RETENCAO_ENVIO_PRECO_SHOPEE_DIAS,
  expiraEmApos,
  relatorioEnvioPrecoRowKey,
  relatorioEnvioPrecoShardId,
  type EnvioPrecoFailure,
  type EnvioPrecoShopee,
  type EnvioPrecoShopeeStatus,
  type EnvioPrecoSkip,
  type LinhaRelatorioEnvioPreco,
} from '@delfrance/schemas';
import {
  envioPrecoShopeeCollection,
  relatorioEnvioPrecoShopeeCollection,
} from '@delfrance/data/admin/collections';
import { isFailedPrecondition } from '@delfrance/data/admin/grpcErrors';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import { isGrpcCodedError } from '../core/containment';
import { ShopeeCredencialInvalidaError } from '../core/credentialStore';
import {
  ShopeeContaNotConfiguredError,
  loadShopeeContext,
  type ShopeeContext,
} from '../core/shopee';
import { ShopeeContaSemShopIdError, ShopeeSemCredencialError } from '../core/tokenStore';
import { MOTIVOS_DE_PAUSA, ratePauseMin } from '../estoque/constantesEstoque';
import { lerEstadoEstoque } from '../estoque/estadoEstoque';
import { shopeeTasksDesabilitado } from '../shopeeTasks';
import {
  AMOSTRA_FALHAS_CAP,
  AMOSTRA_PULOS_CAP,
  ENVIO_PRECO_MAX_PARQUES,
  ENVIO_PRECO_MAX_PAUSAS,
  ENVIO_PRECO_MAX_TENTATIVAS,
  ENVIO_PRECO_ORFAO_MS,
  PARQUE_JITTER_MAX_S,
  itensPorDespachoPreco,
  pageLimitPreco,
} from './constantesPreco';
import { lerPaginaDeFamiliasDePreco, lerPrecosDosProdutos } from './descobertaPreco';
import {
  conferirCompletudeDoItemDePreco,
  enviarPrecoDoItem,
  type ResultadoEnvioPreco,
} from './enviarPreco';
import {
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoEmAndamentoError,
  ShopeePriceSyncTasksDisabledError,
  mensagemDoMotivoDePreco,
} from './errosPreco';
import { criarLeitorDeBaseEmLote } from './leitorDeBase';
import {
  montarItensDePreco,
  precificarItem,
  produtosQuePrecificam,
  type ItemDePreco,
  type ItemPlanejadoPreco,
  type PuloDePlano,
} from './planoPreco';
import {
  avaliarContaParaPreco,
  pausaDeCotaParaPreco,
  type ContextoContaPreco,
  type VereditoContaPreco,
} from './regiaoPreco';

/* -------------------------------------------------------------------------- */
/*                                 the seam                                    */
/* -------------------------------------------------------------------------- */

/** The one log tag of this module. */
const TAG_LOG = '[shopee/precos] atualizar-precos';

/** Seconds to milliseconds, and minutes to seconds — the pause arithmetic's units. */
const MS_POR_SEGUNDO = 1_000;
const SEGUNDOS_POR_MINUTO = 60;

/**
 * How long past its `retomarEm` a PARKED job may stay silent before the orphan
 * reclaim may take it: one hour, written as a product of named units. A parked
 * dispatch resumes at the rollover plus a jitter of seconds; an hour of silence
 * after that means the resume never happened.
 */
const TOLERANCIA_DO_PARQUE_MS = 60 * SEGUNDOS_POR_MINUTO * MS_POR_SEGUNDO;

/**
 * The Cloud Tasks body: `{ jobId, integracaoId }` and nothing else.
 *
 * ⚠️ `.strict()`, unlike step 9's passthrough: this queue has exactly one
 * producer shape (the start route and the job itself), and a payload carrying
 * anything more is a producer this module does not know — refused rather than
 * silently accepted with a field nothing reads.
 */
export const envioPrecoShopeeTaskSchema = z
  .object({ jobId: z.string().min(1), integracaoId: z.string().min(1) })
  .strict();
export type EnvioPrecoShopeeTaskPayload = z.infer<typeof envioPrecoShopeeTaskSchema>;

/** What a caller may ask of ONE enqueue beyond the payload itself. */
export interface OpcoesDeEnfileiramentoPreco {
  /**
   * A delay, in SECONDS. Omitted (never `undefined`) when not asked — kept
   * omitted so the call site does not rely on the SDK treating `undefined` as
   * absent.
   */
  readonly scheduleDelaySeconds?: number;
}

/**
 * The enqueue seam. The start route and the dispatch depend on this interface;
 * `createShopeePriceSyncScheduler()` (`./shopeePriceSyncTasks`) is the real one
 * and a test hands in a recorder. Declared HERE so the scheduler depends on the
 * job's types and the job never depends on the scheduler.
 */
export interface AgendadorPrecoShopee {
  enqueue(payload: EnvioPrecoShopeeTaskPayload, opts?: OpcoesDeEnfileiramentoPreco): Promise<void>;
}

/** What one dispatch did. */
export type DespachoEnvioPreco =
  /**
   * The job is gone or no longer `running` — a cancel, a terminal stamp — or
   * the stamp lost a race, or the plan checkpoint's precondition failed.
   */
  | 'noop'
  /** More to plan or to send (or a burst pause): the job re-enqueued itself. */
  | 'continued'
  /**
   * PARKED on Shopee's daily quota: re-enqueued for the next 00:00 (UTC+8) —
   * or, delivered before its `retomarEm`, for the rest of the wait.
   */
  | 'pausado'
  /** The `completed` flip landed. */
  | 'done'
  /** The job was stamped `failed`. */
  | 'failed';

/** Everything one dispatch needs; every optional member is a test seam with a production default. */
export interface DepsDespachoPreco {
  readonly db: Firestore;
  /** The price queue — used to continue, to pause and to park. */
  readonly scheduler: AgendadorPrecoShopee;
  /**
   * MILLISECONDS — the dispatch's ONE clock read, taken by the functions entry
   * and reused for every stamp. This module reads no clock.
   */
  readonly nowMs: number;
  /**
   * Jitter, in SECONDS, for a park's re-enqueue (`maxS` =
   * {@link PARQUE_JITTER_MAX_S}). Default: a deterministic `0`. The randomness
   * belongs to the functions entry, so the delay this module computes is
   * testable (the stock sender's `jitterSec` precedent).
   */
  readonly jitterSec?: (maxS: number) => number;
  /**
   * The conta context — Firestore and the environment only, NO Shopee call and
   * NO token. Read on every dispatch, so a conta that stopped being a Shopee one
   * fails the job before anything is planned. Default: `loadShopeeContext`.
   */
  readonly resolverContexto?: (db: Firestore, integracaoId: string) => Promise<ShopeeContext>;
  /**
   * The conta verdict — the ONLY place a client is built and the shop read
   * spent, so it runs on a DRAIN only. Default: `avaliarContaParaPreco` over the
   * context's `shop_id`, tabela, client and config.
   */
  readonly avaliarConta?: (
    db: Firestore,
    contexto: ShopeeContext,
    nowMs: number,
  ) => Promise<VereditoContaPreco>;
  /** The plan's page reader. Default: `lerPaginaDeFamiliasDePreco`. */
  readonly lerPagina?: typeof lerPaginaDeFamiliasDePreco;
  /** The DRAIN-time `precos` read. Default: `lerPrecosDosProdutos`. */
  readonly lerPrecos?: typeof lerPrecosDosProdutos;
  /** The per-dispatch batched base reader's factory. Default: `criarLeitorDeBaseEmLote`. */
  readonly criarLeitorDeBase?: typeof criarLeitorDeBaseEmLote;
  /** The per-item sender. Default: `enviarPrecoDoItem`. */
  readonly enviar?: typeof enviarPrecoDoItem;
}

/* -------------------------------------------------------------------------- */
/*                                 the TTL                                     */
/* -------------------------------------------------------------------------- */

/**
 * How long a run's report shards outlive the run, in days. Not what keeps a
 * truncated report off the history list — the TTL deletes the run and its
 * shards independently and in no guaranteed order, which is why the history
 * route hides a run once its own `expiraEm` passes. The margin only covers a
 * download started from a list loaded just before that instant; an unreachable
 * shard costs next to nothing, so it is generous (Mercado Livre's value).
 */
export const MARGEM_RELATORIO_ENVIO_PRECO_SHOPEE_DIAS = 7;

/**
 * The run's TTL instant: {@link RETENCAO_ENVIO_PRECO_SHOPEE_DIAS} after it
 * STARTED. Keyed on `startedAt`, never on a clock read, so every writer of the
 * same run derives the same instant. A real `Date` — the policy ignores a
 * numeric epoch, and the schema refuses one.
 */
export function expiraEmDoEnvioShopee(startedAtMs: number): Date {
  return expiraEmApos(startedAtMs, RETENCAO_ENVIO_PRECO_SHOPEE_DIAS);
}

/**
 * A report shard's TTL instant: {@link MARGEM_RELATORIO_ENVIO_PRECO_SHOPEE_DIAS}
 * after the run's. Keyed on `startedAt` like the run's, so a shard re-written by
 * a replayed dispatch — hours or a day later — carries the SAME instant.
 */
export function expiraEmDoRelatorioShopee(startedAtMs: number): Date {
  return expiraEmApos(
    startedAtMs,
    RETENCAO_ENVIO_PRECO_SHOPEE_DIAS + MARGEM_RELATORIO_ENVIO_PRECO_SHOPEE_DIAS,
  );
}

/* -------------------------------------------------------------------------- */
/*                                 small readers                               */
/* -------------------------------------------------------------------------- */

/** The job as the dispatch read it, and the write stamp of that read. */
interface JobLido {
  readonly job: EnvioPrecoShopee;
  /**
   * The snapshot's `updateTime` — the precondition of the plan checkpoint, the
   * one write derived from this read with nothing sent before it. A real
   * snapshot of an existing document always carries one.
   */
  readonly updateTime: Timestamp | undefined;
}

async function lerJob(db: Firestore, jobId: string): Promise<JobLido | null> {
  const snap = await envioPrecoShopeeCollection.docRef(db, {}, jobId).get();
  if (!snap.exists) return null;
  return {
    job: envioPrecoShopeeCollection.parseRead(
      snap.data(),
      envioPrecoShopeeCollection.docPath({}, jobId),
    ),
    updateTime: snap.updateTime,
  };
}

/** The one field the status re-read asks for. */
const CAMPOS_DO_STATUS = ['status'] as const;

/**
 * Is the job STILL `running`? ONE masked read — `status` and nothing else, so a
 * job document carrying a full `fila` and both samples costs a few bytes to
 * ask. A missing document answers `false`.
 */
async function aindaRodando(db: Firestore, jobId: string): Promise<boolean> {
  const [snap] = await db.getAll(envioPrecoShopeeCollection.docRef(db, {}, jobId), {
    fieldMask: [...CAMPOS_DO_STATUS],
  });
  if (snap === undefined || !snap.exists) return false;
  const status: unknown = snap.get('status');
  return status === ENVIO_PRECO_SHOPEE_STATUS.running;
}

/** A stored field that is a finite number, else `null` — a junk stamp proves nothing. */
function numeroOuNull(bruto: unknown): number | null {
  return typeof bruto === 'number' && Number.isFinite(bruto) ? bruto : null;
}

/**
 * Is this `running` job an ORPHAN the start may reclaim? Pure and exported, so
 * each clause is pinned on its own.
 *
 * - Its `updatedAt` is older than {@link ENVIO_PRECO_ORFAO_MS} — or missing or
 *   junk: a stamp that cannot prove liveness must not brick the button;
 * - AND it is not PARKED: `retomarEm` absent, or more than an hour in the past
 *   (the resume that should have happened did not). A parked job's `updatedAt`
 *   legitimately stops moving for up to a day, and reclaiming it would start a
 *   second run beside a live one.
 */
export function ehJobOrfao(
  job: { readonly updatedAt: unknown; readonly retomarEm: unknown },
  nowMs: number,
): boolean {
  const updatedAt = numeroOuNull(job.updatedAt);
  const parado = updatedAt === null || updatedAt < nowMs - ENVIO_PRECO_ORFAO_MS;
  if (!parado) return false;
  const retomarEm = numeroOuNull(job.retomarEm);
  return retomarEm === null || retomarEm < nowMs - TOLERANCIA_DO_PARQUE_MS;
}

/** A text, cut to what a report row may carry. */
function cortarErro(erro: string | null): string | null {
  return erro === null ? null : erro.slice(0, RELATORIO_ENVIO_PRECO_ERRO_MAX);
}

/**
 * The ONE synthetic row a terminal stamp writes to say the rest was never
 * attempted. Its `motivo` names the kind of stop; the COUNT rides the job's
 * `filaRestante`, so this row never multiplies with the queue length.
 */
function linhaTerminal(
  integracaoId: string,
  motivo: 'job-interrompido' | 'job-cancelado',
  erro: string | null,
): LinhaRelatorioEnvioPreco {
  return {
    produtoId: integracaoId,
    variacaoProdutoId: null,
    anuncioId: null,
    linkDocId: null,
    resultado: ENVIO_PRECO_RESULTADO.naoTentado,
    fase: ENVIO_PRECO_FASE.envio,
    motivo,
    erro: cortarErro(erro),
    preco: null,
    precoAnterior: null,
    variacoes: null,
  };
}

/* -------------------------------------------------------------------------- */
/*                         start · finalize · cancel                           */
/* -------------------------------------------------------------------------- */

/** What the start needs. */
export interface ArgsInicioEnvioPreco {
  /**
   * The conta that PASSED `avaliarContaParaPreco` — branded, so only a verdict
   * can produce it. It IS the "conta verdict first" rule: a refused conta has no
   * context to hand in, so a refusal can never create a job. The job's
   * `integracaoId` is this context's.
   */
  readonly contexto: ContextoContaPreco;
  /** `true` ⇒ the decrease guard is OFF for the whole run (default OFF at the route). */
  readonly baixarPreco: boolean;
  /** The authed uid that started the run, or `null`. */
  readonly startedBy: string | null;
  /** MILLISECONDS — the route's ONE clock read; `startedAt`, `updatedAt` and the TTL derive from it. */
  readonly nowMs: number;
}

/**
 * Create a fresh price job for the context's conta and answer its id.
 *
 * Order: the Tasks valve (a closed one refuses BEFORE any read or write — no
 * document is left behind); the one-active guard (a live `running` job ⇒
 * {@link ShopeeEnvioPrecoEmAndamentoError}; an ORPHAN is stamped `failed` with
 * one `job-interrompido` row, through the transaction, and the start
 * proceeds); then the new document, with `expiraEm` =
 * {@link expiraEmDoEnvioShopee}`(nowMs)`.
 *
 * ⚠️ **It does not enqueue.** The route does, AFTER this resolves, so an enqueue
 * failure has a document to stamp `failed` instead of a 503 and nothing to look
 * at. ⚠️ The guard is NOT transactional — see "the start race" in the module
 * docblock; a test pins it.
 *
 * @throws ShopeePriceSyncTasksDisabledError when `SHOPEE_TASKS_DISABLED` is `'1'`.
 * @throws ShopeeEnvioPrecoEmAndamentoError when a live run exists for the conta.
 */
export async function iniciarEnvioPrecoShopee(
  db: Firestore,
  args: ArgsInicioEnvioPreco,
): Promise<string> {
  if (shopeeTasksDesabilitado()) throw new ShopeePriceSyncTasksDisabledError();

  const integracaoId = args.contexto.integracaoId;
  const emAndamento = await envioPrecoShopeeCollection
    .ref(db, {})
    .where('integracaoId', '==', integracaoId)
    .where('status', '==', ENVIO_PRECO_SHOPEE_STATUS.running)
    .limit(1)
    .get();
  const existente = emAndamento.docs[0];
  if (existente !== undefined) {
    const dados = existente.data() as Record<string, unknown>;
    if (!ehJobOrfao({ updatedAt: dados['updatedAt'], retomarEm: dados['retomarEm'] }, args.nowMs)) {
      throw new ShopeeEnvioPrecoEmAndamentoError(
        `já existe um envio de preços em andamento para a integração ${integracaoId}`,
      );
    }
    // The orphan is reclaimed THROUGH the transaction, like every terminal
    // stamp: an operator cancelling it between the query and this write wins
    // (`not-running`), and the start proceeds either way. A failure of the
    // stamp itself propagates — a start that could not reclaim does not start.
    await finalizarEnvioPrecoShopee(
      db,
      existente.id,
      {
        status: ENVIO_PRECO_SHOPEE_STATUS.failed,
        erro: 'job órfão — superado por um novo envio',
        relatorioCompleto: false,
        finishedAt: args.nowMs,
        updatedAt: args.nowMs,
      },
      { linhaTerminal: MOTIVO_PRECO_SHOPEE.jobInterrompido },
    );
  }

  const jobId = envioPrecoShopeeCollection.newDocId(db, {});
  await envioPrecoShopeeCollection.set(db, {}, jobId, {
    integracaoId,
    status: ENVIO_PRECO_SHOPEE_STATUS.running,
    baixarPreco: args.baixarPreco,
    startedBy: args.startedBy,
    startedAt: args.nowMs,
    updatedAt: args.nowMs,
    expiraEm: expiraEmDoEnvioShopee(args.nowMs),
  });
  return jobId;
}

/** What a terminal stamp actually did. */
export type ResultadoFinalizacaoPreco =
  | 'stamped'
  | 'not-running'
  | 'not-found'
  | 'wrong-integracao';

/**
 * The fields a terminal stamp may write. `status` is terminal by construction.
 * A type ALIAS, not an interface: only an alias is assignable to the
 * `Record<string, unknown>` the handle's `parseMerge` takes.
 *
 * ⚠️ `filaRestante`, `relatorioLinhas` and `relatorioShards` are deliberately
 * absent: each derives from the job as it stands, so they are computed INSIDE
 * the transaction from its own snapshot — never passed in.
 */
export type EnvioPrecoShopeeTerminalPatch = {
  status: Exclude<EnvioPrecoShopeeStatus, 'running'>;
  erro?: string | null;
  finishedAt: number;
  updatedAt: number;
  relatorioCompleto?: boolean;
};

/** The two opt-ins of {@link finalizarEnvioPrecoShopee}. */
export interface OpcoesFinalizacaoPreco {
  /** The ownership check of the cancel route: only a job of the named conta. */
  readonly expectIntegracaoId?: string;
  /**
   * Write ONE synthetic `nao-tentado` row with this motivo, plus `filaRestante`
   * — both derived from the transaction's own snapshot.
   */
  readonly linhaTerminal?: 'job-interrompido' | 'job-cancelado';
}

/**
 * Stamp a terminal state **only while the job is still `running`** — the ONE
 * writer of a terminal `status` (see the module docblock for its six callers).
 *
 * Class **B**: the decision to finalize is made OUTSIDE the callback (the walk
 * ran out; the operator clicked cancel; an attempt failed), so the guard is
 * explicit — `status` and the opt-in `integracaoId` are re-derived from the
 * `tx.get` snapshot, and the write happens only on that fresh read. With a
 * `linhaTerminal`, `filaRestante` and the synthetic row's shard (the one the
 * PERSISTED `relatorioLinhas` selects, exactly as a checkpoint assigns one) are
 * derived from the same snapshot, so an OCC retry recomputes them against the
 * winner. The row's shard carries `expiraEm` from the run's `startedAt`.
 *
 * Every stamp also writes `retomarEm: null`, inside the transaction: a stopped
 * job resumes nowhere, and a parked one cancelled mid-wait must not read as
 * "cancelled, resumes at X" to the status and history routes.
 *
 * ⚠️ The job write is `tx.update` — the document was just proved to exist.
 */
export async function finalizarEnvioPrecoShopee(
  db: Firestore,
  jobId: string,
  patch: EnvioPrecoShopeeTerminalPatch,
  opts: OpcoesFinalizacaoPreco = {},
): Promise<ResultadoFinalizacaoPreco> {
  const ref = envioPrecoShopeeCollection.docRef(db, {}, jobId);
  return db.runTransaction<ResultadoFinalizacaoPreco>(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return 'not-found';
    const job = envioPrecoShopeeCollection.parseRead(
      snap.data(),
      envioPrecoShopeeCollection.docPath({}, jobId),
    );
    if (opts.expectIntegracaoId !== undefined && job.integracaoId !== opts.expectIntegracaoId) {
      return 'wrong-integracao';
    }
    if (job.status !== ENVIO_PRECO_SHOPEE_STATUS.running) return 'not-running';

    const escrita: Record<string, unknown> = { ...patch, retomarEm: null };
    if (opts.linhaTerminal !== undefined) {
      const linha = linhaTerminal(job.integracaoId, opts.linhaTerminal, patch.erro ?? null);
      const indice = Math.floor(job.relatorioLinhas / RELATORIO_ENVIO_PRECO_SHARD_SIZE);
      const total = job.relatorioLinhas + 1;
      tx.set(
        relatorioEnvioPrecoShopeeCollection.docRef(
          db,
          { envioId: jobId },
          relatorioEnvioPrecoShardId(indice),
        ),
        relatorioEnvioPrecoShopeeCollection.parseMerge({
          linhas: { [relatorioEnvioPrecoRowKey(linha)]: linha },
          timestamp: patch.updatedAt,
          expiraEm: expiraEmDoRelatorioShopee(job.startedAt),
        }) as DocumentData,
        { merge: true },
      );
      escrita['filaRestante'] = job.fila.length;
      escrita['relatorioLinhas'] = total;
      escrita['relatorioShards'] = Math.floor((total - 1) / RELATORIO_ENVIO_PRECO_SHARD_SIZE) + 1;
    }
    tx.update(ref, envioPrecoShopeeCollection.parseMerge(escrita) as DocumentData);
    return 'stamped';
  });
}

/**
 * The operator's cancel. `404` for a missing job AND for a job of another conta
 * is the route's (`not-found` / `wrong-integracao`); `409` for one no longer
 * running (`not-running`).
 *
 * The in-flight listing finishes; nothing after it is sent. The dispatch re-reads
 * the status before each listing of its lote (and before the drain, a pause, a
 * park and a re-enqueue), so the listing being sent when the cancel lands
 * completes and checkpoints — its checkpoint writes no `status`, and it ADDS its
 * rows to the counter instead of overwriting the cancel's — and the next read
 * answers `'noop'`. A cancel landing while a page is being PLANNED fails the plan
 * checkpoint's precondition, so no fresh `fila` reaches the cancelled job. The
 * abandoned queue is recorded the way every stopping stamp records it:
 * `filaRestante` plus ONE `job-cancelado` row; `retomarEm` is cleared.
 */
export async function cancelarEnvioPrecoShopee(
  db: Firestore,
  args: { readonly jobId: string; readonly integracaoId: string; readonly nowMs: number },
): Promise<ResultadoFinalizacaoPreco> {
  return finalizarEnvioPrecoShopee(
    db,
    args.jobId,
    {
      status: ENVIO_PRECO_SHOPEE_STATUS.cancelled,
      // `erro` is for a failure. A cancel is not one.
      erro: null,
      relatorioCompleto: false,
      finishedAt: args.nowMs,
      updatedAt: args.nowMs,
    },
    { expectIntegracaoId: args.integracaoId, linhaTerminal: MOTIVO_PRECO_SHOPEE.jobCancelado },
  );
}

/* -------------------------------------------------------------------------- */
/*                              the error classes                              */
/* -------------------------------------------------------------------------- */

/**
 * The classes a retry cannot fix: each stamps the job `failed` on the FIRST
 * attempt instead of spending the queue's ladder to reach the same verdict. A
 * dead grant is not re-minted by waiting, a conta of the wrong `tipo` will not
 * become Shopee, a missing `SHOPEE_PARTNER_*` is OUR misconfiguration, and a
 * closed valve has no sweep behind it.
 *
 * ⚠️ `ShopeeReauthRequiredError` is a `ShopeeApiError` subclass — consulted only
 * after the rate-limit arm has had its say.
 */
function ehFalhaDePrimeiraTentativa(err: unknown): err is Error {
  return (
    err instanceof ShopeeReauthRequiredError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeeConfigError ||
    err instanceof ShopeePriceSyncTasksDisabledError
  );
}

/**
 * The classes whose MESSAGE this app composes itself, from its own ids and
 * field PATHS — never from a provider body: the conta context's and the token
 * store's conta classes, and the price queue's valve. Their sentence is the
 * operator's best cause ("Integração … não é do tipo Shopee."), and the tasks
 * lane's wrong-`tipo` case reads it as its proof of WHICH arm fired.
 *
 * ⚠️ A closed set of exact classes, and never a `ShopeeError` base: every
 * `ShopeeApiError` subclass — `ShopeeReauthRequiredError` included, a
 * first-attempt class too — carries Shopee's own prose in its message.
 */
function temMensagemPropria(err: Error): boolean {
  return (
    err instanceof ShopeeContaNotConfiguredError ||
    err instanceof ShopeeContaSemShopIdError ||
    err instanceof ShopeeSemCredencialError ||
    err instanceof ShopeeCredencialInvalidaError ||
    err instanceof ShopeePriceSyncTasksDisabledError
  );
}

/**
 * Shopee's `error` CODE as a TOKEN — letters, digits, `_`, `.` and `-`, at most
 * a hundred — and nothing that reads as a sentence. A value of any other shape
 * is left out of the stamp rather than trusted.
 */
const CODIGO_SHOPEE = /^[\w.-]{1,100}$/;

/**
 * The `erro` an EXCEPTION stamps: a pt-BR sentence naming its cause, never
 * the provider's text.
 *
 * - One of this app's own conta classes ({@link temMensagemPropria}): its
 *   message, which this app wrote, plus its class.
 * - Anything else: its CLASS, plus Shopee's `error` code verbatim for the
 *   `ShopeeApiError` family (when it is a {@link CODIGO_SHOPEE} token) or the
 *   gRPC status for a Firestore/Tasks failure. A `ShopeeApiError`'s message
 *   quotes Shopee's own `message`, which can carry ids and is not ours to
 *   store; a transport message can carry a URL or a body (the start route's
 *   rule). The message goes to the log, where {@link processarEnvioPrecoShopee}
 *   writes it.
 */
function erroDaFalha(err: Error): string {
  if (temMensagemPropria(err)) return `${err.message} (${err.name})`;
  const detalhes = [err.name];
  if (err instanceof ShopeeApiError) {
    if (CODIGO_SHOPEE.test(err.code)) detalhes.push(`código Shopee ${err.code}`);
  } else if (isGrpcCodedError(err)) {
    detalhes.push(`código gRPC ${String((err as Error & { code: number }).code)}`);
  }
  return `O despacho da atualização de preços falhou (${detalhes.join(', ')}).`;
}

/** The operator sentence of a conta the verdict refused mid-run. */
function erroDeContaRecusada(motivo: string): string {
  return `conta recusada (${motivo}): ${mensagemDoMotivoDePreco(motivo)}`;
}

/** The erro of a run that met a burst limit more often than the ceiling allows. */
const MSG_PAUSAS_EXCEDIDAS =
  `a Shopee limitou a taxa de chamadas mais de ${String(ENVIO_PRECO_MAX_PAUSAS)} vezes nesta ` +
  'atualização; o envio foi encerrado em vez de reenfileirar para sempre.';

/** The erro of a run that met the daily quota more often than the ceiling allows. */
const MSG_PARQUES_EXCEDIDOS =
  `a cota diária da Shopee se esgotou mais de ${String(ENVIO_PRECO_MAX_PARQUES)} vezes nesta ` +
  'atualização; o envio foi encerrado — inicie outro depois da virada da cota.';

/* -------------------------------------------------------------------------- */
/*                               production seams                              */
/* -------------------------------------------------------------------------- */

/**
 * The production verdict: the manual route's own call, over the context this
 * dispatch loaded — the client is built lazily, by the verdict, only when the
 * shop read needs it.
 */
const avaliarContaPadrao: NonNullable<DepsDespachoPreco['avaliarConta']> = (db, contexto, nowMs) =>
  avaliarContaParaPreco(
    db,
    {
      integracaoId: contexto.integracaoId,
      shopId: contexto.conta.shop_id ?? null,
      tabelaNormalOuterRef: contexto.conta.tabelaNormalOuterRef,
    },
    {
      nowMs,
      clientFor: () => Promise.resolve().then(() => contexto.createShopClient()),
      config: contexto.config,
    },
  );

/* -------------------------------------------------------------------------- */
/*                                 the dispatch                                */
/* -------------------------------------------------------------------------- */

/** The row-carrying outcomes of the sender. */
type ResultadoComLinhas = Extract<
  ResultadoEnvioPreco,
  { readonly tipo: 'enviado' | 'pulado' | 'falha' }
>;

/**
 * Process ONE `processShopeePriceSync` dispatch — see the module docblock for
 * the shape. `retryCount` is the Cloud Tasks attempt index (0-based): on the
 * LAST attempt an otherwise-retryable failure stamps the job `failed` instead of
 * rethrowing.
 *
 * ⚠️ The job's own `integracaoId` drives everything; the payload's is only the
 * queue's routing copy of it.
 */
export async function processarEnvioPrecoShopee(
  deps: DepsDespachoPreco,
  payload: EnvioPrecoShopeeTaskPayload,
  retryCount: number,
): Promise<DespachoEnvioPreco> {
  const { db, nowMs } = deps;
  const { jobId } = payload;
  const resolverContexto = deps.resolverContexto ?? loadShopeeContext;
  const avaliarConta = deps.avaliarConta ?? avaliarContaPadrao;
  const lerPagina = deps.lerPagina ?? lerPaginaDeFamiliasDePreco;
  const lerPrecos = deps.lerPrecos ?? lerPrecosDosProdutos;
  const criarLeitorDeBase = deps.criarLeitorDeBase ?? criarLeitorDeBaseEmLote;
  const enviar = deps.enviar ?? enviarPrecoDoItem;
  const jitter = deps.jitterSec ?? (() => 0);

  const leitura = await lerJob(db, jobId);
  if (!leitura || leitura.job.status !== ENVIO_PRECO_SHOPEE_STATUS.running) return 'noop';
  const { job } = leitura;
  const integracaoId = job.integracaoId;
  const continuacao: EnvioPrecoShopeeTaskPayload = { jobId, integracaoId };

  // The working copy. ⚠️ Every mutable below is written by EVERY checkpoint: a
  // field missing from the patch is silently never persisted and resets on the
  // next dispatch (Mercado Livre's lesson).
  let fila: ItemPlanejadoPreco[] = [...job.fila];
  let afterAnchorId = job.afterAnchorId;
  let planejamentoConcluido = job.planejamentoConcluido;
  let planejados = job.planejados;
  let enviados = job.enviados;
  let pulados = job.pulados;
  let falhas = job.falhas;
  let pausas = job.pausas;
  let parques = job.parques;
  // A resumed PARK clears its `retomarEm` in this dispatch's first checkpoint;
  // a park taken again below stamps it anew. (A dispatch that arrives BEFORE
  // the stored `retomarEm` writes nothing — see the top of the drain.)
  let retomarEm: number | null = null;
  let skips: EnvioPrecoSkip[] = [...job.skips];
  let failures: EnvioPrecoFailure[] = [...job.failures];
  let relatorioLinhas = job.relatorioLinhas;
  /** Rows produced since the last COMMITTED checkpoint — cleared only after a commit. */
  let pendentes: LinhaRelatorioEnvioPreco[] = [];

  /**
   * ONE `db.batch()`: the job patch (never `status`) and every pending row, in
   * the shard this dispatch's cursor selects. See the module docblock.
   *
   * `precondicao` — the PLAN checkpoint's alone: the job read's `updateTime`,
   * making the job write an `update` that fails whole (`FAILED_PRECONDITION`,
   * the rows included) when anything wrote the job since that read. Every other
   * checkpoint is a plain merge, because the listing it records WAS sent and its
   * row must land even after a cancel.
   */
  const checkpoint = async (precondicao?: Timestamp): Promise<void> => {
    const porShard = new Map<number, Record<string, LinhaRelatorioEnvioPreco>>();
    let total = relatorioLinhas;
    for (const linha of pendentes) {
      const indice = Math.floor(total / RELATORIO_ENVIO_PRECO_SHARD_SIZE);
      let bucket = porShard.get(indice);
      if (bucket === undefined) {
        bucket = {};
        porShard.set(indice, bucket);
      }
      bucket[relatorioEnvioPrecoRowKey(linha)] = linha;
      total += 1;
    }
    // ⚠️ TIER 0 (root `CLAUDE.md` rule 7): the counters are TRANSFORMS, never
    // an absolute value from this dispatch's copy — a terminal stamp that
    // landed while a listing was in flight has already added its synthetic row,
    // and writing a count that predates it would take that `+1` back. So this
    // ADDS the rows it writes and RAISES the shard count to the last shard they
    // reach. Applied after `parseMerge`, which validates numbers and would
    // refuse a sentinel. A checkpoint with NO rows moves neither.
    //
    // `updatedAt` is the same tier for the same race: a cancel stamps
    // `updatedAt = finishedAt = <its instant>`, and the in-flight listing's
    // checkpoint lands AFTER it carrying this dispatch's older clock. A plain
    // value would move the stamp backwards (`updatedAt < finishedAt` on the
    // status and history routes); `maximum` only ever raises it.
    const transformacoes = {
      updatedAt: FieldValue.maximum(nowMs),
      ...(pendentes.length === 0
        ? {}
        : {
            relatorioLinhas: FieldValue.increment(pendentes.length),
            relatorioShards: FieldValue.maximum(
              Math.floor((total - 1) / RELATORIO_ENVIO_PRECO_SHARD_SIZE) + 1,
            ),
          }),
    };

    const batch = db.batch();
    const refDoJob = envioPrecoShopeeCollection.docRef(db, {}, jobId);
    const patchDoJob = {
      ...envioPrecoShopeeCollection.parseMerge({
        fila,
        // A claim ABOUT `fila`, written with it on every checkpoint so the two
        // always land together.
        filaRestante: fila.length,
        afterAnchorId,
        planejamentoConcluido,
        planejados,
        enviados,
        pulados,
        falhas,
        pausas,
        parques,
        retomarEm,
        skips,
        failures,
      }),
      ...transformacoes,
    } as DocumentData;
    // The patch is FLAT (arrays and scalars), so `update` and a merge write
    // the same fields; only the precondition differs.
    if (precondicao === undefined) batch.set(refDoJob, patchDoJob, { merge: true });
    else batch.update(refDoJob, patchDoJob, { lastUpdateTime: precondicao });
    for (const [indice, linhas] of porShard) {
      batch.set(
        relatorioEnvioPrecoShopeeCollection.docRef(
          db,
          { envioId: jobId },
          relatorioEnvioPrecoShardId(indice),
        ),
        relatorioEnvioPrecoShopeeCollection.parseMerge({
          // A nested-map merge: Firestore DEEP-merges `linhas` under
          // `{ merge: true }`, so the shard keeps the rows already in it.
          linhas,
          timestamp: nowMs,
          expiraEm: expiraEmDoRelatorioShopee(job.startedAt),
        }) as DocumentData,
        { merge: true },
      );
    }
    await batch.commit();
    relatorioLinhas = total;
    pendentes = [];
  };

  /** A skip's sample entry — ONE per listing, capped; the counters stay exact. */
  const amostrarPulo = (entrada: EnvioPrecoSkip): void => {
    if (skips.length < AMOSTRA_PULOS_CAP) skips = [...skips, entrada];
  };
  const amostrarFalha = (entrada: EnvioPrecoFailure): void => {
    if (failures.length < AMOSTRA_FALHAS_CAP) failures = [...failures, entrada];
  };

  /** A plan skip ⇒ one row per model the planner had folded, else ONE row. */
  const registrarPulo = (pulo: PuloDePlano): void => {
    const anuncioId = pulo.itemId === null ? null : String(pulo.itemId);
    const variacoes = pulo.modelos.length === 0 ? [null] : pulo.modelos.map((m) => m.produtoId);
    for (const variacaoProdutoId of variacoes) {
      pendentes.push({
        produtoId: pulo.produtoId,
        variacaoProdutoId,
        anuncioId,
        linkDocId: pulo.linkDocId,
        resultado: ENVIO_PRECO_RESULTADO.pulado,
        fase: ENVIO_PRECO_FASE.plano,
        motivo: pulo.motivo,
        erro: null,
        preco: null,
        precoAnterior: null,
        variacoes: null,
      });
      pulados += 1;
    }
    amostrarPulo({
      itemId: anuncioId,
      produtoId: pulo.produtoId,
      code: pulo.motivo,
      linkDocId: pulo.linkDocId,
      precoAnterior: null,
    });
  };

  /**
   * A sent listing's lines ⇒ one row per line (= per alvo, S1), in order.
   * `preco` is the INTENDED price on every row (the shared schema's documented
   * trap: key "sent" off `resultado`, never off a non-null `preco`).
   */
  const registrarEnvio = (item: ItemDePreco, r: ResultadoComLinhas): void => {
    const anuncioId = String(item.itemId);
    let amostrado = false;
    for (const linha of r.modelos) {
      pendentes.push({
        produtoId: item.produtoId,
        variacaoProdutoId: linha.produtoId === item.produtoId ? null : linha.produtoId,
        anuncioId,
        linkDocId: item.linkDocId,
        resultado: linha.resultado,
        fase: ENVIO_PRECO_FASE.envio,
        motivo: linha.motivo,
        erro: cortarErro(linha.codigo),
        preco: linha.precoAlvo,
        precoAnterior: linha.precoAnterior,
        variacoes: null,
      });
      if (linha.resultado === ENVIO_PRECO_RESULTADO.enviado) enviados += 1;
      else if (linha.resultado === ENVIO_PRECO_RESULTADO.pulado) pulados += 1;
      else falhas += 1;

      // The sample: the listing's FIRST line that did not send.
      if (amostrado || linha.resultado === ENVIO_PRECO_RESULTADO.enviado) continue;
      amostrado = true;
      const code = linha.motivo ?? MOTIVO_PRECO_SHOPEE.recusaDesconhecida;
      const base = {
        itemId: anuncioId,
        produtoId: item.produtoId,
        code,
        linkDocId: item.linkDocId,
        precoAnterior: linha.precoAnterior,
      };
      if (linha.resultado === ENVIO_PRECO_RESULTADO.pulado) amostrarPulo(base);
      else amostrarFalha({ ...base, error: cortarErro(linha.codigo) ?? code });
    }
  };

  /**
   * A DETERMINISTIC terminal failure inside the dispatch: flush what is pending
   * (the rows and every counter) through a checkpoint, THEN the transaction —
   * whose synthetic `job-interrompido` row lands after them, in the shard the
   * just-committed counter selects. A cancel that landed meanwhile wins, and
   * this answers `'noop'`.
   */
  const falharJob = async (erro: string): Promise<DespachoEnvioPreco> => {
    await checkpoint();
    const carimbo = await finalizarEnvioPrecoShopee(
      db,
      jobId,
      {
        status: ENVIO_PRECO_SHOPEE_STATUS.failed,
        erro,
        relatorioCompleto: false,
        finishedAt: nowMs,
        updatedAt: nowMs,
      },
      { linhaTerminal: MOTIVO_PRECO_SHOPEE.jobInterrompido },
    );
    return carimbo === 'stamped' ? 'failed' : 'noop';
  };

  /** A park's task delay: the whole seconds until `ate`, plus the jitter. */
  const atrasoDoParque = (ate: number): number =>
    Math.max(0, Math.ceil((ate - nowMs) / MS_POR_SEGUNDO)) + jitter(PARQUE_JITTER_MAX_S);

  /**
   * A BURST limit: checkpoint WITHOUT consuming the head, then a DELAYED self
   * re-enqueue — no attempt spent. Past the ceiling, the job fails. A job no
   * longer `running` (a cancel that landed during the call that met the limit)
   * takes no pause: nothing is written, nothing enqueued.
   */
  const pausarPorRajada = async (atrasoS: number): Promise<DespachoEnvioPreco> => {
    if (!(await aindaRodando(db, jobId))) return 'noop';
    pausas += 1;
    if (pausas > ENVIO_PRECO_MAX_PAUSAS) return falharJob(MSG_PAUSAS_EXCEDIDAS);
    await checkpoint();
    await deps.scheduler.enqueue(continuacao, {
      scheduleDelaySeconds: Math.max(1, Math.ceil(atrasoS)),
    });
    return 'continued';
  };

  /**
   * The DAILY quota: PARK until `ate` (the next 00:00, UTC+8) — `retomarEm`
   * stamped, `status` still `running`, head not consumed. Past the ceiling, the
   * job fails. A job no longer `running` is not parked: a park stamped after a
   * cancel would put a `retomarEm` back on a stopped job.
   */
  const estacionar = async (ate: number): Promise<DespachoEnvioPreco> => {
    if (!(await aindaRodando(db, jobId))) return 'noop';
    parques += 1;
    if (parques > ENVIO_PRECO_MAX_PARQUES) return falharJob(MSG_PARQUES_EXCEDIDOS);
    retomarEm = ate;
    await checkpoint();
    await deps.scheduler.enqueue(continuacao, { scheduleDelaySeconds: atrasoDoParque(ate) });
    return 'pausado';
  };

  /** A rate-limit ERROR (not a sender result) ⇒ the matching pause arm. */
  const pausarPorErro = (err: ShopeeRateLimitError): Promise<DespachoEnvioPreco> =>
    err.kind === SHOPEE_ERROR_KIND.burst
      ? pausarPorRajada(err.retryAfterSeconds ?? ratePauseMin() * SEGUNDOS_POR_MINUTO)
      : estacionar(proximaViradaDaCotaMs(nowMs));

  /**
   * The terminal stamp from INSIDE the dispatch's catch, where the working copy
   * may be ahead of what was committed: the transaction derives everything from
   * its own snapshot. The stamped `erro` is {@link erroDaFalha}'s sentence —
   * the error's message goes to the log, never to the document. A failure of
   * the stamp itself is logged and never rethrown as long as it is a Firestore
   * or a Shopee-shaped one — rethrowing would replace the original cause with
   * the symptom.
   */
  const carimbarFalha = async (err: Error): Promise<DespachoEnvioPreco> => {
    const erro = erroDaFalha(err);
    console.warn(`${TAG_LOG}: o despacho falhou; o job é encerrado`, {
      jobId,
      integracaoId,
      classe: err.name,
      mensagem: err.message,
    });
    try {
      const carimbo = await finalizarEnvioPrecoShopee(
        db,
        jobId,
        {
          status: ENVIO_PRECO_SHOPEE_STATUS.failed,
          erro,
          relatorioCompleto: false,
          finishedAt: nowMs,
          updatedAt: nowMs,
        },
        { linhaTerminal: MOTIVO_PRECO_SHOPEE.jobInterrompido },
      );
      return carimbo === 'stamped' ? 'failed' : 'noop';
    } catch (erroDoCarimbo) {
      if (!isGrpcCodedError(erroDoCarimbo) && !(erroDoCarimbo instanceof ShopeeError)) {
        throw erroDoCarimbo;
      }
      console.error(`${TAG_LOG}: falha ao carimbar o job como failed`, {
        jobId,
        integracaoId,
        causa: erro,
        erroDoCarimbo: erroDoCarimbo.message,
      });
      return 'failed';
    }
  };

  try {
    const contextoDaConta = await resolverContexto(db, integracaoId);

    /* ------------------------------ (a) plan one page --------------------- */
    if (fila.length === 0 && !planejamentoConcluido) {
      const pagina = await lerPagina(db, {
        integracaoId,
        afterAnchorId,
        pageLimit: pageLimitPreco(),
      });
      const novos: ItemPlanejadoPreco[] = [];
      for (const familia of pagina.familias) {
        const plano = montarItensDePreco(familia, integracaoId);
        for (const item of plano.itens) novos.push(item);
        for (const pulo of plano.pulos) registrarPulo(pulo);
      }
      fila = novos;
      planejados += novos.length;
      afterAnchorId = pagina.nextAfterAnchorId;
      planejamentoConcluido = pagina.nextAfterAnchorId === null;
      try {
        // GUARDED (tier 1): nothing was sent yet, so a job written by anyone
        // since this dispatch read it — a cancel, the orphan reclaim, another
        // delivery of this task — must not receive this page. The whole batch
        // fails, its skip rows included.
        await checkpoint(leitura.updateTime);
      } catch (err) {
        if (isFailedPrecondition(err)) return 'noop';
        throw err;
      }
    }

    /* ------------------------------ (b) the drain ------------------------- */
    if (fila.length > 0) {
      // PARKED until a later instant — an early duplicate, or the queue's retry
      // of a park whose enqueue threw after its checkpoint: wait out the rest,
      // with no park spent, no Shopee call and no write.
      if (job.retomarEm !== null && job.retomarEm > nowMs) {
        await deps.scheduler.enqueue(continuacao, {
          scheduleDelaySeconds: atrasoDoParque(job.retomarEm),
        });
        return 'pausado';
      }
      // A cancel that landed during the plan checkpoint, or since this
      // dispatch read the job, stops it before any Shopee call.
      if (!(await aindaRodando(db, jobId))) return 'noop';

      // The stock sync's QUOTA pause, READ and never written. Before the verdict,
      // so a paused conta spends no Shopee call at all.
      const estado = await lerEstadoEstoque(db, integracaoId);
      const pausadoAte = pausaDeCotaParaPreco(estado, nowMs);
      if (pausadoAte !== null) {
        return estado.pausaMotivo === MOTIVOS_DE_PAUSA.cotaDiaria
          ? await estacionar(pausadoAte)
          : await pausarPorRajada((pausadoAte - nowMs) / MS_POR_SEGUNDO);
      }

      let veredito: VereditoContaPreco;
      try {
        veredito = await avaliarConta(db, contextoDaConta, nowMs);
      } catch (err) {
        // The shop read is the one Shopee call outside the sender: a rate limit
        // here pauses like a sender's, from inside the try.
        if (err instanceof ShopeeRateLimitError) return await pausarPorErro(err);
        throw err;
      }
      if (!veredito.ok) {
        if (veredito.erro !== null) {
          // The class and message are for the log — never for the document.
          console.warn(`${TAG_LOG}: conta recusada (${veredito.motivo})`, {
            jobId,
            integracaoId,
            erro: veredito.erro,
          });
        }
        return await falharJob(erroDeContaRecusada(veredito.motivo));
      }
      const conta = veredito.contexto;

      const lote = fila.slice(0, itensPorDespachoPreco());
      // ONE batched base reader per dispatch, over the whole lote (lazy — the
      // first send pays one `get_item_base_info` per 50 ids).
      const lerBase = criarLeitorDeBase(
        conta.client,
        lote.map((i) => i.itemId),
      );

      for (const planejado of lote) {
        // ⚠️ A cancel stops the lote HERE: the listing in flight when it landed
        // has finished and checkpointed; nothing after it is sent. Before the
        // FIRST listing too — a cancel during the verdict sends nothing.
        if (!(await aindaRodando(db, jobId))) return 'noop';
        // ⚠️ The price NOW, not the plan's (reconcile C-d).
        const precos = await lerPrecos(db, produtosQuePrecificam(planejado));
        const item = precificarItem(planejado, precos, conta.tabelaNormalId);
        const r = await enviar(item, {
          db,
          conta,
          nowMs,
          baixarPreco: job.baixarPreco,
          lerBase,
        });

        if (r.tipo === 'pausa') {
          return r.pausa === MOTIVOS_DE_PAUSA.cotaDiaria
            ? await estacionar(r.ate ?? proximaViradaDaCotaMs(nowMs))
            : await pausarPorRajada(r.retryAfterSeconds ?? ratePauseMin() * SEGUNDOS_POR_MINUTO);
        }
        if (r.tipo === 'fatal') {
          console.warn(`${TAG_LOG}: a conta encerrou o envio (${r.motivo})`, {
            jobId,
            integracaoId,
            itemId: item.itemId,
            erro: r.erro,
          });
          return await falharJob(`${r.motivo}: ${mensagemDoMotivoDePreco(r.motivo)}`);
        }

        // S1 at the surface, BEFORE anything is written: a row set that lost a
        // model is a defect, never a report.
        conferirCompletudeDoItemDePreco(item, r.modelos);
        registrarEnvio(item, r);
        fila = fila.slice(1);
        await checkpoint();
      }
    }

    /* ------------------------ (c) continue or complete -------------------- */
    if (fila.length > 0 || !planejamentoConcluido) {
      // A cancel that landed while this dispatch ran must not buy one more.
      if (!(await aindaRodando(db, jobId))) return 'noop';
      await deps.scheduler.enqueue(continuacao);
      return 'continued';
    }

    // Guarded, never a plain merge: a cancel may have landed mid-drain, and
    // `completed` must not bury it.
    const carimbo = await finalizarEnvioPrecoShopee(db, jobId, {
      status: ENVIO_PRECO_SHOPEE_STATUS.completed,
      relatorioCompleto: true,
      finishedAt: nowMs,
      updatedAt: nowMs,
    });
    return carimbo === 'stamped' ? 'done' : 'noop';
  } catch (err) {
    if (err instanceof ShopeeRateLimitError) {
      // Only an escape outside the sender and the verdict reaches here. Its
      // pause arm's own enqueue can no longer re-enter this catch, so step 9's
      // rule is spelled again: a closed valve stamps; anything else rethrows for
      // the queue's ladder — except on the LAST attempt, which stamps, because
      // nothing re-drives a task the queue has dropped and the job would stay
      // `running` for ever.
      try {
        return await pausarPorErro(err);
      } catch (erroDaPausa) {
        if (erroDaPausa instanceof ShopeePriceSyncTasksDisabledError) {
          return carimbarFalha(erroDaPausa);
        }
        if (retryCount < ENVIO_PRECO_MAX_TENTATIVAS - 1 || !(erroDaPausa instanceof Error)) {
          throw erroDaPausa;
        }
        return carimbarFalha(erroDaPausa);
      }
    }
    if (ehFalhaDePrimeiraTentativa(err)) return carimbarFalha(err);
    if (!(err instanceof Error)) throw err;
    if (retryCount < ENVIO_PRECO_MAX_TENTATIVAS - 1) throw err; // the queue's backoff
    return carimbarFalha(err);
  }
}
