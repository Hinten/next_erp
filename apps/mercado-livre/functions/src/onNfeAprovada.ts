import { logger } from 'firebase-functions';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { nfeMeta } from '@delfrance/schemas';

import { createMlNfeUploadScheduler } from '../../lib/marketplace/mlNfeUploadTasks';
import { MlTasksDisabledError } from '../../lib/marketplace/mlTasks';
import { decideNfeUploadDispatch, enqueueNfeUpload } from '../../lib/marketplace/nfeUpload';
import { getDb } from './lib/admin';

/**
 * NF-e → Mercado Livre invoice upload trigger (Step 12, #739) — this codebase's
 * FIRST Firestore trigger. Fires on every `pedidos/{pedidoId}/nfev4/{nfeId}`
 * write and delegates to the pure `decideNfeUploadDispatch` disposition: when a
 * production (`<tpAmb>1`) NF-e reaches `estado 'a'` (aprovada) with its signed
 * `xml_nfe_proc` present, it enqueues ONE `{ pedidoId, nfeId }` task onto the
 * `processMercadoLivreNfeUpload` queue via `enqueueNfeUpload` (which stamps the
 * `mlEnvio` pendente marker so redundant re-fires within the TTL dedupe).
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root gotcha); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires.
 * Mirrors apps/whatsapp's `sendOutbound` (the same inlined-at-build-time
 * `FIREBASE_DATABASE_ID` — see build.mjs).
 *
 * `retry: true` → Eventarc at-least-once, and it exists for TRANSIENT
 * enqueue/stamp failures. A redelivery replays the ORIGINAL CloudEvent — the
 * SAME stale before/after snapshots, not the current doc — so the decision can
 * re-enqueue a task that already resolved. That duplicate is harmless: the
 * task handler re-gates everything against FRESH reads, the GET-shipment
 * eligibility gate, and the `shipment_invoice_already_saved` → ja-enviado
 * mapping.
 *
 * NO `secrets:` binding — deliberately. This trigger never touches the ML API
 * (that is the queue handler's job); per `src/options.ts`'s per-function-secrets
 * rule, a function with no ML API call must not get the app credentials bound.
 *
 * `MlTasksDisabledError` (the shared `MERCADO_LIVRE_TASKS_DISABLED` valve) is
 * logged + swallowed, NOT retried: no sweep exists for this queue, so while the
 * valve is on an approval goes un-enqueued — the poke/route re-drive is the
 * recovery path once the valve lifts.
 */
export const onNfeAprovada = onDocumentWritten(
  {
    document: `${nfeMeta.collectionPath}/{nfeId}`,
    database: process.env.FIREBASE_DATABASE_ID ?? 'default',
    region: process.env.FUNCTIONS_REGION ?? 'us-east5',
    retry: true,
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived path prefix,
    // so its type isn't inferred into `event.params` (only the trailing
    // `{nfeId}` is) — both are present at runtime.
    const { pedidoId, nfeId } = event.params as { pedidoId: string; nfeId: string };
    const nowMs = Date.now();
    const decision = decideNfeUploadDispatch(
      event.data?.before.data(),
      event.data?.after.data(),
      nowMs,
    );
    logger.info('[mercado-livre] onNfeAprovada', { pedidoId, nfeId, decision });
    if (decision.action !== 'enqueue') return;
    try {
      await enqueueNfeUpload(getDb(), createMlNfeUploadScheduler(), { pedidoId, nfeId }, nowMs);
    } catch (err) {
      if (err instanceof MlTasksDisabledError) {
        logger.warn(
          '[mercado-livre] onNfeAprovada enqueue skipped — MERCADO_LIVRE_TASKS_DISABLED=1 ' +
            '(no sweep for this queue; poke/route re-drives once the valve lifts)',
          { pedidoId, nfeId },
        );
        return;
      }
      throw err;
    }
  },
);
