import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-optional-without-nullable.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// The rule self-scopes to packages/schemas/src — every in-scope case must carry
// a filename under it, as `context.filename` always is in a real run.
const IN = '/repo/packages/schemas/src/cliente.ts';

ruleTester.run('no-optional-without-nullable', rule, {
  valid: [
    {
      name: 'nullable() before optional() — server-stamped field',
      code: `const s = z.string().datetime().nullable().optional();`,
      filename: IN,
    },
    {
      name: 'optional() before nullable() — same thing, reverse order',
      code: `const s = z.number().nonnegative().optional().nullable();`,
      filename: IN,
    },
    {
      name: 'the normal optional-field shape has no optional() at all',
      code: `const s = z.string().nullable().default(null);`,
      filename: IN,
    },
    {
      name: 'nullable() far up the chain, past other modifiers',
      code: `const s = z.string().nullable().describe('X').optional();`,
      filename: IN,
    },
    {
      name: 'nullable() far down the chain, past other modifiers',
      code: `const s = z.string().optional().describe('X').nullable();`,
      filename: IN,
    },
    {
      name: 'required field',
      code: `const s = z.string().min(1);`,
      filename: IN,
    },
    {
      name: 'bracket notation still resolves nullable',
      code: `const s = z.string()['nullable']().optional();`,
      filename: IN,
    },
    // Out of scope: `.optional()` is an ordinary Zod modifier everywhere else.
    {
      name: 'app code is out of scope',
      code: `const s = z.string().optional();`,
      filename: '/repo/apps/web/lib/forms/filtro.ts',
    },
    {
      name: 'schemas tests are out of scope only if outside src/ — this one is inside, see invalid',
      code: `const s = z.string().optional();`,
      filename: '/repo/packages/integrations/nfe/src/wire.ts',
    },
    {
      name: 'a non-Zod .optional(arg) call is not the modifier',
      code: `const s = builder.optional('name');`,
      filename: IN,
    },
  ],

  invalid: [
    {
      name: 'bare optional() on a persisted field',
      code: `const s = z.string().optional();`,
      filename: IN,
      errors: [{ messageId: 'bare' }],
    },
    {
      name: 'bare optional() after other modifiers',
      code: `const s = z.string().min(1).max(255).describe('Nome').optional();`,
      filename: IN,
      errors: [{ messageId: 'bare' }],
    },
    {
      name: 'bare optional() inside an object literal',
      code: `const s = z.object({ nome: z.string().optional() });`,
      filename: IN,
      errors: [{ messageId: 'bare' }],
    },
    {
      name: 'bracket notation does not bypass the rule',
      code: `const s = z.string()['optional']();`,
      filename: IN,
      errors: [{ messageId: 'bare' }],
    },
    {
      name: 'nested schema file',
      code: `const s = z.number().optional();`,
      filename: '/repo/packages/schemas/src/produto/collection/estoque.ts',
      errors: [{ messageId: 'bare' }],
    },
  ],
});
