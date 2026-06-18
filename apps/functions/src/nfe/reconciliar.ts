import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';

import { postNfe } from './call-nfe';

/**
 * Cloud Tasks dispatcher for the async NF-e reconciler (#77/#81).
 *
 * `apps/nfe` enqueues one task per lote (at `now + tMed`, then per-attempt
 * backoff) via the Admin SDK `getFunctions().taskQueue('reconciliarNfe')`. The
 * queue is **auto-provisioned by this function on deploy** — no Terraform. Each
 * dispatch forwards the task payload to apps/nfe `/api/nfe/reconciliar`, which
 * does the actual SEFAZ consult-by-recibo, applies the per-chave outcome, and
 * re-enqueues the next consult while still pending.
 *
 * This dispatcher is deliberately **payload-agnostic**: it forwards `req.data`
 * (the apps/nfe `consultaTaskPayloadSchema` shape — `consulta-lote` today, a
 * `cce-vinculo` variant in #81) verbatim and lets apps/nfe validate + decide.
 * Keeping the schema in apps/nfe avoids a cross-app import.
 *
 * Retry contract (mirrors the apps/nfe route's status codes):
 *   - **2xx → return** (handled). 200 covers every terminal outcome INCLUDING
 *     cStat 656 (consumo indevido), which must NOT be retried — re-querying after
 *     a 656 is a SEFAZ-ban precedent (#77).
 *   - **non-2xx → throw**, so the queue retries within its bounded `retryConfig`.
 *
 * The next scheduled consult (backoff) is re-enqueued by apps/nfe itself (the
 * brain holding the SEFAZ runtime + state), not here — this stays a pure
 * forwarder.
 */
export async function handleReconcileTask(data: unknown): Promise<void> {
  const { status, ok } = await postNfe('/api/nfe/reconciliar', data);
  if (!ok) {
    throw new Error(`/api/nfe/reconciliar responded HTTP ${status}`);
  }
  logger.info(`reconciliarNfe → /api/nfe/reconciliar HTTP ${status}`);
}

export const reconciliarNfe = onTaskDispatched(
  {
    // Bounded transport-failure retries (NOT the per-tMed consult cadence — that
    // is apps/nfe's re-enqueue). Conservative so a flapping endpoint can't hammer.
    retryConfig: {
      maxAttempts: 5,
      minBackoffSeconds: 30,
      maxBackoffSeconds: 300,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 5, maxDispatchesPerSecond: 10 },
  },
  (req) => handleReconcileTask(req.data),
);
