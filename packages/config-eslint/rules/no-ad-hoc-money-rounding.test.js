import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-ad-hoc-money-rounding.js';

// Wire RuleTester to vitest's runner (it calls describe/it at module load).
RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

ruleTester.run('no-ad-hoc-money-rounding', rule, {
  valid: [
    // Allowed precisions / multipliers — NOT money 2dp rounding.
    { name: 'toFixed(4) is XSD precision', code: `const s = (1.2345).toFixed(4);` },
    { name: 'toFixed(10) is XSD precision', code: `const s = (1.2345).toFixed(10);` },
    { name: 'toFixed() with no arg', code: `const s = (1.2345).toFixed();` },
    { name: 'Math.round(x * 1000) is ms, not cents', code: `const ms = Math.round(t * 1000);` },
    { name: 'Math.ceil(x * 100) is weight banding', code: `const w = Math.ceil(p * 100) / 100;` },
    { name: 'Math.round without a *100 arg', code: `const n = Math.round(x);` },
    {
      name: 'the canonical helpers themselves',
      code: `const v = roundReais(x); const t = formatReais(y);`,
    },

    // Allow-listed files may use the raw patterns (canonical impl + wire serializers).
    // Absolute paths, as `context.filename` always is in a real run — the
    // allow-list matches the `/packages/...` / `/apps/...` segment.
    {
      name: 'core/money is the canonical home',
      code: `export const f = (n) => Math.round(n * 100);`,
      filename: '/repo/packages/core/src/money/index.ts',
    },
    {
      name: 'tribute/format.ts is an XSD string serializer',
      code: `export const f = (n) => n.toFixed(2);`,
      filename: '/repo/packages/integrations/nfe/src/tribute/format.ts',
    },
    {
      name: 'generator-input.ts is an XSD string serializer',
      code: `export const f = (n) => n.toFixed(2);`,
      filename: '/repo/apps/nfe/lib/nfe/orchestrator/generator-input.ts',
    },
    {
      name: 'nfe export csv.ts parses XML money strings to cents',
      code: `export const toCents = (n) => Math.round(n * 100);`,
      filename: '/repo/apps/web/lib/nfe/export/csv.ts',
    },
  ],
  invalid: [
    {
      name: 'dot toFixed(2)',
      code: `const s = (1.2345).toFixed(2);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: 'bracket toFixed(2) — cannot be bypassed',
      code: `const s = (1.2345)['toFixed'](2);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: 'Math.round(x * 100)',
      code: `const c = Math.round(x * 100);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: 'Math.round(100 * x) — reversed operand',
      code: `const c = Math.round(100 * x);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: 'Math.round(x * 100) / 100 — the inner round fires',
      code: `const r = Math.round(x * 100) / 100;`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: "bracket Math['round'](x * 100) — cannot be bypassed",
      code: `const c = Math['round'](x * 100);`,
      errors: [{ messageId: 'banned' }],
    },
    {
      name: 'the legacy display pattern money(Math.round(v * 100))',
      code: `const s = format(money(Math.round(v * 100)));`,
      errors: [{ messageId: 'banned' }],
    },
  ],
});
