import { setGlobalOptions } from 'firebase-functions/v2';

// Region must be inlined at build time by build.mjs (esbuild `define`) — Firebase
// runs `setGlobalOptions` during codebase analysis BEFORE process.env/.env is
// available, so the build-time literal is what makes the region available there.
// Defaults to us-east5 (the MP backend's region); override via FUNCTIONS_REGION.
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
process.env.MERCADO_PAGO_TASKS_REGION =
  (process.env.MERCADO_PAGO_TASKS_REGION?.trim() || undefined) ?? region;

setGlobalOptions({
  region,
  maxInstances: 10,
});
