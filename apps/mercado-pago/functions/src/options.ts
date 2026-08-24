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

// Any enqueue from INSIDE a function (e.g. a future self-re-enqueue) targets the
// notification queue in THIS function's region — default the enqueuer's region
// to the inlined one so the region-qualified queue name resolves correctly.
process.env.MERCADO_PAGO_TASKS_REGION =
  (process.env.MERCADO_PAGO_TASKS_REGION?.trim() || undefined) ?? region;

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
});
