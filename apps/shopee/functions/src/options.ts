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

// Any enqueue from INSIDE a function (e.g. a future self-re-enqueue, or a sweep
// re-driving a push through the queue) targets the notification queue in THIS
// function's region — default the enqueuer's region to the inlined one so the
// region-qualified queue name resolves correctly.
//
// ⚠️ The `.trim() || undefined` is not decoration: `??` alone accepts a BLANK
// value, and a blank region produces the well-formed-but-wrong queue path
// `locations//functions/…`, which drops every task while the caller sees
// success (#887, #1108). Blank must count as unset.
process.env.SHOPEE_TASKS_REGION = (process.env.SHOPEE_TASKS_REGION?.trim() || undefined) ?? region;

setGlobalOptions({
  region,
  maxInstances: 10,
});
