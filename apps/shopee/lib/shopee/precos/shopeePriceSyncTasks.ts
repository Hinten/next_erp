/**
 * Task scheduler for the Shopee account-wide PRICE job ("Atualizar preços",
 * master-plan step 13, #1521) — backed by a **Firebase Functions task queue**
 * (`onTaskDispatched`), exactly like `../shopeeTasks.ts` (the push pipeline),
 * `../produtos/shopeeMassImportTasks.ts` (the shape this clones) and
 * `../estoque/shopeeStockTasks.ts`. It is the channel's FOURTH queue.
 *
 * The `/atualizar-precos` route enqueues the FIRST dispatch (`{ jobId,
 * integracaoId }`) after `iniciarEnvioPrecoShopee` created the job document;
 * `processarEnvioPrecoShopee` then re-enqueues onto the **SAME** queue for every
 * plan/drain continuation, for a burst pause and for the daily-quota park — so
 * this scheduler is a dependency of the task handler itself (self-continuation),
 * not only of the route. Two identities therefore dispatch this queue (the App
 * Hosting runtime service account for the first enqueue, the functions runtime
 * one for every re-enqueue), which is what the `tasks-invoker-inventory` row
 * records.
 *
 * ⚠️ **The queue name is a RENAME TRAP, and this one bites mid-run.** A task is
 * routed by NAME: the deployed function's EXPORT name must equal
 * {@link SHOPEE_PRICE_SYNC_QUEUE}, and `apps/shopee/functions/src/index.ts`
 * asserts that at module load beside the three rename-safety checks it already
 * carries. A half-rename does not break the START of a run — the route's first
 * enqueue still names a queue the old deploy serves — it breaks the
 * CONTINUATION, and the job document then stays `running` until the orphan
 * reclaim takes it six hours later, while every surface reported success.
 *
 * ## Config — no new environment variable
 *
 * It REUSES `../shopeeTasks.ts`'s two knobs (one valve, one region knob, for
 * every Shopee queue in this app — the Mercado Livre precedent):
 *   - `SHOPEE_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link ShopeePriceSyncTasksDisabledError} without touching the transport.
 *     ⚠️ Like the mass import there is NO sweep behind this path, so each caller
 *     surfaces it as a refusal or a `failed` job, never as a silent drop: the
 *     start route answers 503 (and `iniciarEnvioPrecoShopee` refuses on the same
 *     valve BEFORE a job document exists), and the dispatch stamps the job
 *     `failed` on the attempt that met it.
 *   - `SHOPEE_TASKS_REGION` (falling back to `FUNCTIONS_REGION`; no default — an
 *     unset value THROWS on the first enqueue) → the region the function and its
 *     queue live in. The region-qualified name is mandatory: without it the
 *     Admin SDK targets `us-central1`, the task is **silently dropped**, and the
 *     caller still sees success (#1108, `../shopeeTasks.ts`).
 *
 * ⚠️ The valve is read through {@link shopeeTasksDesabilitado}, the ONE reader of
 * `SHOPEE_TASKS_DISABLED` in this app. Reading the variable here would make
 * this a second reader — and a second environment reader under `precos/`, which
 * the folder's discipline test forbids outside `./constantesPreco.ts`.
 *
 * ⚠️ A separate error class from the channel's shared tasks-disabled one, for
 * the mass import's exact reason: the shared class is named in
 * `core/containment.ts`'s `erroContidoPorConta`, so a price job raising it would
 * be CONTAINED as one conta's `lastError` instead of stamping the job. The class
 * lives in `./errosPreco` (beside the rest of the price vocabulary) so the job
 * and the route can `instanceof` it without importing this adapter.
 *
 * ⚠️ The seam's types (`AgendadorPrecoShopee`, the payload, the options) are
 * declared in `./atualizarPrecos` and imported here as TYPES ONLY, so this
 * adapter depends on the job's vocabulary and the job never depends on the
 * transport — nor does this module load the job's graph at runtime.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks';
import type {
  AgendadorPrecoShopee,
  EnvioPrecoShopeeTaskPayload,
  OpcoesDeEnfileiramentoPreco,
} from './atualizarPrecos';
import { SHOPEE_PRICE_SYNC_QUEUE } from './constantesPreco';
import { ShopeePriceSyncTasksDisabledError } from './errosPreco';

/** Real scheduler — enqueues onto the `processShopeePriceSync` queue. */
class AgendadorFirebasePrecoShopee implements AgendadorPrecoShopee {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1). Binds the default
  // admin app, which App Hosting and the Functions runtime both populate.
  private fila() {
    return getFunctions(getAdminApp()).taskQueue<EnvioPrecoShopeeTaskPayload>(
      `locations/${shopeeTasksRegion()}/functions/${SHOPEE_PRICE_SYNC_QUEUE}`,
    );
  }

  /**
   * ⚠️ `scheduleDelaySeconds` is OMITTED entirely when the caller did not ask
   * for one, rather than passed as an explicit `undefined`: the option object is
   * forwarded to Cloud Tasks, and "no delay" and "a delay of undefined" are not
   * the same request. Two arms of the job ask for one — the burst pause
   * (`Retry-After`, else the stock sync's own pause length) and the daily park
   * (the next 00:00 UTC+8 plus jitter) — and a delayed re-enqueue is how either
   * is expressed without spending one of the queue's three attempts on waiting.
   * An explicit `0` IS a value and travels as one: the test is `!== undefined`,
   * never truthiness.
   */
  async enqueue(
    payload: EnvioPrecoShopeeTaskPayload,
    opts?: OpcoesDeEnfileiramentoPreco,
  ): Promise<void> {
    const atraso = opts?.scheduleDelaySeconds;
    await this.fila().enqueue(
      payload,
      atraso !== undefined ? { scheduleDelaySeconds: atraso } : undefined,
    );
  }
}

/**
 * Build the scheduler from the environment:
 *   - valve closed → a scheduler whose `enqueue()` throws
 *     {@link ShopeePriceSyncTasksDisabledError} without touching the transport;
 *   - otherwise → the real {@link AgendadorFirebasePrecoShopee}.
 *
 * The valve is decided at CONSTRUCTION (the two sibling adapters' contract): a
 * caller that wants a fresh decision builds a fresh scheduler, and the
 * functions entry builds one per dispatch. Building it reads NO region: the
 * first `enqueue` is where a missing region refuses, so a dispatch that ends
 * without re-enqueuing (a `noop`, the `completed` flip) does not fail on a knob
 * it did not need.
 */
export function createShopeePriceSyncScheduler(): AgendadorPrecoShopee {
  if (shopeeTasksDesabilitado()) {
    return {
      async enqueue() {
        throw new ShopeePriceSyncTasksDisabledError();
      },
    };
  }
  return new AgendadorFirebasePrecoShopee();
}
