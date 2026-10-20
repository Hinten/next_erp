/**
 * The backstop poll's numbers (master plan step 4, PR 4-a): its page cap, its
 * time budget, its lease and its window constants. Pure: constants and
 * arithmetic, no clock of its own. Every relation between them is pinned by
 * `orcamentoPoll.test.ts`, so changing one number without the others turns a
 * test red.
 *
 * ## The page cap comes from Amazon's bucket
 *
 * `searchOrders` refills at 0.0056 requests per second with a burst of 20 (the
 * model's usage plan): ≈ 5.04 tokens per 15-minute tick. So a run reads at most
 * {@link MAX_PAGINAS_POLL_AMAZON} = 5 pages and a capped run never throttles
 * itself; the burst absorbs a resumed drain. Steady state is one page per tick
 * (96 a day, ≈ 20 % of the sustained bucket); a 30-day park drains in ≈ 6 ticks.
 *
 * ## The reads are bounded; the enqueues are NOT — hence the deadline
 *
 * One page costs at most `PRAZO_AMAZON_MS.leitura` (20 s) and one LWA refresh
 * at most `PRAZO_AMAZON_MS.lwa` (20 s), so the reads of a run cost at most
 * 5 × 20 + 20 = 120 s. But a run may enqueue up to 500 rows, each raced against
 * {@link PRAZO_ENFILEIRAMENTO_POLL_MS} (5 s) — on a slow Cloud Tasks that is far
 * more than any budget. So a conta has a DEADLINE: its budget minus
 * {@link FOLGA_CONTA_MS}, checked before every page and before every enqueue. A
 * run that reaches it stops with `orcamento-esgotado` and still writes what it
 * handed off, instead of being killed by the function timeout with nothing
 * written. The deadline check is what bounds a slow run, never the timeout: it
 * may not be removed (pinned as a fact).
 *
 * ## Every conta is reached
 *
 * The contas run one after another inside {@link ORCAMENTO_TICK_MS}, each with
 * min({@link ORCAMENTO_CONTA_MS}, what the tick has left). One the tick can no
 * longer give {@link ORCAMENTO_MINIMO_CONTA_MS} is not started (`sem-tempo`,
 * nothing written), and the order is ROTATED by the tick's 15-minute slot
 * ({@link ordemDoTickAmazon}), so no conta starves behind the same ones forever.
 */
import { PRAZO_AMAZON_MS } from '@delfrance/integrations-amazon-sp-api';

/** The most pages one conta's run may read (module header). */
export const MAX_PAGINAS_POLL_AMAZON = 5;

/** Rows per page: the model's maximum. */
export const MAX_RESULTADOS_POR_PAGINA_AMAZON = 100;

/**
 * The most pages one WINDOW may span, across runs. A window that reaches it, or
 * a page that announces the very token it was asked with, is a malformed answer
 * (`resposta-invalida`, counted): Amazon does not document its pagination (step-3/4
 * plan §5 risk 6), and a chain that never ends would otherwise truncate forever —
 * uncounted, the cursor frozen, no aviso. Far above D8's volume: the 720-h
 * look-back cap at ten times D8's ≈ 50 orders a day is 150 pages. At five pages
 * a tick it is reached in 40 ticks (10 h), and counted on every tick after.
 */
export const MAX_PAGINAS_POR_JANELA_AMAZON = 200;

/** `searchOrders`' default sustained rate, in requests per second (the model's usage plan). */
export const TAXA_SEARCH_ORDERS_RPS = 0.0056;

/** …and its burst. */
export const RAJADA_SEARCH_ORDERS = 20;

/** The schedule's interval, in ms (the cron itself is the functions root's, PR 4-b). */
export const INTERVALO_POLL_AMAZON_MS = 900_000;

/**
 * The poll root's `timeoutSeconds` (PR 4-b binds it; its `index.test.ts` pins
 * the deployed value against this one).
 */
export const TEMPO_LIMITE_POLL_AMAZON_S = 300;

/** One tick's budget, in ms: inside the function timeout, with room for the last conta's final write. */
export const ORCAMENTO_TICK_MS = 240_000;

/** One conta's budget, in ms, when the tick still has that much left. */
export const ORCAMENTO_CONTA_MS = 200_000;

/** The part of a conta's budget kept for the final write and the aviso: the deadline is budget − this. */
export const FOLGA_CONTA_MS = 20_000;

/** The least budget a conta is STARTED with, in ms (module header). */
export const ORCAMENTO_MINIMO_CONTA_MS = 30_000;

/** Each enqueue's deadline, raced as the receiver races its own (step-3 plan §3 decision 32). */
export const PRAZO_ENFILEIRAMENTO_POLL_MS = 5_000;

/** The most rows one run may enqueue: five full pages. */
export const MAX_LINHAS_POR_EXECUCAO = MAX_PAGINAS_POLL_AMAZON * MAX_RESULTADOS_POR_PAGINA_AMAZON;

/**
 * How long a run's lease holds the poll document, in ms: longer than the
 * function timeout, so a live run's lease never expires under it, and shorter
 * than the interval, so a crashed run's lease is free by the next tick.
 */
export const LEASE_POLL_MS = 360_000;

/** The overlap a fresh window re-reads before the cursor, in ms. */
export const SOBREPOSICAO_MS = 600_000;

/** The cursor never passes the drain's start minus this, in ms (step-3/4 plan §3 decision 20). */
export const CAP_INICIO_MS = 300_000;

/** A stored pagination token older than this is discarded, in ms: Amazon expires it after 24 h. */
export const VIDA_TOKEN_MS = 23 * 60 * 60 * 1000;

/** `vistos` keeps the rows stamped at or after cursor − this, in ms: the overlap plus the cap plus a margin. */
export const JANELA_VISTOS_MS = 25 * 60 * 1000;

/** The most `vistos` entries kept (the oldest dropped first: at worst a harmless re-enqueue). */
export const MAX_VISTOS = 2_000;

/**
 * The budget of the conta about to run, in ms: min({@link ORCAMENTO_CONTA_MS},
 * what is left of the tick that started at `inicioDoTickMs`), never below 0.
 */
export function orcamentoDaContaMs(inicioDoTickMs: number, agoraMs: number): number {
  const restante = ORCAMENTO_TICK_MS - (agoraMs - inicioDoTickMs);
  return Math.max(0, Math.min(ORCAMENTO_CONTA_MS, restante));
}

/** The conta's deadline, in ms: its budget minus {@link FOLGA_CONTA_MS}, from `agoraMs`. */
export function prazoDaContaMs(agoraMs: number, orcamentoMs: number): number {
  return agoraMs + orcamentoMs - FOLGA_CONTA_MS;
}

/**
 * The order one tick walks `contas` in: the same order, ROTATED to start at the
 * tick's 15-minute slot modulo the count. Stateless (the slot comes from the
 * tick's own start); returns a new array.
 */
export function ordemDoTickAmazon<T>(contas: readonly T[], inicioDoTickMs: number): T[] {
  if (contas.length === 0) return [];
  const inicio = Math.floor(inicioDoTickMs / INTERVALO_POLL_AMAZON_MS) % contas.length;
  return [...contas.slice(inicio), ...contas.slice(0, inicio)];
}

/** The planned worst case of a run's READS, in ms: every page at its deadline, plus one LWA refresh. */
export const CUSTO_MAXIMO_DAS_LEITURAS_MS =
  MAX_PAGINAS_POLL_AMAZON * PRAZO_AMAZON_MS.leitura + PRAZO_AMAZON_MS.lwa;
