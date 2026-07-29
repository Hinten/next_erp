import { logger } from 'firebase-functions';
import { onTaskDispatched } from 'firebase-functions/v2/tasks';
import { z } from 'zod';

import {
  MERCADO_LIVRE_NFE_UPLOAD_QUEUE,
  NFE_UPLOAD_MAX_ATTEMPTS,
  type NfeUploadTaskPayload,
  nfeUploadTaskSchema,
  processNfeUploadTask,
} from '../../lib/marketplace/nfeUpload';
import { getDb } from './lib/admin';

/**
 * Cloud Tasks dispatcher for the ML NF-e invoice upload (Step 12, #739). The
 * `onNfeAprovada` trigger enqueues one `{ pedidoId, nfeId }` task per approved
 * production NF-e; `processNfeUploadTask` re-reads the NF-e + pedido, resolves
 * the conta and POSTs the raw signed nfeProc XML to ML's
 * `POST /shipments/{shipmentId}/invoice_data?siteId=MLB` so the shipment leaves
 * `invoice_pending`. One task = one NF-e — no self-continuation.
 *
 * Retry window (`retryConfig`): 6 attempts × exponential backoff from 60s
 * (3 doublings, capped at 1800s) ≈ a 25–30 minute envelope. That is sized for
 * the SHORT-lived failure classes only: ML read-your-write consistency on a
 * fresh shipment, transient 429/5xx blips, and the up-to-15-minute race where
 * the order-import sweep hasn't yet stamped `freteInicial.externalId` on the
 * pedido. Anything longer-lived is either DETERMINISTIC (bad XML / homologação
 * ambiente / non-ML pedido — `processNfeUploadTask` resolves those without
 * throwing) or operator-paced (reauth), and re-enters via the poke/route
 * re-drive rather than by stretching this window.
 *
 * `retryConfig.maxAttempts` mirrors `NFE_UPLOAD_MAX_ATTEMPTS`: a transient
 * failure retries with backoff, and on the FINAL attempt `processNfeUploadTask`
 * resolves instead of throwing — stamping `freteInicial.estado = 'error'` on
 * the pedido when the upload itself failed (the flow's ONLY Firestore write;
 * failure DETAIL goes to structured Cloud Logging) — that disposition lives in
 * `nfeUpload.ts` so it stays unit-testable (the `processPriceSync.ts` pattern).
 *
 * `rateLimits` keep this to a single in-flight dispatch: uploads are rare (one
 * per approved NF-e), and serializing them keeps the per-conta token refresh +
 * the shipment GET/POST pair trivially contention-free. `timeoutSeconds: 120`
 * is ample for one `GET /shipments/{id}` + one invoice_data POST.
 *
 * Secrets: `MERCADO_LIVRE_CLIENT_ID` / `MERCADO_LIVRE_CLIENT_SECRET` are bound
 * on THIS function only (see `src/options.ts`'s per-function-secrets rule)
 * because `processNfeUploadTask`'s default `resolveApi` path refreshes the
 * conta's ML access token via `mercadoLivreOAuthConfig()` (reads both).
 *
 * ⚠️ The export name below IS the deployed function + queue name — it MUST
 * equal `MERCADO_LIVRE_NFE_UPLOAD_QUEUE` (the trigger's scheduler enqueues
 * against that string; enforced at load time in `index.ts`). Rename both
 * together.
 */
export const processMercadoLivreNfeUpload = onTaskDispatched(
  {
    retryConfig: {
      maxAttempts: NFE_UPLOAD_MAX_ATTEMPTS,
      minBackoffSeconds: 60,
      maxBackoffSeconds: 1800,
      maxDoublings: 3,
    },
    rateLimits: { maxConcurrentDispatches: 1, maxDispatchesPerSecond: 1 },
    timeoutSeconds: 120,
    secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET'],
  },
  async (req) => {
    let payload: NfeUploadTaskPayload;
    try {
      payload = nfeUploadTaskSchema.parse(req.data);
    } catch (err) {
      if (err instanceof z.ZodError) {
        // A coding/enqueue bug (this queue only ever receives our own
        // `{ pedidoId, nfeId }` payload) — nothing to retry, and no valid ids
        // to act on; this structured log (issues + raw data) is the only trace.
        logger.error('[mercado-livre] NF-e upload task DROPPED — malformed payload', {
          issues: err.issues,
          data: req.data,
        });
        return;
      }
      throw err;
    }

    const result = await processNfeUploadTask(
      { db: getDb(), nowMs: Date.now() },
      payload,
      req.retryCount ?? 0,
    );
    // This structured line IS the per-NF-e observability in the zero-write
    // model (no Firestore marker): outcome + motivo + retryCount per attempt;
    // shipmentId and the ML code/message on failures come from the handler's
    // own error logs inside `processNfeUploadTask`.
    logger.info('[mercado-livre] processed NF-e upload task', {
      queue: MERCADO_LIVRE_NFE_UPLOAD_QUEUE,
      pedidoId: payload.pedidoId,
      nfeId: payload.nfeId,
      outcome: result.outcome,
      motivo: result.motivo,
      retryCount: req.retryCount ?? 0,
    });
  },
);
