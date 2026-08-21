import { logger } from 'firebase-functions';
import { FUNCTIONS_REGION } from './options';
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import { nfeMeta } from '@delfrance/schemas';

import { createMlNfeUploadScheduler } from '../../lib/marketplace/mlNfeUploadTasks';
import { MlTasksDisabledError } from '../../lib/marketplace/mlTasks';
import { decideNfeUploadDispatch, shouldUploadForPedido } from '../../lib/marketplace/nfeUpload';
import { getDb } from './lib/admin';

/**
 * NF-e → Mercado Livre invoice upload trigger (Step 12, #739) — this codebase's
 * FIRST Firestore trigger. Fires on every `pedidos/{pedidoId}/nfev4/{nfeId}`
 * write and delegates to the pure `decideNfeUploadDispatch` disposition: when a
 * production (`<tpAmb>1`) NF-e reaches `estado 'a'` (aprovada) with its signed
 * `xml_nfe_proc` present, ONE pedido read (`shouldUploadForPedido`) filters
 * non-ML pedidos, then it enqueues ONE `{ pedidoId, nfeId }` task onto the
 * `processMercadoLivreNfeUpload` queue.
 *
 * ZERO-WRITE MODEL (owner decision, rev 2): the happy path writes NOTHING to
 * Firestore — there is no per-NF-e marker. Idempotency is the task handler's
 * live shipment-status gate (substatus leaves `invoice_pending` once an invoice
 * is uploaded, so a duplicate task no-ops), per-NF-e observability is the
 * handler's structured Cloud Logging, and the ONLY Firestore write in the whole
 * flow is the failure stamp `freteInicial.estado = 'error'` on the pedido. The
 * single pedido read here is the cost win: a non-ML NF-e approval costs exactly
 * 1 read — no task ever exists for it, and nothing is stamped anywhere.
 *
 * ⚠️ Targets the repo's NAMED `default` Firestore database (root gotcha); an
 * `onDocument*` that omits `database` binds to `(default)` and NEVER fires.
 * Mirrors apps/whatsapp's `sendOutbound` (the same inlined-at-build-time
 * `FIREBASE_DATABASE_ID` — see build.mjs).
 *
 * `retry: true` → Eventarc at-least-once, and it exists for TRANSIENT
 * pedido-read/enqueue failures. A redelivery replays the ORIGINAL CloudEvent —
 * the SAME stale before/after snapshots, not the current doc — so the decision
 * can re-enqueue a task that already resolved. That duplicate is harmless: the
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
    region: FUNCTIONS_REGION,
    retry: true,
  },
  async (event) => {
    // The middle `{pedidoId}` wildcard sits inside the meta-derived path prefix,
    // so its type isn't inferred into `event.params` (only the trailing
    // `{nfeId}` is) — both are present at runtime.
    const { pedidoId, nfeId } = event.params as { pedidoId: string; nfeId: string };
    const decision = decideNfeUploadDispatch(event.data?.before.data(), event.data?.after.data());
    logger.info('[mercado-livre] onNfeAprovada', { pedidoId, nfeId, decision });
    if (decision.action !== 'enqueue') return;

    // The ONE read of the flow's dispatch side: skip non-ML pedidos BEFORE any
    // task exists (no task, no write — a non-ML approval costs exactly this
    // read). A transient Firestore failure here throws and rides the Eventarc
    // retry.
    const check = await shouldUploadForPedido(getDb(), pedidoId);
    logger.info('[mercado-livre] onNfeAprovada pedido check', { pedidoId, nfeId, check });
    if (check.action !== 'enqueue') return;

    try {
      await createMlNfeUploadScheduler().enqueue({ pedidoId, nfeId });
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
