import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-lossy-date-parse.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

// A non-allow-listed, non-test path so the rule is active by default.
const SRC = '/repo/apps/mercado-livre/lib/marketplace/orderImport.ts';

ruleTester.run('no-lossy-date-parse', rule, {
  valid: [
    {
      name: 'new Date() with no argument is a clock read, not a parse',
      code: 'const d = new Date();',
      filename: SRC,
    },
    {
      name: 'a numeric epoch literal is a lossless conversion',
      code: 'const d = new Date(1700000000000);',
      filename: SRC,
    },
    {
      name: 'arithmetic is provably numeric',
      code: 'const d = new Date(us / 1000);',
      filename: SRC,
    },
    {
      name: 'a numeric-returning helper call is provably numeric',
      code: 'const d = new Date(microsToMillis(us));',
      filename: SRC,
    },
    {
      name: 'Date.now() is provably numeric',
      code: 'const d = new Date(Date.now());',
      filename: SRC,
    },
    {
      name: 'Number(x) makes the numeric intent explicit',
      code: 'const d = new Date(Number(raw));',
      filename: SRC,
    },
    {
      name: 'component construction is not string parsing',
      code: 'const d = new Date(2026, 5, 16);',
      filename: SRC,
    },
    {
      name: 'a ternary of two numerics is numeric',
      code: 'const d = new Date(flag ? a * 1000 : Date.now());',
      filename: SRC,
    },
    {
      name: 'a mixed ternary is NOT provably a string (only one branch is)',
      code: "const d = new Date(flag ? 1700000000000 : '2026-01-01');",
      filename: SRC,
    },
    // Regression cases: both of these were flagged by the rule's FIRST draft,
    // which reported anything not provably numeric. They are lossless epoch→Date
    // conversions, and there are ~146 like them in the repo — the noise is why
    // the rule now reports only a provable string.
    {
      name: 'real site: new Date(ms) with a typed numeric parameter (schemas/integracao.ts)',
      code: 'export function decodeHorarioMs(ms) { const d = new Date(ms); return d.getHours(); }',
      filename: SRC,
    },
    {
      name: 'real site: new Date(Math.floor(us / 1000)) (data/pedido/devolucao.ts)',
      code: 'const d = new Date(Math.floor(nowMicros / 1000));',
      filename: SRC,
    },
    {
      name: 'a bare identifier is unproven, and unproven is not reported',
      code: 'const d = new Date(raw);',
      filename: SRC,
    },
    {
      name: 'a member access is unproven',
      code: 'const d = new Date(order.last_updated);',
      filename: SRC,
    },
    {
      name: 'the canonical datetime layer is allow-listed',
      code: "const ms = Date.parse(value); const d = new Date('2026-01-01');",
      filename: '/repo/packages/core/src/datetime/index.ts',
    },
    {
      name: 'the legacy-shape audit tool is allow-listed',
      code: "const d = new Date('2026-01-01T00:00:00Z');",
      filename: '/repo/tools/test-fixtures/src/datetime-shapes.ts',
    },
    {
      name: 'the migration shape report is allow-listed',
      code: 'const ms = Date.parse(value);',
      filename: '/repo/tools/migrations/src/2026-06-pedido-pagamento-micros/shapeReport.ts',
    },
    {
      name: 'unit tests may author ISO literals',
      code: "const US = Date.parse('2026-01-01T00:00:00Z') * 1000;",
      filename: '/repo/apps/mercado-livre/lib/marketplace/orderImport.test.ts',
    },
    {
      name: 'e2e helpers may author ISO literals',
      code: "const d = new Date('2026-01-01T00:00:00Z');",
      filename: '/repo/apps/web/e2e/_helpers/seed-data.ts',
    },
    {
      name: 'windows-style paths are normalized before allow-list matching',
      code: 'const ms = Date.parse(value);',
      filename: 'C:\\repo\\packages\\core\\src\\datetime\\index.ts',
    },
  ],

  invalid: [
    {
      name: 'Date.parse on a provider payload — the Loja Integrada defect',
      code: 'const us = Date.parse(order.last_updated) * 1000;',
      filename: SRC,
      errors: [{ messageId: 'dateParse' }],
    },
    {
      name: 'bracket access cannot bypass the rule',
      code: "const ms = Date['parse'](raw);",
      filename: SRC,
      errors: [{ messageId: 'dateParse' }],
    },
    {
      name: 'new Date(<string literal>) truncates and is TZ-sensitive',
      code: "const d = new Date('2026-06-16T12:00:00.123456Z');",
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'a template literal is provably a string',
      code: 'const d = new Date(`${y}-01-01T00:00:00Z`);',
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'concatenation with a string literal is provably a string',
      code: "const d = new Date(base + 'Z');",
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'a .toISOString() round-trip is provably a string',
      code: 'const d = new Date(other.toISOString());',
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'String(x) is provably a string',
      code: 'const d = new Date(String(raw));',
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'Date(<string>) without new still parses a string',
      code: "const s = Date('2026-06-16T12:00:00Z');",
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'a ternary of two strings IS provably a string',
      code: "const d = new Date(flag ? '2026-01-01' : '2026-02-01');",
      filename: SRC,
      errors: [{ messageId: 'newDateString' }],
    },
    {
      name: 'a file under a non-allow-listed tools path is still checked',
      code: 'const ms = Date.parse(value);',
      filename: '/repo/tools/migrations/src/2026-08-other/migrate.ts',
      errors: [{ messageId: 'dateParse' }],
    },
  ],
});
