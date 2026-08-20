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

/** `main` is broken right now. */
const RED = new Set(['failure', 'timed_out']);

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

/** Creating an issue with an unknown label fails, so the label has to exist first. */
async function ensureLabel({ github, owner, repo }) {
  try {
    await github.rest.issues.getLabel({ owner, repo, name: ALERT_LABEL });
  } catch (err) {
    // Narrow, per CLAUDE.md rule 6: a missing label is ours to fix, nothing else is.
    if (err?.status !== 404) throw err;
    await github.rest.issues.createLabel({
      owner,
      repo,
      name: ALERT_LABEL,
      color: 'b60205',
      description: 'The trunk is failing this workflow — opened and closed by main-red-alert.yml',
    });
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

  await ensureLabel({ github, owner, repo });
  const { data: created } = await github.rest.issues.create({
    owner,
    repo,
    title,
    body,
    labels: ['ci', ALERT_LABEL],
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
