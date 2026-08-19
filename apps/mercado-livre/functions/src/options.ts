import { setGlobalOptions } from 'firebase-functions/v2';

// Region must be inlined at build time by build.mjs (esbuild `define`) — Firebase
// runs `setGlobalOptions` during codebase analysis BEFORE process.env/.env is
// available, so the build-time literal is what makes the region available there.
// Defaults to us-east1 — the region this whole codebase deploys into, and NOT
// the ML backend's own region (us-east5). Override via FUNCTIONS_REGION.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs ' +
      '(defaults us-east1) or set FUNCTIONS_REGION.',
  );
}

/**
 * Region for every `onTaskDispatched` and `onSchedule` function in this codebase.
 *
 * Normally identical to `region` above. It stays a SEPARATE variable because it
 * is the one the App Hosting backend must be told as well: `mlTasksRegion.ts`
 * there builds the region-qualified queue name from `MERCADO_LIVRE_TASKS_REGION`,
 * and if the two disagree the Admin SDK resolves `us-central1` and the task is
 * SILENTLY DROPPED.
 *
 * ⚠️ **Cloud Tasks and Cloud Scheduler do not exist in `us-east5`.** Neither
 * service lists it (Cloud Tasks locations / Cloud Scheduler locations both stop
 * at `us-east4` in the eastern US), so this must never resolve there: it fails
 * all eleven queue/schedule functions at once while the four Firestore triggers
 * deploy cleanly — the asymmetric failure list that diagnosed the first ML
 * functions deploy. That constraint is what picked `us-east1` for the codebase.
 *
 * Inlined at build time by `build.mjs` for the same reason as `region` — the
 * `region:` option is read during codebase analysis, before any env exists.
 */
export const TASKS_SCHEDULER_REGION = process.env.MERCADO_LIVRE_TASKS_REGION?.trim() || 'us-east1';

// ⚠️ Do NOT assign back to `process.env.MERCADO_LIVRE_TASKS_REGION` here. The
// build `define`s that expression, so every read of it — including the one in
// the bundled `mlTasks.ts` enqueuer — is already the inlined literal, and the
// assignment esbuild sees is `"us-east1" = "us-east1"` (it warns, rightly).
// An enqueue from INSIDE a function therefore resolves the same region as the
// task functions themselves, which is exactly where the queues live.

setGlobalOptions({
  region,
  maxInstances: 10,
  // The Mercado Livre app secrets are bound PER-FUNCTION (not globally here) on
  // every function whose default deps refresh an ML access token — set with
  // `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID/_SECRET`:
  //   - `processMercadoLivreMassImport` (Step 8 / #621) — processMassImport.ts
  //   - `processMercadoLivreNotification` (Step 9 order import) — processNotification.ts
  //   - `importMercadoLivreOrders` (Step 9 PR 4 / #360) — index.ts
  //   - `sendMercadoLivreStock` + the two stock sweeps (Step 10) — sendStock.ts / sweepStock.ts
  //   - `processMercadoLivrePriceSync` (Step 11 PR-C) — processPriceSync.ts
  //   - `processMercadoLivreNfeUpload` (Step 12 / #739) — processNfeUpload.ts
  //   - `reprocessMercadoLivreNotifications` (the failures-store reprocess sweep) — index.ts (#778)
  //   - `sweepMercadoLivreMissedFeeds` (the missed_feeds backstop / #812) — index.ts.
  //     ⚠️ The ONLY function where CLIENT_ID is not just for the token refresh:
  //     it is also the `app_id` query param `GET /missed_feeds` requires, so
  //     unbinding it here leaves the backstop inert rather than merely slower.
  // Each declares `secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET']`
  // on its own options rather than here, so a function with no ML API call never
  // gets the secrets bound. The two Firestore triggers are exactly that case and
  // deliberately bind NONE:
  //   - `onNfeAprovada` (Step 12 / #739) — only decides + enqueues.
  //   - `onIntegracaoMercadoLivreChanged` (#782) — pure Firestore: mirrors the ML
  //     conta onto its Mercado Envios `int_frete` doc, never calls the ML API.
  // They are why this stays per-function despite the duplication: a codebase-wide
  // bind here would hand the ML app credentials to a function that must not carry
  // them.
});
