/**
 * Task scheduler for the async NF-e reconciler — backed by a **Firebase
 * Functions task queue** (`onTaskDispatched`), not raw Cloud Tasks / Terraform.
 *
 * When a lote is accepted asynchronously (`cStat=103` + `nRec`), the emitter
 * hands off immediately and enqueues a task scheduled at `now + tMed` onto the
 * `reconciliarNfe` queue (auto-provisioned by the function on deploy — see
 * `apps/nfe/functions/src/reconciliar.ts`). The queue dispatches to that
 * function, which **executes the reconcile in-process** (no HTTP hop) and, while
 * still processing (`cStat=105`), re-enqueues the next consult with backoff up to
 * a cap.
 *
 * Transport: `firebase-admin`'s `getFunctions().taskQueue(...).enqueue(...)`. No
 * queue-path / runner-SA env and no google-auth-library: the Cloud Tasks queue is
 * named after the function and the OIDC token that invokes it is minted by the
 * Cloud Tasks ↔ Functions integration. `getFunctions()` uses the **default** admin
 * app, so the same code runs in `apps/nfe` and inside the function (both init the
 * default app before any enqueue).
 *
 * Config:
 *   - `NFE_TASKS_DISABLED=1` → `noopTaskScheduler` (local dev / deliberate
 *     sweep-only opt-out; the backstop sweep still reconciles).
 *   - `NFE_TASKS_REGION` (default `us-east1`) → the region the `reconciliarNfe`
 *     function + its queue are deployed to (must match the functions' region).
 */
import { z } from 'zod';
import { getFunctions } from 'firebase-admin/functions';

import type { TpEmis } from '@delfrance/integrations-nfe';

import { safeLog } from './log';

/** The `onTaskDispatched` function (and its auto-created queue) in apps/nfe/functions. */
const RECONCILE_FUNCTION = 'reconciliarNfe';
/** Region the reconcile function/queue live in (must match the functions' FUNCTIONS_REGION). */
const reconcileRegion = (): string => process.env.NFE_TASKS_REGION ?? 'us-east1';

/**
 * JSON body the queue delivers to the reconcile function. Shared between the
 * producer (here) and the consumer (the handler) so the contract has one
 * definition. `kind` is a discriminator so PR3 can add a CC-e variant without
 * breaking older in-flight tasks.
 */
export const consultaTaskPayloadSchema = z.object({
  kind: z.literal('consulta-lote'),
  /** Owning filial — selects the A1 cert that signs the consult. */
  filialId: z.string().min(1),
  /** Lote receipt (`consReciNFe` is consulted by this, never by chave). */
  nRec: z.string().min(1),
  /**
   * SEFAZ `tpEmis` of the lote — routes the consult to the right authorizer.
   * Closed to the valid `TpEmis` set (1|2|3|4|5|6|7|9) so a malformed/mis-enqueued
   * payload can't reach SEFAZ routing with an invalid emission type.
   */
  tpEmis: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(9),
  ]),
  /** 0-based consult attempt; the reconciler caps it at `MAX_RECONCILE_ATTEMPTS`. */
  attempt: z.number().int().min(0),
});
export type ConsultaTaskPayload = z.infer<typeof consultaTaskPayloadSchema>;

/** Input to schedule one lote-consult task. */
export interface ConsultaTaskInput {
  readonly filialId: string;
  readonly nRec: string;
  readonly tpEmis: TpEmis;
  readonly attempt: number;
  /** Absolute epoch milliseconds when the task should fire (`Date.now() + delay`). */
  readonly scheduleAtMs: number;
}

/**
 * The enqueue seam. The orchestrator depends on this interface, not on the
 * transport, so unit tests pass a fake recorder. Routes / functions obtain the
 * real one via `createTaskScheduler()`.
 */
export interface TaskScheduler {
  enqueueConsulta(input: ConsultaTaskInput): Promise<void>;
}

/**
 * Silent no-op scheduler — the orchestrator's **default** when no scheduler is
 * threaded in (e.g. unit tests that don't assert enqueue), and the
 * `NFE_TASKS_DISABLED=1` mode. A missing enqueue degrades to "the backstop sweep
 * reconciles it later", never to incorrect state — so the default is safe.
 */
export const noopTaskScheduler: TaskScheduler = {
  async enqueueConsulta() {
    /* no-op */
  },
};

/**
 * Retained error type for the route contract: routes still defensively map a
 * scheduler-construction failure to a 5xx. With the Firebase-managed queue the
 * transport has no required env to validate, so `createTaskScheduler()` no longer
 * throws this — but keeping the type avoids churning the emit routes.
 */
export class NFeTasksConfigError extends Error {
  public readonly missing: ReadonlyArray<string>;
  constructor(missing: ReadonlyArray<string>) {
    super(
      `Cloud Tasks não configurado: defina ${missing.join(', ')} ` +
        `(ou NFE_TASKS_DISABLED=1 para o modo sweep-only).`,
    );
    this.name = 'NFeTasksConfigError';
    this.missing = missing;
  }
}

/** Real scheduler — enqueues onto the `reconciliarNfe` Firebase task queue. */
class FirebaseTaskQueueScheduler implements TaskScheduler {
  async enqueueConsulta(input: ConsultaTaskInput): Promise<void> {
    const payload: ConsultaTaskPayload = {
      kind: 'consulta-lote',
      filialId: input.filialId,
      nRec: input.nRec,
      tpEmis: input.tpEmis,
      attempt: input.attempt,
    };
    // Region-qualified name so the queue resolves to the deployed function's
    // region (the Admin SDK otherwise defaults to us-central1). Uses the default
    // admin app (already initialized by the host before any enqueue).
    const queue = getFunctions().taskQueue<ConsultaTaskPayload>(
      `locations/${reconcileRegion()}/functions/${RECONCILE_FUNCTION}`,
    );
    await queue.enqueue(payload, { scheduleTime: new Date(input.scheduleAtMs) });
  }
}

/**
 * Build the scheduler from the environment:
 *   - `NFE_TASKS_DISABLED=1` → `noopTaskScheduler` (sweep-only) with a one-line
 *     warning so the mode is visible in logs.
 *   - otherwise → the real `FirebaseTaskQueueScheduler`.
 */
export function createTaskScheduler(): TaskScheduler {
  if (process.env.NFE_TASKS_DISABLED === '1') {
    safeLog('warn', '[nfe/tasks] NFE_TASKS_DISABLED=1 — async reconcile runs in sweep-only mode');
    return noopTaskScheduler;
  }
  return new FirebaseTaskQueueScheduler();
}
