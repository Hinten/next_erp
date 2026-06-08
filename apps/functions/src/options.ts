import { setGlobalOptions } from 'firebase-functions/v2';

// Region must match the Storage bucket's region: a mismatch silently breaks the
// gen2 (Eventarc) storage trigger, and gen2's own default is us-central1 (NOT
// the project/bucket location).
//
// FUNCTIONS_REGION is INLINED at build time by build.mjs (esbuild `define`),
// sourced from the env — dev: the root `.env.local` via the `dotenv -e
// ../../.env.local --` loader; CI: the job env. build.mjs FAILS the build if
// it's unset, so an unconfigured region can never ship. (Firebase populates
// neither `process.env` nor params from `.env` during the codebase-analysis
// phase where `setGlobalOptions` runs, so the build-time literal is what makes
// the region available there; the throw below is the backstop.)
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via the dotenv ' +
      'loader (dev: `dotenv -e ../../.env.local -- pnpm --filter ' +
      '@delfrance/functions build`) or with FUNCTIONS_REGION set (CI).',
  );
}

setGlobalOptions({ region, maxInstances: 10 });
