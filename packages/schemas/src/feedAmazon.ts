import { z } from 'zod';
import { CONTA_ID_AMAZON_REGEX } from './notificacaoAmazon';
import { type TimestampLike, ttlExpiry } from './shared/ttl';

/**
 * The two documents of the Amazon `JSON_LISTINGS_FEED` core (step 12a, PR
 * 12-b): the per-submission RECORD and the per-(fluxo, conta) LEASE that keeps
 * one feed in flight at a time. Both are TOP-LEVEL and Admin-only.
 *
 * ## `feedsAmazon/{contaId}_{feedId}` — the record
 *
 * One document per `createFeed` Amazon accepted, created after the lease names
 * the `feedId` (a `create`, so a retry finds it recorded). Amazon's `feedId` is
 * unique only per SELLER, so the id carries the conta: {@link idRegistroFeedAmazon}.
 * Every later write moves `status` FORWARD only (`enviado < processando <` one
 * terminal); the terminal status is the LAST write of a feed's tail, so it is
 * also the duplicate gate. Every poll rung advances `rodadas` and
 * `atualizadoEmMs` even when the status does not move, so a live chain never
 * looks stale. Nothing ever queries it by status (the lease names the in-flight
 * feed, each poll rung names its record), so it has NO composite index.
 *
 * The input document is NEVER stored: per-SKU outcomes are attributed by the
 * `sku` each report issue carries, and only counts land here.
 *
 * ## `feedsAmazonEmCurso/{fluxo}-{contaId}` — the lease
 *
 * `livre → montando → enviando → enviado → livre`, every write under a native
 * precondition. With the doc id's fluxo and conta it holds everything the
 * record needs, so a run that lost the record between the two writes can
 * re-create it from here. Besides the in-flight state it keeps four clocks and
 * a counter that outlive each feed (a take keeps them):
 *
 *  - `pendenteDesdeMs` — the earliest window start of the tick-born window
 *    batches turned away while the lease was held; MIN-merged, never
 *    overwritten, and consumed by the next release (or the writes that hand it
 *    to a recovery without releasing);
 *  - `falhasSeguidas` and `ultimaFalhaEmMs` — consecutive releases that raised
 *    the fluxo's feed-failure aviso, reset by a completed feed: the breaker and
 *    its half-open probe's clock;
 *  - `ultimoEnvioMs` — the last `createFeed` call's own clock: the submission
 *    floor between two feeds;
 *  - `ultimoFeedConcluidoEmMs` — the last release of a feed that may have
 *    applied.
 *
 * The lease is NEVER TTL-stamped: it has no `expiraEm` field at all, so a
 * stray stamp never reaches the document through its handle.
 *
 * ## Units
 *
 * Every INSTANT stored as a number is MILLISECONDS since epoch, a strict
 * non-negative safe integer (never the tolerant `millisSinceEpoch()`, whose
 * coercion would turn a hand-edited value into a different instant). The other
 * numbers are plain counts, and `resultado` keeps Amazon's counts as sent. The
 * two instants that are not numbers are `relogioDesfecho`, a Firestore
 * `Timestamp` (a read's `readTime`, the aviso clock of a feed's outcome, reused
 * by every later attempt), and `expiraEm`, the record's TTL stamp
 * (`./shared/ttl`).
 *
 * ## Admin-only / default-deny
 *
 * NOT registered in `ALL_DOMAINS` and no Meta, so the rules generator emits no
 * match block and no client can read either. Unknown keys are STRIPPED. Bare
 * schemas, never a `{ schema, meta }` export (`registry.test.ts`); the Admin
 * handles in `@delfrance/data/admin/collections` spell the paths.
 */

/** A non-negative SAFE integer: what every compared number here is. */
function inteiroSeguro() {
  return z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
}

/* -------------------------------------------------------------------------- */
/*                                 Grammars                                   */
/* -------------------------------------------------------------------------- */

/**
 * The `feedId` grammar: digits only, 1 to 20. Restated from the SP-API
 * package's `FEED_ID_AMAZON_REGEX`, which a schema cannot import; the app's
 * `feeds/tarefaLote.test.ts` pins the two sources and flags equal. A `feedId`
 * holds no `_`, so a record id splits at its LAST `_` unambiguously.
 */
export const FEED_ID_REGISTRO_AMAZON_REGEX = /^[0-9]{1,20}$/;

/**
 * An id the feed core carries (a run's `execucaoId`, a depósito id): letters,
 * digits, `_` and `-`, 1 to 128. Every auto-id, UUID and hex digest fits.
 */
export const ID_LOTE_FEED_AMAZON_REGEX = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * A producer's label (`origem`): a lowercase token, 1 to 32. The core never
 * branches on it; it reaches the log lines, so it is never free text.
 */
export const ORIGEM_LOTE_FEED_AMAZON_REGEX = /^[a-z][a-z0-9-]{0,31}$/;

/* -------------------------------------------------------------------------- */
/*                              Closed vocabularies                           */
/* -------------------------------------------------------------------------- */

/** The fluxos a feed can carry: stock (step 12) and price (step 13). */
export const fluxoFeedAmazonSchema = z.enum(['estoque', 'preco']);
export type FluxoFeedAmazon = z.infer<typeof fluxoFeedAmazonSchema>;
export const FLUXO_FEED_AMAZON = {
  estoque: 'estoque',
  preco: 'preco',
} as const satisfies Record<string, FluxoFeedAmazon>;

/**
 * The batch kind a feed carried: `blocos` (members read from stored drift
 * blocks) or `janela` (members re-derived from a bounded movement window).
 */
export const tipoLoteFeedAmazonSchema = z.enum(['blocos', 'janela']);
export type TipoLoteFeedAmazon = z.infer<typeof tipoLoteFeedAmazonSchema>;
export const TIPO_LOTE_FEED_AMAZON = {
  blocos: 'blocos',
  janela: 'janela',
} as const satisfies Record<string, TipoLoteFeedAmazon>;

/** The record's status, in order: `enviado < processando <` one of the four terminals. */
export const statusRegistroFeedAmazonSchema = z.enum([
  'enviado',
  'processando',
  'concluido',
  'falhou',
  'cancelado',
  'abandonado',
]);
export type StatusRegistroFeedAmazon = z.infer<typeof statusRegistroFeedAmazonSchema>;
export const STATUS_REGISTRO_FEED_AMAZON = {
  enviado: 'enviado',
  processando: 'processando',
  concluido: 'concluido',
  falhou: 'falhou',
  cancelado: 'cancelado',
  abandonado: 'abandonado',
} as const satisfies Record<string, StatusRegistroFeedAmazon>;

/** The lease's state (module header). */
export const estadoVezFeedAmazonSchema = z.enum(['livre', 'montando', 'enviando', 'enviado']);
export type EstadoVezFeedAmazon = z.infer<typeof estadoVezFeedAmazonSchema>;
export const ESTADO_VEZ_FEED_AMAZON = {
  livre: 'livre',
  montando: 'montando',
  enviando: 'enviando',
  enviado: 'enviado',
} as const satisfies Record<string, EstadoVezFeedAmazon>;

/**
 * How a feed ended, as its recovery reads it: the four terminal statuses, plus
 * `incerto` — a `createFeed` whose answer was lost, recovered after the wait
 * with no record at all.
 */
export const desfechoFeedAmazonSchema = z.enum([
  'concluido',
  'falhou',
  'cancelado',
  'abandonado',
  'incerto',
]);
export type DesfechoFeedAmazon = z.infer<typeof desfechoFeedAmazonSchema>;
export const DESFECHO_FEED_AMAZON = {
  concluido: 'concluido',
  falhou: 'falhou',
  cancelado: 'cancelado',
  abandonado: 'abandonado',
  incerto: 'incerto',
} as const satisfies Record<string, DesfechoFeedAmazon>;

/* -------------------------------------------------------------------------- */
/*                                The window                                  */
/* -------------------------------------------------------------------------- */

/**
 * A window batch's bounded movement window `(desdeMs, ateMs]` at one depósito,
 * and its keep rule: `manterDesdeMs` keeps the rows stamped after it, and
 * `commitAposMs` the rows COMMITTED after it. A FUNCTION returning fresh
 * builders, so the record, the lease and the jobs payload spread the same
 * fields without sharing a refined object.
 */
export function camposJanelaFeedAmazon() {
  return {
    desdeMs: inteiroSeguro(),
    ateMs: inteiroSeguro(),
    manterDesdeMs: inteiroSeguro().nullable(),
    commitAposMs: inteiroSeguro().nullable(),
    depositoId: z.string().regex(ID_LOTE_FEED_AMAZON_REGEX),
  };
}

interface JanelaVerificavel {
  readonly desdeMs: number;
  readonly ateMs: number;
  readonly manterDesdeMs: number | null;
  readonly commitAposMs: number | null;
}

/**
 * The window's own refusals: an empty or reversed window (`desdeMs ≥ ateMs`),
 * and a window that keeps nothing (both keep fields `null`). For a
 * `superRefine`.
 */
export function verificarJanelaFeedAmazon(janela: JanelaVerificavel, ctx: z.RefinementCtx): void {
  if (janela.desdeMs >= janela.ateMs) {
    ctx.addIssue({
      code: 'custom',
      message: 'janela vazia ou invertida: desdeMs deve ser menor que ateMs',
      path: ['desdeMs'],
    });
  }
  if (janela.manterDesdeMs === null && janela.commitAposMs === null) {
    ctx.addIssue({
      code: 'custom',
      message: 'janela sem regra de manutenção: manterDesdeMs e commitAposMs são ambos null',
      path: ['manterDesdeMs'],
    });
  }
}

/** The window as the record and the lease store it (unknown keys stripped). */
export const janelaFeedAmazonSchema = z
  .object(camposJanelaFeedAmazon())
  .superRefine(verificarJanelaFeedAmazon);
export type JanelaFeedAmazon = z.infer<typeof janelaFeedAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                The record                                  */
/* -------------------------------------------------------------------------- */

/** A Firestore `Timestamp` of either SDK, recognised by shape (a read's `readTime`). */
function ehTimestamp(valor: unknown): valor is TimestampLike {
  if (valor === null || typeof valor !== 'object') return false;
  const v = valor as Partial<TimestampLike>;
  return (
    typeof v.toMillis === 'function' &&
    typeof v.seconds === 'number' &&
    typeof v.nanoseconds === 'number'
  );
}

/**
 * A stored Firestore `Timestamp`, returned UNCHANGED: never a number and never
 * a `Date`, because an aviso clock taken from a `readTime` is compared on the
 * Firestore timeline it came from.
 */
function instanteFirestore() {
  return z.custom<TimestampLike>(ehTimestamp, {
    message: 'esperado um Timestamp do Firestore (um readTime), nunca um número ou uma Date',
  });
}

/** Amazon's processing report summary, as counts: stored as Amazon sent them, any integer. */
export const resultadoFeedAmazonSchema = z.object({
  erros: z.number().int(),
  avisos: z.number().int(),
  processadas: z.number().int(),
  aceitas: z.number().int(),
  invalidas: z.number().int(),
});
export type ResultadoFeedAmazon = z.infer<typeof resultadoFeedAmazonSchema>;

/** The report issues that name no SKU: counted, never stored. */
export const problemasSemSkuFeedAmazonSchema = z.object({
  erros: inteiroSeguro(),
  avisos: inteiroSeguro(),
});
export type ProblemasSemSkuFeedAmazon = z.infer<typeof problemasSemSkuFeedAmazonSchema>;

/** `feedsAmazon/{contaId}_{feedId}` (module header). */
export const registroFeedAmazonSchema = z.object({
  contaId: z.string().regex(CONTA_ID_AMAZON_REGEX),
  feedId: z.string().regex(FEED_ID_REGISTRO_AMAZON_REGEX),
  fluxo: fluxoFeedAmazonSchema,
  /** The send run that submitted it. */
  execucaoId: z.string().regex(ID_LOTE_FEED_AMAZON_REGEX),
  /** The producer's label, for the lines; opaque to the core. */
  origem: z.string().regex(ORIGEM_LOTE_FEED_AMAZON_REGEX),
  tipoLote: tipoLoteFeedAmazonSchema,
  /** A window batch's own window, copied from the lease; null for a block batch. */
  janela: janelaFeedAmazonSchema.nullable().default(null),
  /** ms — our clock BEFORE the batch's first read (its snapshot). */
  snapshotEmMs: inteiroSeguro(),
  /** ms — our clock right before `createFeed`: the ladder, the deadline and the abandonment count from it. */
  antesDoEnvioMs: inteiroSeguro(),
  /** The document's message count (one per SKU). */
  mensagens: z.number().int().min(1),
  /** The document's UTF-8 byte count. */
  bytes: z.number().int().min(1),
  status: statusRegistroFeedAmazonSchema,
  /** Amazon's last `processingStatus`, as read: an OPEN string. */
  processingStatus: z.string().nullable().default(null),
  /** The report's summary; null until a report was read (or when there was none). */
  resultado: resultadoFeedAmazonSchema.nullable().default(null),
  problemasSemSku: problemasSemSkuFeedAmazonSchema.default({ erros: 0, avisos: 0 }),
  /** SKUs the report attributed at least one problem to. */
  skusComProblema: inteiroSeguro().default(0),
  /** Of those, the SKUs written back (bounded; the rest only counted). */
  skusGravados: inteiroSeguro().default(0),
  /** The highest poll rung that read Amazon. */
  rodadas: inteiroSeguro().default(0),
  /** ms. */
  criadoEmMs: inteiroSeguro(),
  /** ms — advanced by EVERY poll rung, whether or not the status moved. */
  atualizadoEmMs: inteiroSeguro(),
  /** ms — `antesDoEnvioMs` plus the feed's deadline. */
  prazoEmMs: inteiroSeguro(),
  /** ms — when the terminal status was written; null before. */
  concluidoEmMs: inteiroSeguro().nullable().default(null),
  /** The outcome's aviso clock: stored once, reused by every later attempt (module header). */
  relogioDesfecho: instanteFirestore().nullable().default(null),
  /**
   * TTL expiry (`./shared/ttl`, policy `feedsAmazon`): stamped once, at
   * creation, `RETENCAO_FEED_AMAZON_DIAS` after `criadoEmMs`. A real `Date` on
   * write — a numeric epoch is REFUSED, because the policy silently ignores one
   * and the record would never expire.
   */
  expiraEm: ttlExpiry().nullable().optional(),
});
export type RegistroFeedAmazon = z.infer<typeof registroFeedAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                 The lease                                  */
/* -------------------------------------------------------------------------- */

/** `feedsAmazonEmCurso/{fluxo}-{contaId}` (module header). Never TTL-stamped. */
export const vezFeedAmazonSchema = z.object({
  estado: estadoVezFeedAmazonSchema,
  /** The run holding (or that last held) the lease. */
  execucaoId: z.string().regex(ID_LOTE_FEED_AMAZON_REGEX).nullable().default(null),
  /** Amazon's id, once `enviado`. */
  feedId: z.string().regex(FEED_ID_REGISTRO_AMAZON_REGEX).nullable().default(null),
  /** ms. */
  snapshotEmMs: inteiroSeguro().nullable().default(null),
  /** ms. */
  antesDoEnvioMs: inteiroSeguro().nullable().default(null),
  mensagens: z.number().int().min(1).nullable().default(null),
  bytes: z.number().int().min(1).nullable().default(null),
  /** ms — the lease's expiry. */
  ateMs: inteiroSeguro(),
  /** ms. */
  atualizadoEmMs: inteiroSeguro(),
  /** The holder's producer label, copied into a re-created record. */
  origem: z.string().regex(ORIGEM_LOTE_FEED_AMAZON_REGEX).nullable().default(null),
  /** The holder's batch kind, copied into a re-created record. */
  tipoLote: tipoLoteFeedAmazonSchema.nullable().default(null),
  /** The holder's window (a window batch), copied into a re-created record. */
  janela: janelaFeedAmazonSchema.nullable().default(null),
  /** ms — the earliest start of the window batches turned away; MIN-merged (module header). */
  pendenteDesdeMs: inteiroSeguro().nullable().default(null),
  /** Consecutive releases that raised the feed-failure aviso; 0 after a completed feed. */
  falhasSeguidas: inteiroSeguro().default(0),
  /** ms — stamped with every `falhasSeguidas` + 1. */
  ultimaFalhaEmMs: inteiroSeguro().nullable().default(null),
  /** ms — the `antesDoEnvioMs` of this fluxo's last `createFeed` call. */
  ultimoEnvioMs: inteiroSeguro().nullable().default(null),
  /** ms — the last release of a feed that may have applied. */
  ultimoFeedConcluidoEmMs: inteiroSeguro().nullable().default(null),
});
export type VezFeedAmazon = z.infer<typeof vezFeedAmazonSchema>;

/* -------------------------------------------------------------------------- */
/*                                  The ids                                   */
/* -------------------------------------------------------------------------- */

/**
 * The record's doc id, `<contaId>_<feedId>`. The conta grammar admits `_` and
 * the `feedId` grammar does not, so the id splits at its LAST `_`.
 *
 * @throws {RangeError} an id outside its grammar (the message names the
 *   grammar, never the value).
 */
export function idRegistroFeedAmazon(contaId: string, feedId: string): string {
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('feedAmazon.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  if (!FEED_ID_REGISTRO_AMAZON_REGEX.test(feedId)) {
    throw new RangeError('feedAmazon.ts: feedId fora de FEED_ID_REGISTRO_AMAZON_REGEX');
  }
  return `${contaId}_${feedId}`;
}

/**
 * The lease's doc id, `<fluxo>-<contaId>`. No fluxo holds `-`, so the id
 * splits at its FIRST `-`.
 *
 * @throws {RangeError} a fluxo outside {@link fluxoFeedAmazonSchema}, or a
 *   conta outside its grammar.
 */
export function idVezFeedAmazon(fluxo: FluxoFeedAmazon, contaId: string): string {
  if (!fluxoFeedAmazonSchema.safeParse(fluxo).success) {
    throw new RangeError('feedAmazon.ts: fluxo fora de fluxoFeedAmazonSchema');
  }
  if (!CONTA_ID_AMAZON_REGEX.test(contaId)) {
    throw new RangeError('feedAmazon.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  return `${fluxo}-${contaId}`;
}
