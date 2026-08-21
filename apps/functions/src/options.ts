import { setGlobalOptions } from 'firebase-functions/v2';

// Region must match the Storage bucket's region: a mismatch silently breaks the
// gen2 (Eventarc) storage trigger, and gen2's own default is us-central1 (NOT
// the project/bucket location).
//
// FUNCTIONS_REGION is INLINED at build time by build.mjs (esbuild `define`),
// which REQUIRES it — there is no default, so a forgotten variable stops the
// build instead of inlining a region nobody chose. build.mjs never reads
// `.env.local`. (Firebase populates neither `process.env` nor params from `.env`
// during the codebase-analysis phase where `setGlobalOptions` runs, so the
// build-time literal is what makes the region available there; the throw below
// is the backstop for an unbundled run, e.g. tests without the env set.)
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs with ' +
      'FUNCTIONS_REGION set — there is no default, and it must equal the Storage ' +
      "bucket's region or the gen2 storage trigger silently never fires.",
  );
}

/**
 * The validated codebase region, re-exported so a per-function `region:` option
 * uses the value that already passed the check above instead of re-reading the
 * variable with a fallback of its own. A literal there would silently outvote
 * this check for that one function.
 */
export const FUNCTIONS_REGION = region;

setGlobalOptions({ region, maxInstances: 10 });
