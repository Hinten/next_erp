/**
 * The feed's POLL LADDER (step 12a, PR 12-b), pure: when the next result rung
 * runs, and when a feed is overdue or abandoned. Unwired in 12-b.
 *
 * Rung `n` is delayed {@link ESCADA_CONSULTA_FEED_S}`[n]` seconds after the
 * rung that enqueued it (rung 0 after the submission): 120, 300, 600, 900,
 * 1800, 1800, then hourly. So rung 3 runs 1,920 s (32 min) after the
 * submission, and rung 5 at 5,520 s.
 *
 * Every rung asks {@link proximaConsultaFeed} for its SUCCESSOR, measured from
 * `antesDoEnvioMs` (our clock right before `createFeed`), never from the
 * record's `criadoEmMs`:
 *
 *  - before the deadline (`antesDoEnvioMs` + 12 h): `consultar`, the ladder's
 *    next delay;
 *  - at or past it: `prazo` — the rung raises the fluxo's aviso (an idempotent
 *    per-conta row) and the chain keeps polling HOURLY, because a late `DONE`
 *    still carries a report;
 *  - at or past the abandonment (`antesDoEnvioMs` + 48 h): `abandonar` — no
 *    successor; this rung ends the feed without a download.
 *
 * Both boundaries are INCLUSIVE on the later answer. Delays are WHOLE SECONDS
 * (what a Cloud Tasks schedule delay takes).
 */
import { abandonoDoFeed, prazoDoFeed } from './registroFeed';

/** The first six rungs' delays, in seconds; rung 6 and later wait {@link CONSULTA_HORARIA_FEED_S}. */
export const ESCADA_CONSULTA_FEED_S = [120, 300, 600, 900, 1800, 1800] as const;

/** The delay of every rung past the ladder, and of every rung past the deadline: one hour. */
export const CONSULTA_HORARIA_FEED_S = 3600;

/** What a rung does about its successor. */
export const TIPO_CONSULTA_FEED = {
  consultar: 'consultar',
  prazo: 'prazo',
  abandonar: 'abandonar',
} as const;

export type ProximaConsultaFeed =
  | { readonly tipo: typeof TIPO_CONSULTA_FEED.consultar; readonly atrasoS: number }
  | { readonly tipo: typeof TIPO_CONSULTA_FEED.prazo; readonly atrasoS: number }
  | { readonly tipo: typeof TIPO_CONSULTA_FEED.abandonar };

/**
 * The rung being SCHEDULED (module header): `rodadaAgendada` is ITS index —
 * the running rung's index + 1, or 0 for the first rung after the
 * submission — and a `consultar` answer is that rung's own ladder delay. The
 * `prazo` and `abandonar` answers are judged at `agoraMs`, the running rung's
 * clock.
 *
 * @throws {RangeError} a negative or fractional rung, or a clock that is not a
 *   ms instant (a programming error).
 */
export function proximaConsultaFeed(
  rodadaAgendada: number,
  agoraMs: number,
  antesDoEnvioMs: number,
): ProximaConsultaFeed {
  if (!Number.isSafeInteger(rodadaAgendada) || rodadaAgendada < 0) {
    throw new RangeError('escadaFeed.ts: rodada não é um inteiro não negativo');
  }
  if (!Number.isSafeInteger(agoraMs) || agoraMs < 0) {
    throw new RangeError('escadaFeed.ts: agoraMs não é um instante em ms');
  }
  if (agoraMs >= abandonoDoFeed(antesDoEnvioMs)) return { tipo: TIPO_CONSULTA_FEED.abandonar };
  if (agoraMs >= prazoDoFeed(antesDoEnvioMs)) {
    return { tipo: TIPO_CONSULTA_FEED.prazo, atrasoS: CONSULTA_HORARIA_FEED_S };
  }
  // Past the ladder's last rung the index reads `undefined`: hourly.
  const atrasoS = ESCADA_CONSULTA_FEED_S[rodadaAgendada] ?? CONSULTA_HORARIA_FEED_S;
  return { tipo: TIPO_CONSULTA_FEED.consultar, atrasoS };
}
