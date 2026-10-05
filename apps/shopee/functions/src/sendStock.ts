import { FieldValue } from 'firebase-admin/firestore';
import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { readCacheSummary } from '@delfrance/data/admin/cache';

import {
  SHOPEE_STOCK_SEND_QUEUE,
  STOCK_SEND_MAX_ATTEMPTS,
  concurrentDispatches,
  dispatchesPerSecond,
} from '../../lib/shopee/estoque/constantesEstoque';
import { processShopeeStockSendTask } from '../../lib/shopee/estoque/enviarEstoque';
import { createShopeeStockTaskScheduler } from '../../lib/shopee/estoque/shopeeStockTasks';
import { getDb } from './lib/admin';
import { tasksInvokerOptions } from './tasksInvoker';

/**
 * Cloud Tasks dispatcher for the Shopee STOCK PUSH (master plan step 12,
 * #1520) — the THIRD queue of this codebase. Ports
 * `apps/mercado-livre/functions/src/sendStock.ts`.
 *
 * ONE task is ONE `update_stock` call: one listing, at most
 * `SHOPEE_UPDATE_STOCK_MAX_MODELS` models, with the quantities the sweep
 * computed. The three `onSchedule` sweeps (./sweepStock) enqueue them; the
 * manual push does NOT — it calls `processShopeeStockSendTask` in process, so
 * an operator gets a verdict inside their own request instead of a 202.
 *
 * ⚠️ **RESOLVING IS SUCCESS TO THE QUEUE — for every outcome.** `descartado`
 * and `erro-registrado` included: the ladder has already written what it
 * learned onto the listing, and re-driving it would repeat a refusal the
 * provider already gave. Only a THROW asks for a retry, and the handler
 * neither translates an outcome into a failure nor swallows a throw — the
 * three-attempt ladder below IS the retry.
 *
 * ⚠️ **`ignoreSyncFlag` is NEVER set here**, and that is the point of the
 * option existing: it bypasses the master valve (`SHOPEE_STOCK_SYNC_ENABLED`)
 * and belongs to the MANUAL push alone, where a human is watching. A queue that
 * set it would keep writing to a live marketplace after the valve was closed —
 * the one thing closing the valve is for. Pinned twice: by a source-text
 * assertion over this file (`sendStock.test.ts`) and by the sender's own
 * `!== true` comparison, under which absent and `false` both OBEY the valve.
 *
 * ⚠️ `increment` is REQUIRED and must be the real `FieldValue.increment`. It is
 * the clamp aviso's counter seam, and `packages/data/src/admin/**` may only
 * `import type` from firebase-admin — so the runtime import lives here, exactly
 * as it does for the two aviso-writing schedules in `index.ts`. A stub
 * returning a number would turn `ocorrencias` into a read-modify-write, which
 * loses a bump whenever two producers land together.
 *
 * ⚠️ `jitterSec` is where the RANDOMNESS lives. The sender's default is a
 * deterministic `0` so a delay is testable; the real spread belongs to the
 * deployed dispatcher, because the pause rung re-enqueues every task of a
 * paused conta and they must not all come back on the same second.
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST
 * equal {@link SHOPEE_STOCK_SEND_QUEUE}, and `index.ts` asserts the pair at
 * module load. The hazard here is the mass import's, sharper: **this queue
 * re-enqueues onto ITSELF twice** — the pause rung (a conta paused mid-sweep)
 * and the burst arm (a 429) — so a half-rename does not break the first
 * dispatch, it breaks the run MID-SWEEP while every surface still reports
 * success.
 *
 * ⚠️ TWO identities dispatch it: the functions runtime SA (the three sweeps and
 * both self re-enqueues). `tasksInvokerOptions()` is AUTHORITATIVE for both
 * `roles/run.invoker` and `roles/cloudtasks.enqueuer` — a deploy REPLACES the
 * members, so a name left out of `TASKS_INVOKER_SA` LOSES the role, and the
 * dispatch leg fails invisibly (the enqueue already returned success).
 *
 * ⚠️ `secrets` — every send signs a Shop-signed `update_stock`, and the context
 * resolution refreshes the shop token, so both partner credentials must be
 * bound. Without them the first signed call throws `ShopeeConfigError`, which
 * the ladder does NOT contain: it rethrows, the queue retries three times and
 * the task dead-letters, so the symptom is a whole conta that never syncs
 * rather than a startup error naming the missing binding.
 */
export const sendShopeeStock = onTaskDispatched(
  {
    // roles/run.invoker on this service + roles/cloudtasks.enqueuer on its
    // queue, applied at deploy time from TASKS_INVOKER_SA. Absent when unset.
    ...tasksInvokerOptions(),
    secrets: ['SHOPEE_PARTNER_ID', 'SHOPEE_PARTNER_KEY'],
    // ⚠️ 120, and neither the 540 of this codebase's schedules nor the 300 of
    // the mass import. The work's ceiling is ONE `update_stock`, at most one
    // `get_item_promotion` and at most one clamped retry — three round trips —
    // and a budget far above that does not make a slow dispatch succeed, it
    // makes a HUNG one invisible for that much longer (processMassImport.ts's
    // own argument, one tier down because the work is one tier smaller).
    //
    // ⚠️ It is also what keeps this queue inside the invariant `index.test.ts`
    // pins for every queue in this codebase — `tentativas × timeout +
    // (tentativas − 1) × maxBackoff ≤ 1800`: 3 × 120 + 2 × 300 = 960 ✅, while
    // 540 would give 3 × 540 + 2 × 300 = 2220 ✗. Raising this number is
    // therefore not a local decision.
    timeoutSeconds: 120,
    retryConfig: {
      maxAttempts: STOCK_SEND_MAX_ATTEMPTS,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 2,
    },
    // ⚠️ Evaluated at DEPLOY time — Firebase bakes `rateLimits` into the queue
    // configuration during codebase analysis — so these are deploy-shell env
    // reads with the code defaults 2/2, and changing them is a REDEPLOY, never
    // a code edit. `tools/deploy-env/preflight.mjs` prints the pair on every
    // deploy and drift-checks it against `constantesEstoque.ts`.
    //
    // ⚠️ 2/2 rather than the mass import's 1/1, and the difference is argued in
    // `constantesEstoque.ts`: Shopee's limit is per APPLICATION, so the mass
    // import is right that a second worker spends the same quota twice — but on
    // THIS stream a burst is survivable and self-pacing, because a 429 arms a
    // conta pause plus a delayed re-enqueue that consumes no attempt, never a
    // hot retry loop. It is the first knob a rehearsal should move.
    rateLimits: {
      maxConcurrentDispatches: concurrentDispatches(),
      maxDispatchesPerSecond: dispatchesPerSecond(),
    },
    // ⚠️ No `region:` key: `options.ts` sets it globally for this codebase from
    // the build-time inlined `FUNCTIONS_REGION`, and the enqueuer defaults to
    // the same value. A local override here would let the two drift, and a
    // queue path pointing at the wrong region drops every task while the
    // enqueue still returns success (#1108).
  },
  async (req) => {
    const result = await processShopeeStockSendTask(getDb(), req.data, {
      scheduler: createShopeeStockTaskScheduler(),
      nowMs: Date.now(),
      // The aviso counter seam — see the module doc. Never a stub.
      increment: (by: number) => FieldValue.increment(by),
      // Logged by the ladder, never branched on: the payload is sent verbatim
      // on every attempt. It is what lets a line say "this listing has now
      // failed twice" without a second data source.
      retryCount: req.retryCount ?? 0,
      // The pause rung's spread — see the module doc.
      jitterSec: (maxS: number) => Math.floor(Math.random() * (maxS + 1)),
      // ⚠️ `ignoreSyncFlag` is DELIBERATELY absent. See the module doc.
    });

    // ONE line on purpose — the fields land in `jsonPayload` and are filterable
    // (`jsonPayload.outcome="pausado-reenfileirado"`), so more fields beat more
    // lines.
    //
    // `outcome` and `motivo` are NOT interchangeable and neither is redundant:
    // a CLEAN send that had to clamp up to a promotion's reserved floor is
    // `enviado` WITH `motivo: 'clampado-na-reserva'` — an annotation, not a
    // failure — so reading `motivo !== null` as "it failed" reports every
    // clamped send as broken. `chamadasShopee` is 0–3, and a 3 says the floor
    // path ran (update + promotion read + clamped retry), which is the only
    // place that cost is visible.
    //
    // Never a listing, a body, a URL or a credential: what the send learned is
    // already on the link document, which is the operator's view, and this line
    // only says which dispatch produced it.
    logger.info('[shopee] processed stock send task', {
      queue: SHOPEE_STOCK_SEND_QUEUE,
      outcome: result.outcome,
      motivo: result.motivo,
      retryCount: req.retryCount ?? 0,
      chamadasShopee: result.chamadasShopee,
      // CUMULATIVE for this instance — a dispatch has no tick to bracket (the
      // sweeps in ./sweepStock bracket their own with mark/delta instead).
      readCache: readCacheSummary(),
    });
  },
);
