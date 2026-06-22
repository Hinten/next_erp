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

setGlobalOptions({
  region,
  maxInstances: 10,
  // Cert config, bound from Secret Manager for EVERY function in this codebase
  // (both reconciliarNfe and nfeReconcileSweep resolve filial certs) — mounted as
  // process.env at runtime. `NFE_CERT_ENC_KEY` decrypts an uploaded filial A1 (the
  // prod path); the remaining three are the **env-fallback A1** path (a filial
  // with no stored cert signs with the env A1) — handy for testing, trim them for
  // a prod deploy that uses uploaded per-filial certs. `NFE_CERT_ENV_FALLBACK` is
  // a flag ('1'), routed through secrets only because there is no non-secret env
  // channel yet. Set each: `firebase functions:secrets:set <NAME>`.
  secrets: ['NFE_CERT_ENC_KEY', 'NFE_CERT_BASE64', 'NFE_CERT_PASSWORD', 'NFE_CERT_ENV_FALLBACK'],
});
