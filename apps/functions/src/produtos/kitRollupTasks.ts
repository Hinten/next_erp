/**
 * Task scheduler for the kit weight/box rollup (#1152) — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), the same transport the balanço
 * finalize job uses (`balancoTasks.ts`).
 *
 * Why a queue at all: a single component can sit in **thousands** of kits (ADR
 * 0014 measured ~2 000 for the printed-shirt catalogue, where every kit shares
 * the same blank shirt + print). That fan-out cannot run inline on a Firestore
 * trigger — it has no checkpoint, no retry budget of its own, and a 60s default
 * timeout. The trigger therefore does ONE enqueue and no reads.
 *
 * Two callers enqueue onto it: `onProdutoChanged` when a produto's weight or box
 * actually changed, and the worker itself for every continuation page and for
 * the (normally empty) nested-kit cascade.
 *
 * Config:
 *   - `KIT_ROLLUP_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link KitRollupTasksDisabledError}. The trigger logs and moves on; the
 *     rollup then waits for the next edit to that component.
 *   - `KIT_ROLLUP_TASKS_REGION` (default `FUNCTIONS_REGION`, which `build.mjs`
 *     inlines) — the queue name MUST be region-qualified or the Admin SDK
 *     resolves it against us-central1. A blank value counts as UNSET (#887):
 *     `??` would keep `''` and yield `locations//functions/…`, which drops the
 *     task silently.
 */
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError, getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../lib/admin';
import type { KitRollupPayload } from './kitRollupPayload';

/**
 * ⚠️ This string IS the deployed function name AND the queue name — they are
 * the same identifier in Firebase task queues. It must stay equal to the
 * `recalcularDimensoesKit` export in `kitRollup.ts`; rename both together.
 */
export const KIT_ROLLUP_QUEUE = 'recalcularDimensoesKit';

/**
 * Cloud Tasks retry budget. Unlike the balanço worker there is nothing to park
 * on exhaustion — a kit left stale is corrected by the next edit to any of its
 * components, or by the one-time backfill script.
 */
export const KIT_ROLLUP_MAX_ATTEMPTS = 5;

function kitRollupTasksRegion(): string {
  return process.env.KIT_ROLLUP_TASKS_REGION?.trim() || process.env.FUNCTIONS_REGION || 'us-east1';
}

/**
 * The enqueue seam. The trigger and the worker depend on this interface, not
 * the transport, so tests pass a recorder instead of reaching Cloud Tasks.
 */
export interface KitRollupScheduler {
  enqueue(payload: KitRollupPayload): Promise<void>;
}

export class KitRollupTasksDisabledError extends Error {
  constructor() {
    super('KIT_ROLLUP_TASKS_DISABLED=1 — kit rollup enqueue disabled');
    this.name = 'KitRollupTasksDisabledError';
  }
}

class FirebaseKitRollupScheduler implements KitRollupScheduler {
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<KitRollupPayload>(
      `locations/${kitRollupTasksRegion()}/functions/${KIT_ROLLUP_QUEUE}`,
    );
  }

  async enqueue(payload: KitRollupPayload): Promise<void> {
    // ⚠️ Deliberately NO task `id`. A named Cloud Task cannot be recreated for
    // ~1h after the previous task with that name completed, so an edit sequence
    // A → B → A within the hour would have the third enqueue silently rejected
    // as a duplicate and the rollup lost. Superseding is done by the worker's
    // value guard instead (`kitRollup.ts`), which costs one read per dispatch
    // and cannot drop work it does not replace. No call site in this repo names
    // a task; keep it that way.
    await this.queue().enqueue(payload);
  }
}

export function createKitRollupScheduler(): KitRollupScheduler {
  if (process.env.KIT_ROLLUP_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new KitRollupTasksDisabledError();
      },
    };
  }
  return new FirebaseKitRollupScheduler();
}

/**
 * Whether a failed enqueue may be logged and swallowed rather than thrown.
 *
 * A Firestore trigger does NOT retry by default and there is no job document to
 * park, so throwing here buys nothing. The containment is bounded to the three
 * expected families — the kill switch, the transport, and a credential that
 * could not be resolved — because anything else is a coding bug (root
 * `CLAUDE.md` rule 6: never a bare catch).
 *
 * ⚠️ **Match on the CLASS, never on a gRPC `code` number.** This queue's
 * transport is `firebase-admin/functions`' `FunctionsApiClient` — HTTP, not
 * gRPC — and it throws {@link FirebaseFunctionsError}, whose `code` is a STRING
 * (`functions/permission-denied`, …). An earlier revision reused the numeric
 * `code >= 1 && code <= 16` idiom copied from the Mercado Livre sweeps; it
 * matched **nothing**, so the one failure this file exists to survive —
 * `TASKS_INVOKER_SA` not naming the functions runtime SA, i.e. a 403 on the
 * enqueue — rethrew instead. A guard that never fires is worse than no guard,
 * because it reads as covered.
 *
 * What a swallowed enqueue costs: the kits stay stale until the next edit to any
 * of their components, or until the one-time backfill script runs. That is the
 * accepted trade; a backstop sweep is deliberately not built.
 */
export function isFalhaDeEnfileiramentoContivel(err: unknown): boolean {
  return (
    err instanceof KitRollupTasksDisabledError ||
    err instanceof FirebaseFunctionsError ||
    err instanceof FirebaseAppError
  );
}
