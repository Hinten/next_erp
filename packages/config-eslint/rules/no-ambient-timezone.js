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
//   - the LOCAL-time `Date` getters AND setters (`getHours`, `setHours`, …),
//     whose `getUTC*` / `setUTC*` counterparts are the zone-free form
//   - `new Date(y, m, d, …)`, which reads its components in the ambient zone
//
// NOT flagged:
//   - any of the above WITH an explicit `timeZone` — that is the correct shape,
//     and `apps/mercado-livre/lib/marketplace/estoqueSweep.ts` already does it
//     (it decides cron-slot ownership in `America/Sao_Paulo`, deliberately)
//   - `getUTC*`, `setUTC*`, `Date.UTC(...)`, epoch arithmetic
//   - `n.toLocaleString('pt-BR', { style: 'currency' })` — `toLocaleString` is
//     also a `Number`/`BigInt`/`Array` method, and money is this repo's dominant
//     use of it; a currency format is not a timezone bug
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
// Warn, not error: ONE pre-existing site — `apps/nfe`'s certificado route
// rendering a cert expiry with `toLocaleDateString('pt-BR')` and no zone. It is
// a user-facing string whose correct zone is a product decision (probably
// `America/Sao_Paulo`, not UTC), so the rule surfaces it rather than silently
// picking one. NOTE lint-staged runs `--max-warnings 0`, so editing that file
// means resolving it first.
//
// (An earlier draft counted 6 sites, but 5 of them were `devolucao.ts` under the
// too-broad `/packages/data/` scope — browser code, and therefore exempt by this
// rule's own policy. See the SERVER_PATHS note.)

/**
 * Server surfaces: "ambient" here means "whichever container ran this".
 *
 * ⚠️ `@delfrance/data` is listed by SUBPATH, not wholesale, because it is a
 * MIXED package: `./hooks` ships `'use client'` (usePipelineSnapshot,
 * useSnapshot, useSubcollectionIdLookup) and `./pedido` is consumed from
 * `apps/web` components. Only `./admin/*` and `./server` are genuinely
 * server-only. Listing the whole package flagged `devolucao.ts`'s
 * `autoComentario` — which builds a pt-BR operator comment and runs in the
 * BROWSER, since `registrarIncidentesDeTroca`'s only consumers are
 * `EditarPedidoView`/`NovoPedidoView` — i.e. precisely the case this
 * include-list inversion exists to exempt.
 */
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
  '/packages/data/src/admin/',
  '/packages/data/src/server/',
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

/**
 * The mutating half. `d.setHours(0, 0, 0, 0)` — the canonical "start of day"
 * idiom — lands at 03:00Z on `apps/nfe` and 00:00Z everywhere else, and the
 * unit test agrees with neither. Every one has a `setUTC*` twin.
 */
const LOCAL_SETTERS = new Set([
  'setFullYear',
  'setMonth',
  'setDate',
  'setHours',
  'setMinutes',
  'setSeconds',
  'setMilliseconds',
]);

const LOCALE_FORMATTERS = new Set(['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']);

/**
 * Options that only make sense for a NUMBER format.
 *
 * `toLocaleString` is not a `Date` method — `Number`, `BigInt` and `Array` have
 * it too, and money is this repo's dominant use
 * (`n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })`). This
 * rule matches on the member name alone, so without this escape a currency
 * formatter on a server path would be told to add a `timeZone`. Since
 * lint-staged runs `--max-warnings 0`, that is a hard stop on nonsense advice.
 *
 * `toLocaleDateString` / `toLocaleTimeString` are `Date`-only and need no such
 * escape.
 */
const NUMBER_FORMAT_OPTIONS = new Set([
  'style',
  'currency',
  'currencyDisplay',
  'currencySign',
  'minimumFractionDigits',
  'maximumFractionDigits',
  'minimumIntegerDigits',
  'minimumSignificantDigits',
  'maximumSignificantDigits',
  'notation',
  'compactDisplay',
  'signDisplay',
  'unit',
  'unitDisplay',
  'useGrouping',
  'roundingMode',
]);

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
 * Does the OPTIONS argument name a `timeZone`?
 *
 * ⚠️ Scoped to argument index 1 on purpose. Both `toLocale*(locale, options)`
 * and `Intl.DateTimeFormat(locales, options)` take the options SECOND, and an
 * earlier draft scanned every argument — so a non-literal LOCALE in position 0
 * (`d.toLocaleString(locale)`, `new Intl.DateTimeFormat(cfg.locale)`) hit the
 * by-reference escape hatch and switched the rule off entirely, with no options
 * object present at all. That is the exact shape a channel adapter reaches for
 * once the locale becomes configurable, i.e. the site "that forgot entirely"
 * this rule exists to catch.
 *
 * Within that one argument it stays conservative: a spread or a variable
 * reference counts as "named", because the author clearly passed options and
 * this rule cannot see through the indirection. It exists to catch the site
 * that forgot, not to audit dynamic option objects.
 */
function optionsArg(args) {
  return args.length > 1 ? args[1] : null;
}

function namesTimeZone(args) {
  const opts = optionsArg(args);
  if (!opts) return false;
  if (opts.type === 'ObjectExpression') {
    return opts.properties.some((p) => {
      if (p.type === 'SpreadElement') return true;
      const key = p.key;
      if (!key) return false;
      if (key.type === 'Identifier') return key.name === 'timeZone';
      if (key.type === 'Literal') return key.value === 'timeZone';
      return false;
    });
  }
  // An options object passed by reference — assume it was considered.
  return opts.type === 'Identifier' || opts.type === 'MemberExpression';
}

/** Is the options argument clearly formatting a NUMBER rather than a date? */
function looksLikeNumberFormat(args) {
  const opts = optionsArg(args);
  if (!opts || opts.type !== 'ObjectExpression') return false;
  return opts.properties.some((p) => {
    if (p.type === 'SpreadElement') return false;
    const key = p.key;
    if (!key) return false;
    if (key.type === 'Identifier') return NUMBER_FORMAT_OPTIONS.has(key.name);
    if (key.type === 'Literal') return NUMBER_FORMAT_OPTIONS.has(String(key.value));
    return false;
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
        'different answer depending on which service runs it. Use `{{utc}}` ' +
        'for zone-free logic, or format through Intl with an explicit `timeZone` when ' +
        'a human needs to read a wall clock.',
      localDateParts:
        '`new Date(year, month, …)` builds the instant from AMBIENT-timezone ' +
        'components, so the same expression is 03:00Z on apps/nfe and 00:00Z on every ' +
        'other backend. Use `Date.UTC(...)` (optionally wrapped in `new Date(...)`) so ' +
        'the instant does not depend on which service ran the code.',
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
        // `toLocaleString` also exists on Number/BigInt/Array — a currency
        // format is not a timezone bug. See NUMBER_FORMAT_OPTIONS.
        if (name === 'toLocaleString' && looksLikeNumberFormat(node.arguments)) return;
        if (!namesTimeZone(node.arguments)) {
          context.report({ node, messageId: 'localeNoTimeZone', data: { name } });
        }
        return;
      }
      if (LOCAL_GETTERS.has(name) || LOCAL_SETTERS.has(name)) {
        context.report({
          node,
          messageId: 'localGetter',
          // `getHours` -> `getUTCHours`, `setHours` -> `setUTCHours`.
          data: { name, utc: `${name.slice(0, 3)}UTC${name.slice(3)}` },
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
          return;
        }
        // `new Date(y, m, d, …)` reads its components in the ambient zone. The
        // 0- and 1-argument forms are a clock read and an epoch/string
        // conversion respectively — neither is zone-dependent here
        // (`no-lossy-date-parse` owns the string case).
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Date' &&
          node.arguments.length > 1
        ) {
          context.report({ node, messageId: 'localDateParts' });
        }
      },
    };
  },
};

export default rule;
