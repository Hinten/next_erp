import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every PR-triggered lane must ALWAYS publish a check, and that check must tell
 * the truth. (Was `e2e-lane-gates.test.js`; renamed when the four domain
 * pipelines joined the three e2e lanes.)
 *
 * WHAT WENT WRONG, TWICE. Seven workflows carried a top-level `paths:` filter. A
 * `paths:` that does not match means GitHub never instantiates the workflow, so it
 * publishes NO check run at all — not a failure, not a skip, nothing.
 *
 *   - On the e2e lanes (#1019) that meant six of twenty-five consecutive merged
 *     PRs had zero staging e2e with nothing on the PR page saying so.
 *   - On the domain lanes it was worse, because it was actively firing: `ci.yml`
 *     excludes six workspaces from `turbo run test` and each is owned by exactly
 *     one domain lane, so when the lane skipped those tests ran NOWHERE. Their
 *     `paths:` lists never contained `packages/data`, which all six depend on. On
 *     PR #977 a `packages/data` change ran no domain lane at all.
 *
 * THE INVARIANT DEFENDED HERE. Each lane triggers unconditionally on
 * `pull_request`, decides scope in a `changes` job (see
 * `.github/scripts/e2e-affected.mjs`), and reports through an unskippable `gate`
 * job whose name is pinned as a required status check on `protect-main`.
 *
 * ⚠️ ASSERTION 1 CAN GO RED ON `main` HAVING PASSED ON EVERY PR — and that is the
 * guard working, not a bug in it. Every lane checks out
 * `github.event.pull_request.head.sha`, i.e. the PR HEAD, not GitHub's merge ref,
 * so a repo-state assertion only ever sees its own branch. It happened the day
 * this file was written: #999 added `ci-mercado-livre.yml` to `main` at 15:11,
 * #1031 added the total-partition assertion at 16:34 from a branch that never
 * contained it, both PRs were honestly green, and the merge result had 15
 * workflows against 14 classified. If you are reading this because `main` is red
 * on this assertion, the fix is almost certainly to classify a lane someone added
 * concurrently — not to weaken the partition. Closing the skew itself would mean
 * requiring branches to be up to date before merging, which is a `protect-main`
 * setting and a deliberate cost, not a code change here.
 *
 * ⚠️ WHY THE GATE MUST BE UNSKIPPABLE. A job skipped by `if:` still publishes a
 * check run, with conclusion `skipped`, and GitHub's required-status-check
 * evaluation treats `skipped` as SATISFYING the requirement. A gate carrying any
 * condition beyond `always()` would go green in precisely the cases it exists to
 * report on. And `always()` WITHOUT a result check is a job that is green
 * unconditionally — worse than no gate, because the ruleset now trusts it.
 *
 * ⚠️ WHY A LINE SCAN AND NOT A YAML PARSE. `on:` is a YAML 1.1 boolean. Under
 * js-yaml@3 — or any 1.1-mode parser — a workflow's `on:` block comes back keyed
 * as `true`, not `"on"`, so a test reading `doc.on` sees `undefined` for every file
 * and passes vacuously. That is the exact failure class this guard prevents. It
 * also matches the precedent stated outright in `runtime-deps-pinned.test.js`:
 * "A line-anchored regex, not a YAML parse."
 *
 * ⚠️ `.prettierignore` contains `.github/`, so this YAML is NOT Prettier-formatted
 * and its indentation is not machine-guaranteed. Hence `jobBlocks` derives the
 * indent width, and assertion 0 is a synthetic positive control.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The pinned contract, one entry per gated lane.
 *
 * `check` strings are what a human types into the `protect-main` ruleset (id
 * 16348427). ⚠️ A check-run name carries NO workflow-name prefix — `ci.yml`'s job
 * publishes as bare `lint-typecheck-test` — so every name here must be unique
 * across the WHOLE repo, which assertion 5 enforces. They are pure ASCII on
 * purpose: they get pasted into a JSON payload from PowerShell on Windows, and a
 * mangled em dash produces a required check that never matches and an unmergeable
 * `main`.
 *
 * `jobs[].class` is `required` (must succeed) or `optional:<guard>[+<guard>]`,
 * where each guard names a recorded input the gate is allowed to accept as an
 * explanation for a skip. Keep in sync with each gate's `JOBS:` manifest —
 * assertion 9 checks that.
 */
const LANES = {
  '.github/workflows/e2e-cadastros.yml': {
    gate: 'E2E gate (cadastros)',
    scope: 'E2E scope (cadastros)',
    roots: ['@delfrance/web'],
    // A fork skip here is deliberately RED, unlike the domain live lanes: the
    // staging suite is the ONLY verification of this code, so unverified must not
    // read as verified. Hence the suite job is `required`, not `optional:not_fork`.
    jobs: [{ id: 'cadastros', check: 'cadastros / e2e', class: 'required', readsFork: true }],
  },
  '.github/workflows/e2e-vendas.yml': {
    gate: 'E2E gate (vendas)',
    scope: 'E2E scope (vendas)',
    // This lane also builds and serves apps/integrations on :3001 for the
    // configuracoes suite, so a change there can break it.
    roots: ['@delfrance/web', '@delfrance/integrations-app'],
    jobs: [{ id: 'vendas', check: 'vendas / e2e', class: 'required', readsFork: true }],
  },
  '.github/workflows/e2e-emulator.yml': {
    gate: 'E2E gate (emulator)',
    scope: 'E2E scope (emulator)',
    // firebase.e2e.json serves the `storage` functions codebase FROM SOURCE, so a
    // functions-only PR must run this lane — nothing else exercises those
    // callables and triggers.
    roots: ['@delfrance/web', '@delfrance/functions'],
    jobs: [
      {
        id: 'e2e-emulator',
        check: 'Emulator e2e (auth + firestore + functions)',
        class: 'required',
      },
    ],
  },
  '.github/workflows/ci-nfe.yml': {
    gate: 'CI gate (nfe)',
    scope: 'CI scope (nfe)',
    roots: ['@delfrance/nfe-app', '@delfrance/integrations-nfe'],
    jobs: [
      {
        id: 'nfe-build-test',
        check: 'NFe offline (lint + typecheck + unit + build)',
        class: 'required',
      },
      {
        id: 'nfe-live',
        check: 'NFe live (SEFAZ homologacao + staging Firestore)',
        class: 'optional:live_scope+live_enabled+not_fork',
      },
    ],
  },
  '.github/workflows/ci-freight.yml': {
    gate: 'CI gate (freight)',
    scope: 'CI scope (freight)',
    roots: ['@delfrance/melhor-envio-app', '@delfrance/integrations-freight-br'],
    jobs: [
      {
        id: 'freight-build-test',
        check: 'Freight offline (lint + typecheck + unit + build)',
        class: 'required',
      },
      {
        id: 'freight-live',
        check: 'Freight live (Melhor Envio sandbox)',
        class: 'optional:live_enabled+not_fork',
      },
    ],
  },
  '.github/workflows/ci-mercado-livre.yml': {
    gate: 'CI gate (mercado-livre)',
    scope: 'CI scope (mercado-livre)',
    // One root, not two: `@delfrance/integrations-mercado-livre` is already in the
    // app's closure. That is #823's acceptance criterion ("a PR touching ONLY the
    // library must run this lane") satisfied by the graph rather than by a second
    // entry someone has to remember to keep.
    roots: ['@delfrance/mercado-livre-app'],
    // Fully offline — no ML credentials, ever (ML has no sandbox), so both
    // suite jobs are required and the lane runs on forks too.
    jobs: [
      {
        id: 'ml-firestore-emulator',
        check: 'ML backend on the Firestore emulator',
        class: 'required',
      },
      {
        // #823's last uncovered hop: receiver → real enqueue → tasks emulator →
        // the real `onTaskDispatched` → a real Firestore doc. Split from the
        // job above because it additionally boots the functions + tasks
        // emulators and builds the ML functions artifact, so it starts slower.
        id: 'ml-tasks-roundtrip',
        check: 'ML Cloud Tasks round trip',
        class: 'required',
      },
    ],
  },
  '.github/workflows/ci-storage.yml': {
    gate: 'CI gate (storage)',
    scope: 'CI scope (storage)',
    roots: ['@delfrance/storage', '@delfrance/functions'],
    // Fully offline (demo project, no secrets), so both jobs are required and it
    // runs on forks too.
    jobs: [
      {
        id: 'storage-build-test',
        check: 'Storage offline (lint + typecheck + unit + build)',
        class: 'required',
      },
      {
        id: 'storage-emulator',
        check: 'Storage emulator (firestore + storage + functions)',
        class: 'required',
      },
    ],
  },
  '.github/workflows/ci-rules.yml': {
    gate: 'CI gate (rules)',
    scope: 'CI scope (rules)',
    roots: ['@delfrance/rules-gen'],
    jobs: [
      {
        id: 'rules-offline',
        check: 'Rules offline (lint + typecheck + unit + drift)',
        class: 'required',
      },
      { id: 'rules-emulator', check: 'Rules emulator (firestore)', class: 'required' },
      {
        id: 'rules-api-validate',
        check: 'Rules API compile (projects.test)',
        class: 'optional:not_fork',
      },
    ],
  },
};

/**
 * Every workflow that is deliberately NOT a gated lane, each with the reason.
 *
 * This partition is what makes assertion 1 unfakeable: every file under
 * `.github/workflows/` must appear either here or in LANES, so a NEW lane added
 * without a gate lands in neither and fails loudly. That is strictly stronger than
 * the old `e2e-*.yml` glob, which simply would not have seen it.
 */
const UNGATED = {
  '.github/workflows/ci.yml':
    'Full-graph lane. No `paths:` at all and its suite job carries no `if:`, so ' +
    '`lint-typecheck-test` is directly pinnable and needs no gate of its own.',
  '.github/workflows/e2e-reusable.yml':
    'The shared engine. `workflow_call`-only — asserted separately below.',
  '.github/workflows/nfe-epec-scheduled.yml':
    'schedule + workflow_dispatch only. Never runs on a PR, so it can gate nothing.',
  '.github/workflows/copilot-setup-steps.yml':
    'Agent environment bootstrap. Its self-referential `paths:` filter is correct: ' +
    'it is not a test lane and reports on nothing.',
  '.github/workflows/claude.yml':
    'On-demand @claude bot. Triggers on issue/PR comments and reviews, never on ' +
    '`pull_request`, so it can gate nothing.',
  '.github/workflows/claude-code-review.yml':
    'On-demand @claude review, `issue_comment` only. Never runs on `pull_request`.',
  '.github/workflows/copilot-code-review.yml':
    'Copilot review runner config. Its `pull_request:` trigger is self-referential ' +
    '(`paths:` = this file), so it reports on nothing but its own edits — the same ' +
    'deliberate shape as copilot-setup-steps.yml.',
};

/** Same discovery shape as `env-example-location.test.js` — see its long note. */
function findByPathspec(pathspec) {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', pathspec], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

/**
 * ⚠️ Normalise to LF. `core.autocrlf=true` checks these files out as CRLF on
 * Windows while CI (and the index) sees LF, and every scanner below is
 * line-anchored. Without this the `if:`-block regex silently matched NOTHING
 * locally — so the guard-drift assertion passed by examining zero operands, and
 * only the Linux run was honest. A vacuous local green is exactly the failure
 * mode this whole file exists to prevent, so the normalisation belongs at the
 * single point every assertion reads through.
 */
const read = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\r\n').join('\n');

/** Lines of a top-level block (`on:`, `jobs:`), exclusive of the header. */
function topBlock(source, key) {
  const lines = source.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^(?:${key}|'${key}'|"${key}")\\s*:`).test(l));
  if (start === -1) return { header: null, body: [] };
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    body.push(line);
  }
  return { header: lines[start], body };
}

/** Lines of a sub-block of `on:` (`pull_request:`, `push:`), or null if absent. */
function onSubBlock(source, key) {
  const { body } = topBlock(source, 'on');
  const start = body.findIndex((l) => new RegExp(`^\\s+${key}\\s*:`).test(l));
  if (start === -1) return null;
  const indent = body[start].match(/^\s*/)[0].length;
  const out = [];
  for (const line of body.slice(start + 1)) {
    if (line.trim() && line.match(/^\s*/)[0].length <= indent) break;
    out.push(line);
  }
  return out;
}

/** `{ jobId: body }` for the top-level `jobs:` mapping, with the indent derived. */
export function jobBlocks(source) {
  const { body } = topBlock(source, 'jobs');
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

describe('CI lanes always report', () => {
  // ------------------------------------------------------------------
  // 0. Positive control, on a SYNTHETIC fixture.
  //    The previous version used ci-freight.yml as "the stable fixture with 2
  //    `paths:` keys and 3 job ids" — this very PR changed it to 1 and 5, which is
  //    exactly how such an anchor rots. A synthetic fixture cannot be invalidated
  //    by an unrelated edit; the real-file smoke below keeps it honest about
  //    actually reading this repo's YAML.
  // ------------------------------------------------------------------
  it('the scanner still parses the shapes it claims to', () => {
    const fixture = [
      'name: Fixture',
      'on:',
      '  push:',
      '    branches: [main]',
      '    paths:',
      "      - 'a/**'",
      '  pull_request:',
      '    branches: [main]',
      'jobs:',
      '  # a comment line before the first job',
      '  first-job:',
      '    name: First (with punctuation)',
      '    steps:',
      '      - name: not a job id',
      '        run: echo hi',
      '  second_job:',
      '    if: always()',
      '',
    ].join('\n');

    expect(Object.keys(jobBlocks(fixture))).toEqual(['first-job', 'second_job']);
    expect(checkName('first-job', jobBlocks(fixture)['first-job'])).toBe(
      'First (with punctuation)',
    );
    expect(checkName('second_job', jobBlocks(fixture)['second_job'])).toBe('second_job');
    // `push:` has paths, `pull_request:` does not — the exact discrimination
    // assertion 2 depends on.
    expect(onSubBlock(fixture, 'push').some((l) => /^\s+paths\s*:/.test(l))).toBe(true);
    expect(onSubBlock(fixture, 'pull_request').some((l) => /^\s+paths\s*:/.test(l))).toBe(false);
    expect(onSubBlock(fixture, 'schedule')).toBeNull();

    // ...and it still reads real files in this repo.
    expect(Object.keys(jobBlocks(read('.github/workflows/ci.yml')))).toEqual([
      'lint-typecheck-test',
      'report-failure',
    ]);

    // ⚠️ Line-ending independence, checked explicitly. `core.autocrlf=true` hands
    // Windows a CRLF working tree while CI and the index see LF, and every scanner
    // here is line-anchored. That difference once made the guard-drift assertion
    // pass locally by extracting an EMPTY `if:` block and examining zero operands —
    // a vacuous green that only the Linux run exposed. `read()` normalises, and
    // this proves it: the same fixture with CRLF must parse identically.
    const crlf = fixture.split('\n').join('\r\n');
    const normalise = (s) => s.split('\r\n').join('\n');
    expect(Object.keys(jobBlocks(normalise(crlf)))).toEqual(['first-job', 'second_job']);
    const ifBlock = (body) => body.match(/^\s{4}if\s*:\s*(.+)$/m)?.[1] ?? '';
    expect(ifBlock(jobBlocks(normalise(crlf))['second_job'])).toBe('always()');
  });

  // ------------------------------------------------------------------
  // 1. Anti-vacuity: the partition must be total.
  // ------------------------------------------------------------------
  it('every workflow is either a gated lane or an explicitly excused one', () => {
    // `*.y*ml`, not `*.yml`: GitHub accepts `.yaml` for workflows too, and a lane
    // added as `new-lane.yaml` would otherwise land in neither table and escape
    // the very partition this assertion exists to make unfakeable.
    const found = findByPathspec(':(glob).github/workflows/*.y*ml').sort();
    const classified = [...Object.keys(LANES), ...Object.keys(UNGATED)].sort();

    expect(
      found,
      [
        'The set of workflow files no longer matches what this guard knows about.',
        '',
        'EXTRA (in the repo, unclassified) is the important direction: a new lane',
        'added without a gate lands here, and a lane that publishes no check is the',
        'defect this whole design removed. Add it to LANES with a gate, or to',
        'UNGATED with a written reason for why it can gate nothing.',
        '',
        'MISSING means a workflow was deleted or the pathspec stopped matching —',
        'in which case every other assertion below is checking a smaller set than',
        'it appears to.',
      ].join('\n'),
    ).toEqual(classified);
  });

  // ------------------------------------------------------------------
  // 2. The defect itself.
  // ------------------------------------------------------------------
  it('no gated lane filters its pull_request trigger on paths', () => {
    const offenders = Object.keys(LANES).flatMap((file) => {
      const source = read(file);
      const pr = onSubBlock(source, 'pull_request');
      const bad = [];
      if (pr === null) bad.push('has no `pull_request:` trigger at all');
      else {
        bad.push(...pr.filter((l) => /^\s+paths(-ignore)?\s*:/.test(l)).map((l) => l.trim()));
      }
      // A flow-style `on: {pull_request: {paths: [...]}}` would hide from a line
      // scan entirely, so require the header to be bare.
      const { header } = topBlock(source, 'on');
      if (header && !/^(?:on|'on'|"on")\s*:\s*(?:#.*)?$/.test(header)) {
        bad.push(`inline mapping on the \`on:\` header — ${header.trim()}`);
      }
      return bad.map((b) => `${file} → ${b}`);
    });

    expect(
      offenders,
      [
        'A gated lane must not carry a `paths:` / `paths-ignore:` filter on its',
        '`pull_request:` trigger.',
        '',
        'When it does not match, GitHub never instantiates the workflow, so it',
        'publishes NO check run at all — not a failure, not a skip, nothing. A',
        'required status check that is never reported cannot gate anything.',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        "Put the skip decision in the lane's `changes` job instead, where the lane",
        'still reports. See .github/scripts/e2e-affected.mjs.',
        '',
        'NOTE: the `push:` trigger deliberately KEEPS its `paths:` — nothing on the',
        'push path is a required check, and the `changes` job short-circuits to',
        'run=true on non-PR events. Assertion 11 pins that.',
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 3 + 4. The gate exists, always runs, and reads every job it certifies.
  // ------------------------------------------------------------------
  it('every lane has an unskippable gate wired to all of its suite jobs', () => {
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
      if (!jobs.changes) offenders.push(`${file} → no \`changes\` job`);
      if (!gate.includes('needs.changes.outputs.run_e2e')) {
        offenders.push(`${file} → gate never reads the scope verdict`);
      }
      for (const job of lane.jobs) {
        if (!new RegExp(`needs\\s*:\\s*\\[[^\\]]*\\b${job.id}\\b`).test(gate)) {
          offenders.push(`${file} → gate does not \`needs:\` \`${job.id}\``);
        }
        if (!gate.includes(`needs.${job.id}.result`)) {
          offenders.push(`${file} → gate never reads \`needs.${job.id}.result\``);
        }
      }
    }

    expect(
      offenders,
      [
        'Each lane needs a gate that is structurally incapable of being skipped and',
        'that actually inspects what it certifies.',
        '',
        '⚠️ A job skipped by `if:` still publishes a check run with conclusion',
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
  // 4b. Each lane asks the scope question about the right roots.
  // ------------------------------------------------------------------
  it('every lane passes its own dependency roots to the scope script', () => {
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const hits = [...read(file).matchAll(/--roots\s+([^\n\\]+)/g)];
      if (hits.length !== 1) {
        offenders.push(`${file} → expected exactly one \`--roots\`, found ${hits.length}`);
        continue;
      }
      const actual = hits[0][1].trim().split(/\s+/).sort();
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
        'makes the lane silently stop running on changes it should catch — a skip the',
        'gate then reports as green, because from its point of view the scope job',
        'answered honestly.',
        '',
        'Three roots are non-obvious and must not be dropped:',
        '  - vendas needs @delfrance/integrations-app (it serves apps/integrations',
        '    on :3001 for the configuracoes suite)',
        '  - e2e-emulator needs @delfrance/functions (firebase.e2e.json serves that',
        '    codebase from source; no other lane exercises those triggers)',
        '  - ci-storage needs both @delfrance/storage and @delfrance/functions',
        '',
        'Exactly one occurrence is required: a second, silently-ignored `--roots`',
        'would otherwise be invisible. (ci-nfe.yml additionally uses `--only-paths`',
        'for its live job — a different flag, deliberately not counted here.)',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 5. The pinned names, and their uniqueness across the whole repo.
  // ------------------------------------------------------------------
  it('the pinned gate and scope names are unchanged, and every check name is unique', () => {
    const actual = {};
    for (const [file, lane] of Object.entries(LANES)) {
      const jobs = jobBlocks(read(file));
      actual[file] = {
        gate: checkName('gate', jobs.gate ?? ''),
        scope: checkName('changes', jobs.changes ?? ''),
      };
    }
    const expected = Object.fromEntries(
      Object.entries(LANES).map(([f, l]) => [f, { gate: l.gate, scope: l.scope }]),
    );

    expect(
      actual,
      [
        'A gate or scope check-run name changed.',
        '',
        'The gate names are wired into the `protect-main` ruleset (id 16348427) as',
        'required status checks. GitHub matches a required check by NAME — a renamed',
        'check is simply never reported, and the branch merges without it. The gate',
        'silently stops gating.',
        '',
        'If the rename is intentional, edit the ruleset in the same change:',
        '  gh api repos/Hinten/next_erp/rulesets/16348427',
        '',
        'Keep them pure ASCII — no em dash. They get pasted into a JSON payload from',
        'PowerShell on Windows, and a mangled character produces a required check',
        'that never matches and an unmergeable `main`.',
      ].join('\n'),
    ).toEqual(expected);

    // Uniqueness across EVERY published check name in the repo, not just gates:
    // a check-run name carries no workflow prefix, so `Post failure note on PR` in
    // three files was three indistinguishable checks.
    const all = [];
    for (const file of [...Object.keys(LANES), ...Object.keys(UNGATED)]) {
      for (const [id, body] of Object.entries(jobBlocks(read(file)))) {
        all.push({ name: checkName(id, body), file });
      }
    }
    /**
     * One documented collision, tolerated rather than fixed.
     *
     * `copilot-setup-steps.yml` and `copilot-code-review.yml` both declare a job
     * keyed `copilot-setup-steps` — GitHub requires that exact job id in each file
     * for Copilot to find it, so the key is a contract we do not own. Giving one a
     * distinct `name:` would change the published check but risks breaking that
     * lookup, and the collision is harmless here: both workflows are
     * self-referentially `paths:`-filtered bootstraps that gate nothing and can
     * never be pinned. Do NOT add gated lanes to this set.
     */
    const TOLERATED_COLLISIONS = new Set(['copilot-setup-steps']);

    const dupes = all
      .filter((a, i) => all.findIndex((b) => b.name === a.name) !== i)
      .filter((d) => !TOLERATED_COLLISIONS.has(d.name))
      .map((d) => `${JSON.stringify(d.name)} (${d.file})`);

    expect(
      dupes,
      [
        'Two jobs publish the same check-run name.',
        '',
        'A check-run name carries no workflow-name prefix, so duplicates are',
        'indistinguishable in the PR checks list AND to branch protection: pinning',
        'one would be satisfied by whichever workflow happened to report. It also',
        'breaks the gates, which locate their jobs by name through the jobs API.',
        '',
        ...dupes.map((d) => `  - ${d}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 6. The engine stays an engine.
  // ------------------------------------------------------------------
  it('the reusable engine declares no gate and stays workflow_call-only', () => {
    const REUSABLE = '.github/workflows/e2e-reusable.yml';
    const source = read(REUSABLE);

    expect(
      Object.keys(jobBlocks(source)),
      [
        `${REUSABLE} must not declare a \`gate\` job.`,
        '',
        'A job inside a reusable workflow publishes as "<caller job id> / <job id>",',
        'so both staging callers would emit an identically-named check. Worse, the',
        "fork guard and the scope guard both sit on the CALLER's job — when that is",
        'skipped the reusable contributes no jobs at all, so a gate in here would',
        'vanish in exactly the cases it exists to report on.',
      ].join('\n'),
    ).not.toContain('gate');

    const { body } = topBlock(source, 'on');
    expect(body.some((l) => /^\s+workflow_call\s*:/.test(l))).toBe(true);
    expect(
      body.filter((l) => /^\s+(pull_request|push)\s*:/.test(l)),
      `${REUSABLE} gained a \`pull_request\`/\`push\` trigger — that would make it a ` +
        'gateless entry lane, which assertions 2-5 do not cover.',
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
        'regex here has rotted and this assertion now checks nothing.',
    ).toBeGreaterThan(3);

    /**
     * `local-perf` is the opt-in 1000-item checkout perf harness, added to the
     * project list only under `CHECKOUT_PERF=1`. CI gates the scan ALGORITHM
     * instead, via `checkoutEngine.perf.test.ts` in `@delfrance/schemas`.
     */
    const NOT_IN_CI = new Set(['local-perf']);

    const wired = new Set();
    for (const file of [...Object.keys(LANES), '.github/workflows/e2e-reusable.yml']) {
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
        'Every lane would look green while these specs were never executed. The',
        'project name is the only thing wiring a spec file to a lane, so an unwired',
        'project is silently dead coverage.',
        '',
        ...orphans.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 8. Every suite job is covered by the gate.
  // ------------------------------------------------------------------
  it('no lane has a suite job the gate does not certify', () => {
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const known = new Set(lane.jobs.map((j) => j.id));
      for (const id of Object.keys(jobBlocks(read(file)))) {
        if (id === 'changes' || id === 'gate' || id.startsWith('report-')) continue;
        if (!known.has(id)) offenders.push(`${file} → \`${id}\` is in no gate manifest`);
      }
    }

    expect(
      offenders,
      [
        'A lane gained a job that its gate does not certify.',
        '',
        'This is the multi-job trap: the gate keeps reporting green off the jobs it',
        'does know about, while the new one could be failing. The pinned check would',
        'then certify a lane it no longer covers.',
        '',
        "Add it to that lane's `jobs:` list here AND to the gate's `JOBS:` manifest,",
        'or name it `report-*` if it is a reporter (reporters are skipped on every',
        'green run and must never be certified — see assertion 12).',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 9. Manifest ↔ published names ↔ declared classes all agree.
  // ------------------------------------------------------------------
  it('each gate manifest matches the jobs it certifies, by name and class', () => {
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const jobs = jobBlocks(read(file));
      const gate = jobs.gate ?? '';
      for (const job of lane.jobs) {
        // The published name must match what the manifest quotes: the gate finds
        // jobs through the jobs API BY NAME, so a rename here is a runtime red.
        if (jobs[job.id] !== undefined) {
          const published = checkName(job.id, jobs[job.id]);
          // Reusable-call jobs publish as `<caller id> / <called id>`; the manifest
          // carries that composed string, which cannot be derived from this file.
          const composed = job.check.includes(' / ');
          if (!composed && published !== job.check) {
            offenders.push(
              `${file} → \`${job.id}\` publishes ${JSON.stringify(published)}, manifest says ${JSON.stringify(job.check)}`,
            );
          }
        }
        // Two gate shapes exist on purpose. The four domain lanes are multi-job and
        // carry a `JOBS:` manifest; the three e2e lanes have exactly one suite job
        // and name it in `E2E_JOB_NAME`. Unifying them is a deliberate follow-up —
        // it would mean refactoring three gates that are already merged and
        // verified. Either way the invariant is the same: the gate must look the
        // job up by the name that job actually publishes.
        if (gate.includes('JOBS: |')) {
          if (!gate.includes(`|${job.class}|${job.check}`)) {
            offenders.push(
              `${file} → manifest row missing or changed for \`${job.check}\` (${job.class})`,
            );
          }
        } else if (!gate.includes(`E2E_JOB_NAME: ${job.check}`)) {
          offenders.push(
            `${file} → single-job gate does not declare \`E2E_JOB_NAME: ${job.check}\``,
          );
        }
      }
    }

    // ci-nfe's Consumo Indevido shield locates nfe-live by EXACT name through the
    // jobs API. It used to use a substring regex, which would have failed silently
    // on rename — the 🛡️ comment would simply never appear again.
    const nfe = read('.github/workflows/ci-nfe.yml');
    const liveName = LANES['.github/workflows/ci-nfe.yml'].jobs[1].check;
    const shieldRefs = (nfe.match(/LIVE_JOB_NAME:\s*(.+)/g) ?? []).map((l) =>
      l.replace(/^LIVE_JOB_NAME:\s*/, '').trim(),
    );
    if (shieldRefs.length !== 2 || shieldRefs.some((r) => r !== liveName)) {
      offenders.push(
        `ci-nfe.yml → LIVE_JOB_NAME must appear twice and equal ${JSON.stringify(liveName)}; found ${JSON.stringify(shieldRefs)}`,
      );
    }
    // Comment lines are excluded: the file deliberately quotes the old broken form
    // in a ⚠️ note explaining why it was replaced.
    const liveCode = nfe
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    if (/select\(\.name \| test\(/.test(liveCode)) {
      offenders.push(
        'ci-nfe.yml → a substring `test()` job lookup is back; it fails SILENTLY on rename',
      );
    }

    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 10. Guard wiring does not drift.
  // ------------------------------------------------------------------
  it('every optional job references the output backing each guard it claims', () => {
    const BACKING = {
      live_enabled: 'needs.changes.outputs.live_enabled',
      live_scope: 'needs.changes.outputs.run_live',
      not_fork: 'head.repo.fork',
    };
    const offenders = [];
    for (const [file, lane] of Object.entries(LANES)) {
      const jobs = jobBlocks(read(file));
      const laneJobIds = new Set(lane.jobs.map((j) => j.id));
      for (const job of lane.jobs) {
        const body = jobs[job.id];
        if (body === undefined) continue;

        // A job must be scope-gated, but there are two legitimate ways.
        //
        // ⚠️ Downstream jobs inherit it TRANSITIVELY and must NOT be given an
        // explicit `if:`. A job-level `if:` REPLACES the implicit `success()`, so
        // adding `if: needs.changes.outputs.run_e2e == 'true'` to `rules-emulator`
        // would make it run even when `rules-offline` FAILED. GitHub already skips
        // a job whose `needs` were skipped, so depending on a scope-gated job in the
        // same lane is both sufficient and strictly safer.
        const needs = body.match(/needs\s*:\s*\[([^\]]*)\]|needs\s*:\s*(\S+)/)?.[0] ?? '';
        const dependsOnGatedSibling = [...laneJobIds].some(
          (id) => id !== job.id && new RegExp(`\\b${id}\\b`).test(needs),
        );
        if (!body.includes('needs.changes.outputs.run_e2e') && !dependsOnGatedSibling) {
          offenders.push(`${file} → \`${job.id}\` does not gate on the scope verdict`);
        }
        const claimed = job.class.startsWith('optional:')
          ? job.class.slice('optional:'.length).split('+')
          : [];

        // Direction 1 — every guard the job CLAIMS must actually be read.
        for (const g of claimed) {
          const backing = BACKING[g];
          if (!backing) {
            offenders.push(`${file} → \`${job.id}\` claims unknown guard \`${g}\``);
          } else if (!body.includes(backing)) {
            offenders.push(
              `${file} → \`${job.id}\` claims guard \`${g}\` but never reads \`${backing}\``,
            );
          }
        }

        // Direction 2 — and nothing the `if:` READS may be un-declared.
        //
        // Without this the check is one-way: appending
        // `&& github.actor != 'dependabot[bot]'` to a suite job would pass here and
        // only surface at runtime, as an "unexplained skip" red. That failure is
        // safe but late, and the message below promises commit-time detection.
        //
        // Extract the job's own `if:` (block or inline) and require every
        // `needs.changes.outputs.*` / `github.*` operand in it to be either the
        // scope verdict, the dispatch escape, or the backing of a DECLARED guard.
        const ifBlock =
          body.match(/^\s{4}if\s*:\s*>-?\s*\n((?:\s{6}.*\n)+)/m)?.[1] ??
          body.match(/^\s{4}if\s*:\s*(.+)$/m)?.[1] ??
          '';
        const ALWAYS_ALLOWED = [
          'needs.changes.outputs.run_e2e', // the scope verdict
          'github.event_name', // the workflow_dispatch escape hatch
        ];
        const allowed = [...ALWAYS_ALLOWED, ...claimed.map((g) => BACKING[g]).filter(Boolean)];
        // `readsFork` without `optional:not_fork` is the e2e lanes' deliberate
        // asymmetry: the job DOES skip on a fork, but the gate treats that skip as
        // RED rather than excusing it, because the staging suite is the only
        // verification of that code. The operand is legitimate; the guard is not.
        if (job.readsFork) allowed.push(BACKING.not_fork);
        const operands = [
          ...ifBlock.matchAll(/needs\.changes\.outputs\.[A-Za-z0-9_]+|github\.[A-Za-z0-9_.]+/g),
        ].map((m) => m[0]);
        for (const op of new Set(operands)) {
          if (!allowed.some((a) => op === a || op.endsWith(a) || a.endsWith(op))) {
            offenders.push(
              `${file} → \`${job.id}\` reads \`${op}\` in its \`if:\`, which no declared guard covers`,
            );
          }
        }
      }
    }

    expect(
      offenders,
      [
        "A job's `if:` and the gate's guard vocabulary have drifted apart.",
        '',
        'The gate re-derives the predicate that should have caused a skip. If a job',
        'can skip for a reason no guard covers, the gate reds an "unexplained skip" —',
        'correct, but only discovered at runtime. This catches it at commit time.',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 11. Triggers.
  // ------------------------------------------------------------------
  it('every lane accepts the production base, and the domain lanes keep push paths', () => {
    const offenders = [];
    for (const file of Object.keys(LANES)) {
      const source = read(file);
      const pr = (onSubBlock(source, 'pull_request') ?? []).join('\n');
      if (!/branches:\s*\[[^\]]*\bproduction\b/.test(pr)) {
        offenders.push(`${file} → \`production\` missing from \`pull_request: branches:\``);
      }
      const push = onSubBlock(source, 'push');
      const isDomain = file.includes('/ci-');
      if (isDomain) {
        if (push === null) offenders.push(`${file} → domain lane lost its \`push:\` trigger`);
        else if (!push.some((l) => /^\s+paths\s*:/.test(l))) {
          offenders.push(`${file} → domain lane's \`push:\` lost its \`paths:\``);
        }
      } else if (push !== null) {
        offenders.push(`${file} → e2e lane gained a \`push:\` trigger`);
      }
    }

    expect(
      offenders,
      [
        'A lane trigger changed in a way the design depends on.',
        '',
        '`production` is the release base (main → production). Without it the lane',
        'publishes no check on the PR that actually ships, and a required check that',
        'never reports leaves that PR permanently unmergeable.',
        '',
        'The domain lanes KEEP `push: paths:` deliberately: nothing on the push path',
        'is a required check, and the `changes` job short-circuits to run=true on',
        'non-PR events — so removing it would run the full live SEFAZ pipeline on',
        'every merge to main for no gating benefit.',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  // ------------------------------------------------------------------
  // 12. The gate never certifies a reporter.
  // ------------------------------------------------------------------
  it('no gate needs a report-* job', () => {
    const offenders = [];
    for (const file of Object.keys(LANES)) {
      const gate = jobBlocks(read(file)).gate ?? '';
      const needs = gate.match(/needs\s*:\s*\[([^\]]*)\]/)?.[1] ?? '';
      for (const id of needs.split(',').map((s) => s.trim())) {
        if (id.startsWith('report-')) offenders.push(`${file} → gate needs \`${id}\``);
      }
    }

    expect(
      offenders,
      [
        'A gate depends on a reporter job.',
        '',
        'A `report-*` job is `skipped` on every green run. Needing it makes the gate',
        'either certify a skipped job or go permanently red — both useless.',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
