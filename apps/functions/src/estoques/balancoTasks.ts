/**
 * Task scheduler for the balanço finalize job — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), the same transport
 * `apps/mercado-livre`'s mass-import job uses (`mlMassImportTasks.ts`).
 *
 * Two callers enqueue onto it: the `finalizarBalanco` callable dispatches the
 * FIRST task once it has taken the workflow lock, and the worker itself
 * re-enqueues for every continuation slice — so this module is a dependency of
 * the worker, not just of the callable. There is no sweep to fall back on: a
 * dropped enqueue must surface as a parked (`erro`) balanço, never a silent
 * stall.
 *
 * Config:
 *   - `BALANCO_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link BalancoTasksDisabledError}. The callable maps that to `erro` on
 *     the balanço doc plus a failed response.
 *   - `BALANCO_TASKS_REGION` (default `FUNCTIONS_REGION`, which `build.mjs`
 *     inlines) — the queue name MUST be region-qualified or the Admin SDK
 *     resolves it against us-central1. A blank value counts as UNSET (#887):
 *     `??` would keep `''` and yield `locations//functions/…`, which drops the
 *     task silently — and this queue has no sweep to fall back on.
 */
import { requireRegion } from '@delfrance/core/region';
import { getFunctions } from 'firebase-admin/functions';
import type { BalancoTaskPayload } from '@delfrance/data/balanco';

import { getAdminApp } from '../lib/admin';

/**
 * ⚠️ This string IS the deployed function name AND the queue name — they are
 * the same identifier in Firebase task queues. It must stay equal to the
 * `processarBalanco` export in `aplicarBalanco.ts`; rename both together.
 */
export const BALANCO_QUEUE = 'processarBalanco';

/**
 * Cloud Tasks retry budget, mirrored into the worker so it knows when it is on
 * its LAST attempt and must park the balanço as `erro` instead of throwing
 * (a throw on the final attempt would leave the doc stuck in `finalizando`
 * forever — legacy's exact failure mode).
 */
export const BALANCO_MAX_ATTEMPTS = 5;

function balancoTasksRegion(): string {
  return requireRegion(['BALANCO_TASKS_REGION', 'FUNCTIONS_REGION'], process.env);
}

/**
 * The enqueue seam. The callable and the worker depend on this interface, not
 * the transport, so tests pass a recorder instead of reaching Cloud Tasks.
 */
export interface BalancoScheduler {
  enqueue(payload: BalancoTaskPayload): Promise<void>;
}

export class BalancoTasksDisabledError extends Error {
  constructor() {
    super('BALANCO_TASKS_DISABLED=1 — balanço enqueue disabled');
    this.name = 'BalancoTasksDisabledError';
  }
}

class FirebaseBalancoScheduler implements BalancoScheduler {
  private queue() {
    return getFunctions(getAdminApp()).taskQueue<BalancoTaskPayload>(
      `locations/${balancoTasksRegion()}/functions/${BALANCO_QUEUE}`,
    );
  }

  async enqueue(payload: BalancoTaskPayload): Promise<void> {
    await this.queue().enqueue(payload);
  }
}

export function createBalancoScheduler(): BalancoScheduler {
  if (process.env.BALANCO_TASKS_DISABLED === '1') {
    return {
      async enqueue() {
        throw new BalancoTasksDisabledError();
      },
    };
  }
  return new FirebaseBalancoScheduler();
}
