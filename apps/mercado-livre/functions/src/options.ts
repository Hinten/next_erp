import { setGlobalOptions } from 'firebase-functions/v2';

// Region must be inlined at build time by build.mjs (esbuild `define`) — Firebase
// runs `setGlobalOptions` during codebase analysis BEFORE process.env/.env is
// available, so the build-time literal is what makes the region available there.
// REQUIRED — build.mjs has no default, so an unset value stops the build
// rather than inlining a region nobody chose.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs ' +
      'with FUNCTIONS_REGION set. There is no default.',
  );
}

/**
 * Region for every `onTaskDispatched` and `onSchedule` function in this codebase.
 *
 * ⚠️ **Cloud Tasks and Cloud Scheduler do not exist in `us-east5`.** Neither
 * service lists it (Cloud Tasks locations / Cloud Scheduler locations both stop
 * at `us-east4` in the eastern US), so deploying the codebase wholesale into the
 * ML backend's region fails all thirteen queue/schedule functions at once while
 * the six Firestore triggers deploy cleanly — the exact signature seen on the
 * first ML functions deploy. They are pinned to `us-east1`, which offers both.
 * (Thirteen = five `onTaskDispatched` queues + eight `onSchedule`s, counted from
 * `index.ts`'s exports — re-derive it there rather than incrementing this; the
 * figure had already drifted to "eleven" while the codebase held twelve.)
 *
 * ⚠️ This is also what the ENQUEUER must target. `mlTasks.ts` on the App Hosting
 * backend builds a region-qualified queue name from `MERCADO_LIVRE_TASKS_REGION`;
 * point it anywhere else and the Admin SDK resolves `us-central1` and the task is
 * SILENTLY DROPPED. Set the same value on the backend env.
 *
 * Inlined at build time by `build.mjs` for the same reason as `region` — the
 * `region:` option is read during codebase analysis, before any env exists.
 */
const tasksSchedulerRegion = process.env.MERCADO_LIVRE_TASKS_REGION?.trim();
if (!tasksSchedulerRegion) {
  throw new Error(
    'MERCADO_LIVRE_TASKS_REGION was not inlined at build time. Build via build.mjs ' +
      'with it set, or set MERCADO_LIVRE_TASKS_REGION. There is no default: a wrong ' +
      'queue region is dropped silently, so this must fail instead of guessing.',
  );
}
export const TASKS_SCHEDULER_REGION = tasksSchedulerRegion;

// ⚠️ Do NOT assign back to `process.env.MERCADO_LIVRE_TASKS_REGION` here. The
// build `define`s that expression, so every read of it — including the one in
// the bundled `mlTasks.ts` enqueuer — is already the inlined literal, and the
// assignment esbuild sees is `"us-east1" = "us-east1"` (it warns, rightly).
// An enqueue from INSIDE a function therefore resolves the same region as the
// task functions themselves, which is exactly where the queues live.

/**
 * The validated codebase region, re-exported so a per-function `region:` option
 * uses the value that already passed the check above instead of re-reading the
 * variable with a fallback of its own. A literal there would silently outvote
 * this check for that one function.
 */
export const FUNCTIONS_REGION = region;

setGlobalOptions({
  region,
  maxInstances: 10,
  // The Mercado Livre app secrets are bound PER-FUNCTION (not globally here) on
  // every function whose default deps refresh an ML access token — set with
  // `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID/_SECRET`:
  //   - `processMercadoLivreMassImport` (Step 8 / #621) — processMassImport.ts
  //   - `processMercadoLivreNotification` (Step 9 order import) — processNotification.ts
  //   - `importMercadoLivreOrders` (Step 9 PR 4 / #360) — index.ts
  //   - `sendMercadoLivreStock` + the three stock sweep tiers (Step 10 + the monthly
  //     reconciliation) — sendStock.ts / sweepStock.ts (`sweepScheduleOptions`)
  //   - `processMercadoLivrePriceSync` (Step 11 PR-C) — processPriceSync.ts
  //   - `processMercadoLivreNfeUpload` (Step 12 / #739) — processNfeUpload.ts
  //   - `reprocessMercadoLivreNotifications` (the failures-store reprocess sweep) — index.ts (#778)
  //   - `sweepMercadoLivreMissedFeeds` (the missed_feeds backstop / #812) — index.ts.
  //     ⚠️ The ONLY function where CLIENT_ID is not just for the token refresh:
  //     it is also the `app_id` query param `GET /missed_feeds` requires, so
  //     unbinding it here leaves the backstop inert rather than merely slower.
  //   - `sweepMercadoLivrePedidosTravados` (the weekly stuck-pedido release) — index.ts
  //   - `onAnuncioCategoriaAlterada` (#847) — the ONE Firestore trigger that binds
  //     them: its aviso raise reads the new ML category and ML's fee preview with
  //     the conta's token. Its sibling `onProdutoCategoriaAlterada` binds none.
  // Each declares `secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET']`
  // on its own options rather than here, so a function with no ML API call never
  // gets the secrets bound. These are exactly that case and deliberately bind NONE
  // (five Firestore triggers and one schedule):
  //   - `onNfeAprovada` (Step 12 / #739) — only decides + enqueues.
  //   - `onIntegracaoMercadoLivreChanged` (#782) — pure Firestore: mirrors the ML
  //     conta onto its Mercado Envios `int_frete` doc, never calls the ML API.
  //   - `onProdutoMercadoLivreLinkChanged` / `onVariacaoMercadoLivreLinkChanged`
  //     (#920) — pure Firestore: derive `integracoesComProduto` from the links.
  //   - `onProdutoCategoriaAlterada` (#847) — pure Firestore.
  //   - `sweepMercadoLivreAnunciosNaoEnumerados` (#1200) — the monthly link audit,
  //     sweepStock.ts. ⚠️ The one SCHEDULE here, and the one that sits beside
  //     three sweeps that DO bind the secrets through `sweepScheduleOptions`: it
  //     declares its own options literal precisely so it cannot inherit them.
  //     Pure Firestore — it heals the array and writes avisos, and a healed
  //     family reaches ML through the 03:00 force-all, never through this
  //     function. `index.test.ts` asserts its endpoint names no ML secret.
  // They are why this stays per-function despite the duplication: a codebase-wide
  // bind here would hand the ML app credentials to a function that must not carry
  // them.
});
