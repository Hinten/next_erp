// Custom rule: on a SERVER surface, never read the ambient process timezone.
// Name the zone explicitly, or work in UTC.
//
// The policy, in one line: an epoch integer is absolute and zone-free, so
// anything stored, compared or transmitted carries no zone at all — and where a
// wall-clock zone is genuinely needed, it is PASSED, never inherited from the
// host.
//
// Why it matters here specifically: `apps/nfe` sets `TZ=America/Sao_Paulo` in
// its App Hosting config while every other backend runs UTC. So the same code
// reading the ambient zone produces answers three hours apart depending on which
// service executes it — a difference that never shows up in a unit test, because
// the test runner has its own third timezone. This is not hypothetical: it is
// how an offset-less `Date.parse` resolved two different instants across our own
// backends (see `no-lossy-date-parse`, and #395 for the NF-e fiscal-date case).
//
// Flagged:
//   - `toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` with no
//     explicit `timeZone` in the options object
//   - `Intl.DateTimeFormat(...)` with no explicit `timeZone`
//   - the LOCAL-time `Date` getters (`getHours`, `getMonth`, …), whose `getUTC*`
//     counterparts are the zone-free form
//
// NOT flagged:
//   - any of the above WITH an explicit `timeZone` — that is the correct shape,
//     and `apps/mercado-livre/lib/marketplace/estoqueSweep.ts` already does it
//     (it decides cron-slot ownership in `America/Sao_Paulo`, deliberately)
//   - `getUTC*`, `Date.UTC(...)`, epoch arithmetic
//   - a scheduled function's `timeZone: 'America/Sao_Paulo'` — that is the CRON
//     schedule's zone, not the process zone, and business schedules should
//     follow business time including DST
//
// SCOPE IS AN INCLUDE-LIST, not the usual allow-list, and that inversion is the
// point: reading the ambient zone is CORRECT on the client. A date picker and a
// `toLocaleString('pt-BR')` in `apps/web` should show the operator their own
// wall clock; forcing those to UTC would display the wrong time to a human. So
// this rule applies only where "ambient" means "whichever container happened to
// run this", never where it means "the person looking at the screen".
//
// Warn, not error: 3 pre-existing sites (2 in packages/data/src/pedido/devolucao.ts
// building a pt-BR operator comment, 1 in apps/nfe's certificado route). Both are
// user-facing strings whose correct zone is a product decision — probably
// `America/Sao_Paulo` rather than UTC — so this rule surfaces them rather than
// silently picking one. NOTE lint-staged runs `--max-warnings 0`, so editing one
// of those files means resolving it first.

/** Server surfaces: "ambient" here means "whichever container ran this". */
const SERVER_PATHS = [
  '/apps/functions/',
  '/functions/src/', // the four nested apps/<channel>/functions codebases
  '/apps/nfe/',
  '/apps/melhor-envio/',
  '/apps/mercado-livre/',
  '/apps/mercado-pago/',
  '/apps/whatsapp/',
  '/apps/integrations/',
  '/packages/integrations/',
  '/packages/data/',
];

/** Local-time accessors. Every one has a `getUTC*` twin that is zone-free. */
const LOCAL_GETTERS = new Set([
  'getFullYear',
  'getMonth',
  'getDate',
  'getDay',
  'getHours',
  'getMinutes',
  'getSeconds',
  'getMilliseconds',
]);

const LOCALE_FORMATTERS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

function isTestFile(filename) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    filename.includes('/e2e/') ||
    filename.includes('/__tests__/') ||
    filename.includes('/test/')
  );
}

/** Member name normalized across dot and bracket access. */
function memberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const prop = member.property;
  if (!member.computed && prop.type === 'Identifier') return prop.name;
  if (member.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return prop.value;
  }
  return null;
}

/**
 * Does any argument name a `timeZone`? Conservative by design — a spread or a
 * variable reference counts as "named", because the author clearly passed
 * options and this rule cannot see through the indirection. It exists to catch
 * the site that forgot entirely, not to audit dynamic option objects.
 */
function namesTimeZone(args) {
  return args.some((arg) => {
    if (arg.type === 'ObjectExpression') {
      return arg.properties.some((p) => {
        if (p.type === 'SpreadElement') return true;
        const key = p.key;
        if (!key) return false;
        if (key.type === 'Identifier') return key.name === 'timeZone';
        if (key.type === 'Literal') return key.value === 'timeZone';
        return false;
      });
    }
    // An options object passed by reference — assume it was considered.
    return arg.type === 'Identifier' || arg.type === 'MemberExpression';
  });
}

/** `Intl.DateTimeFormat` in either call or construct position. */
function isIntlDateTimeFormat(callee) {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Intl' &&
    memberName(callee) === 'DateTimeFormat'
  );
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'On server surfaces, never read the ambient process timezone: pass an ' +
        'explicit timeZone, or use the getUTC* accessors.',
    },
    schema: [],
    messages: {
      localeNoTimeZone:
        '`{{name}}` without an explicit `timeZone` formats in the AMBIENT process ' +
        'timezone. apps/nfe runs TZ=America/Sao_Paulo while every other backend is ' +
        'UTC, so this renders differently depending on which service runs it. Pass ' +
        "`{ timeZone: 'America/Sao_Paulo' }` (or 'UTC') explicitly.",
      localGetter:
        '`{{name}}` reads the AMBIENT process timezone. apps/nfe runs ' +
        'TZ=America/Sao_Paulo while every other backend is UTC, so this yields a ' +
        'different answer depending on which service runs it. Use `getUTC{{suffix}}` ' +
        'for zone-free logic, or format through Intl with an explicit `timeZone` when ' +
        'a human needs to read a wall clock.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    // Include-list, not allow-list — see the header. Local time is correct on the client.
    if (!SERVER_PATHS.some((p) => filename.includes(p)) || isTestFile(filename)) {
      return {};
    }

    function checkCall(node) {
      const callee = node.callee;
      if (!callee || callee.type !== 'MemberExpression') return;
      const name = memberName(callee);

      if (isIntlDateTimeFormat(callee)) {
        if (!namesTimeZone(node.arguments)) {
          context.report({
            node,
            messageId: 'localeNoTimeZone',
            data: { name: 'Intl.DateTimeFormat' },
          });
        }
        return;
      }
      if (LOCALE_FORMATTERS.has(name)) {
        if (!namesTimeZone(node.arguments)) {
          context.report({ node, messageId: 'localeNoTimeZone', data: { name } });
        }
        return;
      }
      if (LOCAL_GETTERS.has(name)) {
        context.report({
          node,
          messageId: 'localGetter',
          data: { name, suffix: name.slice(3) },
        });
      }
    }

    return {
      CallExpression: checkCall,
      NewExpression(node) {
        if (isIntlDateTimeFormat(node.callee) && !namesTimeZone(node.arguments)) {
          context.report({
            node,
            messageId: 'localeNoTimeZone',
            data: { name: 'Intl.DateTimeFormat' },
          });
        }
      },
    };
  },
};

export default rule;
