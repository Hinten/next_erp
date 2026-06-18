import { fileURLToPath } from 'node:url';
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

// Re-enqueues from INSIDE this function (runReconcile → scheduler) target the
// `reconciliarNfe` queue, which lives in THIS function's region. Default
// NFE_TASKS_REGION to the inlined region so a non-us-east1 deployment doesn't
// enqueue follow-up consults into the wrong region's queue (which would silently
// drop the reconcile loop). An explicit NFE_TASKS_REGION still overrides.
process.env.NFE_TASKS_REGION ??= region;

// Point the bundled @delfrance/integrations-nfe data-file readers at the copies
// shipped NEXT TO this bundle (prepare-deploy.mjs copies ca/ + schemas/ into the
// artifact). esbuild collapses the package's own dir layout, so runtime.ts's
// `require.resolve`/cwd strategies and xsd/index.ts's relative path no longer
// resolve — these absolute, bundle-relative paths do. Only set if unset, so a
// deploy env can still override. Imports below this run after it (side-effect
// module imported first in index.ts).
process.env.NFE_CA_DIR ??= fileURLToPath(new URL('./ca', import.meta.url));
process.env.NFE_SCHEMA_DIR ??= fileURLToPath(new URL('./schemas', import.meta.url));

setGlobalOptions({ region, maxInstances: 10 });
