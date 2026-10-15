import { setGlobalOptions } from 'firebase-functions/v2';

const region = process.env.FUNCTIONS_REGION;
if (!region) {
  throw new Error(
    'FUNCTIONS_REGION was not inlined at build time. Build via build.mjs ' +
      'with FUNCTIONS_REGION set. There is no default.',
  );
}

process.env.MELHOR_ENVIO_TASKS_REGION =
  (process.env.MELHOR_ENVIO_TASKS_REGION?.trim() || undefined) ?? region;

export const FUNCTIONS_REGION = region;

setGlobalOptions({
  region,
  maxInstances: 10,
});
