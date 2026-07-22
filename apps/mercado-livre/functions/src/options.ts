import { setGlobalOptions } from 'firebase-functions/v2';

// Region must be inlined at build time by build.mjs (esbuild `define`) — Firebase
// runs `setGlobalOptions` during codebase analysis BEFORE process.env/.env is
// available, so the build-time literal is what makes the region available there.
// Defaults to us-east5 (the ML backend's region); override via FUNCTIONS_REGION.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs ' +
      '(defaults us-east5) or set FUNCTIONS_REGION.',
  );
}

// Any enqueue from INSIDE a function (e.g. a future self-re-enqueue) targets the
// notification queue in THIS function's region — default the enqueuer's region
// to the inlined one so the region-qualified queue name resolves correctly.
process.env.MERCADO_LIVRE_TASKS_REGION ??= region;

setGlobalOptions({
  region,
  maxInstances: 10,
  // The Mercado Livre app secret is bound PER-FUNCTION (not globally here) on
  // every function whose default deps refresh an ML access token — set with
  // `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_ID/_SECRET`:
  //   - `processMercadoLivreMassImport` (Step 8 / #621) — processMassImport.ts
  //   - `processMercadoLivreNotification` (Step 9 order import) — processNotification.ts
  // Both declare `secrets: ['MERCADO_LIVRE_CLIENT_ID', 'MERCADO_LIVRE_CLIENT_SECRET']`
  // on their own `onTaskDispatched(...)` options rather than here, so a function
  // with no ML API call (e.g. a future pure-Firestore trigger) never gets the
  // secret bound to it. Promote to a codebase-wide bind here only if that
  // per-function duplication becomes unwieldy (a THIRD+ consumer).
});
