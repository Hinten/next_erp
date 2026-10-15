import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-focused-test.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-focused-test', rule, {
  valid: [
    { name: 'a plain test', code: `it('works', () => {});` },
    { name: 'a plain describe', code: `describe('group', () => {});` },
    {
      name: 'skip is never flagged — the 16 sites here are deliberate credential gating',
      code: `describe.skip('needs creds', () => {}); it.skip('later', () => {}); test.skip(!id, 'guard');`,
    },
    {
      name: 'the conditional-describe idiom this repo uses for credential gating',
      code: `const d = !hasFullCreds && !process.env.CI ? describe.skip : describe; d('suite', () => {});`,
    },
    {
      name: 'RuleTester.itOnly = it.only — a REFERENCE, which is the required ESLint wiring',
      code: `RuleTester.itOnly = it.only;`,
    },
    {
      name: 'an unrelated .only on a non-test callee',
      code: `db.only('x'); helpers.it.only('y');`,
    },
    { name: 'each without only', code: `test.each([1, 2])('n %i', (n) => {});` },
  ],
  invalid: [
    { name: 'it.only', code: `it.only('a', () => {});`, errors: [{ messageId: 'focused' }] },
    {
      name: 'describe.only',
      code: `describe.only('a', () => {});`,
      errors: [{ messageId: 'focused' }],
    },
    { name: 'test.only', code: `test.only('a', () => {});`, errors: [{ messageId: 'focused' }] },
    {
      name: 'modifier chain: it.concurrent.only',
      code: `it.concurrent.only('a', () => {});`,
      errors: [{ messageId: 'focused' }],
    },
    {
      name: 'modifier chain: describe.only.each',
      code: `describe.only.each([1])('a %i', () => {});`,
      errors: [{ messageId: 'focused' }],
    },
    {
      name: 'only AFTER a call: test.each([...]).only(...)',
      code: `test.each([1]).only('a %i', () => {});`,
      errors: [{ messageId: 'focused' }],
    },
    {
      name: 'a wrapped call of it.only still reports (prefer-schema-enum.test.js shape)',
      code: `RuleTester.itOnly = (name, fn) => it.only(name, fn, 1000);`,
      errors: [{ messageId: 'focused' }],
    },
  ],
});
