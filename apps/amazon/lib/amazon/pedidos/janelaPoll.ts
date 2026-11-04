/**
 * The backstop poll's WINDOW ALGEBRA (master plan step 4, PR 4-a). Pure: no
 * clock, no I/O, no environment — every instant is a parameter.
 *
 * ## Two units, never mixed by accident
 *
 * - The CURSOR and every bookkeeping instant are MILLISECONDS (§4.ii).
 * - Amazon's row stamps (`lastUpdatedTime`) are read as MICROSECONDS too,
 *   because `vistos` and the poll's failure-document id must tell two changes
 *   inside one millisecond apart. Both units come from the SAME string, through
 *   the same parser ({@link lerLinhaPollAmazon}: `parseIsoToMicros` and
 *   `parseIsoToMillis`): no clock is ever converted from one unit to the other
 *   here — that stays `avisos/avisos.ts`'s job, for the aviso clocks.
 *
 * ## An instant is compared as an INSTANT, never as text
 *
 * `…T10:00:00Z`, `…T10:00:00.000Z` and `…T07:00:00-03:00` are the same instant,
 * and `…T10:00:00.001Z` is a later one: every comparison here is on numbers. An
 * ISO string WITHOUT an offset is refused (`null`): `parseIsoToMicros` would
 * read it as UTC, which is a guess.
 *
 * ## The cursor moves FORWARD only, and never past the drain's start − 5 min
 *
 * {@link proximoCursorMs}: `max(stored, min(maxRowMs, inicioDrenagemMs −
 * CAP_INICIO_MS))`, and an empty window keeps the stored cursor (step-3/4 plan
 * §3 decision 20). The cap guards against an undocumented offset-style
 * pagination skipping a row that moved while the drain ran; the ten-minute
 * overlap ({@link SOBREPOSICAO_MS}) re-reads the tail, and `vistos` stops the
 * overlap from re-enqueuing on every idle tick.
 */
import { parseIsoToMicros, parseIsoToMillis } from '@delfrance/core/datetime';
import {
  LAST_UPDATED_AFTER_POLL_AMAZON_REGEX,
  PEDIDO_AMAZON_REGEX,
  type PendentePollAmazon,
} from '@delfrance/schemas';

import {
  CAP_INICIO_MS,
  JANELA_VISTOS_MS,
  MAX_VISTOS,
  SOBREPOSICAO_MS,
  VIDA_TOKEN_MS,
} from './orcamentoPoll';

/* -------------------------------------------------------------------------- */
/*                                 The window                                 */
/* -------------------------------------------------------------------------- */

/**
 * An instant (ms) as `lastUpdatedAfter` sends it: FLOORED to the whole second,
 * UTC, `Z` — `2027-01-15T09:50:00Z`. Fixed width, so the same instant always
 * gives the same bytes.
 *
 * @throws {TypeError} for a value that is not a non-negative safe integer, or
 *   outside four-digit years: a null cursor must never get here (in JS,
 *   `null − 600000` is a 1969 instant — the seller's whole history).
 */
export function isoSegundosZ(ms: number): string {
  if (!Number.isSafeInteger(ms) || ms < 0) {
    throw new TypeError('isoSegundosZ: o instante precisa ser um inteiro seguro não negativo');
  }
  const texto = `${new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19)}Z`;
  if (!LAST_UPDATED_AFTER_POLL_AMAZON_REGEX.test(texto)) {
    throw new TypeError('isoSegundosZ: instante fora dos anos de quatro dígitos');
  }
  return texto;
}

/** A fresh window's `lastUpdatedAfter`: the cursor minus the overlap, floored to the second. */
export function limiteInferior(cursorMs: number): string {
  return isoSegundosZ(cursorMs - SOBREPOSICAO_MS);
}

/**
 * The cursor after a COMPLETE drain (module header): forward only, capped at
 * the drain's start minus {@link CAP_INICIO_MS}; `maiorLinhaMs === null` (an
 * empty window) keeps the stored one.
 */
export function proximoCursorMs(p: {
  readonly armazenadoMs: number;
  readonly maiorLinhaMs: number | null;
  readonly inicioDrenagemMs: number;
}): number {
  if (p.maiorLinhaMs === null) return p.armazenadoMs;
  return Math.max(p.armazenadoMs, Math.min(p.maiorLinhaMs, p.inicioDrenagemMs - CAP_INICIO_MS));
}

/**
 * Whether a stored drain can be resumed now: a null token (page 1 of the stored
 * window) always; a real one only while it is younger than {@link VIDA_TOKEN_MS}
 * (Amazon expires it at 24 h).
 */
export function pendenteRetomavel(pendente: PendentePollAmazon, agoraMs: number): boolean {
  return pendente.paginationToken === null || pendente.tokenEmMs + VIDA_TOKEN_MS > agoraMs;
}

/* -------------------------------------------------------------------------- */
/*                                  The rows                                  */
/* -------------------------------------------------------------------------- */

/**
 * ISO-8601 with an EXPLICIT offset (`Z`, `±HH:MM` or `±HHMM`), seconds
 * required, an optional fraction. An offset-less string is refused: the parser
 * would read it as UTC, which is a guess.
 */
const ISO_COM_OFFSET =
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:[.,][0-9]{1,9})?(?:[Zz]|[+-][0-9]{2}:?[0-9]{2})$/;

/** An instant Amazon stamped, in µs and in ms — both from the same string — or `null`. */
export interface InstanteAmazon {
  readonly us: number;
  readonly ms: number;
}

/** Read an Amazon ISO instant (module header): offset REQUIRED, non-negative, both units. */
export function lerInstanteAmazon(texto: string): InstanteAmazon | null {
  if (!ISO_COM_OFFSET.test(texto)) return null;
  const us = parseIsoToMicros(texto);
  const ms = parseIsoToMillis(texto);
  if (us === null || ms === null || us < 0 || ms < 0) return null;
  return { us, ms };
}

/** One `searchOrders` row, as the poll decides on it. */
export interface LinhaPollAmazon {
  /** The 3-7-7 order id. */
  readonly orderId: string;
  /** `lastUpdatedTime`, µs: what `vistos` and the failure-document id carry. */
  readonly lastUpdatedUs: number;
  /** The same instant, ms: what the cursor is compared with. */
  readonly lastUpdatedMs: number;
}

/** An own, data-valued string property (a getter is never invoked), or `null`. */
function texto(linha: object, chave: string): string | null {
  const d = Object.getOwnPropertyDescriptor(linha, chave);
  return d !== undefined && 'value' in d && typeof d.value === 'string' ? d.value : null;
}

/**
 * One row of the page (the package leaves rows `unknown` on purpose): its
 * `orderId` by the 3-7-7 grammar and its `lastUpdatedTime` with an offset, or
 * `null` — an invalid row, which the poll COUNTS and lets block the advance.
 * Nothing else of the row is read (D5).
 */
export function lerLinhaPollAmazon(bruta: unknown): LinhaPollAmazon | null {
  if (typeof bruta !== 'object' || bruta === null || Array.isArray(bruta)) return null;
  const orderId = texto(bruta, 'orderId');
  const carimbo = texto(bruta, 'lastUpdatedTime');
  if (orderId === null || carimbo === null || !PEDIDO_AMAZON_REGEX.test(orderId)) return null;
  const instante = lerInstanteAmazon(carimbo);
  if (instante === null) return null;
  return { orderId, lastUpdatedUs: instante.us, lastUpdatedMs: instante.ms };
}

/* -------------------------------------------------------------------------- */
/*                                   vistos                                   */
/* -------------------------------------------------------------------------- */

/**
 * Whether a row must be enqueued: its stamp is NEWER (µs) than the one last
 * enqueued for that order. An equal stamp is the same change: not enqueued.
 */
export function deveEnfileirar(vistoUs: number | undefined, linhaUs: number): boolean {
  return vistoUs === undefined || linhaUs > vistoUs;
}

/** `base` and this run's additions, the NEWER stamp winning per order. A new object. */
export function mesclarVistos(
  base: Readonly<Record<string, number>>,
  novos: Readonly<Record<string, number>>,
): Record<string, number> {
  const saida: Record<string, number> = { ...base };
  for (const [orderId, us] of Object.entries(novos)) {
    const atual = saida[orderId];
    if (atual === undefined || us > atual) saida[orderId] = us;
  }
  return saida;
}

/**
 * `vistos` pruned against the cursor that will be STORED: rows stamped before
 * `cursorMs − JANELA_VISTOS_MS` can no longer be re-listed (the window starts
 * at cursor − overlap), so they are dropped; then at most {@link MAX_VISTOS},
 * the OLDEST dropped first (at worst a harmless re-enqueue). A row's stamp is
 * compared by its whole-millisecond part. A new object, deterministic order.
 */
export function podarVistos(
  vistos: Readonly<Record<string, number>>,
  cursorMs: number,
): Record<string, number> {
  const limiteMs = cursorMs - JANELA_VISTOS_MS;
  const mantidos = Object.entries(vistos)
    .filter(([, us]) => Math.floor(us / 1000) >= limiteMs)
    .sort(([a, ua], [b, ub]) => (ub !== ua ? ub - ua : a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MAX_VISTOS);
  return Object.fromEntries(mantidos);
}

/* -------------------------------------------------------------------------- */
/*                               The bootstrap                                */
/* -------------------------------------------------------------------------- */

/**
 * The look-back the bootstrap anchors a cursorless conta at, read from the
 * environment the poll's deps carry (the functions root's, PR 4-b; W7 sets it).
 */
export const LOOKBACK_POLL_ENV_AMAZON = 'AMAZON_POLL_LOOKBACK_H';

/** The look-back when the variable is unset or `''`, in hours (step-3/4 plan §3 decision 26). */
export const LOOKBACK_POLL_H_PADRAO = 24;

/** The largest look-back accepted, in hours (30 days). */
export const LOOKBACK_POLL_H_MAXIMO = 720;

const LOOKBACK_GRAMATICA = /^[1-9][0-9]{0,3}$/;

/**
 * `AMAZON_POLL_LOOKBACK_H` as hours, or `null` when it is INVALID — never the
 * default: a typo must stay loud (the conta's refusal `lookback-invalido`)
 * rather than silently re-import weeks of migrated orders. Unset or `''` is the
 * default; anything else must be 1–4 plain digits, no sign, no space, no
 * leading zero, at most {@link LOOKBACK_POLL_H_MAXIMO}. Never trimmed (the
 * valves' rule: a stray space is a misconfiguration).
 */
export function lerLookbackHorasAmazon(bruto: string | undefined): number | null {
  if (bruto === undefined || bruto === '') return LOOKBACK_POLL_H_PADRAO;
  if (!LOOKBACK_GRAMATICA.test(bruto)) return null;
  const horas = Number(bruto);
  return horas <= LOOKBACK_POLL_H_MAXIMO ? horas : null;
}

/** The cursor a cursorless conta is anchored at: `agora − horas`, in ms. */
export function ancoraDoBootstrapMs(agoraMs: number, horas: number): number {
  return agoraMs - horas * 60 * 60 * 1000;
}
