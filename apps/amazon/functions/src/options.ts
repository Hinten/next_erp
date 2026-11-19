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

// Any enqueue from INSIDE a function (the step-4 backstop poll, through
// `src/agendador.ts`) targets the reads queue in THIS function's region —
// default the enqueuer's region to the inlined one so the region-qualified
// queue path resolves correctly.
//
// ⚠️ The `.trim() || undefined` is not decoration: `??` alone accepts a BLANK
// value, and a blank region produces the well-formed-but-wrong queue path
// `locations//functions/…`, which drops every task while the caller sees
// success (#887, #1108). Blank must count as unset. The parentheses are not
// decoration either: `||` and `??` cannot be mixed bare.
process.env.AMAZON_TASKS_REGION = (process.env.AMAZON_TASKS_REGION?.trim() || undefined) ?? region;

// ⚠️ `memory: '512MiB'` is a STOP-GAP (Lucas, 2026-11-19), set together with the
// Shopee codebase, whose one-bundle functions died at the 256-MiB default on
// staging. This codebase has the same one-bundle shape; #2194 measures both and
// brings the default back down. `processAmazonListingsJob` keeps its own `1GiB`
// (a per-function `memory` overrides this one).
setGlobalOptions({
  region,
  maxInstances: 10,
  memory: '512MiB',
});
