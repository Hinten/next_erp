import { setGlobalOptions } from 'firebase-functions/v2';

// Region must match the Storage bucket's region: a mismatch silently breaks the
// gen2 (Eventarc) storage trigger, and gen2's own default is us-central1 (NOT
// the project/bucket location). The repo standardises every Functions codebase
// on us-east5, so the bucket has to be created there — see ADR 0013.
//
// FUNCTIONS_REGION is INLINED at build time by build.mjs (esbuild `define`),
// which defaults it to us-east5 (the required Storage bucket region) and never reads
// `.env.local`; override via the FUNCTIONS_REGION env var for another
// environment. (Firebase populates neither `process.env` nor params from `.env`
// during the codebase-analysis phase where `setGlobalOptions` runs, so the
// build-time literal is what makes the region available there; the throw below
// is the backstop for an unbundled run, e.g. tests without the env set.)
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via the dotenv ' +
      'loader (dev: `dotenv -e ../../.env.local -- pnpm --filter ' +
      '@delfrance/functions build`) or with FUNCTIONS_REGION set (CI).',
  );
}

setGlobalOptions({ region, maxInstances: 10 });
