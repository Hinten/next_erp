/**
 * Turn a red `main` into a signal a human actually sees.
 *
 * WHY THIS EXISTS. #1167 opened on the premise that "nothing re-lints `main`
 * after a merge". That premise is wrong, and what actually happened is worse:
 * `main` IS re-verified after every merge — `ci.yml` carries
 * `push: branches: [master, main]`, and the five `ci-*` domain lanes each keep a
 * path-filtered one — and on 2026-08-20 it caught the break exactly as designed.
 * Run 32373838109 on `d3454c55` concluded `failure` at the **Lint** step at
 * 13:21 UTC, 51 minutes before #1163 fixed it. Nobody saw it, because `ci.yml`'s
 * `report-failure` job is gated on `github.event_name == 'pull_request'` and so
 * reported `skipped` on the one event that mattered. The break was rediscovered
 * by #1158 — a PR that had touched nothing related — and cost an hour of
 * misattributed debugging.
 *
 * So the defect was never detection. It was that a red `main` had no audience.
 * This script gives it one: a standing GitHub issue per workflow, commented on
 * for each new failure and closed again the moment that workflow is green on
 * `main`. Same find-or-create shape as `nfe-epec-scheduled.yml`, with two
 * deliberate departures — see `findStandingIssue` and `resolveIssue` below.
 *
 * WHY A MODULE AND NOT INLINE `github-script`. Logic inside a workflow's `run:`
 * or `script:` block is unreachable from any test — and `workflow_run` cannot
 * fire from a PR branch at all, because the trigger only exists once the file is
 * on the default branch. So a unit test is the ONLY proof available before merge,
 * and a unit test needs a module. Same reasoning and same layout as
 * `.github/scripts/e2e-affected.mjs`, whose tests live in
 * `packages/config-eslint/rules/`.
 */

/** The label that makes the standing issues findable — by this script and by a human. */
export const ALERT_LABEL = 'main-red';

/**
 * `main` is broken right now.
 *
 * ⚠️ `startup_failure` is in here deliberately, and it is the one entry that is
 * not a test going red: GitHub records it when the run never starts at all —
 * invalid workflow YAML, an unresolvable `uses:`, a bad reusable-workflow
 * reference. That is a merge that broke the trunk in the most literal way
 * available, so it must not fall through to "proves nothing". Whether
 * `workflow_run: types: [completed]` even fires for such a run is not something
 * this repo can establish without breaking `main` on purpose; if it does not,
 * this entry is an inert no-op, which is the right direction to be wrong in.
 */
const RED = new Set(['failure', 'timed_out', 'startup_failure']);

/** `main` is verified good right now. */
const GREEN = new Set(['success']);

/**
 * Events whose `head_branch` really is the trunk.
 *
 * A `pull_request` run of the same workflow reports `head_branch` = the PR's
 * source branch, so the `branches:` filter on the trigger already drops it; this
 * is the second, explicit guard. `schedule` is excluded on purpose: the only
 * scheduled lane is `nfe-epec-scheduled.yml`, which probes SEFAZ availability
 * rather than the state of this repo, and it carries its own alerting.
 */
const TRUNK_EVENTS = new Set(['push', 'workflow_dispatch']);

const TRUNK_BRANCHES = new Set(['main', 'master']);

/**
 * What to do about one completed workflow run. Pure — every API call lives below.
 *
 * ⚠️ `cancelled` is NOT an alert, and that is the load-bearing case. Every lane
 * sets `concurrency: cancel-in-progress: true`, so a merge landing while the
 * previous merge's run is still going cancels it — 10 of the last 25 `ci.yml`
 * runs on `main` were cancelled that way. Alerting on those would be pure noise,
 * and it costs nothing to ignore them: a cancelled run only exists because a
 * NEWER run superseded it, and that successor re-establishes the truth. The chain
 * always terminates in a run that concludes.
 */
export function decide({ event, headBranch, conclusion }) {
  if (!TRUNK_EVENTS.has(event)) {
    return { action: 'skip', reason: `event \`${event}\` is not a trunk event` };
  }
  if (!TRUNK_BRANCHES.has(headBranch)) {
    return { action: 'skip', reason: `branch \`${headBranch}\` is not the trunk` };
  }
  if (RED.has(conclusion)) {
    return { action: 'alert', reason: `concluded \`${conclusion}\` on \`${headBranch}\`` };
  }
  if (GREEN.has(conclusion)) {
    return { action: 'resolve', reason: `concluded \`${conclusion}\` on \`${headBranch}\`` };
  }
  return {
    action: 'skip',
    reason: `\`${conclusion}\` proves nothing — a superseded run is cancelled, not broken`,
  };
}

/** One standing issue per workflow. Stable across failures; the label finds it. */
export const titleFor = (workflowName) => `🚨 main is red — ${workflowName}`;

/**
 * The run number of the failure the open issue currently stands for.
 *
 * Kept in an HTML comment in the BODY (not in a comment) so it can be rewritten
 * in place on every new failure, and read back from the one field `listForRepo`
 * already returns.
 */
export const markerFor = (workflowName, runNumber) =>
  `<!-- main-red:${workflowName}:run=${runNumber} -->`;

export function recordedRunNumber(body) {
  const m = /<!-- main-red:[^\n]*?:run=(\d+) -->/.exec(body ?? '');
  return m ? Number(m[1]) : null;
}

/** `[{ job, steps }]` for every job of a run that did not pass. */
export function failingSteps(jobs) {
  const out = [];
  for (const job of jobs ?? []) {
    if (!RED.has(job.conclusion)) continue;
    out.push({
      job: job.name,
      steps: (job.steps ?? []).filter((s) => RED.has(s.conclusion)).map((s) => s.name),
    });
  }
  return out;
}

/**
 * Suite jobs whose failure means a THIRD PARTY was down, not that the trunk broke.
 *
 * ⚠️ Not hypothetical. `ci-nfe.yml`'s `changes` job short-circuits on every non-PR
 * event and passes `true` for the LIVE verdict too, so every path-matching merge
 * to `main` runs `nfe-live` against SEFAZ homologação — the endpoint this repo
 * documents as rate-limiting (`cStat=656`) and treats as flaky enough to deserve
 * its own alerting workflow. `ci-freight.yml` has the same shape (dormant today:
 * `FREIGHT_CI_LIVE_ENABLED` is unset, so `freight-live` skips rather than fails).
 * A ten-minute SEFAZ outage would otherwise open `🚨 main is red — CI — NFe`
 * about a trunk that is fine — the same noise class the `cancelled` carve-out
 * exists to prevent, and the one that will actually recur.
 *
 * Pinned against the lane manifests by assertion 15 in `ci-lane-gates.test.js`:
 * this set must equal every LANES job whose class carries a `live_` guard.
 */
export const THIRD_PARTY_JOBS = new Set([
  'NFe live (SEFAZ homologacao + staging Firestore)',
  'Freight live (Melhor Envio sandbox)',
]);

/**
 * Jobs that report on other jobs rather than running anything themselves.
 *
 * ⚠️ Load-bearing for `onlyThirdPartyFailed`. When `nfe-live` fails the lane GATE
 * fails with it — its verdict loop sets `RED` for any job concluding `failure` and
 * exits 1 — so the failing-job list reads `[NFe live …, CI gate (nfe)]`, and a
 * naive "every failing job is third-party" test would answer false and alert
 * anyway. Matching by shape is safe because assertions 5 and 9 pin every gate and
 * scope name.
 */
export const DERIVED_JOB = /^(?:CI|E2E) (?:gate|scope) \(/;

/**
 * True when a third party was down and nothing of ours failed.
 *
 * ⚠️ The `length > 0` guard is not decoration: `[].every(…)` is `true`, so without
 * it a run that failed while reporting NO failing job — which is exactly what a
 * `startup_failure` looks like — would be read as a SEFAZ outage and dropped.
 * Anything this function cannot positively explain has to alert.
 */
export function onlyThirdPartyFailed(failing) {
  const substantive = failing.filter((f) => !DERIVED_JOB.test(f.job));
  return substantive.length > 0 && substantive.every((f) => THIRD_PARTY_JOBS.has(f.job));
}

/** What one failure looks like — used as the issue body AND as each follow-up comment. */
export function detailBody({ run, failing }) {
  const lines = [
    `❌ \`${run.name}\` concluded **${run.conclusion}** on \`${run.head_branch}\` at ` +
      `\`${(run.head_sha ?? '').slice(0, 7)}\`.`,
    '',
    `- **commit** — ${run.display_title ?? '(no title)'}`,
    `- **run** — ${run.html_url} (run #${run.run_number}, attempt ${run.run_attempt})`,
  ];
  if (failing.length > 0) {
    lines.push('', '**Failing:**');
    for (const f of failing) {
      const steps = f.steps.map((s) => `\`${s}\``).join(', ');
      lines.push(`- \`${f.job}\`${steps ? ` → ${steps}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * The standing tracker. Rewritten on every new failure so the marker stays current.
 *
 * The repro command carries both flags on purpose. `--force`: turbo otherwise
 * replays a cached green. `--continue`: turbo stops at the first failing task, and
 * the first run of this against the broken `main` reported `27 successful, 35
 * total` and hid the second error entirely — 8 workspaces never ran.
 */
export function trackerBody({ run, failing }) {
  return [
    detailBody({ run, failing }),
    '',
    '---',
    '',
    'Reproduce locally on `main`:',
    '',
    '```bash',
    'npm_config_verify_deps_before_run=false npx turbo run lint --force --continue --output-logs=errors-only',
    '```',
    '',
    '⚠️ **Do not diagnose this from whichever PR is failing.** A green PR can turn ' +
      '`main` red on merge: GitHub computes a merge ref once, at check time, so two ' +
      'PRs whose CI ran before the other landed are each green against a `main` that ' +
      'no longer exists. The PR reporting the failure is usually not the one that ' +
      'caused it — see #1167.',
    '',
    `This is the standing tracker for \`${run.name}\` failing on the trunk. Later ` +
      'failures comment here instead of opening a new issue, and it closes itself on ' +
      'the next green run of the same workflow.',
    '',
    markerFor(run.name, run.run_number),
  ].join('\n');
}

/**
 * ⚠️ `listForRepo`, NOT `search.issuesAndPullRequests` — two reasons, both real.
 *
 * 1. The search index is eventually consistent. Two failures minutes apart can
 *    each miss the other's freshly-created issue and open a duplicate.
 * 2. Search is fuzzy. `in:title "..."` matches an issue whose title merely
 *    CONTAINS the string, so a human writing about this tracker gets picked up as
 *    the tracker.
 *
 * `nfe-epec-scheduled.yml` uses search; that half is deliberately not copied. The
 * exact-title filter is belt and braces on top of the label, and `pull_request` is
 * filtered out because `listForRepo` returns PRs carrying the label too.
 */
async function findStandingIssue({ github, owner, repo, title }) {
  const { data } = await github.rest.issues.listForRepo({
    owner,
    repo,
    state: 'open',
    labels: ALERT_LABEL,
    per_page: 100,
  });
  return data.find((i) => i.title === title && !i.pull_request) ?? null;
}

/**
 * The labels every standing tracker carries. `ci` already exists on this repo;
 * `main-red` does not, and is created on the first alert.
 */
const ISSUE_LABELS = [
  { name: 'ci', color: '1d76db', description: 'Continuous integration' },
  {
    name: ALERT_LABEL,
    color: 'b60205',
    description: 'The trunk is failing this workflow — opened and closed by main-red-alert.yml',
  },
];

/**
 * Make sure every label exists before the issue is created.
 *
 * ⚠️ BOTH labels go through here, not just `main-red`. Whether `POST /issues`
 * auto-creates an unknown label is exactly the sort of thing that is cheap to make
 * irrelevant and expensive to be wrong about: if it does not, an unguarded second
 * label is a 422 on the FIRST alert — the one run that has to work — failing
 * closed into the same "reported to nobody" outcome this whole file removes.
 * `getLabel` against a label that exists is one cheap read.
 */
async function ensureLabels({ github, owner, repo }) {
  for (const label of ISSUE_LABELS) {
    try {
      await github.rest.issues.getLabel({ owner, repo, name: label.name });
    } catch (err) {
      // Narrow, per CLAUDE.md rule 6: a missing label is ours to fix, nothing else is.
      if (err?.status !== 404) throw err;
      await github.rest.issues.createLabel({ owner, repo, ...label });
    }
  }
}

async function openOrUpdateIssue({ github, core, owner, repo, run, title, existing }) {
  const { data: jobs } = await github.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: run.id,
    filter: 'latest',
    per_page: 100,
  });
  const failing = failingSteps(jobs.jobs);

  if (onlyThirdPartyFailed(failing)) {
    const reason =
      `only third-party suites failed (${failing.map((f) => f.job).join(', ')}) — ` +
      'the trunk is not implicated';
    core.notice(`${title}: not opened — ${reason}`);
    return { action: 'skip', reason };
  }

  const body = trackerBody({ run, failing });

  if (existing) {
    await github.rest.issues.createComment({
      owner,
      repo,
      issue_number: existing.number,
      body: detailBody({ run, failing }),
    });
    // Refresh the marker, so a later green compares against THIS failure rather
    // than the first one the issue ever recorded.
    await github.rest.issues.update({ owner, repo, issue_number: existing.number, body });
    core.warning(`main is red — commented on #${existing.number}: ${title}`);
    return { action: 'alert', issue: existing.number, created: false };
  }

  await ensureLabels({ github, owner, repo });
  const { data: created } = await github.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: ISSUE_LABELS.map((l) => l.name),
  });
  core.warning(`main is red — opened #${created.number}: ${title}`);
  return { action: 'alert', issue: created.number, created: true };
}

/**
 * ⚠️ Only a run NEWER than the recorded failure may close the tracker.
 *
 * Re-running an older green run is a normal thing to do, and without this guard
 * it would close an issue that is still true. The comparison is on `run_number`,
 * which is monotonic per workflow — not on time, and not on the SHA.
 */
async function resolveIssue({ github, core, owner, repo, run, existing }) {
  if (!existing) {
    return { action: 'skip', reason: 'green, and no standing issue is open' };
  }
  const red = recordedRunNumber(existing.body);
  if (red !== null && run.run_number <= red) {
    const reason = `run #${run.run_number} is not newer than the recorded red run #${red}`;
    core.info(reason);
    return { action: 'skip', reason };
  }
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: existing.number,
    body:
      `✅ \`${run.name}\` is green again on \`${run.head_branch}\` at ` +
      `\`${(run.head_sha ?? '').slice(0, 7)}\` — ${run.html_url}`,
  });
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: existing.number,
    state: 'closed',
    state_reason: 'completed',
  });
  core.info(`main is green again — closed #${existing.number}`);
  return { action: 'resolve', issue: existing.number };
}

/**
 * Entry point, called from `main-red-alert.yml`.
 *
 * The run is fetched by id rather than read off the event payload so that the
 * `workflow_dispatch` replay path and the real `workflow_run` path are the SAME
 * code — which is what makes a replay a rehearsal instead of a different program
 * that happens to look similar.
 */
export async function run({ github, context, core, runId }) {
  const { owner, repo } = context.repo;
  const { data: wr } = await github.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: Number(runId),
  });

  const verdict = decide({
    event: wr.event,
    headBranch: wr.head_branch,
    conclusion: wr.conclusion,
  });
  core.info(
    `${wr.name} run #${wr.run_number} — event=${wr.event} branch=${wr.head_branch} ` +
      `conclusion=${wr.conclusion} → ${verdict.action} (${verdict.reason})`,
  );
  if (verdict.action === 'skip') return verdict;

  const title = titleFor(wr.name);
  const existing = await findStandingIssue({ github, owner, repo, title });

  return verdict.action === 'alert'
    ? openOrUpdateIssue({ github, core, owner, repo, run: wr, title, existing })
    : resolveIssue({ github, core, owner, repo, run: wr, existing });
}
