/**
 * Task scheduler for the Shopee NF-e XML upload (master-plan step 14, #1522) —
 * backed by a **Firebase Functions task queue** (`onTaskDispatched`), exactly
 * like `../precos/shopeePriceSyncTasks.ts` (the shape this clones) and
 * `../estoque/shopeeStockTasks.ts`. It is the channel's FIFTH queue.
 *
 * Its producers are the ones `./tarefaNfe.ts` names: the Firestore trigger that
 * sees an NF-e reach `aprovada` (the first enqueue, held for the SERPRO wait),
 * the `/enviar-nfe` route (an operator re-drive), and the task handler ITSELF —
 * the SERPRO re-enqueue, the burst pause, the daily park and the later
 * read-only recheck are all delayed re-enqueues onto this SAME queue, which is
 * how each waits without spending one of the queue's attempts. The CLI runs the
 * handler in process with a recording scheduler and never reaches this module.
 *
 * ⚠️ **The queue name is a RENAME TRAP.** A task is routed by NAME: the
 * deployed function's EXPORT name must equal {@link SHOPEE_NFE_UPLOAD_QUEUE},
 * and the functions index asserts that at module load. A half-rename enqueues
 * onto a queue nothing drains, while every producer reports success.
 *
 * ## Config — no new environment variable
 *
 * It REUSES `../shopeeTasks.ts`'s two knobs (one valve, one region knob, for
 * every Shopee queue in this app):
 *   - `SHOPEE_TASKS_DISABLED=1` → `enqueue()` throws
 *     {@link ShopeeNfeUploadTasksDisabledError} without touching the transport.
 *     ⚠️ There is NO NF-e sweep behind this path, so every caller must answer
 *     the class explicitly — the trigger raises the `tasks-desabilitadas`
 *     aviso, the route answers 503 — never drop it silently.
 *   - `SHOPEE_TASKS_REGION` (falling back to `FUNCTIONS_REGION`; no default — an
 *     unset value THROWS on the first enqueue) → the region the function and its
 *     queue live in. The region-qualified name is mandatory: without it the
 *     Admin SDK targets its own default region, the task is **silently
 *     dropped**, and the caller still sees success (#1108).
 *
 * ⚠️ The valve is read through {@link shopeeTasksDesabilitado}, the ONE reader
 * of `SHOPEE_TASKS_DISABLED` in this app, and the region through
 * {@link shopeeTasksRegion}. This folder reads no environment of its own (its
 * discipline grep), so both come from the shared module — never a second
 * reader here.
 *
 * ⚠️ The valve class is the NF-e queue's OWN (`./errosNfe`), not the channel's
 * shared tasks-disabled class: the shared one is in `core/containment.ts`'s
 * per-conta containment set, so an NF-e enqueue raising it could be contained
 * as one conta's `lastError` instead of reaching the trigger's aviso or the
 * route's 503.
 *
 * ⚠️ Every payload is validated against the task's own `.strict()` schema
 * BEFORE anything else — before the valve, the region and the transport. The
 * dispatcher parses the same schema on delivery and DROPS what it refuses, so a
 * payload that would not survive it must fail HERE, at the producer, where the
 * caller can see it — not one queue hop later as a dropped task. The error is
 * the schema library's own, whose message names paths and expectations, never
 * the values.
 */
import { getFunctions } from 'firebase-admin/functions';

import { getAdminApp } from '../../firebase/admin';
import { shopeeTasksDesabilitado, shopeeTasksRegion } from '../shopeeTasks';
import { SHOPEE_NFE_UPLOAD_QUEUE } from './constantesNfe';
import { ShopeeNfeUploadTasksDisabledError } from './errosNfe';
import {
  tarefaNfeShopeeSchema,
  type AgendadorNfeShopee,
  type OpcoesDeEnfileiramentoNfe,
  type TarefaNfeShopee,
} from './tarefaNfe';

/**
 * The payload as the queue will carry it: the schema's OUTPUT, every default
 * applied. Throws the schema library's error for anything the dispatcher
 * would drop — an empty id, an unknown phase, a negative or fractional
 * counter, or ANY extra key (the order number and the access key included:
 * neither belongs in a payload that the console and the dispatch logs show).
 */
function validarTarefa(payload: TarefaNfeShopee): TarefaNfeShopee {
  return tarefaNfeShopeeSchema.parse(payload);
}

/**
 * The Cloud Tasks options for ONE enqueue, or `undefined` for "dispatch now".
 *
 * ⚠️ Only a delay GREATER than zero is a delay. Absent, `0` and a negative
 * value all mean "now", and "now" is expressed by OMITTING the options object
 * entirely — never by forwarding `{ scheduleDelaySeconds: undefined }` or a
 * zero, so the call does not rely on the SDK treating either as absent. A
 * zero is a real input here: the SERPRO wait helper clamps an old NF-e's
 * remaining wait to `0`.
 */
function opcoesDaFila(
  opts: OpcoesDeEnfileiramentoNfe | undefined,
): { scheduleDelaySeconds: number } | undefined {
  const atraso = opts?.scheduleDelaySeconds;
  return atraso !== undefined && atraso > 0 ? { scheduleDelaySeconds: atraso } : undefined;
}

/** Real scheduler — enqueues onto the `processShopeeNfeUpload` queue. */
class AgendadorFirebaseNfeShopee implements AgendadorNfeShopee {
  // Region-qualified name so the queue resolves to the deployed function's
  // region (the Admin SDK otherwise uses its own default). Binds the default
  // admin app, which App Hosting and the Functions runtime both populate.
  private fila() {
    return getFunctions(getAdminApp()).taskQueue<TarefaNfeShopee>(
      `locations/${shopeeTasksRegion()}/functions/${SHOPEE_NFE_UPLOAD_QUEUE}`,
    );
  }

  async enqueue(payload: TarefaNfeShopee, opts?: OpcoesDeEnfileiramentoNfe): Promise<void> {
    const tarefa = validarTarefa(payload);
    const opcoes = opcoesDaFila(opts);
    const fila = this.fila();
    await (opcoes === undefined ? fila.enqueue(tarefa) : fila.enqueue(tarefa, opcoes));
  }
}

/**
 * Build the scheduler from the environment:
 *   - valve closed → a scheduler whose `enqueue()` validates the payload and
 *     then throws {@link ShopeeNfeUploadTasksDisabledError} without touching
 *     the transport;
 *   - otherwise → the real {@link AgendadorFirebaseNfeShopee}.
 *
 * The valve is decided at CONSTRUCTION (the sibling adapters' contract): a
 * caller that wants a fresh decision builds a fresh scheduler, and the
 * functions entry builds one per dispatch. Building it reads NO region: the
 * first `enqueue` is where a missing region refuses, so a delivery that ends
 * without re-enqueuing does not fail on a knob it did not need.
 */
export function createShopeeNfeUploadScheduler(): AgendadorNfeShopee {
  if (shopeeTasksDesabilitado()) {
    return {
      async enqueue(payload: TarefaNfeShopee): Promise<void> {
        validarTarefa(payload);
        throw new ShopeeNfeUploadTasksDisabledError();
      },
    };
  }
  return new AgendadorFirebaseNfeShopee();
}
