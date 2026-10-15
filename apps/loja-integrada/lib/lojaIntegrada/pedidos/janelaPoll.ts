/**
 * The order poller's WINDOW: which slice of `GET /v1/pedido/search` one run
 * reads, which rows it enqueues, where its cursor may move, and the three
 * checks that stop a run from advancing (master plan step 3, PR 3-e). Pure:
 * the clock is a parameter (`agoraMs`), and nothing here reads, writes or
 * calls anything.
 *
 * ## Why the window is this wide (each margin waits on a capture)
 *
 * Whether the platform orders the rows, whether its filter is inclusive, and
 * which zone its naive stamps and its filter are in are all undocumented. So:
 *
 *  - the window starts {@link SOBREPOSICAO_S} before the cursor: 120 s for
 *    ties, plus a 4 h zone margin (3 h, and 1 h in case daylight saving
 *    returns). {@link deveEnfileirarLi} against `vistos` is what keeps the
 *    overlap from re-enqueuing the same order on every idle tick;
 *  - a row below the TOLERANCE bound ({@link limiteDeToleranciaLi}, the
 *    window's start minus {@link TOLERANCIA_FILTRO_S}) cannot be explained by a
 *    zone mismatch: the filter was ignored ({@link filtroIgnoradoLi}). `vistos`
 *    is pruned below that SAME bound ({@link podarVistosLi}), so a legitimate
 *    row a zone mismatch brings back is still recognised;
 *  - the bootstrap bound is rendered in São Paulo time, the wider of the two
 *    candidate zones ({@link limiteDeBootstrapLi}); the cursor's ceiling in
 *    UTC, the later one ({@link tetoDoCursorLi});
 *  - the cursor is the max stamp over a WHOLE, consistent drain, floored to the
 *    second and never moved backwards ({@link proximoCursorLi}); the order of
 *    the rows is never assumed.
 *
 * ## What blocks an advance
 *
 *  - {@link filtroIgnoradoLi} — `filtro-ignorado`: stop at once;
 *  - {@link janelaGrandeDemaisLi} — `janela-grande-demais`: page 1 already says
 *    the window holds more rows than {@link MAX_PAGINAS_POLL} pages can drain;
 *  - {@link consistenciaDaJanelaLi} — `janela-instavel`: fewer distinct rows
 *    than the largest `total_count` the pages announced (skipped, and logged,
 *    when no page carried one).
 *
 * ## Units
 *
 * Bounds are naive seconds (`AAAA-MM-DDTHH:MM:SS`), stamps are canonical
 * (26 characters); see `dataLi.ts`. Arithmetic is on the naive fields, so no
 * zone and no daylight-saving rule can enter it; only the bootstrap and the
 * zone flag read an explicit zone, `FUSO_FISCAL`.
 */
import { formatIsoNoFuso } from '@delfrance/core/datetime';
import { CURSOR_POLL_LI_REGEX, FUSO_FISCAL, MARCA_DATA_ILEGIVEL_LI } from '@delfrance/schemas';

import { canonicaDoCursorLi, cursorDaDataLi, deslocarDataLi, renderizarDataLi } from './dataLi';
import { MAX_PAGINAS_POLL } from './orcamentoPoll';

/** The overlap before the cursor, in s: 120 for ties + 4 h of zone margin. */
export const SOBREPOSICAO_S = 14_520;

/** Below the window's start by more than this (4 h + 10 min, in s), a row means the filter was ignored. */
export const TOLERANCIA_FILTRO_S = 15_000;

/**
 * The clock slack, in s: how far past now the cursor may go before it is
 * clamped (`carimbo-no-futuro`), and how far past now a stamp may be before it
 * is `zona-suspeita`. An order changed after the clock was read, or a platform
 * clock a little ahead of ours, is not a zone error; a real one shows as hours.
 */
export const FOLGA_RELOGIO_S = 600;

/** The bootstrap look-back when `LOJA_INTEGRADA_POLL_LOOKBACK_H` is unset or blank, in hours. */
export const LOOKBACK_H_PADRAO = 72;

/** The largest look-back accepted, in hours (90 days). */
export const LOOKBACK_H_MAXIMO = 2_160;

/** The most entries `vistos` keeps after a prune (document size, not correctness). */
export const LIMITE_VISTOS = 5_000;

/**
 * The page size REQUESTED. The page size used is `meta.limit` as read back —
 * the platform may cap it (its own example answers 15) — and is never assumed.
 */
export const LIMITE_PEDIDOS_LI = 50;

/** The search path: the slash form every page requests (`paginarLi` never follows `meta.next`). */
export const CAMINHO_BUSCA_PEDIDOS_LI = '/v1/pedido/search/';

/** The operation name the poller's calls are logged under. */
export const OPERACAO_POLL_PEDIDOS_LI = 'pollPedidos';

/** `^[1-9][0-9]{0,3}$`: a positive decimal with no sign, no leading zero, no space. */
const LOOKBACK_H_GRAMATICA = /^[1-9][0-9]{0,3}$/;

/**
 * `LOJA_INTEGRADA_POLL_LOOKBACK_H` as hours, or `null` when it is invalid —
 * which the poller records as `lookback-invalido` for a conta that still has no
 * cursor, and NEVER replaces with the default. Unset and the template's blank
 * line (`''`) are the default; nothing is trimmed, so `' 72'` is invalid.
 */
export function lerLookbackHorasLi(bruto: string | undefined): number | null {
  if (bruto === undefined || bruto === '') return LOOKBACK_H_PADRAO;
  if (!LOOKBACK_H_GRAMATICA.test(bruto)) return null;
  const horas = Number(bruto);
  return horas <= LOOKBACK_H_MAXIMO ? horas : null;
}

/**
 * The bootstrap bound of a conta with no cursor: `agoraMs − horas`, rendered
 * in São Paulo time to the second. São Paulo is the wider window: if the
 * platform reads the filter in UTC, the same text names an instant 3 h earlier.
 * The first lease stores it as the cursor, so repeated failures never slide it.
 */
export function limiteDeBootstrapLi(agoraMs: number, horas: number): string {
  const limite = formatIsoNoFuso(agoraMs - horas * 3_600_000, FUSO_FISCAL).slice(0, 19);
  if (!CURSOR_POLL_LI_REGEX.test(limite)) {
    throw new RangeError('limiteDeBootstrapLi: o limite não é um cursor');
  }
  return limite;
}

/** The window's start, `since_atualizado`: the cursor minus {@link SOBREPOSICAO_S}. */
export function sinceDaJanelaLi(cursor: string): string {
  return deslocarDataLi(cursor, -SOBREPOSICAO_S);
}

/** The tolerance bound: the window's start minus {@link TOLERANCIA_FILTRO_S}. */
export function limiteDeToleranciaLi(since: string): string {
  return deslocarDataLi(since, -TOLERANCIA_FILTRO_S);
}

/** The cursor's ceiling: now plus {@link FOLGA_RELOGIO_S}, rendered in UTC (the later zone). */
export function tetoDoCursorLi(agoraMs: number): string {
  return renderizarDataLi(agoraMs + FOLGA_RELOGIO_S * 1000);
}

/** The first page's query, in the order it is sent. */
export function queryDaJanelaLi(since: string): {
  readonly since_atualizado: string;
  readonly limit: number;
} {
  return { since_atualizado: since, limit: LIMITE_PEDIDOS_LI };
}

/** The later of two cursors; `null` (no cursor yet) loses to any. */
export function maiorCursorLi(a: string | null, b: string): string {
  return a !== null && a > b ? a : b;
}

/**
 * Where the cursor goes after a FULLY DRAINED, CONSISTENT window.
 *
 *  - `maiorCarimbo` (the max canonical stamp over the whole drain) is floored
 *    to its second, then clamped to {@link tetoDoCursorLi} — `noFuturo` says
 *    the clamp fired, which the poller logs as `carimbo-no-futuro`;
 *  - an empty window (`maiorCarimbo` null) keeps the stored cursor;
 *  - the result is never earlier than `armazenado`.
 */
export function proximoCursorLi(args: {
  readonly armazenado: string;
  readonly maiorCarimbo: string | null;
  readonly agoraMs: number;
}): { readonly cursor: string; readonly noFuturo: boolean } {
  const { armazenado, maiorCarimbo, agoraMs } = args;
  if (maiorCarimbo === null) return { cursor: armazenado, noFuturo: false };
  const teto = tetoDoCursorLi(agoraMs);
  const candidato = cursorDaDataLi(maiorCarimbo);
  const noFuturo = candidato > teto;
  return { cursor: maiorCursorLi(armazenado, noFuturo ? teto : candidato), noFuturo };
}

/**
 * Whether `carimbo` is later than now + {@link FOLGA_RELOGIO_S} in São Paulo
 * time: the platform's stamps may not be in that zone. The poller passes the
 * clock read when the row's PAGE arrived (an order changed during the drain is
 * later than the drain's start), logs `zona-suspeita` (WARNING) once per run
 * and still advances. A UTC stamp reads 3 h ahead, far past the slack.
 */
export function zonaSuspeitaLi(carimbo: string, agoraMs: number): boolean {
  const limiteSp = `${formatIsoNoFuso(agoraMs + FOLGA_RELOGIO_S * 1000, FUSO_FISCAL).slice(0, 23)}000`;
  return carimbo > limiteSp;
}

/**
 * Whether a row is enqueued, given what `vistos` holds for its numero and the
 * row's canonical stamp (`null` = unreadable).
 *
 *  - a readable stamp: only when STRICTLY newer than the one recorded, or when
 *    nothing readable is recorded (absent, or the unreadable marker);
 *  - an unreadable stamp: once — unless the marker is already recorded.
 *
 * ⚠️ Strict `>`: an equal stamp is the same change, re-listed by the overlap.
 */
export function deveEnfileirarLi(visto: string | undefined, carimbo: string | null): boolean {
  if (carimbo === null) return visto !== MARCA_DATA_ILEGIVEL_LI;
  if (visto === undefined || visto === MARCA_DATA_ILEGIVEL_LI) return true;
  return carimbo > visto;
}

/** What `vistos` records for an enqueued row: its stamp, or the unreadable marker. */
export function vistoDaLinhaLi(carimbo: string | null): string {
  return carimbo ?? MARCA_DATA_ILEGIVEL_LI;
}

/**
 * `base` with this run's `novos` written over it. Where both hold a readable
 * stamp the later one is kept (a run re-deriving over a fresher stored map
 * never moves an entry back); otherwise this run's entry wins, because it is
 * what was just enqueued. Returns a new object.
 */
export function mesclarVistosLi(
  base: Readonly<Record<string, string>>,
  novos: Readonly<Record<string, string>>,
): Record<string, string> {
  const saida: Record<string, string> = { ...base };
  for (const [numero, valor] of Object.entries(novos)) {
    const atual = saida[numero];
    const manterAtual =
      atual !== undefined &&
      atual !== MARCA_DATA_ILEGIVEL_LI &&
      valor !== MARCA_DATA_ILEGIVEL_LI &&
      atual > valor;
    saida[numero] = manterAtual ? atual : valor;
  }
  return saida;
}

/** Eviction order for the cap: oldest readable stamp first, the unreadable marker last, then numero. */
function ordemDeDescarte(a: readonly [string, string], b: readonly [string, string]): number {
  const [numA, va] = a;
  const [numB, vb] = b;
  const ilegivelA = va === MARCA_DATA_ILEGIVEL_LI;
  const ilegivelB = vb === MARCA_DATA_ILEGIVEL_LI;
  if (ilegivelA !== ilegivelB) return ilegivelA ? 1 : -1;
  if (va !== vb) return va < vb ? -1 : 1;
  return Number(numA) - Number(numB);
}

/**
 * `vistos` pruned for the final write: every readable stamp BELOW the tolerance
 * bound is dropped (one at the bound stays), the unreadable marker is kept,
 * and past {@link LIMITE_VISTOS} entries the oldest stamps go first. A dropped
 * entry still in the window costs one re-enqueue, never an order. Returns a
 * new object.
 *
 * ⚠️ The bound is the TOLERANCE bound, not the window's start: a row a zone
 * mismatch places up to 4 h below the start is still listed, and must still
 * be recognised.
 */
export function podarVistosLi(
  vistos: Readonly<Record<string, string>>,
  limiteTolerancia: string,
): Record<string, string> {
  const piso = canonicaDoCursorLi(limiteTolerancia);
  const mantidos = Object.entries(vistos).filter(
    ([, valor]) => valor === MARCA_DATA_ILEGIVEL_LI || valor >= piso,
  );
  if (mantidos.length > LIMITE_VISTOS) {
    mantidos.sort(ordemDeDescarte);
    mantidos.splice(0, mantidos.length - LIMITE_VISTOS);
  }
  return Object.fromEntries(mantidos);
}

/**
 * `filtro-ignorado`: a row whose readable stamp is below the tolerance bound
 * cannot be a zone mismatch, so the platform ignored the filter. A row exactly
 * AT the bound is legitimate.
 */
export function filtroIgnoradoLi(carimbo: string, limiteTolerancia: string): boolean {
  return carimbo < canonicaDoCursorLi(limiteTolerancia);
}

/**
 * `janela-grande-demais`, decided on page 1 before draining: the window holds
 * more rows than {@link MAX_PAGINAS_POLL} pages of `meta.limit` (as read back)
 * can drain. Without a `total_count` it cannot be decided here (`false`); the
 * page cap still stops the drain.
 */
export function janelaGrandeDemaisLi(meta: {
  readonly limit: number;
  readonly total_count?: number | null;
}): boolean {
  const total = meta.total_count;
  if (total === null || total === undefined) return false;
  return total > meta.limit * MAX_PAGINAS_POLL;
}

/** What {@link consistenciaDaJanelaLi} found. */
export type ConsistenciaJanelaLi = 'consistente' | 'instavel' | 'sem-total';

/**
 * Whether a fully drained window is consistent: `distintos` (the distinct
 * numeros read across every page) against the LARGEST `total_count` the pages
 * announced (`totais`, one per page, absent ones included).
 *
 *  - fewer rows than announced → `instavel` (`janela-instavel`, no advance):
 *    offset paging over a list that changed while it was read skipped some;
 *  - no page announced a total → `sem-total`: the check is skipped (the poller
 *    logs it) and the run may advance;
 *  - otherwise `consistente`.
 */
export function consistenciaDaJanelaLi(
  totais: readonly (number | null | undefined)[],
  distintos: number,
): ConsistenciaJanelaLi {
  const anunciados = totais.filter((t): t is number => typeof t === 'number');
  if (anunciados.length === 0) return 'sem-total';
  return distintos < Math.max(...anunciados) ? 'instavel' : 'consistente';
}
