import { setGlobalOptions } from 'firebase-functions/v2';

// Inlined at build time by build.mjs (esbuild `define`), which REQUIRES it: no
// default, so a forgotten variable stops the build. It must be the LEGACY
// database's location (us-east1 at the time of writing) — Firestore triggers are
// created in the database's region.
const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs with ' +
      "FUNCTIONS_REGION set to the legacy database's location. There is no default.",
  );
}

export const FUNCTIONS_REGION = region;

// The cheapest shape that keeps up: a fractional CPU (`gcf_gen1` = sized to the
// memory, ~0.167 vCPU at 256 MiB) forces concurrency 1, and each event is two
// small reads and two small writes. At the legacy write rate this stays inside the
// Cloud Run functions free tier. `maxInstances` is a COST CAP, not a throughput
// target: a burst queues and retries instead of scaling out.
setGlobalOptions({
  region,
  memory: '256MiB',
  cpu: 'gcf_gen1',
  concurrency: 1,
  minInstances: 0,
  maxInstances: 20,
  timeoutSeconds: 60,
});
