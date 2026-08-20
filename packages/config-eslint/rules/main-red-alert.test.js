import { describe, expect, it } from 'vitest';

import {
  ALERT_LABEL,
  decide,
  failingSteps,
  markerFor,
  recordedRunNumber,
  run,
  titleFor,
} from '../../../.github/scripts/main-red-alert.mjs';

/**
 * The alerter behind `main-red-alert.yml` (`.github/scripts/main-red-alert.mjs`).
 *
 * ⚠️ WHY IT IS TESTED HERE, AND WHY THAT IS NOT OPTIONAL. `workflow_run` only
 * exists once the workflow file is on the DEFAULT BRANCH — the trigger cannot
 * fire from a PR branch, so no PR can ever exercise this end to end. These tests
 * are the ONLY proof available before the thing merges. Everything the alerter
 * decides therefore lives in an importable module rather than in a `script:`
 * block, exactly as `.github/scripts/e2e-affected.mjs` does.
 *
 * The two directions that matter are opposites of each other:
 *
 *   - ALERTING TOO LITTLE is the defect this exists to remove. A red `main` that
 *     opens no issue is the status quo — detected by `ci.yml`'s `push:` run,
 *     reported to nobody, rediscovered an hour later by an innocent PR.
 *   - ALERTING TOO MUCH kills it just as dead. Every lane runs
 *     `cancel-in-progress: true`, so cancelled runs on `main` are routine (10 of
 *     the last 25 `ci.yml` runs on `main`). An issue per cancellation and nobody
 *     reads the label again.
 */
const CONTEXT = { repo: { owner: 'Hinten', repo: 'next_erp' } };

const core = { info: () => {}, warning: () => {}, setFailed: () => {} };

/** The real shape, trimmed to the fields the alerter reads. */
const workflowRun = (over = {}) => ({
  id: 32373838109,
  name: 'CI',
  event: 'push',
  head_branch: 'main',
  head_sha: 'd3454c55aaaaaaaabbbbbbbbccccccccdddddddd',
  display_title: 'Merge pull request #1114 from Hinten/claude/ml-claims-respond',
  html_url: 'https://github.com/Hinten/next_erp/actions/runs/32373838109',
  run_number: 900,
  run_attempt: 1,
  conclusion: 'failure',
  ...over,
});

const JOBS = [
  {
    name: 'lint-typecheck-test',
    conclusion: 'failure',
    steps: [
      { name: 'Install', conclusion: 'success' },
      { name: 'Typecheck', conclusion: 'success' },
      { name: 'Lint', conclusion: 'failure' },
    ],
  },
  { name: 'Post failure logs on PR', conclusion: 'skipped', steps: [] },
];

/**
 * A recording Octokit stand-in. Every write is captured, so a test can assert on
 * what was NOT called — which is the whole point for the skip cases.
 */
function fakeGithub({ wr, jobs = JOBS, issues = [], labelStatus = 200 }) {
  const calls = [];
  const record = (name, result) => async (args) => {
    calls.push({ name, args });
    return result;
  };
  return {
    calls,
    names: () => calls.map((c) => c.name),
    rest: {
      actions: {
        getWorkflowRun: record('getWorkflowRun', { data: wr }),
        listJobsForWorkflowRun: record('listJobsForWorkflowRun', { data: { jobs } }),
      },
      issues: {
        listForRepo: record('listForRepo', { data: issues }),
        getLabel: async (args) => {
          calls.push({ name: 'getLabel', args });
          if (labelStatus !== 200) {
            const err = new Error('label lookup failed');
            err.status = labelStatus;
            throw err;
          }
          return { data: { name: ALERT_LABEL } };
        },
        createLabel: record('createLabel', { data: {} }),
        create: record('create', { data: { number: 4242 } }),
        createComment: record('createComment', { data: { id: 1 } }),
        update: record('update', { data: {} }),
      },
    },
  };
}

const invoke = (github) => run({ github, context: CONTEXT, core, runId: '32373838109' });

const argsOf = (github, name) => github.calls.filter((c) => c.name === name).map((c) => c.args);

describe('main-red-alert: the verdict', () => {
  // ------------------------------------------------------------------
  // 1. Every conclusion GitHub can produce, in both directions.
  // ------------------------------------------------------------------
  it.each([
    ['failure', 'alert'],
    ['timed_out', 'alert'],
    ['success', 'resolve'],
    ['cancelled', 'skip'],
    ['skipped', 'skip'],
    ['neutral', 'skip'],
    ['action_required', 'skip'],
    ['stale', 'skip'],
  ])('a push run concluding %s → %s', (conclusion, action) => {
    expect(decide({ event: 'push', headBranch: 'main', conclusion }).action).toBe(action);
  });

  it('treats a manual dispatch on the trunk as the trunk', () => {
    expect(
      decide({ event: 'workflow_dispatch', headBranch: 'main', conclusion: 'failure' }).action,
    ).toBe('alert');
    expect(decide({ event: 'push', headBranch: 'master', conclusion: 'failure' }).action).toBe(
      'alert',
    );
  });

  it('ignores runs that are not about the trunk', () => {
    // The `branches:` filter on the trigger already drops these; this is the
    // second guard, and the one the `workflow_dispatch` replay path relies on.
    expect(
      decide({ event: 'pull_request', headBranch: 'main', conclusion: 'failure' }).action,
    ).toBe('skip');
    expect(
      decide({ event: 'push', headBranch: 'claude/issue-1167', conclusion: 'failure' }).action,
    ).toBe('skip');
    expect(decide({ event: 'schedule', headBranch: 'main', conclusion: 'failure' }).action).toBe(
      'skip',
    );
  });

  // ------------------------------------------------------------------
  // 2. The marker the close decision reads back.
  // ------------------------------------------------------------------
  it('round-trips the run number through the issue marker', () => {
    const body = `some text\n${markerFor('CI — Mercado Livre (Firestore emulator)', 901)}\n`;
    expect(recordedRunNumber(body)).toBe(901);
    expect(recordedRunNumber('an issue a human wrote')).toBeNull();
    expect(recordedRunNumber(undefined)).toBeNull();
  });

  // ------------------------------------------------------------------
  // 3. Failing steps, named — a run URL alone makes nobody open the tab.
  // ------------------------------------------------------------------
  it('names the failing steps of the failing jobs only', () => {
    expect(failingSteps(JOBS)).toEqual([{ job: 'lint-typecheck-test', steps: ['Lint'] }]);
    // A job killed by `timeout-minutes` can carry no failing step at all.
    expect(failingSteps([{ name: 'e2e', conclusion: 'timed_out', steps: [] }])).toEqual([
      { job: 'e2e', steps: [] },
    ]);
    expect(failingSteps([])).toEqual([]);
    expect(failingSteps(undefined)).toEqual([]);
  });
});

describe('main-red-alert: what it does about it', () => {
  // ------------------------------------------------------------------
  // 4. First failure — open the tracker.
  // ------------------------------------------------------------------
  it('opens one labelled issue naming the failing step, the commit and the repro', async () => {
    const github = fakeGithub({ wr: workflowRun() });
    const outcome = await invoke(github);

    expect(outcome).toMatchObject({ action: 'alert', issue: 4242, created: true });
    expect(github.names()).not.toContain('createComment');

    const [created] = argsOf(github, 'create');
    expect(created.title).toBe(titleFor('CI'));
    expect(created.labels).toEqual(['ci', ALERT_LABEL]);
    // Anti-vacuity: the step name can only be here if the jobs call was really
    // made and really parsed. `Lint` is what run 32373838109 actually failed on.
    expect(created.body).toContain('`Lint`');
    expect(created.body).toContain('Merge pull request #1114');
    expect(created.body).toContain('d3454c5');
    expect(created.body).toContain('--force --continue');
    expect(created.body).toContain(markerFor('CI', 900));
  });

  it('creates the label first when it does not exist yet', async () => {
    const github = fakeGithub({ wr: workflowRun(), labelStatus: 404 });
    await invoke(github);
    expect(github.names()).toContain('createLabel');
    expect(github.names().indexOf('createLabel')).toBeLessThan(github.names().indexOf('create'));
  });

  it('rethrows a label lookup failure that is not a 404', async () => {
    // The narrow `catch` exists to create a missing label, not to swallow an
    // outage into a silently un-alerted red trunk.
    const github = fakeGithub({ wr: workflowRun(), labelStatus: 500 });
    await expect(invoke(github)).rejects.toThrow('label lookup failed');
    expect(github.names()).not.toContain('create');
  });

  // ------------------------------------------------------------------
  // 5. Second failure — comment, never a duplicate issue.
  // ------------------------------------------------------------------
  it('comments on the standing issue and refreshes its marker', async () => {
    const open = {
      number: 77,
      title: titleFor('CI'),
      body: `old\n${markerFor('CI', 900)}`,
    };
    const github = fakeGithub({ wr: workflowRun({ run_number: 901 }), issues: [open] });
    const outcome = await invoke(github);

    expect(outcome).toMatchObject({ action: 'alert', issue: 77, created: false });
    expect(github.names()).not.toContain('create');
    expect(argsOf(github, 'createComment')[0].body).toContain('`Lint`');
    // The marker has to move, or the NEXT green would compare against run 900 and
    // close an issue that is still true.
    expect(argsOf(github, 'update')[0].body).toContain(markerFor('CI', 901));
  });

  it('does not mistake another workflow, or a PR, for the standing issue', async () => {
    const github = fakeGithub({
      wr: workflowRun(),
      issues: [
        { number: 5, title: titleFor('CI — Rules'), body: markerFor('CI — Rules', 12) },
        { number: 6, title: titleFor('CI'), body: '', pull_request: { url: 'x' } },
      ],
    });
    const outcome = await invoke(github);
    expect(outcome).toMatchObject({ created: true });
  });

  // ------------------------------------------------------------------
  // 6. Green again — close, but only on evidence that is newer.
  // ------------------------------------------------------------------
  it('closes the tracker on a newer green run', async () => {
    const open = { number: 77, title: titleFor('CI'), body: markerFor('CI', 900) };
    const github = fakeGithub({
      wr: workflowRun({ conclusion: 'success', run_number: 901 }),
      issues: [open],
    });

    const outcome = await invoke(github);
    expect(outcome).toMatchObject({ action: 'resolve', issue: 77 });
    expect(argsOf(github, 'update')[0]).toMatchObject({ state: 'closed', issue_number: 77 });
  });

  it('refuses to close on a re-run of an OLDER green run', async () => {
    // Re-running an old run is normal. Without the run-number comparison it would
    // close an issue whose failure is still on `main`.
    const open = { number: 77, title: titleFor('CI'), body: markerFor('CI', 900) };
    const github = fakeGithub({
      wr: workflowRun({ conclusion: 'success', run_number: 899 }),
      issues: [open],
    });

    expect(await invoke(github)).toMatchObject({ action: 'skip' });
    expect(github.names()).not.toContain('update');
    expect(github.names()).not.toContain('createComment');
  });

  it('does nothing when green and no tracker is open', async () => {
    const github = fakeGithub({ wr: workflowRun({ conclusion: 'success' }) });
    expect(await invoke(github)).toMatchObject({ action: 'skip' });
    expect(github.names()).toEqual(['getWorkflowRun', 'listForRepo']);
  });

  // ------------------------------------------------------------------
  // 7. The noise case. `cancel-in-progress` produces these constantly.
  // ------------------------------------------------------------------
  it('writes nothing at all for a cancelled or PR run', async () => {
    for (const wr of [
      workflowRun({ conclusion: 'cancelled' }),
      workflowRun({ event: 'pull_request', head_branch: 'claude/x' }),
    ]) {
      const github = fakeGithub({ wr });
      expect(await invoke(github)).toMatchObject({ action: 'skip' });
      expect(github.names()).toEqual(['getWorkflowRun']);
    }
  });
});
