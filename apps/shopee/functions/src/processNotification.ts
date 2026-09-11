import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import {
  SHOPEE_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
  handleNotificationTask,
} from '../../lib/shopee/notificacoes/notificacao';
import { getDb } from './lib/admin';
import { readCacheSummary } from '@delfrance/data/admin/cache';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for Shopee push notifications (master plan step 3). The
 * receiver (App Hosting route) enqueues the lean payload onto this function's
 * auto-provisioned queue and answers **204 with an empty body** — a JSON body is
 * a FAILURE to Shopee — and the queue dispatches here, running the work
 * **in-process** (no HTTP hop, no OIDC) at a rate bounded by `rateLimits`.
 *
 * `retryConfig.maxAttempts` mirrors `TASK_MAX_ATTEMPTS`: the handler retries a
 * transient failure with backoff, and on the FINAL attempt persists it as
 * `failed` (so the `onSchedule` sweep re-drives it) instead of throwing — the
 * throw/persist disposition lives in `handleNotificationTask` so it stays
 * unit-testable. The happy path persists NOTHING (the cost win).
 *
 * ⚠️ `secrets` — the conta arms sign a PUBLIC Shopee call (`get_shops_by_partner`
 * behind the authorization-expiry producer), so this function needs the partner
 * credentials bound. Without them every conta-code delivery throws
 * `ShopeeConfigError`, which the pipeline treats as transient and parks after
 * the retries; the ack and park arms would keep working, so the failure would
 * look partial rather than like a missing binding.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST equal
 * `SHOPEE_NOTIFICATION_QUEUE` (the receiver enqueues against that string).
 * Rename both together, or the enqueue targets a non-existent queue (silent drop).
 */
export const processShopeeNotification = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    secrets: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
    // ⚠️ NOT the gen2 default of 60 s, and not this codebase's `onSchedule`
    // value of 540 either. Since step 5 a code-3 delivery runs the order
    // import: two Shopee calls (`get_order_detail` + `get_escrow_detail`), up to
    // two collectionGroup queries and up to four SKU probes PER LINE, one
    // transaction and one incidente create per unbound line. On a 20-line order
    // that is comfortably past 60 s, and a timeout mid-import is the one failure
    // that hands a half-written pedido to a retry.
    //
    // ⚠️ Why not simply take 540, the value every `onSchedule` here carries. A
    // budget far above the work's real ceiling does not make a slow import
    // succeed — it makes a HUNG one invisible for that much longer, which is
    // exactly the argument `monitorShopeePushConfig` records for its 120 s
    // (`shopeeCall` carries no timeout of its own). The retry ladder is the
    // second half: 3 attempts of 300 s plus 2 backoffs of ≤ 300 s is ~25 min, so
    // a delivery is durable as `failed` well inside the hot reprocess sweep's
    // hourly window. At 540 it would be ~37 min — still inside the hour, but
    // with half the slack, and claiming a nine-minute import is legitimate.
    //
    // ⚠️ Step 6 adds writes to this path but NO new Shopee call: the same
    // `get_escrow_detail` the import already makes now also produces the
    // pagamento, so the delivery gains one `tx.get` + one `tx.update` on a
    // subcollection document and nothing that touches the network — the budget
    // above is unchanged, and the ladder invariant `index.test.ts` pins
    // (3 × 300 + 2 × 300 = 1 500 ≤ 1 800) is untouched.
    timeoutSeconds: 300,
    retryConfig: {
      maxAttempts: TASK_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    rateLimits: { maxConcurrentDispatches: 3, maxDispatchesPerSecond: 5 },
  },
  async (req) => {
    // Read off the RAW payload, not the `TaskResult`: these two survive the
    // shared pipeline's schema-parse drop, where there is no validated payload
    // and no channel result at all — which is precisely the case an operator
    // most needs named.
    const payload = req.data as { code?: unknown; shopId?: unknown } | null;
    const result = await handleNotificationTask(getDb(), req.data, req.retryCount ?? 0);
    // ⚠️ `outcome` alone is not enough, and that gap is not theoretical: on
    // Mercado Livre's first live run the equivalent line reported a bare success
    // for every delivery while nothing was being written, because one
    // disposition covered both "did the work" and "found nothing to do" (#1087).
    //
    // `kind` separates an aviso from an ack the channel decided on, from a park,
    // and from the shared pipeline's schema-parse drop (which carries no `kind`
    // at all); `detail` names WHICH ack or park; `code` is Shopee's push_code,
    // the only thing that says what the delivery was about; `shopId` is the
    // shop it named, which is what a `defer` for an unmapped shop is ABOUT.
    //
    // ONE call on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.detail="nenhuma-loja-mapeada"`), so more fields beat more
    // lines. `?? null` rather than leaving them undefined: Cloud Logging drops
    // `undefined` keys, so the key would vanish instead of reading as absent.
    //
    // Never the push BODY, `data`, or any credential: this line is read by
    // operators and Shopee payloads carry buyer-facing resource ids.
    //
    // ⚠️ `orderSn` is the ONE exception to that last sentence, and it is not a
    // relaxation: `order_sn` is the pedido's `numero`, an operator's only search
    // handle, and it already sits in the clear as a segment of the
    // `notificacoesShopee` doc id (`3:<shop>:<ordersn>:<carimbo>`). It names no
    // buyer. `itensSemProduto` rides beside it because a successful import that
    // bound no produto is the one "done" an operator must still act on.
    logger.info('[shopee] processed notification task', {
      queue: SHOPEE_NOTIFICATION_QUEUE,
      outcome: result.outcome,
      kind: result.kind ?? null,
      detail: result.detail ?? null,
      code: typeof payload?.code === 'number' ? payload.code : null,
      shopId: typeof payload?.shopId === 'number' ? payload.shopId : null,
      lojas: result.lojas ?? null,
      orderSn: result.orderSn ?? null,
      itensSemProduto: result.itensSemProduto ?? null,
      retryCount: req.retryCount ?? 0,
      // CUMULATIVE for this instance — a notification has no tick to bracket
      // (the sweeps in `index.ts` bracket their own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
