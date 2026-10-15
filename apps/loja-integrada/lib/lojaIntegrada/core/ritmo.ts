/**
 * The PACER: how far apart this app's Loja Integrada calls are spaced (master
 * plan §4.23, step-3 plan Q2). Pure: a constant and a shape, no clock and no
 * timer of its own — the entry point supplies the sleep.
 *
 * ## Where it waits, and why there
 *
 * The context loader (`core/contexto.ts`) waits `intervaloMs` inside the
 * client's `obterCredencial` getter, i.e. BEFORE every request it sends. The
 * package awaits that getter OUTSIDE the request deadline, so the wait never
 * eats the 20 s budget of the call it precedes.
 *
 * Every call through a context is therefore preceded by one full interval,
 * whatever happened before it. Under the reads queue's concurrency of 1, N
 * calls take at least N × the interval across task boundaries, with no shared
 * state to keep: at 2 000 ms, at most 30 calls a minute on that queue, against
 * Loja Integrada's 100 per minute per store.
 *
 * ⚠️ The routes' validating GET does not go through a context, so it is not
 * paced: it is one call per operator save.
 *
 * ⚠️ A run's budget signal is checked by the package only after the wait, so a
 * budgeted run can overshoot its budget by at most one interval.
 */

/** The interval before every Loja Integrada read made through a context, in ms. */
export const RITMO_LEITURA_LI_MS = 2_000;

export interface RitmoLi {
  /** How long to wait before each call, in ms. */
  readonly intervaloMs: number;
  /** The sleep — `setTimeout` in production, a recording fake in tests. */
  esperar(ms: number): Promise<void>;
}

/** The reads pacer, bound to the entry point's sleep. */
export function ritmoDeLeituraLi(esperar: (ms: number) => Promise<void>): RitmoLi {
  return { intervaloMs: RITMO_LEITURA_LI_MS, esperar };
}
