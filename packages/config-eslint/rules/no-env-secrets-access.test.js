import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import rule from './no-env-secrets-access.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

const tsParser = tseslint.parser;

// A deploy script — the file class this rule exists to protect, and the one the old
// denylist actually lived in.
const DEPLOY_SCRIPT = '/repo/apps/nfe/functions/scripts/prepare-deploy.mjs';

ruleTester.run('no-env-secrets-access', rule, {
  valid: [
    {
      name: 'the allowlisted classifier may name the pattern — rejecting it is its job',
      filename: '/repo/tools/deploy-env/env-files.mjs',
      code: `const SECRETS_PREFIX = '.env.secrets';`,
    },
    {
      name: 'the rules directory may name the pattern (this rule and its backstop live there)',
      filename: '/repo/packages/config-eslint/rules/no-env-secrets-access.js',
      code: `const NEEDLE = '.env.secrets';`,
    },
    {
      name: 'the allowed deploy source name is untouched',
      filename: DEPLOY_SCRIPT,
      code: `const src = '.env.deploy';`,
    },
    {
      name: 'the ordinary env names are untouched',
      filename: DEPLOY_SCRIPT,
      code: `const names = ['.env', '.env.local', '.env.example'];`,
    },
    {
      name: 'a similarly-spelled but distinct name is not flagged',
      filename: DEPLOY_SCRIPT,
      code: `const p = '.envsecrets';`,
    },
    {
      name: 'a template literal with no secrets quasi is untouched',
      filename: DEPLOY_SCRIPT,
      code: 'const p = `${dir}/.env.deploy`;',
    },
  ],

  invalid: [
    {
      name: 'a bare string literal in a deploy script',
      filename: DEPLOY_SCRIPT,
      code: `copyFileSync(join(pkgDir, '.env.secrets'), dest);`,
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'the committed template is equally forbidden — it is still a secrets file name',
      filename: DEPLOY_SCRIPT,
      code: `const tpl = '.env.secrets.example';`,
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'an interpolated template literal',
      filename: DEPLOY_SCRIPT,
      code: 'const p = `${repoRoot}/.env.secrets`;',
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'a path embedded mid-string',
      filename: DEPLOY_SCRIPT,
      code: `const p = 'apps/nfe/functions/.env.secrets';`,
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'reported once, not twice, when the name is an interpolated literal',
      filename: DEPLOY_SCRIPT,
      // The Literal visitor reports; the TemplateLiteral visitor deliberately reads
      // only the static quasis, so this does not double-report.
      code: "const p = `${'.env.secrets'}`;",
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'applies to TypeScript too, not just the .mjs scripts',
      filename: '/repo/apps/web/lib/env.ts',
      code: `const p: string = '.env.secrets';`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: 'neverTouch' }],
    },
    {
      name: 'a read is as forbidden as a copy',
      filename: '/repo/tools/test-fixtures/src/seed.ts',
      code: `const raw = readFileSync('.env.secrets', 'utf8');`,
      languageOptions: { parser: tsParser },
      errors: [{ messageId: 'neverTouch' }],
    },
  ],
});
