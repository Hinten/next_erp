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
 * ⚠️ The credential routes' validating GET does not go through a context, so it
 * is not paced: it is one call per operator save. The label routing route calls
 * nothing. The paid re-check route's one read DOES go through a context, so it
 * waits one full interval before its request, outside the 20 s deadline. That
 * wait is a per-request sleep, not a rate limiter: concurrent checks and the
 * reads queue add up rather than share the bound above (master plan §4.23); at
 * the channel's volume they stay far under 100 a minute.
 *
 * ⚠️ A run's budget signal is checked by the package only after the wait, so a
 * budgeted run can overshoot its budget by at most one interval.
 *
 * ## The writes pacer is spent elsewhere
 *
 * The WRITE context (`core/contextoEscrita.ts`) builds {@link ritmoDeEscritaLi}:
 * its write client's getter does NOT wait — the write engine (`core/escrita.ts`)
 * spends the interval itself, where {@link RITMO_ESCRITA_LI_MS} says — and its
 * read client (the situação-history read) waits one interval per request, as
 * above.
 */

/** The interval before every Loja Integrada read made through a context, in ms. */
export const RITMO_LEITURA_LI_MS = 2_000;

/**
 * The WRITES pacer's interval, in ms: 2 000 per call ON AVERAGE (master plan
 * §4.23, step 7), owned by the write engine (`core/escrita.ts`), which spends it
 * where it buys the most:
 *
 *  - TWO intervals before a GET that decides a write, and two before the
 *    read-back of a write that landed (≈ 4 s: the read-after-write delay);
 *  - ONE before any other GET (the situação-history read, a confirming read
 *    that decides nothing) — the history read's own client waits it;
 *  - NONE before a write: it follows the GET that decided it at once, after
 *    only the credential re-read, so the window in which someone else can
 *    change the order between the two is as short as it can be.
 *
 * A posting is GET, PUT, read-back, history: 4 calls, 4 + 0 + 4 + 2 = 10 s of
 * waits, ≥ 4 × 2 s. So N calls on the writes queue wait at least N × the
 * interval in total — at most 30 calls a minute, its sweep included (it runs
 * inside the queue's single dispatch slot). With the reads queue, the poller
 * and the inline reads sweep at 30 each, the theoretical worst per store is
 * 120 a minute against Loja Integrada's 100; reaching it needs a read backlog
 * and a write backlog on one store in the same minute, and a 429 loses nothing
 * in any flow (the write either never landed, or its read-back is contained).
 */
export const RITMO_ESCRITA_LI_MS = 2_000;

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

/** The writes pacer, bound to the entry point's sleep (the write context builds it). */
export function ritmoDeEscritaLi(esperar: (ms: number) => Promise<void>): RitmoLi {
  return { intervaloMs: RITMO_ESCRITA_LI_MS, esperar };
}
