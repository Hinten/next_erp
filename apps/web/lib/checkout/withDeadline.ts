/**
 * Bound an await so a stalled stage becomes a reported failure instead of a
 * spinner that never stops.
 *
 * WHY THIS EXISTS. The "Outros Checkouts" reprint had no timeout anywhere
 * between the operator's click and the network call — not in
 * `reprintCheckoutEtiqueta`, not in the etiqueta registry, and not in the
 * freight HTTP client, whose `RequestInit` carries no `signal` at all. So any
 * stage that never settled left BOTH modal buttons spinning on the shared
 * `usePrintInFlight` flag, with no toast, no log and no way forward but a
 * reload. Whatever the underlying stall is, "we do not know how long this will
 * take" must not be indistinguishable from "the printer is slow".
 *
 * The stage name is the point. A bare timeout tells the operator that something
 * hung; naming the stage tells whoever reads the report WHICH await did.
 *
 * ⚠️ This does NOT cancel the work — a Firestore `getDoc` or a `fetch` without
 * a signal keeps running to completion in the background. It bounds how long
 * the UI waits on it, which is what unwedges the mutex and frees the buttons.
 * Cancellation has to be pushed into each transport separately.
 */

/** Thrown when a stage outlives its deadline. Carries the stage for reporting. */
export class DeadlineExceededError extends Error {
  constructor(
    readonly stage: string,
    readonly ms: number,
  ) {
    super(`A etapa "${stage}" não respondeu em ${Math.round(ms / 1000)}s.`);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Default budget for one reprint stage. Generous on purpose: a cold Firestore
 * read plus a Melhor Envio round trip on a slow connection is seconds, not
 * tens of seconds, and a false timeout is worse than a slow success — it would
 * teach operators to re-click, which is exactly what the print mutex exists to
 * prevent.
 */
export const REPRINT_STAGE_TIMEOUT_MS = 30_000;

/**
 * Resolve `work`, or reject with {@link DeadlineExceededError} after `ms`.
 *
 * The timer is always cleared, including on the failure path — a pending
 * `setTimeout` per reprint would keep the tab awake and, under Vitest fake
 * timers, leak into the next test.
 */
export async function withDeadline<T>(
  stage: string,
  work: Promise<T>,
  ms: number = REPRINT_STAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceededError(stage, ms)), ms);
  });

  try {
    return await Promise.race([work, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
