/**
 * The order poller's TIME budget, and the drain cap derived from it (master
 * plan step 3, PR 3-e). Pure: constants and arithmetic, no clock of its own.
 *
 * ## The cap comes from the budget, not from a round number
 *
 * One tick of the 5-minute schedule gets {@link ORCAMENTO_TICK_MS}; the contas
 * run one after another, each with min({@link ORCAMENTO_CONTA_MS}, what the
 * tick has left). Every page a conta reads costs one pacer interval
 * (`RITMO_LEITURA_LI_MS`, waited before the call) plus the platform's answer
 * time, so the most pages a conta may read in one run is pinned by
 *
 *     MAX_PAGINAS_POLL × (RITMO_LEITURA_LI_MS + LATENCIA_LI_ESTIMADA_MS)
 *       ≤ ORCAMENTO_CONTA_MS − FOLGA_CONTA_MS
 *
 * (`orcamentoPoll.test.ts`): 20 × (2 000 + 2 000) = 80 000 ≤ 90 000. Raising
 * the cap past what the budget can drain turns that test red.
 *
 * ⚠️ {@link LATENCIA_LI_ESTIMADA_MS} is an UNMEASURED planning figure: no
 * capture has timed a Loja Integrada answer yet. A slower platform does not
 * break anything — the run's budget signal aborts the drain, the run keeps the
 * `vistos` it gathered, and the next tick converges — but a much slower one
 * stalls a large window and ends in `orcamento-esgotado`.
 *
 * Enqueue time is deliberately NOT in the formula: a budget-exhausted run
 * persists `vistos`, so the next tick re-reads the pages it already saw and
 * enqueues only what remains.
 *
 * ## Every conta is reached
 *
 * A conta the tick can no longer give {@link ORCAMENTO_MINIMO_CONTA_MS} is not
 * started (`sem-tempo`, nothing written). With a FIXED order, two contas that
 * spend their whole budget on every tick would starve the third forever, with
 * no counter moving and so no aviso. So the tick ROTATES where it starts
 * ({@link ordemDoTickLi}): within any run of as many ticks as there are contas,
 * every conta runs first once, and the first conta always gets a full budget.
 */
import { RITMO_LEITURA_LI_MS } from '../core/ritmo';

/** The most pages one conta's run may read; the window refused on page 1 is sized from it. */
export const MAX_PAGINAS_POLL = 20;

/**
 * The schedule's interval, in ms: `every 5 minutes` (the cron string itself is
 * pinned by `functions/src/pollPedidos.test.ts`). It numbers the ticks for
 * {@link ordemDoTickLi}.
 */
export const INTERVALO_DO_AGENDAMENTO_POLL_MS = 300_000;

/** One tick's deadline, in ms: inside the 5-minute schedule, with room for the last conta's final write. */
export const ORCAMENTO_TICK_MS = 220_000;

/** One conta's budget, in ms, when the tick still has that much left. */
export const ORCAMENTO_CONTA_MS = 100_000;

/** The part of a conta's budget the drain may not plan to spend (enqueues, the aviso step, the final write). */
export const FOLGA_CONTA_MS = 10_000;

/**
 * The time one Loja Integrada read is ASSUMED to take, in ms. ⚠️ An unmeasured
 * planning figure, not a measurement and not a deadline (the per-call deadline
 * is `PRAZO_LI_MS.leitura`).
 */
export const LATENCIA_LI_ESTIMADA_MS = 2_000;

/**
 * How long a run's lease holds the poll document, in ms. It must outlive the
 * longest run: a conta's budget, plus the one pacer interval a run may
 * overshoot it by, plus one whole request deadline (pinned in
 * `orcamentoPoll.test.ts`).
 */
export const DURACAO_LEASE_POLL_MS = 300_000;

/** The time a drain of `paginas` pages is planned to take, in ms. */
export function custoPlanejadoDoDrenoMs(paginas: number): number {
  return paginas * (RITMO_LEITURA_LI_MS + LATENCIA_LI_ESTIMADA_MS);
}

/**
 * The least budget a conta is STARTED with, in ms: one page's planned cost PLUS
 * {@link FOLGA_CONTA_MS}. The page alone is not enough: the run first reads its
 * conta, credential and poll document and takes the lease, and after the page
 * each new row is enqueued behind a budget checkpoint — so a conta started with
 * one page's cost reaches that checkpoint past its deadline and ends in a
 * COUNTED `orcamento-esgotado` through no fault of its own. A conta the tick can
 * give less is `sem-tempo` (nothing written); the rotation
 * ({@link ordemDoTickLi}) makes it first on a later tick.
 */
export const ORCAMENTO_MINIMO_CONTA_MS = custoPlanejadoDoDrenoMs(1) + FOLGA_CONTA_MS;

/**
 * The budget of the conta about to run, in ms: min({@link ORCAMENTO_CONTA_MS},
 * what is left of the tick that started at `inicioDoTickMs`). Below
 * {@link ORCAMENTO_MINIMO_CONTA_MS} (`0` included) the conta is not started
 * (`sem-tempo`, nothing written); {@link ordemDoTickLi} makes it first on a
 * later tick.
 */
export function orcamentoDaContaMs(inicioDoTickMs: number, agoraMs: number): number {
  const restante = ORCAMENTO_TICK_MS - (agoraMs - inicioDoTickMs);
  return Math.max(0, Math.min(ORCAMENTO_CONTA_MS, restante));
}

/**
 * The order one tick walks `contas` in: the same order, ROTATED to start at the
 * tick's number — its 5-minute slot ({@link INTERVALO_DO_AGENDAMENTO_POLL_MS})
 * — modulo the count. Stateless: the slot comes from the tick's own start, so
 * no document records where the last tick stopped. A tick that fires late
 * inside its slot keeps that slot. Returns a new array.
 */
export function ordemDoTickLi<T>(contas: readonly T[], inicioDoTickMs: number): T[] {
  if (contas.length === 0) return [];
  const inicio = Math.floor(inicioDoTickMs / INTERVALO_DO_AGENDAMENTO_POLL_MS) % contas.length;
  return [...contas.slice(inicio), ...contas.slice(0, inicio)];
}
