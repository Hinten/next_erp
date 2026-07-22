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
  // Phase 5: bind the Mercado Livre app secret from Secret Manager for the
  // functions that call the ML API (e.g. order import, notification processing):
  //   secrets: ['MERCADO_LIVRE_CLIENT_SECRET'],
  // Set it with `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET`.
  // (Step 8 / #621 bound `MERCADO_LIVRE_CLIENT_ID` + `MERCADO_LIVRE_CLIENT_SECRET`
  // PER-FUNCTION on `processMercadoLivreMassImport` — see processMassImport.ts —
  // rather than here, since it's the only function so far whose default deps
  // refresh an ML access token. If a second function needs them, promote to a
  // codebase-wide bind here instead of duplicating the `secrets` array.)
});
