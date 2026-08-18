/**
 * One in-flight AI suggestion per operator.
 *
 * ⚠️ **Per-instance, and therefore a courtesy rather than a guarantee.**
 * `apphosting.yaml` allows `maxInstances: 20`, so two requests from the same
 * operator can land on two containers and both run. What this reliably stops is
 * the common case — a double-click, or an impatient second click while the
 * first call is still out — which is worth stopping because every one of those
 * is a billed model call.
 *
 * A real global lock would need Firestore or Redis in the request path. That is
 * not worth it for a button an internal ERP user presses a few times a day; if
 * volume ever justifies it, this module is the seam to replace.
 *
 * This is the first rate-limiting of any kind in the repo — there is none on
 * any other route.
 */
const inFlight = new Map<string, Promise<unknown>>();

/** Thrown when the same operator already has a call out. */
export class AlreadyRunningError extends Error {
  constructor() {
    super('Já existe uma sugestão em andamento para este usuário.');
    this.name = 'AlreadyRunningError';
  }
}

export async function runSingleFlight<T>(key: string, task: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new AlreadyRunningError();
  const promise = task();
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    // `finally`, so a rejection also clears the slot — otherwise one failure
    // would lock the operator out until the instance recycled.
    inFlight.delete(key);
  }
}

/** Test seam. */
export function __resetSingleFlight(): void {
  inFlight.clear();
}
