/**
 * The feed core's PROVIDER SEAM (step 12a, PR 12-b): what a fluxo (stock in
 * step 12, price in step 13) hands the core to have its batch submitted as one
 * `JSON_LISTINGS_FEED`, plus the core's closed abort motivos and its timing
 * constants. TYPES and constants only: the stock provider lives with its
 * fluxo (`estoque/provedorLoteEstoque.ts`, PR 12-f), and the core never
 * imports a fluxo's module — the jobs root binds one per fluxo, through the
 * seam table's factories (`./destinosLote`).
 *
 * ## The seam
 *
 *  - `membros` — the batch's SKUs, deduplicated: a block batch reads its
 *    payload's RANGE of one run's stored parts (`execucaoIdRun`,
 *    `parteInicial`, `partes`), a window batch re-derives its window. `dados` is
 *    whatever `montar` needs (opaque to the core).
 *  - `montar` — the messages for exactly the members the valve let through,
 *    and `snapshotEmMs`, our clock BEFORE the batch's first read.
 *  - `gravarResultado` — the per-SKU write-back of a report (at most the
 *    bounded set the core kept), clocked by the record's stored outcome clock.
 *    Per-SKU problems are the PROVIDER's aviso to raise: a feed whose report
 *    carries per-SKU errors COMPLETED, and never raises `motivoFalha`.
 *  - `recuperar` — what an end needs, by outcome: `vez` is a release that only
 *    found turned-away batches pending.
 *  - `repassarParaPatches` — a batch handed to the per-SKU path: the canary
 *    list's members, or a window batch routed away from a held lease.
 *  - `motivoFalha` — the conta aviso this fluxo raises when a FEED fails.
 *
 * Either build step may answer `abortado` (a closed {@link MotivoAbortoLote}):
 * nothing is posted, and the core raises the `aviso` it names when non-null. A
 * provider that wants a follow-up makes that idempotent request itself before
 * answering.
 *
 * ## The OPTIONAL members (step 13, PR 13-f)
 *
 * A provider that declares none of them gets the core's behaviour unchanged:
 *
 *  - `relatorio` — the document's header asks the processing report for these
 *    datasets per item (`report.includedData`);
 *  - `issueDeItemRelevante` — which of a report ITEM's own issues (the listing
 *    after processing, `categories` included) reach `gravarResultado`, as
 *    `issuesDosItens` beside the report's own `problemas`;
 *  - `valvulaEfetiva` — the valve the send acts on, from the raw one read at
 *    E1: what the valve line logs, what `off` is checked on and what the batch
 *    engine decides the form from (a `null` provider keeps the raw valve);
 *  - `aoFimSemEnvio` — told ONCE of every end after the context that submits
 *    nothing ({@link FIM_SEM_ENVIO_LOTE}), after the release and the core's
 *    own aviso; a transient failure of its write is contained by the core,
 *    never rethrown (a retry would take the lease again and repeat the
 *    batch). An end before the context calls nothing.
 *
 * ## The timing constants
 *
 *  - {@link MAX_FALHAS_SEGUIDAS_FEED} — consecutive failed feeds that open the
 *    breaker (window batches go per SKU instead);
 *  - {@link ESPERA_SONDA_DISJUNTOR_MS} — after the last failure, one window
 *    batch takes the lease as the half-open probe;
 *  - {@link ESPERA_MAXIMA_ATRAS_DE_FEED_MS} — a holder this old is slow: window
 *    batches stop waiting for it;
 *  - {@link ESPACO_MINIMO_ENTRE_FEEDS_MS} — the stock fluxo's floor between
 *    two of its submissions (each fluxo's own sits in `./vezFeed`);
 *  - {@link ESPERA_LOTE_EM_VEZ_S} — a waiting batch's re-enqueue delay;
 *  - {@link ESPERA_MAXIMA_LOTE_RECUPERACAO_MS} — how long a recovery-born
 *    window batch may wait for the lease before going per SKU;
 *  - {@link ORCAMENTO_MONTAGEM_LOTE_MS} — the ONE build budget `membros` and
 *    `montar` share: the send handler checks it after each answer, and a
 *    provider checks it before each read batch of its own.
 */
import type {
  DadoRelatorioFeed,
  MensagemListingsFeed,
} from '@delfrance/integrations-amazon-sp-api';
import type {
  JanelaFeedAmazon,
  MotivoContaAmazon,
  TimestampLike,
  VezFeedAmazon,
} from '@delfrance/schemas';
import type { Firestore } from 'firebase-admin/firestore';

import type { ContextoAmazon } from '../core/contexto';
import type { CamposLogAmazon, LoggerAmazon } from '../core/log';
import type { FluxoComLoteAmazon, ValvulaAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { ProblemaItemSku, ProblemaSku } from './relatorioFeed';
import type { DesfechoRecuperacaoFeedAmazon, TarefaEnviarFeedAmazon } from './tarefaLote';

/* ------------------------------ the abort motivos ----------------------------- */

/** Why a provider refused to build: nothing was posted. */
export const MOTIVO_ABORTO_LOTE = {
  /** The build ran past its budget. */
  snapshotLento: 'snapshot-lento',
  /** The conta's depósito is not the one the batch was produced for. */
  depositoMudou: 'deposito-mudou',
  /** The re-derived window holds more SKUs than one batch may carry. */
  janelaGrande: 'janela-grande',
} as const;
export type MotivoAbortoLote = (typeof MOTIVO_ABORTO_LOTE)[keyof typeof MOTIVO_ABORTO_LOTE];

/* ------------------------------ the ends without a send ----------------------- */

/**
 * Every end of a send AFTER its context that submits nothing (module header,
 * `aoFimSemEnvio`): a dry-run, a build with no message, the canary's members
 * handed to tasks, a window batch handed to tasks (or whose hand-off refused
 * to build), a provider's (or the budget's) abort, a document the package or
 * Amazon refused deterministically, a definitive refusal of the submission,
 * and a block batch past its wait.
 */
export const FIM_SEM_ENVIO_LOTE = {
  simulado: 'simulado',
  semEscrita: 'sem-escrita',
  soPatches: 'so-patches',
  repassado: 'repassado',
  repasseAbortado: 'repasse-abortado',
  abortado: 'abortado',
  documentoFalhou: 'documento-falhou',
  recusaDefinitiva: 'recusa-definitiva',
  loteExpirado: 'lote-expirado',
} as const;
export type FimSemEnvioLote = (typeof FIM_SEM_ENVIO_LOTE)[keyof typeof FIM_SEM_ENVIO_LOTE];

/* ------------------------------ the timing constants -------------------------- */

/** Consecutive failed feeds that open the breaker. */
export const MAX_FALHAS_SEGUIDAS_FEED = 3;

/** A waiting batch's re-enqueue delay, in seconds. */
export const ESPERA_LOTE_EM_VEZ_S = 300;

/** The breaker's half-open probe: this long after the last failure (1 h). */
export const ESPERA_SONDA_DISJUNTOR_MS = 3_600_000;

/** A holder at least this old is slow (30 min). */
export const ESPERA_MAXIMA_ATRAS_DE_FEED_MS = 1_800_000;

/**
 * The stock fluxo's floor between two of its submissions (120 s): the base of
 * the per-fluxo table `ESPACO_MINIMO_ENTRE_FEEDS_MS_POR_FLUXO` (`./vezFeed`).
 */
export const ESPACO_MINIMO_ENTRE_FEEDS_MS = 120_000;

/** How long a recovery-born window batch may wait for the lease (1 h). */
export const ESPERA_MAXIMA_LOTE_RECUPERACAO_MS = 3_600_000;

/**
 * The ONE build budget `membros` and `montar` share, from the send's build
 * start (240 s): past it the batch is `snapshot-lento`, nothing posted. With the
 * submission's worst case on top it fits the jobs queue's 540-s timeout.
 */
export const ORCAMENTO_MONTAGEM_LOTE_MS = 240_000;

/* ---------------------------------- the seam ---------------------------------- */

/** What every provider call receives. */
export interface ContextoLoteAmazon {
  /** The conta's context (read switch already passed). */
  readonly contexto: ContextoAmazon;
  readonly db: Firestore;
  readonly logger: LoggerAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  /** The seller the feed document's header declares. */
  readonly sellerId: string;
  /**
   * The dispatch's lease read's `readTime`: the send-side aviso clock; `null`
   * where the dispatch read no lease. Typed by SHAPE, as the record stores a
   * clock and the aviso module converts one.
   */
  readonly relogioVez: TimestampLike | null;
  /**
   * The lease as the send dispatch's E4 read found it (its
   * `ultimoFeedConcluidoEmMs` included: a stock build's recent-feed rule reads
   * it from here, never with a second read); `null` on the result and recovery
   * sides, which read no lease, and when no lease document exists yet.
   */
  readonly vez: VezFeedAmazon | null;
}

/** A provider refusal to build (module header). */
export interface AbortoLoteAmazon {
  readonly abortado: MotivoAbortoLote;
  readonly aviso: MotivoContaAmazon | null;
}

/** `membros`' answer. */
export type MembrosLoteAmazon<D> =
  | { readonly skus: readonly string[]; readonly dados: D }
  | AbortoLoteAmazon;

/** `montar`'s answer. */
export type MontagemLoteAmazon =
  | {
      readonly mensagens: readonly MensagemListingsFeed[];
      /** ms — our clock BEFORE the batch's first read. */
      readonly snapshotEmMs: number;
      /** The dry-run line's campos: primitives and closed codes only. */
      readonly diff: CamposLogAmazon;
    }
  | AbortoLoteAmazon;

/** `gravarResultado`'s input. */
export interface ResultadoLoteAmazon {
  /** SKU → its problems: the bounded set the core kept. */
  readonly problemas: ReadonlyMap<string, readonly ProblemaSku[]>;
  /**
   * SKU → the report items' own issues `issueDeItemRelevante` kept, bounded as
   * `problemas` is; present exactly when the provider declares that member.
   */
  readonly issuesDosItens?: ReadonlyMap<string, readonly ProblemaItemSku[]>;
  /** ms — the feed's `antesDoEnvioMs` (our submission instant). */
  readonly emMs: number;
  readonly feedId: string;
  /**
   * The record's stored outcome clock (`relogioDesfecho`, as its handle reads
   * it), the same on every attempt.
   */
  readonly relogio: TimestampLike;
}

/** `recuperar`'s input. */
export interface RecuperacaoLoteAmazon {
  readonly desfecho: DesfechoRecuperacaoFeedAmazon;
  /** ms — null for `vez`. */
  readonly snapshotEmMs: number | null;
  /** ms — the turned-away window batches' earliest start, or null. */
  readonly pendenteDesdeMs: number | null;
  /**
   * The recovered feed's `feedId`, else the send run's `execucaoId`; for a
   * `vez` recovery, that releaser's reference PREFIXED (`referenciaVezFeed`).
   * Always `referenciaDaRecuperacaoFeed` of the payload: the same value the
   * recovery's own name and a recovery-born batch's `execucaoId` are minted
   * from.
   */
  readonly referencia: string;
  /** The recovered feed's own window (a window batch), else null. */
  readonly janela: JanelaFeedAmazon | null;
}

/** `recuperar`'s answer. */
export type DesfechoRecuperacaoLoteAmazon =
  | { readonly tarefas: number }
  | { readonly feed: string }
  | { readonly repassado: 'reconciliacao' }
  | { readonly nada: true };

/** What `valvulaEfetiva` receives besides the raw valve: the dispatch's environment and logger. */
export interface EntradaValvulaEfetivaLoteAmazon {
  /** The process environment the raw valve was read from. */
  readonly ambiente: AmbienteAmazon;
  readonly logger: LoggerAmazon;
  /** The envelope of a line the provider writes about the valve. */
  readonly envelope: {
    readonly conta: string;
    readonly tentativa: number;
    readonly idTarefa: string | null;
  };
}

/** A fluxo's provider (module header). `F` the fluxo, `D` what `membros` hands `montar`. */
export interface ProvedorLoteAmazon<F extends FluxoComLoteAmazon, D> {
  readonly fluxo: F;
  membros(
    ctx: ContextoLoteAmazon,
    entrada: TarefaEnviarFeedAmazon & { readonly fluxo: F },
  ): Promise<MembrosLoteAmazon<D>>;
  montar(
    ctx: ContextoLoteAmazon,
    entrada: TarefaEnviarFeedAmazon & { readonly fluxo: F },
    membrosOn: readonly string[],
    dados: D,
  ): Promise<MontagemLoteAmazon>;
  gravarResultado(ctx: ContextoLoteAmazon, resultado: ResultadoLoteAmazon): Promise<void>;
  recuperar(
    ctx: ContextoLoteAmazon,
    recuperacao: RecuperacaoLoteAmazon,
  ): Promise<DesfechoRecuperacaoLoteAmazon>;
  repassarParaPatches(
    ctx: ContextoLoteAmazon,
    entrada: TarefaEnviarFeedAmazon & { readonly fluxo: F },
    skus: readonly string[],
    dados: D,
  ): Promise<{ readonly tarefas: number }>;
  /** The conta aviso this fluxo raises when a FEED fails (never for per-SKU errors). */
  readonly motivoFalha: MotivoContaAmazon;
  /** OPTIONAL (module header): the datasets the processing report carries per item. */
  readonly relatorio?: { readonly incluir: readonly DadoRelatorioFeed[] };
  /** OPTIONAL (module header): which report items' issues reach `gravarResultado`. */
  issueDeItemRelevante?(issue: unknown): boolean;
  /** OPTIONAL (module header): the valve the send acts on, from the raw one read at E1. */
  valvulaEfetiva?(
    valvula: ValvulaAmazon<F>,
    entrada: EntradaValvulaEfetivaLoteAmazon,
  ): ValvulaAmazon<F>;
  /** OPTIONAL (module header): told once of an end after the context that submits nothing. */
  aoFimSemEnvio?(
    ctx: ContextoLoteAmazon,
    entrada: TarefaEnviarFeedAmazon & { readonly fluxo: F },
    fim: FimSemEnvioLote,
  ): Promise<void>;
}
