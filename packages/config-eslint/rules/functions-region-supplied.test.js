import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: every workflow job that BUILDS a Cloud Functions bundle must
 * supply `FUNCTIONS_REGION`.
 *
 * This is the mirror image of `delfrance/no-hardcoded-gcp-region`. That rule bans a
 * region literal in source, because a hardcoded fallback is how this project ended
 * up running functions, queues and Firestore in three regions with nothing ever
 * failing — an enqueue against the wrong region is DROPPED while the route still
 * returns 200 (#1108), so the first signal was the inter-region transfer bill.
 *
 * Removing those fallbacks fixes the silence and creates one new way to break: a
 * build with no region now REFUSES (`requireBuildRegion`, tools/deploy-env). That is
 * the intended trade — loud beats silent — but it means every surface that builds a
 * bundle has to supply the value, and a workflow that forgets goes red for a reason
 * that reads like an unrelated build error.
 *
 * Not hypothetical either. `ci-storage.yml`'s emulator lane carried the comment "the
 * function region resolves from the FUNCTIONS_REGION param default — no env needed
 * here". It happened to survive, because the JOB sets one; the comment was simply
 * wrong, and nothing would have caught it if it had been right.
 *
 * This is a test rather than an ESLint rule because the invariant lives in workflow
 * YAML, which ESLint never sees. Failing it fails CI exactly like a lint error would.
 *
 * ⚠️ Not a YAML parse, deliberately — same reason `ci-lane-gates.test.js` gives:
 * `on:` is a YAML 1.1 boolean, so a naive parse keys that block as `true` and a test
 * reading it sees `undefined` for every file and passes vacuously. A line scan cannot
 * develop that failure mode.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Commands whose job needs a region, and the variable each one needs.
 *
 * ⚠️ **MEASURED, not enumerated.** Every entry here corresponds to a run that
 * actually went red — the same standard `REGIONS_WITHOUT_TASKS` sets in
 * `preflight.mjs`. A speculative list would rot; this one grows only when something
 * breaks, which is also the only way to know a command really resolves a region.
 *
 *  - `functions build` / `prepare-deploy` inline FUNCTIONS_REGION into the bundle
 *    (prepare-deploy calls build.mjs one level down).
 *  - `test:firestore` drives the real ML webhook route, which enqueues through
 *    `mlTasksRegion()`.
 *  - `test:tasks` drives the enqueue AND the task function, which must agree.
 *  - `playwright test` builds apps/web, whose callables read
 *    NEXT_PUBLIC_FUNCTIONS_REGION — inlined at build time, so it is the BUILD that
 *    needs it, not the test run.
 */
const REGION_COMMANDS = [
  { command: 'functions build', variable: 'FUNCTIONS_REGION' },
  { command: 'prepare-deploy', variable: 'FUNCTIONS_REGION' },
  { command: 'test:firestore', variable: 'MERCADO_LIVRE_TASKS_REGION' },
  { command: 'test:tasks', variable: 'MERCADO_LIVRE_TASKS_REGION' },
  { command: 'playwright test', variable: 'NEXT_PUBLIC_FUNCTIONS_REGION' },
];

/**
 * Workflows known to run at least one of those commands. An anchor list, so the
 * pathspec below cannot quietly stop matching and leave this suite passing over an
 * empty set — the failure mode every glob-driven guard in this directory has to
 * defend against.
 */
const KNOWN_BUILDERS = [
  '.github/workflows/ci-mercado-livre.yml',
  '.github/workflows/ci-storage.yml',
  '.github/workflows/copilot-setup-steps.yml',
  '.github/workflows/e2e-emulator.yml',
  '.github/workflows/e2e-reusable.yml',
];

/** Tracked + untracked, so a new workflow counts before it is committed. */
function findWorkflows() {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', ':(glob).github/workflows/*.y*ml'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

/**
 * ⚠️ Normalize line endings. `core.autocrlf=true` checks these files out as CRLF on
 * Windows while CI sees LF, and every scan below is line-oriented. A vacuous local
 * green is exactly what these guards exist to prevent.
 */
const read = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\r\n').join('\n');

/**
 * Split a workflow into jobs: everything from one 2-space-indented `<id>:` line up
 * to the next one. A hand-rolled slice, not a YAML parse, for the reason
 * `ci-lane-gates.test.js` documents — `on:` is a YAML 1.1 boolean, so a naive parse
 * keys that block as `true` and a test reading it passes vacuously over every file.
 *
 * ⚠️ JOB level is the whole point. The first version of this guard asked whether the
 * FILE mentioned the variable anywhere, and that is exactly how two failures got
 * through: `ci-mercado-livre.yml` sets a region in its tasks job while the firestore
 * job — a sibling in the same file — set none, and the file-level scan saw a match.
 */
function jobs(source) {
  const lines = source.split('\n');
  const starts = [];
  lines.forEach((line, i) => {
    if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) starts.push(i);
  });

  return starts.map((start, n) => ({
    id: lines[start].trim().replace(/:$/, ''),
    body: lines.slice(start, starts[n + 1] ?? lines.length).join('\n'),
  }));
}

/**
 * A reusable workflow's caller supplies no env, so `uses:` inherits the callee's.
 * Treat a job that only delegates as covered — the callee is checked on its own.
 */
const delegates = (body) => /^\s*uses:\s*\.\/\.github\/workflows\//m.test(body);

const runsRegionCommand = (source) =>
  REGION_COMMANDS.some(({ command }) => source.includes(command));

describe('a workflow that builds a functions bundle supplies its region', () => {
  it('finds every known builder', () => {
    const found = new Set(findWorkflows());
    const missing = KNOWN_BUILDERS.filter((p) => !found.has(p));

    expect(
      missing,
      [
        'These workflows were not found by the git pathspec. Either they moved',
        '(update KNOWN_BUILDERS) or `:(glob).github/workflows/*.y*ml` stopped matching',
        '— in which case this whole guard silently stopped checking anything:',
        ...missing.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('still recognises those builders by their commands', () => {
    // Guards the scan itself: if REGION_COMMANDS drifts from how the workflows
    // actually invoke things, the assertion below passes over an empty set.
    const unrecognised = KNOWN_BUILDERS.filter((p) => !runsRegionCommand(read(p)));

    expect(
      unrecognised,
      [
        'These are known to run a region-consuming command, but none of',
        `REGION_COMMANDS (${REGION_COMMANDS.map((c) => c.command).join(', ')})`,
        'appears in them. The assertion below would skip them and pass without',
        'checking anything:',
        ...unrecognised.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('every JOB that needs a region sets it', () => {
    const offenders = [];

    for (const file of findWorkflows()) {
      for (const job of jobs(read(file))) {
        if (delegates(job.body)) continue;
        for (const { command, variable } of REGION_COMMANDS) {
          if (!job.body.includes(command)) continue;
          if (new RegExp(`^\\s*${variable}\\s*:`, 'm').test(job.body)) continue;
          offenders.push(`${file} › ${job.id} runs \`${command}\` without ${variable}`);
        }
      }
    }

    expect(
      offenders,
      [
        'These JOBS run a command that resolves a Google Cloud region, but never',
        'set the variable it reads. There is no default any more — the build or the',
        'enqueue REFUSES — so the lane fails with what reads like an unrelated',
        'error. Add it to that job’s own `env:` block; a sibling job in the same',
        'file having it does not help.',
        '',
        '  env:',
        '    FUNCTIONS_REGION: us-central1',
        '',
        '⚠️ A lane that hits REAL staging (e2e-reusable.yml) takes the region those',
        'functions are actually DEPLOYED to, which is not necessarily the region the',
        'rest of the repo targets — see ADR 0013.',
        '',
        'Offenders:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('no workflow sets a region to an empty value', () => {
    // Blank counts as unset everywhere in this repo (#887) — `requireBuildRegion`
    // trims — so `FUNCTIONS_REGION:` with nothing after it reads as configured
    // and behaves as missing. That is the exact confusion these guards remove.
    const offenders = [];
    for (const file of findWorkflows()) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const match = /^\s*((?:NEXT_PUBLIC_)?[A-Z_]*REGION)\s*:\s*(.*)$/.exec(line);
        if (!match) return;
        const value = match[2].trim();
        if (value === '' || value === "''" || value === '""') {
          offenders.push(`${file}:${i + 1} ${match[1]}`);
        }
      });
    }

    expect(
      offenders,
      [
        'A region set to an empty value reads as configured and behaves as unset,',
        'which is the confusion this whole change removes. Give it a real value or',
        'delete the line:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
