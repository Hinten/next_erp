/**
 * Task scheduler for the Shopee MASS PRODUCT IMPORT ("Importar todos os
 * anúncios", master-plan step 9, #1517) — backed by a **Firebase Functions task
 * queue** (`onTaskDispatched`), exactly like `../shopeeTasks.ts` (the push
 * pipeline) and `apps/mercado-livre`'s `mlMassImportTasks.ts` (the shape this
 * ports).
 *
 * The `/importar-todos` route enqueues the FIRST dispatch (`{ jobId,
 * integracaoId }`) after `iniciarImportacaoShopee` created the job doc;
 * `processarImportacaoShopee` then re-enqueues onto the SAME queue for every
 * scan/drain continuation AND for the rate-limit pause — so this scheduler is a
 * dependency of the task handler itself (self-continuation), not just of the
 * route. Two identities therefore dispatch this queue, which is what the
 * `tasks-invoker-inventory` entry records.
 *
 * ## Config — no new environment variable
 *
 * It REUSES `../shopeeTasks.ts`'s two knobs (one valve, one region knob, for
 * every Shopee queue in this app — the Mercado Livre precedent):
 *   - `SHOPEE_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link ShopeeMassImportTasksDisabledError}. ⚠️ Unlike the push pipeline
 *     there is NO sweep behind this path, so the caller (route or task handler)
 *     must surface it as a `failed` job, never as a silent drop.
 *   - `SHOPEE_TASKS_REGION` (falling back to `FUNCTIONS_REGION`; no default — an
 *     unset value THROWS on the first enqueue) → the region the function and its
 *     queue live in. The region-qualified name is mandatory: without it the
 *     Admin SDK targets `us-central1`, the task is **silently dropped**, and the
 *     caller still sees success (#1108).
 *
 * ⚠️ The valve is read through {@link shopeeTasksDesabilitado}, the ONE reader of
 * `SHOPEE_TASKS_DISABLED` in this app. Reading `process.env` here would make
 * this a second reader and that function's docblock claim would go stale.
 *
 * ⚠️ A separate error class from `ShopeeTasksDisabledError` on purpose: that one
 * is inside `core/containment.ts`'s `erroContidoPorConta`, so a mass import that
 * raised it would be CONTAINED as one conta's `lastError` instead of stamping
 * the job `failed`. The class is declared in `./errosImportacao.ts` (beside the
 * import's other errors) so the job module can `instanceof` it without
 * importing this adapter, and this adapter never imports the job module.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks';
import { ShopeeMassImportTasksDisabledError } from './errosImportacao';
import { SHOPEE_MASS_IMPORT_QUEUE } from './importacaoMassa';
import type { AgendadorImportacaoShopee, ImportacaoShopeeTaskPayload } from './itemLido';

/** Real scheduler — enqueues onto the `processShopeeMassImport` queue. */
class AgendadorFirebaseImportacaoShopee implements AgendadorImportacaoShopee {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1). Binds the default
  // admin app, which App Hosting and the Functions runtime both populate.
  private fila() {
    return getFunctions(getAdminApp()).taskQueue<ImportacaoShopeeTaskPayload>(
      `locations/${shopeeTasksRegion()}/functions/${SHOPEE_MASS_IMPORT_QUEUE}`,
    );
  }

  /**
   * ⚠️ `scheduleDelaySeconds` is OMITTED entirely when the caller did not ask
   * for one, rather than passed as an explicit `undefined`: the option object is
   * forwarded to Cloud Tasks and "no delay" and "a delay of undefined" are not
   * the same request. It exists for exactly ONE caller — the rate-limit pause —
   * because Shopee publishes no rate limit and the only honest pacing signal is
   * `ShopeeRateLimitError.retryAfterSeconds`; a delayed re-enqueue is how a
   * pause is expressed without consuming a retry attempt.
   */
  async enqueue(
    payload: ImportacaoShopeeTaskPayload,
    opts?: { readonly scheduleDelaySeconds?: number },
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
 *     {@link ShopeeMassImportTasksDisabledError} without touching the transport;
 *   - otherwise → the real {@link AgendadorFirebaseImportacaoShopee}.
 */
export function createShopeeMassImportScheduler(): AgendadorImportacaoShopee {
  if (shopeeTasksDesabilitado()) {
    return {
      async enqueue() {
        throw new ShopeeMassImportTasksDisabledError();
      },
    };
  }
  return new AgendadorFirebaseImportacaoShopee();
}
