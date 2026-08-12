// Custom rule: never parse a date STRING through `Date`. Funnel it through
// `parseIsoToMicros` / `parseIsoToMillis` (or the tolerant `coerceToMicros` /
// `coerceToMillis`) in `@delfrance/core/datetime`.
//
// Why this exists — two distinct silent-corruption modes, both shipped:
//
//   1. PRECISION LOSS. `Date.parse` returns MILLISECONDS. Every digit finer than
//      a millisecond is destroyed at the boundary, and `coerceToMicros` then
//      multiplied by 1000 and refilled them with zeros, so the loss was
//      invisible in the stored value. Providers really do send microseconds:
//      Django REST Framework's `isoformat()` emits up to 6 fractional digits
//      from a Postgres microsecond column. Truncating them collapses two
//      updates less than a millisecond apart onto byte-identical stamps — at
//      which point a freshness guard cannot order them and the STALE payload
//      can win. That is the Loja Integrada stale-overwrite defect.
//
//   2. AMBIENT TIMEZONE. `Date.parse` reads an offset-less string
//      ("2026-06-16T12:00:00", which DRF emits when USE_TZ=False) in the
//      PROCESS timezone. `apps/nfe` runs with TZ=America/Sao_Paulo while every
//      other backend is UTC, so the same payload resolved three hours apart
//      depending on which service parsed it.
//
// Flagged:
//   - `Date.parse(x)`                  — always; it cannot return microseconds
//   - `new Date(x)` / `Date(x)`        — only when `x` is NOT provably numeric
//
// NOT flagged (lossless, and the documented conversion direction):
//   - `new Date()`                     — a clock read, no parsing
//   - `new Date(1700000000000)`        — a numeric epoch literal
//   - `new Date(ms)` where the argument is arithmetic (`x * 1000`, `a + b`) or a
//     `Number(...)` / `Date.now()` call — epoch → Date is exact
//
// This rule is intentionally NOT type-aware: only `prefer-schema-enum` is, and
// it lives inside `typeAware(...)` for that reason.
//
// That constraint drives the central design decision: `new Date(x)` is reported
// only when `x` is PROVABLY a string, never merely when it is unproven. The
// first draft did the opposite — report anything not provably numeric — and it
// immediately fired on `new Date(ms)` in `packages/schemas/src/integracao.ts`
// and `new Date(Math.floor(us / 1000))` in `packages/data/src/pedido/devolucao.ts`,
// both lossless epoch→Date conversions. There are ~146 such sites in the repo,
// and lint-staged runs `--max-warnings 0`, so that direction would block edits
// across the codebase to flag no defect at all. Accepting a few false NEGATIVES
// (a string arriving through a bare identifier) is the right trade: `Date.parse`
// — which is unambiguous and cannot return microseconds — is still caught
// unconditionally, and it is by far the more common shape on provider payloads.
//
// Allow-listed files (by path) — the ONE place each pattern legitimately lives:
//   - packages/core/src/datetime/       → the canonical parser itself, which
//                                          must keep a `Date` interop surface
//   - packages/config-eslint/rules/     → this rule and its fixtures
//   - tools/migrations/.../shapeReport.ts → classifies raw legacy wire shapes,
//                                          so it must be able to see a `Date`
//   - tools/test-fixtures/src/datetime-shapes.ts → the legacy-shape audit tool,
//                                          same reason
//
// Tests and e2e helpers are exempt wholesale (see `isTestFile`): a fixture that
// writes `Date.parse('2026-01-01T00:00:00Z') * 1000` is the READABLE way to
// author a microsecond literal, and `vi.setSystemTime(new Date('...'))` is
// idiomatic vitest. There are ~490 such sites and none of them reach a provider
// payload.
//
// Warn, not error: this is a ratchet over a known pre-existing population
// (`Date.parse` alone has ~24 non-test sites). Note lint-staged runs
// `--max-warnings 0`, so touching one of those files means fixing it first.
// Distinct rule name, so it coexists with any app's `no-restricted-syntax`
// override — flat config does full-replacement per rule NAME, never across
// names, and apps/nfe plus five channel apps already override that rule.

const ALLOW_LIST = [
  '/packages/core/src/datetime/',
  '/packages/config-eslint/rules/',
  '/tools/migrations/src/2026-06-pedido-pagamento-micros/shapeReport.ts',
  '/tools/test-fixtures/src/datetime-shapes.ts',
];

/** Test, spec and e2e-helper files author ISO literals deliberately. */
function isTestFile(filename) {
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    filename.includes('/e2e/') ||
    filename.includes('/__tests__/') ||
    filename.includes('/test/')
  );
}

/**
 * Member name of a `MemberExpression`, normalized across dot AND bracket access,
 * so `Date['parse'](s)` cannot slip past a dot-only check.
 */
function memberName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  const prop = member.property;
  if (!member.computed && prop.type === 'Identifier') return prop.name;
  if (member.computed && prop.type === 'Literal' && typeof prop.value === 'string') {
    return prop.value;
  }
  return null;
}

/** `Date.parse` / `Date['parse']`. */
function isDateParse(callee) {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'Date' &&
    memberName(callee) === 'parse'
  );
}

/** Calls whose return value is unambiguously a string. */
const STRING_CALLS = new Set(['String', 'toISOString', 'toJSON', 'toDateString', 'toUTCString']);

/**
 * Is the argument provably a STRING without type information?
 *
 * Only shapes that cannot be a number count: a string literal, a template
 * literal, a string-returning call, and `+` concatenation involving one of
 * those. `+` is the only arithmetic operator considered, precisely because it
 * is the only one that is also string concatenation — `a - b` is always
 * numeric, so it is not a signal here.
 */
function isProvablyString(node) {
  if (!node) return false;
  switch (node.type) {
    case 'Literal':
      return typeof node.value === 'string';
    case 'TemplateLiteral':
      return true;
    case 'BinaryExpression':
      return node.operator === '+' && (isProvablyString(node.left) || isProvablyString(node.right));
    case 'CallExpression': {
      const callee = node.callee;
      if (callee.type === 'Identifier') return STRING_CALLS.has(callee.name);
      if (callee.type === 'MemberExpression') return STRING_CALLS.has(memberName(callee));
      return false;
    }
    case 'ConditionalExpression':
      // BOTH branches, not either: `flag ? 1700000000000 : '2026-01-01'` can be a
      // number at runtime, so it is not PROVABLY a string and reporting it would
      // be the false positive this rule was redesigned to avoid. Note the
      // `+` case above is different and correctly uses `||` — `x + 'Z'` is a
      // string whatever `x` is, because JS coerces the other operand.
      return isProvablyString(node.consequent) && isProvablyString(node.alternate);
    default:
      return false;
  }
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Parse date strings through @delfrance/core/datetime, never Date.parse / ' +
        'new Date(string) — Date truncates to milliseconds and reads offset-less ' +
        'strings in the ambient process timezone.',
    },
    schema: [],
    messages: {
      dateParse:
        '`Date.parse` returns MILLISECONDS and reads an offset-less string in the ' +
        'ambient process timezone. Use parseIsoToMicros() / parseIsoToMillis() (or ' +
        'coerceToMicros() / coerceToMillis()) from @delfrance/core/datetime, which ' +
        "keep the provider's sub-millisecond digits and resolve offset-less input as UTC.",
      newDateString:
        '`new Date(<string>)` / `Date(<string>)` truncates to milliseconds and ' +
        'resolves an offset-less string in the ambient process timezone. Use ' +
        'parseIsoToMicros() / parseIsoToMillis() from @delfrance/core/datetime. If ' +
        'the argument is already a numeric epoch, use millisToDate() / microsToDate() ' +
        '(or make the numeric intent explicit) so this is provably lossless.',
    },
  },
  create(context) {
    const filename = (context.filename ?? context.getFilename?.() ?? '').replace(/\\/g, '/');
    if (ALLOW_LIST.some((p) => filename.includes(p)) || isTestFile(filename)) {
      return {};
    }

    function checkDateConstruction(node) {
      // `new Date()` is a clock read — nothing is parsed.
      if (node.arguments.length === 0) return;
      // `new Date(y, m, d)` is component construction, not string parsing.
      if (node.arguments.length > 1) return;
      const arg = node.arguments[0];
      if (arg.type === 'SpreadElement') return;
      // Report ONLY a provable string — see the design note in the header.
      if (isProvablyString(arg)) {
        context.report({ node, messageId: 'newDateString' });
      }
    }

    return {
      CallExpression(node) {
        if (isDateParse(node.callee)) {
          context.report({ node, messageId: 'dateParse' });
          return;
        }
        // `Date(x)` without `new` returns a string, but still parses one.
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date') {
          checkDateConstruction(node);
        }
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && node.callee.name === 'Date') {
          checkDateConstruction(node);
        }
      },
    };
  },
};

export default rule;
