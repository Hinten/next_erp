import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-hardcoded-gcp-region.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/** An ordinary source file — in scope, as every non-test file is. */
const IN = '/repo/apps/mercado-livre/lib/marketplace/mlTasks.ts';

ruleTester.run('no-hardcoded-gcp-region', rule, {
  valid: [
    {
      name: 'the replacement: read it from the environment',
      code: `const region = requireRegion(['MERCADO_LIVRE_TASKS_REGION'], process.env);`,
      filename: IN,
    },
    {
      name: 'the build-time replacement',
      code: `const region = requireBuildRegion('FUNCTIONS_REGION');`,
      filename: '/repo/apps/functions/build.mjs',
    },
    {
      name: 'a queue path built from a variable',
      code: 'const q = `locations/${region}/functions/${name}`;',
      filename: IN,
    },
    {
      name: 'a region embedded in a longer string is not the bare id',
      // The value that decides behaviour is the bare id. A URL is a different
      // kind of constant, and matching inside one would flag doc strings.
      code: `const url = 'https://us-central1-veste.cloudfunctions.net/x';`,
      filename: IN,
    },
    {
      name: 'a full queue path literal is not a bare region id either',
      code: `const q = 'locations/us-east1/functions/processMercadoLivreNotification';`,
      filename: IN,
    },
    {
      name: 'an interpolated template is being assembled, not hardcoded',
      code: 'const r = `${geo}-east1`;',
      filename: IN,
    },
    {
      name: 'a similar-looking string that is not a region',
      code: `const s = 'us-east';`,
      filename: IN,
    },
    {
      name: 'not a region: no trailing digit',
      code: `const s = 'europe-west';`,
      filename: IN,
    },
    {
      name: 'not a region: unknown geography prefix',
      code: `const s = 'mars-central1';`,
      filename: IN,
    },
    {
      name: 'a non-string literal',
      code: `const n = 1;`,
      filename: IN,
    },
    // Tests pin regions deliberately — a queue-path assertion has to write one,
    // and stubbing one is how the resolvers get covered at all.
    {
      name: 'test files are out of scope',
      code: `expect(q).toBe('locations/us-central1/functions/x'); const r = 'us-central1';`,
      filename: '/repo/apps/mercado-livre/lib/marketplace/mlTasks.test.ts',
    },
    {
      name: 'e2e helpers are out of scope',
      code: `const r = 'us-central1';`,
      filename: '/repo/apps/web/e2e/helpers/functions.ts',
    },
    {
      name: 'a spec file is out of scope',
      code: `const r = 'us-central1';`,
      filename: '/repo/apps/web/e2e/estoque.vendas.e2e.spec.ts',
    },
    {
      // It is a measured list of regions LACKING Cloud Tasks (#1108), so it has
      // to name one to mean anything.
      name: 'the preflight guard that must name a region',
      code: `const REGIONS_WITHOUT_TASKS = new Set(['us-east5']);`,
      filename: '/repo/tools/deploy-env/preflight.mjs',
    },
    {
      name: 'this rule and its own test may name regions',
      code: `const MULTI_REGION = new Set(['nam5']);`,
      filename: '/repo/packages/config-eslint/rules/no-hardcoded-gcp-region.js',
    },
  ],

  invalid: [
    {
      name: 'the exact shape this rule exists for — a fallback default',
      code: `const region = process.env.FUNCTIONS_REGION ?? 'us-east1';`,
      filename: IN,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'the `||` variant',
      code: `const region = process.env.FUNCTIONS_REGION || 'us-east5';`,
      filename: '/repo/apps/functions/build.mjs',
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'a per-function region option',
      code: `export const f = onDocumentWritten({ region: 'us-east5' }, handler);`,
      filename: '/repo/apps/whatsapp/functions/src/sendOutbound.ts',
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'a template literal with no interpolation is the same constant',
      code: 'const r = `us-central1`;',
      filename: IN,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'South America too — it is about hardcoding, not about which region',
      code: `const r = 'southamerica-east1';`,
      filename: IN,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'a Firestore multi-region id',
      code: `const loc = 'nam5';`,
      filename: IN,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'a region Google added after this rule was written',
      // The pattern is structural rather than an allow-list precisely so a new
      // region cannot slip past — those are the ones most likely to be pasted
      // straight out of a console.
      code: `const r = 'northamerica-northeast2';`,
      filename: IN,
      errors: [{ messageId: 'hardcoded' }],
    },
    {
      name: 'every occurrence is reported, not just the first',
      code: `const a = 'us-east1'; const b = 'us-east5';`,
      filename: IN,
      errors: [{ messageId: 'hardcoded' }, { messageId: 'hardcoded' }],
    },
    {
      name: 'a config file is still source — it is not a workflow',
      code: `export default { region: 'europe-west4' };`,
      filename: '/repo/apps/nfe/lib/nfe/config.ts',
      errors: [{ messageId: 'hardcoded' }],
    },
  ],
});
