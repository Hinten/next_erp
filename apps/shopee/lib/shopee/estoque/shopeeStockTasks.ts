/**
 * Task scheduler for the Shopee STOCK SEND queue (master-plan step 12, #1520)
 * — backed by a **Firebase Functions task queue** (`onTaskDispatched`), exactly
 * like `../shopeeTasks.ts` (the push pipeline) and
 * `../produtos/shopeeMassImportTasks.ts` (the shape this clones). It is the
 * channel's THIRD queue.
 *
 * The three stock sweeps enqueue one task per listing after the planner cut
 * them; the send handler then re-enqueues onto the **SAME** queue twice over —
 * once for the paused-conta rung, once when a burst refusal arms a pause — so
 * this scheduler is a dependency of the handler itself, not only of the sweeps.
 * Two identities therefore dispatch this queue (the functions runtime service
 * account for the first dispatch, the same one again for the self
 * re-enqueue), which is what the `tasks-invoker-inventory` row records. The
 * manual push runs in-process and adds no third identity.
 *
 * ⚠️ **The queue name is a RENAME TRAP, and this one bites in the middle.** The
 * queue a task is enqueued onto is resolved by NAME: the deployed function's
 * EXPORT name must equal {@link SHOPEE_STOCK_SEND_QUEUE}, and
 * `apps/shopee/functions/src/index.ts` asserts that at module load beside the
 * two rename-safety checks it already carries. Half-renaming here does not
 * break the START of a run — the sweep's first dispatch still lands — it breaks
 * the **self** re-enqueue, so a sweep that meets a paused conta or a burst
 * refusal stops mid-flight while every surface reports success and the tasks
 * quietly accumulate in a queue nothing serves.
 *
 * ## Config — no new environment variable
 *
 * It REUSES `../shopeeTasks.ts`'s two knobs (one valve, one region knob, for
 * every Shopee queue in this app — the Mercado Livre precedent):
 *   - `SHOPEE_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link ShopeeStockTasksDisabledError} without touching the transport. The
 *     two callers answer it differently ON PURPOSE: the send handler narrows it
 *     into its named `tasks-desabilitadas` discard, and the sweep lets it
 *     THROW, because the valve is a deployment state and a tick that cannot
 *     re-enqueue has not done its job.
 *   - `SHOPEE_TASKS_REGION` (falling back to `FUNCTIONS_REGION`; no default — an
 *     unset value THROWS on the first enqueue) → the region the function and
 *     its queue live in. The region-qualified name is mandatory: without it the
 *     Admin SDK targets `us-central1`, the task is **silently dropped**, and the
 *     caller still sees success (#1108, `../shopeeTasks.ts`).
 *
 * ⚠️ The valve is read through {@link shopeeTasksDesabilitado}, the ONE reader of
 * `SHOPEE_TASKS_DISABLED` in this app. Reading the variable here would make this
 * a second reader and that function's docblock claim would go stale — a test in
 * this folder greps this file's raw text for it.
 *
 * ⚠️ A separate error class from the channel's shared tasks-disabled one, on
 * purpose and for the mass import's exact reason: the shared class is named in
 * `core/containment.ts`'s `erroContidoPorConta`, so a stock sweep raising it
 * would be CONTAINED as one conta's `lastError` — N identical strings, one per
 * conta, and a green tick over a deployment-wide outage. The class lives in
 * `./errosEstoque` (beside the rest of the stock vocabulary) so the callers can
 * `instanceof` it without importing this adapter, and this adapter imports none
 * of them.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks';
import { SHOPEE_STOCK_SEND_QUEUE } from './constantesEstoque';
import { ShopeeStockTasksDisabledError } from './errosEstoque';
import type { TarefaDeEstoqueShopee } from './planoEstoque';

/** What a caller may ask of ONE enqueue beyond the payload itself. */
export interface OpcoesDeEnfileiramento {
  /**
   * Seconds to hold the task before it is dispatched.
   *
   * ⚠️ Absent means "dispatch it now", and that is NOT the same request as a
   * delay whose value happens to be undefined — see {@link
   * AgendadorFirebaseEstoqueShopee.enqueue}. Two callers pass it, both from the
   * send handler: the paused-conta rung (hold until the pause expires, plus
   * jitter) and the burst arm (hold for the refusal's own retry hint). Neither
   * consumes a queue attempt, which is the whole point of expressing a pause
   * this way.
   */
  readonly scheduleDelaySeconds?: number;
}

/**
 * The enqueue seam. The sweeps and the send handler depend on this interface,
 * not on the transport, so their unit tests pass a fake recorder; the real one
 * comes from {@link createShopeeStockTaskScheduler}.
 */
export interface AgendadorEstoqueShopee {
  enqueue(payload: TarefaDeEstoqueShopee, opts?: OpcoesDeEnfileiramento): Promise<void>;
}

/** Real scheduler — enqueues onto the `sendShopeeStock` queue. */
class AgendadorFirebaseEstoqueShopee implements AgendadorEstoqueShopee {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise defaults to us-central1). Binds the default
  // admin app, which App Hosting and the Functions runtime both populate.
  private fila() {
    return getFunctions(getAdminApp()).taskQueue<TarefaDeEstoqueShopee>(
      `locations/${shopeeTasksRegion()}/functions/${SHOPEE_STOCK_SEND_QUEUE}`,
    );
  }

  /**
   * ⚠️ `scheduleDelaySeconds` is OMITTED entirely when the caller did not ask
   * for one, rather than passed as an explicit `undefined`: the option object
   * is forwarded to Cloud Tasks, and "no delay" and "a delay of undefined" are
   * not the same request. The caller that needs a delay is the pause rung, and
   * a delayed re-enqueue is how a pause is expressed without spending one of
   * the queue's three attempts on waiting.
   */
  async enqueue(payload: TarefaDeEstoqueShopee, opts?: OpcoesDeEnfileiramento): Promise<void> {
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
 *     {@link ShopeeStockTasksDisabledError} without touching the transport;
 *   - otherwise → the real {@link AgendadorFirebaseEstoqueShopee}.
 *
 * Building it reads NO region: the first `enqueue` is where a missing region
 * refuses, so a surface that constructs a scheduler it never uses (a dry run,
 * a tick with nothing to send) does not fail on a knob it did not need.
 */
export function createShopeeStockTaskScheduler(): AgendadorEstoqueShopee {
  if (shopeeTasksDesabilitado()) {
    return {
      async enqueue() {
        throw new ShopeeStockTasksDisabledError();
      },
    };
  }
  return new AgendadorFirebaseEstoqueShopee();
}
