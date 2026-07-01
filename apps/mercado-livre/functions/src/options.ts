import { setGlobalOptions } from 'firebase-functions/v2';

// Region must be inlined at build time by build.mjs (esbuild `define`) — Firebase
// runs `setGlobalOptions` during codebase analysis BEFORE process.env/.env is
// available, so the build-time literal is what makes the region available there.
// Defaults to us-east1; override via FUNCTIONS_REGION for another environment.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs ' +
      '(defaults us-east1) or set FUNCTIONS_REGION.',
  );
}

setGlobalOptions({
  region,
  maxInstances: 10,
  // Phase 5: bind the Mercado Livre app secret from Secret Manager for the
  // functions that call the ML API (e.g. order import, notification processing):
  //   secrets: ['MERCADO_LIVRE_CLIENT_SECRET'],
  // Set it with `firebase functions:secrets:set MERCADO_LIVRE_CLIENT_SECRET`.
});
