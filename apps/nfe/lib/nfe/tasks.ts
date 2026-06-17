/**
 * Cloud Tasks scheduler for the async NF-e reconciler.
 *
 * When a lote is accepted asynchronously (`cStat=103` + `nRec`), the emitter
 * hands off immediately and schedules a **Cloud Task** that POSTs
 * `/api/nfe/reconciliar` at `now + tMed` (SEFAZ's estimate, default 60 s). The
 * reconcile endpoint consults the lote by receipt and, while still processing
 * (`cStat=105`), re-enqueues the next consult with backoff up to a cap. This
 * mirrors the old Flutter `gerarTaskConsultarNFe` / `CloudTasksClient`
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:2119`,
 * `.old/.../bigquerydart/lib/src/tasks_client.dart`).
 *
 * Transport note: we create tasks through the Cloud Tasks **REST** API with an
 * ADC-authenticated `google-auth-library` client — the same library used for
 * verifying the incoming OIDC token in `auth.ts`. This avoids pulling the heavy
 * `@google-cloud/tasks` gRPC client for one call (and keeps the dependency set
 * to a package already vendored in the monorepo). The queue mints the OIDC
 * token at dispatch from `serviceAccountEmail` + `audience`; we only name them.
 *
 * Config (wired from Terraform outputs at deploy — see `infra/terraform`):
 *   - `NFE_TASKS_QUEUE`     full queue path `projects/<p>/locations/<r>/queues/<name>`
 *   - `NFE_TASKS_ENDPOINT`  absolute reconcile URL (also the OIDC audience)
 *   - `NFE_TASK_RUNNER_SA`  service-account email the queue impersonates
 *   - `NFE_TASKS_DISABLED=1` deliberate opt-out → sweep-only (the backstop cron
 *      still reconciles). Any *other* incomplete config throws `NFeTasksConfigError`
 *      so a half-configured deploy fails loud instead of silently dropping tasks.
 */
import { z } from 'zod';
import { GoogleAuth } from 'google-auth-library';

import type { TpEmis } from '@delfrance/integrations-nfe';

import { safeLog } from './log';

/** Cloud Tasks REST endpoint (v2). `{queue}` is the full queue resource path. */
const CLOUD_TASKS_API = 'https://cloudtasks.googleapis.com/v2';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/**
 * JSON body the queue delivers to `/api/nfe/reconciliar`. Shared between the
 * producer (here) and the consumer (the route) so the contract has one
 * definition. `kind` is a discriminator so PR3 can add a CC-e variant without
 * breaking older in-flight tasks.
 */
export const consultaTaskPayloadSchema = z.object({
  kind: z.literal('consulta-lote'),
  /** Owning filial — selects the A1 cert that signs the consult. */
  filialId: z.string().min(1),
  /** Lote receipt (`consReciNFe` is consulted by this, never by chave). */
  nRec: z.string().min(1),
  /** SEFAZ `tpEmis` of the lote — routes the consult to the right authorizer. */
  tpEmis: z.number().int(),
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
 * The enqueue seam. The orchestrator depends on this interface, not on Cloud
 * Tasks directly, so unit tests pass a fake recorder. Routes obtain the real
 * one via `createTaskScheduler()`.
 */
export interface TaskScheduler {
  enqueueConsulta(input: ConsultaTaskInput): Promise<void>;
}

/**
 * Silent no-op scheduler — the orchestrator's **default** when no scheduler is
 * threaded in (e.g. unit tests that don't assert enqueue). A missing enqueue
 * degrades to "the backstop sweep reconciles it later", never to incorrect
 * state — so the default is safe, while production routes opt into the real
 * scheduler explicitly.
 */
export const noopTaskScheduler: TaskScheduler = {
  async enqueueConsulta() {
    /* no-op */
  },
};

/**
 * Thrown when Cloud Tasks is expected (deployed env, not `NFE_TASKS_DISABLED`)
 * but the config is incomplete. Fails loud at the route boundary so a
 * half-configured deploy is caught in testing rather than silently dropping the
 * async reconcile onto the slow backstop sweep.
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

/** Real scheduler — creates a Cloud Task via the REST API (ADC auth). */
class CloudTasksRestScheduler implements TaskScheduler {
  // One GoogleAuth instance reused across calls — caches the ADC token.
  private readonly auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] });

  constructor(
    private readonly queue: string,
    private readonly endpoint: string,
    private readonly serviceAccountEmail: string,
  ) {}

  async enqueueConsulta(input: ConsultaTaskInput): Promise<void> {
    const payload: ConsultaTaskPayload = {
      kind: 'consulta-lote',
      filialId: input.filialId,
      nRec: input.nRec,
      tpEmis: input.tpEmis,
      attempt: input.attempt,
    };
    const client = await this.auth.getClient();
    await client.request({
      url: `${CLOUD_TASKS_API}/${this.queue}/tasks`,
      method: 'POST',
      data: {
        task: {
          scheduleTime: new Date(input.scheduleAtMs).toISOString(),
          httpRequest: {
            url: this.endpoint,
            httpMethod: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // Cloud Tasks wants the body base64-encoded on the wire.
            body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
            oidcToken: {
              serviceAccountEmail: this.serviceAccountEmail,
              audience: this.endpoint,
            },
          },
        },
      },
    });
  }
}

/**
 * Build the scheduler from the environment.
 *
 *  - `NFE_TASKS_DISABLED=1` → `noopTaskScheduler` (deliberate sweep-only) with a
 *    one-line warning so the mode is visible in logs.
 *  - All of `NFE_TASKS_QUEUE` / `NFE_TASKS_ENDPOINT` / `NFE_TASK_RUNNER_SA`
 *    present → real `CloudTasksRestScheduler`.
 *  - Otherwise → `NFeTasksConfigError` (fail loud).
 *
 * Routes call this per request and let the error surface (the route maps it to
 * a 5xx) so a misconfigured deploy is impossible to miss.
 */
export function createTaskScheduler(): TaskScheduler {
  if (process.env.NFE_TASKS_DISABLED === '1') {
    safeLog('warn', '[nfe/tasks] NFE_TASKS_DISABLED=1 — async reconcile runs in sweep-only mode');
    return noopTaskScheduler;
  }
  const queue = process.env.NFE_TASKS_QUEUE;
  const endpoint = process.env.NFE_TASKS_ENDPOINT;
  const serviceAccountEmail = process.env.NFE_TASK_RUNNER_SA;
  const missing: string[] = [];
  if (!queue) missing.push('NFE_TASKS_QUEUE');
  if (!endpoint) missing.push('NFE_TASKS_ENDPOINT');
  if (!serviceAccountEmail) missing.push('NFE_TASK_RUNNER_SA');
  if (missing.length > 0) throw new NFeTasksConfigError(missing);
  return new CloudTasksRestScheduler(queue!, endpoint!, serviceAccountEmail!);
}
