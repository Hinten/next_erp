/**
 * The feed RECORD's pure rules (step 12a, PR 12-b): how the status of a
 * `feedsAmazon/{contaId}_{feedId}` document moves, what Amazon's
 * `processingStatus` means for it, the two clocks every feed is measured
 * against, and what each poll rung writes. Unwired in 12-b: the result handler
 * of 12-c is the caller.
 *
 * ## Forward-only
 *
 * `enviado < processando <` one of `concluido`, `falhou`, `cancelado`,
 * `abandonado` (the four terminals share one rank). {@link proximoStatusFeed}
 * answers the status to write, or `null` when the read is equal or BACKWARD:
 * the notification and the poll can both arrive, in any order, and a stale
 * rung must never move a concluded record back.
 *
 * ## A terminal status is never a rung's write
 *
 * The terminal status is the LAST write of a feed's tail, after its recovery is
 * enqueued and the lease released, because it is also the duplicate gate: once
 * it is stored, nothing may remain to do. So a rung that reads `DONE`, `FATAL`
 * or `CANCELLED` moves the record at most to `processando`
 * ({@link atualizacaoDaRodadaFeed}); the tail writes the terminal.
 *
 * ## Every rung advances the record, even when the status does not move
 *
 * `rodadas` (the highest rung that read Amazon, `max`-merged) and
 * `atualizadoEmMs` are written by EVERY rung: a `null` from
 * {@link proximoStatusFeed} suppresses only the status. A healthy chain
 * polling a slow feed hourly therefore never looks stale to the daily
 * backstop, which re-adopts only a chain that really died.
 *
 * ## The clocks
 *
 * Both count from `antesDoEnvioMs`, our clock right before `createFeed`, never
 * from the record's `criadoEmMs` (later by the submission's own latency):
 * {@link prazoDoFeed} (12 h: Amazon processes within 8 h, so a feed still open
 * then is overdue) and {@link abandonoDoFeed} (48 h: the chain stops polling).
 * Every value here is MILLISECONDS.
 */
import { STATUS_FEED_AMAZON } from '@delfrance/integrations-amazon-sp-api';
import {
  DESFECHO_FEED_AMAZON,
  type DesfechoFeedAmazon,
  STATUS_REGISTRO_FEED_AMAZON,
  type StatusRegistroFeedAmazon,
} from '@delfrance/schemas';

/** One hour, in ms. */
const HORA_MS = 3_600_000;

/** A feed still open this long after `antesDoEnvioMs` is overdue: the deadline (12 h). */
export const PRAZO_FEED_MS = 12 * HORA_MS;

/** A feed still open this long after `antesDoEnvioMs` is abandoned: the chain stops (48 h). */
export const ABANDONO_FEED_MS = 48 * HORA_MS;

/** Each status's rank: the four terminals share the last one. */
const ORDEM_DO_STATUS: Readonly<Record<StatusRegistroFeedAmazon, number>> = {
  [STATUS_REGISTRO_FEED_AMAZON.enviado]: 0,
  [STATUS_REGISTRO_FEED_AMAZON.processando]: 1,
  [STATUS_REGISTRO_FEED_AMAZON.concluido]: 2,
  [STATUS_REGISTRO_FEED_AMAZON.falhou]: 2,
  [STATUS_REGISTRO_FEED_AMAZON.cancelado]: 2,
  [STATUS_REGISTRO_FEED_AMAZON.abandonado]: 2,
};

/** The terminal rank. */
const ORDEM_TERMINAL = 2;

/** A status's rank, or `null` for a value outside the closed set (a raw read). */
function ordemDe(status: unknown): number | null {
  return typeof status === 'string' && Object.hasOwn(ORDEM_DO_STATUS, status)
    ? ORDEM_DO_STATUS[status as StatusRegistroFeedAmazon]
    : null;
}

/** Whether a status ends the feed (one of the four terminals). */
export function statusTerminalFeed(status: StatusRegistroFeedAmazon): boolean {
  return ordemDe(status) === ORDEM_TERMINAL;
}

/**
 * The status to write when the record holds `armazenado` and the read says
 * `lido`: `lido` when it is strictly LATER, else `null` (equal or backward —
 * the write is suppressed). A value outside the closed set on either side is
 * never written over and never written.
 */
export function proximoStatusFeed(
  armazenado: StatusRegistroFeedAmazon,
  lido: StatusRegistroFeedAmazon,
): StatusRegistroFeedAmazon | null {
  const de = ordemDe(armazenado);
  const para = ordemDe(lido);
  if (de === null || para === null) return null;
  return para > de ? lido : null;
}

/** What one `processingStatus` means for the record. */
export interface StatusDoProcessamentoFeed {
  readonly status: StatusRegistroFeedAmazon;
  /** `false` for a value Amazon's model does not list (or none): the caller logs it. */
  readonly reconhecido: boolean;
}

/** Every `processingStatus` the model lists, and what it means for the record. */
const STATUS_DO_PROCESSAMENTO: ReadonlyMap<string, StatusRegistroFeedAmazon> = new Map<
  string,
  StatusRegistroFeedAmazon
>([
  [STATUS_FEED_AMAZON.emFila, STATUS_REGISTRO_FEED_AMAZON.processando],
  [STATUS_FEED_AMAZON.emProcessamento, STATUS_REGISTRO_FEED_AMAZON.processando],
  [STATUS_FEED_AMAZON.concluido, STATUS_REGISTRO_FEED_AMAZON.concluido],
  [STATUS_FEED_AMAZON.fatal, STATUS_REGISTRO_FEED_AMAZON.falhou],
  [STATUS_FEED_AMAZON.cancelado, STATUS_REGISTRO_FEED_AMAZON.cancelado],
]);

/**
 * Amazon's `processingStatus`, an OPEN string, read EXACTLY (no case fold):
 * `IN_QUEUE` and `IN_PROGRESS` ⇒ `processando`, `DONE` ⇒ `concluido`, `FATAL` ⇒
 * `falhou`, `CANCELLED` ⇒ `cancelado`. Anything else, absent included, ⇒
 * `processando`, unrecognised: the chain keeps polling until a known value or
 * the abandonment, and never ends a feed on a word it does not know.
 */
export function statusDoProcessamento(
  processingStatus: string | null | undefined,
): StatusDoProcessamentoFeed {
  const status =
    typeof processingStatus === 'string'
      ? STATUS_DO_PROCESSAMENTO.get(processingStatus)
      : undefined;
  return status === undefined
    ? { status: STATUS_REGISTRO_FEED_AMAZON.processando, reconhecido: false }
    : { status, reconhecido: true };
}

/** A ms instant: a non-negative safe integer, or a `RangeError` (a programming error). */
function exigirMs(nome: string, valor: number): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`registroFeed.ts: ${nome} não é um instante em ms`);
  }
  return valor;
}

/** The feed's deadline: `antesDoEnvioMs` + {@link PRAZO_FEED_MS}. */
export function prazoDoFeed(antesDoEnvioMs: number): number {
  return exigirMs('antesDoEnvioMs', antesDoEnvioMs) + PRAZO_FEED_MS;
}

/** The feed's abandonment: `antesDoEnvioMs` + {@link ABANDONO_FEED_MS}. */
export function abandonoDoFeed(antesDoEnvioMs: number): number {
  return exigirMs('antesDoEnvioMs', antesDoEnvioMs) + ABANDONO_FEED_MS;
}

/**
 * The recovery's outcome for a terminal status; `null` for an open one
 * (`enviado`, `processando`). `incerto` is never a record's: a lost
 * `createFeed` answer leaves no record.
 */
export function desfechoDoStatus(status: StatusRegistroFeedAmazon): DesfechoFeedAmazon | null {
  switch (status) {
    case STATUS_REGISTRO_FEED_AMAZON.concluido:
      return DESFECHO_FEED_AMAZON.concluido;
    case STATUS_REGISTRO_FEED_AMAZON.falhou:
      return DESFECHO_FEED_AMAZON.falhou;
    case STATUS_REGISTRO_FEED_AMAZON.cancelado:
      return DESFECHO_FEED_AMAZON.cancelado;
    case STATUS_REGISTRO_FEED_AMAZON.abandonado:
      return DESFECHO_FEED_AMAZON.abandonado;
    case STATUS_REGISTRO_FEED_AMAZON.enviado:
    case STATUS_REGISTRO_FEED_AMAZON.processando:
      return null;
  }
}

/** What a rung needs of the stored record. */
export interface RegistroNaRodadaFeed {
  readonly status: StatusRegistroFeedAmazon;
  readonly rodadas: number;
}

/**
 * One rung's write: `rodadas` and `atualizadoEmMs` ALWAYS, `status` only when
 * it moves (the key is absent otherwise, so the patch never carries an
 * `undefined`).
 */
export interface AtualizacaoDaRodadaFeed {
  readonly rodadas: number;
  readonly atualizadoEmMs: number;
  readonly status?: StatusRegistroFeedAmazon;
}

/**
 * The write of the rung `rodada` that read `lido` at `agoraMs` (module header):
 * `rodadas = max(stored, rodada)`, `atualizadoEmMs = agoraMs`, and the status
 * forward-only, capped at `processando` (a terminal is the tail's last write,
 * never a rung's).
 */
export function atualizacaoDaRodadaFeed(
  armazenado: RegistroNaRodadaFeed,
  lido: StatusRegistroFeedAmazon,
  rodada: number,
  agoraMs: number,
): AtualizacaoDaRodadaFeed {
  if (!Number.isSafeInteger(rodada) || rodada < 0) {
    throw new RangeError('registroFeed.ts: rodada não é um inteiro não negativo');
  }
  exigirMs('agoraMs', agoraMs);
  const alvo = statusTerminalFeed(lido) ? STATUS_REGISTRO_FEED_AMAZON.processando : lido;
  const status = proximoStatusFeed(armazenado.status, alvo);
  const base = {
    rodadas: Math.max(armazenado.rodadas, rodada),
    atualizadoEmMs: agoraMs,
  };
  return status === null ? base : { ...base, status };
}
