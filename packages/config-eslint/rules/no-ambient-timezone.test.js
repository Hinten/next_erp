import { afterAll, describe, it } from 'vitest';
import { RuleTester } from 'eslint';
import rule from './no-ambient-timezone.js';

RuleTester.afterAll = afterAll;
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
});

/** A server surface — the rule is active here. */
const SERVER = '/repo/apps/mercado-livre/lib/marketplace/estoque/estoqueSweep.ts';
/** A client surface — local time is CORRECT here, so the rule is inactive. */
const CLIENT = '/repo/apps/web/app/(app)/pedidos/_components/PedidoCells.tsx';

ruleTester.run('no-ambient-timezone', rule, {
  valid: [
    {
      name: 'real site: estoqueSweep passes an explicit timeZone to Intl',
      code: "const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit' }).formatToParts(d);",
      filename: SERVER,
    },
    {
      name: 'toLocaleString with an explicit timeZone',
      code: "const s = d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });",
      filename: SERVER,
    },
    {
      name: "a quoted 'timeZone' key counts too",
      code: "const s = d.toLocaleDateString('pt-BR', { 'timeZone': 'UTC' });",
      filename: SERVER,
    },
    {
      name: 'an options object passed by reference is assumed considered',
      code: "const s = d.toLocaleString('pt-BR', opts);",
      filename: SERVER,
    },
    {
      name: 'a spread is assumed to carry the zone',
      code: "const s = d.toLocaleString('pt-BR', { ...base });",
      filename: SERVER,
    },
    {
      name: 'getUTC* accessors are zone-free',
      code: 'const h = d.getUTCHours(); const m = d.getUTCMonth(); const y = d.getUTCFullYear();',
      filename: SERVER,
    },
    {
      name: 'Date.UTC is explicit',
      code: 'const ms = Date.UTC(2026, 5, 16);',
      filename: SERVER,
    },
    {
      name: 'getTime is an epoch read, not a wall-clock read',
      code: 'const ms = d.getTime();',
      filename: SERVER,
    },
    // The include-list inversion: ambient IS correct on the client, because there
    // "ambient" means the operator's own wall clock, not a random container's.
    {
      name: 'apps/web may read local time — that is the operator wall clock',
      code: "const s = new Date(ms).toLocaleString('pt-BR'); const h = d.getHours();",
      filename: CLIENT,
    },
    {
      name: 'packages/ui may read local time',
      code: 'const h = d.getHours();',
      filename: '/repo/packages/ui/src/object/datetimeField.ts',
    },
    {
      name: 'server tests are exempt',
      code: 'const h = d.getHours();',
      filename: '/repo/apps/mercado-livre/lib/marketplace/estoque/estoqueSweep.test.ts',
    },
    {
      name: 'a scheduled function timeZone option is the CRON zone, not a format call',
      code: "export const sweep = onSchedule({ schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' }, handler);",
      filename: '/repo/apps/whatsapp/functions/src/index.ts',
    },
    // Review finding: `toLocaleString` is also a Number/BigInt/Array method, and
    // money is this repo's dominant use of it. A currency format is not a
    // timezone bug, and under `--max-warnings 0` the warning would be a hard stop
    // on nonsense advice.
    {
      name: 'a currency format on a Number is not a timezone bug',
      code: "const s = valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });",
      filename: SERVER,
    },
    {
      name: 'fraction-digit options also mark it a number format',
      code: "const s = qtd.toLocaleString('pt-BR', { minimumFractionDigits: 2 });",
      filename: SERVER,
    },
    // Review finding: @delfrance/data is a MIXED package — ./hooks ships
    // 'use client' and ./pedido is consumed from apps/web, so only ./admin and
    // ./server are genuinely server-only.
    {
      name: 'packages/data/src/pedido runs in the browser — exempt',
      code: 'const data = `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}`;',
      filename: '/repo/packages/data/src/pedido/devolucao.ts',
    },
    {
      name: 'packages/data/src/hooks ships use client — exempt',
      code: 'const h = d.getHours();',
      filename: '/repo/packages/data/src/hooks/useSnapshot.ts',
    },
    {
      name: 'setUTC* twins are zone-free',
      code: 'd.setUTCHours(0, 0, 0, 0);',
      filename: SERVER,
    },
    {
      name: 'new Date() and new Date(ms) are not component construction',
      code: 'const a = new Date(); const b = new Date(1781611200000);',
      filename: SERVER,
    },
  ],

  invalid: [
    {
      name: 'real site: apps/nfe formats a cert expiry with no timeZone',
      code: "const msg = `Certificado expirado em ${cert.notAfter.toLocaleDateString('pt-BR')}.`;",
      filename: '/repo/apps/nfe/app/api/nfe/certificado/route.ts',
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'the genuinely server-only data subpaths are still covered',
      code: 'const h = d.getHours();',
      filename: '/repo/packages/data/src/admin/notifications/store.ts',
      errors: [{ messageId: 'localGetter' }],
    },
    // Review finding: the local SETTERS are ambient in exactly the same way, and
    // `setHours(0,0,0,0)` is the canonical "start of day" idiom — the single most
    // likely way this bug gets reintroduced.
    {
      name: 'setHours is the start-of-day idiom and is ambient',
      code: 'd.setHours(0, 0, 0, 0);',
      filename: SERVER,
      errors: [{ messageId: 'localGetter' }],
    },
    {
      name: 'setMonth is ambient too',
      code: 'd.setMonth(0);',
      filename: SERVER,
      errors: [{ messageId: 'localGetter' }],
    },
    {
      name: 'the multi-argument Date constructor reads ambient components',
      code: 'const d = new Date(2026, 5, 16);',
      filename: SERVER,
      errors: [{ messageId: 'localDateParts' }],
    },
    // Review finding: scanning EVERY argument let a non-literal locale in
    // position 0 hit the by-reference escape hatch and switch the rule off, with
    // no options object present at all.
    {
      name: 'a non-literal locale must not disable the rule (toLocaleString)',
      code: 'const s = d.toLocaleString(locale);',
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'a non-literal locale must not disable the rule (Intl, identifier)',
      code: 'const f = new Intl.DateTimeFormat(locales);',
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'a non-literal locale must not disable the rule (Intl, member access)',
      code: 'const f = new Intl.DateTimeFormat(cfg.locale);',
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'Intl.DateTimeFormat without a timeZone (construct form)',
      code: "const f = new Intl.DateTimeFormat('en-US', { hour: '2-digit' });",
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'Intl.DateTimeFormat without a timeZone (call form)',
      code: "const f = Intl.DateTimeFormat('en-US');",
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'toLocaleString with a locale but no options at all',
      code: "const s = d.toLocaleString('pt-BR');",
      filename: SERVER,
      errors: [{ messageId: 'localeNoTimeZone' }],
    },
    {
      name: 'getHours on a nested functions codebase',
      code: 'const h = d.getHours();',
      filename: '/repo/apps/mercado-livre/functions/src/sweepStock.ts',
      errors: [{ messageId: 'localGetter' }],
    },
    {
      name: 'bracket access cannot bypass the rule',
      code: "const h = d['getHours']();",
      filename: SERVER,
      errors: [{ messageId: 'localGetter' }],
    },
    {
      name: 'windows-style paths are normalized before scope matching',
      code: 'const h = d.getHours();',
      filename: 'C:\\repo\\apps\\functions\\src\\estoques\\aplicarEstoque.ts',
      errors: [{ messageId: 'localGetter' }],
    },
  ],
});
