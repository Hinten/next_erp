/**
 * A focused test (`describe.only` / `it.only` / `test.only`) may not be committed.
 *
 * WHY. A `.only` does not fail anything — it makes the rest of its file stop
 * running while every reporter still says PASS. That is the exact silent-pass
 * class the CI lane design is built around ("CI green" means "the suite
 * passed", root `CLAUDE.md`), and it was the one instance of it this repo did
 * not guard:
 *
 *   - **Playwright (62 e2e specs) was wide open.** `forbidOnly` defaults to
 *     `false` and `apps/web/playwright.config.ts` did not set it, so one
 *     committed `test.only` would run a single test, skip the rest of its file,
 *     and let `E2E gate (cadastros|vendas|emulator)` report green. That config
 *     now sets `forbidOnly: !!process.env.CI` — this rule is the fast feedback
 *     loop in front of it.
 *   - **Vitest (900+ test files) is protected only by an UNDECLARED upstream
 *     default.** `allowOnly` defaults to `!process.env.CI`, no workspace
 *     overrides it, and nothing asserts it. A default is not a decision.
 *
 * A lint rule and the runner flags are not redundant: the flags fail the RUN
 * (covering a `.only` that arrives through a rebase or a merge that touches no
 * linted line), while this fails the COMMIT, at the keystroke, with the file
 * open — `.lintstagedrc.mjs` runs `eslint --max-warnings 0` on staged files.
 *
 * WHAT IS FLAGGED. A call to `.only(...)` on `describe` / `it` / `test`, and
 * the same through their modifier chains (`describe.only.each(...)`,
 * `it.concurrent.only(...)`, `test.each(...).only(...)`).
 *
 * WHAT IS DELIBERATELY NOT FLAGGED:
 *   - `.skip` in every form. The 16 `.skip` sites here are deliberate
 *     credential gating (`!hasFullCreds ? describe.skip : describe`) and
 *     per-step guards. A skip is visible in the reporter's own counts; `.only`
 *     is what makes the counts lie.
 *   - `RuleTester.itOnly = it.only`, the wiring ESLint's own `RuleTester`
 *     REQUIRES, present in the rule tests in this directory. It is an
 *     ASSIGNMENT of the function, never a call, so nothing special is needed:
 *     the rule reports calls only, which is what makes the wiring legal without
 *     a path allow-list. The single exception is `prefer-schema-enum.test.js`,
 *     which must WRAP the hook to pass a timeout and therefore does call it —
 *     it carries an `eslint-disable-next-line` naming this rule, at the site,
 *     rather than being exempted invisibly from here.
 */

/** `describe` / `it` / `test`, plus the Vitest/Jest aliases. */
const TEST_CALLEES = new Set(['describe', 'it', 'test', 'suite', 'bench']);

/** Walk a member chain back to its root identifier: `a.b.c()` -> `a`. */
function rootIdentifier(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') cur = cur.object;
  // `test.each([...])(...)` puts a CallExpression under the member chain.
  if (cur && cur.type === 'CallExpression') return rootIdentifier(cur.callee);
  return cur && cur.type === 'Identifier' ? cur : null;
}

/** Is `.only` anywhere in this member chain? */
function chainHasOnly(node) {
  let cur = node;
  while (cur && cur.type === 'MemberExpression') {
    if (!cur.computed && cur.property.type === 'Identifier' && cur.property.name === 'only') {
      return true;
    }
    cur = cur.object;
    if (cur && cur.type === 'CallExpression') cur = cur.callee;
  }
  return false;
}

const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid committed focused tests (`describe.only` / `it.only` / `test.only`), which silently skip the rest of their file while CI still reports green.',
    },
    schema: [],
    messages: {
      focused:
        'Remove `.only` before committing. It silently skips every other test in this file while the reporter — and the CI gate — still say PASS. Run one test locally with `vitest -t "<name>"` or `playwright test -g "<name>"` instead.',
    },
  },
  create(context) {
    // `RuleTester.itOnly = it.only` is a REQUIRED assignment in this repo's
    // eleven rule tests. Only a CALL focuses a test, so bare references never
    // report — that is what makes the wiring legal without a path allow-list.
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (!chainHasOnly(callee)) return;
        const root = rootIdentifier(callee);
        if (!root || !TEST_CALLEES.has(root.name)) return;
        context.report({ node: callee, messageId: 'focused' });
      },
    };
  },
};

export default rule;
