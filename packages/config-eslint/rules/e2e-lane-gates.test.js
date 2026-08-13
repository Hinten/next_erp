import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every e2e lane must ALWAYS publish a check, and that check must tell the truth.
 *
 * WHAT WENT WRONG. `e2e-cadastros.yml` and `e2e-vendas.yml` used to carry a
 * top-level `paths:` filter. A `paths:` that does not match means GitHub never
 * instantiates the workflow, so it publishes NO check run at all — not a failure,
 * not a skip, nothing. Six of twenty-five consecutive merged PRs (#1009, #989,
 * #974, #973, #969, #965) therefore merged with zero staging e2e and no visible
 * sign of it, and the root CLAUDE.md documented the state as a permanent caveat:
 * "CI green" ≠ "e2e passed". The list was also simply wrong — `apps/web` imports
 * `@delfrance/integrations-nfe`, `@delfrance/integrations-freight-br` and
 * `@delfrance/storage`, none of which appeared in it.
 *
 * THE INVARIANT THIS FILE DEFENDS. Each lane triggers unconditionally, decides
 * scope in a `changes` job (see `.github/scripts/e2e-affected.mjs`), and reports
 * through an unskippable `gate` job whose name is pinned as a required status
 * check on the `protect-main` ruleset.
 *
 * ⚠️ WHY THE GATE MUST BE UNSKIPPABLE. A job skipped by `if:` still publishes a
 * check run, with conclusion `skipped`, and GitHub's required-status-check
 * evaluation treats `skipped` as SATISFYING the requirement. So a gate carrying
 * any condition beyond `always()` would go green in precisely the cases it exists
 * to report on. That is why assertions 3 and 4 below are separate: `always()`
 * alone is a job that is green unconditionally, which is worse than no gate at
 * all, because the ruleset now trusts it.
 *
 * ⚠️ WHY A LINE SCAN AND NOT A YAML PARSE. `on:` is a YAML 1.1 boolean. Under
 * js-yaml@3 — or any 1.1-mode parser — a workflow's `on:` block comes back keyed
 * as `true`, not `"on"`, so a test reading `doc.on` sees `undefined` for every
 * file and passes vacuously. That is the exact failure class this guard exists to
 * prevent. It also follows the precedent stated outright in
 * `runtime-deps-pinned.test.js`: "A line-anchored regex, not a YAML parse."
 *
 * ⚠️ `.prettierignore` contains `.github/`, so this YAML is NOT Prettier-formatted
 * and its indentation is not machine-guaranteed. Hence `jobBlocks` derives the
 * indent width instead of assuming one, and `it('the scanner still understands
 * this repo's YAML')` exists so a parsing regression fails loudly rather than
 * turning every other assertion green.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The pinned contract. `suite` is the job that actually runs Playwright; `check`
 * is the string a human types into the `protect-main` ruleset (id 16348427).
 *
 * ⚠️ A check-run name carries NO workflow-name prefix — `ci.yml`'s job publishes
 * as bare `lint-typecheck-test` — so these must be unique across the whole repo,
 * not just within their file. They are pure ASCII on purpose: they get pasted into
 * a JSON payload from PowerShell on Windows, and an em dash mangled in transit
 * produces a required check that never matches and an unmergeable `main`.
 *
 * Renaming one of these without editing the ruleset in the same change leaves a
 * required check that is never reported — the branch then merges without it.
 */
const LANES = {
  '.github/workflows/e2e-cadastros.yml': {
    suite: 'cadastros',
    check: 'E2E gate (cadastros)',
    roots: ['@delfrance/web'],
  },
  '.github/workflows/e2e-vendas.yml': {
    suite: 'vendas',
    check: 'E2E gate (vendas)',
    // This lane also builds and serves apps/integrations on :3001 for the
    // configuracoes suite, so a change there can break it.
    roots: ['@delfrance/web', '@delfrance/integrations-app'],
  },
  '.github/workflows/e2e-emulator.yml': {
    suite: 'e2e-emulator',
    check: 'E2E gate (emulator)',
    // firebase.e2e.json serves the `storage` functions codebase FROM SOURCE, so a
    // functions-only PR must run this lane — nothing else exercises those
    // callables and triggers.
    roots: ['@delfrance/web', '@delfrance/functions'],
  },
};

/** The shared engine. Called only via `workflow_call`; never an entry lane. */
const REUSABLE = '.github/workflows/e2e-reusable.yml';

/** Same discovery shape as `env-example-location.test.js` — see its long note. */
function findByPathspec(pathspec) {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', pathspec], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

const read = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8');

/** Lines of the top-level `on:` block, exclusive of the header itself. */
function onBlock(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^(?:on|'on'|"on")\s*:/.test(l));
  if (start === -1) return { header: null, body: [] };
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return { header: lines[start], body };
}

/** `{ jobId: body }` for the top-level `jobs:` mapping, with the indent derived. */
function jobBlocks(source) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => /^jobs\s*:/.test(l));
  if (start === -1) return {};
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  const firstReal = body.find((l) => l.trim() && !l.trim().startsWith('#'));
  const indent = firstReal ? firstReal.match(/^\s*/)[0] : '  ';
  const idRe = new RegExp(`^${indent}([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*(?:#.*)?$`);

  const jobs = {};
  let current = null;
  for (const line of body) {
    const m = line.match(idRe);
    if (m) {
      current = m[1];
      jobs[current] = [];
    } else if (current) {
      jobs[current].push(line);
    }
  }
  return Object.fromEntries(Object.entries(jobs).map(([k, v]) => [k, v.join('\n')]));
}

/** The check-run name GitHub publishes for a job: its `name:`, else its id. */
function checkName(jobId, jobBody) {
  const m = jobBody.match(/^\s{4}name\s*:\s*(.+?)\s*$/m);
  if (!m) return jobId;
  return m[1].replace(/^['"]|['"]$/g, '');
}

describe('e2e lanes always report', () => {
  // ------------------------------------------------------------------
  // 0. Positive control. `.github/` is not Prettier-formatted, so prove the
  //    scanner works before trusting a green from it. ci-freight.yml is the
  //    stable fixture: it legitimately carries `paths:` on both `push` and
  //    `pull_request`, and its three job ids have not changed in the file's life.
  // ------------------------------------------------------------------
  it("the scanner still understands this repo's YAML", () => {
    const source = read('.github/workflows/ci-freight.yml');
    const pathsLines = onBlock(source).body.filter((l) => /^\s+paths(-ignore)?\s*:/.test(l));

    expect(
      pathsLines.length,
      [
        'The workflow scanner in this file no longer parses ci-freight.yml correctly.',
        'It expected to find the 2 `paths:` keys that workflow legitimately has (one',
        'on `push`, one on `pull_request`) and found ' + pathsLines.length + '.',
        '',
        'Fix the scanner before trusting anything else in this file: every other',
        'assertion here would otherwise pass by finding nothing.',
      ].join('\n'),
    ).toBe(2);

    expect(Object.keys(jobBlocks(source))).toEqual([
      'freight-build-test',
      'freight-live',
      'report-failure',
    ]);
  });

  // ------------------------------------------------------------------
  // 1. Anti-vacuity, in both directions.
  // ------------------------------------------------------------------
  it('finds every e2e lane, and no unknown one', () => {
    const found = findByPathspec(':(glob).github/workflows/e2e-*.yml').sort();
    const expected = [...Object.keys(LANES), REUSABLE].sort();

    expect(
      found,
      [
        'The set of e2e workflow files changed.',
        '',
        'MISSING an expected file means the pathspec stopped matching and this whole',
        'guard is checking nothing. EXTRA means a new e2e lane was added without a',
        'gate job — which is the original defect (a lane that can silently publish no',
        'check) returning under a new filename.',
        '',
        'Add the new lane to LANES at the top of this file, give it a `changes` job',
        'and an `always()` gate, and pin its gate name on the protect-main ruleset.',
      ].join('\n'),
    ).toEqual(expected);
  });

  // ------------------------------------------------------------------
  // 2. The defect itself.
  // ------------------------------------------------------------------
  it('no e2e entry workflow filters on paths', () => {
    const offenders = Object.keys(LANES).flatMap((file) => {
      const { header, body } = onBlock(read(file));
      const bad = body.filter((l) => /^\s+paths(-ignore)?\s*:/.test(l)).map((l) => l.trim());
      // A flow-style `on: {pull_request: {paths: [...]}}` would hide from the line
      // scan entirely, so require the header to be bare.
      if (header && !/^(?:on|'on'|"on")\s*:\s*(?:#.*)?$/.test(header)) {
        bad.push(`inline mapping on the \`on:\` header — ${header.trim()}`);
      }
      return bad.map((b) => `${file} → ${b}`);
    });

    expect(
      offenders,
      [
        'An e2e lane must not carry a top-level `paths:` / `paths-ignore:` filter.',
        '',
        'When it does not match, GitHub never instantiates the workflow, so it',
        'publishes NO check run at all — not a failure, not a skip, nothing. A',
        'required status check that is never reported cannot gate anything, and',
        '"CI green" stops implying "e2e passed". That is the bug this whole design',
        'removed; six of twenty-five consecutive merged PRs hit it.',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        "Put the skip decision in the lane's `changes` job instead, where the lane",
        'still reports. See .github/scripts/e2e-affected.mjs.',
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 3 + 4. The gate exists, always runs, and actually reads the suite result.
  // ------------------------------------------------------------------
  it('every e2e lane has an unskippable gate wired to its suite job', () => {
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const jobs = jobBlocks(read(file));
      const gate = jobs.gate;
      if (!gate) {
        offenders.push(`${file} → no \`gate\` job`);
        continue;
      }
      if (!/^\s{4}if\s*:\s*always\(\)\s*$/m.test(gate)) {
        offenders.push(`${file} → gate is not exactly \`if: always()\``);
      }
      if (!new RegExp(`needs\\s*:\\s*\\[[^\\]]*\\b${lane.suite}\\b`).test(gate)) {
        offenders.push(`${file} → gate does not \`needs:\` the suite job \`${lane.suite}\``);
      }
      if (!gate.includes(`needs.${lane.suite}.result`)) {
        offenders.push(`${file} → gate never reads \`needs.${lane.suite}.result\``);
      }
      if (!gate.includes('needs.changes.outputs.run_e2e')) {
        offenders.push(`${file} → gate never reads the scope verdict`);
      }
      if (!jobs.changes) offenders.push(`${file} → no \`changes\` job`);
    }

    expect(
      offenders,
      [
        'Each e2e lane needs a gate job that is structurally incapable of being',
        'skipped, and that actually inspects what it is certifying.',
        '',
        '⚠️ A job skipped by `if:` still publishes a check run, with conclusion',
        '`skipped`, and GitHub treats `skipped` as SATISFYING a required check. So a',
        'gate carrying any condition beyond `always()` goes green in exactly the',
        'cases it exists to report on. And `always()` WITHOUT a result check is a job',
        'that is green unconditionally — worse than no gate, because the ruleset now',
        'trusts it.',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 4b. Each lane asks the scope question about the RIGHT dependency roots.
  // ------------------------------------------------------------------
  it('every lane passes its own dependency roots to the scope script', () => {
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const source = read(file);
      const m = source.match(/--roots\s+([^\n\\]+)/);
      if (!m) {
        offenders.push(`${file} → never invokes e2e-affected.mjs with --roots`);
        continue;
      }
      const actual = m[1].trim().split(/\s+/).sort();
      const expected = [...lane.roots].sort();
      if (actual.join(' ') !== expected.join(' ')) {
        offenders.push(`${file} → --roots ${actual.join(' ')} (expected ${expected.join(' ')})`);
      }
    }

    expect(
      offenders,
      [
        "A lane's dependency roots changed.",
        '',
        'The roots decide which changes the lane considers relevant, so losing one',
        'makes the lane silently stop running on changes it should catch — a skip',
        'that the gate then reports as green, because from its point of view the',
        'scope job answered honestly.',
        '',
        'Two roots are non-obvious and must not be dropped:',
        '  - vendas needs @delfrance/integrations-app — the lane builds and serves',
        '    apps/integrations on :3001 for the configuracoes suite.',
        '  - emulator needs @delfrance/functions — firebase.e2e.json serves the',
        '    `storage` functions codebase from source, and no other lane exercises',
        '    those callables and triggers at all.',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 5. The pinned names.
  // ------------------------------------------------------------------
  it('the pinned gate check names are unchanged and unique', () => {
    const actual = Object.fromEntries(
      Object.entries(LANES).map(([file]) => [
        file,
        checkName('gate', jobBlocks(read(file)).gate ?? ''),
      ]),
    );
    const expected = Object.fromEntries(
      Object.entries(LANES).map(([file, lane]) => [file, lane.check]),
    );

    expect(
      actual,
      [
        'A gate check-run name changed.',
        '',
        'These exact strings are wired into the `protect-main` ruleset (id 16348427)',
        'as required status checks. GitHub matches a required check by NAME — a',
        'renamed check is simply never reported, and the branch merges without it.',
        'The gate silently stops gating.',
        '',
        'If the rename is intentional, edit the ruleset in the same change:',
        '  gh api repos/Hinten/next_erp/rulesets/16348427',
        '',
        'Note the names are pure ASCII deliberately — no em dash. They get pasted',
        'into a JSON payload from PowerShell on Windows, and a mangled character',
        'produces a required check that never matches and an unmergeable `main`.',
      ].join('\n'),
    ).toEqual(expected);

    const names = Object.values(actual);
    expect(new Set(names).size, `gate check names must be unique: ${names.join(', ')}`).toBe(
      names.length,
    );
  });

  // ------------------------------------------------------------------
  // 6. The engine stays an engine.
  // ------------------------------------------------------------------
  it('the reusable engine declares no gate and stays workflow_call-only', () => {
    const source = read(REUSABLE);
    const jobs = jobBlocks(source);
    const { body } = onBlock(source);

    expect(
      Object.keys(jobs),
      [
        `${REUSABLE} must not declare a \`gate\` job.`,
        '',
        'A job inside a reusable workflow publishes as "<caller job id> / <job id>",',
        'so both staging callers would emit an identically-named check and the ruleset',
        'could not tell them apart. Worse, the fork guard and the scope guard both sit',
        "on the CALLER's job — when that is skipped the reusable contributes no jobs",
        'at all, so a gate in here would vanish in exactly the two cases it exists to',
        'report on. The gate belongs in the caller.',
      ].join('\n'),
    ).not.toContain('gate');

    expect(
      body.some((l) => /^\s+workflow_call\s*:/.test(l)),
      `${REUSABLE} must stay \`workflow_call\`-only.`,
    ).toBe(true);

    expect(
      body.filter((l) => /^\s+(pull_request|push)\s*:/.test(l)),
      [
        `${REUSABLE} gained a \`pull_request\` or \`push\` trigger.`,
        '',
        'That would make it a fourth entry lane, which assertions 2-5 above do not',
        'cover — a lane with no gate and no scope job, i.e. the original defect.',
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 7. Every Playwright project is claimed by exactly one lane.
  // ------------------------------------------------------------------
  it('every Playwright project is run by exactly one lane', () => {
    const config = read('apps/web/playwright.config.ts');
    const declared = [...config.matchAll(/^\s+name:\s*'([^']+)',\s*$/gm)].map((m) => m[1]);

    expect(
      declared.length,
      'Parsed no Playwright projects out of apps/web/playwright.config.ts — the ' +
        'regex in this test has rotted and it is now asserting nothing.',
    ).toBeGreaterThan(3);

    /**
     * `local-perf` is the opt-in 1000-item checkout perf harness. It is added to
     * the project list only under `CHECKOUT_PERF=1` and CI never runs it — the scan
     * ALGORITHM is gated instead by `checkoutEngine.perf.test.ts` in
     * `@delfrance/schemas`. See the long comment in playwright.config.ts.
     */
    const NOT_IN_CI = new Set(['local-perf']);

    const wired = new Set();
    for (const file of [...Object.keys(LANES), REUSABLE]) {
      const source = read(file);
      for (const m of source.matchAll(/^\s+projects:\s*(.+?)\s*$/gm)) {
        m[1]
          .split(/\s+/)
          .filter(Boolean)
          .forEach((p) => wired.add(p));
      }
      for (const m of source.matchAll(/--project=([A-Za-z0-9_-]+)/g)) wired.add(m[1]);
    }

    const orphans = declared.filter((p) => !NOT_IN_CI.has(p) && !wired.has(p));

    expect(
      orphans,
      [
        'A Playwright project exists that no CI lane runs.',
        '',
        'The suite would look healthy — every lane green — while these specs were',
        'never executed. The project name is the only thing wiring a spec file to a',
        'lane (the filename suffix picks the project; the project is passed to a',
        'workflow), so an unwired project is silently dead coverage.',
        '',
        ...orphans.map((o) => `  - ${o}`),
        '',
        "Add it to a lane's `projects:` input, or to NOT_IN_CI above with a comment",
        'explaining why CI must never run it.',
      ].join('\n'),
    ).toEqual([]);
  });
});
