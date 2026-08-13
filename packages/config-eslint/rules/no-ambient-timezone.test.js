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
const SERVER = '/repo/apps/mercado-livre/lib/marketplace/estoqueSweep.ts';
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
      filename: '/repo/apps/mercado-livre/lib/marketplace/estoqueSweep.test.ts',
    },
    {
      name: 'a scheduled function timeZone option is the CRON zone, not a format call',
      code: "export const sweep = onSchedule({ schedule: 'every 30 minutes', timeZone: 'America/Sao_Paulo' }, handler);",
      filename: '/repo/apps/whatsapp/functions/src/index.ts',
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
      name: 'real site: devolucao builds a pt-BR comment from local getters',
      code: 'const data = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;',
      filename: '/repo/packages/data/src/pedido/devolucao.ts',
      errors: [
        { messageId: 'localGetter' },
        { messageId: 'localGetter' },
        { messageId: 'localGetter' },
      ],
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
