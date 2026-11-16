/**
 * The feed core's PROVIDER SEAM (step 12a, PR 12-b): what a fluxo (stock in
 * step 12, price in step 13) hands the core to have its batch submitted as one
 * `JSON_LISTINGS_FEED`, plus the core's closed abort motivos and its timing
 * constants. TYPES and constants only: no provider exists yet, and the core
 * never imports a fluxo's module — the jobs root binds one per fluxo (12-c).
 *
 * ## The seam
 *
 *  - `membros` — the batch's SKUs, deduplicated: a block batch reads its
 *    `partes` stored parts, a window batch re-derives its window. `dados` is
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
 * ## The timing constants
 *
 *  - {@link MAX_FALHAS_SEGUIDAS_FEED} — consecutive failed feeds that open the
 *    breaker (window batches go per SKU instead);
 *  - {@link ESPERA_SONDA_DISJUNTOR_MS} — after the last failure, one window
 *    batch takes the lease as the half-open probe;
 *  - {@link ESPERA_MAXIMA_ATRAS_DE_FEED_MS} — a holder this old is slow: window
 *    batches stop waiting for it;
 *  - {@link ESPACO_MINIMO_ENTRE_FEEDS_MS} — the floor between two submissions
 *    of one fluxo;
 *  - {@link ESPERA_LOTE_EM_VEZ_S} — a waiting batch's re-enqueue delay;
 *  - {@link ESPERA_MAXIMA_LOTE_RECUPERACAO_MS} — how long a recovery-born
 *    window batch may wait for the lease before going per SKU.
 */
import type { MensagemListingsFeed } from '@delfrance/integrations-amazon-sp-api';
import type { JanelaFeedAmazon, MotivoContaAmazon, TimestampLike } from '@delfrance/schemas';
import type { Firestore } from 'firebase-admin/firestore';

import type { ContextoAmazon } from '../core/contexto';
import type { CamposLogAmazon, LoggerAmazon } from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { ProblemaSku } from './relatorioFeed';
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

/* ------------------------------ the timing constants -------------------------- */

/** Consecutive failed feeds that open the breaker. */
export const MAX_FALHAS_SEGUIDAS_FEED = 3;

/** A waiting batch's re-enqueue delay, in seconds. */
export const ESPERA_LOTE_EM_VEZ_S = 300;

/** The breaker's half-open probe: this long after the last failure (1 h). */
export const ESPERA_SONDA_DISJUNTOR_MS = 3_600_000;

/** A holder at least this old is slow (30 min). */
export const ESPERA_MAXIMA_ATRAS_DE_FEED_MS = 1_800_000;

/** The floor between two submissions of one fluxo (120 s). */
export const ESPACO_MINIMO_ENTRE_FEEDS_MS = 120_000;

/** How long a recovery-born window batch may wait for the lease (1 h). */
export const ESPERA_MAXIMA_LOTE_RECUPERACAO_MS = 3_600_000;

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
}
